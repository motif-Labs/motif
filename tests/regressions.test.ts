/**
 * One test per bug that shipped and was found later. Each name states the
 * wrong behaviour, so a failure here says which promise broke.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MotifMessage, MotifSession } from '@motif/core';
import { readClaudeSession } from '@motif/core';
import {
  createServer,
  fullReplaceSession,
  registerMember,
  startServer,
  type MotifServer,
} from '@motif/server';
import { isExcluded } from '../packages/cli/src/daemon/syncer.js';
import { performClaudeHandoff } from '../packages/cli/src/handoff/perform.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-regress-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const root = path.resolve(__dirname, '..');

describe('sync scope globs', () => {
  it('a plain directory covers the tree beneath it, not just that one directory', () => {
    // the leak: excluding ~/personal used to sync ~/personal/app anyway
    expect(isExcluded('/u/x/personal/app', ['/u/x/personal'])).toBe(true);
    expect(isExcluded('/u/x/personal/a/b/c', ['/u/x/personal'])).toBe(true);
    expect(isExcluded('/u/x/personal', ['/u/x/personal'])).toBe(true);
    expect(isExcluded('/u/x/personal/', ['/u/x/personal'])).toBe(true);
  });

  it('does not treat a longer sibling name as being inside the tree', () => {
    expect(isExcluded('/u/x/personality', ['/u/x/personal'])).toBe(false);
    expect(isExcluded('/u/x/work', ['/u/x/personal'])).toBe(false);
  });

  it('still honours explicit wildcards literally', () => {
    expect(isExcluded('/u/x/s/secret', ['**/secret'])).toBe(true);
    expect(isExcluded('/u/x/a/b', ['**/a/*'])).toBe(true);
    expect(isExcluded('/u/x/a/b/c', ['**/a/*'])).toBe(false);
  });
});

describe('handoff --dry-run', () => {
  it('writes nothing for the claude-code target', () => {
    const session = readClaudeSession(path.join(root, 'fixtures', 'claude-code', 'minimal.jsonl'));
    // a codex-sourced session, so the claude writer accepts it
    const incoming: MotifSession = { ...session, source: 'codex', sourcePath: '/elsewhere/rollout.jsonl' };
    const claudeDir = path.join(tmp, 'claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    const preview = performClaudeHandoff(incoming, { claudeDir, dryRun: true });
    expect(preview.target.startsWith(claudeDir)).toBe(true);
    expect(fs.existsSync(preview.target)).toBe(false); // the whole contract of the flag
    expect(preview.registered).toBe(false);

    // and the same call without the flag does write
    const real = performClaudeHandoff(incoming, { claudeDir });
    expect(fs.existsSync(real.target)).toBe(true);
  });
});

describe('http api', () => {
  let server: MotifServer;
  let httpServer: ReturnType<typeof startServer>;
  let base: string;
  let memberToken: string;

  beforeEach(async () => {
    server = createServer({ dbPath: path.join(tmp, 'http.sqlite'), token: 'test-token' });
    httpServer = startServer(server, { port: 0 });
    if (!httpServer.listening) await new Promise((r) => httpServer.once('listening', r));
    const addr = httpServer.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
    memberToken = registerMember(server.db, { name: 'ada', email: 'ada@example.com' }).memberToken;
  });
  afterEach(() => {
    httpServer.close();
    server.db.close();
  });

  const call = (p: string, init: RequestInit = {}, token = memberToken) =>
    fetch(base + p, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    });

  it('answers an unknown /api path with JSON 404, not the dashboard HTML', async () => {
    // the SPA catch-all used to serve index.html here, so clients JSON.parse'd
    // '<!doctype html>' and reported a syntax error instead of a 404
    const res = await call('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('json');
    await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
  });

  it('does not 500 on a whitespace-only search', async () => {
    // an empty FTS expression reached SQLite and threw fts5: syntax error
    expect((await call('/api/search?q=%20')).status).toBe(400);
    expect((await call('/api/sessions?q=%20')).status).toBe(200);
  });

  it('deletes a session that memory notes still point at', async () => {
    const messages: MotifMessage[] = [
      { id: 'u1', role: 'user', timestamp: '2026-08-01T10:00:00.000Z', text: 'set up the retry queue' },
    ];
    const session: MotifSession = {
      id: 'claude-code:del-1',
      source: 'claude-code',
      sourceSessionId: 'del-1',
      sourcePath: '/fake/del-1.jsonl',
      projectPath: '/tmp/demo',
      title: 'to be withdrawn',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:05:00.000Z',
      messages,
      filesTouched: [],
      meta: { subagentCount: 0, branchCount: 0, parseErrors: 0 },
    };
    const me = registerMember(server.db, { name: 'ben', email: 'ben@example.com' });
    const row = fullReplaceSession(server.db, me.memberId, session);
    // a distilled note pointing at the session is what used to make DELETE 500
    const entityId = server.db
      .prepare("INSERT INTO memory_entities (name, kind, project_path) VALUES ('retry-queue','topic',?)")
      .run(session.projectPath).lastInsertRowid as number;
    server.db
      .prepare(
        `INSERT INTO memory_notes (entity_id, aspect, body, status, source_session_pk, member_id, created_at)
         VALUES (?, 'decision', 'retries are queued per account', 'current', ?, ?, ?)`,
      )
      .run(entityId, row.pk, me.memberId, session.createdAt);

    const res = await call('/api/sessions/claude-code:del-1', { method: 'DELETE' }, me.memberToken);
    expect(res.status).toBe(200);
    expect((await call('/api/sessions/claude-code:del-1', {}, me.memberToken)).status).toBe(404);
  });
});
