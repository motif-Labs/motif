export interface SessionRow {
  id: string;
  memberName: string | null;
  projectPath: string;
  gitBranch: string | null;
  title: string | null;
  updatedAt: string | null;
  messageCount: number;
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
  createdAt: string | null;
  filesTouched: string[];
  messages: Message[];
}

export interface MemoryEntity {
  id: number;
  kind: string;
  name: string;
  project_path: string;
  current_notes: number;
  conflicts: number;
}

export interface MemoryNote {
  id: number;
  aspect: string;
  body: string;
  status: 'current' | 'superseded' | 'conflicted';
  created_at: string;
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

export async function api<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { authorization: `Bearer ${getToken() ?? ''}` },
  });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function openEvents(onEvent: (name: string, data: unknown) => void): () => void {
  const src = new EventSource(`/api/events?token=${encodeURIComponent(getToken() ?? '')}`);
  const names = ['session-upserted', 'memory-updated', 'member-joined', 'handoff-created'];
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
