/**
 * How much a claim can be trusted, as one number. A labs-grade memory does not
 * hide uncertainty — it shows it. Confidence rises with corroboration (other
 * sessions that reached the same entity) and a human's vouch; it falls with
 * conflict, dispute, staleness and age. Deterministic and cheap: it reads only
 * columns the record already keeps, so recall and the UI compute the same value.
 */
import type { Db } from '../db/database.js';

export interface NoteSignals {
  status: string;
  verification: string;
  stale: number;
  createdAt: string;
  /** How many distinct sessions produced a current note on the same entity. */
  support: number;
}

const DAY = 86_400_000;

/** 1.0 fresh, decaying to ~0.4 over ~120 days — old knowledge is not wrong, just less certain. */
export function freshness(createdAt: string, now = Date.now()): number {
  const age = Math.max(0, now - Date.parse(createdAt)) / DAY;
  return 0.4 + 0.6 * Math.exp(-age / 120);
}

/** 0..1. The single trust number every surface agrees on. */
export function confidence(s: NoteSignals, now = Date.now()): number {
  let c = 0.55;
  if (s.verification === 'verified') c += 0.3;
  if (s.verification === 'disputed') c -= 0.25;
  if (s.status === 'conflicted') c -= 0.3;
  if (s.stale) c -= 0.2;
  c += Math.min(0.2, Math.max(0, s.support - 1) * 0.07); // corroboration
  c *= 0.7 + 0.3 * freshness(s.createdAt, now); // age tempers, never zeroes
  return Math.max(0.05, Math.min(1, c));
}

/** Support counts per entity in one query, so callers avoid an N+1. */
export function supportByEntity(db: Db, project?: string): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT n.entity_id AS id, COUNT(DISTINCT n.source_session_pk) AS support
       FROM memory_notes n ${project ? 'JOIN memory_entities e ON e.id = n.entity_id' : ''}
       WHERE n.status = 'current' AND n.verification != 'retired'
       ${project ? 'AND e.project_path = ?' : ''}
       GROUP BY n.entity_id`,
    )
    .all(...(project ? [project] : [])) as { id: number; support: number }[];
  return new Map(rows.map((r) => [r.id, r.support]));
}

export function confidenceLabel(c: number): string {
  return c >= 0.75 ? 'high' : c >= 0.5 ? 'medium' : 'low';
}
