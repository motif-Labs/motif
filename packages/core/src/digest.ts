/**
 * Compact plain-text digest of session messages for LLM consumption
 * (memory extraction, summaries). Token-frugal by construction: reasoning is
 * excluded, tool results are truncated hardest, and the whole digest is
 * capped — callers pass only the message window they care about.
 */

import type { MotifMessage } from './schema.js';

export interface DigestOptions {
  /** Rough character budget (~4 chars/token). Default 48_000 ≈ 12k tokens. */
  maxChars?: number;
  toolResultChars?: number;
}

export function buildDigest(messages: MotifMessage[], opts: DigestOptions = {}): string {
  const maxChars = opts.maxChars ?? 48_000;
  const toolResultChars = opts.toolResultChars ?? 300;
  const parts: string[] = [];

  for (const m of messages) {
    switch (m.role) {
      case 'user':
        if (m.text) parts.push(`USER: ${m.text}`);
        break;
      case 'assistant':
        if (m.text) parts.push(`ASSISTANT: ${m.text}`);
        break;
      case 'tool_call':
        parts.push(`TOOL ${m.toolName ?? '?'}: ${JSON.stringify(m.toolInput ?? {}).slice(0, 400)}`);
        break;
      case 'tool_result': {
        const text = (m.text ?? '').trim();
        if (text) {
          parts.push(
            `RESULT: ${text.length > toolResultChars ? `${text.slice(0, toolResultChars)}…` : text}`,
          );
        }
        break;
      }
      case 'reasoning':
        break; // never include internal reasoning in digests
    }
  }

  let digest = parts.join('\n');
  if (digest.length > maxChars) {
    // keep the tail — recent activity matters most for memory updates
    digest = `…(truncated)…\n${digest.slice(-maxChars)}`;
  }
  return digest;
}
