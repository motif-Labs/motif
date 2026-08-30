/**
 * Two ways to reach the team's context, behind one interface:
 *
 *   local  — open the SQLite file directly (the same one `motif up`/`motif
 *            server` writes; SQLite WAL makes concurrent readers free). No
 *            HTTP, no port, works while the agent runs.
 *   remote — a teammate's server over HTTP with this machine's member token.
 *
 * Remote wins when a non-local server is configured, because that database is
 * the team's; otherwise we read the local one.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  canView,
  createAskRequest,
  exportSession,
  getAskRequest,
  getSessionRow,
  listSessions,
  openDb,
  recall,
  renderRecall,
  searchSessions,
  type Db,
} from '@motif/server';
import type { MotifSession } from '@motif/core';
import { MotifClient, type AskRequest } from '../api-client.js';
import { loadConfig, motifHome, type MotifConfig } from '../config.js';
import { askSessionLocally, canAnswerLocally, looksLive } from '../ask/perform.js';

export interface Backend {
  readonly kind: 'local' | 'remote';
  recall(query: string, project?: string, budget?: number): Promise<string>;
  /** The same bundle, unrendered — for `--json` and the benchmark. */
  recallJson(query: string, project?: string, budget?: number): Promise<unknown>;
  search(query: string, limit: number): Promise<string>;
  listSessions(project: string | undefined, limit: number): Promise<string>;
  getSession(id: string, tail: number): Promise<string>;
  ask(sessionId: string, question: string, waitSeconds: number): Promise<string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function renderSessionList(
  rows: {
    id: string;
    title: string | null;
    memberName: string | null;
    projectPath: string;
    updatedAt: string | null;
    messageCount: number;
    snippet?: string;
  }[],
  heading: string,
): string {
  if (rows.length === 0) return `${heading}\n\n(nothing found)`;
  const lines = [heading, ''];
  for (const r of rows) {
    lines.push(
      `- \`${r.id}\` **${r.title ?? '(untitled)'}** — @${r.memberName ?? '?'}, ${r.projectPath || '?'}, ${r.updatedAt?.slice(0, 10) ?? ''} (${r.messageCount} messages)`,
    );
    if (r.snippet) lines.push(`    …${r.snippet}…`);
  }
  return lines.join('\n');
}

function renderTranscript(session: MotifSession, tail: number): string {
  const messages = session.messages.filter((m) => m.role !== 'reasoning');
  const shown = tail > 0 ? messages.slice(-tail) : messages;
  const lines = [
    `# ${session.title ?? '(untitled)'}`,
    `\`${session.id}\` · ${session.source} · ${session.projectPath} · ${shown.length}/${messages.length} messages shown`,
    '',
  ];
  for (const m of shown) {
    if (m.role === 'tool_call') {
      lines.push(`**[tool] ${m.toolName ?? '?'}** ${JSON.stringify(m.toolInput ?? {}).slice(0, 200)}`);
    } else if (m.role === 'tool_result') {
      lines.push(`**[result]** ${(m.text ?? '').slice(0, 200)}`);
    } else if (m.text?.trim()) {
      lines.push(`**${m.role === 'user' ? 'User' : 'Agent'}:** ${m.text.trim().slice(0, 2000)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Shared by both backends: the wording of an ask outcome. */
function renderAsk(
  sessionId: string,
  question: string,
  status: string,
  answer?: string | null,
  error?: string | null,
): string {
  if (status === 'done' && answer) {
    return `# Answer from session \`${sessionId}\`\n\n_Question: ${question}_\n\n${answer}`;
  }
  if (status === 'error') {
    return `The session could not answer: ${error ?? 'unknown error'}`;
  }
  return `Question queued for \`${sessionId}\`. Its owner's machine answers it — check back with the same tool, or read it in the dashboard.`;
}

class LocalBackend implements Backend {
  readonly kind = 'local';
  constructor(
    private readonly db: Db,
    private readonly cfg: MotifConfig,
  ) {}

  private get viewer(): number | undefined {
    return this.cfg.memberId;
  }

  async recall(query: string, project?: string, budget?: number): Promise<string> {
    return renderRecall(recall(this.db, { query, project, viewerId: this.viewer, budget }));
  }

  async recallJson(query: string, project?: string, budget?: number): Promise<unknown> {
    return recall(this.db, { query, project, viewerId: this.viewer, budget });
  }

  async search(query: string, limit: number): Promise<string> {
    const rows = searchSessions(this.db, query, limit, this.viewer);
    return renderSessionList(rows, `# Sessions matching "${query}"`);
  }

  async listSessions(project: string | undefined, limit: number): Promise<string> {
    const rows = listSessions(this.db, { project, limit, viewerId: this.viewer });
    return renderSessionList(rows, '# Recent sessions');
  }

  async getSession(id: string, tail: number): Promise<string> {
    const row = getSessionRow(this.db, id);
    if (!row || !canView(row, this.viewer)) return `No session \`${id}\` is visible to you.`;
    const session = exportSession(this.db, row.id);
    return session ? renderTranscript(session, tail) : `No session \`${id}\`.`;
  }

  async ask(sessionId: string, question: string, waitSeconds: number): Promise<string> {
    const row = getSessionRow(this.db, sessionId);
    if (!row || !canView(row, this.viewer)) return `No session \`${sessionId}\` is visible to you.`;
    const session = exportSession(this.db, row.id)!;

    // fast path: it is our own session and the transcript is right here
    if (canAnswerLocally(session)) {
      if (looksLive(session)) {
        return `\`${row.id}\` is still running right now — resuming it could collide with the live process. Read it with get_session instead.`;
      }
      const outcome = askSessionLocally(session, question);
      return renderAsk(row.id, question, 'done', outcome.answer);
    }

    // otherwise queue it for the machine that owns it
    if (this.viewer === undefined)
      return "Asking a teammate's session needs a member token (run `motif connect`).";
    const request = createAskRequest(this.db, this.viewer, row, question);
    const deadline = Date.now() + waitSeconds * 1000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const fresh = getAskRequest(this.db, request.id);
      if (fresh && fresh.status !== 'pending') {
        return renderAsk(row.id, question, fresh.status, fresh.answer, fresh.error);
      }
    }
    return renderAsk(row.id, question, 'pending');
  }
}

class RemoteBackend implements Backend {
  readonly kind = 'remote';
  constructor(private readonly client: MotifClient) {}

  async recall(query: string, project?: string, budget?: number): Promise<string> {
    return this.client.recallMarkdown(query, { project, budget });
  }

  async recallJson(query: string, project?: string, budget?: number): Promise<unknown> {
    return this.client.recall(query, { project, budget });
  }

  async search(query: string, limit: number): Promise<string> {
    const rows = (await this.client.search(query)).slice(0, limit) as never[];
    return renderSessionList(rows, `# Sessions matching "${query}"`);
  }

  async listSessions(project: string | undefined, limit: number): Promise<string> {
    const rows = await this.client.listSessions({ project, limit });
    return renderSessionList(rows as never[], '# Recent sessions');
  }

  async getSession(id: string, tail: number): Promise<string> {
    const session = await this.client.exportSession(id);
    return renderTranscript(session, tail);
  }

  async ask(sessionId: string, question: string, waitSeconds: number): Promise<string> {
    let request: AskRequest;
    try {
      request = await this.client.createAsk(sessionId, question);
    } catch (err) {
      return `Could not ask that session: ${(err as Error).message}`;
    }
    const deadline = Date.now() + waitSeconds * 1000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const fresh = await this.client.getAsk(request.id).catch(() => undefined);
      if (fresh && fresh.status !== 'pending') {
        return renderAsk(sessionId, question, fresh.status, fresh.answer, fresh.error);
      }
    }
    return renderAsk(sessionId, question, 'pending');
  }
}

const isLoopback = (url: string): boolean =>
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(url);

export function createBackend(dbPath?: string): Backend {
  const cfg = loadConfig();
  const remote = (): Backend =>
    new RemoteBackend(new MotifClient({ serverUrl: cfg.serverUrl!, token: cfg.memberToken ?? cfg.token! }));
  const connected = Boolean(cfg.serverUrl && (cfg.memberToken || cfg.token));

  // A real team server owns the data, so it wins outright.
  if (connected && !isLoopback(cfg.serverUrl!)) return remote();

  const file = dbPath ?? process.env.MOTIF_DB_PATH ?? path.join(motifHome(), 'motif.db');
  if (fs.existsSync(file)) return new LocalBackend(openDb(file), cfg);

  // Reading the file directly is only an optimisation. If it is not where this
  // machine keeps its own state — a server started elsewhere, a different
  // MOTIF_HOME, an SSH tunnel to localhost — ask the server we are connected to
  // rather than declaring there is no database.
  if (connected) return remote();

  throw new Error(
    `No Motif database at ${file} and no server configured.\nRun \`motif up\` once (solo) or \`motif connect <url> --token …\` (team), then retry.`,
  );
}
