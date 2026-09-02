/**
 * Retrieval benchmark: does a small Motif bundle actually contain the answer,
 * and how small is it compared with the history it replaces?
 *
 *   npx tsx bench/run.ts [--db <path>] [--questions <file>] [--budget 1500]
 *
 * This measures RETRIEVAL, deterministically and for free, no model calls, so
 * anyone can reproduce it on their own corpus. It deliberately does not claim
 * an end-to-end "we cut your bill by X%": that needs live agent runs, which are
 * nondeterministic and cost money (see the --live note in the README).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, recall, approxTokens, type Db } from '../packages/server/src/index.js';

interface Question {
  q: string;
  project?: string;
  expect: string[];
}

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const dbPath = arg('db') ?? process.env.MOTIF_DB_PATH ?? path.join(os.homedir(), '.motif', 'motif.db');
const questionsPath =
  arg('questions') ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'questions.json');
const budget = Number(arg('budget', '1500'));
const anyMember = (db.prepare('SELECT id FROM members LIMIT 1').get() as { id: number } | undefined)?.id;

if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Run \`motif up\` once, then retry.`);
  process.exit(1);
}

const db: Db = openDb(dbPath);
const questions = JSON.parse(fs.readFileSync(questionsPath, 'utf8')) as Question[];

/** Everything an agent would have to read to rediscover this by itself. */
function projectHistoryTokens(db: Db, project?: string): number {
  const row = project
    ? db
        .prepare(
          `SELECT SUM(LENGTH(m.content_json)) AS chars FROM messages m
           JOIN sessions s ON s.pk = m.session_pk WHERE s.project_path = ?`,
        )
        .get(project)
    : db.prepare('SELECT SUM(LENGTH(content_json)) AS chars FROM messages').get();
  return Math.ceil(((row as { chars: number | null })?.chars ?? 0) / 4);
}

const corpusTokens = projectHistoryTokens(db);
const rows: { q: string; hit: boolean; tokens: number; items: number; sessions: number }[] = [];

for (const question of questions) {
  const result = recall(db, {
    query: question.q,
    project: question.project,
    budget,
    // the benchmark runs on the owner's own corpus, measure what THEY would
    // see, or personal-sourced notes silently vanish from the score
    viewerId: anyMember,
  });
  const haystack = result.items
    .map((i) => i.text)
    .join('\n')
    .toLowerCase();
  const hit = question.expect.every((e) => haystack.includes(e.toLowerCase()));
  rows.push({
    q: question.q,
    hit,
    tokens: result.tokensApprox,
    items: result.items.length,
    sessions: new Set(result.items.map((i) => i.sessionId).filter(Boolean)).size,
  });
}

const hits = rows.filter((r) => r.hit).length;
const tokens = rows.map((r) => r.tokens).sort((a, b) => a - b);
const median = tokens[Math.floor(tokens.length / 2)] ?? 0;

console.log(`# Motif retrieval benchmark\n`);
console.log(
  `Corpus: ${corpusTokens.toLocaleString()} tokens of session history · budget ${budget} tokens/answer\n`,
);
console.log('| question | answer present | tokens | items | sessions cited |');
console.log('|---|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.q} | ${r.hit ? '✅' : '-'} | ${r.tokens} | ${r.items} | ${r.sessions} |`);
}
console.log(
  `\n**hit rate ${hits}/${rows.length} (${Math.round((hits / rows.length) * 100)}%)** · median ${median} tokens per answer · ` +
    `**${(corpusTokens / Math.max(median, 1)).toFixed(0)}× smaller** than the history it draws from.`,
);
console.log(
  `\n_Measured on this machine's own corpus with \`npx tsx bench/run.ts\`. Write your own bench/questions.json to reproduce on yours._`,
);
