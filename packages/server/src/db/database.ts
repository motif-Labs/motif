import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type Db = Database.Database;

/**
 * Collapses members that are really the same person (same name/email/machine)
 * into the earliest row, re-pointing everything they own. Sessions that were
 * synced under several duplicate identities keep only the freshest copy.
 */
const DEDUPE_MEMBERS_SQL = `
  CREATE TEMP TABLE dup_keepers AS
    SELECT m.id AS id,
           (SELECT MIN(m2.id) FROM members m2
             WHERE m2.name = m.name
               AND COALESCE(m2.email, '') = COALESCE(m.email, '')
               AND COALESCE(m2.machine, '') = COALESCE(m.machine, '')) AS keeper
    FROM members m;

  CREATE TEMP TABLE doomed_sessions AS
    SELECT s.pk FROM sessions s
    JOIN dup_keepers k ON k.id = s.member_id
    WHERE EXISTS (
      SELECT 1 FROM sessions s2 JOIN dup_keepers k2 ON k2.id = s2.member_id
      WHERE k2.keeper = k.keeper
        AND s2.source = s.source AND s2.source_session_id = s.source_session_id
        AND (s2.updated_at > s.updated_at OR (s2.updated_at = s.updated_at AND s2.pk < s.pk))
    );

  DELETE FROM messages_fts WHERE session_pk IN (SELECT pk FROM doomed_sessions);
  DELETE FROM sessions WHERE pk IN (SELECT pk FROM doomed_sessions);
  UPDATE sessions SET member_id = (SELECT keeper FROM dup_keepers WHERE dup_keepers.id = sessions.member_id);
  UPDATE member_tokens SET member_id = (SELECT keeper FROM dup_keepers WHERE dup_keepers.id = member_tokens.member_id);
  UPDATE memory_notes SET member_id = (SELECT keeper FROM dup_keepers WHERE dup_keepers.id = memory_notes.member_id)
    WHERE member_id IS NOT NULL;
  UPDATE handoffs SET member_id = (SELECT keeper FROM dup_keepers WHERE dup_keepers.id = handoffs.member_id)
    WHERE member_id IS NOT NULL;
  UPDATE handoff_requests SET requested_by = (SELECT keeper FROM dup_keepers WHERE dup_keepers.id = handoff_requests.requested_by);
  DELETE FROM members WHERE id IN (SELECT id FROM dup_keepers WHERE id <> keeper);
  DROP TABLE doomed_sessions;
  DROP TABLE dup_keepers;
`;

/** Exposed for register-time reuse and tests; migration v3 runs the same SQL once. */
export function dedupeMembers(db: Db): void {
  db.exec(DEDUPE_MEMBERS_SQL);
}

const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    machine TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    source TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    member_id INTEGER NOT NULL REFERENCES members(id),
    source_path TEXT,
    project_path TEXT NOT NULL DEFAULT '',
    git_branch TEXT,
    title TEXT,
    created_at TEXT,
    updated_at TEXT,
    tool_version TEXT,
    files_touched TEXT NOT NULL DEFAULT '[]',
    meta_json TEXT NOT NULL DEFAULT '{}',
    last_extracted_seq INTEGER NOT NULL DEFAULT 0,
    UNIQUE(source, source_session_id, member_id)
  );
  CREATE INDEX idx_sessions_project ON sessions(project_path, updated_at DESC);
  CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);

  CREATE TABLE messages (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    session_pk INTEGER NOT NULL REFERENCES sessions(pk) ON DELETE CASCADE,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    ts TEXT,
    UNIQUE(session_pk, id)
  );
  CREATE INDEX idx_messages_session_seq ON messages(session_pk, seq);

  CREATE VIRTUAL TABLE messages_fts USING fts5(
    text,
    session_pk UNINDEXED,
    tokenize = 'porter unicode61'
  );

  CREATE TABLE memory_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('file','decision','topic')),
    name TEXT NOT NULL,
    project_path TEXT NOT NULL DEFAULT '',
    UNIQUE(kind, name, project_path)
  );

  CREATE TABLE memory_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
    aspect TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('current','superseded','conflicted')),
    superseded_by INTEGER REFERENCES memory_notes(id),
    conflict_with INTEGER REFERENCES memory_notes(id),
    source_session_pk INTEGER REFERENCES sessions(pk),
    member_id INTEGER REFERENCES members(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_notes_entity ON memory_notes(entity_id, status);

  CREATE TABLE handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_pk INTEGER REFERENCES sessions(pk),
    member_id INTEGER REFERENCES members(id),
    target TEXT NOT NULL,
    output_path TEXT,
    target_session_id TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // v2 — identity from per-member tokens (never from a claimed header) + web-initiated handoffs
  `
  ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'member';

  CREATE TABLE member_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    machine TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );

  CREATE TABLE handoff_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    requested_by INTEGER NOT NULL REFERENCES members(id),
    target TEXT NOT NULL DEFAULT 'codex',
    cwd_override TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','error')),
    output_path TEXT,
    target_session_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX idx_handoff_requests_member ON handoff_requests(requested_by, status);
  `,
  // v3 — merge duplicate members created before identity dedup existed
  DEDUPE_MEMBERS_SQL,
  // v4 — handoffs can be assigned to a teammate (their daemon executes)
  `
  ALTER TABLE handoff_requests ADD COLUMN assignee_id INTEGER REFERENCES members(id);
  `,
];

export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

/** Returns the persisted team token, minting one on first run. */
export function ensureTeamToken(db: Db, explicit?: string): string {
  if (explicit) {
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('team_token', explicit);
    return explicit;
  }
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('team_token') as
    | { value: string }
    | undefined;
  if (row) return row.value;
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('team_token', token);
  return token;
}
