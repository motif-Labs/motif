/**
 * A complete invented team, written straight into a database — no reader ever
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
const base = Date.now() - 6 * DAY;
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
  {
    id: 'demo-rate-limit',
    source: 'claude-code',
    member: 'ada',
    project: '/workspace/payments-api',
    files: ['src/limiter/bucket.ts', 'docs/adr/014-rate-limiting.md'],
    day: 0,
    turns: [
      [
        'The public API has no rate limiting. Add one, but it has to survive a restart — the last in-memory attempt reset every deploy.',
        'Went with a Redis token bucket keyed by API key rather than IP, since several customers sit behind one NAT. 100 req/min sustained, burst of 20. State lives in Redis so a rolling deploy does not hand everyone a fresh quota.',
      ],
      [
        'What happens if Redis is down?',
        'Fail open, and log loudly. Rejecting live payment traffic because a cache is unreachable is worse than briefly serving unlimited requests. Decision recorded in ADR-014.',
      ],
    ],
  },
  {
    id: 'demo-auth-closed',
    source: 'claude-code',
    member: 'ben',
    project: '/workspace/payments-api',
    files: ['src/middleware/auth.ts'],
    day: 1,
    turns: [
      [
        'Auth middleware fails open when the token service times out. That is backwards — make it fail closed.',
        'Flipped it to fail closed, with one carve-out: the internal health route keeps working so the load balancer does not pull every node when the token service blips.',
      ],
    ],
  },
  {
    id: 'demo-runbook',
    source: 'codex',
    member: 'iris',
    project: '/workspace/ops-runbooks',
    files: ['runbooks/redis-outage.md'],
    day: 2,
    turns: [
      [
        'Write the on-call runbook for a Redis outage.',
        'Documented the split people keep getting wrong on call: ADR-014 as written says the limiter fails CLOSED when Redis is unreachable — the earlier session remembered it the other way around. During an outage expect 429s, not a traffic spike.',
      ],
    ],
  },
  {
    id: 'demo-breaker',
    source: 'codex',
    member: 'cleo',
    project: '/workspace/payments-api',
    files: ['src/auth/breaker.ts'],
    day: 2,
    turns: [
      [
        'Put a circuit breaker in front of the token service so a slow dependency cannot stall every request.',
        'Opens after five consecutive timeouts, half-open probe every ten seconds. While the breaker is open, auth fails closed. Different blast radius than the limiter — that is a policy split worth keeping deliberate.',
      ],
    ],
  },
  {
    id: 'demo-idempotency',
    source: 'codex',
    member: 'ben',
    project: '/workspace/payments-api',
    files: ['src/routes/payments.ts'],
    day: 3,
    turns: [
      [
        'Add idempotency keys to the payment endpoint so a retried request cannot double-charge.',
        'Client sends Idempotency-Key; the key and response are stored for 24h and replayed on a repeat. The request body hash is part of the key, so reusing a key with different data gets a 422 instead of the old response.',
      ],
    ],
  },
  {
    id: 'demo-pool-leak',
    source: 'claude-code',
    member: 'cleo',
    project: '/workspace/payments-api',
    files: ['src/limiter/bucket.ts', 'src/cache/session.ts'],
    day: 3,
    turns: [
      [
        'Redis connections leak in staging — the pool is exhausted after a few hours.',
        'The rate limiter was constructing a client per request. Moved it to a shared pool created at boot; the limiter sits on every public route, so a leak there takes the whole API down first.',
      ],
    ],
  },
  {
    id: 'demo-retry-after',
    source: 'claude-code',
    member: 'iris',
    project: '/workspace/payments-api',
    files: ['src/limiter/respond.ts', 'src/limiter/bucket.ts'],
    day: 4,
    turns: [
      [
        'Our 429s go out with no Retry-After, so clients retry immediately and make it worse.',
        'Retry-After is now computed from the bucket refill rate, and X-RateLimit-Remaining is on every response — that header is what support keeps asking customers to screenshot.',
      ],
    ],
  },
  {
    id: 'demo-billing',
    source: 'codex',
    member: 'ada',
    project: '/workspace/billing-worker',
    files: ['src/jobs/billing.ts'],
    day: 5,
    turns: [
      [
        'Move the nightly billing job off cron onto the new queue.',
        'The job now enqueues per-account instead of one giant nightly sweep, so a single failing account no longer blocks the batch. The cron entry stays for one release as a fallback.',
      ],
    ],
  },
  {
    id: 'demo-bucket-tune',
    source: 'claude-code',
    member: 'ben',
    project: '/workspace/payments-api',
    files: ['src/limiter/bucket.ts'],
    day: 5,
    turns: [
      [
        'The burst allowance feels too tight for the mobile clients — they batch on reconnect.',
        'Raised burst to 30 for authenticated mobile keys only; the sustained rate is unchanged. Watching the 429 rate for a week before deciding whether it sticks.',
      ],
    ],
  },
];

export interface DemoSeedResult {
  members: { name: string; token: string }[];
  sessions: number;
  reviewItems: number;
}

export function seedDemo(db: Db): DemoSeedResult {
  const members = new Map<string, { memberId: number; memberToken: string }>();
  for (const name of ['ada', 'ben', 'cleo', 'iris']) {
    members.set(name, registerMember(db, { name, email: `${name}@example.com` }));
  }

  for (const s of SESSIONS) {
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
    fullReplaceSession(db, members.get(s.member)!.memberId, session);
  }

  const pk = (id: string): number =>
    (db.prepare('SELECT pk FROM sessions WHERE source_session_id = ?').get(id) as { pk: number }).pk;

  // ── distilled memory: enough for recall, Review and authority ranking ─────
  const ada = members.get('ada')!.memberId;
  const iris = members.get('iris')!.memberId;
  const ben = members.get('ben')!.memberId;

  // a clean, current claim — and a human vouches for it, so recall shows rank
  applyNotes(
    db,
    [
      {
        entity: { kind: 'decision', name: 'idempotency keys' },
        aspect: 'behaviour',
        body: 'Payment retries replay the stored response for 24h; a reused key with a different body gets a 422.',
      },
    ],
    { projectPath: '/workspace/payments-api', sessionPk: pk('demo-idempotency'), memberId: ben },
  );
  const idem = db.prepare("SELECT id FROM memory_notes WHERE body LIKE '%422%'").get() as { id: number };
  applyVerdict(db, { noteId: idem.id, reviewerId: ben, verdict: 'confirm' });

  // the OPEN CONFLICT the Review inbox exists for: two sessions remember
  // ADR-014 in opposite directions, and nobody has ruled yet
  applyNotes(
    db,
    [
      {
        entity: { kind: 'decision', name: 'redis outage policy' },
        aspect: 'limiter behaviour',
        body: 'The limiter fails open when Redis is unreachable — rejecting payments over a cache is worse. (ADR-014)',
      },
    ],
    { projectPath: '/workspace/payments-api', sessionPk: pk('demo-rate-limit'), memberId: ada },
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
    { projectPath: '/workspace/payments-api', sessionPk: pk('demo-runbook'), memberId: iris },
  );

  // a claim whose ground moved: three later sessions reworked bucket.ts and
  // nothing refreshed the entity — the queue raises it as possibly stale
  applyNotes(
    db,
    [
      {
        entity: { kind: 'file', name: 'src/limiter/bucket.ts' },
        aspect: 'design',
        body: 'One Redis client per request keeps the bucket simple; connection churn is negligible.',
      },
    ],
    { projectPath: '/workspace/payments-api', sessionPk: pk('demo-rate-limit'), memberId: ada },
  );

  const reviewItems = db
    .prepare("SELECT COUNT(*) AS n FROM memory_notes WHERE status = 'conflicted'")
    .get() as { n: number };

  return {
    members: [...members.entries()].map(([name, m]) => ({ name, token: m.memberToken })),
    sessions: SESSIONS.length,
    reviewItems: reviewItems.n,
  };
}
