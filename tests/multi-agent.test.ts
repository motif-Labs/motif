import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  isDormantHandoff,
  readClaudeSession,
  readCodexSession,
  serializeRollout,
  toRolloutLines,
  uuidv7,
} from '@motif/core';
import { loadCursorProjectMap, readCursorSession } from '../packages/cli/src/readers/cursor.js';
import { performCodexHandoff } from '../packages/cli/src/handoff/perform.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-agents-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('codex reader', () => {
  it('reads a real captured rollout: conversation kept, telemetry and injected context dropped', () => {
    const s = readCodexSession(path.join(root, 'fixtures', 'codex', 'rollout-captured-0.150.1.jsonl'));
    expect(s.source).toBe('codex');
    expect(s.sourceSessionId).toBe('01a049f4-8c89-7d83-a1a3-f3b2a68112e6');
    expect(s.projectPath).toContain('/scratchpad');
    expect(s.meta.model).toBe('gpt-5.6-sol');
    const texts = s.messages.map((m) => m.text ?? '');
    expect(texts).toContain('say hello and nothing else');
    // environment_context / skills_instructions user-items and developer items are injected, not conversation
    expect(texts.join()).not.toContain('<environment_context>');
    expect(texts.join()).not.toContain('skills_instructions');
    expect(s.title).toBe('say hello and nothing else');
  });

  it('round-trips a Claude session through the handoff writer', () => {
    const claude = readClaudeSession(path.join(root, 'fixtures', 'claude-code', 'tools.jsonl'));
    const now = new Date('2026-08-29T10:00:00.000Z');
    const rollout = toRolloutLines(claude, { threadId: uuidv7(now, () => 0.5), now });
    const file = path.join(tmp, `rollout-2026-08-29T10-00-00-${rollout.threadId}.jsonl`);
    fs.writeFileSync(file, serializeRollout(rollout.lines));

    const back = readCodexSession(file);
    const roles = back.messages.map((m) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    expect(roles).toContain('tool_call');
    expect(roles).toContain('tool_result');
    // original user prompt survives; provenance marker also comes back as a user line
    expect(back.messages.some((m) => m.text === 'fix the bug in app.ts')).toBe(true);
    const call = back.messages.find((m) => m.role === 'tool_call')!;
    expect(call.toolName).toBe('apply_patch');
  });

  it('dormant handoff copies are recognized and skipped; resumed ones are not', () => {
    const claude = readClaudeSession(path.join(root, 'fixtures', 'claude-code', 'minimal.jsonl'));
    const now = new Date();
    const rollout = toRolloutLines(claude, { threadId: uuidv7(now), now });
    const file = path.join(tmp, 'rollout-x.jsonl');
    fs.writeFileSync(file, serializeRollout(rollout.lines));
    expect(isDormantHandoff(file)).toBe(true);
    // codex appends turn_context the moment it resumes
    fs.appendFileSync(file, `${JSON.stringify({ timestamp: '', type: 'turn_context', payload: {} })}\n`);
    expect(isDormantHandoff(file)).toBe(false);
  });

  it('refuses codex → codex handoff with a helpful hint', () => {
    const s = readCodexSession(path.join(root, 'fixtures', 'codex', 'rollout-captured-0.150.1.jsonl'));
    expect(() => performCodexHandoff(s)).toThrow(/codex resume/);
  });
});

describe('cursor reader', () => {
  it('reads conversations from a cursorDiskKV store (headers + bubbles)', () => {
    const dbPath = path.join(tmp, 'state.vscdb');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
    const composerId = 'abc-123';
    db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(
      `composerData:${composerId}`,
      JSON.stringify({
        composerId,
        name: 'Fix the login bug',
        createdAt: 1756400000000,
        lastUpdatedAt: 1756400300000,
        fullConversationHeadersOnly: [
          { bubbleId: 'b1', type: 1 },
          { bubbleId: 'b2', type: 2 },
        ],
      }),
    );
    db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(
      `bubbleId:${composerId}:b1`,
      JSON.stringify({ type: 1, text: 'login form crashes on submit' }),
    );
    db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(
      `bubbleId:${composerId}:b2`,
      JSON.stringify({ type: 2, text: 'The handler throws because email is undefined — add a guard.' }),
    );
    db.close();

    const s = readCursorSession(composerId, dbPath);
    expect(s.source).toBe('cursor');
    expect(s.title).toBe('Fix the login bug');
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(s.messages[0]!.text).toContain('login form crashes');
    expect(s.updatedAt).toBe(new Date(1756400300000).toISOString());
  });

  it('maps composers to project paths via workspaceStorage', () => {
    // layout: <tmp>/User/globalStorage/state.vscdb + <tmp>/User/workspaceStorage/<hash>/…
    const userDir = path.join(tmp, 'User');
    const globalDb = path.join(userDir, 'globalStorage', 'state.vscdb');
    fs.mkdirSync(path.dirname(globalDb), { recursive: true });
    new Database(globalDb).close();

    const wsDir = path.join(userDir, 'workspaceStorage', 'abc123hash');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'workspace.json'), JSON.stringify({ folder: 'file:///Users/me/webapp' }));
    const wsDb = new Database(path.join(wsDir, 'state.vscdb'));
    wsDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    wsDb
      .prepare('INSERT INTO ItemTable VALUES (?, ?)')
      .run('composer.composerData', JSON.stringify({ allComposers: [{ composerId: 'conv-1' }, { composerId: 'conv-2' }] }));
    wsDb.close();

    const map = loadCursorProjectMap(globalDb);
    expect(map.get('conv-1')).toBe('/Users/me/webapp');
    expect(map.get('conv-2')).toBe('/Users/me/webapp');
    expect(map.has('unknown')).toBe(false);
  });
});
