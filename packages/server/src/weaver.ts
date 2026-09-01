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

export interface WeaverPayload {
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
