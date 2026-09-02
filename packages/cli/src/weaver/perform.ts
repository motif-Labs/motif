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

export interface WeaverGapPayload {
  kind: 'missing-regression';
  file: string;
  sessionId: string;
  sessionTitle: string;
  memberName: string | null;
  context: string;
}

export type AnyWeaverPayload = WeaverRulingPayload | WeaverGapPayload;

export interface WeaverJob {
  id: number;
  project_path: string;
  payload: string;
}

export interface WeaverDeps {
  /** Run an agent over the worktree. Must only touch files under `cwd`. */
  runAgent: (prompt: string, cwd: string) => Promise<void> | void;
  /** Push the branch and open a draft PR; returns its URL. */
  publishBranch: (opts: {
    repo: string;
    worktree: string;
    branch: string;
    title: string;
    body: string;
  }) => Promise<string> | string;
  log?: (msg: string) => void;
}

export interface WeaverOutcome {
  status: 'done' | 'error';
  prUrl?: string;
  result: string;
}

const git = (cwd: string, ...args: string[]): string =>
  // stderr is piped, not inherited — git narrates worktree creation on stderr,
  // and that narration does not belong in the daemon's (or the demo's) output
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function buildPrompt(p: AnyWeaverPayload): string {
  if (p.kind === 'missing-regression') {
    return [
      'A change was made to this repository with no test to hold it. The context',
      'from the team record is below — use it so you do not have to search:',
      '',
      p.context,
      '',
      `Task: add ONE focused regression test for ${p.file} that would fail if the`,
      'fix were reverted, and nothing else. Do not refactor, do not touch',
      'unrelated files, do not add tests for behaviour the change did not affect.',
      'Match the repository’s existing test style and framework. If a suitable',
      'test already exists, change nothing at all.',
    ].join('\n');
  }
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

export async function performWeaverJob(job: WeaverJob, deps: WeaverDeps): Promise<WeaverOutcome> {
  const log = deps.log ?? (() => {});
  const payload = JSON.parse(job.payload) as AnyWeaverPayload;
  const repo = job.project_path;

  if (!fs.existsSync(path.join(repo, '.git'))) {
    return { status: 'error', result: `no git repository at ${repo} on this machine` };
  }

  const branch = `motif/weaver-${job.id}`;
  // A re-claimed job whose branch already exists was woven before and only the
  // completion report was lost. Weaving again would burn ten agent-minutes to
  // fail on the branch name — or worse, push a duplicate PR from another machine.
  try {
    git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    return {
      status: 'done',
      result: `branch ${branch} already exists — woven by a previous attempt whose report was lost`,
    };
  } catch {
    /* no branch: this is a first attempt */
  }
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
    log(`🧵 weaving #${job.id} (${payload.kind})…`);
    await deps.runAgent(buildPrompt(payload), worktree);

    git(worktree, 'add', '-A');
    const staged = git(worktree, 'diff', '--cached', '--name-only');
    if (staged === '') {
      cleanup(true);
      return { status: 'done', result: 'the repository already agrees with the ruling' };
    }

    const title =
      payload.kind === 'missing-regression'
        ? `Add a regression test for ${payload.file}`
        : `Align with the team ruling on ${payload.entity} · ${payload.aspect}`;
    const receipts =
      payload.kind === 'missing-regression'
        ? `from: session ${payload.sessionId}${payload.memberName ? ` (@${payload.memberName})` : ''}`
        : [
            payload.winnerSessionId && `ruled correct: session ${payload.winnerSessionId}`,
            payload.loserSessionId && `ruled wrong: session ${payload.loserSessionId}`,
            payload.reason && `reviewer: ${payload.reason}`,
          ]
            .filter(Boolean)
            .join('\n');
    git(worktree, 'commit', '-m', `${title}\n\n${receipts}`);

    const body =
      payload.kind === 'missing-regression'
        ? [
            `A change to \`${payload.file}\` shipped without a test. This adds one, aimed at exactly that change.`,
            '',
            `**From:** session \`${payload.sessionId}\`${payload.memberName ? ` — @${payload.memberName}` : ''}`,
            `> ${payload.sessionTitle}`,
            '',
            `Drafted by the Motif Weaver from job #${job.id}. Files changed: ${staged.split('\n').join(', ')}`,
          ]
            .filter(Boolean)
            .join('\n')
        : [
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
            .join('\n');
    const prUrl = await deps.publishBranch({ repo, worktree, branch, title, body });

    cleanup(false); // the branch carries the work; only the worktree goes
    log(`   draft PR ready: ${prUrl}`);
    return { status: 'done', prUrl, result: `changed: ${staged.split('\n').join(', ')}` };
  } catch (err) {
    cleanup(true);
    return { status: 'error', result: String(err).slice(0, 400) };
  }
}

/* ── default dependencies: the real agent and the real PR ─────────────────── */

import { spawn, spawnSync } from 'node:child_process';

export function defaultRunAgent(prompt: string, cwd: string): Promise<void> {
  // Non-interactive Claude Code with an explicit tool allowlist: it may read
  // and edit inside the worktree, and nothing else. No Bash — the Weaver
  // aligns text with a ruling; it does not get a shell. Async on purpose: a
  // ten-minute agent run must not freeze the daemon that also answers asks,
  // delivers handoffs and syncs sessions.
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--allowedTools', 'Read', 'Grep', 'Glob', 'Edit', 'Write'], {
      cwd,
      // on Windows the agent CLIs are .cmd shims that need a shell to resolve
      shell: process.platform === 'win32',
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('agent timed out after 10 minutes'));
    }, 10 * 60_000);
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.stdout?.resume(); // drain, or a chatty agent blocks on a full pipe
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`claude CLI unavailable: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`agent exited ${code}: ${stderr.slice(0, 200)}`));
    });
    child.stdin?.end(prompt);
  });
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
