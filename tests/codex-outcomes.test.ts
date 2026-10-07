import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCodexSession, readToolOutcome, type MotifSession } from '@motif/core';
import { extractRecovery } from '../packages/server/src/learning/extract.js';

const fixture = (name: string) => path.join(process.cwd(), 'fixtures/codex', name);

const result = (s: MotifSession, callId: string) =>
  s.messages.find((m) => m.role === 'tool_result' && m.toolCallId === callId);

const context = (s: MotifSession) => ({
  sessionId: s.id,
  source: s.source,
  project: s.projectPath,
  identity: s.id,
  copied: false,
  parseErrors: s.meta.parseErrors,
});

describe('Codex tool outcomes', () => {
  const s = readCodexSession(fixture('tool-results.jsonl'));

  it('reads the fixture without parse errors and pairs calls with results', () => {
    expect(s.id).toBe('codex:0b0b0b0b-2222-7000-8000-000000000001');
    expect(s.meta.parseErrors).toBe(0);
    expect(s.messages.filter((m) => m.role === 'tool_call')).toHaveLength(13);
    expect(s.messages.filter((m) => m.role === 'tool_result')).toHaveLength(12);
  });

  it('keeps explicit exit codes from successful and failed native envelopes', () => {
    expect(result(s, 'call_ok')!.toolResult).toEqual({ exitCode: 0, terminal: true });
    expect(result(s, 'call_fail')!.toolResult).toEqual({ exitCode: 1, terminal: true });
  });

  it('keeps explicit exit codes from structured JSON receipts', () => {
    expect(result(s, 'call_json_ok')!.toolResult).toEqual({ exitCode: 0, terminal: true });
    expect(result(s, 'call_json_fail')!.toolResult).toEqual({ exitCode: 101, terminal: true });
  });

  it('leaves a still-running process unknown, and does not move a later poll exit onto it', () => {
    expect(result(s, 'call_running')!.toolResult).toBeUndefined();
    expect(result(s, 'call_running')!.text).toContain('Process running with session ID 7');
    expect(result(s, 'call_poll')!.toolResult).toEqual({ exitCode: 130, terminal: true });
  });

  it('never infers an outcome from prose or malformed receipts', () => {
    for (const id of [
      'call_prose',
      'call_string_code',
      'call_float_code',
      'call_no_exit_line',
      'call_aborted',
    ]) {
      expect(result(s, id)!.toolResult, id).toBeUndefined();
      expect(readToolOutcome(result(s, id)!.text), id).toBeUndefined();
    }
  });

  it('keeps unparseable arguments as the raw string', () => {
    const call = s.messages.find((m) => m.role === 'tool_call' && m.toolCallId === 'call_bad_args')!;
    expect(call.toolInput).toBe('{"cmd":"npm test"');
    expect(result(s, 'call_bad_args')!.toolResult).toBeUndefined();
  });

  it('records an interrupted call with no result rather than inventing one', () => {
    const call = s.messages.find((m) => m.toolCallId === 'call_interrupted' && m.role === 'tool_call');
    expect(call).toBeDefined();
    expect(result(s, 'call_interrupted')).toBeUndefined();
  });

  it('extraction only counts terminal exit codes as failures', () => {
    const { decisions, summary } = extractRecovery(s.messages, context(s));
    expect(decisions).toHaveLength(0);
    expect(summary).toEqual({
      toolCalls: 13,
      observedFailures: 2,
      candidates: 0,
      excluded: {
        'unrelated-next-action': 2,
        'unknown-exit': 6,
        'unsupported-command': 2,
        'ambiguous-or-missing-result': 1,
      },
    });
  });
});

describe('Codex truncated rollout', () => {
  const s = readCodexSession(fixture('tool-results-truncated.jsonl'));

  it('counts a garbage line as a parse error and leaves a cut-off envelope unknown', () => {
    expect(s.meta.parseErrors).toBe(1);
    expect(s.messages.map((m) => m.role)).toEqual(['tool_call', 'tool_result', 'tool_call', 'tool_result']);
    expect(result(s, 'call_a')!.toolResult).toEqual({ exitCode: 1, terminal: true });
    expect(result(s, 'call_b')!.toolResult).toBeUndefined();
  });

  it('counts a partially written last line as a parse error', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-codex-outcomes-'));
    try {
      const file = path.join(tmp, 'rollout.jsonl');
      const half =
        '{"timestamp":"2026-03-02T10:00:05.000Z","ordinal":5,"type":"response_item","payload":{"type":"fun';
      fs.writeFileSync(file, fs.readFileSync(fixture('tool-results-truncated.jsonl'), 'utf8') + half);
      const partial = readCodexSession(file);
      expect(partial.meta.parseErrors).toBe(2);
      expect(partial.messages).toEqual(s.messages);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('is excluded from extraction as a whole', () => {
    const { decisions, summary } = extractRecovery(s.messages, context(s));
    expect(decisions).toHaveLength(0);
    expect(summary.excluded).toEqual({ 'parse-errors': 1 });
  });
});
