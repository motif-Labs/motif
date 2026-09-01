/**
 * The human loop over distilled memory.
 *
 * Sessions are evidence and never change; notes are claims with a lifecycle.
 * The extraction pipeline marks contradictions instead of resolving them
 * (pipeline.ts), which leaves a queue only a person can clear: which claim is
 * still true. This module builds that queue and applies the verdicts.
 *
 * Verdicts never delete. A wrong note is retired, a losing note is superseded,
 * and the ruling itself — who, over what, why — is recorded in memory_reviews.
 */
import type { Db } from '../db/database.js';

export type Verdict = 'confirm' | 'prefer' | 'retire' | 'dispute';

export interface ReviewNote {
  id: number;
  entity_id: number;
  kind: string;
  entity: string;
  project_path: string;
  aspect: string;
  body: string;
  status: string;
  verification: string;
  stale: number;
  stale_reason: string | null;
  author_name: string | null;
  session_id: string | null;
  session_visibility: string | null;
  session_member_id: number | null;
  created_at: string;
}

export interface ReviewItem {
  type: 'conflict' | 'stale' | 'disputed';
  /** The note awaiting judgement (for conflicts: the challenger). */
  note: ReviewNote;
  /** For conflicts: the note it contradicts (the incumbent). */
  against?: ReviewNote;
}

const NOTE_SELECT = `
  SELECT n.id, n.entity_id, e.kind, e.name AS entity, e.project_path,
         n.aspect, n.body, n.status, n.verification, n.stale, n.stale_reason,
         n.created_at,
         m.name AS author_name,
         s.id AS session_id, s.visibility AS session_visibility,
         s.member_id AS session_member_id
  FROM memory_notes n
  JOIN memory_entities e ON e.id = n.entity_id
  LEFT JOIN members m ON m.id = n.member_id
  LEFT JOIN sessions s ON s.pk = n.source_session_pk`;

/** A note is shown only when its evidence would be — same rule as sessions. */
function viewable(note: ReviewNote, viewerId: number | undefined): boolean {
  if (note.session_id === null) return true; // no session attached (e.g. seeded)
  if (note.session_visibility !== 'personal') return true;
  return viewerId !== undefined && note.session_member_id === viewerId;
}

/**
 * Everything waiting for a human: unresolved conflicts (challenger + incumbent,
 * side by side), notes flagged stale, and notes someone disputed. Ordered by
 * age — the oldest doubt is the most expensive one.
 */
export function listReviewQueue(db: Db, viewerId: number | undefined): ReviewItem[] {
  // freshness is computed lazily on read: cheap, deterministic, and needs no scheduler
  markStaleNotes(db);
  const noteById = (id: number): ReviewNote | undefined =>
    db.prepare(`${NOTE_SELECT} WHERE n.id = ?`).get(id) as ReviewNote | undefined;

  const items: ReviewItem[] = [];

  const conflicts = db
    .prepare(
      `${NOTE_SELECT} WHERE n.status = 'conflicted' AND n.verification NOT IN ('retired') ORDER BY n.created_at ASC`,
    )
    .all() as (ReviewNote & { conflict_with?: number })[];
  const conflictWith = db.prepare('SELECT conflict_with FROM memory_notes WHERE id = ?');
  for (const note of conflicts) {
    const ref = conflictWith.get(note.id) as { conflict_with: number | null } | undefined;
    const against = ref?.conflict_with ? noteById(ref.conflict_with) : undefined;
    if (!viewable(note, viewerId)) continue;
    if (against && !viewable(against, viewerId)) continue;
    items.push({ type: 'conflict', note, against });
  }

  const stale = db
    .prepare(
      `${NOTE_SELECT} WHERE n.stale = 1 AND n.status = 'current' AND n.verification NOT IN ('retired') ORDER BY n.created_at ASC`,
    )
    .all() as ReviewNote[];
  for (const note of stale) if (viewable(note, viewerId)) items.push({ type: 'stale', note });

  const disputed = db
    .prepare(
      `${NOTE_SELECT} WHERE n.verification = 'disputed' AND n.status != 'conflicted' AND n.stale = 0 ORDER BY n.created_at ASC`,
    )
    .all() as ReviewNote[];
  for (const note of disputed) if (viewable(note, viewerId)) items.push({ type: 'disputed', note });

  return items;
}

export interface StaleOptions {
  /** How many later sessions must touch a note's source files before doubt is raised. */
  threshold?: number;
}

/**
 * Deterministic staleness: a machine-made note whose source files have since
 * been worked on repeatedly, with no newer note on the same entity, is probably
 * describing code that no longer exists that way. No model call — this reads
 * only what the sync already stored, so it works with no LLM configured.
 *
 * Human-verified notes are exempt: a person's word is not overruled by a
 * heuristic. If the world really changed, distillation will eventually raise a
 * conflict, and that goes back through a person.
 */
export function markStaleNotes(db: Db, opts: StaleOptions = {}): number {
  const threshold = opts.threshold ?? 3;
  const candidates = db
    .prepare(
      `SELECT n.id, n.entity_id, n.created_at, n.source_session_pk,
              s.project_path, s.updated_at AS src_updated, s.files_touched
       FROM memory_notes n JOIN sessions s ON s.pk = n.source_session_pk
       WHERE n.status = 'current' AND n.verification = 'unverified' AND n.stale = 0`,
    )
    .all() as {
    id: number;
    entity_id: number;
    created_at: string;
    source_session_pk: number;
    project_path: string;
    src_updated: string;
    files_touched: string;
  }[];

  const newerNote = db.prepare(
    'SELECT 1 FROM memory_notes WHERE entity_id = ? AND created_at > ? AND id != ? LIMIT 1',
  );
  const laterSessions = db.prepare(
    'SELECT files_touched FROM sessions WHERE project_path = ? AND updated_at > ? AND pk != ?',
  );

  let marked = 0;
  for (const n of candidates) {
    const files = JSON.parse(n.files_touched || '[]') as string[];
    if (files.length === 0) continue;
    // distillation kept up with this entity — the note is contested or refreshed, not stale
    if (newerNote.get(n.entity_id, n.created_at, n.id)) continue;
    let touching = 0;
    for (const later of laterSessions.all(n.project_path, n.src_updated, n.source_session_pk) as {
      files_touched: string;
    }[]) {
      const lf = JSON.parse(later.files_touched || '[]') as string[];
      if (lf.some((f) => files.includes(f))) touching++;
      if (touching >= threshold) break;
    }
    if (touching >= threshold) {
      db.prepare('UPDATE memory_notes SET stale = 1, stale_reason = ? WHERE id = ?').run(
        `${touching} later session(s) worked on its source files and produced no newer note`,
        n.id,
      );
      marked++;
    }
  }
  return marked;
}

export interface VerdictInput {
  noteId: number;
  reviewerId: number;
  verdict: Verdict;
  /** For 'prefer': the losing note this one wins over. */
  overNoteId?: number;
  reason?: string;
}

export function applyVerdict(db: Db, input: VerdictInput): ReviewNote {
  const now = new Date().toISOString();
  const note = db
    .prepare('SELECT id, status, conflict_with FROM memory_notes WHERE id = ?')
    .get(input.noteId) as { id: number; status: string; conflict_with: number | null } | undefined;
  if (!note) throw new Error(`no note #${input.noteId}`);

  db.transaction(() => {
    switch (input.verdict) {
      case 'confirm': {
        // a person vouches for the claim as it stands
        db.prepare(
          `UPDATE memory_notes SET verification = 'verified', verified_by = ?, verified_at = ?, stale = 0, stale_reason = NULL WHERE id = ?`,
        ).run(input.reviewerId, now, input.noteId);
        // confirming a conflicted challenger without naming a loser is ambiguous
        if (note.status === 'conflicted') {
          throw new Error(`note #${input.noteId} is in conflict — use 'prefer' to pick the winner`);
        }
        break;
      }
      case 'prefer': {
        const loserId = input.overNoteId ?? note.conflict_with;
        if (!loserId) throw new Error(`'prefer' needs the losing note (--over <id>)`);
        if (loserId === input.noteId) throw new Error('a note cannot win over itself');
        const loser = db.prepare('SELECT id FROM memory_notes WHERE id = ?').get(loserId);
        if (!loser) throw new Error(`no note #${loserId}`);
        db.prepare(
          `UPDATE memory_notes SET status = 'current', conflict_with = NULL,
                  verification = 'verified', verified_by = ?, verified_at = ?, stale = 0, stale_reason = NULL
           WHERE id = ?`,
        ).run(input.reviewerId, now, input.noteId);
        db.prepare(
          `UPDATE memory_notes SET status = 'superseded', superseded_by = ?, conflict_with = NULL WHERE id = ?`,
        ).run(input.noteId, loserId);
        // any other challengers that pointed at the loser now contest the winner
        db.prepare('UPDATE memory_notes SET conflict_with = ? WHERE conflict_with = ?').run(
          input.noteId,
          loserId,
        );
        break;
      }
      case 'retire': {
        // out of service, never out of the record
        db.prepare(
          `UPDATE memory_notes SET verification = 'retired', verified_by = ?, verified_at = ? WHERE id = ?`,
        ).run(input.reviewerId, now, input.noteId);
        if (note.status === 'conflicted' && note.conflict_with) {
          // the challenge is withdrawn; the incumbent stands
          db.prepare('UPDATE memory_notes SET conflict_with = NULL WHERE id = ?').run(input.noteId);
        }
        break;
      }
      case 'dispute': {
        db.prepare(`UPDATE memory_notes SET verification = 'disputed' WHERE id = ?`).run(input.noteId);
        break;
      }
    }
    db.prepare(
      `INSERT INTO memory_reviews (note_id, reviewer_id, verdict, over_note_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.noteId,
      input.reviewerId,
      input.verdict,
      input.verdict === 'prefer' ? (input.overNoteId ?? note.conflict_with) : null,
      input.reason ?? null,
      now,
    );
  })();

  return db.prepare(`${NOTE_SELECT} WHERE n.id = ?`).get(input.noteId) as ReviewNote;
}
