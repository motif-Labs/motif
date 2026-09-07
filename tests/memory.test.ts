import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MotifMessage, MotifSession } from '@motif/core';
import {
  applyNotes,
  applyVerdict,
  fullReplaceSession,
  listReviewQueue,
  LiveBus,
  openDb,
  recall,
  registerMember,
  runMemoryTick,
  type LLMProvider,
} from '@motif/server';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-mem-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// 'file' is not gated by the admission gate, so these exercise the raw
// supersede/conflict mechanics; the gate itself is covered by its own tests.
const note = (
  name: string,
  aspect: string,
  body: string,
  extra: Partial<{ supersedes: boolean; contradictsCurrent: boolean }> = {},
) => ({
  entity: { kind: 'file' as const, name },
  aspect,
  body,
  ...extra,
});

describe('memory notes', () => {
  it('supersedes: new note becomes current, old kept with pointer', () => {
    const db = openDb(path.join(tmp, 'db.sqlite'));
    const ctx = { projectPath: '/tmp/demo', sessionPk: null, memberId: null };
    applyNotes(db, [note('file-transfer', 'tool', 'We use rclone for file transfer')], ctx);
    applyNotes(
      db,
      [note('file-transfer', 'tool', 'We replaced rclone with rsync', { supersedes: true })],
      ctx,
    );

    const rows = db.prepare('SELECT body, status, superseded_by FROM memory_notes ORDER BY id').all() as {
      body: string;
      status: string;
      superseded_by: number | null;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'superseded' });
    expect(rows[0]!.superseded_by).not.toBeNull();
    expect(rows[1]).toMatchObject({ body: 'We replaced rclone with rsync', status: 'current' });
    db.close();
  });

  it('conflict: contradicting note is flagged, old stays current', () => {
    const db = openDb(path.join(tmp, 'db.sqlite'));
    const ctx = { projectPath: '/tmp/demo', sessionPk: null, memberId: null };
    applyNotes(db, [note('auth', 'method', 'JWT everywhere')], ctx);
    applyNotes(db, [note('auth', 'method', 'Session cookies everywhere', { contradictsCurrent: true })], ctx);

    const rows = db.prepare('SELECT body, status, conflict_with FROM memory_notes ORDER BY id').all() as {
      body: string;
      status: string;
      conflict_with: number | null;
    }[];
    expect(rows[0]).toMatchObject({ body: 'JWT everywhere', status: 'current' });
    expect(rows[1]).toMatchObject({ status: 'conflicted' });
    expect(rows[1]!.conflict_with).not.toBeNull();
    db.close();
  });

  it('pipeline processes only idle sessions with new messages, incrementally', async () => {
    const db = openDb(path.join(tmp, 'db.sqlite'));
    const bus = new LiveBus();
    const { memberId } = registerMember(db, { name: 'ada' });

    const messages: MotifMessage[] = [
      { id: 'u1', role: 'user', timestamp: '2026-08-01T10:00:00.000Z', text: 'switch storage to sqlite' },
      { id: 'a1#0', role: 'assistant', timestamp: '2026-08-01T10:00:05.000Z', text: 'done, sqlite it is' },
    ];
    const session: MotifSession = {
      id: 'claude-code:mem1',
      source: 'claude-code',
      sourceSessionId: 'mem1',
      sourcePath: '/fake/mem1.jsonl',
      projectPath: '/tmp/demo',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:05.000Z', // long idle
      messages,
      filesTouched: [],
      meta: { subagentCount: 0, branchCount: 0, parseErrors: 0 },
    };
    fullReplaceSession(db, memberId, session);

    const calls: string[] = [];
    const provider: LLMProvider = {
      name: 'fake',
      async completeJSON({ user }) {
        calls.push(user);
        return { notes: [note('storage', 'engine', 'SQLite is the storage engine')] };
      },
    };

    expect(await runMemoryTick(db, provider, bus)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('switch storage to sqlite');
    const notes = db.prepare("SELECT body FROM memory_notes WHERE status = 'current'").all();
    expect(notes).toHaveLength(1);

    // second tick: watermark advanced, nothing new to process
    expect(await runMemoryTick(db, provider, bus)).toBe(0);
    expect(calls).toHaveLength(1);
    db.close();
  });

  it('skips gracefully when the model returns garbage', async () => {
    const db = openDb(path.join(tmp, 'db.sqlite'));
    const bus = new LiveBus();
    const { memberId } = registerMember(db, { name: 'ada' });
    fullReplaceSession(db, memberId, {
      id: 'claude-code:mem2',
      source: 'claude-code',
      sourceSessionId: 'mem2',
      sourcePath: '/fake/mem2.jsonl',
      projectPath: '/tmp/demo',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:05.000Z',
      messages: [{ id: 'u1', role: 'user', timestamp: '2026-08-01T10:00:00.000Z', text: 'hi' }],
      filesTouched: [],
      meta: { subagentCount: 0, branchCount: 0, parseErrors: 0 },
    });

    let attempts = 0;
    const provider: LLMProvider = {
      name: 'fake',
      async completeJSON() {
        attempts++;
        throw new Error('boom');
      },
    };
    expect(await runMemoryTick(db, provider, bus)).toBe(0);
    expect(attempts).toBe(2); // original + one repair retry
    // watermark advanced so the poisoned session doesn't loop forever
    expect(await runMemoryTick(db, provider, bus)).toBe(0);
    expect(attempts).toBe(2);
    db.close();
  });

  const soloSession = (memberId: number, text: string): MotifSession => ({
    id: 'claude-code:solo1',
    source: 'claude-code',
    sourceSessionId: 'solo1',
    sourcePath: '/fake/solo1.jsonl',
    projectPath: '/tmp/demo',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:05.000Z',
    visibility: 'personal',
    messages: [{ id: 'u1', role: 'user', timestamp: '2026-08-01T10:00:00.000Z', text }],
    filesTouched: [],
    meta: { subagentCount: 0, branchCount: 0, parseErrors: 0 },
  });

  it('distils a personal session into owner-private memory, so solo works with no leak', async () => {
    const db = openDb(path.join(tmp, 'db.sqlite'));
    const bus = new LiveBus();
    const ada = registerMember(db, { name: 'ada' });
    const ben = registerMember(db, { name: 'ben' });
    fullReplaceSession(db, ada.memberId, soloSession(ada.memberId, 'use bun for the build scripts'));

    const provider: LLMProvider = {
      name: 'fake',
      async completeJSON() {
        return { notes: [note('runtime', 'scripts', 'Bun runs the build scripts here')] };
      },
    };
    expect(await runMemoryTick(db, provider, bus)).toBe(1);

    // solo is functional: ada gets her own memory back
    const forAda = recall(db, { query: 'bun build scripts runtime', viewerId: ada.memberId });
    expect(JSON.stringify(forAda)).toContain('Bun runs the build scripts');

    // the privacy gate holds: ben, on the same server, never sees it
    const forBen = recall(db, { query: 'bun build scripts runtime', viewerId: ben.memberId });
    expect(JSON.stringify(forBen)).not.toContain('Bun runs the build scripts');
    db.close();
  });

  it("a team extraction never sees another member's personal notes as context", async () => {
    const db = openDb(path.join(tmp, 'db.sqlite'));
    const bus = new LiveBus();
    const ada = registerMember(db, { name: 'ada' });
    const ben = registerMember(db, { name: 'ben' });

    // ada's personal session, distilled first (older)
    fullReplaceSession(db, ada.memberId, soloSession(ada.memberId, 'ada prefers bun privately'));
    // ben's TEAM session in the same project, newer so it runs second
    fullReplaceSession(db, ben.memberId, {
      id: 'claude-code:team1',
      source: 'claude-code',
      sourceSessionId: 'team1',
      sourcePath: '/fake/team1.jsonl',
      projectPath: '/tmp/demo',
      createdAt: '2026-08-01T10:00:20.000Z',
      updatedAt: '2026-08-01T10:00:25.000Z',
      visibility: 'team',
      messages: [
        { id: 'u1', role: 'user', timestamp: '2026-08-01T10:00:20.000Z', text: 'we ship on node 22' },
      ],
      filesTouched: [],
      meta: { subagentCount: 0, branchCount: 0, parseErrors: 0 },
    });

    const calls: string[] = [];
    const provider: LLMProvider = {
      name: 'fake',
      async completeJSON({ user }) {
        calls.push(user);
        return { notes: [note('runtime', 'engine', calls.length === 1 ? 'Bun, personal' : 'Node 22, team')] };
      },
    };

    expect(await runMemoryTick(db, provider, bus)).toBe(1); // ada personal
    expect(await runMemoryTick(db, provider, bus)).toBe(1); // ben team
    expect(calls).toHaveLength(2);
    // the team run's prompt must not carry ada's private note into a shared note
    expect(calls[1]).toContain('we ship on node 22');
    expect(calls[1]).not.toContain('Bun, personal');
    db.close();
  });

  const decision = (
    name: string,
    aspect: string,
    body: string,
    extra: Partial<{ contradictsCurrent: boolean }> = {},
  ) => ({ entity: { kind: 'decision' as const, name }, aspect, body, ...extra });

  it('gates a team decision as a proposal, held out of recall until admitted', () => {
    const db = openDb(path.join(tmp, 'db.sqlite'));
    const ada = registerMember(db, { name: 'ada' });
    // a distilled TEAM decision (sessionPk null = team lane)
    applyNotes(db, [decision('cache-keys', 'policy', 'shared cache keys include tenant_id')], {
      projectPath: '/tmp/demo',
      sessionPk: null,
      memberId: ada.memberId,
      gate: true,
    });
    const noteId = (
      db.prepare("SELECT id FROM memory_notes WHERE body LIKE '%tenant_id%'").get() as { id: number }
    ).id;
    const q = { query: 'cache keys tenant', viewerId: ada.memberId };

    // proposed: out of recall, but present in the review queue as a proposal
    expect(JSON.stringify(recall(db, q))).not.toContain('tenant_id');
    const queue = listReviewQueue(db, ada.memberId);
    expect(queue.some((i) => i.type === 'proposed' && i.note.id === noteId)).toBe(true);

    // a human admits it, and only then does recall serve it
    applyVerdict(db, { noteId, reviewerId: ada.memberId, verdict: 'confirm' });
    expect(JSON.stringify(recall(db, q))).toContain('tenant_id');
    db.close();
  });

  it('a rejected proposal never reaches recall', () => {
    const db = openDb(path.join(tmp, 'db.sqlite'));
    const ada = registerMember(db, { name: 'ada' });
    applyNotes(db, [decision('cache-keys', 'policy', 'query params alone are enough')], {
      projectPath: '/tmp/demo',
      sessionPk: null,
      memberId: ada.memberId,
      gate: true,
    });
    const noteId = (
      db.prepare("SELECT id FROM memory_notes WHERE body LIKE '%query params%'").get() as { id: number }
    ).id;
    applyVerdict(db, { noteId, reviewerId: ada.memberId, verdict: 'retire' });
    expect(
      JSON.stringify(recall(db, { query: 'cache keys query params', viewerId: ada.memberId })),
    ).not.toContain('query params alone');
    db.close();
  });

  it('admitting a proposal supersedes the team decision it updates', () => {
    const db = openDb(path.join(tmp, 'db.sqlite'));
    const ada = registerMember(db, { name: 'ada' });
    const admit = (body: string): number => {
      applyNotes(db, [decision('rate-limit', 'policy', body)], {
        projectPath: '/tmp/demo',
        sessionPk: null,
        memberId: ada.memberId,
        gate: true,
      });
      const id = (
        db.prepare('SELECT id FROM memory_notes WHERE body = ? AND admitted = 0').get(body) as {
          id: number;
        }
      ).id;
      applyVerdict(db, { noteId: id, reviewerId: ada.memberId, verdict: 'confirm' });
      return id;
    };
    const first = admit('fail open when redis is down');
    const second = admit('fail closed when redis is down');

    const row = (id: number) =>
      db.prepare('SELECT status, superseded_by FROM memory_notes WHERE id = ?').get(id) as {
        status: string;
        superseded_by: number | null;
      };
    expect(row(first)).toMatchObject({ status: 'superseded', superseded_by: second });
    expect(row(second).status).toBe('current');
    const out = JSON.stringify(recall(db, { query: 'rate limit redis fail', viewerId: ada.memberId }));
    expect(out).toContain('fail closed');
    expect(out).not.toContain('fail open');
    db.close();
  });
});
