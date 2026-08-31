import type { MotifMessage, MotifSession } from '@motif/core';

export interface AskRequest {
  id: number;
  session_id: string;
  asked_by: number;
  executor_id: number;
  question: string;
  status: 'pending' | 'done' | 'error';
  answer: string | null;
  error: string | null;
  created_at: string;
  asker_name?: string | null;
  session_title?: string | null;
}

export interface ClientOptions {
  serverUrl: string;
  /** Bearer credential: the member token for writes, or the team token for read-only use. */
  token: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    friendly?: string,
  ) {
    super(friendly ?? `HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

export class MotifClient {
  constructor(private readonly opts: ClientOptions) {}

  private async request<T>(method: string, pathName: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(pathName, this.opts.serverUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (res.status === 404 && pathName.startsWith('/api/sessions/')) {
      // Mistyping an id is the most common way to get here. Disconnected, the
      // CLI says so plainly; connected, it used to print a raw HTTP 404.
      // echo back what the user typed, not the internal source prefix
      const id = decodeURIComponent(pathName.split('/')[3] ?? '').replace(/^[a-z-]+:/, '');
      throw new ApiError(404, text, `No session matches "${id}". Try \`motif list\`.`);
    }
    if (!res.ok) throw new ApiError(res.status, text);
    return JSON.parse(text) as T;
  }

  health(): Promise<{ ok: boolean }> {
    return this.request('GET', '/api/health');
  }

  register(input: { name: string; email?: string; machine?: string }): Promise<{
    memberId: number;
    memberToken: string;
    role: string;
  }> {
    return this.request('POST', '/api/members/register', input);
  }

  me(): Promise<{ kind: 'team' | 'member'; member?: { id: number; name: string } }> {
    return this.request('GET', '/api/me');
  }

  deleteSession(id: string): Promise<{ ok: boolean; deleted: string }> {
    return this.request('DELETE', `/api/sessions/${encodeURIComponent(id)}`);
  }

  prune(olderThanDays: number): Promise<{ ok: boolean; sessions: number; messages: number }> {
    return this.request('POST', '/api/admin/prune', { olderThanDays });
  }

  recall(
    query: string,
    opts: { project?: string; budget?: number; markdown?: boolean } = {},
  ): Promise<unknown> {
    const q = new URLSearchParams({ q: query });
    if (opts.project) q.set('project', opts.project);
    if (opts.budget) q.set('budget', String(opts.budget));
    if (opts.markdown) q.set('format', 'markdown');
    return this.request('GET', `/api/recall?${q}`);
  }

  async recallMarkdown(query: string, opts: { project?: string; budget?: number } = {}): Promise<string> {
    const q = new URLSearchParams({ q: query, format: 'markdown' });
    if (opts.project) q.set('project', opts.project);
    if (opts.budget) q.set('budget', String(opts.budget));
    const res = await fetch(new URL(`/api/recall?${q}`, this.opts.serverUrl), {
      headers: { authorization: `Bearer ${this.opts.token}` },
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text);
    return text;
  }

  createAsk(sessionId: string, question: string): Promise<AskRequest> {
    return this.request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/asks`, { question });
  }

  getAsk(id: number): Promise<AskRequest> {
    return this.request('GET', `/api/asks/${id}`);
  }

  listAsksForSession(sessionId: string): Promise<AskRequest[]> {
    return this.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}/asks`);
  }

  listAskRequests(status?: string): Promise<AskRequest[]> {
    return this.request('GET', `/api/ask-requests${status ? `?status=${status}` : ''}`);
  }

  completeAskRequest(
    id: number,
    result: { status: 'done' | 'error'; answer?: string; error?: string },
  ): Promise<unknown> {
    return this.request('PATCH', `/api/ask-requests/${id}`, result);
  }

  addComment(sessionId: string, body: string, messageId?: string): Promise<{ id: number }> {
    return this.request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/comments`, {
      body,
      messageId,
    });
  }

  listComments(
    sessionId: string,
  ): Promise<{ id: number; author_name: string | null; body: string; created_at: string }[]> {
    return this.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}/comments`);
  }

  createHandoffRequest(input: {
    sessionId: string;
    cwd?: string;
    assignee?: string;
    target?: string;
  }): Promise<{
    id: number;
    assignee_id: number | null;
  }> {
    return this.request('POST', '/api/handoff-requests', input);
  }

  listHandoffRequests(status?: string): Promise<
    {
      id: number;
      session_id: string;
      cwd_override: string | null;
      status: string;
      target: string;
      requested_by: number;
      assignee_id: number | null;
      requester_name: string | null;
    }[]
  > {
    return this.request('GET', `/api/handoff-requests${status ? `?status=${status}` : ''}`);
  }

  completeHandoffRequest(
    id: number,
    result: { status: 'done' | 'error'; outputPath?: string; targetSessionId?: string; error?: string },
  ): Promise<unknown> {
    return this.request('PATCH', `/api/handoff-requests/${id}`, result);
  }

  putSession(session: MotifSession): Promise<{ ok: boolean; lastId: string | null }> {
    return this.request('PUT', `/api/sessions/${encodeURIComponent(session.id)}`, session);
  }

  postMessages(
    session: Omit<MotifSession, 'messages'>,
    afterId: string | null,
    prefixHash: string,
    messages: MotifMessage[],
  ): Promise<{ ok: boolean; appended: number; lastId: string | null }> {
    return this.request('POST', `/api/sessions/${encodeURIComponent(session.id)}/messages`, {
      session,
      afterId,
      prefixHash,
      messages,
    });
  }

  listSessions(params: { project?: string; limit?: number } = {}): Promise<
    {
      id: string;
      memberName: string | null;
      projectPath: string;
      gitBranch: string | null;
      title: string | null;
      updatedAt: string | null;
      messageCount: number;
    }[]
  > {
    const q = new URLSearchParams();
    if (params.project) q.set('project', params.project);
    if (params.limit) q.set('limit', String(params.limit));
    return this.request('GET', `/api/sessions?${q}`);
  }

  getSession(id: string): Promise<MotifSession & { memberId: number }> {
    return this.request('GET', `/api/sessions/${encodeURIComponent(id)}`);
  }

  exportSession(id: string): Promise<MotifSession> {
    return this.request('GET', `/api/sessions/${encodeURIComponent(id)}/export`);
  }

  search(
    query: string,
    opts: { project?: string } = {},
  ): Promise<
    { id: string; title: string | null; projectPath: string; snippet: string; memberName: string | null }[]
  > {
    const params = new URLSearchParams({ q: query });
    if (opts.project) params.set('project', opts.project);
    return this.request('GET', `/api/search?${params}`);
  }

  postHandoff(input: {
    sessionId: string;
    target: string;
    outputPath?: string;
    targetSessionId?: string;
  }): Promise<{ ok: boolean }> {
    return this.request('POST', '/api/handoffs', input);
  }
}
