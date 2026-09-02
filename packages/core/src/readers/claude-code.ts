/**
 * Claude Code session reader.
 *
 * Sessions live at ~/.claude/projects/<mangled-cwd>/<sessionId>.jsonl. The
 * transcript is a DAG linked by parentUuid (branches appear on rewind/edit);
 * the active path is found by walking back from the last `last-prompt` line's
 * leafUuid. Attachment/system lines carry uuids and sit inside the parent
 * chain, so the walk traverses them but only user/assistant lines emit
 * messages. Parsing is tolerant: unreadable lines are counted and skipped,
 * a live session's last line is often truncated mid-append.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { MotifMessage, MotifSession } from '../schema.js';
import { motifSessionId } from '../schema.js';

export interface SessionFileInfo {
  path: string;
  sessionId: string;
  projectDir: string;
  mtimeMs: number;
  size: number;
}

export function defaultClaudeDir(): string {
  return path.join(os.homedir(), '.claude');
}

/** Globs top-level `*.jsonl` per project dir; sessions-index.json is not authoritative. */
export function discoverSessions(claudeDir = defaultClaudeDir()): SessionFileInfo[] {
  const projectsRoot = path.join(claudeDir, 'projects');
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(projectsRoot);
  } catch {
    return [];
  }
  const out: SessionFileInfo[] = [];
  for (const dir of projectDirs) {
    const full = path.join(projectsRoot, dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const p = path.join(full, e.name);
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      out.push({
        path: p,
        sessionId: e.name.slice(0, -'.jsonl'.length),
        projectDir: full,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    }
  }
  return out;
}

/** Session ids whose owning Claude Code process is still alive (file may be mid-append). */
export function getLiveSessionIds(claudeDir = defaultClaudeDir()): Set<string> {
  const live = new Set<string>();
  const dir = path.join(claudeDir, 'sessions');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return live;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (typeof reg?.pid !== 'number' || typeof reg?.sessionId !== 'string') continue;
      process.kill(reg.pid, 0); // throws if the process is gone
      live.add(reg.sessionId);
    } catch {
      // unreadable registry entry or dead pid, not live
    }
  }
  return live;
}

interface RawLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { role?: string; content?: unknown; model?: string };
  leafUuid?: string;
  aiTitle?: string;
  [key: string]: unknown;
}

function flattenBlockContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') {
          const block = b as Record<string, unknown>;
          if (block.type === 'text' && typeof block.text === 'string') return block.text;
          if (block.type === 'image') return '[image]';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function readClaudeSession(filePath: string): MotifSession {
  const sessionId = path.basename(filePath).replace(/\.jsonl$/, '');
  const raw = fs.readFileSync(filePath, 'utf8');

  const nodes = new Map<string, RawLine>();
  const children = new Map<string, string[]>();
  const fileOrder = new Map<string, number>();
  let parseErrors = 0;
  let leafHint: string | undefined;
  let aiTitle: string | undefined;
  let projectPath = '';
  let gitBranch: string | undefined;
  let toolVersion: string | undefined;
  let model: string | undefined;
  let firstPrompt: string | undefined;
  let order = 0;

  for (const lineText of raw.split('\n')) {
    if (!lineText.trim()) continue;
    let line: RawLine;
    try {
      line = JSON.parse(lineText);
    } catch {
      parseErrors++;
      continue;
    }
    switch (line.type) {
      case 'last-prompt':
        if (typeof line.leafUuid === 'string') leafHint = line.leafUuid; // rewritten repeatedly; last wins
        continue;
      case 'ai-title':
        if (typeof line.aiTitle === 'string') aiTitle = line.aiTitle;
        continue;
      case 'summary': // legacy compaction summaries, no uuid chain participation needed
        continue;
    }
    if (typeof line.uuid !== 'string') continue; // mode/permission-mode/atis-latch/etc.
    if (line.isSidechain) continue;

    if (!projectPath && typeof line.cwd === 'string') projectPath = line.cwd;
    if (typeof line.gitBranch === 'string' && line.gitBranch) gitBranch = line.gitBranch;
    if (typeof line.version === 'string') toolVersion = line.version;
    if (line.type === 'assistant' && typeof line.message?.model === 'string') model = line.message.model;
    if (
      firstPrompt === undefined &&
      line.type === 'user' &&
      typeof line.message?.content === 'string' &&
      !line.isMeta
    ) {
      firstPrompt = line.message.content;
    }

    nodes.set(line.uuid, line);
    fileOrder.set(line.uuid, order++);
    if (typeof line.parentUuid === 'string') {
      const list = children.get(line.parentUuid) ?? [];
      list.push(line.uuid);
      children.set(line.parentUuid, list);
    }
  }

  // Leaf selection: trust the last `last-prompt` hint, else the newest childless message line.
  const childless = [...nodes.keys()].filter((u) => !children.has(u));
  let leaf: string | undefined = leafHint && nodes.has(leafHint) ? leafHint : undefined;
  if (!leaf) {
    const candidates = childless
      .map((u) => nodes.get(u)!)
      .filter((l) => l.type === 'user' || l.type === 'assistant');
    const pool = candidates.length > 0 ? candidates : [...childless.map((u) => nodes.get(u)!)];
    pool.sort((a, b) => {
      const ta = a.timestamp ?? '';
      const tb = b.timestamp ?? '';
      if (ta !== tb) return ta < tb ? -1 : 1;
      return (fileOrder.get(a.uuid!) ?? 0) - (fileOrder.get(b.uuid!) ?? 0);
    });
    leaf = pool.at(-1)?.uuid;
  }

  // Walk leaf -> root through all node kinds, then keep message lines in forward order.
  const activePath: RawLine[] = [];
  let cursor = leaf;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = nodes.get(cursor);
    if (!node) break;
    activePath.push(node);
    cursor = typeof node.parentUuid === 'string' ? node.parentUuid : undefined;
  }
  activePath.reverse();

  const messages: MotifMessage[] = [];
  const filesTouched: string[] = [];
  const touched = new Set<string>();

  for (const line of activePath) {
    if (line.isMeta) continue;
    const ts = line.timestamp ?? '';
    const uuid = line.uuid!;
    if (line.type === 'user') {
      const content = line.message?.content;
      if (typeof content === 'string') {
        messages.push({ id: uuid, role: 'user', timestamp: ts, text: content });
      } else if (Array.isArray(content)) {
        content.forEach((block, i) => {
          if (!block || typeof block !== 'object') return;
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_result') {
            messages.push({
              id: `${uuid}#${i}`,
              role: 'tool_result',
              timestamp: ts,
              toolCallId: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined,
              text: flattenBlockContent(b.content),
            });
          } else if (b.type === 'text' && typeof b.text === 'string') {
            messages.push({ id: `${uuid}#${i}`, role: 'user', timestamp: ts, text: b.text });
          } else if (b.type === 'image') {
            messages.push({ id: `${uuid}#${i}`, role: 'user', timestamp: ts, text: '[image]' });
          }
        });
      }
    } else if (line.type === 'assistant') {
      const content = line.message?.content;
      if (!Array.isArray(content)) continue;
      content.forEach((block, i) => {
        if (!block || typeof block !== 'object') return;
        const b = block as Record<string, unknown>;
        const id = `${uuid}#${i}`;
        if (b.type === 'text' && typeof b.text === 'string') {
          messages.push({ id, role: 'assistant', timestamp: ts, text: b.text });
        } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
          // signature is an Anthropic-only attestation; never carried forward
          messages.push({ id, role: 'reasoning', timestamp: ts, text: b.thinking });
        } else if (b.type === 'tool_use') {
          const toolName = typeof b.name === 'string' ? b.name : 'unknown';
          const input = b.input;
          messages.push({
            id,
            role: 'tool_call',
            timestamp: ts,
            toolName,
            toolCallId: typeof b.id === 'string' ? b.id : undefined,
            toolInput: input,
          });
          if (EDIT_TOOLS.has(toolName) && input && typeof input === 'object') {
            const inp = input as Record<string, unknown>;
            const fp = inp.file_path ?? inp.notebook_path;
            if (typeof fp === 'string' && !touched.has(fp)) {
              touched.add(fp);
              filesTouched.push(fp);
            }
          }
        }
      });
    }
  }

  const timestamps = messages.map((m) => m.timestamp).filter(Boolean);
  const branchLeaves = childless.filter((u) => {
    const t = nodes.get(u)?.type;
    return t === 'user' || t === 'assistant';
  });

  let subagentCount = 0;
  try {
    subagentCount = fs
      .readdirSync(path.join(path.dirname(filePath), sessionId, 'subagents'))
      .filter((n) => n.startsWith('agent-') && n.endsWith('.jsonl')).length;
  } catch {
    // no subagents dir
  }

  const title = aiTitle ?? (firstPrompt ? firstPrompt.replace(/\s+/g, ' ').trim().slice(0, 120) : undefined);

  return {
    id: motifSessionId('claude-code', sessionId),
    source: 'claude-code',
    sourceSessionId: sessionId,
    sourcePath: filePath,
    projectPath,
    gitBranch,
    title,
    createdAt: timestamps[0] ?? '',
    updatedAt: timestamps.at(-1) ?? '',
    toolVersion,
    messages,
    filesTouched,
    meta: {
      subagentCount,
      branchCount: Math.max(0, branchLeaves.length - 1),
      parseErrors,
      model,
      sourceBytes: Buffer.byteLength(raw),
    },
  };
}
