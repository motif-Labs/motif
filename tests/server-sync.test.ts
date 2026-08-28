import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MotifMessage, MotifSession } from '@motif/core';
import {
  appendMessages,
  createServer,
  exportSession,
  fullReplaceSession,
  listSessions,
  openDb,
  prefixHash,
  registerMember,
  searchSessions,
  startServer,
  type MotifServer,
} from '@motif/server';

function makeSession(id: string, messages: MotifMessage[]): MotifSession {
  return {
    id: `claude-code:${id}`,
    source: 'claude-code',
    sourceSessionId: id,
    sourcePath: `/fake/${id}.jsonl`,
    projectPath: '/tmp/demo',
    gitBranch: 'main',
    title: 'test session',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:05:00.000Z',
    messages,
    filesTouched: [],
    meta: { subagentCount: 0, branchCount: 0, parseErrors: 0 },
  };
}

const msg = (id: string, role: MotifMessage['role'], text: string): MotifMessage => ({
  id,
  role,
  timestamp: '2026-08-01T10:00:00.000Z',
  text,
});

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-test-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('store sync protocol', () => {
  it('creates, appends incrementally, and rejects a bad prefix', () => {
    const db = openDb(path.join(tmp, 'db.sqlite'));
    const { memberId } = registerMember(db, { name: 'mert', email: 'm@example.com' });

    const m1 = [msg('u1', 'user', 'hello'), msg('a1#0', 'assistant', 'hi there')];
    const session = makeSession('s1', m1);
    const { messages: _, ...meta } = session;

    // initial create through the append path (afterId null on empty server)
    const first = appendMessages(db, memberId, meta, null, prefixHash([]), m1);
    expect(first.ok).toBe(true);

    // clean incremental append
    const m2 = [msg('u2', 'user', 'and now?')];
    const second = appendMessages(db, memberId, meta, 'a1#0', prefixHash(['u1', 'a1#0']), m2);
    expect(second.ok).toBe(true);
    expect(exportSession(db, session.id)?.messages.map((m) => m.id)).toEqual(['u1', 'a1#0', 'u2']);

    // stale prefix (client thinks tail is a1#0 but server moved on) -> conflict
    const bad = appendMessages(db, memberId, meta, 'a1#0', prefixHash(['u1', 'a1#0']), [
      msg('u3', 'user', 'again'),
    ]);
    expect(bad).toEqual({ ok: false, reason: 'prefix-mismatch' });

    // fallback: full replace wins and is idempotent on ids
    fullReplaceSession(db, memberId, makeSession('s1', [...m1, ...m2, msg('u3', 'user', 'again')]));
    expect(exportSession(db, session.id)?.messages).toHaveLength(4);
    db.close();
  });

  it('scopes sessions per member and searches with FTS', () => {
    const db = openDb(path.join(tmp, 'db.sqlite'));
    const a = registerMember(db, { name: 'alice', email: 'a@example.com' }).memberId;
    const b = registerMember(db, { name: 'bob', email: 'b@example.com' }).memberId;
    fullReplaceSession(db, a, makeSession('sa', [msg('u1', 'user', 'the rclone migration plan')]));
    fullReplaceSession(db, b, makeSession('sb', [msg('u1', 'user', 'unrelated frontend work')]));

    expect(listSessions(db)).toHaveLength(2);
    expect(listSessions(db, { memberId: a })).toHaveLength(1);

    const hits = searchSessions(db, 'rclone');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.memberName).toBe('alice');
    db.close();
  });
});

describe('http api', () => {
  let server: MotifServer;
  let httpServer: ReturnType<typeof startServer>;
  let base: string;

  beforeEach(async () => {
    server = createServer({ dbPath: path.join(tmp, 'http.sqlite'), token: 'test-token' });
    httpServer = startServer(server, { port: 0 });
    if (!httpServer.listening) {
      await new Promise((resolve) => httpServer.once('listening', resolve));
    }
    const addr = httpServer.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterEach(() => {
    httpServer.close();
    server.db.close();
  });

  const call = (path_: string, init: RequestInit = {}, member?: number) =>
    fetch(base + path_, {
      ...init,
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        ...(member !== undefined ? { 'x-motif-member': String(member) } : {}),
        ...init.headers,
      },
    });

  it('rejects bad tokens and accepts the flow end to end', async () => {
    expect((await fetch(`${base}/api/sessions`)).status).toBe(401);

    const reg = await call('/api/members/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'mert', email: 'm@example.com' }),
    });
    const { memberId } = (await reg.json()) as { memberId: number };

    const session = makeSession('h1', [msg('u1', 'user', 'server smoke test')]);
    const put = await call(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: 'PUT',
      body: JSON.stringify(session),
    }, memberId);
    expect(put.status).toBe(200);

    const list = (await (await call('/api/sessions')).json()) as { id: string }[];
    expect(list.map((s) => s.id)).toContain(session.id);

    const conflict = await call(`/api/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        session: { ...session, messages: undefined },
        afterId: 'wrong-tail',
        prefixHash: 'nope',
        messages: [msg('u2', 'user', 'x')],
      }),
    }, memberId);
    expect(conflict.status).toBe(409);

    const exported = (await (await call(`/api/sessions/${encodeURIComponent(session.id)}/export`)).json()) as MotifSession;
    expect(exported.messages).toHaveLength(1);
  });
});
