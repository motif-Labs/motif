import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  api,
  clearToken,
  getToken,
  openEvents,
  setToken,
  type MemoryEntity,
  type MemoryNote,
  type Message,
  type SessionDetail,
  type SessionRow,
} from './api.js';

function useHash(): string {
  const [hash, setHash] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const onChange = () => setHash(location.hash.slice(1) || '/');
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

function ago(iso: string | null): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const projName = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const isActive = (iso: string | null) => !!iso && Date.now() - new Date(iso).getTime() < 5 * 60 * 1000;

function SessionCard({ s }: { s: SessionRow }) {
  return (
    <a class="card" href={`#/sessions/${encodeURIComponent(s.id)}`} style="display:block;text-decoration:none;color:inherit">
      <div class="title">{s.title ?? '(untitled)'}</div>
      <div class="meta">
        {isActive(s.updatedAt) && <span class="badge live">● active</span>}
        {s.memberName && <span class="badge member">{s.memberName}</span>}
        <span>{projName(s.projectPath)}</span>
        {s.gitBranch && s.gitBranch !== 'HEAD' && <span>⎇ {s.gitBranch}</span>}
        <span>{s.messageCount} messages</span>
        <span>{ago(s.updatedAt)}</span>
      </div>
      {s.snippet && <div class="meta">…{s.snippet}…</div>}
    </a>
  );
}

function Feed() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const reload = () => api<SessionRow[]>('/api/sessions?limit=50').then(setSessions).catch(() => {});
  useEffect(() => {
    reload();
    return openEvents((name) => {
      if (name === 'session-upserted' || name === 'handoff-created') reload();
    });
  }, []);
  if (!sessions) return <div class="empty">Loading…</div>;
  return (
    <div>
      <h1>Team feed</h1>
      {sessions.length === 0 && (
        <div class="empty">
          No sessions yet. On each dev machine: <code>motif connect</code> then <code>motif daemon start</code>.
        </div>
      )}
      {sessions.map((s) => (
        <SessionCard key={s.id} s={s} />
      ))}
    </div>
  );
}

function MessageView({ m }: { m: Message }) {
  if (m.role === 'reasoning') return null;
  if (m.role === 'tool_call' || m.role === 'tool_result') {
    const label =
      m.role === 'tool_call' ? `→ ${m.toolName ?? 'tool'}` : '← result';
    const body = m.role === 'tool_call' ? JSON.stringify(m.toolInput ?? {}, null, 2) : (m.text ?? '');
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
      <div class="role">{m.role}</div>
      <div class="bubble">{text.length > 6000 ? `${text.slice(0, 6000)}…` : text}</div>
    </div>
  );
}

function SessionView({ id }: { id: string }) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState('');
  const reload = () =>
    api<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`).then(setSession).catch((e) => setError(String(e)));
  useEffect(() => {
    reload();
    return openEvents((name, data) => {
      if (name === 'session-upserted' && (data as { id?: string }).id === id) reload();
    });
  }, [id]);
  if (error) return <div class="empty">{error}</div>;
  if (!session) return <div class="empty">Loading…</div>;
  return (
    <div>
      <h1>{session.title ?? '(untitled)'}</h1>
      <div class="meta" style="color:var(--text-dim);margin-bottom:16px;display:flex;gap:14px;flex-wrap:wrap">
        {isActive(session.updatedAt) && <span class="badge live">● active</span>}
        {session.memberName && <span class="badge member">{session.memberName}</span>}
        <span>{session.projectPath}</span>
        <span>{session.messages.length} messages</span>
        <span>updated {ago(session.updatedAt)}</span>
      </div>
      {session.filesTouched.length > 0 && (
        <div style="color:var(--text-dim);font-size:12px;margin-bottom:16px">
          files: {session.filesTouched.join(', ')}
        </div>
      )}
      {session.messages.map((m) => (
        <MessageView key={m.id} m={m} />
      ))}
    </div>
  );
}

function Memory() {
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
      <h1>Engineering memory</h1>
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
            {of.map((e) => (
              <a key={e.id} class="card" href={`#/memory/${e.id}`} style="display:block;text-decoration:none;color:inherit">
                <div class="title">{e.name}</div>
                <div class="meta">
                  <span>{projName(e.project_path)}</span>
                  <span>{e.current_notes} current</span>
                  {e.conflicts > 0 && <span class="badge conflict">{e.conflicts} conflict</span>}
                </div>
              </a>
            ))}
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
  const { entity, notes } = data;
  return (
    <div>
      <h1>
        <span style="color:var(--text-dim)">[{entity.kind}]</span> {entity.name}
      </h1>
      {notes.map((n) => (
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

function Search() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const run = () => {
    if (q.trim()) api<SessionRow[]>(`/api/search?q=${encodeURIComponent(q)}`).then(setRows).catch(() => setRows([]));
  };
  return (
    <div>
      <h1>Search</h1>
      <div class="row">
        <input
          type="text"
          placeholder="Search across every session and teammate…"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <button onClick={run}>Search</button>
      </div>
      {rows && rows.length === 0 && <div class="empty">No matches.</div>}
      {rows?.map((s) => <SessionCard key={s.id} s={s} />)}
    </div>
  );
}

function TokenGate({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    setToken(value.trim());
    try {
      await api('/api/sessions?limit=1');
      onDone();
    } catch {
      clearToken();
      setError('That token was rejected by the server.');
    }
  };
  return (
    <div class="center">
      <div class="logo" style="padding:0">
        mo<span>tif</span>
      </div>
      <div style="color:var(--text-dim)">Enter your team token — it's printed when the server starts.</div>
      <input
        type="password"
        placeholder="team token"
        value={value}
        onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {error && <div style="color:var(--red)">{error}</div>}
      <button onClick={submit}>Connect</button>
    </div>
  );
}

function App() {
  const hash = useHash();
  const [authed, setAuthed] = useState(!!getToken());
  if (!authed) return <TokenGate onDone={() => setAuthed(true)} />;

  const nav = [
    ['#/', 'Feed', /^\/$/],
    ['#/memory', 'Memory', /^\/memory/],
    ['#/search', 'Search', /^\/search/],
  ] as const;

  let view = <Feed />;
  const sessionMatch = hash.match(/^\/sessions\/(.+)$/);
  const memoryMatch = hash.match(/^\/memory\/(\d+)$/);
  if (sessionMatch) view = <SessionView id={decodeURIComponent(sessionMatch[1])} />;
  else if (memoryMatch) view = <MemoryEntityView id={memoryMatch[1]} />;
  else if (hash.startsWith('/memory')) view = <Memory />;
  else if (hash.startsWith('/search')) view = <Search />;

  return (
    <>
      <div class="sidebar">
        <div class="logo">
          mo<span>tif</span>
        </div>
        {nav.map(([href, label, re]) => (
          <a key={href} class={`nav-item ${re.test(hash) ? 'active' : ''}`} href={href}>
            {label}
          </a>
        ))}
        <div class="foot">
          <a
            class="nav-item"
            style="padding:0"
            onClick={() => {
              clearToken();
              location.reload();
            }}
          >
            Sign out
          </a>
        </div>
      </div>
      <div class="main">{view}</div>
    </>
  );
}

render(<App />, document.getElementById('app')!);
