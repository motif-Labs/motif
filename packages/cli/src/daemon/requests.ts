/**
 * Dashboard-initiated handoffs. The web UI can't write into this machine's
 * ~/.codex, so it queues a request on the server; this daemon — authenticated
 * as the requesting member — picks it up, performs the native handoff
 * locally, and reports the result back. Requests are self-scoped: the server
 * only ever hands a daemon its own member's requests.
 */

import { MotifClient } from '../api-client.js';
import { performHandoff, resumeCommandFor, type HandoffTarget } from '../handoff/perform.js';
import { askSessionLocally, looksLive } from '../ask/perform.js';
import type { MotifConfig } from '../config.js';

/**
 * Answer the questions teammates asked of sessions this machine owns. Only
 * this machine has the raw transcript, so only it can resume them; the answer
 * goes back to the server for everyone to read.
 */
export async function fulfillPendingAsks(
  client: MotifClient,
  config: MotifConfig,
  log: (msg: string) => void = () => {},
): Promise<number> {
  let requests;
  try {
    requests = await client.listAskRequests('pending');
  } catch {
    return 0;
  }
  let answered = 0;
  for (const req of requests) {
    if (config.allowAsks === false) {
      await client
        .completeAskRequest(req.id, { status: 'error', error: 'the owner disabled asks on this machine' })
        .catch(() => {});
      continue;
    }
    try {
      const session = await client.exportSession(req.session_id);
      // Session ids resolve by string, and a teammate can upload a row that
      // shadows one. Answering means resuming a transcript and spawning an
      // agent, so refuse anything that is not exactly what was asked for.
      if (session.id !== req.session_id) {
        throw new Error(`session ${req.session_id} resolved to ${session.id}; refusing`);
      }
      if (looksLive(session)) throw new Error('that session is running right now; try again once it is idle');
      log(`💬 @${req.asker_name ?? 'someone'} asked ${req.session_id} — answering…`);
      const outcome = askSessionLocally(session, req.question);
      await client.completeAskRequest(req.id, { status: 'done', answer: outcome.answer });
      log(`   answered in ${Math.round(outcome.durationMs / 1000)}s (${outcome.agent})`);
      answered++;
    } catch (err) {
      await client
        .completeAskRequest(req.id, { status: 'error', error: String(err).slice(0, 500) })
        .catch(() => {});
      log(`   could not answer #${req.id}: ${String(err).slice(0, 160)}`);
    }
  }
  return answered;
}

export async function fulfillPendingHandoffs(
  client: MotifClient,
  log: (msg: string) => void = () => {},
): Promise<number> {
  let requests;
  try {
    requests = await client.listHandoffRequests('pending');
  } catch {
    return 0; // server unreachable — next sweep retries
  }
  let done = 0;
  for (const req of requests) {
    try {
      const target = (req.target === 'claude-code' ? 'claude-code' : 'codex') as HandoffTarget;
      const session = await client.exportSession(req.session_id);
      // A request with an assignee is a delivery from someone else, so the
      // "you already have this one, just resume it" guard is wrong by
      // construction — and it fires falsely whenever two people happen to
      // share a directory layout.
      const delivered = req.assignee_id !== null;
      const result = performHandoff(target, session, {
        cwdOverride: req.cwd_override ?? undefined,
        force: delivered,
      });
      await client.completeHandoffRequest(req.id, {
        status: 'done',
        outputPath: result.target,
        targetSessionId: result.threadId,
      });
      const fromTeammate = req.assignee_id !== null && req.requester_name;
      log(
        fromTeammate
          ? `📥 @${req.requester_name} handed you a session — continue with: ${resumeCommandFor(target, result.threadId)}`
          : `handoff #${req.id}: ${req.session_id} → ${result.target}`,
      );
      done++;
    } catch (err) {
      await client
        .completeHandoffRequest(req.id, { status: 'error', error: String(err).slice(0, 500) })
        .catch(() => {});
      log(`handoff #${req.id} failed: ${String(err).slice(0, 200)}`);
    }
  }
  return done;
}

/**
 * Minimal SSE client over fetch (Node has no EventSource). Reconnects with
 * backoff; each named event triggers the callback.
 */
export function listenEvents(
  serverUrl: string,
  token: string,
  onEvent: (event: string, data: unknown) => void,
): { stop: () => void } {
  let stopped = false;
  let controller: AbortController | undefined;

  const connect = async (delayMs: number): Promise<void> => {
    if (stopped) return;
    await new Promise((r) => setTimeout(r, delayMs));
    if (stopped) return;
    controller = new AbortController();
    try {
      const res = await fetch(new URL(`/api/events?token=${encodeURIComponent(token)}`, serverUrl), {
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
      let buffer = '';
      let eventName = '';
      for await (const chunk of res.body) {
        buffer += Buffer.from(chunk).toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trimEnd();
          buffer = buffer.slice(idx + 1);
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (eventName && eventName !== 'ping') {
              try {
                onEvent(eventName, data ? JSON.parse(data) : undefined);
              } catch {
                /* malformed event data — ignore */
              }
            }
          } else if (line === '') eventName = '';
        }
      }
    } catch {
      /* dropped — reconnect below */
    }
    void connect(5000);
  };
  void connect(0);

  return {
    stop() {
      stopped = true;
      controller?.abort();
    },
  };
}
