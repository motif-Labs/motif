// Writes synthetic agent sessions in the real on-disk formats, so `scripts/demo.sh`
// can populate a dashboard without touching anybody's actual history.
//
//   node scripts/seed-sessions.mjs <claude-dir> <codex-home> <ada|ben>
//
// Everything here is invented. The files it produces are read back by the same
// readers Motif uses on a real machine — nothing writes to the database directly.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [claudeDir, codexHome, who] = process.argv.slice(2);
if (!claudeDir || !codexHome || !who) {
  console.error('usage: node scripts/seed-sessions.mjs <claude-dir> <codex-home> <ada|ben>');
  process.exit(1);
}

const uuid = () => crypto.randomUUID();
const mangle = (p) => p.replace(/[/.]/g, '-');
const HOUR = 3600_000;

/** Minutes-ago timestamps, so the dashboard shows a plausible recent week. */
let clock = Date.now() - 26 * HOUR;
const tick = (ms = 90_000) => new Date((clock += ms)).toISOString();

// ── Claude Code: newline-delimited JSON, each line linked by parentUuid ──────
function writeClaudeSession({ cwd, turns }) {
  const sessionId = uuid();
  const dir = path.join(claudeDir, 'projects', mangle(cwd));
  fs.mkdirSync(dir, { recursive: true });

  let parentUuid = null;
  const lines = [];
  const push = (type, message) => {
    const id = uuid();
    lines.push({
      parentUuid,
      sessionId,
      uuid: id,
      timestamp: tick(),
      type,
      cwd,
      version: '2.1.250',
      message,
    });
    parentUuid = id;
  };

  for (const turn of turns) {
    push('user', { role: 'user', content: turn.user });
    if (turn.tool) {
      const toolId = `toolu_${crypto.randomBytes(8).toString('hex')}`;
      push('assistant', {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [
          { type: 'text', text: turn.thought ?? 'Let me look at that file.' },
          { type: 'tool_use', id: toolId, name: turn.tool.name, input: turn.tool.input },
        ],
      });
      push('user', {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolId, content: turn.tool.result }],
      });
    }
    push('assistant', { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: turn.assistant }] });
  }

  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return sessionId;
}

// ── Codex: rollout file under sessions/YYYY/MM/DD, one envelope per line ─────
function writeCodexSession({ cwd, turns }) {
  const sessionId = uuid();
  const started = new Date(clock);
  const day = started.toISOString().slice(0, 10).split('-');
  const dir = path.join(codexHome, 'sessions', ...day);
  fs.mkdirSync(dir, { recursive: true });

  let ordinal = 0;
  const lines = [];
  const push = (type, payload) => lines.push({ timestamp: tick(), ordinal: ordinal++, type, payload });

  push('session_meta', {
    session_id: sessionId,
    id: sessionId,
    timestamp: started.toISOString(),
    cwd,
    originator: 'codex_cli_rs',
    cli_version: '0.150.1',
    source: 'interactive',
    model_provider: 'openai',
  });
  for (const turn of turns) {
    push('response_item', {
      type: 'message',
      id: `msg_${uuid()}`,
      role: 'user',
      content: [{ type: 'input_text', text: turn.user }],
    });
    if (turn.tool) {
      push('response_item', {
        type: 'function_call',
        id: `fc_${uuid()}`,
        name: turn.tool.name,
        arguments: JSON.stringify(turn.tool.input),
        call_id: 'call_1',
      });
      push('response_item', { type: 'function_call_output', call_id: 'call_1', output: turn.tool.result });
    }
    push('response_item', {
      type: 'message',
      id: `msg_${uuid()}`,
      role: 'assistant',
      content: [{ type: 'output_text', text: turn.assistant }],
    });
  }

  const stamp = started.toISOString().slice(0, 19).replace(/[:]/g, '-');
  fs.writeFileSync(path.join(dir, `rollout-${stamp}-${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return sessionId;
}

// ── The invented work ───────────────────────────────────────────────────────
const ADA = [
  ['claude', {
    cwd: '/workspace/payments-api',
    turns: [
      {
        user: 'The public API has no rate limiting. Add one, but it has to survive a restart — the last in-memory attempt reset every deploy.',
        thought: 'In-memory buckets die with the process, so this needs shared state.',
        tool: { name: 'Read', input: { file_path: '/workspace/payments-api/src/middleware/index.ts' }, result: 'export const middleware = [requestId, auth, logging];' },
        assistant: 'Went with a Redis token bucket keyed by API key rather than IP, since several customers sit behind one NAT. 100 req/min sustained, burst of 20. State lives in Redis so a rolling deploy does not hand everyone a fresh quota.',
      },
      {
        user: 'What happens if Redis is down?',
        assistant: 'Fail open, and log loudly. Rejecting live payment traffic because a cache is unreachable is worse than briefly serving unlimited requests. Decision recorded in ADR-014.',
      },
    ],
  }],
  ['claude', {
    cwd: '/workspace/payments-api',
    turns: [
      {
        user: 'The checkout webhook test is flaky in CI — passes locally, fails maybe one run in five.',
        thought: 'Intermittent-in-CI-only usually means ordering or a real clock.',
        tool: { name: 'Bash', input: { command: 'npm test -- webhook --repeat 20' }, result: '18 passed, 2 failed — expected 3 calls, received 2' },
        assistant: 'Found it: the test asserts on delivery attempts before the retry queue has drained. It passes locally only because your machine is slower, so the retry lands first. Replaced the sleep with a wait on the queue depth.',
      },
    ],
  }],
  ['codex', {
    cwd: '/workspace/billing-worker',
    turns: [
      {
        user: 'Move the nightly billing job off cron onto the new queue.',
        tool: { name: 'apply_patch', input: { path: 'src/jobs/billing.ts' }, result: 'patched src/jobs/billing.ts' },
        assistant: 'Job now enqueues per-account instead of one giant nightly sweep, so a single failing account no longer blocks the batch. Kept the cron entry for one release as a fallback.',
      },
    ],
  }],
];

const BEN = [
  ['claude', {
    cwd: '/workspace/payments-api',
    turns: [
      {
        user: 'Auth middleware fails open when the token service times out. That is backwards — make it fail closed.',
        thought: 'Need to check every call site before flipping the default.',
        tool: { name: 'Grep', input: { pattern: 'verifyToken\\(' }, result: 'src/middleware/auth.ts:31\nsrc/routes/internal.ts:12' },
        assistant: 'Flipped it to fail closed, with one carve-out: the internal health route keeps working so the load balancer does not pull every node when the token service blips.',
      },
    ],
  }],
  ['codex', {
    cwd: '/workspace/payments-api',
    turns: [
      {
        user: 'Add idempotency keys to the payment endpoint so a retried request cannot double-charge.',
        tool: { name: 'apply_patch', input: { path: 'src/routes/payments.ts' }, result: 'patched src/routes/payments.ts' },
        assistant: 'Client sends Idempotency-Key; we store the key with the response for 24h and replay it on a repeat. Chose the request body hash as part of the key so a client reusing a key with different data gets a 422 instead of silently getting the old response.',
      },
      {
        user: 'Why 24 hours?',
        assistant: 'It covers the longest client retry window we have seen (a 6h backoff chain) with margin, without growing the table unbounded. Configurable, but that is the default.',
      },
    ],
  }],
];

const plan = who === 'ada' ? ADA : BEN;
for (const [kind, spec] of plan) {
  const id = kind === 'claude' ? writeClaudeSession(spec) : writeCodexSession(spec);
  console.log(`  seeded ${kind.padEnd(6)} ${id.slice(0, 8)}  ${spec.cwd}`);
  clock += 3 * HOUR;
}
