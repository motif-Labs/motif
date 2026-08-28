import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readClaudeSession } from '@motif/core';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude-code');
const fixture = (name: string) => path.join(fixtures, name);

describe('readClaudeSession', () => {
  it('parses a minimal two-turn session', () => {
    const s = readClaudeSession(fixture('minimal.jsonl'));
    expect(s.id).toBe('claude-code:minimal');
    expect(s.projectPath).toBe('/tmp/demo');
    expect(s.gitBranch).toBe('main');
    expect(s.title).toBe('Greeting session');
    expect(s.toolVersion).toBe('2.1.241');
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(s.messages[0]!.text).toBe('hello agent');
    expect(s.messages[1]!.text).toBe('hello human');
    expect(s.createdAt).toBe('2026-08-01T10:00:00.000Z');
    expect(s.updatedAt).toBe('2026-08-01T10:00:05.000Z');
  });

  it('follows the active path on a branched (rewound) session', () => {
    const s = readClaudeSession(fixture('branched.jsonl'));
    const texts = s.messages.map((m) => m.text);
    expect(texts).toEqual(['first question', 'first answer', 'rewound follow-up', 'active answer']);
    expect(texts).not.toContain('abandoned follow-up');
    expect(s.meta.branchCount).toBe(1);
  });

  it('falls back to the newest childless message when last-prompt is missing', () => {
    // corrupted.jsonl has no last-prompt line; active leaf must be a1
    const s = readClaudeSession(fixture('corrupted.jsonl'));
    expect(s.messages.map((m) => m.text)).toEqual(['still works?', 'yes']);
  });

  it('explodes assistant blocks, drops thinking signatures, walks through attachments', () => {
    const s = readClaudeSession(fixture('tools.jsonl'));
    expect(s.messages.map((m) => m.role)).toEqual([
      'user',
      'reasoning',
      'assistant',
      'tool_call',
      'tool_result',
      'assistant',
    ]);
    const reasoning = s.messages.find((m) => m.role === 'reasoning')!;
    expect(reasoning.text).toBe('I should look at the file first');
    expect(JSON.stringify(s)).not.toContain('SECRET_ANTHROPIC_SIG');

    const call = s.messages.find((m) => m.role === 'tool_call')!;
    expect(call.toolName).toBe('Edit');
    expect(call.toolCallId).toBe('toolu_001');
    expect(call.id).toBe('a1#2');

    const result = s.messages.find((m) => m.role === 'tool_result')!;
    expect(result.toolCallId).toBe('toolu_001');
    expect(result.text).toContain('has been updated');

    expect(s.filesTouched).toEqual(['/tmp/demo/app.ts']);
  });

  it('tolerates corrupted and unknown lines', () => {
    const s = readClaudeSession(fixture('corrupted.jsonl'));
    expect(s.meta.parseErrors).toBe(2); // bad json + truncated tail
    expect(s.messages.length).toBe(2);
  });
});
