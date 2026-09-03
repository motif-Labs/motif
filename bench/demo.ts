/**
 * Reproducible retrieval benchmark on the built-in demo corpus.
 *
 *   npm run bench:demo
 *
 * Unlike `bench/run.ts` (which measures YOUR own ~/.motif corpus), this seeds a
 * throwaway copy of the `motif demo` team and asks a fixed set of questions, so
 * anyone gets the same numbers on any machine, with no model calls and nothing
 * to pay for. It reports the answer-present rate and how few tokens each answer
 * takes compared with the raw history it replaces.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, recall } from '../packages/server/src/index.js';
import { seedDemo } from '../packages/cli/src/demo/seed.js';

interface Question {
  q: string;
  project?: string;
  expect: string[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const questions = JSON.parse(fs.readFileSync(path.join(here, 'questions.demo.json'), 'utf8')) as Question[];
const budget = 1500;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-bench-demo-'));
const db = openDb(path.join(tmp, 'demo.db'));
seedDemo(db);
const viewer = (db.prepare('SELECT id FROM members LIMIT 1').get() as { id: number } | undefined)?.id;

const corpusTokens = Math.ceil(
  ((db.prepare('SELECT SUM(LENGTH(content_json)) AS c FROM messages').get() as { c: number | null }).c ?? 0) /
    4,
);

const rows = questions.map((question) => {
  const result = recall(db, { query: question.q, project: question.project, budget, viewerId: viewer });
  const haystack = result.items
    .map((i) => i.text)
    .join('\n')
    .toLowerCase();
  return {
    q: question.q,
    hit: question.expect.every((e) => haystack.includes(e.toLowerCase())),
    tokens: result.tokensApprox,
    items: result.items.length,
  };
});

const hits = rows.filter((r) => r.hit).length;
const tokens = rows.map((r) => r.tokens).sort((a, b) => a - b);
const median = tokens[Math.floor(tokens.length / 2)] ?? 0;

console.log('# Motif retrieval benchmark (built-in demo corpus)\n');
console.log(`Corpus: ${corpusTokens.toLocaleString()} tokens of history · budget ${budget} tokens/answer\n`);
console.log('| question | answer present | tokens | items |');
console.log('|---|---|---|---|');
for (const r of rows) console.log(`| ${r.q} | ${r.hit ? 'yes' : 'no'} | ${r.tokens} | ${r.items} |`);
console.log(
  `\n**answer present ${hits}/${rows.length} (${Math.round((hits / rows.length) * 100)}%)** · ` +
    `median ${median} tokens per answer · **${(corpusTokens / Math.max(median, 1)).toFixed(0)}x smaller** than the history.`,
);
fs.rmSync(tmp, { recursive: true, force: true });
