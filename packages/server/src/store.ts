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
  visibility: 'team' | 'personal';
}

/** May this viewer see this session at all? */
export function canView(
  row: Pick<SessionRow, 'visibility' | 'member_id'>,
  viewerId: number | undefined,
): boolean {
  return row.visibility === 'team' || (viewerId !== undefined && row.member_id === viewerId);
}

export function prefixHash(ids: string[]): string {
  return crypto.createHash('sha256').update(ids.join('\n')).digest('hex');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Registers (or re-recognizes) a member and mints a per-device member token.
 * Identity on every later request comes from that token — never from a
 * client-claimed header. The first member becomes the owner.
 */
export function registerMember(
  db: Db,
  input: { name: string; email?: string; machine?: string },
): { memberId: number; memberToken: string; role: string; created: boolean } {
  const now = new Date().toISOString();
  let existing: { id: number; role: string } | undefined;
  if (input.email) {
    existing = db.prepare('SELECT id, role FROM members WHERE email = ?').get(input.email) as
      { id: number; role: string } | undefined;
  }
  if (!existing) {
    // no email: same person reconnecting from the same machine keeps one identity
    existing = db
      .prepare('SELECT id, role FROM members WHERE email IS NULL AND name = ? AND machine = ?')
      .get(input.name, input.machine ?? null) as { id: number; role: string } | undefined;
  }

  let memberId: number;
  let role: string;
  let created = false;
  if (existing) {
    memberId = existing.id;
    role = existing.role;
    db.prepare('UPDATE members SET name = ?, machine = ?, last_seen_at = ? WHERE id = ?').run(
      input.name,
      input.machine ?? null,
      now,
      memberId,
    );
  } else {
    const isFirst = (db.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number }).n === 0;
    role = isFirst ? 'owner' : 'member';
    const res = db
      .prepare(
        'INSERT INTO members(name, email, machine, role, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(input.name, input.email ?? null, input.machine ?? null, role, now, now);
    memberId = Number(res.lastInsertRowid);
    created = true;
  }

  const memberToken = `mm_${crypto.randomBytes(24).toString('base64url')}`;
  db.prepare(
    'INSERT INTO member_tokens (member_id, token_hash, machine, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)',
  ).run(memberId, hashToken(memberToken), input.machine ?? null, now, now);
  return { memberId, memberToken, role, created };
}

/** Maps a bearer token to a member id; undefined if it is not a member token. */
export function resolveMemberByToken(db: Db, token: string): number | undefined {
  const row = db
    .prepare('SELECT id, member_id FROM member_tokens WHERE token_hash = ?')
    .get(hashToken(token)) as { id: number; member_id: number } | undefined;
  if (!row) return undefined;
  db.prepare('UPDATE member_tokens SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  return row.member_id;
}

export function touchMember(db: Db, memberId: number): void {
  db.prepare('UPDATE members SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), memberId);
}

function upsertSessionRow(db: Db, memberId: number, meta: SessionMetaPayload): SessionRow {
  // A daemon may set visibility from the project scope it was told about, but
  // it must never undo a choice a person made by hand in the dashboard — that
  // is what visibility_locked marks. The conflict key includes member_id, so a
  // daemon can only ever touch rows it owns.
  db.prepare(
    `INSERT INTO sessions (id, source, source_session_id, member_id, source_path, project_path,
       git_branch, title, created_at, updated_at, tool_version, files_touched, meta_json, visibility)
     VALUES (@id, @source, @sourceSessionId, @memberId, @sourcePath, @projectPath,
       @gitBranch, @title, @createdAt, @updatedAt, @toolVersion, @filesTouched, @metaJson, @visibility)
     ON CONFLICT(source, source_session_id, member_id) DO UPDATE SET
       source_path = excluded.source_path, project_path = excluded.project_path,
       git_branch = excluded.git_branch, title = excluded.title,
       created_at = excluded.created_at, updated_at = excluded.updated_at,
       tool_version = excluded.tool_version, files_touched = excluded.files_touched,
       meta_json = excluded.meta_json,
       visibility = CASE WHEN sessions.visibility_locked = 1
                         THEN sessions.visibility ELSE excluded.visibility END`,
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
    visibility: meta.visibility === 'personal' ? 'personal' : 'team',
  });
  return db
    .prepare('SELECT * FROM sessions WHERE source = ? AND source_session_id = ? AND member_id = ?')
    .get(meta.source, meta.sourceSessionId, memberId) as SessionRow;
}

function insertMessages(db: Db, sessionPk: number, startSeq: number, messages: MotifMessage[]): void {
  // OR IGNORE keeps the protocol idempotent even if a source emits duplicate ids
  const insertMsg = db.prepare(
    'INSERT OR IGNORE INTO messages (session_pk, id, seq, role, content_json, ts) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertFts = db.prepare('INSERT INTO messages_fts (text, session_pk, message_id) VALUES (?, ?, ?)');
  let seq = startSeq;
  for (const m of messages) {
    const res = insertMsg.run(sessionPk, m.id, seq, m.role, JSON.stringify(m), m.timestamp ?? null);
    if (res.changes === 0) continue; // duplicate id — first occurrence wins
    seq++;
    if ((m.role === 'user' || m.role === 'assistant') && m.text) {
      insertFts.run(m.text, sessionPk, m.id);
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
  visibility: 'team' | 'personal';
}

export function listSessions(
  db: Db,
  opts: {
    project?: string;
    memberId?: number;
    limit?: number;
    viewerId?: number;
    scope?: 'team' | 'personal';
  } = {},
): SessionListItem[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.scope === 'personal') {
    // personal scope is strictly the viewer's own drawer
    where.push("s.visibility = 'personal' AND s.member_id = ?");
    params.push(opts.viewerId ?? -1);
  } else if (opts.scope === 'team') {
    where.push("s.visibility = 'team'");
  } else {
    where.push("(s.visibility = 'team' OR s.member_id = ?)");
    params.push(opts.viewerId ?? -1);
  }
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
              s.title, s.created_at, s.updated_at, s.visibility,
              (SELECT COUNT(*) FROM messages WHERE session_pk = s.pk) AS message_count
       FROM sessions s LEFT JOIN members m ON m.id = s.member_id
       WHERE ${where.join(' AND ')}
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
    visibility: 'team' | 'personal';
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
    visibility: r.visibility,
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
    visibility: row.visibility,
    messages: getSessionMessages(db, row.pk),
    filesTouched: JSON.parse(row.files_touched) as string[],
    meta: JSON.parse(row.meta_json) as MotifSession['meta'],
  };
}

/** FTS5 MATCH treats quotes/operators as syntax; quote each term so raw user input never 500s. */
export function ftsQuery(q: string): string {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

export interface HandoffRequestRow {
  id: number;
  session_id: string;
  requested_by: number;
  /** Who executes (and receives) the handoff; null = the requester themselves. */
  assignee_id: number | null;
  target: string;
  cwd_override: string | null;
  status: 'pending' | 'done' | 'error';
  output_path: string | null;
  target_session_id: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  /** Joined for display: who asked (relevant when assigned to a teammate). */
  requester_name?: string | null;
}

/**
 * Queued handoffs: the server can't write into anyone's ~/.codex, so a
 * request is executed by a daemon on the EXECUTOR'S machine. The executor is
 * the assignee when set (a teammate being handed the work, Mosaic-style),
 * otherwise the requester (dashboard button on your own session). A daemon
 * only ever sees requests it is the executor of.
 */
export function createHandoffRequest(
  db: Db,
  memberId: number,
  input: { sessionId: string; target?: string; cwd?: string; assigneeId?: number },
): HandoffRequestRow {
  const res = db
    .prepare(
      `INSERT INTO handoff_requests (session_id, requested_by, assignee_id, target, cwd_override, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sessionId,
      memberId,
      input.assigneeId ?? null,
      input.target ?? 'codex',
      input.cwd ?? null,
      new Date().toISOString(),
    );
  return db
    .prepare('SELECT * FROM handoff_requests WHERE id = ?')
    .get(res.lastInsertRowid) as HandoffRequestRow;
}

/** The member id whose daemon must execute a request. */
export function handoffExecutor(row: Pick<HandoffRequestRow, 'requested_by' | 'assignee_id'>): number {
  return row.assignee_id ?? row.requested_by;
}

export function listHandoffRequests(
  db: Db,
  memberId: number,
  opts: { status?: string } = {},
): HandoffRequestRow[] {
  const base = `SELECT h.*, m.name AS requester_name FROM handoff_requests h
                LEFT JOIN members m ON m.id = h.requested_by
                WHERE COALESCE(h.assignee_id, h.requested_by) = ?`;
  if (opts.status) {
    return db
      .prepare(`${base} AND h.status = ? ORDER BY h.id`)
      .all(memberId, opts.status) as HandoffRequestRow[];
  }
  return db.prepare(`${base} ORDER BY h.id DESC LIMIT 50`).all(memberId) as HandoffRequestRow[];
}

/** One request, visible to whoever asked for it or has to run it. */
export function getHandoffRequestFor(db: Db, memberId: number, id: number): HandoffRequestRow | undefined {
  return db
    .prepare(
      `SELECT h.*, m.name AS requester_name FROM handoff_requests h
       LEFT JOIN members m ON m.id = h.requested_by
       WHERE h.id = ? AND (h.requested_by = ? OR COALESCE(h.assignee_id, h.requested_by) = ?)`,
    )
    .get(id, memberId, memberId) as HandoffRequestRow | undefined;
}

export function completeHandoffRequest(
  db: Db,
  memberId: number,
  requestId: number,
  result: { status: 'done' | 'error'; outputPath?: string; targetSessionId?: string; error?: string },
): HandoffRequestRow | undefined {
  const changed = db
    .prepare(
      `UPDATE handoff_requests SET status = ?, output_path = ?, target_session_id = ?, error = ?, completed_at = ?
       WHERE id = ? AND COALESCE(assignee_id, requested_by) = ? AND status = 'pending'`,
    )
    .run(
      result.status,
      result.outputPath ?? null,
      result.targetSessionId ?? null,
      result.error ?? null,
      new Date().toISOString(),
      requestId,
      memberId,
    );
  if (changed.changes === 0) return undefined;
  return db.prepare('SELECT * FROM handoff_requests WHERE id = ?').get(requestId) as HandoffRequestRow;
}

/** Resolves a teammate reference — id, exact name, or @handle-ish prefix. */
export function resolveMember(db: Db, ref: string): { id: number; name: string } | undefined {
  const clean = ref.replace(/^@/, '').trim();
  if (/^\d+$/.test(clean)) {
    return db.prepare('SELECT id, name FROM members WHERE id = ?').get(Number(clean)) as
      { id: number; name: string } | undefined;
  }
  const exact = db
    .prepare('SELECT id, name FROM members WHERE LOWER(name) = LOWER(?) OR LOWER(email) = LOWER(?)')
    .get(clean, clean) as { id: number; name: string } | undefined;
  if (exact) return exact;
  const prefix = db
    .prepare('SELECT id, name FROM members WHERE LOWER(name) LIKE LOWER(?) ORDER BY id LIMIT 2')
    .all(`${clean}%`) as { id: number; name: string }[];
  return prefix.length === 1 ? prefix[0] : undefined;
}

export function searchSessions(
  db: Db,
  q: string,
  limit = 30,
  viewerId?: number,
  project?: string,
): (SessionListItem & { snippet: string })[] {
  const rows = db
    .prepare(
      `WITH f AS MATERIALIZED (
         SELECT session_pk, rank, snippet(messages_fts, 0, '', '', '…', 12) AS snip
         FROM messages_fts WHERE messages_fts MATCH ?
       )
       SELECT s.id, s.source, s.member_id, m.name AS member_name, s.project_path, s.git_branch,
              s.title, s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM messages WHERE session_pk = s.pk) AS message_count,
              s.visibility, f.snip, MIN(f.rank) AS best_rank
       FROM f
       JOIN sessions s ON s.pk = f.session_pk
       LEFT JOIN members m ON m.id = s.member_id
       WHERE (s.visibility = 'team' OR s.member_id = ?)
         AND (? IS NULL OR s.project_path = ?)
       GROUP BY s.pk
       ORDER BY best_rank
       LIMIT ?`,
    )
    .all(ftsQuery(q), viewerId ?? -1, project ?? null, project ?? null, limit) as {
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
    visibility: 'team' | 'personal';
    snip: string;
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
    visibility: r.visibility,
    snippet: r.snip,
  }));
}

export interface CommentRow {
  id: number;
  session_pk: number;
  message_id: string | null;
  author_id: number;
  author_name: string | null;
  body: string;
  mentions: number[];
  created_at: string;
}

/** Finds @mentions in a comment body against the member roster (longest names first). */
export function parseMentions(db: Db, body: string): number[] {
  if (!body.includes('@')) return [];
  const members = db.prepare('SELECT id, name FROM members').all() as { id: number; name: string }[];
  const lower = body.toLowerCase();
  return members
    .sort((a, b) => b.name.length - a.name.length)
    .filter((m) => lower.includes(`@${m.name.toLowerCase()}`))
    .map((m) => m.id);
}

export function addComment(
  db: Db,
  authorId: number,
  sessionPk: number,
  messageId: string | null,
  body: string,
): CommentRow {
  const mentions = parseMentions(db, body);
  const res = db
    .prepare(
      'INSERT INTO session_comments (session_pk, message_id, author_id, body, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(sessionPk, messageId, authorId, body, JSON.stringify(mentions), new Date().toISOString());
  return listComments(db, sessionPk).find((c) => c.id === Number(res.lastInsertRowid))!;
}

export function listComments(db: Db, sessionPk: number): CommentRow[] {
  const rows = db
    .prepare(
      `SELECT c.*, m.name AS author_name FROM session_comments c
       LEFT JOIN members m ON m.id = c.author_id
       WHERE c.session_pk = ? ORDER BY c.id`,
    )
    .all(sessionPk) as (Omit<CommentRow, 'mentions'> & { mentions: string })[];
  return rows.map((r) => ({ ...r, mentions: JSON.parse(r.mentions) as number[] }));
}

/** Authors delete their own comments; nobody else's. */
export function deleteComment(db: Db, authorId: number, commentId: number): boolean {
  return (
    db.prepare('DELETE FROM session_comments WHERE id = ? AND author_id = ?').run(commentId, authorId)
      .changes > 0
  );
}

export interface AskRequestRow {
  id: number;
  session_id: string;
  asked_by: number;
  executor_id: number;
  question: string;
  status: 'pending' | 'done' | 'error';
  answer: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  asker_name?: string | null;
  session_title?: string | null;
}

/**
 * "Ask a past session a question": only the machine that owns the raw
 * transcript can answer, so the executor is always the session's owner. The
 * asker just queues the question; the owner's daemon resumes the session
 * headlessly and writes the answer back.
 */
export function createAskRequest(
  db: Db,
  askerId: number,
  session: SessionRow,
  question: string,
): AskRequestRow {
  const res = db
    .prepare(
      'INSERT INTO ask_requests (session_id, asked_by, executor_id, question, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(session.id, askerId, session.member_id, question, new Date().toISOString());
  return getAskRequest(db, Number(res.lastInsertRowid))!;
}

export function getAskRequest(db: Db, id: number): AskRequestRow | undefined {
  return db
    .prepare(
      `SELECT a.*, m.name AS asker_name, s.title AS session_title
       FROM ask_requests a
       LEFT JOIN members m ON m.id = a.asked_by
       LEFT JOIN sessions s ON s.id = a.session_id
       WHERE a.id = ?`,
    )
    .get(id) as AskRequestRow | undefined;
}

/** What this member's daemon must answer (executor scope). */
export function listAskRequests(db: Db, memberId: number, status?: string): AskRequestRow[] {
  const base = `SELECT a.*, m.name AS asker_name, s.title AS session_title
                FROM ask_requests a
                LEFT JOIN members m ON m.id = a.asked_by
                LEFT JOIN sessions s ON s.id = a.session_id
                WHERE a.executor_id = ?`;
  return status
    ? (db.prepare(`${base} AND a.status = ? ORDER BY a.id`).all(memberId, status) as AskRequestRow[])
    : (db.prepare(`${base} ORDER BY a.id DESC LIMIT 50`).all(memberId) as AskRequestRow[]);
}

/** Everything asked about one session — the "asked & answered" log. */
export function listAsksForSession(db: Db, sessionId: string): AskRequestRow[] {
  return db
    .prepare(
      `SELECT a.*, m.name AS asker_name FROM ask_requests a
       LEFT JOIN members m ON m.id = a.asked_by
       WHERE a.session_id = ? ORDER BY a.id`,
    )
    .all(sessionId) as AskRequestRow[];
}

export function completeAskRequest(
  db: Db,
  executorId: number,
  id: number,
  result: { status: 'done' | 'error'; answer?: string; error?: string },
): AskRequestRow | undefined {
  const changed = db
    .prepare(
      `UPDATE ask_requests SET status = ?, answer = ?, error = ?, completed_at = ?
       WHERE id = ? AND executor_id = ? AND status = 'pending'`,
    )
    .run(
      result.status,
      result.answer ?? null,
      result.error ?? null,
      new Date().toISOString(),
      id,
      executorId,
    );
  return changed.changes === 0 ? undefined : getAskRequest(db, id);
}

/** Owner-only scope change; the server owns visibility after insert. */
export function setSessionVisibility(
  db: Db,
  viewerId: number,
  id: string,
  visibility: 'team' | 'personal',
): SessionRow | undefined {
  const row = getSessionRow(db, id);
  if (!row || row.member_id !== viewerId) return undefined;
  // an explicit choice outranks whatever the daemon computes from then on
  db.prepare('UPDATE sessions SET visibility = ?, visibility_locked = 1 WHERE pk = ?').run(
    visibility,
    row.pk,
  );
  return { ...row, visibility };
}
