import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MotifMessage, MotifSession } from '@motif/core';
import {
  addComment,
  applyNotes,
  chunkText,
  fullReplaceSession,
  openDb,
  queryTerms,
  recall,
  registerMember,
  renderRecall,
  windowAround,
  type Db,
} from '@motif/server';

let tmp: string;
let db: Db;
let alice: number;
let bob: number;

const msg = (id: string, role: MotifMessage['role'], text: string): MotifMessage => ({
  id,
  role,
  timestamp: new Date().toISOString(),
  text,
});

const session = (
  id: string,
  project: string,
  messages: MotifMessage[],
  extra: Partial<MotifSession> = {},
): MotifSession => ({
  id: `claude-code:${id}`,
  source: 'claude-code',
  sourceSessionId: id,
  sourcePath: `/fake/${id}.jsonl`,
  projectPath: project,
  title: id,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  messages,
  filesTouched: [],
  meta: { subagentCount: 0, branchCount: 0, parseErrors: 0 },
  ...extra,
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-recall-'));
  db = openDb(path.join(tmp, 'db.sqlite'));
  alice = registerMember(db, { name: 'alice', email: 'a@x.dev' }).memberId;
  bob = registerMember(db, { name: 'bob', email: 'b@x.dev' }).memberId;
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('chunking and windows', () => {
  it('splits on paragraphs and merges tiny ones', () => {
    const chunks = chunkText(`${'a'.repeat(500)}\n\n${'b'.repeat(500)}\n\ntiny`, 800);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toContain('tiny');
  });

  it('quotes around the match, not the start of the text', () => {
    const text = `${'filler '.repeat(200)}the retry queue is idempotent because of the key`;
    const w = windowAround(text, ['idempotent'], 200);
    expect(w).toContain('idempotent');
    expect(w.length).toBeLessThan(260);
  });

  it('drops stopwords from the query', () => {
    expect(queryTerms('why did we choose the storage engine')).toEqual(['choose', 'storage', 'engine']);
  });
});

describe('recall', () => {
  it('finds the paragraph that answers the question and cites its session', () => {
    fullReplaceSession(
      db,
      alice,
      session('s1', '/w/api', [
        msg('u1', 'user', 'the payment retries double-charge people sometimes'),
        msg(
          'a1',
          'assistant',
          'Root cause found.\n\nEvery charge now writes an idempotency key before calling the provider, so a crashed worker reconciles pending keys instead of replaying the queue.',
        ),
      ]),
    );
    fullReplaceSession(
      db,
      alice,
      session('s2', '/w/api', [msg('u1', 'user', 'unrelated css tweak on the marketing page')]),
    );

    const r = recall(db, { query: 'how do we avoid double charging on retries', viewerId: alice });
    const text = r.items.map((i) => i.text).join('\n');
    expect(text).toContain('idempotency key');
    expect(text).not.toContain('marketing page');
    expect(r.items.some((i) => i.sessionId === 'claude-code:s1')).toBe(true);
    expect(renderRecall(r)).toContain('claude-code:s1');
  });

  it('puts distilled notes and human pins above raw transcript', () => {
    const row = fullReplaceSession(
      db,
      alice,
      session('s3', '/w/api', [
        msg('u1', 'user', 'what auth should we use'),
        msg('a1', 'assistant', 'Discussion about auth options went back and forth here.'),
      ]),
    );
    applyNotes(
      db,
      [
        {
          entity: { kind: 'decision', name: 'auth-method' },
          aspect: 'mechanism',
          body: 'Auth uses httpOnly session cookies; JWT-in-localStorage was retired.',
        },
      ],
      {
        projectPath: '/w/api',
        sessionPk: row.pk,
        memberId: alice,
      },
    );
    addComment(db, bob, row.pk, null, 'auth decision still holds for mobile too');

    const r = recall(db, { query: 'which auth mechanism did we pick', viewerId: alice });
    expect(r.items[0]!.kind).toBe('note');
    expect(r.items.map((i) => i.kind)).toContain('pin');
    expect(r.items.map((i) => i.text).join()).toContain('httpOnly');
  });

  it('never leaks a personal session, and respects the token budget', () => {
    fullReplaceSession(
      db,
      bob,
      session('secret', '/w/side', [msg('u1', 'user', 'my private side project uses widgets everywhere')], {
        visibility: 'personal',
      }),
    );
    fullReplaceSession(
      db,
      alice,
      session('open', '/w/api', [msg('u1', 'user', `widgets ${'and more widgets '.repeat(400)}`)]),
    );

    const asAlice = recall(db, { query: 'widgets', viewerId: alice, budget: 300 });
    expect(asAlice.items.map((i) => i.sessionId)).not.toContain('claude-code:secret');
    expect(asAlice.tokensApprox).toBeLessThanOrEqual(300 + 200); // one oversized item may be kept

    const asBob = recall(db, { query: 'widgets side project', viewerId: bob });
    expect(asBob.items.some((i) => i.sessionId === 'claude-code:secret')).toBe(true);
  });

  it('does not spend the budget on the same text synced twice', () => {
    const dup = 'We reverse engineered the codex rollout format and wrote it natively.';
    fullReplaceSession(db, alice, session('copy1', '/w/api', [msg('u1', 'user', dup)]));
    fullReplaceSession(db, alice, session('copy2', '/w/api', [msg('u1', 'user', dup)]));
    const r = recall(db, { query: 'codex rollout format', viewerId: alice });
    const copies = r.items.filter((i) => i.text.includes('reverse engineered')).length;
    expect(copies).toBe(1);
  });

  it('reports honestly when nothing matches', () => {
    const r = recall(db, { query: 'kubernetes helm charts', viewerId: alice });
    expect(r.items).toHaveLength(0);
    expect(renderRecall(r)).toContain('No prior team context');
  });
});
