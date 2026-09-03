/**
 * The Weaver's queue. When a ruling lands on team memory, the repository may
 * still say what the losing claim said, an ADR, a comment, a README. The
 * server cannot fix that (it has no checkout and runs no agent), so it queues
 * the work: a daemon with the project on disk and the owner's explicit opt-in
 * claims the job, weaves the change in a throwaway worktree, and reports the
 * draft PR back.
 *
 * Claiming is atomic, two daemons cannot take the same job, and a job born
 * from personal evidence is never queued at all: what a stranger cannot read,
 * the Weaver must not broadcast.
 */
import type { Db } from './db/database.js';

export interface RulingPayload {
  kind: 'ruling';
  entity: string;
  aspect: string;
  winnerBody: string;
  loserBody: string;
  reason: string | null;
  reviewerName: string | null;
  winnerSessionId: string | null;
  loserSessionId: string | null;
}

/** A gap the record can see but the repo hasn't closed: a change made in a
 * session with no test to hold it. The context travels WITH the job, the
 * session's own summary and the files it touched, so the agent writes the
 * test instead of spelunking the whole tree for it. That is the point: the
 * work is aimed, not exploratory, and cheap because of it. */
export interface GapPayload {
  kind: 'missing-regression';
  file: string;
  changeKind: ChangeKind;
  sessionId: string;
  sessionTitle: string;
  memberName: string | null;
  /** The distilled note(s) about this file, what the change was and why. */
  context: string;
}

export type WeaverPayload = RulingPayload | GapPayload;

export interface WeaverJobRow {
  id: number;
  project_path: string;
  payload: string;
  status: 'pending' | 'running' | 'done' | 'error';
  claimed_by: number | null;
  pr_url: string | null;
  result: string | null;
  resolution: 'merged' | 'closed' | null;
  source_note_id: number | null;
  created_at: string;
  updated_at: string;
}

export type ChangeKind = 'fix' | 'feature' | 'change';

export interface RegressionGap {
  file: string;
  changeKind: ChangeKind;
  sessionId: string;
  sessionTitle: string;
  memberName: string | null;
  project: string;
  context: string;
}

const TEST_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$/i;
const CODE_RE = /\.[jt]sx?$|\.(py|go|rb|rs|java|kt|swift)$/i;
const FIX_RE = /\b(fix|fixed|bug|broke|broken|regression|crash|failing|flaky|incorrect|wrong|revert)\b/i;
const FEATURE_RE =
  /\b(add|added|implement|introduce|build|create|support|enable|new|wire up|endpoint|feature)\b/i;

/**
 * Untested changes the record can see: a session that changed code, added no
 * test, and either announced a fix/feature in its title or was distilled into
 * memory (so the change mattered). Deterministic, it reads only what sync
 * stored, and every gap carries the receipt that justifies the work, so the
 * agent is aimed at a real change, never asked to invent one.
 */
export function findRegressionGaps(db: Db, project?: string): RegressionGap[] {
  const rows = db
    .prepare(
      `SELECT s.pk, s.id, s.title, s.files_touched, s.project_path, m.name AS member_name
       FROM sessions s LEFT JOIN members m ON m.id = s.member_id
       WHERE s.visibility = 'team'
       ${project ? 'AND s.project_path = ?' : ''}
       ORDER BY s.updated_at DESC LIMIT 400`,
    )
    .all(...(project ? [project] : [])) as {
    pk: number;
    id: string;
    title: string | null;
    files_touched: string;
    project_path: string;
    member_name: string | null;
  }[];

  // first pass: keep only sessions that changed code without touching a test
  interface Cand {
    r: (typeof rows)[number];
    codeFile: string;
    isFix: boolean;
    isFeature: boolean;
  }
  const cands: Cand[] = [];
  for (const r of rows) {
    const files = JSON.parse(r.files_touched || '[]') as string[];
    const codeFile = files.find((f) => CODE_RE.test(f) && !TEST_RE.test(f));
    const touchedTest = files.some((f) => TEST_RE.test(f));
    if (!codeFile || touchedTest) continue;
    const title = r.title ?? '';
    cands.push({ r, codeFile, isFix: FIX_RE.test(title), isFeature: FEATURE_RE.test(title) });
  }

  // the receipts, in ONE query for every candidate instead of one query per
  // session. /api/overview calls this on every load, so the old per-session
  // lookup was up to 400 queries against memory_notes each time.
  const notesByPk = new Map<number, string[]>();
  if (cands.length > 0) {
    const pks = cands.map((c) => c.r.pk);
    const ph = pks.map(() => '?').join(',');
    for (const row of db
      .prepare(
        `SELECT source_session_pk AS pk, body FROM memory_notes
         WHERE source_session_pk IN (${ph}) AND status = 'current' AND verification != 'retired'`,
      )
      .all(...pks) as { pk: number; body: string }[]) {
      const list = notesByPk.get(row.pk) ?? [];
      if (list.length < 3) list.push(row.body); // the old query's LIMIT 3
      notesByPk.set(row.pk, list);
    }
  }

  const gaps: RegressionGap[] = [];
  const seen = new Set<string>();
  for (const { r, codeFile, isFix, isFeature } of cands) {
    const notes = notesByPk.get(r.pk) ?? [];
    // a change earns a gap if it looks like a fix/feature OR the memory kept it
    if (!isFix && !isFeature && notes.length === 0) continue;

    const key = `${r.project_path}::${codeFile}`;
    if (seen.has(key)) continue; // one gap per file, freshest that qualifies wins
    seen.add(key);

    const title = r.title ?? '';
    const changeKind: ChangeKind = isFix ? 'fix' : isFeature ? 'feature' : 'change';
    const context = [
      `Session "${title}" changed ${codeFile} and added no test.`,
      ...notes.map((n) => `Record: ${n}`),
    ].join('\n');

    gaps.push({
      file: codeFile,
      changeKind,
      sessionId: r.id,
      sessionTitle: title || '(untitled)',
      memberName: r.member_name,
      project: r.project_path,
      context,
    });
  }
  return gaps;
}

export function createWeaverJob(
  db: Db,
  projectPath: string,
  payload: WeaverPayload,
  sourceNoteId?: number,
): WeaverJobRow {
  const now = new Date().toISOString();
  const id = db
    .prepare(
      `INSERT INTO weaver_jobs (project_path, payload, status, source_note_id, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?)`,
    )
    .run(projectPath, JSON.stringify(payload), sourceNoteId ?? null, now, now).lastInsertRowid as number;
  return db.prepare('SELECT * FROM weaver_jobs WHERE id = ?').get(id) as WeaverJobRow;
}

/**
 * The loop closes here. A Weaver PR's fate is a fact about the world: a fix
 * that was merged confirms the change; a fix born from a ruling that gets
 * CLOSED is evidence the ruling may have been wrong, so the note it came from
 * is flagged disputed and returns to the review queue. The record learns from
 * what its own hands produced.
 */
export function resolveWeaverJob(
  db: Db,
  id: number,
  resolution: 'merged' | 'closed',
): { job: WeaverJobRow; reopenedNoteId?: number } | undefined {
  const job = db.prepare('SELECT * FROM weaver_jobs WHERE id = ?').get(id) as WeaverJobRow | undefined;
  if (!job) return undefined;
  db.prepare('UPDATE weaver_jobs SET resolution = ?, updated_at = ? WHERE id = ?').run(
    resolution,
    new Date().toISOString(),
    id,
  );
  let reopenedNoteId: number | undefined;
  if (resolution === 'closed' && job.source_note_id) {
    const note = db
      .prepare("SELECT id, verification FROM memory_notes WHERE id = ? AND verification = 'verified'")
      .get(job.source_note_id) as { id: number } | undefined;
    if (note) {
      db.prepare("UPDATE memory_notes SET verification = 'disputed' WHERE id = ?").run(note.id);
      reopenedNoteId = note.id;
    }
  }
  return {
    job: db.prepare('SELECT * FROM weaver_jobs WHERE id = ?').get(id) as WeaverJobRow,
    reopenedNoteId,
  };
}

/** A claim is a lease, not a deed. A daemon that died mid-weave must not
 * strand the job in 'running' forever, completion only matches the claimer,
 * and claiming only matches 'pending', so without this nothing could ever
 * retry it. */
const CLAIM_LEASE_MS = 30 * 60_000;

export function requeueStaleClaims(db: Db, leaseMs = CLAIM_LEASE_MS): number {
  const cutoff = new Date(Date.now() - leaseMs).toISOString();
  return db
    .prepare(
      `UPDATE weaver_jobs SET status = 'pending', claimed_by = NULL, updated_at = ?
       WHERE status = 'running' AND updated_at < ?`,
    )
    .run(new Date().toISOString(), cutoff).changes;
}

export function listWeaverJobs(db: Db, status?: WeaverJobRow['status']): WeaverJobRow[] {
  if (status === 'pending') requeueStaleClaims(db);
  return (
    status
      ? db.prepare('SELECT * FROM weaver_jobs WHERE status = ? ORDER BY created_at ASC').all(status)
      : db.prepare('SELECT * FROM weaver_jobs ORDER BY created_at DESC LIMIT 100').all()
  ) as WeaverJobRow[];
}

/** True when this call won the job; false when someone else already did. */
export function claimWeaverJob(db: Db, id: number, memberId: number): boolean {
  const res = db
    .prepare(
      `UPDATE weaver_jobs SET status = 'running', claimed_by = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(memberId, new Date().toISOString(), id);
  return res.changes === 1;
}

export function completeWeaverJob(
  db: Db,
  id: number,
  memberId: number,
  outcome: { status: 'done' | 'error'; prUrl?: string; result?: string },
): WeaverJobRow | undefined {
  const res = db
    .prepare(
      `UPDATE weaver_jobs SET status = ?, pr_url = ?, result = ?, updated_at = ?
       WHERE id = ? AND claimed_by = ? AND status = 'running'`,
    )
    .run(
      outcome.status,
      outcome.prUrl ?? null,
      outcome.result ?? null,
      new Date().toISOString(),
      id,
      memberId,
    );
  if (res.changes !== 1) return undefined;
  return db.prepare('SELECT * FROM weaver_jobs WHERE id = ?').get(id) as WeaverJobRow;
}
