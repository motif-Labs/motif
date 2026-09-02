import { render, type ComponentChildren, type JSX } from 'preact';
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

const ic = (d: ComponentChildren) => (
  <svg
    class="nav-ic"
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    {d}
  </svg>
);
/* the sidebar speaks SF Symbols' dialect: geometric, stroked, quiet */
const NAV_ICONS: Record<string, JSX.Element> = {
  '#/': ic(
    <>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </>,
  ),
  '#/sessions': ic(
    <>
      <path d="M3 4.5h10M3 8h10M3 11.5h6" />
      <circle cx="12.5" cy="11.5" r="1.6" fill="currentColor" stroke="none" />
    </>,
  ),
  '#/people': ic(
    <>
      <circle cx="5.5" cy="5.5" r="2.4" />
      <path d="M1.8 13.2c.5-2.6 1.9-3.9 3.7-3.9s3.2 1.3 3.7 3.9" />
      <circle cx="11.5" cy="6" r="1.9" />
      <path d="M10.6 9.6c1.9.1 3.1 1.3 3.6 3.4" />
    </>,
  ),
  '#/memory': ic(
    <>
      <path d="M8 1.8 14.2 8 8 14.2 1.8 8Z" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
    </>,
  ),
  '#/review': ic(
    <>
      <path d="M8 2.5v11M4.5 13.5h7M4 5l8-1.5" />
      <path d="M4 5 2.2 8.6a2 2 0 0 0 3.6 0ZM12 3.5l-1.8 3.6a2 2 0 0 0 3.6 0Z" />
    </>,
  ),
  '#/search': ic(
    <>
      <circle cx="7" cy="7" r="4.2" />
      <path d="m10.2 10.2 3.4 3.4" />
    </>,
  ),
  '#/weave': ic(
    <>
      <circle cx="4" cy="4" r="1.6" />
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="7.5" cy="12" r="1.6" />
      <path d="M4 4l3.5 8M12 5L7.5 12M4 4l8 1" />
    </>,
  ),
  '#/setup': ic(
    <>
      <path d="M2.5 5h4.4m3.2 0h5.4M2.5 11h7.4m3.2 0h2.4" />
      <circle cx="8.5" cy="5" r="1.7" />
      <circle cx="11.5" cy="11" r="1.7" />
    </>,
  ),
};

function ConfidenceBar({ value }: { value: number }) {
  const level = value >= 0.75 ? 'high' : value >= 0.5 ? 'medium' : 'low';
  return (
    <span class={`conf conf-${level}`} title={`${level} confidence`}>
      <span class="conf-fill" style={`width:${Math.round(value * 100)}%`} />
    </span>
  );
}

/** Coalesce a burst of events into one call. */
function debounce<T extends (...a: never[]) => void>(fn: T, ms = 250): T {
  let t: ReturnType<typeof setTimeout> | undefined;
  return ((...a: never[]) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  }) as T;
}

function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div class="skeleton">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} class="bone" style={`opacity:${1 - i * 0.15}`} />
      ))}
    </div>
  );
}

interface Toast {
  id: number;
  glyph: string;
  title: string;
  body?: string;
  href?: string;
}

let toastSeq = 0;

/** The work, felt as it happens: conflicts caught, rulings landing, PRs woven. */
function Toasts() {
  const [toasts, setToasts] = useState<(Toast & { leaving?: boolean })[]>([]);
  useEffect(() => {
    const dismiss = (id: number) => {
      setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 260);
    };
    const push = (t: Omit<Toast, 'id'>) => {
      const id = ++toastSeq;
      setToasts((prev) => [...prev.slice(-2), { ...t, id }]); // never more than 3
      setTimeout(() => dismiss(id), 6000);
    };
    return openEvents((name, data) => {
      if (name === 'memory-conflict') {
        const d = data as { entity: string };
        push({
          glyph: '⚖️',
          title: 'Two sessions disagree',
          body: `“${d.entity}” — agents see both sides until someone rules`,
          href: '#/review',
        });
      }
      if (name === 'memory-reviewed') {
        const d = data as { verdict: string };
        push({
          glyph: '✓',
          title: 'A ruling landed',
          body: `${d.verdict} — recorded, recall obeys`,
          href: '#/review',
        });
      }
      if (name === 'weaver-completed') {
        const d = data as { prUrl?: string };
        if (d.prUrl) {
          push({ glyph: '🧵', title: 'The Weaver opened a draft PR', body: d.prUrl });
        }
      }
      if (name === 'member-joined') {
        const d = data as { name: string };
        push({ glyph: '·', title: `${d.name} joined the team` });
      }
    });
  }, []);
  if (toasts.length === 0) return null;
  return (
    <div class="toasts">
      {toasts.map((t) => (
        <a
          key={t.id}
          class={`toast ${t.leaving ? 'leaving' : ''}`}
          href={t.href}
          onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
        >
          <span class="glyph">{t.glyph}</span>
          <span>
            <div class="t-title">{t.title}</div>
            {t.body && <div class="t-body">{t.body}</div>}
          </span>
        </a>
      ))}
    </div>
  );
}

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
  // muted ink family — identity through hue, never through candy
  '#5b647a',
  '#6b5e73',
  '#566a66',
  '#6e6355',
  '#4f6076',
  '#715860',
  '#5d6a58',
  '#725d5d',
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

function SessionCard({ s, fresh }: { s: SessionRow; fresh?: boolean }) {
  return (
    <div class={`snode ${isActive(s.updatedAt) ? 'live' : ''} ${fresh ? 'fresh' : ''}`}>
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
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const reload = () =>
    api<SessionRow[]>(`/api/sessions?limit=200&scope=${scopeRef.current}`)
      .then(setSessions)
      .catch(() => setSessions([]));
  useEffect(() => {
    setSessions(null);
    reload();
    const reloadList = debounce(reload); // a burst of sessions reloads the list once
    return openEvents((name, data) => {
      if (name !== 'session-upserted') return;
      const id = (data as { id?: string }).id;
      if (id) {
        // the freshness highlight is per-id and cheap — keep it immediate
        setFresh((f) => new Set(f).add(id));
        setTimeout(
          () =>
            setFresh((f) => {
              const next = new Set(f);
              next.delete(id);
              return next;
            }),
          2600,
        );
      }
      reloadList();
    });
  }, [scope]);
  if (!sessions) return <Skeleton rows={6} />;

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
      <div class="page-head">
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
                <SessionCard key={s.id} s={s} fresh={fresh.has(s.id)} />
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
        <h1 class="session-title">{session.title ?? '(untitled)'}</h1>
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
      if (name === 'memory-updated' || name === 'memory-reviewed' || name === 'memory-conflict') reload();
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

  if (!items) return <Skeleton rows={3} />;
  return (
    <div style="max-width:820px">
      <h1>Review</h1>
      {items.length === 0 && <div class="empty">Nothing waits for a ruling — the memory is at peace.</div>}
      {!canRule && items.length > 0 && (
        <div class="empty">Signed in with the team token — rulings need a member token.</div>
      )}
      {items.map((item) =>
        item.type === 'conflict' && item.against ? (
          <div key={item.note.id} class="case">
            <div class="case-head">
              <span class="chip conflict">conflict</span>
              <span class="title">
                {item.against.entity} · {item.against.aspect}
              </span>
              <span>— agents see both sides until someone rules</span>
            </div>
            <div class="case-claims">
              <div class="claim">
                <div class="tag">standing</div>
                <div class="body">{item.against.body}</div>
                <div class="meta">
                  {item.against.author_name ? `@${item.against.author_name}` : 'unknown'} ·{' '}
                  {ago(item.against.created_at)}
                  {item.against.session_id && (
                    <>
                      {' · '}
                      <a href={`#/sessions/${encodeURIComponent(item.against.session_id)}`}>the session</a>
                    </>
                  )}
                </div>
              </div>
              <div class="claim">
                <div class="tag challenger">challenger</div>
                <div class="body">{item.note.body}</div>
                <div class="meta">
                  {item.note.author_name ? `@${item.note.author_name}` : 'unknown'} ·{' '}
                  {ago(item.note.created_at)}
                  {item.note.session_id && (
                    <>
                      {' · '}
                      <a href={`#/sessions/${encodeURIComponent(item.note.session_id)}`}>the session</a>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div class="case-verdict">
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
          <div key={item.note.id} class="case">
            <div class="case-head">
              <span class="chip">{item.type}</span>
              <span class="title">
                {item.note.entity} · {item.note.aspect}
              </span>
              <span>
                {item.type === 'stale'
                  ? `— ${item.note.stale_reason ?? 'its source files moved on'}`
                  : '— flagged as wrong, evidence pending'}
              </span>
            </div>
            <div class="case-claims single">
              <div class="claim">
                <div class="body">{item.note.body}</div>
                <div class="meta">
                  {item.note.author_name ? `@${item.note.author_name}` : 'unknown'} ·{' '}
                  {ago(item.note.created_at)}
                  {item.note.session_id && (
                    <>
                      {' · '}
                      <a href={`#/sessions/${encodeURIComponent(item.note.session_id)}`}>the session</a>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div class="case-verdict">
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

interface GNode {
  id: string;
  type: 'entity' | 'session';
  kind: string;
  label: string;
  project: string;
  confidence?: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}
interface GEdge {
  a: string;
  b: string;
  kind: string;
}

/**
 * The Weave: the record drawn instead of searched. Entities are diamonds,
 * sessions are dots, edges are the real relationships in the tables. A
 * hand-rolled force layout on a canvas — no dependency, fine to a few hundred
 * nodes. Hover lights a node's neighbourhood; click an entity opens it.
 */
interface ActivityItem {
  type: string;
  actor: string | null;
  subject: string;
  at: string;
  href?: string;
}
interface Overview {
  counts: {
    sessions: number;
    members: number;
    projects: number;
    decisions: number;
    conflicts: number;
    gaps: number;
  };
  activeProjects: { project: string; sessions: number; last: string }[];
  recentDecisions: { name: string; body: string; created_at: string; verification: string; status: string }[];
  activity: ActivityItem[];
}

const ACTIVITY_GLYPH: Record<string, string> = {
  session: '',
  'ruling:prefer': '⚖',
  'ruling:confirm': '✓',
  'ruling:retire': '·',
  'ruling:dispute': '?',
  handoff: '⇢',
  weaver: '🧵',
};

function ActivityLine({ a }: { a: ActivityItem }) {
  const verb = a.type.startsWith('ruling')
    ? 'ruled on'
    : a.type === 'handoff'
      ? 'handed off'
      : a.type === 'weaver'
        ? ''
        : 'worked on';
  const inner = (
    <>
      <span class="act-node" data-kind={a.type.split(':')[0]}>
        {ACTIVITY_GLYPH[a.type] ?? ''}
      </span>
      <span class="act-body">
        <span class="act-line">
          {a.actor && <b>{a.actor}</b>} {verb} <span class="act-subj">{a.subject}</span>
        </span>
        <span class="act-when">{ago(a.at)}</span>
      </span>
    </>
  );
  return a.href ? (
    <a class="act" href={a.href}>
      {inner}
    </a>
  ) : (
    <div class="act">{inner}</div>
  );
}

function OverviewPage({ me: _me }: { me: Me }) {
  const [d, setD] = useState<Overview | null>(null);
  useEffect(() => {
    const load = () =>
      api<Overview>('/api/overview')
        .then(setD)
        .catch(() => setD(null));
    load();
    const reloadOv = debounce(load);
    return openEvents((name) => {
      if (
        name === 'session-upserted' ||
        name === 'memory-updated' ||
        name === 'memory-reviewed' ||
        name === 'memory-conflict' ||
        name === 'weaver-completed' ||
        name === 'handoff-created'
      )
        reloadOv();
    });
  }, []);
  if (!d) return <Skeleton rows={5} />;
  const c = d.counts;
  const empty = c.sessions === 0;

  return (
    <div>
      <div class="page-head">
        <h1>Overview</h1>
        <span class="pulse-line">
          <b>{c.sessions}</b> sessions · <b>{c.members}</b> people · <b>{c.projects}</b> projects ·{' '}
          <b>{c.decisions}</b> decisions
        </span>
      </div>

      {empty ? (
        <div class="empty">
          Nothing yet. Run <code>motif up</code> to point it at your own history, or <code>motif demo</code>{' '}
          to see it full.
        </div>
      ) : (
        <div class="ov2">
          <div class="ov2-main">
            <h2>Activity</h2>
            <div class="act-thread">
              {d.activity.map((a, i) => (
                <ActivityLine key={i} a={a} />
              ))}
            </div>
          </div>

          <div class="ov2-side">
            <div class="needs">
              <h2>Needs you</h2>
              {c.conflicts === 0 && c.gaps === 0 ? (
                <div class="needs-clear">
                  <span class="chip live">clear</span> the memory is at peace
                </div>
              ) : (
                <>
                  {c.conflicts > 0 && (
                    <a class="needs-row" href="#/review">
                      <span class="needs-n conflict">{c.conflicts}</span>
                      <span>unresolved conflict{c.conflicts === 1 ? '' : 's'} to rule on</span>
                    </a>
                  )}
                  {c.gaps > 0 && (
                    <a class="needs-row" href="#/sessions">
                      <span class="needs-n">{c.gaps}</span>
                      <span>untested change{c.gaps === 1 ? '' : 's'} the Weaver can close</span>
                    </a>
                  )}
                </>
              )}
            </div>

            <div class="latest">
              <h2>Latest decisions</h2>
              {d.recentDecisions.length === 0 ? (
                <div class="ov-muted">
                  Decisions appear as sessions are distilled — enable it with <code>MOTIF_LLM_PROVIDER</code>.
                </div>
              ) : (
                d.recentDecisions.map((r, i) => (
                  <a key={i} class="latest-row" href="#/memory">
                    <span class="latest-name">
                      {r.name}
                      {r.verification === 'verified' && <span class="chip live">verified</span>}
                      {r.status === 'conflicted' && <span class="chip conflict">conflict</span>}
                    </span>
                    <span class="latest-body">{r.body}</span>
                  </a>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function WeavePage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [data, setData] = useState<{ nodes: GNode[]; edges: GEdge[] } | null>(null);
  const hoverRef = useRef<string | null>(null);

  useEffect(() => {
    api<{ nodes: GNode[]; edges: GEdge[] }>('/api/graph')
      .then(setData)
      .catch(() => setData({ nodes: [], edges: [] }));
  }, []);

  useEffect(() => {
    if (!data || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    let raf = 0;
    let alpha = 1;

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const onResize = () => {
      resize();
      alpha = Math.max(alpha, 0.05);
      wake();
    };
    resize();
    window.addEventListener('resize', onResize);

    const W = () => canvas.width / dpr;
    const H = () => canvas.height / dpr;
    const nodes = data.nodes;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const adj = new Map<string, Set<string>>();
    for (const n of nodes) adj.set(n.id, new Set());
    for (const e of data.edges) {
      adj.get(e.a)?.add(e.b);
      adj.get(e.b)?.add(e.a);
    }
    // seed positions on a loose circle
    nodes.forEach((n, i) => {
      const a = (i / nodes.length) * Math.PI * 2;
      n.x = W() / 2 + Math.cos(a) * 120 + (Math.random() - 0.5) * 40;
      n.y = H() / 2 + Math.sin(a) * 120 + (Math.random() - 0.5) * 40;
      n.vx = 0;
      n.vy = 0;
    });

    const ink = getComputedStyle(document.body).getPropertyValue('--text').trim();
    const faint = getComputedStyle(document.body).getPropertyValue('--faint').trim();
    const border = getComputedStyle(document.body).getPropertyValue('--border').trim();
    const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim();
    const red = getComputedStyle(document.body).getPropertyValue('--red').trim();

    const step = () => {
      // repulsion
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]!;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]!;
          let dx = a.x! - b.x!;
          let dy = a.y! - b.y!;
          let d2 = dx * dx + dy * dy || 0.01;
          const f = 900 / d2;
          const d = Math.sqrt(d2);
          dx /= d;
          dy /= d;
          a.vx! += dx * f;
          a.vy! += dy * f;
          b.vx! -= dx * f;
          b.vy! -= dy * f;
        }
      }
      // spring along edges
      for (const e of data.edges) {
        const a = byId.get(e.a);
        const b = byId.get(e.b);
        if (!a || !b) continue;
        const dx = b.x! - a.x!;
        const dy = b.y! - a.y!;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - 70) * 0.012;
        a.vx! += (dx / d) * f;
        a.vy! += (dy / d) * f;
        b.vx! -= (dx / d) * f;
        b.vy! -= (dy / d) * f;
      }
      // centre pull + integrate
      for (const n of nodes) {
        n.vx! += (W() / 2 - n.x!) * 0.002;
        n.vy! += (H() / 2 - n.y!) * 0.002;
        n.vx! *= 0.86;
        n.vy! *= 0.86;
        n.x! += n.vx! * alpha;
        n.y! += n.vy! * alpha;
      }
      alpha *= 0.985;
    };

    const draw = () => {
      ctx.clearRect(0, 0, W(), H());
      const hov = hoverRef.current;
      const near = hov ? (adj.get(hov) ?? new Set()) : null;
      // edges — gentle curves, lit ones glow like a synapse firing
      for (const e of data.edges) {
        const a = byId.get(e.a);
        const b = byId.get(e.b);
        if (!a || !b) continue;
        const lit = hov && (e.a === hov || e.b === hov);
        ctx.strokeStyle = e.kind === 'contests' ? red : e.kind === 'relates' ? accent : lit ? accent : border;
        ctx.globalAlpha = hov ? (lit ? 1 : 0.08) : e.kind === 'relates' ? 0.45 : 0.32;
        ctx.lineWidth = lit ? 1.8 : e.kind === 'relates' ? 1.2 : 0.9;
        ctx.shadowBlur = lit ? 8 : 0;
        ctx.shadowColor = e.kind === 'contests' ? red : accent;
        if (e.kind === 'contests') ctx.setLineDash([3, 4]);
        // curve the edge slightly toward the midpoint's perpendicular
        const mx = (a.x! + b.x!) / 2;
        const my = (a.y! + b.y!) / 2;
        const dx = b.x! - a.x!;
        const dy = b.y! - a.y!;
        const len = Math.hypot(dx, dy) || 1;
        const bow = Math.min(18, len * 0.12);
        ctx.beginPath();
        ctx.moveTo(a.x!, a.y!);
        ctx.quadraticCurveTo(mx + (-dy / len) * bow, my + (dx / len) * bow, b.x!, b.y!);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;
      // nodes
      for (const n of nodes) {
        const dim = hov && n.id !== hov && !near?.has(n.id);
        ctx.globalAlpha = dim ? 0.25 : 1;
        const active = n.id === hov || near?.has(n.id);
        if (n.type === 'entity') {
          const r = 4 + (n.confidence ?? 0.5) * 5.5;
          const col = n.kind === 'decision' ? accent : ink;
          // the diamond, with a cheap shadow glow only when it matters
          ctx.globalAlpha = dim ? 0.3 : 1;
          ctx.shadowBlur = active ? 14 : (n.confidence ?? 0.5) > 0.7 ? 6 : 0;
          ctx.shadowColor = col;
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.moveTo(n.x!, n.y! - r);
          ctx.lineTo(n.x! + r, n.y!);
          ctx.lineTo(n.x!, n.y! + r);
          ctx.lineTo(n.x! - r, n.y!);
          ctx.closePath();
          ctx.fill();
          ctx.shadowBlur = 0;
        } else {
          ctx.globalAlpha = dim ? 0.2 : active ? 0.9 : 0.55;
          ctx.fillStyle = faint;
          ctx.beginPath();
          ctx.arc(n.x!, n.y!, active ? 3.6 : 2.8, 0, Math.PI * 2);
          ctx.fill();
        }
        if (n.id === hov || (!hov && n.type === 'entity')) {
          ctx.globalAlpha = dim ? 0.25 : 0.9;
          ctx.fillStyle = faint;
          ctx.font = '11px -apple-system, sans-serif';
          const t = n.label.length > 30 ? n.label.slice(0, 30) + '…' : n.label;
          if (n.type === 'entity' || n.id === hov) ctx.fillText(t, n.x! + 9, n.y! + 3);
        }
      }
      ctx.globalAlpha = 1;
    };

    // run the physics until it settles, then STOP — no frames burned while the
    // graph sits still. A hover or a redraw request wakes it (see wake()).
    let running = false;
    let lastHover: string | null = null;
    let settleGuard = 0;
    const frame = () => {
      if (hoverRef.current !== lastHover) {
        lastHover = hoverRef.current;
        settleGuard = 0;
      }
      const moving = alpha > 0.015;
      if (moving) {
        step();
        settleGuard = 0;
      } else {
        settleGuard++;
      }
      draw();
      if (settleGuard > 20) {
        running = false; // fully idle: stop the loop
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    const wake = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(frame);
    };
    wake();

    const pick = (mx: number, my: number): GNode | null => {
      let best: GNode | null = null;
      let bd = 14;
      for (const n of nodes) {
        const d = Math.hypot(n.x! - mx, n.y! - my);
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
      return best;
    };
    const onMove = (ev: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      const hit = pick(ev.clientX - r.left, ev.clientY - r.top);
      const changed = (hit?.id ?? null) !== hoverRef.current;
      hoverRef.current = hit?.id ?? null;
      canvas.style.cursor = hit ? 'pointer' : 'default';
      if (changed) wake();
    };
    const onClick = (ev: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      const hit = pick(ev.clientX - r.left, ev.clientY - r.top);
      if (hit?.type === 'entity') location.hash = `#/memory/${hit.id.slice(1)}`;
      if (hit?.type === 'session' && hit.sessionId)
        location.hash = `#/sessions/${encodeURIComponent(hit.sessionId)}`;
    };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('click', onClick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('click', onClick);
    };
  }, [data]);

  return (
    <div>
      <div class="page-head">
        <h1>Weave</h1>
      </div>
      {data && data.nodes.length === 0 ? (
        <div class="empty">
          The weave draws itself as memory forms. Enable distillation with <code>MOTIF_LLM_PROVIDER</code>, or
          try <code>motif demo</code>.
        </div>
      ) : (
        <>
          <div class="weave-legend">
            <span>
              <i class="wl-diamond" /> decision
            </span>
            <span>
              <i class="wl-diamond ink" /> file · topic
            </span>
            <span>
              <i class="wl-dot" /> session
            </span>
            <span>
              <i class="wl-line relate" /> related
            </span>
            <span>
              <i class="wl-line contest" /> contested
            </span>
          </div>
          <div class="weave-wrap">
            <canvas ref={canvasRef} class="weave-canvas" />
          </div>
        </>
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
  if (!entities) return <Skeleton rows={5} />;
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
                    {e.conflicts > 0 ? (
                      <span class="chip conflict">{e.conflicts} conflict</span>
                    ) : (
                      <ConfidenceBar value={e.confidence ?? 0.5} />
                    )}
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
        <div key={n.id} class={`note ${n.status} ${n.verification === 'retired' ? 'superseded' : ''}`}>
          <div class="aspect">
            {n.aspect} · {n.status}
            {n.verification && n.verification !== 'unverified' ? ` · ${n.verification}` : ''} ·{' '}
            {ago(n.created_at)}
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
    const reloadCount = debounce(loadCount);
    return openEvents((name) => {
      if (name === 'memory-updated' || name === 'memory-reviewed' || name === 'memory-conflict')
        reloadCount();
    });
  }, [authed]);

  if (!authed) return <TokenGate onDone={() => setAuthed(true)} />;

  const nav = [
    ['#/', 'Overview', /^\/$/],
    ['#/sessions', 'Sessions', /^\/sessions/],
    ['#/weave', 'Weave', /^\/weave/],
    ['#/memory', 'Memory', /^\/memory/],
    ['#/review', 'Review', /^\/review/],
    ['#/people', 'People', /^\/people/],
    ['#/search', 'Search', /^\/search/],
    ['#/setup', 'Setup', /^\/setup/],
  ] as const;

  let view = <OverviewPage me={me} />;
  let crumb = 'Overview';
  const sessionMatch = hash.match(/^\/sessions\/(.+)$/);
  const memoryMatch = hash.match(/^\/memory\/(\d+)$/);
  if (sessionMatch) {
    view = <SessionView id={decodeURIComponent(sessionMatch[1])} me={me} />;
    crumb = 'Sessions';
  } else if (hash.startsWith('/sessions')) {
    view = <SessionsPage me={me} />;
    crumb = 'Sessions';
  } else if (memoryMatch) {
    view = <MemoryEntityView id={memoryMatch[1]} />;
    crumb = 'Memory';
  } else if (hash.startsWith('/people')) {
    view = <PeoplePage me={me} />;
    crumb = 'People';
  } else if (hash.startsWith('/weave')) {
    view = <WeavePage />;
    crumb = 'Weave';
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
      <Toasts />
      <div class="shell">
        <div class="sidebar">
          {nav.map(([href, label, re]) => (
            <a key={href} class={`nav-item ${re.test(hash) ? 'active' : ''}`} href={href}>
              {NAV_ICONS[href]}
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
