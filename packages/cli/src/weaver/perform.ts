/**
 * The Weaver's hands. A ruling on team memory says which claim won; the
 * repository may still say what the loser said — an ADR, a comment, a README.
 * This takes one queued job and weaves the repo back into agreement, under
 * rails that do not bend:
 *
 *   - a throwaway git worktree; the owner's checkout is never touched
 *   - changes only an agent made from the ruling's own words, receipts included
 *   - nothing to change → no branch, no PR, no noise
 *   - a draft PR on a `motif/` branch; pushing to the default branch is not a
 *     thing this code can do
 *
 * The agent and the publish step are injected, so every rail is testable
 * against a real git repo without spawning a real agent.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface WeaverRulingPayload {
  kind: 'ruling';
  entity: string;
  aspect: string;
  winnerBody: string;
  loserBody: string;
  reason: string | null;
  winnerSessionId: string | null;
  loserSessionId: string | null;
}

export interface WeaverJob {
  id: number;
  project_path: string;
  payload: string;
}

export interface WeaverDeps {
  /** Run an agent over the worktree. Must only touch files under `cwd`. */
  runAgent: (prompt: string, cwd: string) => void;
  /** Push the branch and open a draft PR; returns its URL. */
  publishBranch: (opts: {
    repo: string;
    worktree: string;
    branch: string;
    title: string;
    body: string;
  }) => string;
  log?: (msg: string) => void;
}

export interface WeaverOutcome {
  status: 'done' | 'error';
  prUrl?: string;
  result: string;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

export function buildPrompt(p: WeaverRulingPayload): string {
  return [
    'A human ruling has resolved a contradiction in this team’s memory.',
    '',
    `Topic: ${p.entity} · ${p.aspect}`,
    `RULED CORRECT: ${p.winnerBody}`,
    `RULED WRONG:   ${p.loserBody}`,
    p.reason ? `Why: ${p.reason}` : '',
    '',
    'Task: bring THIS repository into agreement with the ruling. Look for docs,',
    'comments, ADRs or code that state the losing claim, and correct only those.',
    'Change nothing the ruling does not imply. If the repository already agrees',
    'with the ruling, change nothing at all.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function performWeaverJob(job: WeaverJob, deps: WeaverDeps): WeaverOutcome {
  const log = deps.log ?? (() => {});
  const payload = JSON.parse(job.payload) as WeaverRulingPayload;
  const repo = job.project_path;

  if (!fs.existsSync(path.join(repo, '.git'))) {
    return { status: 'error', result: `no git repository at ${repo} on this machine` };
  }

  const branch = `motif/weaver-${job.id}`;
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-weaver-'));
  const cleanup = (dropBranch: boolean): void => {
    try {
      git(repo, 'worktree', 'remove', '--force', worktree);
    } catch {
      fs.rmSync(worktree, { recursive: true, force: true });
      try {
        git(repo, 'worktree', 'prune');
      } catch {
        /* the repo may be gone entirely */
      }
    }
    if (dropBranch) {
      try {
        git(repo, 'branch', '-D', branch);
      } catch {
        /* never created */
      }
    }
  };

  try {
    git(repo, 'worktree', 'add', worktree, '-b', branch);
  } catch (err) {
    fs.rmSync(worktree, { recursive: true, force: true });
    return { status: 'error', result: `could not create a worktree: ${String(err).slice(0, 200)}` };
  }

  try {
    log(`🧵 weaving ruling #${job.id} for ${payload.entity} · ${payload.aspect}…`);
    deps.runAgent(buildPrompt(payload), worktree);

    git(worktree, 'add', '-A');
    const staged = git(worktree, 'diff', '--cached', '--name-only');
    if (staged === '') {
      cleanup(true);
      return { status: 'done', result: 'the repository already agrees with the ruling' };
    }

    const receipts = [
      payload.winnerSessionId && `ruled correct: session ${payload.winnerSessionId}`,
      payload.loserSessionId && `ruled wrong: session ${payload.loserSessionId}`,
      payload.reason && `reviewer: ${payload.reason}`,
    ]
      .filter(Boolean)
      .join('\n');
    git(
      worktree,
      'commit',
      '-m',
      `Align with the team ruling on ${payload.entity}\n\n${payload.winnerBody}\n\n${receipts}`,
    );

    const prUrl = deps.publishBranch({
      repo,
      worktree,
      branch,
      title: `Align with the team ruling on ${payload.entity} · ${payload.aspect}`,
      body: [
        `A human ruling resolved a contradiction in team memory, and these files still said what the losing claim said.`,
        '',
        `**Ruled correct:** ${payload.winnerBody}`,
        `**Ruled wrong:** ${payload.loserBody}`,
        payload.reason ? `**Why:** ${payload.reason}` : '',
        '',
        payload.winnerSessionId
          ? `Evidence: \`${payload.winnerSessionId}\` vs \`${payload.loserSessionId ?? '?'}\``
          : '',
        '',
        `Drafted by the Motif Weaver from job #${job.id}. Files changed: ${staged.split('\n').join(', ')}`,
      ]
        .filter(Boolean)
        .join('\n'),
    });

    cleanup(false); // the branch carries the work; only the worktree goes
    log(`   draft PR ready: ${prUrl}`);
    return { status: 'done', prUrl, result: `changed: ${staged.split('\n').join(', ')}` };
  } catch (err) {
    cleanup(true);
    return { status: 'error', result: String(err).slice(0, 400) };
  }
}

/* ── default dependencies: the real agent and the real PR ─────────────────── */

import { spawnSync } from 'node:child_process';

export function defaultRunAgent(prompt: string, cwd: string): void {
  // Non-interactive Claude Code with an explicit tool allowlist: it may read
  // and edit inside the worktree, and nothing else. No Bash — the Weaver
  // aligns text with a ruling; it does not get a shell.
  const run = spawnSync('claude', ['-p', '--allowedTools', 'Read', 'Grep', 'Glob', 'Edit', 'Write'], {
    cwd,
    input: prompt,
    encoding: 'utf8',
    timeout: 10 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (run.error) throw new Error(`claude CLI unavailable: ${run.error.message}`);
  if (run.status !== 0) {
    throw new Error(`agent exited ${run.status}: ${(run.stderr ?? '').slice(0, 200)}`);
  }
}

export function defaultPublishBranch(opts: {
  repo: string;
  worktree: string;
  branch: string;
  title: string;
  body: string;
}): string {
  execFileSync('git', ['-C', opts.worktree, 'push', '-u', 'origin', opts.branch], {
    encoding: 'utf8',
  });
  const out = spawnSync(
    'gh',
    ['pr', 'create', '--draft', '--head', opts.branch, '--title', opts.title, '--body', opts.body],
    { cwd: opts.worktree, encoding: 'utf8' },
  );
  if (out.error) throw new Error('gh CLI is not installed — the branch is pushed, open the PR by hand');
  if (out.status !== 0) throw new Error(`gh pr create failed: ${(out.stderr ?? '').slice(0, 200)}`);
  const url = (out.stdout ?? '').trim().split('\n').pop() ?? '';
  if (!url.startsWith('http')) throw new Error(`unexpected gh output: ${url.slice(0, 120)}`);
  return url;
}
