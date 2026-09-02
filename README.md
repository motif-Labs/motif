<h1 align="center">Motif</h1>

<p align="center"><b>Working memory for AI coding agents, yours, and your team's.</b></p>

<p align="center">
  Your AI sessions know things your repo doesn't: what was decided, what was tried, what broke.<br />
  Motif remembers it, keeps that memory honest, and puts it to work, from recall to pull requests.<br />
  Solo from the first minute; a team the moment you invite one. On infrastructure you own.
</p>

<p align="center">
  <a href="https://www.getmotif.dev">Website</a> ·
  <a href="https://www.getmotif.dev/docs.html">Docs</a> ·
  <a href="https://www.getmotif.dev/faq.html">FAQ</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="https://www.getmotif.dev/roadmap.html">Roadmap</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/getmotif"><img src="https://img.shields.io/npm/v/getmotif?color=2b7fff&label=npm" alt="npm version" /></a>
  <a href="https://github.com/motif-Labs/motif/actions/workflows/ci.yml"><img src="https://github.com/motif-Labs/motif/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-green" alt="Node 22+" />
  <img src="https://img.shields.io/badge/self--hosted-no%20cloud-lightgrey" alt="Self-hosted" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/motif-Labs/motif/main/docs/assets/handoff.gif" alt="Handing a live Claude Code session to a teammate, who picks it up in Codex" width="820" />
</p>

<p align="center"><sub>One command hands a live Claude Code session to a teammate. Her daemon materialises it as a Codex<br />thread on her own machine, and <code>codex resume</code> opens it as history, not as a paste.</sub></p>

---

Claude Code, Codex and Cursor each keep their sessions in their own format, on
whichever laptop happened to run them. The work one developer's agent does is
invisible to everyone else's, and to that developer's own agent next week, in a
different tool. Every session starts cold and re-derives a decision somebody
already made.

Motif collects all of it onto a server you host, and hands it back when it is
needed.

## Install

```bash
npm i -g getmotif        # the binary is `motif`
motif up                 # server + live sync on 127.0.0.1:4680
motif mcp install        # register with Claude Code, Codex and Cursor
```

That is the whole setup. Your existing sessions import on first run and your
agents can query them immediately, no account, no cloud, no API key, and nothing
leaves the machine. Prefer not to install anything? `npx getmotif up` does the
same thing. Node 22 or newer.

Want to see it populated before pointing it at anything real?

```bash
npx getmotif demo        # a team's week replays live, in five acts, you rule, the Weaver acts
```

Sessions stream in, memory catches two of them contradicting each other, you
pick the winner from the terminal, and the Weaver aligns a real (throwaway) git
repository with your ruling, the diff on screen. No reader runs; your own
history is never opened.

## How it works

Motif works in three movements, **remember**, **verify**, **act**, and every
verb under them is a command you can run today.

### Remember

### 01 · Collect, one memory for the whole team

A small daemon watches Claude Code, Codex and Cursor on every machine and streams
sessions to your server as they happen, attributed to the person and the tool
that produced them. Nothing leaves your infrastructure, and there is no telemetry.

<p align="center">
  <img src="https://raw.githubusercontent.com/motif-Labs/motif/main/docs/assets/dashboard.png" alt="The dashboard: every member's sessions across Claude Code and Codex, on one timeline" width="880" />
</p>

Joining a team shares nothing by default, everything uploads as `personal` until
you say otherwise:

```bash
motif projects team ~/work/payments-api      # this project goes to the team
motif projects exclude ~/personal --purge    # this one never does
```

### 02 · Ask, the agent that lived it answers

A collected archive is still an archive. Asking is what makes it a participant.
`ask` resumes a past session **read-only on the machine that owns it**, so the
answer comes from the agent that had the full context, not from a summary.

```bash
motif ask 4f2a9c "what did we rule out here, and why?"
```

It works on your own sessions and, with a teammate's daemon running, on theirs.
Claude Code and Codex sessions can be asked; Cursor has no resume command, so
Cursor sessions are collected and searchable but not askable.

### 03 · Recall, and your agents query it themselves

```console
$ motif recall "why do we fail open when the token service times out"

# Team context for "why do we fail open when the token service times out"

## From past sessions

**Auth middleware fails open when the token service times out, make it fail closed.**
@ben, 12 days ago · `claude-code:88b19192`
> Flipped it to fail closed, with one carve-out: the internal health route keeps
> working so the load balancer does not pull every node when the token service blips.

**The public API has no rate limiting, and it has to survive a restart.**
@ada, 3 weeks ago · `codex:99bfccc0`
> Fail open, and log loudly. Rejecting live payment traffic because a cache is
> unreachable is worse than briefly serving unlimited requests. ADR-014.

---
230 tokens from 5 sessions. Cite session ids when you use this.
```

Two teammates, two different tools, one answer with the reasoning still attached.
**Your agents get the same bundle over MCP, without being asked**, you are not
meant to open a dashboard. One command registers Motif with all three:

```bash
motif mcp install
```

| tool                                | what it does                                                               |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `recall`                            | the distilled answer, decisions, human notes, cited excerpts, ~1.5k tokens |
| `search_sessions` · `list_sessions` | find the session                                                           |
| `get_session`                       | read a transcript                                                          |
| `ask_session`                       | **put a question to a past session**, the agent that lived it answers      |

`ask_session` is the unusual one: your Claude Code agent can question a Codex
session from three weeks ago, and the machine that owns it answers.

And in the other direction, from the code back to the conversation:

```bash
motif blame src/limiter.ts     # which sessions produced this file, freshest first
```

"Why is this like this" starts from the file itself: each hit names the person,
the tool, the session, and `motif show` opens the conversation.

**Measured, not asserted.** Against **1.77M tokens** of real session history,
`recall` answers **8 of 9** questions inside a 1,500-token budget, a median
bundle of 1,496 tokens, **1,186× smaller** than the history it searched.
Reproduce it on your own corpus with `npm run bench`.

Every claim carries one **confidence** number, corroboration and a human's vouch
raise it; conflict, staleness and age lower it, and recall ranks and labels by
it, so an agent knows how much to trust each line.

No embeddings, no vector store, no API key. Ranking comes from full-text search
over the graph the sessions already form, handoff lineage, shared files, shared
entities, plus the notes people pinned. Every item says why it was picked.

### See it, the record as a graph

Everything the sessions form, decisions, files, topics, and the sessions that
produced them, is a graph, not a list. The **Weave** view draws it: entities
are diamonds, sessions are dots, and edges are the real relationships (a session
that informs an entity, a note that contests another, a handoff lineage). It is
the same graph recall walks to answer in ~1.5k tokens instead of the whole
history, now visible. Two entities a single session both touched are drawn as
**related**, so decisions and the files and topics they shaped form one causal
weave, and each entity is sized by its confidence.

### Verify

### 04 · Decide, every decision, with the reason still attached

As sessions go idle the server distils them into entity notes: the decisions, the
files they touched, the topics they belong to, each carrying the reasoning it came
from. New knowledge **supersedes** old rather than overwriting it, and
contradictions are **flagged** instead of quietly piling up.

```bash
MOTIF_LLM_PROVIDER=claude-code motif server      # uses your local CLI, no key
# or: anthropic · openai · openai-compatible (Ollama, vLLM, OpenRouter)
```

This is the one part that calls a model, and it is off unless you configure a
provider.

### 05 · Verify, memory that earns its trust

Distilled memory is a machine's claim about what your team decided. Claims age,
and sessions contradict each other. Motif refuses to paper over either: a
contradiction is **flagged**, a note whose source files were reworked without it
is marked **possibly stale**, and both wait for a person in the Review inbox,
in the dashboard, or:

```bash
motif memory review                    # conflicts, both sides cited; stale notes
motif memory prefer 47 --over 12       # rule: this claim wins, that one is superseded
motif memory confirm 31                # vouch for a claim, verified beats machine-only
motif memory retire 8                  # out of service, never out of the record
```

Rulings never delete, and the ruling itself is recorded, who ruled, over what,
and why. Recall serves the outcome: retired notes disappear, human-verified
ones outrank machine-only ones, and an unresolved conflict is shown to agents
with both sides and a warning, never as one quiet wrong answer.

### Act

### 06 · Weave the record back into the repo

A ruling fixes the memory; the repository can still say what the losing claim
said. And the record can see changes the repo never tested, a fix or a feature
that shipped with no test. The **Weaver** closes both, on projects you opt in:

```bash
motif weaver enable ~/work/payments-api    # let the Weaver act here (draft PRs only)
motif weaver scan                          # untested fixes and features it could close
motif weaver run src/limiter.ts            # write the missing test → draft PR
```

When a ruling lands, or you queue a gap, a daemon holding the project claims the
job, works in a **throwaway worktree**, and opens a **draft PR** on a `motif/`
branch, the ruling or the session that made the change cited in the body. The
rails do not bend: your checkout is never touched, a default branch cannot be
pushed, an agreeing repo produces no PR, and a job born from personal evidence
is never queued. The agent is handed the record's own context, the session that
made the change, so it writes the change instead of searching for it: pointed at
a receipt a human picked, never wandering, and cheap because it reads the graph
rather than the whole tree.

The loop closes: `motif weaver resolve <id> merged|closed` records a PR's fate,
and a fix born from a ruling that gets **closed** returns that ruling to review,
the record learning from what its own hands produced.

### 07 · Move, any agent, any teammate

None of this asks anyone to change tools. A session started in one agent continues
natively in another: Motif writes the target tool's own session file and registers
the thread in its state database, so the tool opens it as its own history.

```bash
motif handoff 4f2a9c --open                # continue it here, in the other tool
motif handoff 4f2a9c --to-member "Ada"     # hand it over, lands in THEIR tool
```

<p align="center">
  <img src="https://raw.githubusercontent.com/motif-Labs/motif/main/docs/assets/codex-takeover.png" alt="The Claude Code conversation, resumed inside Codex on another machine, answering a teammate's question about it" width="880" />
</p>

<p align="center"><sub>The same conversation inside Codex on the other machine, including the question asked<br />a minute earlier in Claude Code. Codex answers about work it never did.</sub></p>

Claude Code ⇄ Codex in both directions, verified against Codex 0.151.0. Cursor
sessions convert into either. The tool is a preference; the memory is shared.

## You do not need a team

None of this needs one to be worth running. `motif up` on a single machine makes
your own history queryable: the decision you made three weeks ago, in a tool you
have since stopped using, answered from the session where you made it, and
`handoff` moves that session into whichever agent you use now.

The benchmark above was measured on one developer's corpus.

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

**Step by step, including the details that bite: [docs/TEAM-SETUP.md](docs/TEAM-SETUP.md).**

Everything lives in one SQLite file, that file _is_ your team. Start the server
against the same path and the team token, every member and all history survive a
restart; start it against a different one and you have a new, empty team. Backup
is `cp`. Put TLS in front with any reverse proxy for teams outside a trusted
network.

## Privacy and security

**Two credentials, two levels.** A _team token_ is shared once and grants read
access plus the right to register. A _member token_ is minted per person and
device by `motif connect`; only its hash reaches the server. Every write is
attributed to the token's owner, a claimed name or header changes nothing, so
members cannot write as each other.

**Filtering runs before upload.** Exclude globs keep whole trees local, and ten
redaction patterns, API keys, AWS ids, GitHub tokens, JWTs, private key blocks,
scrub secrets out of message text _and_ tool inputs on the source machine.
Handoffs and asks only ever execute on the machine that owns the session, through
its own daemon. Full model in [SECURITY.md](SECURITY.md).

## The numbers

|           |                                                                                         |
| --------- | --------------------------------------------------------------------------------------- |
| Runtime   | one process, one SQLite file, default port `4680`                                       |
| Footprint | ≈57 MB resident for server and daemon combined, ≈14 MB database at 130 sessions         |
| Network   | no telemetry, no account, no API key, nothing leaves the machine until you connect      |
| Redaction | on by default, 10 patterns, applied before upload                                       |
| Retrieval | deterministic, FTS5 + the session graph + pinned notes, no embeddings                   |
| Tests     | 74, CI on Linux, macOS and Windows across Node 22 and 24                                |
| Package   | [`getmotif`](https://www.npmjs.com/package/getmotif), published from CI with provenance |
| Licence   | Apache-2.0 in full, no license key, no feature flags, no member limits                  |

## Command reference

<details>
<summary><b>Every command, grouped</b>, or run <code>motif --help</code></summary>

<br />

**Finding things**

| command                                      | what it does                                         |
| -------------------------------------------- | ---------------------------------------------------- |
| `motif list`                                 | sessions across the team, newest first               |
| `motif list --project ~/work/api --limit 50` | narrow it                                            |
| `motif search "idempotency"`                 | full-text search over everyone's sessions            |
| `motif show <id>`                            | read a session as a transcript (`--tools`, `--json`) |
| `motif recall "how does auth work"`          | the distilled answer, with citations                 |
| `motif blame src/limiter.ts`                 | the sessions that produced a file, freshest first    |

**Working with a session**

| command                                       | what it does                              |
| --------------------------------------------- | ----------------------------------------- |
| `motif ask <id> "why this way?"`              | the session answers, with its own context |
| `motif asks <id>`                             | questions asked of it, and the answers    |
| `motif handoff <id> --open`                   | continue it in another tool, natively     |
| `motif handoff <id> --to-member "Ada"`        | hand it to a teammate                     |
| `motif handoff <id> --dry-run`                | show what would be written, write nothing |
| `motif comment <id> "@Ben this broke Friday"` | pin a note, notify a person               |

**Scope and privacy**

| command                                 | what it does                                 |
| --------------------------------------- | -------------------------------------------- |
| `motif projects list`                   | what syncs, and as what                      |
| `motif projects team <path>`            | make a project team-visible                  |
| `motif projects personal <path>`        | keep it to yourself                          |
| `motif projects exclude <path> --purge` | never sync it, and withdraw what did         |
| `motif projects mode selected`          | allowlist mode: nothing syncs until included |

**Ruling on memory**

| command                                | what it does                                      |
| -------------------------------------- | ------------------------------------------------- |
| `motif memory review`                  | everything waiting for a human, evidence cited    |
| `motif memory prefer <id> --over <id>` | resolve a conflict; the loser is kept, superseded |
| `motif memory confirm <id>`            | vouch for a claim, it outranks machine-only ones  |
| `motif memory retire <id>`             | out of recall, still in the record                |
| `motif demo`                           | an invented team to try all of this on            |

**Running it**

| command                                        | what it does                                |
| ---------------------------------------------- | ------------------------------------------- |
| `motif up`                                     | server + sync on this machine               |
| `motif server --port 4680 --host 0.0.0.0`      | the team server                             |
| `motif connect <url> --token <t> --name "Ada"` | join a team from this machine               |
| `motif daemon start` · `install` · `pause`     | sync in the background, at login            |
| `motif status` · `motif doctor`                | health at a glance · diagnose with fixes    |
| `motif prune --older-than 90`                  | drop old raw sessions, keep distilled notes |
| `motif mcp install` · `motif skills`           | teach your agents to use it                 |

</details>

## Independence and compatibility

Motif is an independent project, not affiliated with or endorsed by Anthropic,
OpenAI or Anysphere. It reads and writes files those tools keep on **your own
machine**, in formats that are private and undocumented, worked out from real
files and from the tools' own open-source code where it exists. Nothing is
scraped and no service is called on your behalf.

Two things follow, and you should know both before relying on it:

- **Formats can change without notice.** Every reader parses tolerantly and never
  fails a whole sync on an unknown shape, and conformance fixtures pin what we
  understood at the time, but an upstream release can still break a handoff. A
  failing fixture plus a corrected parse is the most useful pull request you can
  send.
- **`ask` runs under the session owner's own account.** When a teammate questions
  your session, _your_ daemon resumes it with _your_ CLI and _your_ subscription,
  and only ever for sessions you own. It is off unless you run the daemon, and
  `motif daemon pause` stops it.

## Contributing

New session readers are the most welcome contribution, Motif is only as useful
as the tools it can collect from. [CONTRIBUTING.md](CONTRIBUTING.md) has the
setup, the DCO sign-off and what a good pull request looks like here;
[CLAUDE.md](CLAUDE.md) has the invariants worth knowing before touching sync,
handoff or scope.

## License

Apache-2.0, see [LICENSE](LICENSE).

Everything in this repository is Apache-2.0: no license key, no feature flags, and
no limits on members, sessions or projects. Everything that is free today stays
free.
