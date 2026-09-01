/**
 * Push local sessions to the server. Incremental by default: the daemon
 * remembers how many messages of each session the server has confirmed
 * (count + hash of the id prefix). If the local parse no longer matches that
 * prefix (rewind/re-linearization) — or the server disagrees (409) — it falls
 * back to a full PUT. The source jsonl files are the durable queue; state
 * only memoizes what was already acknowledged.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultCodexDir,
  discoverCodexSessions,
  discoverSessions,
  isDormantHandoff,
  readClaudeSession,
  readCodexSession,
  type MotifMessage,
  type MotifSession,
} from '@motif/core';
import { discoverCursorConversations, loadCursorProjectMap, readCursorSession } from '../readers/cursor.js';
import { ApiError, MotifClient } from '../api-client.js';
import { motifHome, type MotifConfig } from '../config.js';
import {
  fulfillPendingAsks,
  fulfillPendingHandoffs,
  fulfillPendingWeaves,
  listenEvents,
} from './requests.js';

interface SyncedState {
  count: number;
  hash: string;
  mtimeMs: number;
  size: number;
}

type DaemonState = Record<string, SyncedState>;

function statePath(): string {
  return path.join(motifHome(), 'daemon-state.json');
}

export function loadState(): DaemonState {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as DaemonState;
  } catch {
    return {};
  }
}

export function saveState(state: DaemonState): void {
  fs.mkdirSync(motifHome(), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state));
}

export async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Buffer.from(buf).toString('hex');
}

export function idPrefixHash(ids: string[]): Promise<string> {
  return sha256hex(ids.join('\n'));
}

/** Windows paths use backslashes; match everything in forward-slash space. */
const slashed = (p: string) => p.replace(/\\/g, '/');

function globToRegExp(glob: string): RegExp {
  const raw = slashed(glob).replace(/\/+$/, '');
  const escaped = raw
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  // A plain directory path means that whole tree, not just that one directory:
  // excluding ~/personal has to exclude ~/personal/app too, or the privacy
  // gate leaks every subproject. Patterns with a wildcard are taken literally.
  const body = raw.includes('*') ? escaped : `${escaped}(?:/.*)?`;
  return new RegExp(`^${body}$`);
}

export function isExcluded(projectPath: string, excludes: string[] = []): boolean {
  const target = slashed(projectPath);
  return excludes.some((g) => globToRegExp(g.replace(/^~/, slashed(os.homedir()))).test(target));
}

/**
 * The sync gate. 'all' mode syncs everything not excluded; 'selected' mode
 * syncs nothing unless the project is explicitly included — the safe default
 * for machines that also do personal work.
 */
export function shouldSyncProject(projectPath: string, cfg: MotifConfig): boolean {
  if (cfg.syncMode === 'selected') {
    return isExcluded(projectPath, cfg.include); // same matcher, allowlist semantics
  }
  return !isExcluded(projectPath, cfg.exclude);
}

/**
 * Built-in secret patterns, applied to every outgoing session unless the
 * machine opts out (`redactDefaults: false`). Skewed toward high-precision
 * token shapes; over-redacting is the safe failure direction.
 */
export const DEFAULT_REDACT_PATTERNS: string[] = [
  'sk-[A-Za-z0-9_-]{20,}', // OpenAI / Anthropic / Stripe-secret style
  'sk-ant-[A-Za-z0-9_-]{20,}',
  'AKIA[0-9A-Z]{16}', // AWS access key id
  'gh[pousr]_[A-Za-z0-9]{36,}', // GitHub tokens
  'github_pat_[A-Za-z0-9_]{22,}',
  'xox[baprs]-[A-Za-z0-9-]{10,}', // Slack
  'AIza[0-9A-Za-z_-]{35}', // Google API key
  'eyJ[A-Za-z0-9_-]{15,}\\.eyJ[A-Za-z0-9_-]{15,}\\.[A-Za-z0-9_-]{10,}', // JWT
  '-----BEGIN[A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END[A-Z ]*PRIVATE KEY-----',
  'mm_[A-Za-z0-9_-]{24,}', // Motif member tokens themselves
];

export function effectiveRedactPatterns(cfg: MotifConfig): string[] {
  const defaults = cfg.redactDefaults === false ? [] : DEFAULT_REDACT_PATTERNS;
  return [...defaults, ...(cfg.redactPatterns ?? [])];
}

/**
 * Joining a team must never auto-expose your history: unless this machine
 * predates the scope feature (teamProjects undefined → legacy all-team),
 * only sessions of explicitly listed team projects upload as 'team'; the
 * rest land in your personal drawer.
 */
export function computeVisibility(projectPath: string, cfg: MotifConfig): 'team' | 'personal' {
  if (cfg.teamProjects === undefined) return 'team';
  return isExcluded(projectPath, cfg.teamProjects) ? 'team' : 'personal';
}

export function redactSession(session: MotifSession, patterns: string[] = []): MotifSession {
  if (patterns.length === 0) return session;
  const regexes = patterns
    .map((p) => {
      try {
        return new RegExp(p, 'g');
      } catch {
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);
  const redactText = (t: string | undefined) => {
    if (!t) return t;
    let out = t;
    for (const r of regexes) out = out.replace(r, '[REDACTED]');
    return out;
  };
  const redactInput = (input: unknown): unknown => {
    if (input === undefined) return input;
    // tool inputs carry commands and file contents — redact their serialized form too
    const serialized = redactText(JSON.stringify(input))!;
    try {
      return JSON.parse(serialized);
    } catch {
      return serialized; // replacement broke the JSON shape; ship the redacted string
    }
  };
  return {
    ...session,
    messages: session.messages.map((m: MotifMessage) => ({
      ...m,
      text: redactText(m.text),
      ...(m.toolInput !== undefined ? { toolInput: redactInput(m.toolInput) } : {}),
    })),
  };
}

export interface SyncReport {
  pushed: number;
  appended: number;
  replaced: number;
  unchanged: number;
  excluded: number;
  errors: { sessionId: string; error: string }[];
  paused?: boolean;
}

/** `motif daemon pause` drops this flag file; the daemon keeps running but ships nothing. */
export function isPaused(): boolean {
  return fs.existsSync(path.join(motifHome(), 'paused'));
}

interface SyncItem {
  /** State key: `${source}:${sourceSessionId}` — sources may reuse ids. */
  key: string;
  mtimeMs: number;
  size: number;
  read: () => MotifSession;
}

/** Everything this machine can sync, across every supported agent. */
export function collectSyncItems(claudeDir?: string): SyncItem[] {
  const items: SyncItem[] = [];
  for (const f of discoverSessions(claudeDir)) {
    items.push({
      key: `claude-code:${f.sessionId}`,
      mtimeMs: f.mtimeMs,
      size: f.size,
      read: () => readClaudeSession(f.path),
    });
  }
  for (const f of discoverCodexSessions()) {
    if (isDormantHandoff(f.path)) continue; // our own handoff copies, not yet resumed
    items.push({
      key: `codex:${f.sessionId}`,
      mtimeMs: f.mtimeMs,
      size: f.size,
      read: () => readCodexSession(f.path),
    });
  }
  const cursorConversations = discoverCursorConversations();
  const cursorProjects = cursorConversations.length > 0 ? loadCursorProjectMap() : new Map<string, string>();
  for (const c of cursorConversations) {
    items.push({
      key: `cursor:${c.composerId}`,
      mtimeMs: c.updatedAtMs,
      size: 0,
      read: () => readCursorSession(c.composerId, undefined, cursorProjects.get(c.composerId) ?? ''),
    });
  }
  return items;
}

export async function syncOnce(
  client: MotifClient,
  config: MotifConfig,
  opts: { claudeDir?: string; force?: boolean } = {},
): Promise<SyncReport> {
  const state = loadState();
  const report: SyncReport = { pushed: 0, appended: 0, replaced: 0, unchanged: 0, excluded: 0, errors: [] };
  if (isPaused()) {
    report.paused = true;
    return report;
  }

  for (const file of collectSyncItems(opts.claudeDir)) {
    const prev = state[file.key];
    if (!opts.force && prev && prev.mtimeMs === file.mtimeMs && prev.size === file.size) {
      report.unchanged++;
      continue;
    }
    let session: MotifSession;
    try {
      session = file.read();
    } catch (err) {
      report.errors.push({ sessionId: file.key, error: String(err) });
      continue;
    }
    if (!shouldSyncProject(session.projectPath, config)) {
      report.excluded++;
      continue;
    }
    if (session.messages.length === 0) {
      // nothing to share (e.g. Cursor cloud-cache stubs) — remember and move on
      state[file.key] = { count: 0, hash: await idPrefixHash([]), mtimeMs: file.mtimeMs, size: file.size };
      report.excluded++;
      continue;
    }
    session = redactSession(session, effectiveRedactPatterns(config));
    session = { ...session, visibility: computeVisibility(session.projectPath, config) };

    const ids = session.messages.map((m) => m.id);
    try {
      let confirmedCount = 0;
      if (prev && prev.count <= ids.length) {
        const localPrefixHash = await idPrefixHash(ids.slice(0, prev.count));
        if (localPrefixHash === prev.hash) {
          const { messages: _messages, ...meta } = session;
          const newMessages = session.messages.slice(prev.count);
          if (newMessages.length === 0 && prev.count === ids.length) {
            // metadata-only change (e.g. title); cheap append of nothing still updates meta
          }
          try {
            await client.postMessages(meta, ids[prev.count - 1] ?? null, localPrefixHash, newMessages);
            confirmedCount = ids.length;
            report.appended++;
          } catch (err) {
            if (!(err instanceof ApiError && err.status === 409)) throw err;
          }
        }
      }
      if (confirmedCount === 0) {
        try {
          await client.putSession(session);
        } catch (err) {
          // The server refuses to shrink a session unless we say we meant it.
          // Rewinding onto another branch legitimately produces a shorter
          // linearisation, so most of the time we did. A parse that collapsed
          // to almost nothing is a broken reader, not a rewind, and replacing
          // the team's record with it would destroy history no one can recover.
          if (!(err instanceof ApiError && err.status === 409)) throw err;
          const detail = JSON.parse(err.body) as { stored?: number; incoming?: number };
          const stored = detail.stored ?? 0;
          const incoming = detail.incoming ?? ids.length;
          if (stored >= 20 && incoming < stored * 0.25) {
            throw new Error(
              `local copy has ${incoming} messages but the server has ${stored}; refusing to overwrite. ` +
                'The source file may be truncated, or a reader may have stopped understanding its format.',
            );
          }
          await client.putSession(session, { allowShrink: true });
        }
        confirmedCount = ids.length;
        report.replaced++;
      }
      state[file.key] = {
        count: confirmedCount,
        hash: await idPrefixHash(ids.slice(0, confirmedCount)),
        mtimeMs: file.mtimeMs,
        size: file.size,
      };
      report.pushed++;
    } catch (err) {
      report.errors.push({ sessionId: file.key, error: String(err) });
    }
  }
  saveState(state);
  return report;
}

export interface WatchHandle {
  stop: () => void;
}

/**
 * fs.watch with debounce, plus a reconciliation sweep as a safety net.
 * When `live` is set, also listens to the server's event stream and fulfils
 * dashboard-initiated handoff requests on this machine.
 */
export function watchAndSync(
  client: MotifClient,
  config: MotifConfig,
  opts: {
    claudeDir?: string;
    onReport?: (r: SyncReport) => void;
    debounceMs?: number;
    sweepMs?: number;
    live?: { serverUrl: string; token: string; log?: (msg: string) => void };
  } = {},
): WatchHandle {
  const debounceMs = opts.debounceMs ?? 1500;
  const sweepMs = opts.sweepMs ?? 60_000;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let queued = false;

  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
  };
  const run = async () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      const report = await syncOnce(client, config, { claudeDir: opts.claudeDir });
      opts.onReport?.(report);
    } catch {
      // network down — the next sweep retries
    } finally {
      running = false;
      if (queued) {
        queued = false;
        kick();
      }
    }
  };

  const watchers: fs.FSWatcher[] = [];
  const watchDir = (dir: string): void => {
    try {
      watchers.push(
        fs.watch(dir, { recursive: true }, (_event, filename) => {
          if (filename?.endsWith('.jsonl')) kick();
        }),
      );
    } catch {
      // directory missing or watch unsupported — sweeps still cover it
    }
  };
  watchDir(path.join(opts.claudeDir ?? path.join(os.homedir(), '.claude'), 'projects'));
  watchDir(path.join(defaultCodexDir(), 'sessions'));
  // Cursor writes into one hot SQLite file; the sweep picks its changes up
  const sweep = setInterval(() => {
    void run();
    if (opts.live) {
      void fulfillPendingHandoffs(client, opts.live.log);
      void fulfillPendingAsks(client, config, opts.live.log);
      void fulfillPendingWeaves(client, config, opts.live.log);
    }
  }, sweepMs);
  void run();

  let events: { stop: () => void } | undefined;
  if (opts.live) {
    const log = opts.live.log ?? (() => {});
    void fulfillPendingHandoffs(client, log); // clear any backlog on start
    void fulfillPendingAsks(client, config, log);
    void fulfillPendingWeaves(client, config, log);
    events = listenEvents(opts.live.serverUrl, opts.live.token, (event, data) => {
      if (event === 'handoff-requested') void fulfillPendingHandoffs(client, log);
      if (event === 'weaver-job') void fulfillPendingWeaves(client, config, log);
      if (event === 'ask-requested') {
        const d = data as { executorId?: number };
        if (config.memberId === undefined || d.executorId === config.memberId) {
          void fulfillPendingAsks(client, config, log);
        }
      }
      if (event === 'ask-answered') {
        const d = data as { sessionId?: string; askedBy?: number; status?: string };
        if (config.memberId !== undefined && d.askedBy === config.memberId) {
          log(`💬 your question about ${d.sessionId} was answered (${d.status}) — motif asks ${d.sessionId}`);
        }
      }
      if (event === 'comment-added') {
        const d = data as { sessionId?: string; authorName?: string; mentionIds?: number[] };
        if (config.memberId !== undefined && d.mentionIds?.includes(config.memberId)) {
          log(`💬 @${d.authorName ?? 'someone'} mentioned you on ${d.sessionId} — open it in the dashboard`);
        }
      }
    });
  }

  return {
    stop() {
      for (const w of watchers) w.close();
      clearInterval(sweep);
      clearTimeout(timer);
      events?.stop();
    },
  };
}
