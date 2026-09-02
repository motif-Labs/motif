import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MotifSession } from '@motif/core';
import {
  applyNotes,
  applyVerdict,
  createServer,
  fullReplaceSession,
  listReviewQueue,
  markStaleNotes,
  openDb,
  recall,
  registerMember,
  startServer,
  type Db,
  type MotifServer,
} from '@motif/server';

let tmp: string;
let db: Db;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-review-'));
  db = openDb(path.join(tmp, 'db.sqlite'));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const PROJECT = '/workspace/app';

function seedConflict(memberId: number): { standingId: number; challengerId: number } {
  applyNotes(
    db,
    [
      {
        entity: { kind: 'decision', name: 'redis outage policy' },
        aspect: 'behaviour',
        body: 'The limiter fails open when redis is unreachable.',
      },
    ],
    { projectPath: PROJECT, sessionPk: null, memberId },
  );
  applyNotes(
    db,
    [
      {
        entity: { kind: 'decision', name: 'redis outage policy' },
        aspect: 'behaviour',
        body: 'ADR-014 says fail closed when redis is unreachable.',
        contradictsCurrent: true,
      },
    ],
    { projectPath: PROJECT, sessionPk: null, memberId },
  );
  const rows = db.prepare('SELECT id, status FROM memory_notes ORDER BY id').all() as {
    id: number;
    status: string;
  }[];
  const standing = rows.find((r) => r.status === 'current')!;
  const challenger = rows.find((r) => r.status === 'conflicted')!;
  return { standingId: standing.id, challengerId: challenger.id };
}

describe('memory review — the human loop over distilled claims', () => {
  it('surfaces a conflict as one item carrying both sides', () => {
    const { memberId } = registerMember(db, { name: 'ada' });
    const { standingId, challengerId } = seedConflict(memberId);

    const queue = listReviewQueue(db, memberId);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.type).toBe('conflict');
    expect(queue[0]!.note.id).toBe(challengerId);
    expect(queue[0]!.against!.id).toBe(standingId);
  });

  it("'prefer' crowns the challenger, supersedes the incumbent, and records who ruled and why", () => {
    const { memberId } = registerMember(db, { name: 'ada' });
    const { standingId, challengerId } = seedConflict(memberId);

    applyVerdict(db, {
      noteId: challengerId,
      reviewerId: memberId,
      verdict: 'prefer',
      overNoteId: standingId,
      reason: 'ADR-014 is the written decision; the session misremembered it',
    });

    const winner = db
      .prepare('SELECT status, verification FROM memory_notes WHERE id = ?')
      .get(challengerId) as {
      status: string;
      verification: string;
    };
    const loser = db
      .prepare('SELECT status, superseded_by FROM memory_notes WHERE id = ?')
      .get(standingId) as {
      status: string;
      superseded_by: number;
    };
    expect(winner).toEqual({ status: 'current', verification: 'verified' });
    expect(loser.status).toBe('superseded');
    expect(loser.superseded_by).toBe(challengerId);

    // the ruling itself is part of the record
    const review = db.prepare('SELECT * FROM memory_reviews WHERE note_id = ?').get(challengerId) as {
      reviewer_id: number;
      verdict: string;
      over_note_id: number;
      reason: string;
    };
    expect(review.reviewer_id).toBe(memberId);
    expect(review.verdict).toBe('prefer');
    expect(review.over_note_id).toBe(standingId);
    expect(review.reason).toContain('ADR-014');

    expect(listReviewQueue(db, memberId)).toHaveLength(0);
  });

  it('recall stops serving retired notes and ranks human-verified above machine-current', () => {
    const { memberId } = registerMember(db, { name: 'ada' });
    applyNotes(
      db,
      [
        {
          entity: { kind: 'decision', name: 'retry policy' },
          aspect: 'behaviour',
          body: 'Retries use exponential backoff with jitter.',
        },
        {
          entity: { kind: 'decision', name: 'retry policy old' },
          aspect: 'behaviour',
          body: 'Retries happen exactly three times with no backoff.',
        },
      ],
      { projectPath: PROJECT, sessionPk: null, memberId },
    );
    const wrong = db.prepare("SELECT id FROM memory_notes WHERE body LIKE '%exactly three times%'").get() as {
      id: number;
    };
    applyVerdict(db, { noteId: wrong.id, reviewerId: memberId, verdict: 'retire' });
    const right = db.prepare("SELECT id FROM memory_notes WHERE body LIKE '%jitter%'").get() as {
      id: number;
    };
    applyVerdict(db, { noteId: right.id, reviewerId: memberId, verdict: 'confirm' });

    const out = recall(db, { query: 'retry backoff policy', budget: 1500 });
    const texts = out.items.map((i) => i.text).join('\n');
    expect(texts).toContain('jitter');
    expect(texts).not.toContain('exactly three times');
    expect(out.items.find((i) => i.text.includes('jitter'))!.why).toContain('human-verified');
  });

  it("'confirm' refuses a note that is still in conflict — a ruling must pick a side", () => {
    const { memberId } = registerMember(db, { name: 'ada' });
    const { challengerId } = seedConflict(memberId);
    expect(() =>
      applyVerdict(db, { noteId: challengerId, reviewerId: memberId, verdict: 'confirm' }),
    ).toThrow(/prefer/);
  });

  it("'retire' on a challenger withdraws the challenge and the incumbent stands", () => {
    const { memberId } = registerMember(db, { name: 'ada' });
    const { standingId, challengerId } = seedConflict(memberId);
    applyVerdict(db, { noteId: challengerId, reviewerId: memberId, verdict: 'retire' });

    const standing = db.prepare('SELECT status FROM memory_notes WHERE id = ?').get(standingId) as {
      status: string;
    };
    expect(standing.status).toBe('current');
    expect(listReviewQueue(db, memberId)).toHaveLength(0);
    // and it stops COUNTING as a conflict — a retired challenge left
    // 'conflicted' would show the dashboard a conflict nothing could clear
    const challenger = db.prepare('SELECT status FROM memory_notes WHERE id = ?').get(challengerId) as {
      status: string;
    };
    expect(challenger.status).toBe('superseded');
  });

  it("'prefer' refuses notes that are not in conflict with each other", () => {
    const { memberId } = registerMember(db, { name: 'ada' });
    const { challengerId } = seedConflict(memberId);
    applyNotes(
      db,
      [{ entity: { kind: 'decision', name: 'unrelated' }, aspect: 'x', body: 'an innocent bystander' }],
      { projectPath: PROJECT, sessionPk: null, memberId },
    );
    const bystander = db.prepare("SELECT id FROM memory_notes WHERE body LIKE '%bystander%'").get() as {
      id: number;
    };
    // a typo'd --over id must not silently supersede a live unrelated note
    expect(() =>
      applyVerdict(db, {
        noteId: challengerId,
        reviewerId: memberId,
        verdict: 'prefer',
        overNoteId: bystander.id,
      }),
    ).toThrow(/not in conflict/);
    const untouched = db.prepare('SELECT status FROM memory_notes WHERE id = ?').get(bystander.id) as {
      status: string;
    };
    expect(untouched.status).toBe('current');
  });

  it('a contradictsCurrent note with nothing to contradict lands as current and reports no conflict', () => {
    const { memberId } = registerMember(db, { name: 'ada' });
    const { conflicts } = applyNotes(
      db,
      [
        {
          entity: { kind: 'decision', name: 'brand new topic' },
          aspect: 'a',
          body: 'first claim ever',
          contradictsCurrent: true,
        },
      ],
      { projectPath: PROJECT, sessionPk: null, memberId },
    );
    expect(conflicts).toHaveLength(0);
    expect(listReviewQueue(db, memberId)).toHaveLength(0);
  });
});

function makeSession(id: string, files: string[], updatedAt: string, project = PROJECT): MotifSession {
  return {
    id: `claude-code:${id}`,
    source: 'claude-code',
    sourceSessionId: id,
    sourcePath: `/fake/${id}.jsonl`,
    projectPath: project,
    gitBranch: 'main',
    title: 'work',
    createdAt: updatedAt,
    updatedAt,
    messages: [{ id: `${id}-u1`, role: 'user', timestamp: updatedAt, text: 'do the thing' }],
    filesTouched: files,
    meta: { subagentCount: 0, branchCount: 0, parseErrors: 0 },
  };
}

describe('staleness — doubt raised when the ground moves under a note', () => {
  it('marks a note stale after enough later sessions touch its files, and the queue shows it', () => {
    const { memberId } = registerMember(db, { name: 'ada' });
    const src = fullReplaceSession(
      db,
      memberId,
      makeSession('src', ['src/limiter.js'], '2026-08-01T10:00:00.000Z'),
    );
    applyNotes(
      db,
      [
        {
          entity: { kind: 'file', name: 'src/limiter.js' },
          aspect: 'design',
          body: 'A token bucket lives here.',
        },
      ],
      { projectPath: PROJECT, sessionPk: src.pk, memberId },
    );

    // later sessions record the SAME file in different shapes — relative here,
    // absolute there — exactly what cross-tool teams produce
    fullReplaceSession(db, memberId, makeSession('later0', ['src/limiter.js'], '2026-08-02T10:00:00.000Z'));
    fullReplaceSession(
      db,
      memberId,
      makeSession('later1', ['/workspace/app/src/limiter.js'], '2026-08-03T10:00:00.000Z'),
    );
    fullReplaceSession(db, memberId, makeSession('later2', ['src/limiter.js'], '2026-08-04T10:00:00.000Z'));
    expect(markStaleNotes(db)).toBe(1);

    const queue = listReviewQueue(db, memberId);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.type).toBe('stale');
    expect(queue[0]!.note.stale_reason).toContain('later session');

    // recall still serves it, but says the ground moved
    const out = recall(db, { query: 'token bucket limiter', budget: 1500 });
    expect(out.items.find((i) => i.text.includes('token bucket'))!.why).toContain('possibly stale');
  });

  it('leaves alone: verified notes, refreshed entities, and quiet files', () => {
    const { memberId } = registerMember(db, { name: 'ada' });
    const src = fullReplaceSession(
      db,
      memberId,
      makeSession('src', ['src/a.js', 'src/b.js'], '2026-08-01T10:00:00.000Z'),
    );
    applyNotes(
      db,
      [
        { entity: { kind: 'file', name: 'src/a.js' }, aspect: 'design', body: 'Verified claim about a.' },
        { entity: { kind: 'file', name: 'src/b.js' }, aspect: 'design', body: 'Refreshed claim about b.' },
      ],
      { projectPath: PROJECT, sessionPk: src.pk, memberId },
    );
    const verified = db.prepare("SELECT id FROM memory_notes WHERE body LIKE '%Verified%'").get() as {
      id: number;
    };
    applyVerdict(db, { noteId: verified.id, reviewerId: memberId, verdict: 'confirm' });

    for (let i = 0; i < 3; i++) {
      fullReplaceSession(
        db,
        memberId,
        makeSession(`later${i}`, ['src/a.js', 'src/b.js'], `2026-08-0${2 + i}T10:00:00.000Z`),
      );
    }
    // the refreshed entity got a newer note — distillation kept up
    applyNotes(
      db,
      [{ entity: { kind: 'file', name: 'src/b.js' }, aspect: 'design', body: 'Newer claim about b.' }],
      { projectPath: PROJECT, sessionPk: null, memberId },
    );

    expect(markStaleNotes(db)).toBe(0);
    expect(listReviewQueue(db, memberId)).toHaveLength(0);
  });
});

describe('memory visibility — notes inherit the visibility of their evidence', () => {
  let server: MotifServer;
  let httpServer: ReturnType<typeof startServer>;
  let base: string;

  beforeEach(async () => {
    server = createServer({ dbPath: path.join(tmp, 'http.sqlite'), token: 'test-token' });
    httpServer = startServer(server, { port: 0 });
    if (!httpServer.listening) await new Promise((r) => httpServer.once('listening', r));
    const addr = httpServer.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterEach(() => {
    httpServer.close();
    server.db.close();
  });

  const call = (p: string, token: string) =>
    fetch(base + p, { headers: { authorization: `Bearer ${token}` } });

  it('an entity distilled from a personal session exists only for its owner', async () => {
    const owner = registerMember(server.db, { name: 'ada', email: 'ada@example.com' });
    const other = registerMember(server.db, { name: 'bob', email: 'bob@example.com' });
    const src = fullReplaceSession(
      server.db,
      owner.memberId,
      makeSession('private', ['src/secret-feature.ts'], '2026-08-01T10:00:00.000Z', '/workspace/private-app'),
    );
    server.db.prepare('UPDATE sessions SET visibility = ? WHERE pk = ?').run('personal', src.pk);
    applyNotes(
      server.db,
      [
        {
          entity: { kind: 'topic', name: 'secret feature plan' },
          aspect: 'decision',
          body: 'The unannounced feature ships in October.',
        },
      ],
      { projectPath: '/workspace/private-app', sessionPk: src.pk, memberId: owner.memberId },
    );

    const forOwner = (await (await call('/api/memory/entities', owner.memberToken)).json()) as {
      name: string;
    }[];
    expect(forOwner.map((e) => e.name)).toContain('secret feature plan');

    const forOther = (await (await call('/api/memory/entities', other.memberToken)).json()) as {
      name: string;
    }[];
    expect(forOther.map((e) => e.name)).not.toContain('secret feature plan');

    // the detail endpoint agrees: for the outsider the entity does not exist
    const id = (forOwner.find((e) => e.name === 'secret feature plan') as { id?: number }).id;
    expect((await call(`/api/memory/entities/${id}`, other.memberToken)).status).toBe(404);
    expect((await call(`/api/memory/entities/${id}`, owner.memberToken)).status).toBe(200);

    // and the review queue keeps the same promise for conflicts born of personal work
    applyNotes(
      server.db,
      [
        {
          entity: { kind: 'topic', name: 'secret feature plan' },
          aspect: 'decision',
          body: 'The feature slipped to November.',
          contradictsCurrent: true,
        },
      ],
      { projectPath: '/workspace/private-app', sessionPk: src.pk, memberId: owner.memberId },
    );
    const ownerQueue = (await (await call('/api/memory/review', owner.memberToken)).json()) as {
      items: unknown[];
    };
    const otherQueue = (await (await call('/api/memory/review', other.memberToken)).json()) as {
      items: unknown[];
    };
    expect(ownerQueue.items).toHaveLength(1);
    expect(otherQueue.items).toHaveLength(0);

    // recall keeps the same promise — the MCP path must not leak what the
    // dashboard hides
    const ownerRecall = recall(server.db, { query: 'secret feature ships', viewerId: owner.memberId });
    const otherRecall = recall(server.db, { query: 'secret feature ships', viewerId: other.memberId });
    expect(ownerRecall.items.some((i) => i.text.includes('secret'))).toBe(true);
    expect(otherRecall.items.some((i) => i.text.includes('secret'))).toBe(false);

    // and the WRITE path: a stranger can neither read nor rule on the note
    const secretNote = server.db.prepare("SELECT id FROM memory_notes WHERE body LIKE '%October%'").get() as {
      id: number;
    };
    const strangerVerdict = await fetch(`${base}/api/memory/notes/${secretNote.id}/verdict`, {
      method: 'POST',
      headers: { authorization: `Bearer ${other.memberToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'retire' }),
    });
    expect(strangerVerdict.status).toBe(404); // not 403 — its existence is not theirs to learn
    const untouched = server.db
      .prepare('SELECT verification FROM memory_notes WHERE id = ?')
      .get(secretNote.id) as { verification: string };
    expect(untouched.verification).toBe('unverified');

    // deleting the personal evidence must not PUBLISH the claim: the orphaned
    // note keeps the visibility it died with
    const del = await fetch(`${base}/api/sessions/${encodeURIComponent('claude-code:private')}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${owner.memberToken}` },
    });
    expect(del.status).toBe(200);
    const afterDelete = (await (await call('/api/memory/entities', other.memberToken)).json()) as {
      name: string;
    }[];
    expect(afterDelete.map((e) => e.name)).not.toContain('secret feature plan');
    const stillOwners = (await (await call('/api/memory/entities', owner.memberToken)).json()) as {
      name: string;
    }[];
    expect(stillOwners.map((e) => e.name)).toContain('secret feature plan');
  });

  it('a retired note stops counting on the Memory tab — dashboard and agents read one truth', async () => {
    const cleo = registerMember(server.db, { name: 'cleo', email: 'cleo@example.com' });
    applyNotes(
      server.db,
      [{ entity: { kind: 'decision', name: 'lone claim' }, aspect: 'a', body: 'the only note here' }],
      { projectPath: '/workspace/app', sessionPk: null, memberId: cleo.memberId },
    );
    const note = server.db.prepare("SELECT id FROM memory_notes WHERE body = 'the only note here'").get() as {
      id: number;
    };
    applyVerdict(server.db, { noteId: note.id, reviewerId: cleo.memberId, verdict: 'retire' });

    const entities = (await (await call('/api/memory/entities', cleo.memberToken)).json()) as {
      name: string;
      current_notes: number;
    }[];
    const lone = entities.find((e) => e.name === 'lone claim');
    expect(lone?.current_notes ?? 0).toBe(0);
  });
});
