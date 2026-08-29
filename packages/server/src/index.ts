import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MotifMessage, MotifSession } from '@motif/core';
import { ensureTeamToken, openDb, type Db } from './db/database.js';
import { LiveBus } from './live/bus.js';
import {
  appendMessages,
  completeHandoffRequest,
  createHandoffRequest,
  exportSession,
  handoffExecutor,
  resolveMember,
  fullReplaceSession,
  getSessionMessages,
  getSessionRow,
  listHandoffRequests,
  listSessions,
  registerMember,
  resolveMemberByToken,
  searchSessions,
  touchMember,
  type SessionMetaPayload,
} from './store.js';

export interface ServerConfig {
  dbPath?: string;
  token?: string;
  /** Shown in the dashboard breadcrumb; persisted on first set (env: MOTIF_TEAM_NAME). */
  teamName?: string;
}

export interface MotifServer {
  app: Hono;
  db: Db;
  bus: LiveBus;
  token: string;
}

export function defaultDbPath(): string {
  return process.env.MOTIF_DB_PATH ?? path.join(os.homedir(), '.motif', 'motif.db');
}

export function createServer(config: ServerConfig = {}): MotifServer {
  const db = openDb(config.dbPath ?? defaultDbPath());
  const token = ensureTeamToken(db, config.token ?? process.env.MOTIF_TOKEN);
  const bus = new LiveBus();
  const app = new Hono();

  const explicitTeamName = config.teamName ?? process.env.MOTIF_TEAM_NAME;
  if (explicitTeamName) {
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('team_name', explicitTeamName);
  }
  const teamName = (): string =>
    (db.prepare('SELECT value FROM meta WHERE key = ?').get('team_name') as { value: string } | undefined)?.value ?? 'Team';

  app.get('/api/health', (c) => c.json({ ok: true, name: 'motif' }));

  const safeEqual = (a: string, b: string): boolean => {
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
  };

  // Brute-force damper: guessing a 192-bit token is hopeless, but there is no
  // reason to let anyone try fast. Sliding window of failures per client IP.
  const authFailures = new Map<string, { count: number; resetAt: number }>();
  const FAIL_LIMIT = 20;
  const FAIL_WINDOW_MS = 60_000;
  const clientKey = (c: { req: { header: (n: string) => string | undefined } }): string =>
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? 'local';
  const failuresFor = (key: string) => {
    const now = Date.now();
    const entry = authFailures.get(key);
    if (!entry || entry.resetAt < now) return { count: 0, resetAt: now + FAIL_WINDOW_MS };
    return entry;
  };

  // Identity comes from the token itself, never from a client-claimed header:
  //  - team token  → read access + member registration (cannot write sessions)
  //  - member token → full access, identity implied by the token
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health') return next();
    const key = clientKey(c);
    const failures = failuresFor(key);
    if (failures.count >= FAIL_LIMIT) {
      return c.json({ error: 'too many failed attempts — try again later' }, 429);
    }
    const header = c.req.header('authorization');
    // EventSource cannot set headers, so ?token= is accepted as an equivalent
    const presented = header?.startsWith('Bearer ') ? header.slice(7) : (c.req.query('token') ?? '');
    const fail = () => {
      authFailures.set(key, { count: failures.count + 1, resetAt: failures.resetAt });
      return c.json({ error: 'unauthorized' }, 401);
    };
    if (!presented) return fail();
    if (safeEqual(presented, token)) {
      c.set('authKind' as never, 'team' as never);
    } else {
      const member = resolveMemberByToken(db, presented);
      if (member === undefined) return fail();
      c.set('authKind' as never, 'member' as never);
      c.set('memberId' as never, member as never);
      touchMember(db, member);
    }
    return next();
  });

  const memberId = (c: { get: (k: never) => unknown }): number | undefined =>
    c.get('memberId' as never) as number | undefined;

  const isOwner = (id: number | undefined): boolean =>
    id !== undefined &&
    (db.prepare('SELECT role FROM members WHERE id = ?').get(id) as { role?: string } | undefined)?.role === 'owner';

  app.get('/api/team', (c) =>
    c.json({
      name: teamName(),
      members: db.prepare('SELECT COUNT(*) AS n FROM members').pluck().get(),
      sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').pluck().get(),
    }),
  );

  app.patch('/api/team', async (c) => {
    if (!isOwner(memberId(c))) return c.json({ error: 'owner only' }, 403);
    const body = await c.req.json<{ name?: string }>();
    if (!body.name?.trim()) return c.json({ error: 'name required' }, 400);
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('team_name', body.name.trim().slice(0, 60));
    return c.json({ ok: true, name: teamName() });
  });

  // Retention: owner prunes sessions older than N days. Memory notes and
  // handoff records survive (their session link is nulled) — distilled
  // knowledge is the point of keeping less raw history around.
  app.post('/api/admin/prune', async (c) => {
    if (!isOwner(memberId(c))) return c.json({ error: 'owner only' }, 403);
    const body = await c.req.json<{ olderThanDays?: number }>();
    const days = Number(body.olderThanDays);
    if (!Number.isFinite(days) || days < 7) return c.json({ error: 'olderThanDays must be >= 7' }, 400);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const result = db.transaction(() => {
      const doomed = db.prepare('SELECT pk FROM sessions WHERE updated_at < ?').all(cutoff) as { pk: number }[];
      const pks = doomed.map((r) => r.pk);
      let messages = 0;
      for (const pk of pks) {
        db.prepare('UPDATE memory_notes SET source_session_pk = NULL WHERE source_session_pk = ?').run(pk);
        db.prepare('UPDATE handoffs SET session_pk = NULL WHERE session_pk = ?').run(pk);
        db.prepare('DELETE FROM messages_fts WHERE session_pk = ?').run(pk);
        messages += db.prepare('DELETE FROM messages WHERE session_pk = ?').run(pk).changes;
        db.prepare('DELETE FROM sessions WHERE pk = ?').run(pk);
      }
      return { sessions: pks.length, messages };
    })();
    return c.json({ ok: true, ...result, cutoff });
  });

  // Owner revokes a member's device tokens: their daemon stops writing
  // immediately; their sessions stay attributed. Re-joining needs the team
  // token again (rotate MOTIF_TOKEN to truly close the door).
  app.post('/api/members/:id/revoke', (c) => {
    const caller = memberId(c);
    if (!isOwner(caller)) return c.json({ error: 'owner only' }, 403);
    const target = Number(c.req.param('id'));
    if (target === caller) return c.json({ error: 'cannot revoke yourself' }, 400);
    const revoked = db.prepare('DELETE FROM member_tokens WHERE member_id = ?').run(target);
    return c.json({ ok: true, revokedTokens: revoked.changes });
  });

  app.get('/api/me', (c) => {
    const id = memberId(c);
    if (id === undefined) return c.json({ kind: 'team' });
    const row = db.prepare('SELECT id, name, email, role FROM members WHERE id = ?').get(id);
    return c.json({ kind: 'member', member: row });
  });

  app.post('/api/members/register', async (c) => {
    const body = await c.req.json<{ name?: string; email?: string; machine?: string }>();
    if (!body.name) return c.json({ error: 'name required' }, 400);
    const res = registerMember(db, { name: body.name, email: body.email, machine: body.machine });
    if (res.created) bus.publish('member-joined', { memberId: res.memberId, name: body.name });
    return c.json(res);
  });

  app.get('/api/members', (c) => {
    const rows = db
      .prepare('SELECT id, name, email, machine, role, created_at, last_seen_at FROM members ORDER BY id')
      .all();
    return c.json(rows);
  });

  app.get('/api/projects', (c) => {
    const rows = db
      .prepare(
        'SELECT project_path, COUNT(*) AS sessions, MAX(updated_at) AS last_activity FROM sessions GROUP BY project_path ORDER BY last_activity DESC',
      )
      .all();
    return c.json(rows);
  });

  app.get('/api/sessions', (c) => {
    const q = c.req.query('q');
    if (q) return c.json(searchSessions(db, q, Number(c.req.query('limit') ?? 30)));
    return c.json(
      listSessions(db, {
        project: c.req.query('project'),
        memberId: c.req.query('member') ? Number(c.req.query('member')) : undefined,
        limit: Number(c.req.query('limit') ?? 50),
      }),
    );
  });

  app.get('/api/search', (c) => {
    const q = c.req.query('q');
    if (!q) return c.json({ error: 'q required' }, 400);
    return c.json(searchSessions(db, q, Number(c.req.query('limit') ?? 30)));
  });

  app.get('/api/sessions/:id/export', (c) => {
    const session = exportSession(db, c.req.param('id'));
    if (!session) return c.json({ error: 'not found' }, 404);
    return c.json(session);
  });

  app.get('/api/sessions/:id', (c) => {
    const row = getSessionRow(db, c.req.param('id'));
    if (!row) return c.json({ error: 'not found' }, 404);
    const member = db.prepare('SELECT name FROM members WHERE id = ?').get(row.member_id) as
      | { name: string }
      | undefined;
    return c.json({
      id: row.id,
      source: row.source,
      memberId: row.member_id,
      memberName: member?.name ?? null,
      sourcePath: row.source_path,
      projectPath: row.project_path,
      gitBranch: row.git_branch,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      toolVersion: row.tool_version,
      filesTouched: JSON.parse(row.files_touched),
      meta: JSON.parse(row.meta_json),
      messages: getSessionMessages(db, row.pk),
    });
  });

  // Members can withdraw their OWN sessions (e.g. a project excluded after the fact)
  app.delete('/api/sessions/:id', (c) => {
    const member = memberId(c);
    if (member === undefined) return c.json({ error: 'member token required' }, 403);
    const row = getSessionRow(db, c.req.param('id'));
    if (!row) return c.json({ error: 'not found' }, 404);
    if (row.member_id !== member) return c.json({ error: 'you can only delete your own sessions' }, 403);
    db.transaction(() => {
      db.prepare('DELETE FROM messages_fts WHERE session_pk = ?').run(row.pk);
      db.prepare('DELETE FROM sessions WHERE pk = ?').run(row.pk);
    })();
    return c.json({ ok: true, deleted: row.id });
  });

  app.put('/api/sessions/:id', async (c) => {
    const member = memberId(c);
    if (member === undefined) return c.json({ error: 'writes require a member token (motif connect)' }, 403);
    const session = await c.req.json<MotifSession>();
    if (session.id !== c.req.param('id')) return c.json({ error: 'id mismatch' }, 400);
    const row = fullReplaceSession(db, member, session);
    bus.publish('session-upserted', {
      id: row.id,
      memberId: member,
      title: session.title,
      projectPath: session.projectPath,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
    });
    return c.json({ ok: true, lastId: session.messages.at(-1)?.id ?? null });
  });

  app.post('/api/sessions/:id/messages', async (c) => {
    const member = memberId(c);
    if (member === undefined) return c.json({ error: 'writes require a member token (motif connect)' }, 403);
    const body = await c.req.json<{
      session: SessionMetaPayload;
      afterId: string | null;
      prefixHash: string;
      messages: MotifMessage[];
    }>();
    if (body.session.id !== c.req.param('id')) return c.json({ error: 'id mismatch' }, 400);
    const result = appendMessages(db, member, body.session, body.afterId, body.prefixHash, body.messages);
    if (!result.ok) return c.json({ error: result.reason }, 409);
    bus.publish('session-upserted', {
      id: result.row.id,
      memberId: member,
      title: body.session.title,
      projectPath: body.session.projectPath,
      updatedAt: body.session.updatedAt,
      messageCount: db
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE session_pk = ?')
        .pluck()
        .get(result.row.pk) as number,
    });
    return c.json({ ok: true, appended: result.appended, lastId: result.lastId });
  });

  app.post('/api/handoff-requests', async (c) => {
    const member = memberId(c);
    if (member === undefined) {
      return c.json({ error: 'handoff runs on your machine via your daemon — log in with your member token' }, 403);
    }
    const body = await c.req.json<{ sessionId?: string; cwd?: string; assignee?: string; target?: string }>();
    if (!body.sessionId) return c.json({ error: 'sessionId required' }, 400);
    if (!getSessionRow(db, body.sessionId)) return c.json({ error: 'session not found' }, 404);
    if (body.target && body.target !== 'codex' && body.target !== 'claude-code') {
      return c.json({ error: 'target must be codex or claude-code' }, 400);
    }
    let assigneeId: number | undefined;
    if (body.assignee) {
      const assignee = resolveMember(db, body.assignee);
      if (!assignee) return c.json({ error: `no unique member matches "${body.assignee}"` }, 404);
      if (assignee.id !== member) assigneeId = assignee.id;
    }
    const request = createHandoffRequest(db, member, {
      sessionId: body.sessionId,
      cwd: body.cwd,
      assigneeId,
      target: body.target,
    });
    // wake the EXECUTOR's daemon — the assignee when handing to a teammate
    bus.publish('handoff-requested', {
      requestId: request.id,
      sessionId: request.session_id,
      memberId: handoffExecutor(request),
    });
    return c.json(request);
  });

  app.get('/api/handoff-requests', (c) => {
    const member = memberId(c);
    if (member === undefined) return c.json({ error: 'member token required' }, 403);
    return c.json(listHandoffRequests(db, member, { status: c.req.query('status') }));
  });

  app.patch('/api/handoff-requests/:id', async (c) => {
    const member = memberId(c);
    if (member === undefined) return c.json({ error: 'member token required' }, 403);
    const body = await c.req.json<{ status: 'done' | 'error'; outputPath?: string; targetSessionId?: string; error?: string }>();
    const updated = completeHandoffRequest(db, member, Number(c.req.param('id')), body);
    if (!updated) return c.json({ error: 'not found or not yours or not pending' }, 404);
    bus.publish('handoff-request-updated', {
      requestId: updated.id,
      sessionId: updated.session_id,
      memberId: updated.requested_by, // the watcher is whoever asked
      executorId: member,
      status: updated.status,
      outputPath: updated.output_path ?? undefined,
      targetSessionId: updated.target_session_id ?? undefined,
      error: updated.error ?? undefined,
    });
    return c.json(updated);
  });

  app.post('/api/handoffs', async (c) => {
    const member = memberId(c);
    if (member === undefined) return c.json({ error: 'member token required' }, 403);
    const body = await c.req.json<{ sessionId: string; target: string; outputPath?: string; targetSessionId?: string }>();
    const row = getSessionRow(db, body.sessionId);
    db.prepare(
      'INSERT INTO handoffs (session_pk, member_id, target, output_path, target_session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(row?.pk ?? null, member ?? null, body.target, body.outputPath ?? null, body.targetSessionId ?? null, new Date().toISOString());
    if (member) bus.publish('handoff-created', { sessionId: body.sessionId, memberId: member, target: body.target });
    return c.json({ ok: true });
  });

  app.get('/api/memory/entities', (c) => {
    const rows = db
      .prepare(
        `SELECT e.id, e.kind, e.name, e.project_path,
                SUM(CASE WHEN n.status = 'current' THEN 1 ELSE 0 END) AS current_notes,
                SUM(CASE WHEN n.status = 'conflicted' THEN 1 ELSE 0 END) AS conflicts
         FROM memory_entities e LEFT JOIN memory_notes n ON n.entity_id = e.id
         GROUP BY e.id ORDER BY e.kind, e.name`,
      )
      .all();
    return c.json(rows);
  });

  app.get('/api/memory/entities/:id', (c) => {
    const entity = db.prepare('SELECT * FROM memory_entities WHERE id = ?').get(c.req.param('id'));
    if (!entity) return c.json({ error: 'not found' }, 404);
    const notes = db
      .prepare('SELECT * FROM memory_notes WHERE entity_id = ? ORDER BY created_at DESC')
      .all(c.req.param('id'));
    return c.json({ entity, notes });
  });

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = bus.subscribe((e) => {
        void stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) });
      });
      stream.onAbort(unsubscribe);
      // keepalive comments so proxies don't drop the stream
      while (!stream.aborted) {
        await stream.writeSSE({ event: 'ping', data: '' });
        await new Promise((r) => setTimeout(r, 25_000));
      }
    }),
  );

  serveUi(app);

  return { app, db, bus, token };
}

/** Serves the built dashboard (ui/dist) when it ships with the package. */
function serveUi(app: Hono): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'ui'), // packaged: dist/ui next to the bundle
    path.join(here, '..', '..', '..', 'ui', 'dist'), // monorepo dev layout
  ];
  const uiDir = candidates.find((d) => fs.existsSync(path.join(d, 'index.html')));
  if (!uiDir) return;
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };
  app.get('*', (c) => {
    const reqPath = c.req.path === '/' ? '/index.html' : c.req.path;
    const file = path.normalize(path.join(uiDir, reqPath));
    const fallback = path.join(uiDir, 'index.html'); // SPA hash-router entry
    const target = file.startsWith(uiDir) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : fallback;
    return c.body(fs.readFileSync(target), 200, {
      'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
    });
  });
}

export function startServer(
  server: MotifServer,
  opts: { port?: number; hostname?: string } = {},
): ServerType {
  return serve({
    fetch: server.app.fetch,
    port: opts.port ?? Number(process.env.MOTIF_PORT ?? 4680),
    hostname: opts.hostname ?? '127.0.0.1',
  });
}

export { dedupeMembers, openDb } from './db/database.js';
export * from './store.js';
export { LiveBus } from './live/bus.js';
export { createProvider, type LLMProvider } from './memory/providers.js';
export { applyNotes, runMemoryTick, startMemoryScheduler } from './memory/pipeline.js';
