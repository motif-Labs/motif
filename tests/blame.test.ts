import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MotifMessage, MotifSession } from '@motif/core';
import {
  createServer,
  fullReplaceSession,
  registerMember,
  startServer,
  type MotifServer,
} from '@motif/server';
import { rankForFile } from '../packages/cli/src/commands/blame.js';

const msg = (id: string, role: MotifMessage['role'], text: string): MotifMessage => ({
  id,
  role,
  timestamp: '2026-08-01T10:00:00.000Z',
  text,
});

function session(id: string, files: string[], updatedAt: string): MotifSession {
  return {
    id: `claude-code:${id}`,
    source: 'claude-code',
    sourceSessionId: id,
    sourcePath: `/fake/${id}.jsonl`,
    projectPath: '/workspace/app',
    gitBranch: 'main',
    title: `session ${id}`,
    createdAt: updatedAt,
    updatedAt,
    messages: [msg(`${id}-1`, 'user', 'work')],
    filesTouched: files,
    meta: { subagentCount: 0, branchCount: 0, parseErrors: 0 },
  };
}

describe('rankForFile — from a path to the sessions that produced it', () => {
  it('matches absolute stored paths against relative asks, exact beating loose, fresh beating old', () => {
    const ranked = rankForFile(
      [
        session('old-exact', ['/workspace/app/src/limiter.ts'], '2026-08-01T10:00:00.000Z'),
        session('new-exact', ['/workspace/app/src/limiter.ts'], '2026-08-05T10:00:00.000Z'),
        session('other-file', ['/workspace/app/src/auth.ts'], '2026-08-06T10:00:00.000Z'),
      ],
      'src/limiter.ts',
    );
    expect(ranked.map((r) => r.id)).toEqual(['claude-code:new-exact', 'claude-code:old-exact']);
    expect(ranked[0]!.exact).toBe(true);
  });

  it('matches across slash conventions — and still ranks them exact, not merely loose', () => {
    const ranked = rankForFile(
      [session('win', ['C:\\repo\\src\\limiter.ts'], '2026-08-05T10:00:00.000Z')],
      'src\\limiter.ts',
    );
    expect(ranked).toHaveLength(1);
    // a Windows-stored path that IS the file must not lose to a fresher loose match
    expect(ranked[0]!.exact).toBe(true);
  });
});

describe('/api/sessions/by-file', () => {
  let tmp: string;
  let server: MotifServer;
  let httpServer: ReturnType<typeof startServer>;
  let base: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-blame-'));
    server = createServer({ dbPath: path.join(tmp, 'db.sqlite'), token: 'test-token' });
    httpServer = startServer(server, { port: 0 });
    if (!httpServer.listening) await new Promise((r) => httpServer.once('listening', r));
    const addr = httpServer.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterEach(() => {
    httpServer.close();
    server.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("answers with matching sessions and keeps personal work out of a stranger's blame", async () => {
    const ada = registerMember(server.db, { name: 'ada', email: 'ada@example.com' });
    const bob = registerMember(server.db, { name: 'bob', email: 'bob@example.com' });
    fullReplaceSession(
      server.db,
      ada.memberId,
      session('team-work', ['/workspace/app/src/limiter.ts'], '2026-08-05T10:00:00.000Z'),
    );
    const secret = fullReplaceSession(
      server.db,
      ada.memberId,
      session('private-work', ['/workspace/app/src/limiter.ts'], '2026-08-06T10:00:00.000Z'),
    );
    server.db.prepare('UPDATE sessions SET visibility = ? WHERE pk = ?').run('personal', secret.pk);

    const ask = (token: string) =>
      fetch(`${base}/api/sessions/by-file?path=src/limiter.ts&project=/workspace/app`, {
        headers: { authorization: `Bearer ${token}` },
      }).then((r) => r.json() as Promise<{ sessions: { id: string; member_name: string | null }[] }>);

    const forBob = await ask(bob.memberToken);
    expect(forBob.sessions.map((s) => s.id)).toEqual(['claude-code:team-work']);
    expect(forBob.sessions[0]!.member_name).toBe('ada');

    const forAda = await ask(ada.memberToken);
    expect(forAda.sessions.map((s) => s.id).sort()).toEqual([
      'claude-code:private-work',
      'claude-code:team-work',
    ]);
  });
});
