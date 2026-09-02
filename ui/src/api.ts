export interface SessionRow {
  id: string;
  source: string;
  memberName: string | null;
  projectPath: string;
  gitBranch: string | null;
  title: string | null;
  updatedAt: string | null;
  createdAt?: string | null;
  messageCount: number;
  visibility?: 'team' | 'personal';
  snippet?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'reasoning' | 'tool_call' | 'tool_result';
  timestamp: string;
  text?: string;
  toolName?: string;
  toolInput?: unknown;
}

export interface SessionDetail extends SessionRow {
  sourcePath: string | null;
  visibility: 'team' | 'personal';
  filesTouched: string[];
  toolVersion: string | null;
  meta: {
    subagentCount: number;
    branchCount: number;
    parseErrors: number;
    model?: string;
    sourceBytes?: number;
  };
  messages: Message[];
}

export interface MemberRow {
  id: number;
  name: string;
  email: string | null;
  machine: string | null;
  role: string;
  created_at: string;
  last_seen_at: string;
}

export interface MemoryEntity {
  id: number;
  kind: string;
  name: string;
  project_path: string;
  current_notes: number;
  conflicts: number;
  confidence?: number;
}

export interface MemoryNote {
  id: number;
  aspect: string;
  body: string;
  status: 'current' | 'superseded' | 'conflicted';
  created_at: string;
  verification?: string;
}

export interface ReviewNote {
  id: number;
  kind: string;
  entity: string;
  project_path: string;
  aspect: string;
  body: string;
  status: string;
  verification: string;
  stale: number;
  stale_reason: string | null;
  author_name: string | null;
  session_id: string | null;
  created_at: string;
}

export interface ReviewItem {
  type: 'conflict' | 'stale' | 'disputed';
  note: ReviewNote;
  against?: ReviewNote;
}

export interface Comment {
  id: number;
  message_id: string | null;
  author_id: number;
  author_name: string | null;
  body: string;
  created_at: string;
}

export interface Ask {
  id: number;
  question: string;
  answer: string | null;
  error: string | null;
  status: 'pending' | 'done' | 'error';
  asker_name: string | null;
  created_at: string;
}

export interface Me {
  kind: 'team' | 'member';
  member?: { id: number; name: string; email: string | null; role: string };
}

export interface HandoffRequest {
  id: number;
  session_id: string;
  status: 'pending' | 'done' | 'error';
  output_path: string | null;
  target_session_id: string | null;
  error: string | null;
}

const TOKEN_KEY = 'motif-token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage unavailable — session-only auth
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${getToken() ?? ''}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* keep status */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export function openEvents(onEvent: (name: string, data: unknown) => void): () => void {
  const src = new EventSource(`/api/events?token=${encodeURIComponent(getToken() ?? '')}`);
  const names = [
    'session-upserted',
    'memory-updated',
    'member-joined',
    'handoff-created',
    'handoff-requested',
    'handoff-request-updated',
    'comment-added',
    'ask-requested',
    'ask-answered',
    'memory-conflict',
    'memory-reviewed',
    'weaver-job',
    'weaver-completed',
  ];
  for (const name of names) {
    src.addEventListener(name, (e) => {
      try {
        onEvent(name, JSON.parse((e as MessageEvent).data as string));
      } catch {
        /* ignore malformed event */
      }
    });
  }
  return () => src.close();
}
