/**
 * MotifSession → Codex rollout conversion (the native-handoff hero).
 *
 * Format pinned against Codex 0.150.1: a real captured rollout
 * (fixtures/codex/rollout-captured-0.150.1.jsonl) plus the serde definitions
 * in openai/codex @ rust-v0.150.1 — RolloutLine {timestamp, ordinal, type,
 * payload}; ResponseItem tagged `type`/snake_case with function_call
 * `arguments` as a JSON STRING and function_call_output `output` as a plain
 * string; SessionMeta requires session_id/id/timestamp/cwd/originator/
 * cli_version. history_mode "legacy" so resume rebuilds the UI transcript
 * from user_message/agent_message event_msg lines while response_item lines
 * carry the model-visible history.
 *
 * Timestamps use handoff time, not the original session's: the resume picker
 * sorts by recency and a handed-off session should surface on top.
 */

import type { MotifMessage, MotifSession } from '../schema.js';
import { buildDigest } from '../digest.js';
import { translateToolCall } from './codex-tools.js';

export interface RolloutLine {
  timestamp: string;
  ordinal: number;
  type: string;
  payload: unknown;
}

export interface ConvertOptions {
  threadId: string;
  now: Date;
  cliVersion?: string;
  /** Extra provenance note; defaults to a handoff marker with the source id. */
  provenance?: string;
  /**
   * For very long sessions: keep only the last `keepLast` messages verbatim
   * and compress everything earlier into one condensed-history user message,
   * so the target tool's context isn't flooded on resume.
   */
  digest?: { keepLast: number };
}

export interface ConvertResult {
  lines: RolloutLine[];
  threadId: string;
  /** Path relative to ~/.codex: sessions/YYYY/MM/DD/rollout-…jsonl */
  relativePath: string;
  droppedReasoning: number;
  title: string;
  firstUserMessage: string;
}

/** UUIDv7 (time-ordered) — Codex ids are v7 and the picker benefits from id ordering. */
export function uuidv7(now: Date, random: () => number = Math.random): string {
  const ts = now.getTime();
  const bytes = new Uint8Array(16);
  for (let i = 5; i >= 0; i--) bytes[i] = Math.floor(ts / 2 ** ((5 - i) * 8)) % 256;
  for (let i = 6; i < 16; i++) bytes[i] = Math.floor(random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function utcStamp(now: Date): string {
  // rollout filenames encode UTC as YYYY-MM-DDTHH-MM-SS
  return now.toISOString().slice(0, 19).replace(/:/g, '-');
}

export function rolloutRelativePath(threadId: string, now: Date): string {
  const iso = now.toISOString();
  return `sessions/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}/rollout-${utcStamp(now)}-${threadId}.jsonl`;
}

export function toRolloutLines(session: MotifSession, opts: ConvertOptions): ConvertResult {
  const { threadId } = opts;
  const iso = opts.now.toISOString();
  let ordinal = 0;
  const lines: RolloutLine[] = [];
  const push = (type: string, payload: unknown) =>
    lines.push({ timestamp: iso, ordinal: ordinal++, type, payload });

  push('session_meta', {
    session_id: threadId,
    id: threadId,
    timestamp: iso,
    cwd: session.projectPath || '/',
    originator: 'motif',
    cli_version: opts.cliVersion ?? '0.150.1',
    source: 'cli', // interactive source so the resume picker lists it
    model_provider: 'openai',
    base_instructions: null,
    history_mode: 'legacy',
    ...(session.gitBranch && session.gitBranch !== 'HEAD'
      ? { git: { branch: session.gitBranch } }
      : {}),
  });

  const provenance =
    opts.provenance ??
    `[Handed off from Claude Code session ${session.sourceSessionId} via Motif on ${iso.slice(0, 10)}. The conversation below is the prior history of this task; continue where it left off.]`;
  push('response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: provenance }],
  });

  let droppedReasoning = 0;
  let firstUserMessage = '';

  let toConvert = session.messages;
  if (opts.digest && session.messages.length > opts.digest.keepLast) {
    const earlier = session.messages.slice(0, -opts.digest.keepLast);
    toConvert = session.messages.slice(-opts.digest.keepLast);
    droppedReasoning += earlier.filter((m) => m.role === 'reasoning').length;
    firstUserMessage = earlier.find((m) => m.role === 'user')?.text ?? '';
    push('response_item', {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: `[Condensed history — the first ${earlier.length} messages of this session, summarized]\n${buildDigest(earlier, { maxChars: 24_000 })}`,
        },
      ],
    });
  }

  for (const m of toConvert) {
    switch (m.role) {
      case 'user': {
        const text = m.text ?? '';
        if (!text) break;
        if (!firstUserMessage) firstUserMessage = text;
        push('response_item', {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        });
        push('event_msg', { type: 'user_message', message: text });
        break;
      }
      case 'assistant': {
        const text = m.text ?? '';
        if (!text) break;
        push('response_item', {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
        push('event_msg', { type: 'agent_message', message: text });
        break;
      }
      case 'tool_call': {
        const call = translateToolCall(m.toolName ?? 'unknown', m.toolInput);
        push('response_item', {
          type: 'function_call',
          name: call.name,
          arguments: call.arguments,
          call_id: m.toolCallId ?? m.id,
        });
        break;
      }
      case 'tool_result': {
        push('response_item', {
          type: 'function_call_output',
          call_id: m.toolCallId ?? m.id,
          output: m.text ?? '',
        });
        break;
      }
      case 'reasoning':
        droppedReasoning++; // Anthropic-signed thinking has no faithful Codex mapping
        break;
    }
  }

  return {
    lines,
    threadId,
    relativePath: rolloutRelativePath(threadId, opts.now),
    droppedReasoning,
    title: session.title ?? firstUserMessage.slice(0, 80),
    firstUserMessage,
  };
}

export function serializeRollout(lines: RolloutLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}
