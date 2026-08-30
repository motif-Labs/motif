/**
 * Cursor session reader. Cursor keeps chats in SQLite:
 * <Cursor dir>/User/globalStorage/state.vscdb, table cursorDiskKV —
 * `composerData:<id>` rows hold conversation metadata (with an ordered
 * bubble list), `bubbleId:<composerId>:<bubbleId>` rows hold messages
 * (type 1 = user, type 2 = assistant). Schemas drift between Cursor
 * versions, so every access is tolerant: unknown shapes are skipped,
 * never fatal. The DB is opened read-only WITHOUT immutable so SQLite
 * still replays the WAL of a running Cursor.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { motifSessionId, type MotifMessage, type MotifSession } from '@motif/core';

export function defaultCursorDb(): string | undefined {
  // MOTIF_CURSOR_DIR points the reader somewhere else — used by the demo and by
  // tests. When it is set, the real Cursor directory is never consulted: an
  // override that silently falls back would sync somebody's actual history.
  const override = process.env.MOTIF_CURSOR_DIR;
  if (override) {
    const db = path.join(override, 'User', 'globalStorage', 'state.vscdb');
    return fs.existsSync(db) ? db : undefined;
  }
  const candidates =
    process.platform === 'darwin'
      ? [path.join(os.homedir(), 'Library', 'Application Support', 'Cursor')]
      : process.platform === 'win32'
        ? [path.join(process.env.APPDATA ?? '', 'Cursor')]
        : [path.join(os.homedir(), '.config', 'Cursor')];
  for (const dir of candidates) {
    const db = path.join(dir, 'User', 'globalStorage', 'state.vscdb');
    if (fs.existsSync(db)) return db;
  }
  return undefined;
}

interface ComposerHeader {
  bubbleId?: string;
  type?: number;
}

interface ComposerData {
  composerId?: string;
  name?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  fullConversationHeadersOnly?: ComposerHeader[];
  conversation?: { type?: number; text?: string; bubbleId?: string }[];
}

export interface CursorConversationInfo {
  composerId: string;
  updatedAtMs: number;
}

function openRo(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/**
 * Maps composerId → project path. Cursor keeps the workspace link one level
 * away: User/workspaceStorage/<hash>/workspace.json names the folder, and
 * that workspace's own state.vscdb lists its composers under the
 * 'composer.composerData' ItemTable key. Best-effort — an unmapped
 * conversation simply stays project-less.
 */
export function loadCursorProjectMap(dbPath = defaultCursorDb()): Map<string, string> {
  const map = new Map<string, string>();
  if (!dbPath) return map;
  const storageRoot = path.join(path.dirname(path.dirname(dbPath)), 'workspaceStorage');
  let entries: string[];
  try {
    entries = fs.readdirSync(storageRoot);
  } catch {
    return map;
  }
  for (const hash of entries) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(storageRoot, hash, 'workspace.json'), 'utf8')) as {
        folder?: string;
      };
      if (!meta.folder?.startsWith('file://')) continue;
      const folder = fileURLToPath(meta.folder);
      const wsDb = openRo(path.join(storageRoot, hash, 'state.vscdb'));
      try {
        const row = wsDb.prepare('SELECT value FROM ItemTable WHERE key = ?').get('composer.composerData') as
          | { value: string | Buffer }
          | undefined;
        if (!row) continue;
        const data = JSON.parse(String(row.value)) as { allComposers?: { composerId?: string }[] };
        for (const c of data.allComposers ?? []) {
          if (c.composerId) map.set(c.composerId, folder);
        }
      } finally {
        wsDb.close();
      }
    } catch {
      // one broken workspace must not hide the rest
    }
  }
  return map;
}

export function discoverCursorConversations(dbPath = defaultCursorDb()): CursorConversationInfo[] {
  if (!dbPath) return [];
  try {
    const db = openRo(dbPath);
    try {
      const rows = db
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        .all() as { key: string; value: string | Buffer }[];
      const out: CursorConversationInfo[] = [];
      for (const row of rows) {
        try {
          const data = JSON.parse(String(row.value)) as ComposerData;
          const composerId = data.composerId ?? row.key.slice('composerData:'.length);
          out.push({ composerId, updatedAtMs: data.lastUpdatedAt ?? data.createdAt ?? 0 });
        } catch {
          /* one bad row must not hide the rest */
        }
      }
      return out;
    } finally {
      db.close();
    }
  } catch {
    return []; // db locked/missing/schema drift — treat as "no cursor sessions"
  }
}

const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : '');

function bubbleText(b: Record<string, unknown>): string {
  if (typeof b.text === 'string' && b.text.trim()) return b.text;
  // richText is a serialized editor document; dig out plain text nodes
  if (typeof b.richText === 'string') {
    try {
      const texts: string[] = [];
      const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        const n = node as Record<string, unknown>;
        if (typeof n.text === 'string') texts.push(n.text);
        for (const child of Array.isArray(n.children) ? n.children : []) walk(child);
        if (n.root) walk(n.root);
      };
      walk(JSON.parse(b.richText));
      return texts.join('');
    } catch {
      /* fall through */
    }
  }
  return '';
}

export function readCursorSession(
  composerId: string,
  dbPath = defaultCursorDb(),
  projectPath = '',
): MotifSession {
  if (!dbPath) throw new Error('Cursor data directory not found');
  const db = openRo(dbPath);
  try {
    const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${composerId}`) as
      | { value: string | Buffer }
      | undefined;
    if (!row) throw new Error(`Cursor conversation ${composerId} not found`);
    const data = JSON.parse(String(row.value)) as ComposerData;

    const messages: MotifMessage[] = [];
    let parseErrors = 0;
    let firstPrompt: string | undefined;

    const pushBubble = (bubbleId: string, bubble: Record<string, unknown>): void => {
      const type = bubble.type;
      const text = bubbleText(bubble);
      if (!text) return;
      if (type === 1) {
        if (!firstPrompt) firstPrompt = text;
        messages.push({ id: bubbleId, role: 'user', timestamp: iso(bubble.createdAt as number | undefined), text });
      } else if (type === 2) {
        messages.push({ id: bubbleId, role: 'assistant', timestamp: iso(bubble.createdAt as number | undefined), text });
      }
    };

    const seen = new Set<string>();
    if (Array.isArray(data.fullConversationHeadersOnly) && data.fullConversationHeadersOnly.length > 0) {
      const getBubble = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
      for (const header of data.fullConversationHeadersOnly) {
        if (!header.bubbleId || seen.has(header.bubbleId)) continue;
        seen.add(header.bubbleId);
        const b = getBubble.get(`bubbleId:${composerId}:${header.bubbleId}`) as { value: string | Buffer } | undefined;
        if (!b) continue;
        try {
          pushBubble(header.bubbleId, JSON.parse(String(b.value)) as Record<string, unknown>);
        } catch {
          parseErrors++;
        }
      }
    } else if (Array.isArray(data.conversation)) {
      // older Cursor builds inline the bubbles in composerData
      data.conversation.forEach((b, i) => pushBubble(b.bubbleId ?? `b${i}`, b as Record<string, unknown>));
    }

    const title = (data.name?.trim() || firstPrompt?.replace(/\s+/g, ' ').trim())?.slice(0, 120);
    return {
      id: motifSessionId('cursor', composerId),
      source: 'cursor',
      sourceSessionId: composerId,
      sourcePath: dbPath,
      projectPath,
      title,
      createdAt: iso(data.createdAt),
      updatedAt: iso(data.lastUpdatedAt ?? data.createdAt),
      messages,
      filesTouched: [],
      meta: { subagentCount: 0, branchCount: 0, parseErrors },
    };
  } finally {
    db.close();
  }
}
