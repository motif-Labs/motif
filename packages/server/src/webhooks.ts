/**
 * One URL, told two kinds of things: a new conflict the moment memory catches
 * it, and a daily summary while anything still waits for a ruling. The payload
 * carries a plain-text `text` field, so a Slack incoming webhook renders it
 * as-is; other receivers get the structured fields next to it.
 *
 * Delivery is fire-and-forget with a short timeout. A webhook that is down
 * must never slow the server or wedge a queue — a missed ping costs a day,
 * not a feature.
 */
import type { Db } from './db/database.js';
import type { LiveBus } from './live/bus.js';
import { listReviewQueue } from './memory/review.js';

export interface WebhookOptions {
  /** How often the open-queue digest fires. Default: daily. */
  digestMs?: number;
  log?: (msg: string) => void;
}

function post(url: string, payload: Record<string, unknown>, log?: (m: string) => void): void {
  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  }).catch((err) => log?.(`webhook: delivery failed: ${String(err).slice(0, 120)}`));
}

export function startWebhooks(
  db: Db,
  bus: LiveBus,
  url: string,
  opts: WebhookOptions = {},
): { stop: () => void } {
  const unsubscribe = bus.subscribe((e) => {
    if (e.event === 'memory-conflict') {
      const d = e.data as { entity: string; aspect: string };
      post(
        url,
        {
          text: `⚖️ Motif: two sessions disagree about “${d.entity} · ${d.aspect}”. Agents see both sides until someone rules — dashboard → Review.`,
          event: 'memory-conflict',
          entity: d.entity,
          aspect: d.aspect,
          at: new Date().toISOString(),
        },
        opts.log,
      );
    }
    if (e.event === 'weaver-completed') {
      const d = e.data as { jobId: number; status: string; prUrl?: string };
      if (d.prUrl) {
        post(
          url,
          {
            text: `🧵 Motif: the Weaver aligned the repo with a ruling — draft PR ready: ${d.prUrl}`,
            event: 'weaver-completed',
            jobId: d.jobId,
            prUrl: d.prUrl,
            at: new Date().toISOString(),
          },
          opts.log,
        );
      }
    }
    if (e.event === 'memory-reviewed') {
      const d = e.data as { noteId: number; verdict: string };
      post(
        url,
        {
          text: `✅ Motif: a ruling landed — note #${d.noteId}: ${d.verdict}. The record keeps who and why.`,
          event: 'memory-reviewed',
          noteId: d.noteId,
          verdict: d.verdict,
          at: new Date().toISOString(),
        },
        opts.log,
      );
    }
  });

  const digest = (): void => {
    const items = listReviewQueue(db, undefined);
    if (items.length === 0) return; // a quiet queue earns a quiet channel
    const conflicts = items.filter((i) => i.type === 'conflict').length;
    const stale = items.filter((i) => i.type === 'stale').length;
    const disputed = items.length - conflicts - stale;
    const parts = [
      conflicts && `${conflicts} conflict(s)`,
      stale && `${stale} stale note(s)`,
      disputed && `${disputed} disputed`,
    ].filter(Boolean);
    post(
      url,
      {
        text: `🧵 Motif review queue: ${parts.join(', ')} waiting for a ruling — dashboard → Review.`,
        event: 'review-digest',
        conflicts,
        stale,
        disputed,
        at: new Date().toISOString(),
      },
      opts.log,
    );
  };
  const timer = setInterval(digest, opts.digestMs ?? 24 * 3600_000);
  timer.unref();

  return {
    stop: () => {
      unsubscribe();
      clearInterval(timer);
    },
  };
}
