import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listReviewQueue, openDb, recall, type Db } from '@motif/server';
import { seedDemo } from '../packages/cli/src/demo/seed.js';

let tmp: string;
let db: Db;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-demo-seed-'));
  db = openDb(path.join(tmp, 'db.sqlite'));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the built-in demo seed', () => {
  it('stages the whole story: sessions, a conflict to rule on, a stale note, a verified one', () => {
    const result = seedDemo(db);
    expect(result.sessions).toBe(9);
    expect(result.members.map((m) => m.name).sort()).toEqual(['ada', 'ben', 'cleo', 'iris', 'you']);

    const queue = listReviewQueue(db, undefined);
    const types = queue.map((i) => i.type).sort();
    expect(types).toEqual(['conflict', 'stale']);

    // the conflict shows both sides, each citing its session
    const conflict = queue.find((i) => i.type === 'conflict')!;
    expect(conflict.against!.session_id).toContain('demo-rate-limit');
    expect(conflict.note.session_id).toContain('demo-runbook');

    // recall crosses people and tools, and carries authority marks
    const out = recall(db, { query: 'why do we fail open when redis is down', budget: 1500 });
    const rendered = out.items.map((i) => i.text).join('\n');
    expect(rendered).toContain('CONFLICTED');
    expect(rendered).toContain('possibly stale');

    const verified = recall(db, { query: 'idempotency retried payment double-charge', budget: 1500 });
    expect(verified.items.some((i) => i.why.includes('human-verified'))).toBe(true);

    // the seed never wrote outside the database it was handed (WAL sidecars are the db's own)
    expect(fs.readdirSync(tmp).every((f) => f.startsWith('db.sqlite'))).toBe(true);
  });
});
