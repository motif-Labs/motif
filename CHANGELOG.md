# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.3] - 2026-09-02

### Added

- **Drag a node in the Weave.** Grab any knot and the graph follows: its ties
  stretch with it and the rest of the weave resettles when you let go.

## [1.3.2] - 2026-09-02

### Changed

- **The Weave reads more clearly.** The same concept seen in two projects is
  now one knot, not two, so cross-project ties pull together instead of
  doubling. Decisions carry a label at rest; files, topics and sessions reveal
  theirs on hover, each on a soft pill so a dense weave stays legible.

### Added

- **A hover card on the Weave.** Point at any node for its kind, confidence and
  how many ties it holds, without leaving the graph.

## [1.3.1] - 2026-09-02

## [1.3.0], 2026-09-02

## [1.2.0], 2026-09-02

### Added

- **The Weave**, the record drawn as a graph instead of a list. Entities and
  sessions are nodes; edges are the relationships already in the tables (a
  session that informs an entity, a note that contests another, a handoff
  lineage). A dependency-free force layout with the same visibility rules as
  recall; hover lights a neighbourhood, click opens a node.
- **The Weaver scans for untested changes.** Beyond acting on a ruling, it now
  finds fixes and features the record kept but the repo never tested,
  `motif weaver scan` lists them, `motif weaver run <file>` queues one. Queueing
  is always a person's choice; the agent is handed the session's own context and
  writes the focused test as a draft PR, never wandering the tree.
- **The Review loop.** Distilled memory notes now carry a human axis next to the
  machine one: a person can `confirm`, `prefer` (resolving a conflict),
  `retire` or `dispute` a claim, from `motif memory review` or the dashboard's
  new Review inbox, which counts what waits on a live badge. Rulings never
  delete and are themselves recorded with who, over what, and why. Recall
  serves the outcome: retired notes disappear, human-verified ones outrank
  machine-only ones, unresolved conflicts are shown with both sides and a
  warning.
- **Staleness.** A machine-made note whose source files were reworked by later
  sessions, with nothing refreshing the entity, is flagged "possibly stale",
  computed deterministically when the queue is read, no model call involved.
  Human-verified notes are exempt.
- **`motif demo`.** Not a museum, a show: a team's week replays live in five
  acts. Sessions stream in, memory catches two of them contradicting each
  other, YOU rule on the conflict from the terminal, the Weaver aligns a real
  throwaway git repository with your ruling (diff on screen; rule the other way
  and it refuses to invent work), and recall answers with your verdict marked
  verified. No reader runs; nothing real can be touched.
- **`motif blame <file>`.** From the code back to the conversation: the
  sessions that touched a file, exact match beating loose and fresh beating
  old, drawn from the team server and this machine's own history. Attribution
  is inferred from what sessions recorded about themselves, and personal
  sessions stay out of a stranger's blame.

### Fixed

- Entity names and notes distilled from personal sessions were listed for every
  token holder by the memory endpoints. Notes now inherit the visibility of
  their evidence, the same rule sessions follow.

## [1.1.3], 2026-08-31

### Changed

- **Node 22 is the minimum.** `engines` said 20, but the SQLite prebuilds now
  start at 22, so a Node 20 install compiled from source without saying so. Node
  20 reached end of life in April 2026.
- The README leads with what the product does rather than with prose: the
  cross-tool handoff is shown above the fold, install appears once instead of
  twice, the solo story sits next to the team story, the retrieval benchmark
  carries its real figures, and the command reference is collapsed so it no
  longer sits between the pitch and the setup.

## [1.1.2], 2026-08-31

### Fixed

- **Installing on Node 24 compiled SQLite from source.** The pinned
  `better-sqlite3` line ships prebuilt binaries for Node 18, 20, 22 and 23, but
  not for 24, the current LTS. Anyone on it fell back to a `node-gyp` build,
  which needs a full C++ toolchain and fails outright without one, so
  `npx getmotif up` could break on the most common Node version. Moved to the
  release line that carries prebuilds for Node 22 through 26.

### Changed

- CI runs the suite and the real global-install check on Node 22 and 24, across
  Linux, macOS and Windows. Testing a single Node version is what let the gap
  above through.

## [1.1.1], 2026-08-31

### Fixed

- `motif doctor` asked the server who you were, so with the server off it
  reported "member identity (writes enabled)" as missing and told you to re-run
  `connect`, over a working token already on the machine. It now trusts the
  local member token when the server cannot be reached, and the server stays the
  authority when it answers.
- `motif daemon start` dropped `--claude-dir`, so a backgrounded daemon read the
  default directory instead of the one you named.
- A handoff out of a Codex session was annotated as coming from Claude Code. The
  marker now names the tool the session actually came from.

### Changed

- `motif recall` says in the terminal that what it printed is context for an
  agent, not an answer to your question.
- The quickstart is now the real first run, `npx getmotif up`, on your own
  sessions, local until you connect to a team. The seeded two-member demo script
  it replaced is no longer part of the repository.

## [1.1.0], 2026-08-31

Security release. Everyone running a shared server should upgrade.

### Security

- **Identity takeover (critical).** `POST /api/members/register` returned a
  valid token for an identity that already existed, so the shared read-only team
  token could be exchanged for the owner's credential. Re-enrollment now requires
  that member's own token or the owner's.
- **Personal sessions leaked through the event stream.** Session titles are the
  first user prompt and project paths are absolute; both were published to every
  subscriber. Events now carry visibility and personal ones reach only their
  owner. `GET /api/projects` had the same hole.
- **The ask path trusted its input.** Ownership of a transcript is now checked
  against the agent directories rather than by `existsSync`, session ids must be
  shaped like ids before they reach argv, and the daemon refuses a session that
  is not the one the request named. The question travels on stdin instead of a
  command line, on Windows a shell would have interpreted it, and runs with
  read-only tools, fenced as quoted text.
- A handoff could write one level outside `~/.claude/projects`.
- The rate-limit key was a client-supplied header; it is now the socket address
  unless `MOTIF_TRUST_PROXY=1`.
- `~/.motif/config.json`, which holds the member token, is created 0600.
- Handoff lineage rows could be attached to sessions the caller cannot see.

### Fixed

- `motif mcp install` replaced a config it had failed to parse, without taking
  the backup it takes on success, deleting other MCP servers.
- A non-numeric `budget` disabled the recall cap and returned everything.

### Changed

- SECURITY.md now states what a teammate can and cannot cause on your machine,
  and that this is a trust model rather than a sandbox.

## [1.0.6], 2026-08-31

### Fixed

- `motif projects team <path>` did nothing to sessions that were already synced,
  which is all of them: a fresh member uploads everything as `personal` before
  they ever set a scope. Visibility computed from project scope now applies on
  re-sync, while a choice made by hand in the dashboard still outranks it.
  (Migration v8.)
- A handoff delivered by a teammate was refused by the guard that stops you
  handing a session to the tool it already lives in, the guard fired on a path
  that happened to exist on the receiving machine.
- `motif handoff --to-member` reported the request as sent and exited, so a
  failure on the recipient's machine was never seen. It waits for the outcome.

### Changed

- SECURITY.md now states which tokens are hashed: member tokens are, the team
  token is not, because the server prints it on every start.
- New guide: `docs/TEAM-SETUP.md`, including the thing that surprises people,
  the database file _is_ the team, and starting the server against a different
  path creates a new empty one.

## [1.0.5], 2026-08-31

### Fixed

- `motif up` and `motif ui` printed the **team** token as the dashboard login.
  It is read-only, so the person running their own server signed in unable to
  use handoff, ask or notes. Both now use the member token, and `motif ui` signs
  the browser in directly instead of asking you to copy anything.
- A mistyped session id printed a raw `HTTP 404` from `show`, `comment`,
  `comments`, `asks`, `ask` and `handoff` once connected to a server, while the
  same typo gave a readable message when disconnected.
- `motif search ""` listed every session instead of saying what it needed.

### Changed

- Package description rewritten to lead with what the product is for.

## [1.0.4], 2026-08-31

### Changed

- README restructured around the five things Motif does, collect, ask, recall,
  decide, move, each with the command that does it, plus a usage reference
  grouped by task. Published so the npm package page carries it too.

## [1.0.3], 2026-08-31

### Fixed

- `motif up` on a machine where the port was already taken crashed with an
  unhandled `EADDRINUSE` and a raw Node stack trace, the first thing a new user
  saw. It now says what is holding the port, and whether that is another Motif:
  if so it points at `motif ui`, otherwise at `--port` and `lsof`. `EACCES` on a
  privileged port is explained too.
- The server commands now wait for the port to actually bind before continuing,
  so a failed bind no longer races ahead and reports a confusing error from the
  next step instead.

## [1.0.2], 2026-08-31

### Fixed

- `motif --version` reported the previous release. The version was a hand-edited
  constant that did not track the manifest, so 1.0.1 shipped announcing itself as
  1.0.0. It is now injected from `package.json` at build time, and both CI and the
  release workflow fail if the binary and the manifest ever disagree again.

## [1.0.1], 2026-08-31

### Changed

- README rewritten. It now opens with a real `motif recall` result rather than
  the handoff animation, states the single-machine case explicitly, and carries
  version, CI and license badges.

### Fixed

- The README claimed 62 tests (there are 64) and quoted an exact benchmark
  corpus size that grows over time. The durable claim replaced the drifting one.
- Image URLs are absolute, so they render on the npm package page as well as on
  GitHub.

## [1.0.0], 2026-08-30

First public release.

### Added

- **Collection**, a daemon watches Claude Code, Codex and Cursor sessions on
  each machine and syncs them to a self-hosted server. Incremental sync with a
  prefix hash; the source files are the durable queue.
- **Native handoff, both directions**, a Claude Code session becomes a real
  Codex rollout (registered in Codex's thread database, so `codex resume` lists
  it), and a Codex or Cursor session becomes a real Claude Code transcript.
  `--to-member` hands a session to a teammate; their daemon materialises it.
- **Recall**, deterministic retrieval over the team's history: FTS/bm25 plus a
  session graph (handoff lineage, shared memory entities, overlapping files)
  plus human notes, packed into a token budget. No embeddings, no API key.
- **MCP server**, `motif mcp install` registers Motif with Claude Code, Codex
  and Cursor. Tools: `recall`, `search_sessions`, `list_sessions`,
  `get_session`, `ask_session`.
- **Ask a session**, resume any past Claude Code or Codex session read-only on
  the machine that owns it and get an answer from the agent that lived it.
- **Session memory**, entity-based notes with supersession and conflict
  detection, via a pluggable LLM provider (Anthropic, OpenAI, any
  OpenAI-compatible endpoint, or the local `claude` CLI).
- **Team dashboard**, session timeline, transcripts, search, memory, pinned
  notes with @mentions, and handoff controls, served by the same binary.
- **Team/personal scope**, joining a team shares nothing by default; sessions
  upload as personal until a project is marked team-visible.
- **Privacy controls**, per-project include/exclude, secret redaction over
  message text and tool inputs, and `--purge` to withdraw what was already sent.
- Docker image and compose file, retention pruning, health endpoint, and a
  benchmark harness (`npm run bench`).

### Security

- Identity derives from a per-device member token, never from a claimed name or
  header. Tokens are 192-bit, stored as SHA-256 hashes, compared in constant
  time, and rate-limited on failure.

[Unreleased]: https://github.com/motif-Labs/motif/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/motif-Labs/motif/releases/tag/v1.1.0
[1.0.6]: https://github.com/motif-Labs/motif/releases/tag/v1.0.6
[1.0.5]: https://github.com/motif-Labs/motif/releases/tag/v1.0.5
[1.0.4]: https://github.com/motif-Labs/motif/releases/tag/v1.0.4
[1.0.3]: https://github.com/motif-Labs/motif/releases/tag/v1.0.3
[1.0.2]: https://github.com/motif-Labs/motif/releases/tag/v1.0.2
[1.0.1]: https://github.com/motif-Labs/motif/releases/tag/v1.0.1
[1.0.0]: https://github.com/motif-Labs/motif/releases/tag/v1.0.0
