import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverCodexSessions, readCodexSession, toRolloutLines, uuidv7, type MotifSession } from '@motif/core';
import { resolveSession, scanLocal } from '../local.js';
import { loadConfig } from '../config.js';
import { MotifClient } from '../api-client.js';
import { codexHome, performClaudeHandoff, performHandoff, resumeCommandFor, type HandoffTarget } from '../handoff/perform.js';

export function registerHandoff(program: Command): void {
  program
    .command('handoff <id>')
    .description('Continue a session in another tool, natively (Claude Code ⇄ Codex, Cursor → both)')
    .option('--to <tool>', 'target tool: codex | claude-code', 'codex')
    .option('--cwd <path>', "map the session onto your local clone (a teammate's project path differs from yours)")
    .option('--open', 'launch Codex right into the handed-off session')
    .option('--digest [n]', 'compress all but the last n messages into a summary (default n: 60)')
    .option('--to-member <name>', "hand the session to a TEAMMATE — their daemon materializes it on their machine")
    .option('--dry-run', 'show what would be written without writing')
    .option('--force', 'write even if Codex does not appear to be installed')
    .option('--json', 'machine-readable output')
    .action(async (id: string, opts: { to: string; cwd?: string; open?: boolean; digest?: string | boolean; toMember?: string; dryRun?: boolean; force?: boolean; json?: boolean }) => {
      if (opts.to !== 'codex' && opts.to !== 'claude-code') {
        throw new Error(`Unsupported handoff target "${opts.to}" (supported: codex, claude-code)`);
      }
      const target = opts.to as HandoffTarget;
      const { claudeDir } = program.opts<{ claudeDir?: string }>();
      const cfg = loadConfig();

      if (opts.toMember) {
        // teammate handoff runs on THEIR machine, via the server queue
        if (!cfg.serverUrl || !cfg.memberToken) {
          throw new Error('Handing to a teammate needs a server connection (motif connect).');
        }
        const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken });
        // make sure the session exists server-side (sync it if it's only local)
        const sessionId = id.includes(':') ? id : `claude-code:${id}`;
        let resolved = sessionId;
        try {
          resolved = (await client.exportSession(sessionId)).id;
        } catch {
          const local = resolveSession(scanLocal(claudeDir).sessions, id);
          await client.putSession(local);
          resolved = local.id;
        }
        const req = await client.createHandoffRequest({ sessionId: resolved, cwd: opts.cwd, assignee: opts.toMember, target });
        console.log(`Handed ${resolved} to ${opts.toMember} (request #${req.id}, target: ${target}).`);
        console.log('Their daemon will materialize it on their machine; they get a ready-to-run resume command.');
        return;
      }

      // local parse is freshest; then local codex rollouts; then the team server
      let session: MotifSession | undefined;
      try {
        session = resolveSession(scanLocal(claudeDir).sessions, id);
      } catch {
        const bare = id.includes(':') ? id.split(':')[1]! : id;
        const codexLocal = discoverCodexSessions().filter((f) => f.sessionId.startsWith(bare));
        if (codexLocal.length === 1) session = readCodexSession(codexLocal[0]!.path);
      }
      if (!session) {
        if (!cfg.serverUrl || !cfg.token) {
          throw new Error(`No local session matches "${id}" and no server is configured.`);
        }
        const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken ?? cfg.token });
        session = await client.exportSession(id.includes(':') ? id : `claude-code:${id}`);
      }

      const digest =
        opts.digest !== undefined && opts.digest !== false
          ? { keepLast: typeof opts.digest === 'string' ? Number(opts.digest) || 60 : 60 }
          : undefined;
      if (!digest && session.messages.length > 300 && !opts.json) {
        console.log(
          `(note: ${session.messages.length} messages — consider --digest to keep the resume light in the target tool)`,
        );
      }

      if (opts.dryRun && target === 'claude-code') {
        const preview = performClaudeHandoff(session, { cwdOverride: opts.cwd, force: opts.force, dryRun: true });
        if (opts.json) {
          console.log(JSON.stringify({ target: preview.target, messages: preview.messageCount }, null, 2));
        } else {
          console.log(`Would write ${preview.messageCount} messages to:\n  ${preview.target}`);
          if (preview.droppedReasoning) {
            console.log(`(${preview.droppedReasoning} reasoning blocks dropped — not portable across providers)`);
          }
        }
        return;
      }
      if (opts.dryRun && target === 'codex') {
        const preview = toRolloutLines(
          opts.cwd ? { ...session, projectPath: path.resolve(opts.cwd) } : session,
          { threadId: uuidv7(new Date()), now: new Date(), digest },
        );
        const targetPath = path.join(codexHome(), preview.relativePath);
        if (opts.json) {
          console.log(JSON.stringify({ target: targetPath, lines: preview.lines.length, droppedReasoning: preview.droppedReasoning }, null, 2));
        } else {
          console.log(`Would write ${preview.lines.length} lines to:\n  ${targetPath}`);
          if (preview.droppedReasoning) console.log(`(${preview.droppedReasoning} reasoning blocks dropped — not portable across providers)`);
          for (const l of [...preview.lines.slice(0, 2), ...preview.lines.slice(-1)]) {
            console.log(`  ${JSON.stringify(l).slice(0, 140)}…`);
          }
        }
        return;
      }

      const result = performHandoff(target, session, { cwdOverride: opts.cwd, force: opts.force, digest });

      if (cfg.serverUrl && cfg.memberToken) {
        const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken });
        await client
          .postHandoff({ sessionId: session.id, target, outputPath: result.target, targetSessionId: result.threadId })
          .catch(() => {}); // team feed is best-effort
      }

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
        return;
      }
      console.log(`Handed off ${result.messageCount} messages → ${result.target}`);
      if (result.droppedReasoning) console.log(`(${result.droppedReasoning} reasoning blocks dropped — not portable across providers)`);
      if (target === 'codex') {
        console.log(result.registered ? 'Registered in Codex state DB.' : 'Codex will pick the session up from disk.');
      }

      if (opts.open) {
        const cwd = fs.existsSync(result.projectPath) ? result.projectPath : process.cwd();
        console.log(`\nOpening ${target === 'claude-code' ? 'Claude Code' : 'Codex'} in ${cwd}…\n`);
        // hand the terminal over to the target TUI, resumed into the session
        // (shell on Windows so .cmd shims resolve)
        const shell = process.platform === 'win32';
        if (target === 'claude-code') {
          spawnSync('claude', ['--resume', result.threadId], { cwd, stdio: 'inherit', shell });
        } else {
          const direct = spawnSync('codex', ['resume', result.threadId], { cwd, stdio: 'inherit', shell });
          if (direct.error && (direct.error as NodeJS.ErrnoException).code === 'ENOENT') {
            spawnSync('npx', ['-y', '@openai/codex', 'resume', result.threadId], { cwd, stdio: 'inherit', shell });
          }
        }
        return;
      }
      console.log(`\nContinue with:  ${resumeCommandFor(target, result.threadId)}`);
    });
}
