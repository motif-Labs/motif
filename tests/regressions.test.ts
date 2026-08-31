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
  setSessionVisibility,
  listenErrorMessage,
  fullReplaceSession,
  registerMember,
  startServer,
  type MotifServer,
} from '@motif/server';
import { isExcluded } from '../packages/cli/src/daemon/syncer.js';
import { performClaudeHandoff, performCodexHandoff } from '../packages/cli/src/handoff/perform.js';
import { canAnswerLocally } from '../packages/cli/src/ask/perform.js';
import { MotifClient } from '../packages/cli/src/api-client.js';
import { writesEnabled } from '../packages/cli/src/commands/ops.js';

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

describe('handoff --digest', () => {
  it('condenses earlier messages for the claude-code target too', () => {
    // --digest was accepted, advertised in --help, and silently ignored for
    // claude-code: only the codex writer implemented it.
    const base = readClaudeSession(path.join(root, 'fixtures', 'claude-code', 'minimal.jsonl'));
    const many: MotifMessage[] = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      timestamp: '2026-08-01T10:00:00.000Z',
      text: `message number ${i}`,
    }));
    const incoming: MotifSession = {
      ...base,
      source: 'codex',
      sourcePath: '/elsewhere/rollout.jsonl',
      messages: many,
    };
    const claudeDir = path.join(tmp, 'claude-digest');
    fs.mkdirSync(claudeDir, { recursive: true });

    const full = performClaudeHandoff(incoming, { claudeDir });
    const digested = performClaudeHandoff(incoming, { claudeDir, digest: { keepLast: 5 } });

    const body = fs.readFileSync(digested.target, 'utf8');
    expect(body).toContain('Condensed history');
    expect(body).toContain('message number 39'); // the tail survives verbatim
    expect(fs.readFileSync(full.target, 'utf8').split('\n').length).toBeGreaterThan(body.split('\n').length);
  });
});

describe('answering a question only ever resumes our own session', () => {
  it('rejects a transcript path outside the agent directories', () => {
    // The check was `fs.existsSync(sourcePath)`, which is true of any file that
    // happens to exist. A teammate can upload a session row, so that let them
    // choose which path the resume pointed at — and the working directory.
    const base: MotifSession = {
      ...readClaudeSession(path.join(root, 'fixtures', 'claude-code', 'minimal.jsonl')),
      source: 'claude-code',
      sourceSessionId: '11111111-2222-4333-8444-555555555555',
    };
    expect(canAnswerLocally({ ...base, sourcePath: '/etc/hosts' })).toBe(false);
    expect(canAnswerLocally({ ...base, sourcePath: os.homedir() })).toBe(false);
    expect(canAnswerLocally({ ...base, sourcePath: undefined })).toBe(false);
  });

  it('rejects a session id that is not shaped like an id', () => {
    // sourceSessionId becomes an argv element next to --resume. A value like a
    // flag name would be read as a flag by the CLI.
    const base: MotifSession = {
      ...readClaudeSession(path.join(root, 'fixtures', 'claude-code', 'minimal.jsonl')),
      source: 'claude-code',
      sourcePath: '/etc/hosts',
    };
    for (const bad of ['--dangerously-skip-permissions', '-p', 'a b', '../../x', '']) {
      expect(canAnswerLocally({ ...base, sourceSessionId: bad })).toBe(false);
    }
  });

  it('never answers a Cursor session', () => {
    const base = readClaudeSession(path.join(root, 'fixtures', 'claude-code', 'minimal.jsonl'));
    expect(canAnswerLocally({ ...base, source: 'cursor' })).toBe(false);
  });
});

describe('a handoff writes only where it is supposed to', () => {
  it('refuses a target outside the agent directory, whatever the project path says', () => {
    // The write target is derived from session data, and for a delivery from a
    // teammate that data arrived over the network. Separator mangling makes
    // traversal hard; this makes containment explicit so a change to the
    // mangling cannot quietly open a write elsewhere.
    const session = readClaudeSession(path.join(root, 'fixtures', 'claude-code', 'minimal.jsonl'));
    const claudeDir = path.join(tmp, 'claude');
    fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
    const incoming = (projectPath: string): MotifSession => ({
      ...session,
      source: 'codex',
      sourcePath: '/elsewhere/rollout.jsonl',
      projectPath,
    });

    // this one used to land in the root of ~/.claude, beside Claude Code's own files
    expect(() => performClaudeHandoff(incoming('..'), { claudeDir, force: true })).toThrow(/outside/);

    // separators never survive mangling, so a traversal string stays a directory name
    const hostile = performClaudeHandoff(incoming('/../../../tmp/PWNED'), { claudeDir, force: true });
    expect(hostile.target.startsWith(path.join(claudeDir, 'projects') + path.sep)).toBe(true);
    expect(fs.existsSync('/tmp/PWNED')).toBe(false);

    // and an ordinary path still works
    const normal = performClaudeHandoff(incoming('/workspace/api'), { claudeDir, force: true });
    expect(fs.existsSync(normal.target)).toBe(true);
  });
});

describe('a handoff delivered by a teammate', () => {
  it('is not refused by the "you already have this" guard', () => {
    // The guard tests whether the rollout path exists locally. A delivery from
    // a teammate exists precisely because the session is not here — and two
    // people sharing a directory layout made the test fire falsely, so the
    // handoff never landed and the sender was told it was on its way.
    const session = readClaudeSession(path.join(root, 'fixtures', 'claude-code', 'minimal.jsonl'));
    const here = path.join(tmp, 'mine.jsonl');
    fs.writeFileSync(here, 'x');
    const local: MotifSession = { ...session, source: 'codex', sourcePath: here };

    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(tmp, 'codex-home');
    try {
      expect(() => performCodexHandoff(local)).toThrow(/codex resume/);
      // the same session, delivered: it must be written, not refused
      const result = performCodexHandoff(local, { force: true });
      expect(fs.existsSync(result.target)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });
});

describe('a busy port', () => {
  it('explains itself instead of throwing an unhandled listen error', () => {
    // `npx getmotif up` on a machine where 4680 was taken printed a raw Node
    // stack trace — the first thing a new user saw.
    const ours = listenErrorMessage(4680, 'EADDRINUSE', true);
    expect(ours).toContain('Motif is already running');
    expect(ours).toContain('motif ui');
    expect(ours).toContain('--port 4681');
    expect(ours).not.toContain('EADDRINUSE');

    const theirs = listenErrorMessage(4680, 'EADDRINUSE', false);
    expect(theirs).toContain('already in use by something else');
    expect(theirs).toContain('lsof');

    expect(listenErrorMessage(80, 'EACCES', false)).toContain('elevated privileges');
    // an unknown code still names the port rather than disappearing
    expect(listenErrorMessage(4680, 'EPERM', false)).toContain('4680');
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

  it('says a session id was not found instead of reporting an HTTP status', async () => {
    // Disconnected, the CLI said `No session matches "x"`. Connected, the same
    // typo produced `HTTP 404: {"error":"not found"}` from six commands.
    const client = new MotifClient({ serverUrl: base, token: memberToken });
    await expect(client.exportSession('zzzzzzzz')).rejects.toThrow(/No session matches "zzzzzzzz"/);
    // and the internal source prefix is not echoed back at the user
    await expect(client.exportSession('claude-code:zzzzzzzz')).rejects.toThrow(/matches "zzzzzzzz"/);
  });

  it('answers an unknown /api path with JSON 404, not the dashboard HTML', async () => {
    // the SPA catch-all used to serve index.html here, so clients JSON.parse'd
    // '<!doctype html>' and reported a syntax error instead of a 404
    const res = await call('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('json');
    await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
  });

  it('applies --project to search once a server is in the picture', async () => {
    // the flag existed but was dropped on the server path, so it only worked
    // while disconnected
    const me = registerMember(server.db, { name: 'cleo', email: 'cleo@example.com' });
    const mk = (id: string, project: string): MotifSession => ({
      id: `claude-code:${id}`,
      source: 'claude-code',
      sourceSessionId: id,
      sourcePath: `/fake/${id}.jsonl`,
      projectPath: project,
      title: id,
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:05:00.000Z',
      messages: [
        {
          id: `${id}-u`,
          role: 'user',
          timestamp: '2026-08-01T10:00:00.000Z',
          text: 'kafka retention question',
        },
      ],
      filesTouched: [],
      meta: { subagentCount: 0, branchCount: 0, parseErrors: 0 },
    });
    fullReplaceSession(server.db, me.memberId, mk('p-a', '/workspace/alpha'));
    fullReplaceSession(server.db, me.memberId, mk('p-b', '/workspace/beta'));

    const all = (await (await call('/api/search?q=kafka', {}, me.memberToken)).json()) as unknown[];
    expect(all.length).toBe(2);
    const scoped = (await (
      await call('/api/search?q=kafka&project=%2Fworkspace%2Falpha', {}, me.memberToken)
    ).json()) as { id: string }[];
    expect(scoped.map((r) => r.id)).toEqual(['claude-code:p-a']);
  });

  it('does not 500 on a whitespace-only search', async () => {
    // an empty FTS expression reached SQLite and threw fts5: syntax error
    expect((await call('/api/search?q=%20')).status).toBe(400);
    expect((await call('/api/sessions?q=%20')).status).toBe(200);
  });

  it('applies a scope change on re-sync, but never undoes a hand-made one', async () => {
    // `motif projects team <path>` did nothing to sessions already synced —
    // which is all of them — because visibility was frozen after INSERT.
    const me = registerMember(server.db, { name: 'dana', email: 'dana@example.com' });
    const base = {
      source: 'claude-code' as const,
      sourcePath: '/fake/s.jsonl',
      projectPath: '/workspace/api',
      title: 'scoped',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:05:00.000Z',
      filesTouched: [],
      meta: { subagentCount: 0, branchCount: 0, parseErrors: 0 },
      messages: [{ id: 'u1', role: 'user' as const, timestamp: '2026-08-01T10:00:00.000Z', text: 'hello' }],
    };
    const personal: MotifSession = {
      ...base,
      id: 'claude-code:vis-1',
      sourceSessionId: 'vis-1',
      visibility: 'personal',
    };
    fullReplaceSession(server.db, me.memberId, personal);
    const read = () =>
      (
        server.db.prepare('SELECT visibility FROM sessions WHERE source_session_id = ?').get('vis-1') as {
          visibility: string;
        }
      ).visibility;
    expect(read()).toBe('personal');

    // the daemon now says the project is team-visible: the re-sync must take
    fullReplaceSession(server.db, me.memberId, { ...personal, visibility: 'team' });
    expect(read()).toBe('team');

    // but a choice made by hand outranks the daemon from then on
    setSessionVisibility(server.db, me.memberId, 'claude-code:vis-1', 'personal');
    fullReplaceSession(server.db, me.memberId, { ...personal, visibility: 'team' });
    expect(read()).toBe('personal');
  });

  it('refuses to replace a session with a shorter one unless told to', async () => {
    // A full replace deletes what is stored and writes what arrived. A reader
    // that stopped understanding a format after an upstream release would send
    // a nearly empty session and silently destroy the team's record.
    const me = registerMember(server.db, { name: 'eli', email: 'eli@example.com' });
    const msg = (n: number): MotifMessage[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `m${i}`,
        role: 'user' as const,
        timestamp: '2026-08-01T10:00:00.000Z',
        text: `message ${i}`,
      }));
    const session = (n: number): MotifSession => ({
      id: 'claude-code:shrink-1',
      source: 'claude-code',
      sourceSessionId: 'shrink-1',
      sourcePath: '/fake/s.jsonl',
      projectPath: '/workspace/api',
      title: 'long',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:05:00.000Z',
      messages: msg(n),
      filesTouched: [],
      meta: { subagentCount: 0, branchCount: 0, parseErrors: 0 },
    });
    const put = (n: number, allow = false) =>
      call(
        `/api/sessions/claude-code:shrink-1${allow ? '?allowShrink=1' : ''}`,
        {
          method: 'PUT',
          body: JSON.stringify(session(n)),
        },
        me.memberToken,
      );

    expect((await put(200)).status).toBe(200);
    const refused = await put(3);
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ stored: 200, incoming: 3 });

    // the record is untouched
    const still = server.db
      .prepare(
        'SELECT COUNT(*) AS n FROM messages WHERE session_pk = (SELECT pk FROM sessions WHERE source_session_id = ?)',
      )
      .get('shrink-1') as { n: number };
    expect(still.n).toBe(200);

    // a deliberate rewind still goes through
    expect((await put(150, true)).status).toBe(200);
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

  // `motif doctor` used to ask the server who you are and, when the server was
  // simply off, report "member identity" as missing — sending someone to mint a
  // second identity over the working token already on their machine.
  it('reports writes enabled from the local token when the server is unreachable', () => {
    expect(writesEnabled({ reachable: false }, true)).toBe(true);
    expect(writesEnabled({ reachable: false }, false)).toBe(false);
    // when the server does answer it stays the authority, so a read-only team
    // token is still reported as unable to write
    expect(writesEnabled({ reachable: true, identity: 'team token (read-only)' }, true)).toBe(false);
    expect(writesEnabled({ reachable: true, identity: 'ada (member)' }, true)).toBe(true);
  });
});
