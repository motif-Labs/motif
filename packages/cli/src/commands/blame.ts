import type { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { MotifSession } from '@motif/core';
import { MotifClient } from '../api-client.js';
import { loadConfig } from '../config.js';
import { scanLocal } from '../local.js';

/**
 * `git blame` says who last touched a line. This says which CONVERSATION the
 * work came from — the sessions that touched a file, newest first, so "why is
 * this like this" starts from the file itself instead of an archaeology dig.
 *
 * Attribution is honest about being inferred: sessions record which files they
 * touched and when; this ranks by how specifically and how recently they did.
 */

export interface BlameCandidate {
  id: string;
  source: string;
  member: string | null;
  title: string | null;
  updatedAt: string | null;
  matched: string;
  exact: boolean;
}

/** Suffix-match both ways: stored paths may be absolute, asked paths relative. */
function fileMatches(stored: string, rel: string): boolean {
  return stored === rel || stored.endsWith(`/${rel}`) || rel.endsWith(`/${stored}`);
}

export function rankForFile(
  sessions: Pick<MotifSession, 'id' | 'source' | 'title' | 'updatedAt' | 'filesTouched'>[],
  rel: string,
): BlameCandidate[] {
  const out: BlameCandidate[] = [];
  for (const s of sessions) {
    const hit = (s.filesTouched ?? []).find((f) => fileMatches(f, rel));
    if (!hit) continue;
    out.push({
      id: s.id,
      source: s.source,
      member: null,
      title: s.title ?? null,
      updatedAt: s.updatedAt ?? null,
      matched: hit,
      exact: hit === rel || hit.endsWith(`/${rel}`),
    });
  }
  // exact path beats loose suffix; within a tier, the freshest session first
  return out.sort(
    (a, b) => Number(b.exact) - Number(a.exact) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
  );
}

function projectRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

export function registerBlame(program: Command): void {
  program
    .command('blame <file>')
    .description('Which sessions produced this file — from the code back to the conversation')
    .option('--json', 'machine-readable output')
    .action(async (file: string, opts: { json?: boolean }) => {
      const root = projectRoot();
      const rel = path.relative(root, path.resolve(file));
      const { claudeDir } = program.opts<{ claudeDir?: string }>();
      const cfg = loadConfig();

      const seen = new Set<string>();
      const candidates: BlameCandidate[] = [];

      // the team's record first — it sees sessions from every machine
      if (cfg.serverUrl && (cfg.memberToken ?? cfg.token)) {
        try {
          const client = new MotifClient({
            serverUrl: cfg.serverUrl,
            token: cfg.memberToken ?? cfg.token!,
          });
          for (const s of await client.sessionsByFile(rel, root)) {
            seen.add(s.id);
            candidates.push({
              id: s.id,
              source: s.source,
              member: s.member_name,
              title: s.title,
              updatedAt: s.updated_at,
              matched: s.matched,
              exact: s.exact,
            });
          }
        } catch {
          // the local scan below still answers
        }
      }

      // then this machine's own history, for whatever never synced
      for (const c of rankForFile(scanLocal(claudeDir).sessions, rel)) {
        if (!seen.has(c.id)) candidates.push(c);
      }
      candidates.sort(
        (a, b) => Number(b.exact) - Number(a.exact) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
      );

      if (opts.json) {
        console.log(JSON.stringify(candidates.slice(0, 10), null, 2));
        return;
      }
      if (candidates.length === 0) {
        console.log(`No session on record touched ${rel}.`);
        console.log(
          '(Sessions know the files their tools wrote — work done outside an agent leaves no trail here.)',
        );
        return;
      }
      console.log(`${rel} — worked on in ${candidates.length} session(s):\n`);
      for (const c of candidates.slice(0, 5)) {
        const when = c.updatedAt ? c.updatedAt.slice(0, 10) : '????-??-??';
        const who = c.member ? `@${c.member}` : 'this machine';
        console.log(`  ${when}  ${who} · ${c.source}  ${c.title ?? '(untitled)'}`);
        console.log(`            ${c.id}   →  motif show ${c.id}\n`);
      }
    });
}
