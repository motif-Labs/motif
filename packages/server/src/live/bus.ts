import { EventEmitter } from 'node:events';

export interface LiveEvents {
  'session-upserted': {
    id: string;
    memberId: number;
    title?: string;
    projectPath: string;
    updatedAt?: string;
    messageCount: number;
  };
  'memory-updated': { entityId: number; kind: string; name: string };
  'member-joined': { memberId: number; name: string };
  'handoff-created': { sessionId: string; memberId: number; target: string };
  'handoff-requested': { requestId: number; sessionId: string; memberId: number };
  'handoff-request-updated': {
    requestId: number;
    sessionId: string;
    memberId: number;
    executorId?: number;
    status: string;
    outputPath?: string;
    targetSessionId?: string;
    error?: string;
  };
}

export type LiveEventName = keyof LiveEvents;

/**
 * Single-process fanout for SSE. The server runs as one process over one
 * SQLite file, so an in-memory emitter is all the pub/sub we need.
 */
export class LiveBus extends EventEmitter {
  publish<K extends LiveEventName>(event: K, data: LiveEvents[K]): void {
    this.emit('event', { event, data });
  }
  subscribe(fn: (e: { event: LiveEventName; data: unknown }) => void): () => void {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}
