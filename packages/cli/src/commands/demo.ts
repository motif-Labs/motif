import type { Command } from 'commander';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import {
  applyVerdict,
  createServer,
  createWeaverJob,
  findRegressionGaps,
  recall,
  startServer,
  whenListening,
} from '@motif/server';
import { performWeaverJob } from '../weaver/perform.js';
import { SESSIONS, insertSession, seedBackgroundMemory, seedConflict, seedMembers } from '../demo/seed.js';

/**
 * Not a museum — a show. A team's week replays in front of you in five acts:
 * sessions stream in live, memory catches two of them contradicting each
 * other, YOU rule on it, the Weaver aligns a real git repository with your
 * ruling, and recall answers with your verdict marked verified.
 *
 * Everything is invented and everything is isolated: the seed writes straight
 * into a throwaway database, the repository the Weaver touches is one this
 * command just created, and no reader ever runs — your own history cannot be
 * opened even by accident.
 */

const LOSING_LINE =
  'Fail **open** when Redis is unreachable — rejecting live payment traffic over a cache is worse than briefly serving unlimited requests.';
const WINNING_LINE =
  'Fail **closed** when Redis is unreachable. (Ruled by @you — the ADR as written wins; see the ruling record.)';

function makeDemoRepo(dir: string): string {
  const repo = path.join(dir, 'payments-api');
  fs.mkdirSync(path.join(repo, 'docs', 'adr'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'docs', 'adr', '014-rate-limiting.md'),
    `# ADR-014 — Rate limiting\n\nToken bucket in Redis, not in-memory: the previous attempt reset on every deploy.\n\n${LOSING_LINE}\n`,
  );
  fs.writeFileSync(
    path.join(repo, 'limiter-notes.md'),
    '# limiter\n\nRedis token bucket keyed by API key. 100 req/min, burst 20.\n',
  );
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  };
  git('init', '-q');
  git('add', '-A');
  execFileSync(
    'git',
    ['-C', repo, '-c', 'user.name=demo', '-c', 'user.email=demo@example.com', 'commit', '-qm', 'groundwork'],
    { stdio: 'ignore' },
  );
  return repo;
}

export function registerDemo(program: Command): void {
  program
    .command('demo')
    .description('A team’s week, replayed live in five acts — you rule, the Weaver acts')
    .option('--port <n>', 'port to listen on', '4699')
    .option('--no-open', 'do not open the dashboard in a browser')
    .option('--fast', 'no dramatic pauses')
    .option('--auto', 'do not ask for the ruling; side with the ADR')
    .option('--clean', 'remove the demo and exit')
    .action(
      async (opts: { port: string; open: boolean; fast?: boolean; auto?: boolean; clean?: boolean }) => {
        const dir = process.env.MOTIF_DEMO_DIR ?? path.join(os.homedir(), '.motif-demo');
        if (opts.clean) {
          fs.rmSync(dir, { recursive: true, force: true });
          console.log('Demo removed. Your own ~/.motif was never touched.');
          return;
        }

        // a fresh take every run — the demo is a stage, not a workspace
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });

        const beat = (ms: number): Promise<void> =>
          opts.fast ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));

        const server = createServer({ dbPath: path.join(dir, 'demo.db'), teamName: 'Motif Engineering' });
        const members = seedMembers(server.db);
        const you = members.byName.get('you')!;
        const port = Number(opts.port) || 4699;
        const listener = startServer(server, { port, hostname: '127.0.0.1' });
        await whenListening(listener);
        const base = `http://127.0.0.1:${port}`;

        console.log(
          `\n  MOTIF ENGINEERING — two weeks of a real team's work, replayed. Nothing real is touched.\n`,
        );
        console.log(`  Dashboard (watch it fill): ${base}  — signed in as "you"\n`);
        if (opts.open) {
          const url = `${base}/?token=${encodeURIComponent(you.memberToken)}`;
          if (process.platform === 'win32') {
            spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
          } else {
            const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
            spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
          }
          await beat(1500);
        }

        // ── Act 1 · sessions stream in, live ─────────────────────────────
        console.log(
          `  ▸ Act 1 · Collect — ${new Set(SESSIONS.map((x) => x.member)).size} people, two tools, ${new Set(SESSIONS.map((x) => x.project)).size} projects, one record\n`,
        );
        SESSIONS.forEach((s) => insertSession(server.db, members, s));
        // stream the recent ones on screen; the rest are already in the record
        const shown = SESSIONS.slice(-9);
        for (const s of shown) {
          const title = s.turns[0]![0];
          server.bus.publish('session-upserted', {
            id: `${s.source}:${s.id}`,
            memberId: members.byName.get(s.member)!.memberId,
            visibility: 'team',
            title,
            projectPath: s.project,
            messageCount: s.turns.length * 2,
          });
          console.log(
            `    ${s.member.padEnd(5)} · ${s.source === 'claude-code' ? 'Claude Code' : 'Codex      '}  ${title.slice(0, 62)}…`,
          );
          await beat(300);
        }
        console.log(`    …and ${SESSIONS.length - shown.length} more already in the record.\n`);

        // ── Act 2 · memory catches a contradiction ───────────────────────
        await beat(900);
        console.log('\n  ▸ Act 2 · Memory distils — and catches two sessions disagreeing\n');
        seedBackgroundMemory(server.db, members);
        const { standingId, challengerId } = seedConflict(server.db, members);
        server.bus.publish('memory-conflict', {
          entity: 'redis outage policy',
          aspect: 'limiter behaviour',
        });
        await beat(600);
        console.log('    ⚖️  CONFLICT — “redis outage policy”');
        console.log('        ada, in the rate-limiting session:  the limiter fails OPEN  (cites ADR-014)');
        console.log('        iris, writing the runbook:          ADR-014 as WRITTEN says fail CLOSED');
        console.log('        until someone rules, agents are shown BOTH sides with a warning.\n');

        // ── Act 3 · you rule ─────────────────────────────────────────────
        console.log('  ▸ Act 3 · A human rules — that human is you\n');
        let pick = '2';
        if (!opts.auto && process.stdin.isTTY) {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question(
            '    Which claim is true?  [1] fail open   [2] fail closed, as the ADR is written  > ',
          );
          rl.close();
          pick = answer.trim() === '1' ? '1' : '2';
        } else {
          console.log('    (--auto: ruling with the ADR as written)');
        }
        const winnerId = pick === '2' ? challengerId : standingId;
        const loserId = pick === '2' ? standingId : challengerId;
        applyVerdict(server.db, {
          noteId: winnerId,
          reviewerId: you.memberId,
          verdict: 'prefer',
          overNoteId: loserId,
          reason:
            pick === '2'
              ? 'the ADR as written is the decision of record'
              : 'the session captured the real intent',
        });
        server.bus.publish('memory-reviewed', {
          noteId: winnerId,
          verdict: 'prefer',
          reviewerId: you.memberId,
        });
        console.log(
          `    ruled: fail ${pick === '2' ? 'CLOSED' : 'OPEN'} · recorded with who, over what, and why · recall obeys instantly\n`,
        );

        // ── Act 4 · the Weaver acts on your ruling ───────────────────────
        await beat(700);
        console.log('  ▸ Act 4 · The Weaver — your ruling grows hands\n');
        const repo = makeDemoRepo(dir);
        console.log('    a real git repository (a scratch dir) still says:');
        console.log(`      "${LOSING_LINE.slice(0, 60)}…"\n`);
        await beat(900);
        const job = createWeaverJob(server.db, repo, {
          kind: 'ruling',
          entity: 'redis outage policy',
          aspect: 'limiter behaviour',
          winnerBody: pick === '2' ? WINNING_LINE : LOSING_LINE,
          loserBody: pick === '2' ? LOSING_LINE : WINNING_LINE,
          reason: 'ruled in the demo, by you',
          reviewerName: 'you',
          winnerSessionId: pick === '2' ? 'codex:demo-runbook' : 'claude-code:demo-rate-limit',
          loserSessionId: pick === '2' ? 'claude-code:demo-rate-limit' : 'codex:demo-runbook',
        });
        console.log('    weaving in a throwaway worktree… (a scripted stand-in plays the agent here;');
        console.log('    on your machine this is your own Claude/Codex, and the result is a draft PR)\n');
        const outcome = await performWeaverJob(
          { id: job.id, project_path: repo, payload: job.payload },
          {
            runAgent: (_prompt, cwd) => {
              // the demo's deterministic stand-in: correct exactly the losing line
              const adr = path.join(cwd, 'docs', 'adr', '014-rate-limiting.md');
              const text = fs.readFileSync(adr, 'utf8');
              if (pick === '2' && text.includes(LOSING_LINE)) {
                fs.writeFileSync(adr, text.replace(LOSING_LINE, WINNING_LINE));
              }
            },
            publishBranch: ({ branch }) => `(local branch ${branch} — in real use: a draft PR via gh)`,
          },
        );
        if (outcome.prUrl) {
          const diff = execFileSync(
            'git',
            ['-C', repo, 'diff', `HEAD..motif/weaver-${job.id}`, '--', 'docs/adr/014-rate-limiting.md'],
            { encoding: 'utf8' },
          )
            .split('\n')
            .filter((l) => l.startsWith('+') || l.startsWith('-'))
            .filter((l) => !l.startsWith('+++') && !l.startsWith('---'))
            .map((l) => `      ${l}`)
            .join('\n');
          console.log(`    committed on motif/weaver-${job.id}:\n\n${diff}\n`);
          console.log(`    ${outcome.prUrl}\n`);
        } else {
          console.log(`    ${outcome.result} — no branch, no PR, no noise.`);
          console.log('    (you ruled for what the repo already says; the Weaver refuses to invent work)\n');
        }

        // ── Act 4b · the Weaver finds an untested fix, on its own ────────
        await beat(700);
        console.log('  ▸ Act 4b · The Weaver scans — and finds a fix nobody tested\n');
        const gaps = findRegressionGaps(server.db);
        // prefer a fix for the demo — an untested bug fix is the sharper story
        const gap = gaps.find((g) => g.changeKind === 'fix') ?? gaps[0];
        if (gap) {
          console.log(`    it found: ${gap.file}`);
          console.log(`    from "${gap.sessionTitle}" — ${gap.changeKind}, no test\n`);
          await beat(700);
          // wire the demo repo to hold this file, then let the Weaver write the test
          const srcDir = path.join(repo, path.dirname(gap.file));
          fs.mkdirSync(srcDir, { recursive: true });
          fs.writeFileSync(
            path.join(repo, gap.file),
            'export function charge(key, amount) {\n  if (seen(key)) return replay(key);\n  seen.add(key);\n  return doCharge(key, amount);\n}\n',
          );
          execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' });
          execFileSync(
            'git',
            ['-C', repo, '-c', 'user.name=demo', '-c', 'user.email=d@demo.test', 'commit', '-qm', 'the fix'],
            { stdio: 'ignore' },
          );
          const testJob = createWeaverJob(server.db, repo, {
            kind: 'missing-regression',
            file: gap.file,
            changeKind: gap.changeKind,
            sessionId: gap.sessionId,
            sessionTitle: gap.sessionTitle,
            memberName: gap.memberName,
            context: gap.context,
          });
          const testOut = await performWeaverJob(
            { id: testJob.id, project_path: repo, payload: testJob.payload },
            {
              runAgent: (_p, cwd) => {
                const t = path.join(cwd, gap.file.replace(/\.(\w+)$/, '.test.$1'));
                fs.mkdirSync(path.dirname(t), { recursive: true });
                fs.writeFileSync(
                  t,
                  "import { charge } from './payments';\n\ntest('a retried key replays instead of charging twice', () => {\n  charge('k1', 10);\n  expect(charge('k1', 10)).toBe(replay('k1'));\n});\n",
                );
              },
              publishBranch: ({ branch }) => `(local branch ${branch} — in real use: a draft PR)`,
            },
          );
          if (testOut.prUrl) {
            console.log(`    the Weaver wrote the test — ${testOut.result}`);
            console.log('    (aimed at the fix, from the record — no wandering the tree)\n');
          }
        } else {
          console.log('    every recorded change already has a test.\n');
        }

        // ── Act 5 · ask the memory ───────────────────────────────────────
        await beat(700);
        console.log('  ▸ Act 5 · Recall — what agents are told now\n');
        const out = recall(server.db, {
          query: 'what happens when redis is down',
          viewerId: you.memberId,
          budget: 900,
        });
        for (const item of out.items.filter((i) => i.kind === 'note').slice(0, 2)) {
          console.log(`    ${item.text.split('\n').join('\n    ')}`);
          console.log(`      — ${item.why}\n`);
        }

        console.log('  Invented data, real engine: a ruling, a test the agent wrote from a receipt,');
        console.log('  a worktree, a diff — all of it the code that ships.\n');
        console.log(`  Now open the dashboard: ${base}`);
        console.log('    Overview — the team’s pulse at a glance');
        console.log('    Weave    — the whole record as a living graph');
        console.log('    Review   — the conflict you just ruled on, and how');
        console.log('    Memory   — decisions, each with a confidence\n');
        console.log(
          '  On your own history:  motif up     ·     Again:  motif demo     ·     Remove:  motif demo --clean\n',
        );
        console.log('  Ctrl+C stops the server.');
      },
    );
}
