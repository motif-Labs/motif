import crypto from 'node:crypto';
import type { MotifMessage, MotifSession } from '@motif/core';
import type { Db } from './db/database.js';

export interface SessionMetaPayload extends Omit<MotifSession, 'messages'> {}

export interface SessionRow {
  pk: number;
  id: string;
  source: string;
  source_session_id: string;
  member_id: number;
  source_path: string | null;
  project_path: string;
  git_branch: string | null;
  title: string | null;
  created_at: string | null;
  updated_at: string | null;
  tool_version: string | null;
  files_touched: string;
  meta_json: string;
  last_extracted_seq: number;
}

export function prefixHash(ids: string[]): string {
  return crypto.createHash('sha256').update(ids.join('\n')).digest('hex');
}

export function registerMember(
  db: Db,
  input: { name: string; email?: string; machine?: string },
): { memberId: number; created: boolean } {
  const now = new Date().toISOString();
  if (input.email) {
    const existing = db.prepare('SELECT id FROM members WHERE email = ?').get(input.email) as
      | { id: number }
      | undefined;
    if (existing) {
      db.prepare('UPDATE members SET name = ?, machine = ?, last_seen_at = ? WHERE id = ?').run(
        input.name,
        input.machine ?? null,
        now,
        existing.id,
      );
      return { memberId: existing.id, created: false };
    }
  }
  const res = db
    .prepare('INSERT INTO members(name, email, machine, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.name, input.email ?? null, input.machine ?? null, now, now);
  return { memberId: Number(res.lastInsertRowid), created: true };
}

export function touchMember(db: Db, memberId: number): void {
  db.prepare('UPDATE members SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), memberId);
}

function upsertSessionRow(db: Db, memberId: number, meta: SessionMetaPayload): SessionRow {
  db.prepare(
    `INSERT INTO sessions (id, source, source_session_id, member_id, source_path, project_path,
       git_branch, title, created_at, updated_at, tool_version, files_touched, meta_json)
     VALUES (@id, @source, @sourceSessionId, @memberId, @sourcePath, @projectPath,
       @gitBranch, @title, @createdAt, @updatedAt, @toolVersion, @filesTouched, @metaJson)
     ON CONFLICT(source, source_session_id, member_id) DO UPDATE SET
       source_path = excluded.source_path, project_path = excluded.project_path,
       git_branch = excluded.git_branch, title = excluded.title,
       created_at = excluded.created_at, updated_at = excluded.updated_at,
       tool_version = excluded.tool_version, files_touched = excluded.files_touched,
       meta_json = excluded.meta_json`,
  ).run({
    id: meta.id,
    source: meta.source,
    sourceSessionId: meta.sourceSessionId,
    memberId,
    sourcePath: meta.sourcePath ?? null,
    projectPath: meta.projectPath ?? '',
    gitBranch: meta.gitBranch ?? null,
    title: meta.title ?? null,
    createdAt: meta.createdAt ?? null,
    updatedAt: meta.updatedAt ?? null,
    toolVersion: meta.toolVersion ?? null,
    filesTouched: JSON.stringify(meta.filesTouched ?? []),
    metaJson: JSON.stringify(meta.meta ?? {}),
  });
  return db
    .prepare('SELECT * FROM sessions WHERE source = ? AND source_session_id = ? AND member_id = ?')
    .get(meta.source, meta.sourceSessionId, memberId) as SessionRow;
}

function insertMessages(db: Db, sessionPk: number, startSeq: number, messages: MotifMessage[]): void {
  const insertMsg = db.prepare(
    'INSERT INTO messages (session_pk, id, seq, role, content_json, ts) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertFts = db.prepare('INSERT INTO messages_fts (text, session_pk) VALUES (?, ?)');
  let seq = startSeq;
  for (const m of messages) {
    insertMsg.run(sessionPk, m.id, seq++, m.role, JSON.stringify(m), m.timestamp ?? null);
    if ((m.role === 'user' || m.role === 'assistant') && m.text) {
      insertFts.run(m.text, sessionPk);
    }
  }
}

export function fullReplaceSession(db: Db, memberId: number, session: MotifSession): SessionRow {
  return db.transaction(() => {
    const row = upsertSessionRow(db, memberId, session);
    db.prepare('DELETE FROM messages WHERE session_pk = ?').run(row.pk);
    db.prepare('DELETE FROM messages_fts WHERE session_pk = ?').run(row.pk);
    insertMessages(db, row.pk, 0, session.messages);
    return row;
  })();
}

export type AppendResult =
  | { ok: true; row: SessionRow; appended: number; lastId: string | null }
  | { ok: false; reason: 'unknown-session' | 'prefix-mismatch' };

/**
 * Idempotent incremental append. The client claims the server's tail is
 * `afterId` with `hash` covering all ids up to it; on any disagreement the
 * caller falls back to a full PUT.
 */
export function appendMessages(
  db: Db,
  memberId: number,
  meta: SessionMetaPayload,
  afterId: string | null,
  hash: string,
  messages: MotifMessage[],
): AppendResult {
  return db.transaction((): AppendResult => {
    const existing = db
      .prepare('SELECT * FROM sessions WHERE source = ? AND source_session_id = ? AND member_id = ?')
      .get(meta.source, meta.sourceSessionId, memberId) as SessionRow | undefined;

    if (!existing) {
      if (afterId !== null) return { ok: false, reason: 'unknown-session' };
      const row = upsertSessionRow(db, memberId, meta);
      insertMessages(db, row.pk, 0, messages);
      return { ok: true, row, appended: messages.length, lastId: messages.at(-1)?.id ?? null };
    }

    const storedIds = (
      db.prepare('SELECT id FROM messages WHERE session_pk = ? ORDER BY seq').all(existing.pk) as {
        id: string;
      }[]
    ).map((r) => r.id);
    const tail = storedIds.at(-1) ?? null;
    if (tail !== afterId || prefixHash(storedIds) !== hash) {
      return { ok: false, reason: 'prefix-mismatch' };
    }
    const row = upsertSessionRow(db, memberId, meta);
    insertMessages(db, row.pk, storedIds.length, messages);
    return { ok: true, row, appended: messages.length, lastId: messages.at(-1)?.id ?? tail };
  })();
}

export interface SessionListItem {
  id: string;
  source: string;
  memberId: number;
  memberName: string | null;
  projectPath: string;
  gitBranch: string | null;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
}

export function listSessions(
  db: Db,
  opts: { project?: string; memberId?: number; limit?: number } = {},
): SessionListItem[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.project) {
    where.push('s.project_path = ?');
    params.push(opts.project);
  }
  if (opts.memberId !== undefined) {
    where.push('s.member_id = ?');
    params.push(opts.memberId);
  }
  const rows = db
    .prepare(
      `SELECT s.id, s.source, s.member_id, m.name AS member_name, s.project_path, s.git_branch,
              s.title, s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM messages WHERE session_pk = s.pk) AS message_count
       FROM sessions s LEFT JOIN members m ON m.id = s.member_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY s.updated_at DESC
       LIMIT ?`,
    )
    .all(...params, opts.limit ?? 50) as {
    id: string;
    source: string;
    member_id: number;
    member_name: string | null;
    project_path: string;
    git_branch: string | null;
    title: string | null;
    created_at: string | null;
    updated_at: string | null;
    message_count: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    memberId: r.member_id,
    memberName: r.member_name,
    projectPath: r.project_path,
    gitBranch: r.git_branch,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count,
  }));
}

/**
 * Accepts a full motif id, a source uuid, or a unique uuid prefix (like the
 * CLI's local resolution). Most recently updated row wins on ties.
 */
export function getSessionRow(db: Db, id: string): SessionRow | undefined {
  const exact = db
    .prepare('SELECT * FROM sessions WHERE id = ? OR source_session_id = ? ORDER BY updated_at DESC LIMIT 1')
    .get(id, id) as SessionRow | undefined;
  if (exact) return exact;
  const prefix = id.includes(':') ? id.split(':')[1]! : id;
  if (prefix.length < 4) return undefined; // too short to be a meaningful prefix
  return db
    .prepare(
      "SELECT * FROM sessions WHERE source_session_id LIKE ? || '%' ESCAPE '\\' ORDER BY updated_at DESC LIMIT 1",
    )
    .get(prefix.replace(/[%_\\]/g, '\\$&')) as SessionRow | undefined;
}

export function getSessionMessages(db: Db, sessionPk: number): MotifMessage[] {
  const rows = db
    .prepare('SELECT content_json FROM messages WHERE session_pk = ? ORDER BY seq')
    .all(sessionPk) as { content_json: string }[];
  return rows.map((r) => JSON.parse(r.content_json) as MotifMessage);
}

export function exportSession(db: Db, id: string): MotifSession | undefined {
  const row = getSessionRow(db, id);
  if (!row) return undefined;
  return {
    id: row.id,
    source: row.source as MotifSession['source'],
    sourceSessionId: row.source_session_id,
    sourcePath: row.source_path ?? '',
    projectPath: row.project_path,
    gitBranch: row.git_branch ?? undefined,
    title: row.title ?? undefined,
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
    toolVersion: row.tool_version ?? undefined,
    messages: getSessionMessages(db, row.pk),
    filesTouched: JSON.parse(row.files_touched) as string[],
    meta: JSON.parse(row.meta_json) as MotifSession['meta'],
  };
}

export function searchSessions(db: Db, q: string, limit = 30): (SessionListItem & { snippet: string })[] {
  const rows = db
    .prepare(
      `WITH f AS MATERIALIZED (
         SELECT session_pk, rank, snippet(messages_fts, 0, '', '', '…', 12) AS snip
         FROM messages_fts WHERE messages_fts MATCH ?
       )
       SELECT s.id, s.source, s.member_id, m.name AS member_name, s.project_path, s.git_branch,
              s.title, s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM messages WHERE session_pk = s.pk) AS message_count,
              f.snip, MIN(f.rank) AS best_rank
       FROM f
       JOIN sessions s ON s.pk = f.session_pk
       LEFT JOIN members m ON m.id = s.member_id
       GROUP BY s.pk
       ORDER BY best_rank
       LIMIT ?`,
    )
    .all(q, limit) as ({
    id: string;
    source: string;
    member_id: number;
    member_name: string | null;
    project_path: string;
    git_branch: string | null;
    title: string | null;
    created_at: string | null;
    updated_at: string | null;
    message_count: number;
    snip: string;
  })[];
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    memberId: r.member_id,
    memberName: r.member_name,
    projectPath: r.project_path,
    gitBranch: r.git_branch,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count,
    snippet: r.snip,
  }));
}
