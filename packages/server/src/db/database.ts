import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type Db = Database.Database;

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
