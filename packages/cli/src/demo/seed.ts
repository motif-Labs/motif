/**
 * A complete invented team, written straight into a database, no reader ever
 * runs, so `motif demo` cannot touch anyone's real agent history even by
 * accident. Everything here is synthetic, in the same spirit as fixtures/:
 * generic names, /workspace paths, hand-written content.
 *
 * The seed is arranged so every part of the product has something to show:
 * sessions across two tools and three projects, distilled memory with one
 * OPEN CONFLICT and one STALE note for the Review inbox, one human-verified
 * note so recall demonstrates authority ranking, and a recall query that
 * crosses people and tools.
 */
import type { MotifMessage, MotifSession } from '@motif/core';
import { applyNotes, applyVerdict, fullReplaceSession, registerMember, type Db } from '@motif/server';

const DAY = 24 * 3600_000;
const base = Date.now() - 13 * DAY;
/** Deterministic timestamps spread over the last week. */
const at = (day: number, hour: number): string => new Date(base + day * DAY + hour * 3600_000).toISOString();

let seq = 0;
const msg = (role: MotifMessage['role'], text: string, ts: string): MotifMessage => ({
  id: `demo-${++seq}`,
  role,
  timestamp: ts,
  text,
});

interface SeedSession {
  id: string;
  source: 'claude-code' | 'codex';
  member: string;
  project: string;
  files: string[];
  day: number;
  turns: [user: string, assistant: string][];
}

const SESSIONS: SeedSession[] = [
  // ── payments-api, the busy heart, many hands, many decisions ──────────
  {
    id: 'pay-ratelimit',
    source: 'claude-code',
    member: 'ada',
    project: '/workspace/payments-api',
    files: ['src/limiter/bucket.ts', 'docs/adr/014-rate-limiting.md'],
    day: 0,
    turns: [
      [
        'The public API has no rate limiting. Add one that survives a restart, the in-memory attempt reset on every deploy.',
        'Redis token bucket keyed by API key, since several customers sit behind one NAT. 100 req/min, burst 20. State in Redis so a rolling deploy keeps quotas. Recorded in ADR-014.',
      ],
      [
        'What if Redis is down?',
        'Fail open and log loudly, rejecting live payment traffic over a cache outage is worse. ADR-014.',
      ],
    ],
  },
  {
    id: 'pay-authclose',
    source: 'claude-code',
    member: 'ben',
    project: '/workspace/payments-api',
    files: ['src/middleware/auth.ts'],
    day: 1,
    turns: [
      [
        'Auth middleware fails open when the token service times out. That is backwards, make it fail closed.',
        'Flipped to fail closed, with one carve-out: the internal health route stays up so the load balancer does not pull every node on a blip.',
      ],
    ],
  },
  {
    id: 'pay-idempotency',
    source: 'codex',
    member: 'ben',
    project: '/workspace/payments-api',
    files: ['src/routes/payments.ts'],
    day: 2,
    turns: [
      [
        'Add idempotency keys so a retried request cannot double-charge.',
        'Client sends Idempotency-Key; the key and response are stored 24h and replayed on repeat. Body hash is part of the key, so a reused key with different data gets 422.',
      ],
      [
        'Why 24h?',
        'Covers the longest retry window we have seen (a 6h backoff chain) with margin, without growing the table unbounded.',
      ],
    ],
  },
  {
    id: 'pay-doublecharge',
    source: 'claude-code',
    member: 'omar',
    project: '/workspace/payments-api',
    files: ['src/routes/payments.ts'],
    day: 3,
    turns: [
      [
        'Fix the double-charge: a retried request with the same idempotency key still charged twice.',
        'The key was checked AFTER the charge call, not before. Moved the lookup ahead of the charge so a replay short-circuits to the stored response. Verified by hand against the reproduction.',
      ],
    ],
  },
  {
    id: 'pay-breaker',
    source: 'codex',
    member: 'cleo',
    project: '/workspace/payments-api',
    files: ['src/auth/breaker.ts', 'src/middleware/auth.ts'],
    day: 3,
    turns: [
      [
        'Put a circuit breaker in front of the token service so a slow dependency cannot stall every request.',
        'Opens after five consecutive timeouts, half-open probe every ten seconds. While open, auth fails closed. Different blast radius than the limiter, a deliberate policy split.',
      ],
    ],
  },
  {
    id: 'pay-poolleak',
    source: 'claude-code',
    member: 'cleo',
    project: '/workspace/payments-api',
    files: ['src/limiter/bucket.ts', 'src/cache/session.ts'],
    day: 4,
    turns: [
      [
        'Redis connections leak in staging, the pool is exhausted after a few hours.',
        'The limiter constructed a client per request. Moved to a shared pool created at boot; the limiter is on every public route, so a leak there takes the whole API down first.',
      ],
    ],
  },
  {
    id: 'pay-retryafter',
    source: 'claude-code',
    member: 'iris',
    project: '/workspace/payments-api',
    files: ['src/limiter/respond.ts', 'src/limiter/bucket.ts'],
    day: 5,
    turns: [
      [
        'Our 429s go out with no Retry-After, so clients retry immediately and make it worse.',
        'Retry-After now computed from the bucket refill rate, and X-RateLimit-Remaining on every response, the header support keeps asking customers to screenshot.',
      ],
    ],
  },
  {
    id: 'pay-webhookflaky',
    source: 'codex',
    member: 'ada',
    project: '/workspace/payments-api',
    files: ['src/webhooks/deliver.ts', 'test/webhooks.test.ts'],
    day: 6,
    turns: [
      [
        'The checkout webhook test is flaky in CI, passes locally, fails maybe one run in five.',
        'The test asserted delivery attempts before the retry queue drained; it passed locally only because the machine is slower. Replaced the sleep with a wait on queue depth.',
      ],
    ],
  },
  {
    id: 'pay-scoping',
    source: 'claude-code',
    member: 'nora',
    project: '/workspace/payments-api',
    files: ['src/limiter/bucket.ts'],
    day: 8,
    turns: [
      [
        'Enterprise customers hit the 100/min limit during nightly syncs. Add a per-plan override.',
        'Limits now read from the plan: enterprise gets 1000/min, burst 100; everyone else unchanged. Keyed by API key as before, so the NAT case still holds.',
      ],
    ],
  },
  {
    id: 'pay-webhookretry',
    source: 'codex',
    member: 'omar',
    project: '/workspace/payments-api',
    files: ['src/webhooks/deliver.ts'],
    day: 9,
    turns: [
      [
        'Add exponential backoff to webhook delivery, some endpoints are down for minutes.',
        'Backoff 1s → 32s over six attempts, then a dead-letter row. Idempotency-Key travels with each retry so a slow endpoint that finally accepts does not process twice.',
      ],
    ],
  },
  // ── billing-worker, the nightly job, moved to a queue ─────────────────
  {
    id: 'bill-cron',
    source: 'codex',
    member: 'ada',
    project: '/workspace/billing-worker',
    files: ['src/jobs/billing.ts'],
    day: 1,
    turns: [
      [
        'Move the nightly billing job off cron onto the new queue.',
        'Enqueues per-account instead of one giant nightly sweep, so a single failing account no longer blocks the batch. Kept the cron entry for one release as a fallback.',
      ],
    ],
  },
  {
    id: 'bill-partial',
    source: 'claude-code',
    member: 'iris',
    project: '/workspace/billing-worker',
    files: ['src/jobs/billing.ts', 'src/jobs/retry.ts'],
    day: 7,
    turns: [
      [
        'A billing run partially failed and we double-charged three accounts on retry.',
        'The retry re-ran the whole batch instead of the failed accounts. Now each account is its own idempotent unit, keyed like the payments API, a retry only touches what actually failed.',
      ],
    ],
  },
  {
    id: 'bill-timezone',
    source: 'claude-code',
    member: 'ben',
    project: '/workspace/billing-worker',
    files: ['src/jobs/schedule.ts'],
    day: 10,
    turns: [
      [
        'Fix the off-by-one: some accounts billed a day early around DST.',
        'The schedule computed the next run in UTC then displayed local, crossing the DST boundary. Compute in the account’s zone and store UTC, the display was never the source of truth.',
      ],
    ],
  },
  // ── ops-runbooks, the on-call knowledge, sometimes at odds ────────────
  {
    id: 'ops-redis',
    source: 'codex',
    member: 'iris',
    project: '/workspace/ops-runbooks',
    files: ['runbooks/redis-outage.md'],
    day: 5,
    turns: [
      [
        'Write the on-call runbook for a Redis outage.',
        'Documented the split people keep getting wrong: ADR-014 as WRITTEN says the limiter fails CLOSED on a Redis outage, the rate-limiting session remembered it the other way. During an outage expect 429s, not a traffic spike.',
      ],
    ],
  },
  {
    id: 'ops-tokenservice',
    source: 'claude-code',
    member: 'cleo',
    project: '/workspace/ops-runbooks',
    files: ['runbooks/token-service.md'],
    day: 8,
    turns: [
      [
        'Runbook for a token-service outage now that auth fails closed.',
        'If the token service is down, expect 401s, not 500s, the breaker opens and auth fails closed. If you see a traffic spike instead, it is Redis, not the token service. Cross-linked both runbooks.',
      ],
    ],
  },
  // ── web-dashboard, a different corner, its own history ────────────────
  {
    id: 'web-auth',
    source: 'claude-code',
    member: 'nora',
    project: '/workspace/web-dashboard',
    files: ['src/auth/session.ts'],
    day: 2,
    turns: [
      [
        'Sessions log users out after 30 minutes even while active, sliding expiry is broken.',
        'The cookie max-age was set once at login and never refreshed. Now each authenticated request slides it forward, capped at an 8h absolute lifetime.',
      ],
    ],
  },
  {
    id: 'web-charts',
    source: 'codex',
    member: 'omar',
    project: '/workspace/web-dashboard',
    files: ['src/charts/usage.ts'],
    day: 6,
    turns: [
      [
        'Build the usage chart for the billing page, requests per day, per plan.',
        'Server aggregates by day and plan; the client just draws. No per-request fetch, so a customer with millions of calls still loads instantly.',
      ],
    ],
  },
  {
    id: 'web-timezone',
    source: 'claude-code',
    member: 'ada',
    project: '/workspace/web-dashboard',
    files: ['src/charts/usage.ts'],
    day: 11,
    turns: [
      [
        'The usage chart is off by a day for customers outside UTC.',
        'Same class of bug as billing: aggregation bucketed by UTC day, displayed local. Now buckets by the viewer’s zone. Noted the pattern, this is the third timezone bug this month.',
      ],
    ],
  },
];

export { SESSIONS };

export interface DemoMembers {
  byName: Map<string, { memberId: number; memberToken: string; displayName: string }>;
}

export function seedMembers(db: Db): DemoMembers {
  const byName = new Map<string, { memberId: number; memberToken: string; displayName: string }>();
  // The seed keys stay stable ('ada', 'ben', …) so the rest of this file can
  // address a member by a short handle. What a viewer sees on screen is the
  // display name below. The one running the demo can put their own name on the
  // 'you' seat for a recording, without a real name ever entering the repo:
  //   MOTIF_DEMO_ME="Robin (you)" motif demo
  const display: Record<string, string> = {
    ada: 'Maya',
    ben: 'Leo',
    cleo: 'Priya',
    iris: 'Sofia',
    omar: 'Diego',
    nora: 'Nina',
    you: process.env.MOTIF_DEMO_ME?.trim() || 'you',
  };
  for (const [key, name] of Object.entries(display)) {
    const reg = registerMember(db, { name, email: `${key}@example.com` });
    byName.set(key, { ...reg, displayName: name });
  }
  return { byName };
}

export function insertSession(db: Db, members: DemoMembers, s: SeedSession): void {
  const started = at(s.day, 10);
  const messages: MotifMessage[] = [];
  for (const [user, assistant] of s.turns) {
    messages.push(msg('user', user, at(s.day, 10)));
    messages.push(msg('assistant', assistant, at(s.day, 11)));
  }
  const session: MotifSession = {
    id: `${s.source}:${s.id}`,
    source: s.source,
    sourceSessionId: s.id,
    sourcePath: `/workspace/.demo/${s.id}.jsonl`,
    projectPath: s.project,
    gitBranch: 'main',
    title: s.turns[0]![0],
    createdAt: started,
    updatedAt: at(s.day, 12),
    messages,
    filesTouched: s.files,
    meta: { subagentCount: 0, branchCount: 0, parseErrors: 0 },
  };
  fullReplaceSession(db, members.byName.get(s.member)!.memberId, session);
}

const sessionPk = (db: Db, id: string): number =>
  (db.prepare('SELECT pk FROM sessions WHERE source_session_id = ?').get(id) as { pk: number }).pk;

/** The verified note and the stale one, quiet background for recall. */
export function seedBackgroundMemory(db: Db, members: DemoMembers): void {
  const ada = members.byName.get('ada')!.memberId;
  const ben = members.byName.get('ben')!.memberId;
  const iris = members.byName.get('iris')!.memberId;
  const PAY = '/workspace/payments-api';
  const put = (
    session: string,
    member: number,
    project: string,
    notes: { kind: 'decision' | 'file' | 'topic'; name: string; aspect: string; body: string }[],
  ) =>
    applyNotes(
      db,
      notes.map((n) => ({ entity: { kind: n.kind, name: n.name }, aspect: n.aspect, body: n.body })),
      { projectPath: project, sessionPk: sessionPk(db, session), memberId: member },
    );

  // idempotency, a decision AND the file it lives in, from one session:
  // co-occurrence links them in the Weave. Then a human vouches for it.
  put('pay-idempotency', ben, PAY, [
    {
      kind: 'decision',
      name: 'idempotency keys',
      aspect: 'behaviour',
      body: 'Payment retries replay the stored response for 24h; a reused key with a different body gets a 422.',
    },
    {
      kind: 'file',
      name: 'src/routes/payments.ts',
      aspect: 'design',
      body: 'The idempotency lookup must run BEFORE the charge call, or a replay double-charges.',
    },
  ]);
  const idem = db.prepare("SELECT id FROM memory_notes WHERE body LIKE '%422%'").get() as { id: number };
  applyVerdict(db, { noteId: idem.id, reviewerId: ben, verdict: 'confirm' });

  // the recurring timezone lesson, a topic tying three files across projects
  put('web-timezone', ada, '/workspace/web-dashboard', [
    {
      kind: 'topic',
      name: 'timezone bugs',
      aspect: 'pattern',
      body: 'Aggregate/schedule in the viewer or account zone, store UTC. Display is never the source of truth, third such bug this month.',
    },
    {
      kind: 'file',
      name: 'src/charts/usage.ts',
      aspect: 'design',
      body: 'Buckets usage by the viewer’s zone, not UTC.',
    },
  ]);

  // the breaker/auth policy split, a decision touching two files
  put('pay-breaker', members.byName.get('cleo')!.memberId, PAY, [
    {
      kind: 'decision',
      name: 'auth failure policy',
      aspect: 'behaviour',
      body: 'Auth fails CLOSED: the breaker opens after five timeouts, and a token-service outage yields 401s, not a traffic spike.',
    },
    {
      kind: 'file',
      name: 'src/auth/breaker.ts',
      aspect: 'design',
      body: 'Opens after five consecutive timeouts; half-open probe every 10s.',
    },
  ]);

  // a note that will read as possibly stale, its file was reworked since
  put('pay-ratelimit', ada, PAY, [
    {
      kind: 'file',
      name: 'src/limiter/bucket.ts',
      aspect: 'design',
      body: 'One Redis client per request keeps the bucket simple; connection churn is negligible.',
    },
  ]);
  // Mark it stale deterministically. markStaleNotes' heuristic compares the
  // wall-clock created_at of notes made in the same run, and a coarse-resolution
  // clock (Windows is ~15ms) ties them, so the demo's stale note appeared only on
  // some platforms. The demo just needs to SHOW one, so set it directly.
  db.prepare(
    `UPDATE memory_notes SET stale = 1,
            stale_reason = 'later sessions reworked its source file and produced no newer note'
     WHERE body LIKE 'One Redis client per request%'
       AND entity_id = (SELECT id FROM memory_entities
                        WHERE kind = 'file' AND name = 'src/limiter/bucket.ts' AND project_path = ?)`,
  ).run(PAY);

  const cleo = members.byName.get('cleo')!.memberId;
  const omar = members.byName.get('omar')!.memberId;
  const nora = members.byName.get('nora')!.memberId;

  // Every real session left a mark. Each of these ties a decision or file to a
  // topic that spans projects, so the Weave fills with co-occurrence edges the
  // way a real fortnight of work would.
  put('pay-ratelimit', ada, PAY, [
    {
      kind: 'decision',
      name: 'rate limiting',
      aspect: 'design',
      body: 'Redis token bucket keyed by API key, not IP: several customers share one NAT. 100 req/min, burst 20, state in Redis so a deploy keeps quotas.',
    },
    {
      kind: 'topic',
      name: 'redis dependency',
      aspect: 'risk',
      body: 'The limiter sits on every public route, so anything Redis-shaped there is a whole-API risk.',
    },
  ]);
  put('pay-poolleak', cleo, PAY, [
    {
      kind: 'file',
      name: 'src/limiter/bucket.ts',
      aspect: 'incident',
      body: 'A client-per-request leak exhausted the pool in staging; moved to a shared pool at boot.',
    },
    {
      kind: 'topic',
      name: 'redis dependency',
      aspect: 'risk',
      body: 'Connection lifecycle on the limiter path is load-bearing; a leak here takes the API down first.',
    },
  ]);
  put('pay-retryafter', iris, PAY, [
    {
      kind: 'file',
      name: 'src/limiter/respond.ts',
      aspect: 'design',
      body: 'Retry-After is computed from the bucket refill rate; X-RateLimit-Remaining on every response.',
    },
    {
      kind: 'decision',
      name: 'rate limiting',
      aspect: 'client contract',
      body: 'Clients get a real Retry-After, not a guess, so a rate-limited client backs off correctly.',
    },
  ]);
  put('pay-scoping', nora, PAY, [
    {
      kind: 'decision',
      name: 'rate limiting',
      aspect: 'per-plan',
      body: 'Enterprise plans read a 1000/min, burst-100 override; keyed by API key so the NAT case still holds.',
    },
  ]);
  put('pay-webhookflaky', ada, PAY, [
    {
      kind: 'file',
      name: 'src/webhooks/deliver.ts',
      aspect: 'test',
      body: 'The flaky CI test asserted before the retry queue drained; now waits on queue depth.',
    },
    {
      kind: 'topic',
      name: 'idempotency pattern',
      aspect: 'delivery',
      body: 'Webhook retries must be idempotent, same lesson as payments.',
    },
  ]);
  put('pay-webhookretry', omar, PAY, [
    {
      kind: 'file',
      name: 'src/webhooks/deliver.ts',
      aspect: 'design',
      body: 'Backoff 1s to 32s over six attempts, then a dead-letter row; the Idempotency-Key travels with each retry.',
    },
    {
      kind: 'decision',
      name: 'idempotency keys',
      aspect: 'delivery',
      body: 'A slow endpoint that finally accepts a retried webhook must not process it twice.',
    },
  ]);
  put('pay-doublecharge', omar, PAY, [
    {
      kind: 'topic',
      name: 'idempotency pattern',
      aspect: 'incident',
      body: 'The double-charge came from checking the key AFTER the charge; the pattern is check-before-act.',
    },
  ]);
  put('bill-cron', ada, '/workspace/billing-worker', [
    {
      kind: 'decision',
      name: 'billing queue',
      aspect: 'design',
      body: 'Nightly billing enqueues per-account, not one sweep, so one failing account no longer blocks the batch.',
    },
  ]);
  put('bill-partial', iris, '/workspace/billing-worker', [
    {
      kind: 'topic',
      name: 'idempotency pattern',
      aspect: 'billing',
      body: 'A partial billing run double-charged on retry; each account is now its own idempotent unit, keyed like payments.',
    },
    {
      kind: 'decision',
      name: 'billing queue',
      aspect: 'retry',
      body: 'A retry touches only the accounts that actually failed, never the whole batch.',
    },
  ]);
  put('bill-timezone', ben, '/workspace/billing-worker', [
    {
      kind: 'topic',
      name: 'timezone bugs',
      aspect: 'billing',
      body: 'A DST off-by-one billed accounts a day early; compute in the account zone, store UTC.',
    },
    {
      kind: 'file',
      name: 'src/jobs/schedule.ts',
      aspect: 'design',
      body: 'Next-run computed in the account’s zone; UTC is stored, display is never the source of truth.',
    },
  ]);
  put('ops-tokenservice', cleo, '/workspace/ops-runbooks', [
    {
      kind: 'decision',
      name: 'auth failure policy',
      aspect: 'on-call',
      body: 'Token-service outage yields 401s, not a traffic spike; if you see a spike, it is Redis, not the token service.',
    },
    {
      kind: 'topic',
      name: 'redis dependency',
      aspect: 'on-call',
      body: 'The two outages present differently: Redis is a 429 spike, token service is 401s.',
    },
  ]);
  put('web-auth', nora, '/workspace/web-dashboard', [
    {
      kind: 'decision',
      name: 'session expiry',
      aspect: 'behaviour',
      body: 'Sliding expiry refreshes the cookie on each request, capped at an 8h absolute lifetime.',
    },
    {
      kind: 'file',
      name: 'src/auth/session.ts',
      aspect: 'design',
      body: 'Cookie max-age slides forward per request; absolute cap prevents an eternal session.',
    },
  ]);
  put('web-charts', omar, '/workspace/web-dashboard', [
    {
      kind: 'file',
      name: 'src/charts/usage.ts',
      aspect: 'design',
      body: 'Server aggregates usage by day and plan; the client only draws, so millions of calls still load instantly.',
    },
  ]);
}

/** Handoff lineage: work that moved from one tool to another, drawing the
 * 'continues' edges that make the graph a real timeline, not just a snapshot. */
export function seedHandoffs(db: Db, members: DemoMembers): void {
  const link = (fromSession: string, toSession: string, member: number, target: string) => {
    const fromPk = sessionPk(db, fromSession);
    const to = db
      .prepare('SELECT source_session_id FROM sessions WHERE source_session_id = ?')
      .get(toSession) as { source_session_id: string } | undefined;
    if (!to) return;
    db.prepare(
      `INSERT INTO handoffs (session_pk, member_id, target, target_session_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(fromPk, member, target, toSession, new Date().toISOString());
  };
  const ben = members.byName.get('ben')!.memberId;
  const iris = members.byName.get('iris')!.memberId;
  const omar = members.byName.get('omar')!.memberId;
  // the auth work moved Claude Code -> Codex to add the breaker
  link('pay-authclose', 'pay-breaker', ben, 'codex');
  // the rate-limit runbook picked up where the fix left off
  link('pay-ratelimit', 'ops-redis', iris, 'codex');
  // the double-charge fix continued into the webhook retry hardening
  link('pay-doublecharge', 'pay-webhookretry', omar, 'codex');
}

/** A second live disagreement, so the Review queue and the graph both show that
 * a real team holds more than one open question at a time. */
export function seedSecondConflict(db: Db, members: DemoMembers): void {
  const iris = members.byName.get('iris')!.memberId;
  const omar = members.byName.get('omar')!.memberId;
  applyNotes(
    db,
    [
      {
        entity: { kind: 'decision', name: 'billing retry strategy' },
        aspect: 'behaviour',
        body: 'On a partial failure, re-run the whole nightly batch; simpler to reason about.',
      },
    ],
    { projectPath: '/workspace/billing-worker', sessionPk: sessionPk(db, 'bill-cron'), memberId: iris },
  );
  applyNotes(
    db,
    [
      {
        entity: { kind: 'decision', name: 'billing retry strategy' },
        aspect: 'behaviour',
        body: 'Never re-run the whole batch, that is what double-charged three accounts. Retry only the failed, idempotent units.',
        contradictsCurrent: true,
      },
    ],
    { projectPath: '/workspace/billing-worker', sessionPk: sessionPk(db, 'bill-partial'), memberId: omar },
  );
}

/** The star of the show: two sessions remember ADR-014 in opposite directions. */
export function seedConflict(db: Db, members: DemoMembers): { standingId: number; challengerId: number } {
  const ada = members.byName.get('ada')!.memberId;
  const iris = members.byName.get('iris')!.memberId;
  applyNotes(
    db,
    [
      {
        entity: { kind: 'decision', name: 'redis outage policy' },
        aspect: 'limiter behaviour',
        body: 'The limiter fails open when Redis is unreachable, rejecting payments over a cache is worse. (ADR-014)',
      },
    ],
    { projectPath: '/workspace/payments-api', sessionPk: sessionPk(db, 'pay-ratelimit'), memberId: ada },
  );
  applyNotes(
    db,
    [
      {
        entity: { kind: 'decision', name: 'redis outage policy' },
        aspect: 'limiter behaviour',
        body: 'ADR-014 as written says fail CLOSED when Redis is unreachable; the rate-limiting session mis-stated it.',
        contradictsCurrent: true,
      },
    ],
    { projectPath: '/workspace/payments-api', sessionPk: sessionPk(db, 'ops-redis'), memberId: iris },
  );
  const rows = db
    .prepare(
      `SELECT id, status FROM memory_notes WHERE entity_id =
         (SELECT id FROM memory_entities WHERE name = 'redis outage policy') ORDER BY id`,
    )
    .all() as { id: number; status: string }[];
  return {
    standingId: rows.find((r) => r.status === 'current')!.id,
    challengerId: rows.find((r) => r.status === 'conflicted')!.id,
  };
}

export interface DemoSeedResult {
  members: { name: string; token: string }[];
  sessions: number;
  reviewItems: number;
}

export function seedDemo(db: Db): DemoSeedResult {
  const members = seedMembers(db);
  for (const sd of SESSIONS) insertSession(db, members, sd);
  seedBackgroundMemory(db, members);
  seedHandoffs(db, members);
  seedSecondConflict(db, members);
  seedConflict(db, members);

  const reviewItems = db
    .prepare("SELECT COUNT(*) AS n FROM memory_notes WHERE status = 'conflicted'")
    .get() as { n: number };

  return {
    members: [...members.byName.entries()].map(([name, m]) => ({ name, token: m.memberToken })),
    sessions: SESSIONS.length,
    reviewItems: reviewItems.n,
  };
}
