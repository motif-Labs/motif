/**
 * MotifSession → Claude Code session conversion (the reverse handoff:
 * ran out of Codex limits? carry the session into Claude Code).
 *
 * Format pinned by our own reader and real transcripts: one JSON line per
 * event in ~/.claude/projects/<mangled-cwd>/<sessionId>.jsonl, conversation
 * chained via parentUuid, `last-prompt` pointing at the leaf, `ai-title`
 * carrying the display title. Tool activity is rendered as readable text —
 * handed-off history is context for the model, not a replayable trace, and
 * plain text survives every Claude Code version.
 */

import type { MotifMessage, MotifSession } from '../schema.js';

export interface ClaudeLine {
  [key: string]: unknown;
}

export interface ClaudeConvertOptions {
  sessionId: string;
  now: Date;
  /** Mirrors the locally installed Claude Code version string. */
  toolVersion?: string;
  provenance?: string;
}

export interface ClaudeConvertResult {
  lines: ClaudeLine[];
  sessionId: string;
  /** Relative to ~/.claude: projects/<mangled>/<id>.jsonl */
  relativePath: string;
  droppedReasoning: number;
  title: string;
}

/** Claude Code's project dir name: the cwd with every path separator → '-'. */
export function mangleProjectPath(cwd: string): string {
  return cwd.replace(/[\\/:]/g, '-');
}

function toolCallText(m: MotifMessage): string {
  const input = JSON.stringify(m.toolInput ?? {});
  return `[ran ${m.toolName ?? 'tool'}] ${input.length > 300 ? `${input.slice(0, 300)}…` : input}`;
}

function toolResultText(m: MotifMessage): string {
  const text = (m.text ?? '').trim();
  return `[${m.toolName ?? 'tool'} output]\n${text.length > 400 ? `${text.slice(0, 400)}…` : text}`;
}

export function toClaudeSessionLines(session: MotifSession, opts: ClaudeConvertOptions): ClaudeConvertResult {
  const { sessionId } = opts;
  const cwd = session.projectPath || '/';
  const version = opts.toolVersion ?? '2.1.250';
  const nowIso = opts.now.toISOString();

  const lines: ClaudeLine[] = [];
  let parentUuid: string | null = null;
  let seq = 0;
  let droppedReasoning = 0;

  const envelope = (ts: string) => ({
    isSidechain: false,
    userType: 'external' as const,
    cwd,
    sessionId,
    version,
    ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
    timestamp: ts || nowIso,
  });

  const pushUser = (text: string, ts: string): void => {
    const uuid = `${sessionId.slice(0, 8)}-mu-${String(seq++).padStart(4, '0')}`;
    lines.push({
      parentUuid,
      type: 'user',
      message: { role: 'user', content: text },
      uuid,
      ...envelope(ts),
    });
    parentUuid = uuid;
  };

  const pushAssistant = (text: string, ts: string): void => {
    const uuid = `${sessionId.slice(0, 8)}-ma-${String(seq++).padStart(4, '0')}`;
    lines.push({
      parentUuid,
      type: 'assistant',
      message: {
        id: `msg_motif_${uuid}`,
        type: 'message',
        role: 'assistant',
        model: session.meta.model ?? 'unknown',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      uuid,
      ...envelope(ts),
    });
    parentUuid = uuid;
  };

  const provenance =
    opts.provenance ??
    `[Handed off from ${session.source} session ${session.sourceSessionId} via Motif on ${nowIso.slice(0, 10)}. The conversation below is the prior history of this task; continue where it left off.]`;
  pushUser(provenance, nowIso);

  // batch consecutive tool activity into single readable turns
  let toolBuffer: string[] = [];
  let toolBufferTs = '';
  const flushTools = (): void => {
    if (toolBuffer.length === 0) return;
    pushAssistant(toolBuffer.join('\n\n'), toolBufferTs);
    toolBuffer = [];
  };

  for (const m of session.messages) {
    switch (m.role) {
      case 'user':
        flushTools();
        if (m.text) pushUser(m.text, m.timestamp);
        break;
      case 'assistant':
        flushTools();
        if (m.text) pushAssistant(m.text, m.timestamp);
        break;
      case 'tool_call':
        if (toolBuffer.length === 0) toolBufferTs = m.timestamp;
        toolBuffer.push(toolCallText(m));
        break;
      case 'tool_result':
        if (m.text?.trim()) {
          if (toolBuffer.length === 0) toolBufferTs = m.timestamp;
          toolBuffer.push(toolResultText(m));
        }
        break;
      case 'reasoning':
        droppedReasoning++;
        break;
    }
  }
  flushTools();

  const title =
    session.title ??
    session.messages
      .find((m) => m.role === 'user')
      ?.text?.replace(/\s+/g, ' ')
      .slice(0, 80) ??
    'Handed-off session';
  lines.push({ type: 'ai-title', aiTitle: title.slice(0, 120), sessionId });
  lines.push({
    type: 'last-prompt',
    lastPrompt:
      [...session.messages]
        .reverse()
        .find((m) => m.role === 'user')
        ?.text?.slice(0, 200) ?? provenance.slice(0, 200),
    leafUuid: parentUuid,
    sessionId,
  });

  return {
    lines,
    sessionId,
    relativePath: `projects/${mangleProjectPath(cwd)}/${sessionId}.jsonl`,
    droppedReasoning,
    title,
  };
}

export function serializeClaudeSession(lines: ClaudeLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}
