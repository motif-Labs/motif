import { EventEmitter } from 'node:events';

export interface LiveEvents {
  'session-upserted': {
    id: string;
    memberId: number;
    /** Subscribers are filtered on this: a personal session reaches only its owner. */
    visibility: 'team' | 'personal';
    title?: string;
    projectPath: string;
    updatedAt?: string;
    messageCount: number;
  };
  'memory-updated': { entityId: number; kind: string; name: string };
  'memory-reviewed': { noteId: number; verdict: string; reviewerId: number };
  'member-joined': { memberId: number; name: string };
  'handoff-created': { sessionId: string; memberId: number; target: string };
  'handoff-requested': { requestId: number; sessionId: string; memberId: number };
  'ask-requested': { requestId: number; sessionId: string; executorId: number; askerName: string | null };
  'ask-answered': { requestId: number; sessionId: string; askedBy: number; status: string };
  'comment-added': {
    sessionId: string;
    commentId: number;
    authorId: number;
    authorName: string | null;
    mentionIds: number[];
    messageId: string | null;
  };
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
  constructor() {
    super();
    // one listener per open dashboard tab and per daemon; a team of ten
    // trips Node's default cap of 10 and prints a warning that means nothing here
    this.setMaxListeners(0);
  }

  publish<K extends LiveEventName>(event: K, data: LiveEvents[K]): void {
    this.emit('event', { event, data });
  }
  subscribe(fn: (e: { event: LiveEventName; data: unknown }) => void): () => void {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}
