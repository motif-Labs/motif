import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import os from 'node:os';
import path from 'node:path';
import type { MotifMessage, MotifSession } from '@motif/core';
import { ensureTeamToken, openDb, type Db } from './db/database.js';
import { LiveBus } from './live/bus.js';
import {
  appendMessages,
  exportSession,
  fullReplaceSession,
  getSessionMessages,
  getSessionRow,
  listSessions,
  registerMember,
  searchSessions,
  touchMember,
  type SessionMetaPayload,
} from './store.js';

export interface ServerConfig {
  dbPath?: string;
  token?: string;
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

  app.get('/api/health', (c) => c.json({ ok: true, name: 'motif' }));

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health') return next();
    const auth = c.req.header('authorization');
    if (auth !== `Bearer ${token}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const member = c.req.header('x-motif-member');
    if (member && /^\d+$/.test(member)) {
      c.set('memberId' as never, Number(member) as never);
      touchMember(db, Number(member));
    }
    return next();
  });

  const memberId = (c: { get: (k: never) => unknown }): number | undefined =>
    c.get('memberId' as never) as number | undefined;

  app.post('/api/members/register', async (c) => {
    const body = await c.req.json<{ name?: string; email?: string; machine?: string }>();
    if (!body.name) return c.json({ error: 'name required' }, 400);
    const res = registerMember(db, { name: body.name, email: body.email, machine: body.machine });
    if (res.created) bus.publish('member-joined', { memberId: res.memberId, name: body.name });
    return c.json(res);
  });

  app.get('/api/members', (c) => {
    const rows = db.prepare('SELECT id, name, email, machine, last_seen_at FROM members').all();
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
    return c.json({
      id: row.id,
      source: row.source,
      memberId: row.member_id,
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

  app.put('/api/sessions/:id', async (c) => {
    const member = memberId(c);
    if (!member) return c.json({ error: 'x-motif-member header required' }, 400);
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
    if (!member) return c.json({ error: 'x-motif-member header required' }, 400);
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

  app.post('/api/handoffs', async (c) => {
    const member = memberId(c);
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

  return { app, db, bus, token };
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

export { openDb } from './db/database.js';
export * from './store.js';
export { LiveBus } from './live/bus.js';
export { createProvider, type LLMProvider } from './memory/providers.js';
export { applyNotes, runMemoryTick, startMemoryScheduler } from './memory/pipeline.js';
