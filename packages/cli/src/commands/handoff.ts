import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { toRolloutLines, uuidv7, type MotifSession } from '@motif/core';
import { resolveSession, scanLocal } from '../local.js';
import { loadConfig } from '../config.js';
import { MotifClient } from '../api-client.js';
import { codexHome, performCodexHandoff } from '../handoff/perform.js';

export function registerHandoff(program: Command): void {
  program
    .command('handoff <id>')
    .description('Continue a session in another tool, natively (Claude Code → Codex)')
    .option('--to <tool>', 'target tool', 'codex')
    .option('--cwd <path>', "map the session onto your local clone (a teammate's project path differs from yours)")
    .option('--open', 'launch Codex right into the handed-off session')
    .option('--dry-run', 'show what would be written without writing')
    .option('--force', 'write even if Codex does not appear to be installed')
    .option('--json', 'machine-readable output')
    .action(async (id: string, opts: { to: string; cwd?: string; open?: boolean; dryRun?: boolean; force?: boolean; json?: boolean }) => {
      if (opts.to !== 'codex') throw new Error(`Unsupported handoff target "${opts.to}" (v0.1 supports: codex)`);
      const { claudeDir } = program.opts<{ claudeDir?: string }>();
      const cfg = loadConfig();

      // local parse is freshest; fall back to the team server for teammates' sessions
      let session: MotifSession;
      try {
        session = resolveSession(scanLocal(claudeDir).sessions, id);
      } catch (localErr) {
        if (!cfg.serverUrl || !cfg.token) throw localErr;
        const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken ?? cfg.token });
        session = await client.exportSession(id.includes(':') ? id : `claude-code:${id}`);
      }

      if (opts.dryRun) {
        const preview = toRolloutLines(
          opts.cwd ? { ...session, projectPath: path.resolve(opts.cwd) } : session,
          { threadId: uuidv7(new Date()), now: new Date() },
        );
        const target = path.join(codexHome(), preview.relativePath);
        if (opts.json) {
          console.log(JSON.stringify({ target, lines: preview.lines.length, droppedReasoning: preview.droppedReasoning }, null, 2));
        } else {
          console.log(`Would write ${preview.lines.length} lines to:\n  ${target}`);
          if (preview.droppedReasoning) console.log(`(${preview.droppedReasoning} reasoning blocks dropped — not portable across providers)`);
          for (const l of [...preview.lines.slice(0, 2), ...preview.lines.slice(-1)]) {
            console.log(`  ${JSON.stringify(l).slice(0, 140)}…`);
          }
        }
        return;
      }

      const result = performCodexHandoff(session, { cwdOverride: opts.cwd, force: opts.force });

      if (cfg.serverUrl && cfg.memberToken) {
        const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken });
        await client
          .postHandoff({ sessionId: session.id, target: 'codex', outputPath: result.target, targetSessionId: result.threadId })
          .catch(() => {}); // team feed is best-effort
      }

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
        return;
      }
      console.log(`Handed off ${result.messageCount} messages → ${result.target}`);
      if (result.droppedReasoning) console.log(`(${result.droppedReasoning} reasoning blocks dropped — not portable across providers)`);
      console.log(result.registered ? 'Registered in Codex state DB.' : 'Codex will pick the session up from disk.');

      if (opts.open) {
        const cwd = fs.existsSync(result.projectPath) ? result.projectPath : process.cwd();
        console.log(`\nOpening Codex in ${cwd}…\n`);
        // hand the terminal over to the Codex TUI, resumed into the session
        const direct = spawnSync('codex', ['resume', result.threadId], { cwd, stdio: 'inherit' });
        if (direct.error && (direct.error as NodeJS.ErrnoException).code === 'ENOENT') {
          spawnSync('npx', ['-y', '@openai/codex', 'resume', result.threadId], { cwd, stdio: 'inherit' });
        }
        return;
      }
      console.log(`\nContinue with:  codex resume ${result.threadId}`);
    });
}
