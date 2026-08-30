/**
 * Context retrieval — the engine behind `motif recall` and the MCP server.
 *
 * Deliberately NOT a vector index: no embeddings, no model calls, nothing to
 * pay for. Relevance comes from three deterministic signals that a human can
 * audit, and every returned item carries the reason it was picked:
 *
 *   1. term match   — FTS5/bm25 over message text (message-level, so an
 *                     excerpt can be cited exactly)
 *   2. graph        — sessions linked by handoff lineage, shared memory
 *                     entities, or overlapping touched files
 *   3. curation     — distilled memory notes and human-pinned comments,
 *                     which are worth far more per token than raw transcript
 *
 * Results are packed to a token budget: curated knowledge first (highest
 * signal per token), raw excerpts after, because the point of the whole
 * exercise is handing an agent 1-2k useful tokens instead of it re-deriving
 * everything from scratch.
 */

import type { Db } from './db/database.js';
import { canView, type SessionRow } from './store.js';

export const approxTokens = (text: string): number => Math.ceil(text.length / 4);

const STOPWORDS = new Set([
  'the','a','an','and','or','but','is','are','was','were','be','been','to','of','in','on','for','with',
  'what','why','how','when','where','which','who','did','do','does','we','i','you','it','this','that',
  'ne','neden','nasil','nasıl','nedir','icin','için','ile','bir','bu','şu','su','mi','mı','ve','veya',
]);

export function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_/.-]+/gu, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 2 && !STOPWORDS.has(t)),
    ),
  ];
}

/**
 * Search is AND ("find the session with these words"); recall is OR ("find
 * whatever relates to this question") — a natural-language question almost
 * never has all its words in one message. bm25 then ranks the messages that
 * matched the most, and the rarest, terms.
 */
export function ftsOrQuery(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * FTS matches with a stemmer ("charging" finds "charge"), so scoring must too
 * — otherwise the paragraph FTS just found gets thrown away for not containing
 * the exact word. A short prefix is a cheap stand-in for a stemmer.
 */
function termHitIndex(lower: string, term: string): number {
  const direct = lower.indexOf(term);
  if (direct !== -1) return direct;
  if (term.length < 6) return -1;
  return lower.indexOf(term.slice(0, Math.max(4, term.length - 3)));
}

/** How many of the query's terms appear in a piece of text (0..1). */
function termCoverage(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lower = text.toLowerCase();
  return terms.filter((t) => termHitIndex(lower, t) !== -1).length / terms.length;
}

/**
 * Split a message into paragraph-sized chunks so the bundle can quote the
 * paragraph that answers the question instead of wherever the message happens
 * to start. Long paragraphs are hard-capped; tiny ones are merged.
 */
export function chunkText(text: string, target = 800): string[] {
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  let buf = '';
  for (const para of paras) {
    const piece = para.length > target * 2 ? `${para.slice(0, target * 2)}…` : para;
    if (!buf) buf = piece;
    else if (buf.length + piece.length <= target) buf += `\n${piece}`;
    else {
      out.push(buf);
      buf = piece;
    }
    if (buf.length >= target) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Same text synced twice (handoff copies, re-imports) must not eat the budget twice. */
function dedupeKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * The answer usually sits next to the words you searched for, not at the top
 * of a long paragraph — so quote the window around the first match.
 */
export function windowAround(text: string, terms: string[], width: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= width) return trimmed;
  const lower = trimmed.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = termHitIndex(lower, t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return `${trimmed.slice(0, width)}…`;
  const before = Math.floor(width * 0.35);
  const start = Math.max(0, at - before);
  const end = Math.min(trimmed.length, start + width);
  return `${start > 0 ? '…' : ''}${trimmed.slice(start, end)}${end < trimmed.length ? '…' : ''}`;
}

/** Fresh knowledge beats stale knowledge; 30-day half-life. */
function recencyScore(iso: string | null | undefined): number {
  if (!iso) return 0.3;
  const days = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  if (!Number.isFinite(days)) return 0.3;
  return Math.pow(0.5, Math.max(0, days) / 30);
}

export type RecallKind = 'note' | 'pin' | 'excerpt';

export interface RecallItem {
  kind: RecallKind;
  text: string;
  why: string;
  sessionId?: string;
  sessionTitle?: string | null;
  member?: string | null;
  when?: string | null;
  score: number;
  tokens: number;
  /** Ordering class: 0 distilled note, 1 matching human note, 2 excerpt, 3 context-only note. */
  priority: number;
}

export interface RecallRelated {
  sessionId: string;
  title: string | null;
  member: string | null;
  updatedAt: string | null;
  why: string;
}

export interface RecallResult {
  query: string;
  project?: string;
  items: RecallItem[];
  related: RecallRelated[];
  tokensApprox: number;
  /** Diagnostics that make the ranking auditable. */
  stats: { candidateSessions: number; termHits: number; graphHops: number; budget: number };
}

export interface RecallOptions {
  query: string;
  project?: string;
  viewerId?: number;
  /** Approximate token ceiling for the returned bundle. Default 1500. */
  budget?: number;
  /** Excerpt truncation, in characters. Default 700. */
  excerptChars?: number;
}

interface SessionMeta {
  pk: number;
  id: string;
  title: string | null;
  member: string | null;
  member_id: number;
  project_path: string;
  updated_at: string | null;
  files_touched: string;
  visibility: 'team' | 'personal';
}

function visibleSessions(db: Db, project: string | undefined, viewerId: number | undefined): Map<number, SessionMeta> {
  const rows = db
    .prepare(
      `SELECT s.pk, s.id, s.title, s.member_id, s.project_path, s.updated_at, s.files_touched, s.visibility,
              m.name AS member
       FROM sessions s LEFT JOIN members m ON m.id = s.member_id
       ${project ? 'WHERE s.project_path = ?' : ''}`,
    )
    .all(...(project ? [project] : [])) as (SessionMeta & { member_id: number })[];
  const map = new Map<number, SessionMeta>();
  for (const r of rows) {
    if (canView({ visibility: r.visibility, member_id: r.member_id }, viewerId)) map.set(r.pk, r);
  }
  return map;
}

/** Jaccard overlap of two touched-file lists. */
function fileOverlap(a: string, b: string): number {
  try {
    const A = new Set(JSON.parse(a) as string[]);
    const B = new Set(JSON.parse(b) as string[]);
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const f of A) if (B.has(f)) inter++;
    return inter === 0 ? 0 : inter / (A.size + B.size - inter);
  } catch {
    return 0;
  }
}

export function recall(db: Db, opts: RecallOptions): RecallResult {
  const budget = opts.budget ?? 1500;
  const excerptChars = opts.excerptChars ?? 700;
  const terms = queryTerms(opts.query);
  const sessions = visibleSessions(db, opts.project, opts.viewerId);

  // ── 1. term matches (message-level bm25) ────────────────────────────────
  interface Hit { sessionPk: number; messageId: string; text: string; rank: number }
  let hits: Hit[] = [];
  if (terms.length > 0) {
    try {
      hits = db
        .prepare(
          `SELECT session_pk AS sessionPk, message_id AS messageId, text, rank
           FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT 240`,
        )
        .all(ftsOrQuery(terms)) as Hit[];
    } catch {
      hits = []; // malformed match expression — fall back to graph/curation only
    }
  }
  hits = hits.filter((h) => sessions.has(h.sessionPk));

  // bm25 returns negative numbers (more negative = better); map to 0..1
  const ranks = hits.map((h) => h.rank);
  const best = Math.min(...ranks, 0);
  const normRank = (r: number) => (best === 0 ? 0.5 : Math.max(0, Math.min(1, r / best)));

  const sessionTermScore = new Map<number, number>();
  for (const h of hits) {
    const s = normRank(h.rank);
    sessionTermScore.set(h.sessionPk, Math.max(sessionTermScore.get(h.sessionPk) ?? 0, s));
  }

  // ── 2. graph expansion (1 hop from the strongest term hits) ─────────────
  const seeds = [...sessionTermScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([pk]) => pk);
  const graphBoost = new Map<number, { score: number; why: string }>();
  const addEdge = (pk: number, score: number, why: string): void => {
    if (!sessions.has(pk) || seeds.includes(pk)) return;
    const prev = graphBoost.get(pk);
    if (!prev || prev.score < score) graphBoost.set(pk, { score, why });
  };

  if (seeds.length > 0) {
    const inSeeds = seeds.map(() => '?').join(',');
    // handoff lineage: the strongest link — one session literally continues another
    for (const row of db
      .prepare(
        `SELECT h.session_pk AS fromPk, s2.pk AS toPk
         FROM handoffs h JOIN sessions s2 ON s2.source_session_id = h.target_session_id
         WHERE h.session_pk IN (${inSeeds}) OR s2.pk IN (${inSeeds})`,
      )
      .all(...seeds, ...seeds) as { fromPk: number | null; toPk: number }[]) {
      if (row.fromPk !== null) addEdge(row.fromPk, 0.8, 'handed off from/to a matching session');
      addEdge(row.toPk, 0.8, 'handed off from/to a matching session');
    }
    // shared memory entity: two sessions that shaped the same decision/file
    for (const row of db
      .prepare(
        `SELECT DISTINCT n2.source_session_pk AS pk, e.name AS entity
         FROM memory_notes n1
         JOIN memory_notes n2 ON n2.entity_id = n1.entity_id
         JOIN memory_entities e ON e.id = n1.entity_id
         WHERE n1.source_session_pk IN (${inSeeds}) AND n2.source_session_pk IS NOT NULL`,
      )
      .all(...seeds) as { pk: number; entity: string }[]) {
      addEdge(row.pk, 0.6, `shares memory entity "${row.entity}"`);
    }
    // overlapping files
    for (const seed of seeds) {
      const a = sessions.get(seed);
      if (!a) continue;
      for (const [pk, b] of sessions) {
        if (pk === seed) continue;
        const j = fileOverlap(a.files_touched, b.files_touched);
        if (j > 0.2) addEdge(pk, 0.3 + j * 0.3, 'touched the same files');
      }
    }
  }

  // ── 3. curated knowledge: memory notes ──────────────────────────────────
  const noteRows = db
    .prepare(
      `SELECT n.body, n.aspect, n.created_at, n.status, e.name AS entity, e.kind, e.project_path
       FROM memory_notes n JOIN memory_entities e ON e.id = n.entity_id
       WHERE n.status IN ('current','conflicted')
       ${opts.project ? 'AND e.project_path = ?' : ''}`,
    )
    .all(...(opts.project ? [opts.project] : [])) as {
    body: string;
    aspect: string;
    created_at: string;
    status: string;
    entity: string;
    kind: string;
    project_path: string;
  }[];

  const items: RecallItem[] = [];
  for (const n of noteRows) {
    const cov = termCoverage(`${n.entity} ${n.aspect} ${n.body}`, terms);
    if (cov === 0 && terms.length > 0) continue;
    const score = 0.65 * cov + 0.2 * recencyScore(n.created_at) + (n.status === 'conflicted' ? 0.1 : 0.15);
    const text = `[${n.kind}] ${n.entity} · ${n.aspect}${n.status === 'conflicted' ? ' (CONFLICTED)' : ''}\n${n.body}`;
    items.push({
      kind: 'note',
      text,
      why: n.status === 'conflicted' ? 'team memory — unresolved conflict' : 'team memory (current)',
      score,
      tokens: approxTokens(text),
      priority: 0,
    });
  }

  // ── 4. curated knowledge: human pins ────────────────────────────────────
  const pinRows = db
    .prepare(
      `SELECT c.body, c.created_at, c.session_pk, m.name AS author
       FROM session_comments c LEFT JOIN members m ON m.id = c.author_id`,
    )
    .all() as { body: string; created_at: string; session_pk: number; author: string | null }[];
  let contextOnlyPins = 0;
  for (const p of pinRows) {
    const s = sessions.get(p.session_pk);
    if (!s) continue;
    const cov = termCoverage(p.body, terms);
    const linked = sessionTermScore.get(p.session_pk) ?? 0;
    if (cov === 0) {
      // a note that says nothing about the question is context, not an answer:
      // it may not outrank real excerpts, and two of them is plenty
      if (linked === 0 || contextOnlyPins >= 2) continue;
      contextOnlyPins++;
    }
    const text = `@${p.author ?? '?'}: ${p.body}`;
    items.push({
      kind: 'pin',
      text,
      why: cov > 0 ? 'human note matching the question' : 'human note on a matching session',
      sessionId: s.id,
      sessionTitle: s.title,
      member: p.author,
      when: p.created_at,
      score: 0.55 * cov + 0.3 * linked + 0.2 * recencyScore(p.created_at) + 0.1,
      tokens: approxTokens(text),
      priority: cov > 0 ? 1 : 3,
    });
  }

  // ── 5. excerpts: the best-answering PARAGRAPH of each matching message ──
  const seenChunks = new Set<string>(items.map((i) => dedupeKey(i.text)));
  const candidates: RecallItem[] = [];
  for (const h of hits.slice(0, 120)) {
    const s = sessions.get(h.sessionPk);
    if (!s) continue;
    for (const chunk of chunkText(h.text, excerptChars)) {
      const cov = termCoverage(chunk, terms);
      if (cov === 0) continue; // this paragraph is not about the question
      const key = dedupeKey(chunk);
      if (seenChunks.has(key)) continue; // the same text synced twice (handoff copies)
      seenChunks.add(key);
      candidates.push({
        kind: 'excerpt',
        text: windowAround(chunk, terms, excerptChars),
        why: `covers ${Math.round(cov * 100)}% of the question's terms`,
        sessionId: s.id,
        sessionTitle: s.title,
        member: s.member,
        when: s.updated_at,
        score:
          0.55 * cov +
          0.25 * normRank(h.rank) +
          0.1 * recencyScore(s.updated_at) +
          0.1 * (graphBoost.get(h.sessionPk)?.score ?? 0),
        tokens: approxTokens(chunk),
        priority: 2,
      });
    }
  }
  // keep the bundle diverse: at most two paragraphs from any one session
  candidates.sort((a, b) => b.score - a.score);
  const perSession = new Map<string, number>();
  for (const c of candidates) {
    const used = perSession.get(c.sessionId!) ?? 0;
    if (used >= 2) continue;
    perSession.set(c.sessionId!, used + 1);
    items.push(c);
  }

  // ── 6. pack to budget: curated first, then excerpts by score ────────────
  items.sort((a, b) => a.priority - b.priority || b.score - a.score);
  const packed: RecallItem[] = [];
  let used = 0;
  for (const item of items) {
    if (used + item.tokens > budget && packed.length > 0) continue;
    packed.push(item);
    used += item.tokens;
  }

  // ── 7. related sessions (links, not content — cheap to include) ─────────
  const related: RecallRelated[] = [];
  const relatedPks = new Set<number>();
  for (const [pk, boost] of [...graphBoost.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 6)) {
    const s = sessions.get(pk);
    if (!s || relatedPks.has(pk)) continue;
    relatedPks.add(pk);
    related.push({ sessionId: s.id, title: s.title, member: s.member, updatedAt: s.updated_at, why: boost.why });
  }

  return {
    query: opts.query,
    project: opts.project,
    items: packed,
    related,
    tokensApprox: used,
    stats: {
      candidateSessions: sessions.size,
      termHits: hits.length,
      graphHops: graphBoost.size,
      budget,
    },
  };
}

/** Markdown rendering used by the MCP tool and the CLI — one shape everywhere. */
export function renderRecall(result: RecallResult): string {
  if (result.items.length === 0 && result.related.length === 0) {
    return `No prior team context found for "${result.query}".`;
  }
  const lines: string[] = [`# Team context for "${result.query}"`];
  const notes = result.items.filter((i) => i.kind === 'note');
  const pins = result.items.filter((i) => i.kind === 'pin');
  const excerpts = result.items.filter((i) => i.kind === 'excerpt');

  if (notes.length > 0) {
    lines.push('\n## What the team already decided');
    for (const n of notes) lines.push(`- ${n.text.replace(/\n/g, '\n  ')}`);
  }
  if (pins.length > 0) {
    lines.push('\n## Notes people pinned');
    for (const p of pins) lines.push(`- ${p.text}  _(${p.sessionId})_`);
  }
  if (excerpts.length > 0) {
    lines.push('\n## From past sessions');
    for (const e of excerpts) {
      lines.push(
        `\n**${e.sessionTitle ?? 'session'}** — @${e.member ?? '?'}, ${e.when?.slice(0, 10) ?? ''} · \`${e.sessionId}\`\n> ${e.text.replace(/\n/g, '\n> ')}`,
      );
    }
  }
  if (result.related.length > 0) {
    lines.push('\n## Related sessions (not included above)');
    for (const r of result.related) lines.push(`- \`${r.sessionId}\` ${r.title ?? ''} — ${r.why}`);
  }
  lines.push(
    `\n---\n_${result.tokensApprox} tokens from ${result.stats.candidateSessions} sessions. Cite session ids when you use this. Ask a session directly with the ask_session tool._`,
  );
  return lines.join('\n');
}
