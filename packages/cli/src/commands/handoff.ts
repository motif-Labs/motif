import type { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  serializeRollout,
  toRolloutLines,
  uuidv7,
  type MotifSession,
} from '@motif/core';
import { resolveSession, scanLocal } from '../local.js';
import { loadConfig } from '../config.js';
import { MotifClient } from '../api-client.js';

function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

/** Newest versioned state DB (state_5.sqlite today; the suffix tracks Codex migrations). */
function findStateDb(home: string): string | undefined {
  try {
    const dbs = fs
      .readdirSync(home)
      .filter((n) => /^state_\d+\.sqlite$/.test(n))
      .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    return dbs[0] ? path.join(home, dbs[0]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Registers the thread in Codex's state DB so the resume picker lists it even
 * when the DB (not a file scan) is the source of listings. Best-effort: on any
 * schema surprise we leave it to Codex's own filesystem reconcile.
 */
function insertThreadRow(
  dbPath: string,
  input: {
    threadId: string;
    rolloutPath: string;
    cwd: string;
    title: string;
    firstUserMessage: string;
    gitBranch?: string;
    cliVersion: string;
    now: Date;
  },
): boolean {
  try {
    const db = new Database(dbPath);
    try {
      const sec = Math.floor(input.now.getTime() / 1000);
      const ms = input.now.getTime();
      db.prepare(
        `INSERT INTO threads (
           id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
           sandbox_policy, approval_mode, cli_version, first_user_message, memory_mode,
           created_at_ms, updated_at_ms, thread_source, preview, recency_at, recency_at_ms,
           history_mode, git_branch
         ) VALUES (?, ?, ?, ?, 'cli', 'openai', ?, ?, '{"type":"read-only"}', 'on-request', ?, ?, 'enabled',
           ?, ?, 'user', ?, ?, ?, 'legacy', ?)`,
      ).run(
        input.threadId,
        input.rolloutPath,
        sec,
        sec,
        input.cwd,
        input.title.slice(0, 200),
        input.cliVersion,
        input.firstUserMessage.slice(0, 500),
        ms,
        ms,
        input.firstUserMessage.slice(0, 200),
        sec,
        ms,
        input.gitBranch ?? null,
      );
      return true;
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`(state db registration skipped: ${String(err).slice(0, 120)})`);
    return false;
  }
}

export function registerHandoff(program: Command): void {
  program
    .command('handoff <id>')
    .description('Continue a session in another tool, natively (Claude Code → Codex)')
    .option('--to <tool>', 'target tool', 'codex')
    .option('--dry-run', 'show what would be written without writing')
    .option('--force', 'write even if Codex does not appear to be installed')
    .option('--json', 'machine-readable output')
    .action(async (id: string, opts: { to: string; dryRun?: boolean; force?: boolean; json?: boolean }) => {
      if (opts.to !== 'codex') throw new Error(`Unsupported handoff target "${opts.to}" (v0.1 supports: codex)`);
      const { claudeDir } = program.opts<{ claudeDir?: string }>();
      const cfg = loadConfig();

      // local parse is freshest; fall back to the team server for teammates' sessions
      let session: MotifSession;
      try {
        session = resolveSession(scanLocal(claudeDir).sessions, id);
      } catch (localErr) {
        if (!cfg.serverUrl || !cfg.token) throw localErr;
        const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.token, memberId: cfg.memberId });
        session = await client.exportSession(id.includes(':') ? id : `claude-code:${id}`);
      }

      const home = codexHome();
      if (!fs.existsSync(home) && !opts.force) {
        throw new Error(`${home} not found — is Codex installed? (--force to write anyway)`);
      }

      const now = new Date();
      const result = toRolloutLines(session, { threadId: uuidv7(now), now });
      const target = path.join(home, result.relativePath);

      if (opts.dryRun) {
        const preview = result.lines.slice(0, 2).concat(result.lines.slice(-1));
        if (opts.json) {
          console.log(JSON.stringify({ target, lines: result.lines.length, droppedReasoning: result.droppedReasoning }, null, 2));
        } else {
          console.log(`Would write ${result.lines.length} lines to:\n  ${target}`);
          if (result.droppedReasoning) console.log(`(${result.droppedReasoning} reasoning blocks dropped — not portable across providers)`);
          for (const l of preview) console.log(`  ${JSON.stringify(l).slice(0, 140)}…`);
        }
        return;
      }

      if (fs.existsSync(target)) throw new Error(`Refusing to overwrite existing rollout: ${target}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, serializeRollout(result.lines));

      const stateDb = findStateDb(home);
      const registered = stateDb
        ? insertThreadRow(stateDb, {
            threadId: result.threadId,
            rolloutPath: target,
            cwd: session.projectPath || '/',
            title: result.title,
            firstUserMessage: result.firstUserMessage,
            gitBranch: session.gitBranch !== 'HEAD' ? session.gitBranch : undefined,
            cliVersion: '0.150.1',
            now,
          })
        : false;

      if (cfg.serverUrl && cfg.token) {
        const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.token, memberId: cfg.memberId });
        await client
          .postHandoff({ sessionId: session.id, target: 'codex', outputPath: target, targetSessionId: result.threadId })
          .catch(() => {}); // team feed is best-effort
      }

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, target, threadId: result.threadId, registered, droppedReasoning: result.droppedReasoning }, null, 2));
        return;
      }
      console.log(`Handed off ${session.messages.length} messages → ${target}`);
      if (result.droppedReasoning) console.log(`(${result.droppedReasoning} reasoning blocks dropped — not portable across providers)`);
      console.log(registered ? 'Registered in Codex state DB.' : 'Codex will pick the session up from disk.');
      console.log(`\nContinue with:  codex resume ${result.threadId}`);
    });
}
