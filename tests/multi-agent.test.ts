import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  isDormantHandoff,
  mangleProjectPath,
  readClaudeSession,
  readCodexSession,
  serializeClaudeSession,
  serializeRollout,
  toClaudeSessionLines,
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
  it('reads a Codex 0.150.1 rollout: conversation kept, telemetry and injected context dropped', () => {
    const s = readCodexSession(path.join(root, 'fixtures', 'codex', 'rollout-0.150.1.jsonl'));
    expect(s.source).toBe('codex');
    expect(s.sourceSessionId).toBe('01a04900-1111-7d83-a1a3-b0b0b0b0b0b0');
    expect(s.projectPath).toContain('/example-project');
    expect(s.meta.model).toBe('gpt-5.6-sol');
    const texts = s.messages.map((m) => m.text ?? '');
    expect(texts).toContain('list the files in this directory');
    // environment_context / skills_instructions user-items and developer items are injected, not conversation
    expect(texts.join()).not.toContain('<environment_context>');
    expect(texts.join()).not.toContain('skills_instructions');
    expect(s.title).toBe('list the files in this directory');
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

  it('refuses codex → codex handoff only when the rollout is already local', () => {
    const s = readCodexSession(path.join(root, 'fixtures', 'codex', 'rollout-0.150.1.jsonl'));
    const prevHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(tmp, 'codex-home'); // never touch the real ~/.codex
    try {
      expect(() => performCodexHandoff(s)).toThrow(/codex resume/); // fixture exists on disk
      // the same session synced from a teammate's machine (path not present here) converts fine
      const remote = { ...s, sourcePath: '/somebody/elses/machine/rollout.jsonl' };
      const result = performCodexHandoff(remote, { force: true });
      expect(fs.existsSync(result.target)).toBe(true);
      expect(result.target.startsWith(process.env.CODEX_HOME!)).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevHome;
    }
  });
});

describe('claude-code writer (reverse handoff)', () => {
  it('round-trips a Codex session into a Claude Code transcript our own reader accepts', () => {
    const codex = readCodexSession(path.join(root, 'fixtures', 'codex', 'rollout-0.150.1.jsonl'));
    const result = toClaudeSessionLines(codex, {
      sessionId: '11111111-2222-4333-8444-555555555555',
      now: new Date('2026-08-29T12:00:00.000Z'),
      toolVersion: '2.1.250',
    });
    expect(result.relativePath).toBe(
      `projects/${mangleProjectPath(codex.projectPath)}/11111111-2222-4333-8444-555555555555.jsonl`,
    );

    const dir = path.join(tmp, 'projects', mangleProjectPath(codex.projectPath));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${result.sessionId}.jsonl`);
    fs.writeFileSync(file, serializeClaudeSession(result.lines));

    const back = readClaudeSession(file);
    expect(back.projectPath).toBe(codex.projectPath);
    expect(back.title).toBe(codex.title);
    expect(back.messages.some((m) => m.text?.includes('Handed off from Codex session'))).toBe(true);
    expect(back.messages.some((m) => m.text === 'list the files in this directory')).toBe(true);
    expect(back.meta.parseErrors).toBe(0);
    // conversation chain is linear and complete (no dropped links)
    expect(back.messages.length).toBeGreaterThanOrEqual(2);
  });

  it('renders tool activity as readable text, batched into single turns', () => {
    const claude = readClaudeSession(path.join(root, 'fixtures', 'claude-code', 'tools.jsonl'));
    const result = toClaudeSessionLines(claude, {
      sessionId: 'aaaa1111-0000-4000-8000-000000000000',
      now: new Date(),
    });
    const all = serializeClaudeSession(result.lines);
    expect(all).toContain('[ran Edit]');
    expect(all).toContain('has been updated');
    expect(all).not.toContain('SECRET_ANTHROPIC_SIG'); // reasoning never crosses
    expect(result.droppedReasoning).toBe(1);
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
      JSON.stringify({ type: 2, text: 'The handler throws because email is undefined, add a guard.' }),
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
    fs.writeFileSync(
      path.join(wsDir, 'workspace.json'),
      JSON.stringify({ folder: 'file:///Users/me/webapp' }),
    );
    const wsDb = new Database(path.join(wsDir, 'state.vscdb'));
    wsDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    wsDb
      .prepare('INSERT INTO ItemTable VALUES (?, ?)')
      .run(
        'composer.composerData',
        JSON.stringify({ allComposers: [{ composerId: 'conv-1' }, { composerId: 'conv-2' }] }),
      );
    wsDb.close();

    const map = loadCursorProjectMap(globalDb);
    expect(map.get('conv-1')).toBe('/Users/me/webapp');
    expect(map.get('conv-2')).toBe('/Users/me/webapp');
    expect(map.has('unknown')).toBe(false);
  });
});
