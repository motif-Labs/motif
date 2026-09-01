import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { AgentMark, AGENT_LABELS } from './logos.js';
import {
  api,
  clearToken,
  getToken,
  openEvents,
  setToken,
  type Ask,
  type Comment,
  type HandoffRequest,
  type Me,
  type MemberRow,
  type MemoryEntity,
  type MemoryNote,
  type ReviewItem,
  type ReviewNote,
  type Message,
  type SessionDetail,
  type SessionRow,
} from './api.js';

/* ── helpers ─────────────────────────────────────────── */

type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'motif-theme';

function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(THEME_KEY) as Theme) || 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => applyTheme(theme), [theme]);
  const cycle = () => {
    const next: Theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* session-only preference */
    }
    setTheme(next);
  };
  return [theme, cycle];
}

function useHash(): string {
  const [hash, setHash] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const onChange = () => setHash(location.hash.slice(1) || '/');
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const days = Math.round(s / 86400);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

function clock(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fullDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const projName = (p: string | null | undefined) => (p ?? '').split('/').filter(Boolean).pop() ?? '?';
const isActive = (iso: string | null | undefined) =>
  !!iso && Date.now() - new Date(iso).getTime() < 5 * 60 * 1000;
const kb = (b?: number) =>
  b === undefined ? '—' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`;

const AVATAR_COLORS = [
  '#6366f1',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
];
function Avatar({ name, size = 22 }: { name: string | null; size?: number }) {
  const n = name ?? '?';
  let h = 0;
  for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const initials = n
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span
      class="avatar"
      style={`width:${size}px;height:${size}px;background:${AVATAR_COLORS[h % AVATAR_COLORS.length]}`}
    >
      {initials}
    </span>
  );
}

function ToolChip({ source }: { source: string }) {
  return (
    <span class="agent-tag">
      <AgentMark source={source} />
      {AGENT_LABELS[source] ?? source}
    </span>
  );
}

/* ── sessions ────────────────────────────────────────── */

function SessionCard({ s }: { s: SessionRow }) {
  return (
    <div class={`snode ${isActive(s.updatedAt) ? 'live' : ''}`}>
      <a class="scard" href={`#/sessions/${encodeURIComponent(s.id)}`}>
        <div class="top">
          <span class="title">{s.title ?? '(untitled)'}</span>
          <span class="ago">{isActive(s.updatedAt) ? 'live now' : ago(s.updatedAt)}</span>
        </div>
        <div class="meta">
          <span class="who">
            <Avatar name={s.memberName} size={18} />@{s.memberName ?? 'unknown'}
          </span>
          <ToolChip source={s.source} />
          <span class="proj">{projName(s.projectPath)}</span>
          {s.snippet && <span>…{s.snippet}…</span>}
        </div>
      </a>
    </div>
  );
}

function NowWorking({ sessions }: { sessions: SessionRow[] }) {
  const seen = new Set<string>();
  const live = sessions.filter((s) => {
    if (!isActive(s.updatedAt)) return false;
    const key = `${s.memberName}:${s.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (live.length === 0) return null;
  return (
    <div class="now-strip">
      {live.map((s) => (
        <a class="now-chip" href={`#/sessions/${encodeURIComponent(s.id)}`}>
          <span class="pulse" />
          <Avatar name={s.memberName} size={18} />
          <b>{s.memberName}</b>
          <span class="x">×</span>
          <ToolChip source={s.source} />
          <span class="x">@</span>
          <span class="proj mono">{projName(s.projectPath)}</span>
        </a>
      ))}
    </div>
  );
}

function dayLabel(iso: string | null): string {
  if (!iso) return 'Earlier';
  const d = new Date(iso);
  const today = new Date();
  const diffDays = Math.floor(
    (new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000,
  );
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'long', day: 'numeric' });
}

function SessionsPage({ me }: { me: Me }) {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [scope, setScope] = useState<'team' | 'personal'>('team');
  const [project, setProject] = useState('');
  const [member, setMember] = useState('');
  const [agent, setAgent] = useState('');
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const reload = () =>
    api<SessionRow[]>(`/api/sessions?limit=200&scope=${scopeRef.current}`)
      .then(setSessions)
      .catch(() => setSessions([]));
  useEffect(() => {
    setSessions(null);
    reload();
    return openEvents((name) => {
      if (name === 'session-upserted') reload();
    });
  }, [scope]);
  if (!sessions) return <div class="empty">Loading…</div>;

  const projects = [...new Set(sessions.map((s) => projName(s.projectPath)))].sort();
  const members = [...new Set(sessions.map((s) => s.memberName).filter(Boolean))] as string[];
  const agents = [...new Set(sessions.map((s) => s.source))];
  const filtered = sessions.filter(
    (s) =>
      (!project || projName(s.projectPath) === project) &&
      (!member || s.memberName === member) &&
      (!agent || s.source === agent),
  );

  // group by day so a long history stays scannable
  const groups: { label: string; rows: SessionRow[] }[] = [];
  for (const s of filtered) {
    const label = dayLabel(s.updatedAt);
    const last = groups.at(-1);
    if (last && last.label === label) last.rows.push(s);
    else groups.push({ label, rows: [s] });
  }

  return (
    <div>
      <h1>Sessions</h1>
      <div class="filters">
        {me.kind === 'member' && (
          <span class="scope-pills">
            <button class={scope === 'team' ? 'on' : ''} onClick={() => setScope('team')}>
              Team
            </button>
            <button class={scope === 'personal' ? 'on' : ''} onClick={() => setScope('personal')}>
              Personal
            </button>
          </span>
        )}
        <select value={agent} onChange={(e) => setAgent((e.target as HTMLSelectElement).value)}>
          <option value="">all agents</option>
          {agents.map((a) => (
            <option value={a}>{AGENT_LABELS[a] ?? a}</option>
          ))}
        </select>
        <select value={member} onChange={(e) => setMember((e.target as HTMLSelectElement).value)}>
          <option value="">everyone</option>
          {members.map((m) => (
            <option value={m}>{m}</option>
          ))}
        </select>
        <select value={project} onChange={(e) => setProject((e.target as HTMLSelectElement).value)}>
          <option value="">all projects</option>
          {projects.map((p) => (
            <option value={p}>{p}</option>
          ))}
        </select>
        {(project || member || agent) && (
          <a
            class="nav-item"
            style="padding:4px 8px"
            onClick={() => {
              setProject('');
              setMember('');
              setAgent('');
            }}
          >
            clear
          </a>
        )}
      </div>
      <NowWorking sessions={sessions} />
      {sessions.length > 0 && filtered.length === 0 ? (
        <div class="empty">No sessions match these filters.</div>
      ) : sessions.length === 0 ? (
        <div class="empty">
          {scope === 'personal' ? (
            <>
              Your personal drawer is empty — sessions of projects not marked with{' '}
              <code>motif projects team</code> land here, visible only to you.
            </>
          ) : (
            <>
              Nothing team-visible yet. Mark company projects with{' '}
              <code>motif projects team &lt;path&gt;</code>, or promote a personal session from its page.
            </>
          )}
        </div>
      ) : (
        <div class="thread">
          {groups.map((g) => (
            <div key={g.label}>
              <div class="day-label">{g.label}</div>
              {g.rows.map((s) => (
                <SessionCard key={s.id} s={s} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── session detail ──────────────────────────────────── */

function ChatTurn({
  m,
  memberName,
  source,
  pins,
  canPin,
  composerOpen,
  onOpenComposer,
  onPost,
  onDelete,
  myName,
}: {
  m: Message;
  memberName: string | null;
  source: string;
  pins: Comment[];
  canPin: boolean;
  composerOpen: boolean;
  onOpenComposer: () => void;
  onPost: (body: string) => void;
  onDelete: (id: number) => void;
  myName?: string;
}) {
  const [draft, setDraft] = useState('');
  if (m.role === 'reasoning') return null;
  if (m.role === 'tool_call' || m.role === 'tool_result') {
    // tool activity reads like a system event between bubbles
    const label = m.role === 'tool_call' ? `⚙ ${m.toolName ?? 'tool'}` : '↳ result';
    const body = m.role === 'tool_call' ? JSON.stringify(m.toolInput ?? {}, null, 2) : (m.text ?? '');
    if (!body || body === '{}') return null;
    return (
      <div class="activity">
        <details>
          <summary>{label}</summary>
          <pre>{body.length > 4000 ? `${body.slice(0, 4000)}…` : body}</pre>
        </details>
      </div>
    );
  }
  const text = (m.text ?? '').trim();
  if (!text) return null;
  const isUser = m.role === 'user';
  return (
    <div class={`turn ${isUser ? 'user' : 'agent'}`}>
      <span class="av">
        {isUser ? (
          <Avatar name={memberName} size={30} />
        ) : (
          <span class="agent-av">
            <AgentMark source={source} size={17} />
          </span>
        )}
      </span>
      <div class="bubble-col">
        <div class="bubble">{text.length > 6000 ? `${text.slice(0, 6000)}…` : text}</div>
        {pins.length > 0 && (
          <div class="pins">
            {pins.map((c) => (
              <div class="pin" key={c.id}>
                <Avatar name={c.author_name} size={16} />
                <span>
                  <span class="who">{c.author_name}</span>
                  {c.body}
                </span>
                <span class="when">{ago(c.created_at)}</span>
                {myName && c.author_name === myName && (
                  <span class="del" title="Delete note" onClick={() => onDelete(c.id)}>
                    ×
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {composerOpen && (
          <div class="pin-composer">
            <input
              type="text"
              placeholder="Pin a note… (@Name notifies them)"
              value={draft}
              onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && draft.trim()) {
                  onPost(draft.trim());
                  setDraft('');
                }
              }}
            />
            <button
              class="primary"
              onClick={() => {
                if (draft.trim()) {
                  onPost(draft.trim());
                  setDraft('');
                }
              }}
            >
              Pin
            </button>
          </div>
        )}
      </div>
      {canPin && !composerOpen && (
        <button class="pin-btn" title="Pin a note here" onClick={onOpenComposer}>
          ﹢
        </button>
      )}
    </div>
  );
}

function HandoffPanel({ session, me }: { session: SessionDetail; me: Me }) {
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<{ threadId?: string; outputPath?: string; error?: string }>({});
  const [slow, setSlow] = useState(false);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [teammate, setTeammate] = useState('');
  const [sentTo, setSentTo] = useState('');
  const reqId = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (me.kind === 'member')
      api<MemberRow[]>('/api/members')
        .then(setMembers)
        .catch(() => setMembers([]));
  }, [me.kind]);

  useEffect(() => {
    if (state !== 'working') return;
    const slowTimer = setTimeout(() => setSlow(true), 15000);
    // The live stream is the fast path; this poll is the one that survives a
    // dropped EventSource, a sleeping laptop, or an event that arrives before
    // the POST resolves. Without it the panel waits forever.
    const settle = (
      status?: string,
      d: { targetSessionId?: string; outputPath?: string; error?: string } = {},
    ) => {
      if (status === 'done') {
        setState('done');
        setResult({ threadId: d.targetSessionId, outputPath: d.outputPath });
      } else if (status === 'error') {
        setState('error');
        setResult({ error: d.error ?? 'unknown error' });
      }
    };
    const poll = setInterval(() => {
      const id = reqId.current;
      if (id === undefined) return;
      api<{ status?: string; target_session_id?: string; output_path?: string; error?: string }>(
        `/api/handoff-requests/${id}`,
      )
        .then((r) =>
          settle(r.status, {
            targetSessionId: r.target_session_id,
            outputPath: r.output_path,
            error: r.error,
          }),
        )
        .catch(() => {});
    }, 3000);
    const stop = openEvents((name, data) => {
      const d = data as {
        requestId?: number;
        status?: string;
        targetSessionId?: string;
        outputPath?: string;
        error?: string;
      };
      if (name === 'handoff-request-updated' && d.requestId === reqId.current) {
        if (d.status === 'done') {
          setState('done');
          setResult({ threadId: d.targetSessionId, outputPath: d.outputPath });
        } else {
          setState('error');
          setResult({ error: d.error ?? 'unknown error' });
        }
      }
    });
    return () => {
      clearTimeout(slowTimer);
      clearInterval(poll);
      stop();
    };
  }, [state]);

  const [target, setTarget] = useState('');
  const request = async (assignee: string | undefined, chosenTarget: string) => {
    setState('working');
    setSlow(false);
    setSentTo(assignee ?? '');
    setTarget(chosenTarget);
    try {
      const r = await api<HandoffRequest>('/api/handoff-requests', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: session.id,
          target: chosenTarget,
          ...(assignee ? { assignee } : {}),
        }),
      });
      reqId.current = r.id;
    } catch (err) {
      setState('error');
      setResult({ error: String((err as Error).message) });
    }
  };
  const targets = (['claude-code', 'codex'] as const).filter((t) => t !== session.source);
  const resumeCmd = (id?: string) =>
    target === 'claude-code' ? `claude --resume ${id}` : `codex resume ${id}`;

  if (me.kind !== 'member') {
    return (
      <div>
        <button disabled>Continue in…</button>
        <div class="hint">
          Handoff runs on your machine via your daemon. Sign in with your member token (see
          ~/.motif/config.json) to enable it.
        </div>
      </div>
    );
  }
  const teammates = members.filter((m) => m.id !== me.member?.id);
  return (
    <div>
      <div class="cont-label">Continue in</div>
      <div class="cont-row" style="margin-top:6px">
        {targets.map((t) => (
          <button class="primary" onClick={() => request(undefined, t)} disabled={state === 'working'}>
            <AgentMark source={t} size={15} />
            {AGENT_LABELS[t]}
          </button>
        ))}
      </div>
      {teammates.length > 0 && (
        <div class="searchrow" style="margin:8px 0 0;max-width:none">
          <select
            style="flex:1;background:var(--panel);border:1px solid var(--border);border-radius:7px;color:var(--dim);font:inherit;font-size:12px;padding:6px 8px"
            value={teammate}
            onChange={(e) => setTeammate((e.target as HTMLSelectElement).value)}
          >
            <option value="">hand to teammate…</option>
            {teammates.map((m) => (
              <option value={m.name}>{m.name}</option>
            ))}
          </select>
          <button
            style="width:auto"
            disabled={!teammate || state === 'working'}
            onClick={() => request(teammate, targets[0]!)}
          >
            Send
          </button>
        </div>
      )}
      {state === 'working' && (
        <div class="hint status-wait">
          {sentTo
            ? `Waiting for ${sentTo}'s daemon to materialize the session on their machine…`
            : 'Waiting for your daemon to materialize the session…'}
          {slow && !sentTo && (
            <>
              <br />
              Taking long — is the daemon running? <code>motif daemon start</code>
            </>
          )}
          {slow && sentTo && (
            <>
              <br />
              They'll pick it up whenever their daemon is next online.
            </>
          )}
        </div>
      )}
      {state === 'done' && (
        <div class="hint status-ok">
          {sentTo ? (
            <>
              Delivered — {sentTo} has it in their {AGENT_LABELS[target] ?? target} now, with a ready-to-run
              resume command.
            </>
          ) : (
            <>
              Ready on your machine. Continue with:
              <div
                class="cmd"
                title="Click to copy"
                onClick={() => navigator.clipboard?.writeText(resumeCmd(result.threadId))}
              >
                {resumeCmd(result.threadId)}
              </div>
            </>
          )}
        </div>
      )}
      {state === 'error' && <div class="hint status-err">{result.error}</div>}
    </div>
  );
}

function SessionNoteComposer({ onPost }: { onPost: (body: string) => void }) {
  const [draft, setDraft] = useState('');
  const send = () => {
    if (!draft.trim()) return;
    onPost(draft.trim());
    setDraft('');
  };
  return (
    <div class="pin-composer" style="max-width:none">
      <input
        type="text"
        placeholder="Pin a note onto this session… (@Name notifies them)"
        value={draft}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === 'Enter' && send()}
      />
      <button class="primary" onClick={send}>
        Pin
      </button>
    </div>
  );
}

function SessionView({ id, me }: { id: string; me: Me }) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [asks, setAsks] = useState<Ask[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [composerFor, setComposerFor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const reload = () =>
    api<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`)
      .then(setSession)
      .catch((e) => setError(String(e.message)));
  const loadComments = () =>
    api<Comment[]>(`/api/sessions/${encodeURIComponent(id)}/comments`)
      .then(setComments)
      .catch(() => {});
  const loadAsks = () =>
    api<Ask[]>(`/api/sessions/${encodeURIComponent(id)}/asks`)
      .then(setAsks)
      .catch(() => {});
  const askSession = async () => {
    if (!question.trim()) return;
    setAsking(true);
    await api(`/api/sessions/${encodeURIComponent(id)}/asks`, {
      method: 'POST',
      body: JSON.stringify({ question: question.trim() }),
    }).catch(() => {});
    setQuestion('');
    setAsking(false);
    loadAsks();
  };
  useEffect(() => {
    reload();
    loadComments();
    loadAsks();
    return openEvents((name, data) => {
      if (name === 'session-upserted' && (data as { id?: string }).id === id) reload();
      if (name === 'comment-added' && (data as { sessionId?: string }).sessionId === id) loadComments();
      if (
        (name === 'ask-requested' || name === 'ask-answered') &&
        (data as { sessionId?: string }).sessionId === id
      )
        loadAsks();
    });
  }, [id]);
  const postComment = async (messageId: string | null, body: string) => {
    setComposerFor(null);
    await api(`/api/sessions/${encodeURIComponent(id)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body, messageId: messageId ?? undefined }),
    }).catch(() => {});
    loadComments();
  };
  const removeComment = async (commentId: number) => {
    await api(`/api/sessions/${encodeURIComponent(id)}/comments/${commentId}`, { method: 'DELETE' }).catch(
      () => {},
    );
    loadComments();
  };
  if (error) return <div class="empty">{error}</div>;
  if (!session) return <div class="empty">Loading…</div>;

  const mine = me.kind === 'member' && me.member?.id !== undefined && session.memberName === me.member.name;
  const toggleVisibility = async () => {
    const next = session.visibility === 'personal' ? 'team' : 'personal';
    const verb =
      next === 'team'
        ? 'Share this session with the whole team?'
        : 'Move this session back to your personal drawer?';
    if (!confirm(verb)) return;
    await api(`/api/sessions/${encodeURIComponent(session.id)}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ visibility: next }),
    }).catch(() => {});
    reload();
  };

  return (
    <div class="detail">
      <div class="transcript chat">
        <h1>{session.title ?? '(untitled)'}</h1>
        {session.messages.map((m) => (
          <ChatTurn
            key={m.id}
            m={m}
            memberName={session.memberName}
            source={session.source}
            pins={comments.filter((c) => c.message_id === m.id)}
            canPin={me.kind === 'member'}
            composerOpen={composerFor === m.id}
            onOpenComposer={() => setComposerFor(m.id)}
            onPost={(body) => postComment(m.id, body)}
            onDelete={removeComment}
            myName={me.member?.name}
          />
        ))}
        <div class="notes-box">
          <h2>Ask this session</h2>
          {asks.map((a) => (
            <div class={`ask ${a.status}`} key={a.id}>
              <div class="ask-q">
                <Avatar name={a.asker_name} size={16} />
                <span>
                  <span class="who">{a.asker_name}</span>
                  {a.question}
                </span>
                <span class="when">{ago(a.created_at)}</span>
              </div>
              {a.status === 'pending' && (
                <div class="ask-a pending">…waiting for the machine that owns this session</div>
              )}
              {a.status === 'error' && <div class="ask-a err">{a.error}</div>}
              {a.answer && <div class="ask-a">{a.answer}</div>}
            </div>
          ))}
          {session.source === 'cursor' && (
            <div class="hint">
              Cursor sessions cannot be asked: Cursor has no resume-from-transcript command, so there is
              nothing to put the question to. Read it here, or hand it to Claude Code or Codex first.
            </div>
          )}
          {me.kind === 'member' && session.source !== 'cursor' && (
            <div class="pin-composer" style="max-width:none">
              <input
                type="text"
                placeholder="Ask the agent that lived this session… (it answers with full context)"
                value={question}
                disabled={asking}
                onInput={(e) => setQuestion((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => e.key === 'Enter' && askSession()}
              />
              <button class="primary" onClick={askSession} disabled={asking || !question.trim()}>
                {asking ? 'Asking…' : 'Ask'}
              </button>
            </div>
          )}

          <h2 style="margin-top:24px">Notes on this session</h2>
          {comments
            .filter((c) => c.message_id === null)
            .map((c) => (
              <div class="pin" key={c.id} style="max-width:none;margin-bottom:6px">
                <Avatar name={c.author_name} size={16} />
                <span>
                  <span class="who">{c.author_name}</span>
                  {c.body}
                </span>
                <span class="when">{ago(c.created_at)}</span>
                {me.kind === 'member' && c.author_name === me.member?.name && (
                  <span class="del" onClick={() => removeComment(c.id)}>
                    ×
                  </span>
                )}
              </div>
            ))}
          {me.kind === 'member' && <SessionNoteComposer onPost={(body) => postComment(null, body)} />}
        </div>
      </div>
      <div class="meta-panel">
        <div class="spec">
          <div class="spec-head">
            <span class="agent-av">
              <AgentMark source={session.source} size={24} />
            </span>
            <div class="agent-name">{AGENT_LABELS[session.source] ?? session.source}</div>
            <div class="model">{session.meta?.model ?? 'model unknown'}</div>
          </div>
          <div class="spec-stitch" />
          <div class="spec-grid">
            <div class="spec-cell">
              <div class="k">Messages</div>
              <div class="v">{session.messages.length}</div>
            </div>
            <div class="spec-cell">
              <div class="k">Size</div>
              <div class="v">{kb(session.meta?.sourceBytes)}</div>
            </div>
            <div class="spec-cell">
              <div class="k">Started</div>
              <div class="v">{fullDate(session.createdAt)}</div>
            </div>
            <div class="spec-cell">
              <div class="k">Updated</div>
              <div class="v">{fullDate(session.updatedAt)}</div>
            </div>
          </div>
          <div class="spec-row">
            <span class="chip" style="gap:6px">
              <Avatar name={session.memberName} size={16} />@{session.memberName ?? 'unknown'}
            </span>
            <span
              class={`chip vis-chip ${session.visibility === 'personal' ? 'personal' : ''}`}
              title={mine ? 'Click to change' : undefined}
              onClick={mine ? toggleVisibility : undefined}
            >
              {session.visibility === 'personal' ? '◐ Personal' : '✓ Team'}
              {mine && ' ▾'}
            </span>
            <span class="chip mono" style="font-size:10.5px">
              {projName(session.projectPath)}
            </span>
          </div>
          <div class="spec-stitch" />
          <div class="spec-actions" style="margin-top:12px">
            <HandoffPanel session={session} me={me} />
            <button onClick={() => navigator.clipboard?.writeText(location.href)}>Copy link</button>
          </div>
          <div class="spec-foot">
            <details>
              <summary>Details</summary>
              <div class="session-id mono">{session.id}</div>
              {session.sourcePath && (
                <div class="session-id mono" style="margin-top:6px">
                  {session.sourcePath}
                </div>
              )}
              <div class="session-id mono" style="margin-top:6px">
                {session.projectPath}
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── people ──────────────────────────────────────────── */

function PeoplePage({ me }: { me: Me }) {
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const reload = () =>
    api<MemberRow[]>('/api/members')
      .then(setMembers)
      .catch(() => setMembers([]));
  useEffect(() => {
    reload();
  }, []);
  const amOwner = me.kind === 'member' && me.member?.role === 'owner';
  const revoke = async (m: MemberRow) => {
    if (!confirm(`Revoke ${m.name}'s access? Their devices stop syncing immediately; their sessions stay.`))
      return;
    await api(`/api/members/${m.id}/revoke`, { method: 'POST', body: '{}' }).catch(() => {});
    reload();
  };
  if (!members) return <div class="empty">Loading…</div>;
  return (
    <div>
      <h1>People</h1>
      <div class="table">
        {members.map((m) => (
          <div class="people-row" key={m.id}>
            <Avatar name={m.name} size={26} />
            <span class="name">{m.name}</span>
            <span class="email">{m.email ?? ''}</span>
            <span class="machine mono">{m.machine ?? ''}</span>
            <span class="chip">{m.role}</span>
            <span class="seen">{ago(m.last_seen_at)}</span>
            {amOwner && m.id !== me.member?.id && (
              <button style="width:auto;padding:4px 10px;font-size:11px" onClick={() => revoke(m)}>
                revoke
              </button>
            )}
          </div>
        ))}
      </div>
      {amOwner && (
        <div class="hint" style="margin-top:10px">
          Revoking removes a member's device tokens — they stop syncing instantly. To keep them out for good,
          also rotate the team token (restart the server with a new MOTIF_TOKEN).
        </div>
      )}
    </div>
  );
}

/* ── memory ──────────────────────────────────────────── */

function ReviewNoteCard({ n, label }: { n: ReviewNote; label?: string }) {
  return (
    <div class={`note ${n.status}`}>
      <div class="aspect">
        {label && <strong>{label} · </strong>}[{n.kind}] {n.entity} · {n.aspect}
        {n.stale ? ` · stale: ${n.stale_reason ?? 'its files moved on'}` : ''}
      </div>
      <div>{n.body}</div>
      <div class="aspect" style="margin-top:6px">
        {n.author_name ? `@${n.author_name}` : 'unknown'} · {ago(n.created_at)}
        {n.session_id && (
          <>
            {' · '}
            <a href={`#/sessions/${encodeURIComponent(n.session_id)}`}>source session</a>
          </>
        )}
      </div>
    </div>
  );
}

function ReviewPage({ me }: { me: Me }) {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = () =>
    api<{ items: ReviewItem[] }>('/api/memory/review')
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  useEffect(() => {
    reload();
    return openEvents((name) => {
      if (name === 'memory-updated' || name === 'memory-reviewed') reload();
    });
  }, []);

  const canRule = me.kind === 'member';
  const rule = async (noteId: number, verdict: 'confirm' | 'prefer' | 'retire', overNoteId?: number) => {
    setBusy(true);
    try {
      await api(`/api/memory/notes/${noteId}/verdict`, {
        method: 'POST',
        body: JSON.stringify({ verdict, overNoteId }),
      });
      await reload();
    } catch (err) {
      alert(String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!items) return <div class="empty">Loading…</div>;
  return (
    <div style="max-width:760px">
      <h1>Review</h1>
      {items.length === 0 && <div class="empty">Nothing waits for a ruling — the memory is at peace.</div>}
      {!canRule && items.length > 0 && (
        <div class="empty">Signed in with the team token — rulings need a member token.</div>
      )}
      {items.map((item) =>
        item.type === 'conflict' && item.against ? (
          <div key={item.note.id} class="review-item">
            <div class="aspect" style="margin-bottom:6px">
              <span class="chip conflict">conflict</span> two sessions disagree — agents see both sides until
              someone rules
            </div>
            <ReviewNoteCard n={item.against} label="standing" />
            <ReviewNoteCard n={item.note} label="challenger" />
            <div class="review-actions">
              <button
                disabled={!canRule || busy}
                onClick={() => rule(item.against!.id, 'prefer', item.note.id)}
              >
                Keep the standing note
              </button>
              <button
                class="primary"
                disabled={!canRule || busy}
                onClick={() => rule(item.note.id, 'prefer', item.against!.id)}
              >
                The challenger is right
              </button>
              <button disabled={!canRule || busy} onClick={() => rule(item.note.id, 'retire')}>
                Retire the challenge
              </button>
            </div>
          </div>
        ) : (
          <div key={item.note.id} class="review-item">
            <div class="aspect" style="margin-bottom:6px">
              <span class="chip">{item.type}</span>{' '}
              {item.type === 'stale'
                ? 'the files this note came from have moved on since'
                : 'someone flagged this note as wrong'}
            </div>
            <ReviewNoteCard n={item.note} />
            <div class="review-actions">
              <button
                class="primary"
                disabled={!canRule || busy}
                onClick={() => rule(item.note.id, 'confirm')}
              >
                Still true
              </button>
              <button disabled={!canRule || busy} onClick={() => rule(item.note.id, 'retire')}>
                Retire it
              </button>
            </div>
          </div>
        ),
      )}
    </div>
  );
}

function MemoryPage() {
  const [entities, setEntities] = useState<MemoryEntity[] | null>(null);
  const reload = () =>
    api<MemoryEntity[]>('/api/memory/entities')
      .then(setEntities)
      .catch(() => setEntities([]));
  useEffect(() => {
    reload();
    return openEvents((name) => {
      if (name === 'memory-updated') reload();
    });
  }, []);
  if (!entities) return <div class="empty">Loading…</div>;
  const kinds = ['decision', 'file', 'topic'];
  return (
    <div>
      <h1>Memory</h1>
      {entities.length === 0 && (
        <div class="empty">
          No memory yet. Enable it on the server with <code>MOTIF_LLM_PROVIDER</code> — notes appear as
          sessions go idle.
        </div>
      )}
      {kinds.map((kind) => {
        const of = entities.filter((e) => e.kind === kind);
        if (of.length === 0) return null;
        return (
          <div key={kind}>
            <h2>{kind}s</h2>
            <div class="table">
              {of.map((e) => (
                <a key={e.id} class="row" href={`#/memory/${e.id}`}>
                  <span class="title">{e.name}</span>
                  <span class="who">
                    <span>{projName(e.project_path)}</span>
                  </span>
                  <span class="vis">
                    <span class="chip">{e.current_notes} notes</span>
                  </span>
                  <span class="ago">
                    {e.conflicts > 0 && <span class="chip conflict">{e.conflicts} conflict</span>}
                  </span>
                </a>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MemoryEntityView({ id }: { id: string }) {
  const [data, setData] = useState<{ entity: MemoryEntity; notes: MemoryNote[] } | null>(null);
  useEffect(() => {
    api<{ entity: MemoryEntity; notes: MemoryNote[] }>(`/api/memory/entities/${id}`)
      .then(setData)
      .catch(() => {});
  }, [id]);
  if (!data) return <div class="empty">Loading…</div>;
  return (
    <div style="max-width:760px">
      <h1>
        <span style="color:var(--faint)">[{data.entity.kind}]</span> {data.entity.name}
      </h1>
      {data.notes.map((n) => (
        <div key={n.id} class={`note ${n.status}`}>
          <div class="aspect">
            {n.aspect} · {n.status} · {ago(n.created_at)}
          </div>
          <div>{n.body}</div>
        </div>
      ))}
    </div>
  );
}

/* ── search ──────────────────────────────────────────── */

function SearchPage() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const run = () => {
    if (q.trim())
      api<SessionRow[]>(`/api/search?q=${encodeURIComponent(q)}`)
        .then(setRows)
        .catch(() => setRows([]));
  };
  return (
    <div>
      <h1>Search</h1>
      <div class="searchrow">
        <input
          type="text"
          placeholder="Search every session, every teammate, every tool…"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <button class="primary" onClick={run}>
          Search
        </button>
      </div>
      {rows && rows.length === 0 && <div class="empty">No matches.</div>}
      {rows && rows.length > 0 && (
        <div class="thread">
          {rows.map((s) => (
            <SessionCard key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── setup ───────────────────────────────────────────── */

function SetupPage({ me }: { me: Me }) {
  const origin = location.origin;
  const [teamName, setTeamName] = useState('');
  const [renamed, setRenamed] = useState(false);
  const amOwner = me.kind === 'member' && me.member?.role === 'owner';
  const rename = async () => {
    if (!teamName.trim()) return;
    await api('/api/team', { method: 'PATCH', body: JSON.stringify({ name: teamName.trim() }) }).catch(
      () => {},
    );
    setRenamed(true);
    setTimeout(() => location.reload(), 600);
  };
  return (
    <div style="max-width:680px">
      <h1>Setup</h1>
      {amOwner && (
        <>
          <h2>Team</h2>
          <div class="meta-card">
            <div class="searchrow" style="margin-bottom:0">
              <input
                type="text"
                placeholder="team name"
                value={teamName}
                onInput={(e) => setTeamName((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => e.key === 'Enter' && rename()}
              />
              <button class="primary" onClick={rename}>
                {renamed ? 'Saved' : 'Rename'}
              </button>
            </div>
          </div>
        </>
      )}
      <h2>Connect a teammate</h2>
      <div class="meta-card">
        <p style="color:var(--dim);margin-bottom:8px">
          On their machine, with the team token you share out-of-band:
        </p>
        <div class="cmd">
          npx getmotif connect {origin} --token &lt;team-token&gt; --name "Ada" --email ada@team.dev
        </div>
        <div class="cmd">motif daemon start</div>
        <div class="hint">
          The daemon streams their sessions here live and fulfils their dashboard handoffs.
        </div>
      </div>
      <h2>Your login</h2>
      <div class="meta-card">
        {me.kind === 'member' ? (
          <p style="color:var(--dim)">
            Signed in as <b>@{me.member?.name}</b> ({me.member?.role}) with your personal member token —
            actions like handoff are enabled.
          </p>
        ) : (
          <p style="color:var(--dim)">
            Signed in with the shared <b>team token</b> — read-only. To enable actions, sign out and log in
            with your personal member token from <code>~/.motif/config.json</code> on your machine.
          </p>
        )}
      </div>
      <h2>Privacy</h2>
      <div class="meta-card">
        <p style="color:var(--dim); line-height:1.6">
          Sessions stay on this server — nothing leaves your infrastructure. Doing personal work on the same
          machine? Switch that machine to allowlist mode so <b>only</b> company projects sync:
        </p>
        <div class="cmd">motif projects mode selected</div>
        <div class="cmd">motif projects include ~/work/company-repo</div>
        <p style="color:var(--dim); line-height:1.6; margin-top:8px">
          Or stay in default mode and block specific projects with{' '}
          <code>motif projects exclude &lt;path&gt; --purge</code> (purge also withdraws already-synced
          sessions). <code>redactPatterns</code> in <code>~/.motif/config.json</code> scrub secrets before
          upload. Put TLS in front with a reverse proxy for teams outside a trusted network.
        </p>
      </div>
    </div>
  );
}

/* ── login gate ──────────────────────────────────────── */

function TokenGate({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    setToken(value.trim());
    try {
      await api('/api/me');
      onDone();
    } catch {
      clearToken();
      setError('that token was rejected by the server');
    }
  };
  return (
    <div class="center">
      <img src="/brand/logo.png" alt="motif" style="width:200px;mix-blend-mode:multiply" />
      <div style="color:var(--dim);line-height:1.6">
        Sign in with your <b>member token</b> (from <code>~/.motif/config.json</code>, full access) or the
        shared <b>team token</b> (read-only).
      </div>
      <input
        type="password"
        placeholder="token"
        value={value}
        onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {error && <div class="status-err">{error}</div>}
      <button class="primary" style="width:auto;padding:8px 22px" onClick={submit}>
        Sign in
      </button>
    </div>
  );
}

/* ── app shell ───────────────────────────────────────── */

const THEME_ICONS: Record<Theme, string> = { system: '◐', light: '☀', dark: '☾' };

function App() {
  const hash = useHash();
  const [theme, cycleTheme] = useTheme();
  const [authed, setAuthed] = useState(!!getToken());
  const [me, setMe] = useState<Me>({ kind: 'team' });
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [team, setTeam] = useState('Team');

  useEffect(() => {
    if (!authed) return;
    // a stale/revoked token must bounce to the gate, not strand the app on silent 401s
    api<Me>('/api/me')
      .then(setMe)
      .catch((e: Error) => {
        if (e.message === 'unauthorized') {
          clearToken();
          setAuthed(false);
        }
      });
    api<{ name: string }>('/api/team')
      .then((t) => setTeam(t.name))
      .catch(() => {});
    const loadMembers = () =>
      api<MemberRow[]>('/api/members')
        .then(setMembers)
        .catch(() => setMembers([]));
    loadMembers();
    return openEvents((name) => {
      if (name === 'member-joined') loadMembers();
    });
  }, [authed]);

  const [reviewCount, setReviewCount] = useState(0);
  useEffect(() => {
    if (!authed) return;
    const loadCount = () =>
      api<{ items: unknown[] }>('/api/memory/review')
        .then((r) => setReviewCount(r.items.length))
        .catch(() => setReviewCount(0));
    loadCount();
    return openEvents((name) => {
      if (name === 'memory-updated' || name === 'memory-reviewed') loadCount();
    });
  }, [authed]);

  if (!authed) return <TokenGate onDone={() => setAuthed(true)} />;

  const nav = [
    ['#/', 'Sessions', /^\/(sessions.*)?$/],
    ['#/people', 'People', /^\/people/],
    ['#/memory', 'Memory', /^\/memory/],
    ['#/review', 'Review', /^\/review/],
    ['#/search', 'Search', /^\/search/],
    ['#/setup', 'Setup', /^\/setup/],
  ] as const;

  let view = <SessionsPage me={me} />;
  let crumb = 'Sessions';
  const sessionMatch = hash.match(/^\/sessions\/(.+)$/);
  const memoryMatch = hash.match(/^\/memory\/(\d+)$/);
  if (sessionMatch) {
    view = <SessionView id={decodeURIComponent(sessionMatch[1])} me={me} />;
    crumb = 'Sessions';
  } else if (memoryMatch) {
    view = <MemoryEntityView id={memoryMatch[1]} />;
    crumb = 'Memory';
  } else if (hash.startsWith('/people')) {
    view = <PeoplePage me={me} />;
    crumb = 'People';
  } else if (hash.startsWith('/memory')) {
    view = <MemoryPage />;
    crumb = 'Memory';
  } else if (hash.startsWith('/review')) {
    view = <ReviewPage me={me} />;
    crumb = 'Review';
  } else if (hash.startsWith('/search')) {
    view = <SearchPage />;
    crumb = 'Search';
  } else if (hash.startsWith('/setup')) {
    view = <SetupPage me={me} />;
    crumb = 'Setup';
  }

  return (
    <>
      <div class="topbar">
        <a class="brand" href="#/">
          <img class="brand-img" src="/brand/logo.png" alt="motif" />
        </a>
        <span class="crumb">/</span>
        <span class="crumb-item">{team}</span>
        <span class="crumb">/</span>
        <span class="crumb-item">{crumb}</span>
        <span class="spacer" />
        <a class="nav-item theme-toggle" title={`Theme: ${theme}`} onClick={cycleTheme}>
          {THEME_ICONS[theme]}
        </a>
        <span class="whoami">
          {me.kind === 'member' ? (
            <>
              <Avatar name={me.member?.name ?? '?'} size={24} /> {me.member?.name}
            </>
          ) : (
            <span class="chip">team token · read-only</span>
          )}
          <a
            class="nav-item"
            style="padding:4px 8px"
            onClick={() => {
              clearToken();
              location.reload();
            }}
          >
            Sign out
          </a>
        </span>
      </div>
      <div class="shell">
        <div class="sidebar">
          {nav.map(([href, label, re]) => (
            <a key={href} class={`nav-item ${re.test(hash) ? 'active' : ''}`} href={href}>
              {label}
              {href === '#/review' && reviewCount > 0 && (
                <span class="chip conflict" style="margin-left:6px">
                  {reviewCount}
                </span>
              )}
            </a>
          ))}
          {members.length > 0 && (
            <>
              <div class="side-heading">Members</div>
              {members.map((m) => (
                <div class="side-member" key={m.id}>
                  <Avatar name={m.name} size={20} />
                  <span>{m.name}</span>
                  <span class="role">{m.role === 'owner' ? 'Owner' : ''}</span>
                </div>
              ))}
            </>
          )}
        </div>
        <div class="main">{view}</div>
      </div>
    </>
  );
}

// `motif ui` opens the dashboard with a one-time token in the query string, so a
// local user never copies anything. Consume it before the first render and strip
// it from the URL so it does not linger in history or get pasted to someone.
try {
  const here = new URL(location.href);
  const handed = here.searchParams.get('token');
  if (handed) {
    setToken(handed);
    here.searchParams.delete('token');
    history.replaceState(null, '', here.pathname + here.search + here.hash);
  }
} catch {
  /* non-browser context, or storage unavailable */
}

render(<App />, document.getElementById('app')!);
