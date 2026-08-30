<h1 align="center">Motif</h1>

<p align="center"><b>Your coding agents stop starting from zero.</b></p>

<p align="center">
  Motif collects every Claude Code, Codex and Cursor session your team runs onto a server you own —<br />
  then lets any agent recall what was already decided, move a session between tools natively,<br />
  or put a question to a session from three weeks ago.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/getmotif"><img src="https://img.shields.io/npm/v/getmotif?color=2b7fff&label=npm" alt="npm version" /></a>
  <a href="https://github.com/motif-Labs/motif/actions/workflows/ci.yml"><img src="https://github.com/motif-Labs/motif/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-green" alt="Node 20+" />
  <img src="https://img.shields.io/badge/self--hosted-no%20cloud-lightgrey" alt="Self-hosted" />
</p>

---

Every agent session starts cold. It re-reads the codebase, re-derives the
constraints, and re-litigates a decision someone on your team settled weeks ago
in a different tool. The reasoning exists — it is sitting in a JSONL file on
somebody's laptop, and nothing collects it.

Motif does:

```console
$ motif recall "why do we fail open when the token service times out"

# Team context for "why do we fail open when the token service times out"

## From past sessions

**Auth middleware fails open when the token service times out — make it fail closed.**
— @ben, 12 days ago · `claude-code:88b19192`
> Flipped it to fail closed, with one carve-out: the internal health route keeps
> working so the load balancer does not pull every node when the token service blips.

**The public API has no rate limiting, and it has to survive a restart.**
— @ada, 3 weeks ago · `codex:99bfccc0`
> Fail open, and log loudly. Rejecting live payment traffic because a cache is
> unreachable is worse than briefly serving unlimited requests. ADR-014.

---
230 tokens from 5 sessions. Cite session ids when you use this.
```

Two teammates, two different tools, one answer with the reasoning still attached.

**Your agent gets the same bundle over MCP, without being asked.** That is the
point of the product: you are not meant to open a dashboard.

## Install

```bash
npm i -g getmotif        # the binary is `motif`
motif up                 # server + live sync on 127.0.0.1:4680
motif mcp install        # register with Claude Code, Codex and Cursor
```

That is the whole solo setup. Your existing sessions import on first run, and
your agents can query them immediately. No account, no cloud, no API key.

Works for one person on one machine — the benchmark further down was measured on
a single developer's history. A team server is optional, and covered below.

## What it does

### One memory, across every tool and teammate

A small daemon watches Claude Code, Codex and Cursor on each machine and streams
sessions to your server as they happen. Nothing leaves your infrastructure and
there is no telemetry.

<p align="center">
  <img src="https://raw.githubusercontent.com/motif-Labs/motif/main/docs/assets/dashboard.png" alt="The dashboard: every member's sessions across Claude Code, Codex and Cursor on one timeline" width="880" />
</p>

### Native handoff, in both directions

Start in Claude Code, finish in Codex. Motif writes a real Codex rollout file and
registers the thread in Codex's own state database, so `codex resume` lists it
and appends to it as its own history — not a summary someone pasted in.

<p align="center">
  <img src="https://raw.githubusercontent.com/motif-Labs/motif/main/docs/assets/handoff.gif" alt="Handing a Claude Code session to Codex, natively" width="820" />
</p>

```bash
motif handoff <id> --open              # continue it here, in the other tool
motif handoff <id> --to-member "Ada"   # hand it to a teammate — lands in THEIR tool
```

Verified against Codex 0.150.1. Cursor sessions convert into either target.

### Ask a session

A transcript answers what happened. Sometimes you need to ask what _would_
happen. `ask` resumes a past session read-only **on the machine that owns it**,
and the agent that lived it answers with the full context it had.

```bash
motif ask 4f2a9c "what did we rule out here, and why?"
```

<p align="center">
  <img src="https://raw.githubusercontent.com/motif-Labs/motif/main/docs/assets/session.png" alt="A session: the transcript, what it touched, and the controls to continue it elsewhere or ask it a question" width="880" />
</p>

## Your agents query it themselves

One command registers Motif as an MCP server with Claude Code, Codex and Cursor:

```bash
motif mcp install
```

| tool                                | what it does                                                                |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `recall`                            | the distilled answer — decisions, human notes, cited excerpts, ~1.5k tokens |
| `search_sessions` · `list_sessions` | find the session                                                            |
| `get_session`                       | read a transcript                                                           |
| `ask_session`                       | **put a question to a past session** — the agent that lived it answers      |

`ask_session` is the unusual one: your Claude Code agent can question a Codex
session from three weeks ago, and the machine that owns that session answers.

## Measured, not asserted

Retrieval is benchmarked rather than claimed. Against a ~2M-token corpus of real
sessions, `motif recall` returns the answer for **8 of 9 questions** inside a
1,500-token budget — roughly three orders of magnitude smaller than the history
it draws from.

```bash
npm run bench    # reproduce it on your own corpus
```

**No embeddings, no vector store, no API key.** Ranking comes from full-text
search over the graph the sessions already form — handoff lineage, shared memory
entities, overlapping files — plus the notes people pinned. Every item in a
bundle says why it was picked, and the whole thing runs on your machine.

The one miss is cross-language: a question asked in one language about a decision
discussed in another. Lexical search is language-bound; distilled memory covers
that gap.

## Privacy and security

**Two credentials, two levels.** A _team token_ is shared once and grants read
access plus the right to register. A _member token_ is minted per person and
device by `motif connect`; only its hash reaches the server. Every write is
attributed to the token's owner — a claimed name or header changes nothing, so
members cannot write as each other.

**Joining a team shares nothing by default.** A freshly connected machine uploads
everything as `personal`, visible only to you, until you mark projects
team-visible:

```bash
motif projects team ~/work/payments-api    # this one goes to the team
motif projects exclude ~/personal --purge  # this one never does, and withdraw what did
```

**Filtering runs before upload.** Exclude globs keep whole trees local, and
`redactPatterns` scrub secrets out of message text _and_ tool inputs on the
source machine. Handoffs and asks only ever execute on the machine that owns the
session, through its own daemon. Full model in [SECURITY.md](SECURITY.md).

## Running it for a team

One server per team, one daemon per machine.

```bash
# on the server
docker compose up -d                       # or: MOTIF_TOKEN=<token> npx getmotif server

# on each developer's machine, once
npx getmotif connect https://motif.internal.yourco.dev \
  --token <team-token> --name "Ada" --email ada@yourco.dev
motif daemon install                       # start at every login
```

Everything lives in one SQLite file, so backup is `cp`. Measured on a real
workload of 130 sessions: **≈57 MB resident** for server and daemon combined,
**≈14 MB** database, idle CPU effectively zero. `GET /api/health` for monitoring,
`motif prune --older-than 90` to keep it lean — raw sessions go, distilled notes
stay.

Put TLS in front with any reverse proxy for teams outside a trusted network.

## Everyday commands

```bash
motif list                          # sessions across the team, newest first
motif search "idempotency"          # full-text search over everyone's sessions
motif show <id>                     # read a session as a transcript
motif recall "how does auth work"   # what the team already knows
motif ask <id> "why this way?"      # the session answers, with its context
motif handoff <id> --open           # continue it in another tool, natively
motif status · motif doctor         # health at a glance · diagnose with fixes
```

Every command has `--help`, and `motif --help` lists them all.

## Try it without touching your own history

```bash
git clone https://github.com/motif-Labs/motif && cd motif
npm install && npm run build
bash scripts/demo.sh        # two members, invented sessions, a live dashboard
```

The demo pins every reader at its own scratch directories, so it never opens
`~/.claude`, `~/.codex` or your Cursor storage. `bash scripts/demo.sh clean`
removes it.

## Independence and compatibility

Motif is an independent project, not affiliated with or endorsed by Anthropic,
OpenAI or Anysphere. It reads and writes files those tools keep on **your own
machine**, in formats that are private and undocumented, worked out from real
files and from the tools' own open-source code where it exists. Nothing is
scraped and no service is called on your behalf.

Two things follow, and you should know both before relying on it:

- **Formats can change without notice.** Every reader parses tolerantly and never
  fails a whole sync on an unknown shape, and conformance fixtures pin what we
  understood at the time — but an upstream release can still break a handoff. A
  failing fixture plus a corrected parse is the most useful pull request you can
  send.
- **`ask` runs under the session owner's own account.** When a teammate questions
  your session, _your_ daemon resumes it with _your_ CLI and _your_ subscription,
  and only ever for sessions you own. It is off unless you run the daemon, and
  `motif daemon pause` stops it.

## Contributing

New session readers are the most welcome contribution — Motif is only as useful
as the tools it can collect from. [CONTRIBUTING.md](CONTRIBUTING.md) has the
setup, the DCO sign-off and what a good pull request looks like here;
[CLAUDE.md](CLAUDE.md) has the invariants worth knowing before touching sync,
handoff or scope. Changes are in [CHANGELOG.md](CHANGELOG.md).

## License

Apache-2.0 — see [LICENSE](LICENSE).

Everything in this repository is Apache-2.0: no license key, no feature flags,
and no limits on members, sessions or projects. Everything that is free today
stays free.
