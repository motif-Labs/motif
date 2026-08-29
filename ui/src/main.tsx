import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  api,
  clearToken,
  getToken,
  openEvents,
  setToken,
  type HandoffRequest,
  type Me,
  type MemberRow,
  type MemoryEntity,
  type MemoryNote,
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
  return `${Math.round(s / 86400)} days ago`;
}

function clock(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fullDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const projName = (p: string | null | undefined) => (p ?? '').split('/').filter(Boolean).pop() ?? '?';
const isActive = (iso: string | null | undefined) => !!iso && Date.now() - new Date(iso).getTime() < 5 * 60 * 1000;
const kb = (b?: number) => (b === undefined ? '—' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`);

const AVATAR_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];
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
    <span class="avatar" style={`width:${size}px;height:${size}px;background:${AVATAR_COLORS[h % AVATAR_COLORS.length]}`}>
      {initials}
    </span>
  );
}

const TOOLS: Record<string, { label: string; color: string }> = {
  'claude-code': { label: 'Claude Code', color: '#d97757' },
  codex: { label: 'Codex', color: '#1a7f64' },
  cursor: { label: 'Cursor', color: '#3b82f6' },
};
function ToolChip({ source }: { source: string }) {
  const t = TOOLS[source] ?? { label: source, color: '#9ca3af' };
  return (
    <span class="chip">
      <span class="dot" style={`background:${t.color}`} />
      {t.label}
    </span>
  );
}

/* ── sessions ────────────────────────────────────────── */

function TableHead() {
  return (
    <div class="thead">
      <span class="time">Time</span>
      <span class="title">Session</span>
      <span class="who">Owner</span>
      <span class="tool">Agent</span>
      <span class="vis">Scope</span>
      <span class="ago">Updated</span>
    </div>
  );
}

function SessionRowView({ s }: { s: SessionRow }) {
  return (
    <a class="row" href={`#/sessions/${encodeURIComponent(s.id)}`}>
      <span class="time">{clock(s.updatedAt)}</span>
      <span class="title">
        {isActive(s.updatedAt) && <span class="chip live" style="margin-right:8px">● live</span>}
        {s.title ?? '(untitled)'}
      </span>
      <span class="who">
        <Avatar name={s.memberName} />
        <span>@{s.memberName ?? 'unknown'}</span>
      </span>
      <span class="tool">
        <ToolChip source={s.source} />
      </span>
      <span class="vis">
        <span class="chip">Team</span>
      </span>
      <span class="ago">{ago(s.updatedAt)}</span>
    </a>
  );
}

function SessionsPage() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const reload = () => api<SessionRow[]>('/api/sessions?limit=100').then(setSessions).catch(() => {});
  useEffect(() => {
    reload();
    return openEvents((name) => {
      if (name === 'session-upserted') reload();
    });
  }, []);
  if (!sessions) return <div class="empty">Loading…</div>;
  return (
    <div>
      <h1>Sessions</h1>
      {sessions.length === 0 ? (
        <div class="empty">
          No sessions yet. On each dev machine run <code>motif connect</code>, then <code>motif daemon start</code>.
        </div>
      ) : (
        <div class="table">
          <TableHead />
          {sessions.map((s) => (
            <SessionRowView key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── session detail ──────────────────────────────────── */

function MessageView({ m }: { m: Message }) {
  if (m.role === 'reasoning') return null;
  if (m.role === 'tool_call' || m.role === 'tool_result') {
    const label = m.role === 'tool_call' ? `${m.toolName ?? 'tool'} call` : 'result';
    const body = m.role === 'tool_call' ? JSON.stringify(m.toolInput ?? {}, null, 2) : (m.text ?? '');
    if (!body || body === '{}') return null;
    return (
      <div class="msg tool">
        <details>
          <summary>{label}</summary>
          <pre>{body.length > 4000 ? `${body.slice(0, 4000)}…` : body}</pre>
        </details>
      </div>
    );
  }
  const text = (m.text ?? '').trim();
  if (!text) return null;
  return (
    <div class={`msg ${m.role}`}>
      <div class="head">{m.role === 'user' ? 'User' : 'Assistant'}</div>
      <div class="body">{text.length > 6000 ? `${text.slice(0, 6000)}…` : text}</div>
    </div>
  );
}

function HandoffPanel({ session, me }: { session: SessionDetail; me: Me }) {
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<{ threadId?: string; outputPath?: string; error?: string }>({});
  const [slow, setSlow] = useState(false);
  const reqId = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (state !== 'working') return;
    const slowTimer = setTimeout(() => setSlow(true), 15000);
    const stop = openEvents((name, data) => {
      const d = data as { requestId?: number; status?: string; targetSessionId?: string; outputPath?: string; error?: string };
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
      stop();
    };
  }, [state]);

  const request = async () => {
    setState('working');
    setSlow(false);
    try {
      const r = await api<HandoffRequest>('/api/handoff-requests', {
        method: 'POST',
        body: JSON.stringify({ sessionId: session.id }),
      });
      reqId.current = r.id;
    } catch (err) {
      setState('error');
      setResult({ error: String((err as Error).message) });
    }
  };

  if (me.kind !== 'member') {
    return (
      <div>
        <button disabled>Continue in Codex</button>
        <div class="hint">Handoff runs on your machine via your daemon. Sign in with your member token (see ~/.motif/config.json) to enable it.</div>
      </div>
    );
  }
  return (
    <div>
      <button class="primary" onClick={request} disabled={state === 'working'}>
        {state === 'working' ? 'Handing off…' : 'Continue in Codex'}
      </button>
      {state === 'working' && (
        <div class="hint status-wait">
          Waiting for your daemon to write the Codex session…
          {slow && (
            <>
              <br />
              Taking long — is the daemon running? <code>motif daemon start</code>
            </>
          )}
        </div>
      )}
      {state === 'done' && (
        <div class="hint status-ok">
          Ready on your machine. Continue with:
          <div
            class="cmd"
            title="Click to copy"
            onClick={() => navigator.clipboard?.writeText(`codex resume ${result.threadId}`)}
          >
            codex resume {result.threadId}
          </div>
        </div>
      )}
      {state === 'error' && <div class="hint status-err">{result.error}</div>}
    </div>
  );
}

function SessionView({ id, me }: { id: string; me: Me }) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState('');
  const reload = () =>
    api<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`).then(setSession).catch((e) => setError(String(e.message)));
  useEffect(() => {
    reload();
    return openEvents((name, data) => {
      if (name === 'session-upserted' && (data as { id?: string }).id === id) reload();
    });
  }, [id]);
  if (error) return <div class="empty">{error}</div>;
  if (!session) return <div class="empty">Loading…</div>;

  return (
    <div class="detail">
      <div class="transcript">
        <h1>{session.title ?? '(untitled)'}</h1>
        {session.messages.map((m) => (
          <MessageView key={m.id} m={m} />
        ))}
      </div>
      <div class="meta-panel">
        <div class="meta-card">
          <div class="meta-row"><span class="k">Agent</span><span class="v"><ToolChip source={session.source} /></span></div>
          <div class="meta-row"><span class="k">Model</span><span class="v">{session.meta?.model ?? 'Unknown model'}</span></div>
          <div class="meta-row"><span class="k">Project</span><span class="v mono">{session.projectPath || '—'}</span></div>
          <div class="meta-row">
            <span class="k">Owner</span>
            <span class="v" style="display:flex;align-items:center;gap:6px">
              <Avatar name={session.memberName} size={18} />@{session.memberName ?? 'unknown'}
            </span>
          </div>
          <div class="meta-row"><span class="k">Visibility</span><span class="v">Team</span></div>
          <div class="meta-row"><span class="k">Started</span><span class="v">{fullDate(session.createdAt)}</span></div>
          <div class="meta-row"><span class="k">Updated</span><span class="v">{fullDate(session.updatedAt)}</span></div>
          <div class="meta-row"><span class="k">Messages</span><span class="v">{session.messages.length}</span></div>
          <div class="meta-row"><span class="k">Size</span><span class="v">{kb(session.meta?.sourceBytes)}</span></div>
          {session.gitBranch && session.gitBranch !== 'HEAD' && (
            <div class="meta-row"><span class="k">Branch</span><span class="v mono">{session.gitBranch}</span></div>
          )}
          <div class="meta-sep" />
          <div class="meta-row" style="display:block">
            <div class="k" style="margin-bottom:4px">Session ID</div>
            <div class="session-id mono">{session.id}</div>
          </div>
          <div class="meta-sep" />
          <button onClick={() => navigator.clipboard?.writeText(location.href)}>Copy link</button>
          <div style="height:8px" />
          <HandoffPanel session={session} me={me} />
          {session.sourcePath && (
            <>
              <div class="meta-sep" />
              <div class="meta-row" style="display:block">
                <div class="k" style="margin-bottom:4px">Local path</div>
                <div class="session-id mono">{session.sourcePath}</div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── people ──────────────────────────────────────────── */

function PeoplePage() {
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  useEffect(() => {
    api<MemberRow[]>('/api/members').then(setMembers).catch(() => {});
  }, []);
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
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── memory ──────────────────────────────────────────── */

function MemoryPage() {
  const [entities, setEntities] = useState<MemoryEntity[] | null>(null);
  const reload = () => api<MemoryEntity[]>('/api/memory/entities').then(setEntities).catch(() => {});
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
          No memory yet. Enable it on the server with <code>MOTIF_LLM_PROVIDER</code> — notes appear as sessions go idle.
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
                  <span class="who"><span>{projName(e.project_path)}</span></span>
                  <span class="vis"><span class="chip">{e.current_notes} notes</span></span>
                  <span class="ago">{e.conflicts > 0 && <span class="chip conflict">{e.conflicts} conflict</span>}</span>
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
    api<{ entity: MemoryEntity; notes: MemoryNote[] }>(`/api/memory/entities/${id}`).then(setData).catch(() => {});
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
    if (q.trim()) api<SessionRow[]>(`/api/search?q=${encodeURIComponent(q)}`).then(setRows).catch(() => setRows([]));
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
        <button class="primary" onClick={run}>Search</button>
      </div>
      {rows && rows.length === 0 && <div class="empty">No matches.</div>}
      {rows && rows.length > 0 && (
        <div class="table">
          <TableHead />
          {rows.map((s) => (
            <SessionRowView key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── setup ───────────────────────────────────────────── */

function SetupPage({ me }: { me: Me }) {
  const origin = location.origin;
  return (
    <div style="max-width:680px">
      <h1>Setup</h1>
      <h2>Connect a teammate</h2>
      <div class="meta-card">
        <p style="color:var(--dim);margin-bottom:8px">On their machine, with the team token you share out-of-band:</p>
        <div class="cmd">npx motif connect {origin} --token &lt;team-token&gt; --name "Ada" --email ada@team.dev</div>
        <div class="cmd">motif daemon start</div>
        <div class="hint">The daemon streams their sessions here live and fulfils their dashboard handoffs.</div>
      </div>
      <h2>Your login</h2>
      <div class="meta-card">
        {me.kind === 'member' ? (
          <p style="color:var(--dim)">
            Signed in as <b>@{me.member?.name}</b> ({me.member?.role}) with your personal member token — actions like
            handoff are enabled.
          </p>
        ) : (
          <p style="color:var(--dim)">
            Signed in with the shared <b>team token</b> — read-only. To enable actions, sign out and log in with your
            personal member token from <code>~/.motif/config.json</code> on your machine.
          </p>
        )}
      </div>
      <h2>Privacy</h2>
      <div class="meta-card">
        <p style="color:var(--dim); line-height:1.6">
          Sessions stay on this server — nothing leaves your infrastructure. Doing personal work on the same machine?
          Switch that machine to allowlist mode so <b>only</b> company projects sync:
        </p>
        <div class="cmd">motif projects mode selected</div>
        <div class="cmd">motif projects include ~/work/company-repo</div>
        <p style="color:var(--dim); line-height:1.6; margin-top:8px">
          Or stay in default mode and block specific projects with <code>motif projects exclude &lt;path&gt; --purge</code>{' '}
          (purge also withdraws already-synced sessions). <code>redactPatterns</code> in <code>~/.motif/config.json</code>{' '}
          scrub secrets before upload. Put TLS in front with a reverse proxy for teams outside a trusted network.
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
        Sign in with your <b>member token</b> (from <code>~/.motif/config.json</code>, full access) or the shared{' '}
        <b>team token</b> (read-only).
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
    api<Me>('/api/me').then(setMe).catch(() => {});
    api<{ name: string }>('/api/team').then((t) => setTeam(t.name)).catch(() => {});
    const loadMembers = () => api<MemberRow[]>('/api/members').then(setMembers).catch(() => {});
    loadMembers();
    return openEvents((name) => {
      if (name === 'member-joined') loadMembers();
    });
  }, [authed]);

  if (!authed) return <TokenGate onDone={() => setAuthed(true)} />;

  const nav = [
    ['#/', 'Sessions', /^\/(sessions.*)?$/],
    ['#/people', 'People', /^\/people/],
    ['#/memory', 'Memory', /^\/memory/],
    ['#/search', 'Search', /^\/search/],
    ['#/setup', 'Setup', /^\/setup/],
  ] as const;

  let view = <SessionsPage />;
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
    view = <PeoplePage />;
    crumb = 'People';
  } else if (hash.startsWith('/memory')) {
    view = <MemoryPage />;
    crumb = 'Memory';
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

render(<App />, document.getElementById('app')!);
