/**
 * Session memory — basic tier. A scheduler picks sessions that have gone
 * idle with unprocessed messages, digests only the new messages, shows the
 * model the current notes for that project, and applies the returned notes
 * with supersession (history kept, currency flagged) and conflict marking
 * (contradictions surface for a human; nothing is silently accumulated).
 */

import { buildDigest, type MotifMessage } from '@motif/core';
import type { Db } from '../db/database.js';
import type { LiveBus } from '../live/bus.js';
import type { LLMProvider } from './providers.js';

const SYSTEM_PROMPT = `You maintain an engineering memory for a software team. You receive a digest of an AI coding-agent session and the team's current memory notes for that project.

Extract durable knowledge as notes attached to entities. Entity kinds:
- "file": a specific file or component path mentioned in the work
- "decision": a technical decision (tools chosen, approaches adopted or dropped)
- "topic": a recurring subject that fits neither of the above

Rules:
- Only record knowledge that stays true after the session ends (decisions, constraints, gotchas, how things work). Never record transient activity ("the user ran the tests").
- "aspect" is a short slug naming what facet of the entity the note covers (e.g. "storage-engine", "auth-flow", "status").
- If a note updates existing knowledge for the same entity+aspect, set "supersedes": true.
- If a note CONTRADICTS a current note and you cannot tell which is right, set "contradictsCurrent": true instead of supersedes.
- Few good notes beat many weak ones. Return an empty list when nothing durable happened.

Respond with ONLY a JSON object, no prose:
{"notes":[{"entity":{"kind":"file|decision|topic","name":"..."},"aspect":"...","body":"...","supersedes":false,"contradictsCurrent":false}]}`;

interface ExtractedNote {
  entity: { kind: 'file' | 'decision' | 'topic'; name: string };
  aspect: string;
  body: string;
  supersedes?: boolean;
  contradictsCurrent?: boolean;
}

function parseNotes(raw: unknown): ExtractedNote[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { notes?: unknown }).notes)) {
    throw new Error('model output missing notes array');
  }
  return ((raw as { notes: unknown[] }).notes as ExtractedNote[]).filter(
    (n) =>
      n?.entity &&
      ['file', 'decision', 'topic'].includes(n.entity.kind) &&
      typeof n.entity.name === 'string' &&
      typeof n.aspect === 'string' &&
      typeof n.body === 'string',
  );
}

function currentNotesForProject(db: Db, projectPath: string): string {
  const rows = db
    .prepare(
      `SELECT e.kind, e.name, n.aspect, n.body FROM memory_notes n
       JOIN memory_entities e ON e.id = n.entity_id
       WHERE n.status = 'current' AND e.project_path = ?
       ORDER BY e.kind, e.name LIMIT 200`,
    )
    .all(projectPath) as { kind: string; name: string; aspect: string; body: string }[];
  if (rows.length === 0) return '(no notes yet)';
  return rows.map((r) => `- [${r.kind}] ${r.name} / ${r.aspect}: ${r.body}`).join('\n');
}

export function applyNotes(
  db: Db,
  notes: ExtractedNote[],
  ctx: { projectPath: string; sessionPk: number | null; memberId: number | null },
): { entityIds: number[] } {
  const now = new Date().toISOString();
  const entityIds: number[] = [];
  db.transaction(() => {
    for (const note of notes) {
      db.prepare(
        'INSERT INTO memory_entities (kind, name, project_path) VALUES (?, ?, ?) ON CONFLICT(kind, name, project_path) DO NOTHING',
      ).run(note.entity.kind, note.entity.name, ctx.projectPath);
      const entity = db
        .prepare('SELECT id FROM memory_entities WHERE kind = ? AND name = ? AND project_path = ?')
        .get(note.entity.kind, note.entity.name, ctx.projectPath) as { id: number };
      entityIds.push(entity.id);

      const current = db
        .prepare("SELECT id FROM memory_notes WHERE entity_id = ? AND aspect = ? AND status = 'current'")
        .get(entity.id, note.aspect) as { id: number } | undefined;

      if (current && note.contradictsCurrent) {
        // conflict: old stays current, new is flagged for a human to resolve
        db.prepare(
          `INSERT INTO memory_notes (entity_id, aspect, body, status, conflict_with, source_session_pk, member_id, created_at)
           VALUES (?, ?, ?, 'conflicted', ?, ?, ?, ?)`,
        ).run(entity.id, note.aspect, note.body, current.id, ctx.sessionPk, ctx.memberId, now);
        continue;
      }

      const inserted = db
        .prepare(
          `INSERT INTO memory_notes (entity_id, aspect, body, status, source_session_pk, member_id, created_at)
           VALUES (?, ?, ?, 'current', ?, ?, ?)`,
        )
        .run(entity.id, note.aspect, note.body, ctx.sessionPk, ctx.memberId, now);
      if (current) {
        db.prepare('UPDATE memory_notes SET status = ?, superseded_by = ? WHERE id = ?').run(
          'superseded',
          Number(inserted.lastInsertRowid),
          current.id,
        );
      }
    }
  })();
  return { entityIds };
}

export interface MemoryPipelineOptions {
  /** A session is "idle" when unchanged for this long. Default 10 min. */
  idleMs?: number;
  intervalMs?: number;
  maxDigestChars?: number;
  /** Rough daily token ceiling for extraction (env: MOTIF_LLM_DAILY_BUDGET). Default 1M. */
  dailyTokenBudget?: number;
  log?: (msg: string) => void;
}

const approxTokens = (text: string): number => Math.ceil(text.length / 4);

function spendKey(): string {
  return `llm_spend_${new Date().toISOString().slice(0, 10)}`;
}

function getSpend(db: Db): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(spendKey()) as
    { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

function addSpend(db: Db, tokens: number): void {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)',
  ).run(spendKey(), String(tokens), tokens);
}

export async function runMemoryTick(
  db: Db,
  provider: LLMProvider,
  bus: LiveBus,
  opts: MemoryPipelineOptions = {},
): Promise<number> {
  const idleMs = opts.idleMs ?? 10 * 60 * 1000;
  const budget = opts.dailyTokenBudget ?? Number(process.env.MOTIF_LLM_DAILY_BUDGET ?? 1_000_000);
  if (getSpend(db) >= budget) {
    opts.log?.(`memory: daily token budget (${budget}) reached — extraction paused until tomorrow`);
    return 0;
  }
  const cutoff = new Date(Date.now() - idleMs).toISOString();
  const candidates = db
    .prepare(
      `SELECT s.pk, s.id, s.project_path, s.member_id, s.last_extracted_seq,
              (SELECT MAX(seq) FROM messages WHERE session_pk = s.pk) AS max_seq
       FROM sessions s
       WHERE s.visibility = 'team' AND s.updated_at < ?
         AND (SELECT MAX(seq) FROM messages WHERE session_pk = s.pk) > s.last_extracted_seq - 1
         AND EXISTS (SELECT 1 FROM messages WHERE session_pk = s.pk AND seq >= s.last_extracted_seq)
       ORDER BY s.updated_at ASC
       LIMIT 1`,
    )
    .all(cutoff) as {
    pk: number;
    id: string;
    project_path: string;
    member_id: number;
    last_extracted_seq: number;
    max_seq: number | null;
  }[];

  let processed = 0;
  for (const s of candidates) {
    if (s.max_seq === null || s.max_seq < s.last_extracted_seq) continue;
    const newMessages = (
      db
        .prepare('SELECT content_json FROM messages WHERE session_pk = ? AND seq >= ? ORDER BY seq')
        .all(s.pk, s.last_extracted_seq) as { content_json: string }[]
    ).map((r) => JSON.parse(r.content_json) as MotifMessage);
    if (newMessages.length === 0) continue;

    const digest = buildDigest(newMessages, { maxChars: opts.maxDigestChars });
    const user = `Project: ${s.project_path}\n\nCurrent memory notes for this project:\n${currentNotesForProject(db, s.project_path)}\n\nNew session activity (digest):\n${digest}`;
    addSpend(db, approxTokens(SYSTEM_PROMPT + user) + 2048); // count before calling; failures still cost

    let raw: unknown;
    try {
      raw = await provider.completeJSON({ system: SYSTEM_PROMPT, user });
    } catch (err) {
      // one repair retry, then skip — a stuck job must never wedge the queue
      try {
        raw = await provider.completeJSON({
          system: SYSTEM_PROMPT,
          user: `${user}\n\nIMPORTANT: respond with ONLY the JSON object described in the system prompt.`,
        });
      } catch {
        opts.log?.(`memory: extraction failed for ${s.id}: ${String(err).slice(0, 200)}`);
        // advance the watermark anyway so one poisoned session doesn't loop forever
        db.prepare('UPDATE sessions SET last_extracted_seq = ? WHERE pk = ?').run(s.max_seq + 1, s.pk);
        continue;
      }
    }

    let notes: ExtractedNote[];
    try {
      notes = parseNotes(raw);
    } catch (err) {
      opts.log?.(`memory: bad model output for ${s.id}: ${String(err)}`);
      db.prepare('UPDATE sessions SET last_extracted_seq = ? WHERE pk = ?').run(s.max_seq + 1, s.pk);
      continue;
    }

    const { entityIds } = applyNotes(db, notes, {
      projectPath: s.project_path,
      sessionPk: s.pk,
      memberId: s.member_id,
    });
    db.prepare('UPDATE sessions SET last_extracted_seq = ? WHERE pk = ?').run(s.max_seq + 1, s.pk);
    processed++;
    opts.log?.(`memory: ${notes.length} note(s) from ${s.id}`);
    for (const entityId of entityIds) {
      const e = db.prepare('SELECT id, kind, name FROM memory_entities WHERE id = ?').get(entityId) as {
        id: number;
        kind: string;
        name: string;
      };
      bus.publish('memory-updated', { entityId: e.id, kind: e.kind, name: e.name });
    }
  }
  return processed;
}

export function startMemoryScheduler(
  db: Db,
  provider: LLMProvider,
  bus: LiveBus,
  opts: MemoryPipelineOptions = {},
): { stop: () => void } {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // one extraction job at a time
    running = true;
    try {
      await runMemoryTick(db, provider, bus, opts);
    } catch (err) {
      opts.log?.(`memory: tick failed: ${String(err).slice(0, 200)}`);
    } finally {
      running = false;
    }
  }, opts.intervalMs ?? 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
