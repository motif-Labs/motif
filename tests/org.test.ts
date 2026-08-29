import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MotifMessage, MotifSession } from '@motif/core';
import { dedupeMembers, fullReplaceSession, listSessions, openDb } from '@motif/server';
import { shouldSyncProject } from '../packages/cli/src/daemon/syncer.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-org-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const msg = (id: string, text: string): MotifMessage => ({ id, role: 'user', timestamp: '2026-08-01T10:00:00.000Z', text });

const session = (id: string, updatedAt: string): MotifSession => ({
  id: `claude-code:${id}`,
  source: 'claude-code',
  sourceSessionId: id,
  sourcePath: `/fake/${id}.jsonl`,
  projectPath: '/tmp/demo',
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt,
  messages: [msg('u1', 'hello')],
  filesTouched: [],
  meta: { subagentCount: 0, branchCount: 0, parseErrors: 0 },
});

describe('member dedupe (migration v3 logic)', () => {
  it('merges same-person rows and keeps one copy of shared sessions', () => {
    const db = openDb(path.join(tmp, 'db.sqlite'));
    // simulate the pre-fix world: the same person registered four times
    const now = new Date().toISOString();
    const ins = db.prepare(
      "INSERT INTO members(name, email, machine, role, created_at, last_seen_at) VALUES (?, NULL, 'mac', 'member', ?, ?)",
    );
    const ids = [1, 2, 3, 4].map(() => Number(ins.run('mertcicekci', now, now).lastInsertRowid));

    // the same session synced under three of those identities; freshest under id 3
    fullReplaceSession(db, ids[0]!, session('dup', '2026-08-20T10:00:00.000Z'));
    fullReplaceSession(db, ids[1]!, session('dup', '2026-08-21T10:00:00.000Z'));
    fullReplaceSession(db, ids[2]!, session('dup', '2026-08-22T10:00:00.000Z'));
    // plus one session only the last duplicate had
    fullReplaceSession(db, ids[3]!, session('solo', '2026-08-23T10:00:00.000Z'));

    dedupeMembers(db);

    const members = db.prepare('SELECT id, name FROM members').all() as { id: number; name: string }[];
    expect(members).toHaveLength(1);
    expect(members[0]!.id).toBe(ids[0]);

    const sessions = listSessions(db);
    expect(sessions).toHaveLength(2); // dup collapsed to freshest copy + solo
    expect(sessions.every((s) => s.memberId === ids[0])).toBe(true);
    const dup = db
      .prepare("SELECT updated_at FROM sessions WHERE source_session_id = 'dup'")
      .all() as { updated_at: string }[];
    expect(dup).toHaveLength(1);
    expect(dup[0]!.updated_at).toBe('2026-08-22T10:00:00.000Z');
    db.close();
  });
});

describe('project sync scope', () => {
  it("'all' mode syncs everything except excluded", () => {
    expect(shouldSyncProject('/w/company', {})).toBe(true);
    expect(shouldSyncProject('/w/personal', { exclude: ['**/personal'] })).toBe(false);
  });

  it("'selected' mode syncs nothing unless included — personal work stays local", () => {
    const cfg = { syncMode: 'selected' as const, include: ['/w/company', '/w/oss/**'] };
    expect(shouldSyncProject('/w/company', cfg)).toBe(true);
    expect(shouldSyncProject('/w/oss/motif', cfg)).toBe(true);
    expect(shouldSyncProject('/home/me/personal-startup', cfg)).toBe(false);
    expect(shouldSyncProject('/anything', { syncMode: 'selected' })).toBe(false); // empty allowlist
  });
});
