/**
 * Dashboard-initiated handoffs. The web UI can't write into this machine's
 * ~/.codex, so it queues a request on the server; this daemon — authenticated
 * as the requesting member — picks it up, performs the native handoff
 * locally, and reports the result back. Requests are self-scoped: the server
 * only ever hands a daemon its own member's requests.
 */

import { MotifClient } from '../api-client.js';
import { performCodexHandoff } from '../handoff/perform.js';

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
      const session = await client.exportSession(req.session_id);
      const result = performCodexHandoff(session, { cwdOverride: req.cwd_override ?? undefined });
      await client.completeHandoffRequest(req.id, {
        status: 'done',
        outputPath: result.target,
        targetSessionId: result.threadId,
      });
      log(`handoff #${req.id}: ${req.session_id} → ${result.target}`);
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
