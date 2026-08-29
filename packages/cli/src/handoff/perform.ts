/**
 * The native-handoff engine, shared by the `motif handoff` command and the
 * daemon (which fulfils dashboard-initiated handoff requests on this
 * machine). Writes the Codex rollout and registers the thread in Codex's
 * state DB; the server never touches ~/.codex — only this machine does.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { serializeRollout, toRolloutLines, uuidv7, type MotifSession } from '@motif/core';

export function codexHome(): string {
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

/** Mirror Codex's own cli_version instead of hardcoding one, when a row exists to copy. */
function detectCliVersion(db: Database.Database): string {
  try {
    const row = db.prepare('SELECT cli_version FROM threads ORDER BY updated_at DESC LIMIT 1').get() as
      | { cli_version: string }
      | undefined;
    if (row?.cli_version) return row.cli_version;
  } catch {
    /* fall through */
  }
  return '0.150.1';
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
        detectCliVersion(db),
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

export interface HandoffResult {
  target: string;
  threadId: string;
  registered: boolean;
  droppedReasoning: number;
  messageCount: number;
  projectPath: string;
}

export function performCodexHandoff(
  session: MotifSession,
  opts: { cwdOverride?: string; force?: boolean } = {},
): HandoffResult {
  if (opts.cwdOverride) session = { ...session, projectPath: path.resolve(opts.cwdOverride) };

  const home = codexHome();
  if (!fs.existsSync(home) && !opts.force) {
    throw new Error(`${home} not found — is Codex installed? (--force to write anyway)`);
  }

  const now = new Date();
  const result = toRolloutLines(session, { threadId: uuidv7(now), now });
  const target = path.join(home, result.relativePath);
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
        now,
      })
    : false;

  return {
    target,
    threadId: result.threadId,
    registered,
    droppedReasoning: result.droppedReasoning,
    messageCount: session.messages.length,
    projectPath: session.projectPath,
  };
}
