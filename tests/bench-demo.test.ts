/**
 * Locks the retrieval engine's quality against the built-in demo corpus, the
 * same measurement `npm run bench:demo` reports. If a change to ranking or
 * packing regresses answer-present rate or bloats the bundle, this fails.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, recall, type Db } from '@motif/server';
import { seedDemo } from '../packages/cli/src/demo/seed.js';

interface Question {
  q: string;
  project?: string;
  expect: string[];
}

let tmp: string;
let db: Db;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-benchtest-'));
  db = openDb(path.join(tmp, 'demo.db'));
  seedDemo(db);
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('retrieval quality on the demo corpus', () => {
  it('finds the answer for (almost) every question, in a tight bundle', () => {
    const questions = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'bench', 'questions.demo.json'), 'utf8'),
    ) as Question[];
    const viewer = (db.prepare('SELECT id FROM members LIMIT 1').get() as { id: number }).id;

    const results = questions.map((question) => {
      const r = recall(db, { query: question.q, project: question.project, budget: 1500, viewerId: viewer });
      const hay = r.items
        .map((i) => i.text)
        .join('\n')
        .toLowerCase();
      return { hit: question.expect.every((e) => hay.includes(e.toLowerCase())), tokens: r.tokensApprox };
    });

    const hits = results.filter((r) => r.hit).length;
    // the engine answers essentially all of them; a small margin guards against
    // incidental demo-seed drift without letting a real regression through
    expect(hits).toBeGreaterThanOrEqual(questions.length - 1);

    const tokens = results.map((r) => r.tokens).sort((a, b) => a - b);
    const median = tokens[Math.floor(tokens.length / 2)] ?? 0;
    // the bundle is tight: the budget is 1500, and the answer arrives in far less
    expect(median).toBeLessThan(800);
  });
});
