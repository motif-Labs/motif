import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyNotes,
  claimWeaverJob,
  completeWeaverJob,
  createServer,
  createWeaverJob,
  fullReplaceSession,
  listWeaverJobs,
  openDb,
  registerMember,
  startServer,
  type Db,
  type MotifServer,
} from '@motif/server';
import type { MotifMessage, MotifSession } from '@motif/core';
import { performWeaverJob } from '../packages/cli/src/weaver/perform.js';
import { requeueStaleClaims } from '@motif/server';

const PAYLOAD = {
  kind: 'ruling' as const,
  entity: 'redis outage policy',
  aspect: 'limiter behaviour',
  winnerBody: 'ADR-014 says fail CLOSED when Redis is unreachable.',
  loserBody: 'The limiter fails open when Redis is unreachable.',
  reason: 'the ADR is the written decision',
  winnerSessionId: 'codex:runbook',
  loserSessionId: 'claude-code:rate-limit',
};

describe('the weaver queue', () => {
  let tmp: string;
  let db: Db;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-weaver-q-'));
    db = openDb(path.join(tmp, 'db.sqlite'));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('claims atomically: one winner, one loser, and only the claimer completes', () => {
    const a = registerMember(db, { name: 'ada' }).memberId;
    const b = registerMember(db, { name: 'ben' }).memberId;
    const job = createWeaverJob(db, '/workspace/app', PAYLOAD);

    expect(claimWeaverJob(db, job.id, a)).toBe(true);
    expect(claimWeaverJob(db, job.id, b)).toBe(false);

    // the loser of the claim cannot report an outcome
    expect(completeWeaverJob(db, job.id, b, { status: 'done' })).toBeUndefined();
    const done = completeWeaverJob(db, job.id, a, { status: 'done', prUrl: 'https://example.com/pr/1' });
    expect(done?.status).toBe('done');
    expect(listWeaverJobs(db, 'pending')).toHaveLength(0);
  });

  it('a claim is a lease: a job stranded in running comes back to pending', () => {
    const a = registerMember(db, { name: 'ada' }).memberId;
    const job = createWeaverJob(db, '/workspace/app', PAYLOAD);
    claimWeaverJob(db, job.id, a);
    // the daemon died mid-weave; nothing will ever complete this claim
    db.prepare('UPDATE weaver_jobs SET updated_at = ? WHERE id = ?').run(
      new Date(Date.now() - 60 * 60_000).toISOString(),
      job.id,
    );
    expect(requeueStaleClaims(db)).toBe(1);
    const back = listWeaverJobs(db, 'pending');
    expect(back.map((j) => j.id)).toContain(job.id);
    expect(back[0]!.claimed_by).toBeNull();
  });
});

describe('a ruling queues work — unless its evidence is personal', () => {
  let tmp: string;
  let server: MotifServer;
  let httpServer: ReturnType<typeof startServer>;
  let base: string;

  const msg = (id: string): MotifMessage => ({
    id,
    role: 'user',
    timestamp: '2026-08-01T10:00:00.000Z',
    text: 'work',
  });
  const session = (id: string): MotifSession => ({
    id: `claude-code:${id}`,
    source: 'claude-code',
    sourceSessionId: id,
    sourcePath: `/fake/${id}.jsonl`,
    projectPath: '/workspace/app',
    gitBranch: 'main',
    title: id,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:05:00.000Z',
    messages: [msg(`${id}-1`)],
    filesTouched: [],
    meta: { subagentCount: 0, branchCount: 0, parseErrors: 0 },
  });

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-weaver-h-'));
    server = createServer({ dbPath: path.join(tmp, 'db.sqlite'), token: 'test-token' });
    httpServer = startServer(server, { port: 0 });
    if (!httpServer.listening) await new Promise((r) => httpServer.once('listening', r));
    const addr = httpServer.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterEach(() => {
    httpServer.close();
    server.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function stageConflictAndRule(personalLoser: boolean): Promise<number> {
    const ada = registerMember(server.db, { name: 'ada', email: `a${Math.random()}@example.com` });
    const src = fullReplaceSession(server.db, ada.memberId, session(`s-${personalLoser}`));
    if (personalLoser) {
      server.db.prepare('UPDATE sessions SET visibility = ? WHERE pk = ?').run('personal', src.pk);
    }
    applyNotes(
      server.db,
      [{ entity: { kind: 'decision', name: `policy-${personalLoser}` }, aspect: 'a', body: 'loser claim' }],
      { projectPath: '/workspace/app', sessionPk: src.pk, memberId: ada.memberId },
    );
    applyNotes(
      server.db,
      [
        {
          entity: { kind: 'decision', name: `policy-${personalLoser}` },
          aspect: 'a',
          body: 'winner claim',
          contradictsCurrent: true,
        },
      ],
      { projectPath: '/workspace/app', sessionPk: null, memberId: ada.memberId },
    );
    const challenger = server.db
      .prepare("SELECT id FROM memory_notes WHERE body = 'winner claim' AND status = 'conflicted'")
      .get() as { id: number };
    const res = await fetch(`${base}/api/memory/notes/${challenger.id}/verdict`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ada.memberToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'prefer' }),
    });
    expect(res.status).toBe(200);
    return (server.db.prepare('SELECT COUNT(*) AS n FROM weaver_jobs').get() as { n: number }).n;
  }

  it("'prefer' on team-visible evidence queues a job carrying both claims", async () => {
    const jobs = await stageConflictAndRule(false);
    expect(jobs).toBe(1);
    const job = listWeaverJobs(server.db, 'pending')[0]!;
    const payload = JSON.parse(job.payload) as { winnerBody: string; loserBody: string };
    expect(payload.winnerBody).toBe('winner claim');
    expect(payload.loserBody).toBe('loser claim');
    expect(job.project_path).toBe('/workspace/app');
  });

  it("'prefer' over personal evidence queues nothing — daemons must not receive what strangers cannot read", async () => {
    const jobs = await stageConflictAndRule(true);
    expect(jobs).toBe(0);
  });
});

describe('performWeaverJob — the rails, against a real git repository', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-weaver-repo-'));
    execFileSync('git', ['-C', repo, 'init', '-q']);
    fs.writeFileSync(path.join(repo, 'ADR.md'), 'The limiter fails open when Redis is unreachable.\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-qm',
      'init',
    ]);
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const job = (id: number) => ({ id, project_path: repo, payload: JSON.stringify(PAYLOAD) });

  it('weaves in a worktree, commits on a motif/ branch, publishes, and never touches the checkout', async () => {
    let published: { branch: string; body: string } | undefined;
    const outcome = await performWeaverJob(job(7), {
      runAgent: (prompt, cwd) => {
        expect(prompt).toContain('RULED CORRECT: ADR-014 says fail CLOSED');
        expect(cwd).not.toBe(repo); // a worktree, not the owner's checkout
        fs.writeFileSync(path.join(cwd, 'ADR.md'), 'Fail CLOSED when Redis is unreachable (ruled).\n');
      },
      publishBranch: ({ branch, body }) => {
        published = { branch, body };
        return 'https://example.com/pr/7';
      },
    });

    expect(outcome).toMatchObject({ status: 'done', prUrl: 'https://example.com/pr/7' });
    expect(published!.branch).toBe('motif/weaver-7');
    expect(published!.body).toContain('codex:runbook'); // receipts travel with the PR
    // the owner's checkout is untouched; the branch carries the change
    expect(fs.readFileSync(path.join(repo, 'ADR.md'), 'utf8')).toContain('fails open');
    const onBranch = execFileSync('git', ['-C', repo, 'show', 'motif/weaver-7:ADR.md'], {
      encoding: 'utf8',
    });
    expect(onBranch).toContain('Fail CLOSED');
  });

  it('an agreeing repository produces no branch, no PR, no noise', async () => {
    let publishCalled = false;
    const outcome = await performWeaverJob(job(8), {
      runAgent: () => {}, // the agent finds nothing to change
      publishBranch: () => {
        publishCalled = true;
        return 'never';
      },
    });
    expect(outcome.status).toBe('done');
    expect(outcome.prUrl).toBeUndefined();
    expect(outcome.result).toContain('already agrees');
    expect(publishCalled).toBe(false);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'motif/*'], { encoding: 'utf8' });
    expect(branches.trim()).toBe('');
  });

  it('a re-claimed job whose branch exists reports done instead of weaving twice', async () => {
    // first attempt weaves and publishes, but the completion report was lost
    await performWeaverJob(job(11), {
      runAgent: (_p, cwd) => fs.writeFileSync(path.join(cwd, 'ADR.md'), 'woven once\n'),
      publishBranch: () => 'https://example.com/pr/11',
    });
    // the lease requeues it; a second attempt must not burn another agent run
    let agentRan = false;
    const outcome = await performWeaverJob(job(11), {
      runAgent: () => {
        agentRan = true;
      },
      publishBranch: () => 'never',
    });
    expect(agentRan).toBe(false);
    expect(outcome.status).toBe('done');
    expect(outcome.result).toContain('previous attempt');
  });

  it('a failing publish rolls everything back and reports the error', async () => {
    const outcome = await performWeaverJob(job(9), {
      runAgent: (_p, cwd) => fs.writeFileSync(path.join(cwd, 'ADR.md'), 'changed\n'),
      publishBranch: () => {
        throw new Error('no remote named origin');
      },
    });
    expect(outcome.status).toBe('error');
    expect(outcome.result).toContain('no remote');
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'motif/*'], { encoding: 'utf8' });
    expect(branches.trim()).toBe('');
    expect(
      execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }).trim().split('\n'),
    ).toHaveLength(1);
  });
});
