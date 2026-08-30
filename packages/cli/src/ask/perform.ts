/**
 * "Ask a past session a question."
 *
 * The transcript alone is a document; the agent that wrote it is a colleague.
 * This resumes a session headlessly on the machine that owns it and asks the
 * question, so the answer comes back with the session's full context instead
 * of a lossy summary. Only the owning machine can do this — which is exactly
 * why the request is queued for its daemon.
 */

import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import type { MotifSession } from '@motif/core';

const READ_ONLY_PREAMBLE = [
  'READ-ONLY QUESTION relayed by Motif from a teammate.',
  'Answer strictly from this session\'s own context. Do not edit files, do not run',
  'commands that change anything, do not start new work. Be concise and concrete.',
  'If the answer is not in this session, say so plainly.',
  '',
  'Question: ',
].join('\n');

const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*[A-Za-z]/g, '');

/** Codex prints a run log before the reply; the reply follows the last usage line. */
function cleanCodexOutput(out: string): string {
  const text = stripAnsi(out);
  const marks = [...text.matchAll(/^tokens used.*$/gim)];
  const last = marks.at(-1);
  return (last ? text.slice(last.index! + last[0].length) : text).trim();
}

/**
 * A CLI that prints "you are out of credits" and exits 0 has not answered the
 * question — surfacing that text as the session's answer would be a lie.
 */
const REFUSALS = [/out of usage credits/i, /usage limit/i, /rate limit/i, /not authenticated/i, /please (log ?in|run .*login)/i];

function assertUsable(agent: string, status: number | null, answer: string, stderr: string): void {
  if (status !== 0) throw new Error(`${agent} exited ${status ?? 'null'}: ${(stderr || answer).slice(0, 300)}`);
  if (!answer) throw new Error(`${agent} returned nothing: ${stderr.slice(0, 300)}`);
  if (answer.length < 400 && REFUSALS.some((r) => r.test(answer))) {
    throw new Error(`${agent} could not answer: ${answer.slice(0, 200)}`);
  }
}

export interface AskOutcome {
  answer: string;
  agent: string;
  durationMs: number;
}

export function canAnswerLocally(session: MotifSession): boolean {
  if (session.source === 'cursor') return false; // no headless resume
  return !!session.sourcePath && fs.existsSync(session.sourcePath);
}

/** Sessions written to in the last two minutes are probably still running. */
export function looksLive(session: MotifSession): boolean {
  if (!session.updatedAt) return false;
  return Date.now() - new Date(session.updatedAt).getTime() < 2 * 60 * 1000;
}

export function askSessionLocally(
  session: MotifSession,
  question: string,
  opts: { timeoutMs?: number } = {},
): AskOutcome {
  if (session.source === 'cursor') {
    throw new Error('Cursor sessions cannot be resumed headlessly — read the transcript instead.');
  }
  if (!canAnswerLocally(session)) {
    throw new Error(`The transcript for ${session.id} is not on this machine.`);
  }
  const cwd = session.projectPath && fs.existsSync(session.projectPath) ? session.projectPath : os.homedir();
  const prompt = `${READ_ONLY_PREAMBLE}${question}`;
  const timeout = opts.timeoutMs ?? 180_000;
  const shell = process.platform === 'win32';
  const started = Date.now();

  if (session.source === 'claude-code') {
    const run = spawnSync('claude', ['-p', '--resume', session.sourceSessionId, prompt], {
      cwd,
      timeout,
      encoding: 'utf8',
      shell,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (run.error) throw new Error(`claude CLI unavailable: ${run.error.message}`);
    const answer = stripAnsi(run.stdout ?? '').trim();
    assertUsable('claude', run.status, answer, run.stderr ?? '');
    return { answer, agent: 'claude-code', durationMs: Date.now() - started };
  }

  // codex
  const args = ['exec', 'resume', session.sourceSessionId, '--skip-git-repo-check', prompt];
  let run = spawnSync('codex', args, { cwd, timeout, encoding: 'utf8', shell, maxBuffer: 32 * 1024 * 1024 });
  if (run.error && (run.error as NodeJS.ErrnoException).code === 'ENOENT') {
    run = spawnSync('npx', ['-y', '@openai/codex', ...args], {
      cwd,
      timeout,
      encoding: 'utf8',
      shell,
      maxBuffer: 32 * 1024 * 1024,
    });
  }
  if (run.error) throw new Error(`codex CLI unavailable: ${run.error.message}`);
  const answer = cleanCodexOutput(run.stdout ?? '');
  assertUsable('codex', run.status, answer, stripAnsi(run.stderr ?? ''));
  return { answer, agent: 'codex', durationMs: Date.now() - started };
}
