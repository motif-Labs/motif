/**
 * The Weaver's queue. When a ruling lands on team memory, the repository may
 * still say what the losing claim said — an ADR, a comment, a README. The
 * server cannot fix that (it has no checkout and runs no agent), so it queues
 * the work: a daemon with the project on disk and the owner's explicit opt-in
 * claims the job, weaves the change in a throwaway worktree, and reports the
 * draft PR back.
 *
 * Claiming is atomic — two daemons cannot take the same job — and a job born
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
 * session with no test to hold it. The context travels WITH the job — the
 * session's own summary and the files it touched — so the agent writes the
 * test instead of spelunking the whole tree for it. That is the point: the
 * work is aimed, not exploratory, and cheap because of it. */
export interface GapPayload {
  kind: 'missing-regression';
  file: string;
  sessionId: string;
  sessionTitle: string;
  memberName: string | null;
  /** The distilled note(s) about this file — what the change was and why. */
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
  created_at: string;
  updated_at: string;
}

export interface RegressionGap {
  file: string;
  sessionId: string;
  sessionTitle: string;
  memberName: string | null;
  project: string;
  context: string;
}

const TEST_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$/i;
const CODE_RE = /\.[jt]sx?$|\.(py|go|rb|rs|java|kt|swift)$/i;
const FIX_RE = /\b(fix|bug|broke|broken|regression|crash|failing|flaky|incorrect|wrong)\b/i;

/** Sessions that changed code, left no test, and whose work the memory thought
 * worth recording — the shape of an untested fix. Deterministic: it reads only
 * what sync already stored, and each gap carries the receipt that justifies it. */
export function findRegressionGaps(db: Db, project?: string): RegressionGap[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.title, s.files_touched, s.project_path, m.name AS member_name
       FROM sessions s LEFT JOIN members m ON m.id = s.member_id
       WHERE s.visibility = 'team'
       ${project ? 'AND s.project_path = ?' : ''}
       ORDER BY s.updated_at DESC LIMIT 400`,
    )
    .all(...(project ? [project] : [])) as {
    id: string;
    title: string | null;
    files_touched: string;
    project_path: string;
    member_name: string | null;
  }[];

  const gaps: RegressionGap[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const files = JSON.parse(r.files_touched || '[]') as string[];
    const looksLikeFix = FIX_RE.test(r.title ?? '');
    const touchedCode = files.some((f) => CODE_RE.test(f) && !TEST_RE.test(f));
    const touchedTest = files.some((f) => TEST_RE.test(f));
    if (!looksLikeFix || !touchedCode || touchedTest) continue;

    const codeFile = files.find((f) => CODE_RE.test(f) && !TEST_RE.test(f))!;
    const key = `${r.project_path}::${codeFile}`;
    if (seen.has(key)) continue; // one gap per file, freshest wins
    seen.add(key);

    // the receipt: what the record already knows about this file
    const notes = db
      .prepare(
        `SELECT n.body FROM memory_notes n JOIN memory_entities e ON e.id = n.entity_id
         WHERE e.name = ? AND e.project_path = ? AND n.status = 'current' AND n.verification != 'retired' LIMIT 3`,
      )
      .all(codeFile.replace(/^.*?([^/]+\/[^/]+)$/, '$1'), r.project_path) as { body: string }[];
    const context = [
      `Session "${r.title}" changed ${codeFile} and added no test.`,
      ...notes.map((n) => `Record: ${n.body}`),
    ].join('\n');

    gaps.push({
      file: codeFile,
      sessionId: r.id,
      sessionTitle: r.title ?? '(untitled)',
      memberName: r.member_name,
      project: r.project_path,
      context,
    });
  }
  return gaps;
}

export function createWeaverJob(db: Db, projectPath: string, payload: WeaverPayload): WeaverJobRow {
  const now = new Date().toISOString();
  const id = db
    .prepare(
      `INSERT INTO weaver_jobs (project_path, payload, status, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?)`,
    )
    .run(projectPath, JSON.stringify(payload), now, now).lastInsertRowid as number;
  return db.prepare('SELECT * FROM weaver_jobs WHERE id = ?').get(id) as WeaverJobRow;
}

/** A claim is a lease, not a deed. A daemon that died mid-weave must not
 * strand the job in 'running' forever — completion only matches the claimer,
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
