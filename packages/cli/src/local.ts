/**
 * Local session access shared by CLI commands. In solo/offline use (and until
 * the daemon+server land in M2) commands parse straight from ~/.claude — the
 * files are small enough that a full parse is milliseconds and always fresh.
 */

import {
  discoverSessions,
  getLiveSessionIds,
  readClaudeSession,
  type MotifSession,
  type SessionFileInfo,
} from '@motif/core';

export interface LocalScan {
  sessions: MotifSession[];
  live: Set<string>;
  files: SessionFileInfo[];
  failures: { path: string; error: string }[];
}

export function scanLocal(claudeDir?: string): LocalScan {
  const files = discoverSessions(claudeDir);
  const live = getLiveSessionIds(claudeDir);
  const sessions: MotifSession[] = [];
  const failures: { path: string; error: string }[] = [];
  for (const f of files) {
    try {
      sessions.push(readClaudeSession(f.path));
    } catch (err) {
      failures.push({ path: f.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return { sessions, live, files, failures };
}

/** Accepts a full motif id, a source uuid, or a unique uuid prefix. */
export function resolveSession(sessions: MotifSession[], id: string): MotifSession {
  const exact = sessions.find((s) => s.id === id || s.sourceSessionId === id);
  if (exact) return exact;
  const matches = sessions.filter((s) => s.sourceSessionId.startsWith(id));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new Error(`No session matches "${id}". Try \`motif list\`.`);
  }
  throw new Error(
    `Ambiguous id "${id}" — matches:\n` +
      matches.map((m) => `  ${m.sourceSessionId}  ${m.title ?? ''}`).join('\n'),
  );
}

export function shortId(s: MotifSession): string {
  return s.sourceSessionId.slice(0, 8);
}
