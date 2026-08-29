import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readClaudeSession,
  rolloutRelativePath,
  serializeRollout,
  toRolloutLines,
  translateToolCall,
  uuidv7,
} from '@motif/core';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_NOW = new Date('2026-08-29T10:00:00.000Z');
const FIXED_ID = uuidv7(FIXED_NOW, () => 0.5);

function convertToolsFixture() {
  const session = readClaudeSession(path.join(root, 'fixtures', 'claude-code', 'tools.jsonl'));
  return toRolloutLines(session, { threadId: FIXED_ID, now: FIXED_NOW });
}

describe('codex writer', () => {
  it('uuidv7 is well-formed and time-ordered', () => {
    const a = uuidv7(new Date('2026-01-01T00:00:00Z'), () => 0.5);
    const b = uuidv7(new Date('2026-06-01T00:00:00Z'), () => 0.5);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  it('computes the date-partitioned rollout path from handoff time', () => {
    expect(rolloutRelativePath('abc', FIXED_NOW)).toBe(
      'sessions/2026/08/29/rollout-2026-08-29T10-00-00-abc.jsonl',
    );
  });

  it('matches the envelope shape of a real captured Codex 0.150.1 rollout', () => {
    const captured = fs
      .readFileSync(path.join(root, 'fixtures', 'codex', 'rollout-captured-0.150.1.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const ours = convertToolsFixture().lines;

    // every line carries the same envelope keys as the real file
    for (const line of ours) {
      expect(Object.keys(line).sort()).toEqual(['ordinal', 'payload', 'timestamp', 'type']);
      expect(typeof line.ordinal).toBe('number');
    }
    // ordinals dense from 0, like the capture
    expect(ours.map((l) => l.ordinal)).toEqual(ours.map((_, i) => i));

    // session_meta first, with every required field the real capture has
    const realMeta = captured[0]!.payload as Record<string, unknown>;
    const ourMeta = ours[0]!.payload as Record<string, unknown>;
    expect(ours[0]!.type).toBe('session_meta');
    for (const key of ['session_id', 'id', 'timestamp', 'cwd', 'originator', 'cli_version', 'source', 'model_provider']) {
      expect(realMeta).toHaveProperty(key);
      expect(ourMeta).toHaveProperty(key);
    }

    // user response_item matches the captured shape exactly (sans metadata passthrough)
    const realUser = captured.find(
      (l) => l.type === 'response_item' && (l.payload as { role?: string }).role === 'user' &&
        !JSON.stringify(l.payload).includes('environment_context'),
    )!.payload as Record<string, unknown>;
    const ourUser = ours.find(
      (l) => l.type === 'response_item' && (l.payload as { role?: string }).role === 'user',
    )!.payload as { type: string; content: { type: string }[] };
    expect(ourUser.type).toBe((realUser as { type: string }).type);
    expect(ourUser.content[0]!.type).toBe(
      (realUser as { content: { type: string }[] }).content[0]!.type,
    );
  });

  it('converts tool calls with string arguments and matching call ids', () => {
    const { lines } = convertToolsFixture();
    const call = lines.find((l) => l.type === 'response_item' && (l.payload as { type?: string }).type === 'function_call')!
      .payload as { name: string; arguments: string; call_id: string };
    expect(call.name).toBe('apply_patch'); // Claude Edit → apply_patch envelope
    expect(typeof call.arguments).toBe('string');
    expect(() => JSON.parse(call.arguments)).not.toThrow();
    expect(JSON.parse(call.arguments).input).toContain('*** Update File: /tmp/demo/app.ts');

    const output = lines.find(
      (l) => l.type === 'response_item' && (l.payload as { type?: string }).type === 'function_call_output',
    )!.payload as { call_id: string; output: string };
    expect(output.call_id).toBe(call.call_id);
    expect(typeof output.output).toBe('string');
  });

  it('drops reasoning, keeps a provenance marker, emits legacy UI events', () => {
    const result = convertToolsFixture();
    expect(result.droppedReasoning).toBe(1);
    const all = serializeRollout(result.lines);
    expect(all).not.toContain('I should look at the file first');
    expect(all).toContain('Handed off from Claude Code session');
    const events = result.lines.filter((l) => l.type === 'event_msg').map((l) => (l.payload as { type: string }).type);
    expect(events).toContain('user_message');
    expect(events).toContain('agent_message');
  });

  it('tool translation table covers the core vocabulary', () => {
    expect(JSON.parse(translateToolCall('Bash', { command: 'ls -la' }).arguments)).toEqual({
      command: ['bash', '-lc', 'ls -la'],
    });
    expect(translateToolCall('Read', { file_path: '/a b.ts' }).arguments).toContain("'/a b.ts'");
    expect(translateToolCall('Write', { file_path: '/x.ts', content: 'a\nb' }).name).toBe('apply_patch');
    expect(translateToolCall('WebFetch', { url: 'https://x' }).name).toBe('WebFetch'); // passthrough
  });
});
