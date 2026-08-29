import type { MotifMessage, MotifSession } from '@motif/core';

export interface ClientOptions {
  serverUrl: string;
  /** Bearer credential: the member token for writes, or the team token for read-only use. */
  token: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
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

  createHandoffRequest(input: { sessionId: string; cwd?: string; assignee?: string }): Promise<{
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

  search(query: string): Promise<{ id: string; title: string | null; projectPath: string; snippet: string; memberName: string | null }[]> {
    return this.request('GET', `/api/search?q=${encodeURIComponent(query)}`);
  }

  postHandoff(input: { sessionId: string; target: string; outputPath?: string; targetSessionId?: string }): Promise<{ ok: boolean }> {
    return this.request('POST', '/api/handoffs', input);
  }
}
