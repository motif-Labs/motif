import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyNotes,
  applyVerdict,
  listReviewQueue,
  openDb,
  recall,
  registerMember,
  type Db,
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
  });
});
