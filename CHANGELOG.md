# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.4] — 2026-08-31

### Changed

- README restructured around the five things Motif does — collect, ask, recall,
  decide, move — each with the command that does it, plus a usage reference
  grouped by task. Published so the npm package page carries it too.

## [1.0.3] — 2026-08-31

### Fixed

- `motif up` on a machine where the port was already taken crashed with an
  unhandled `EADDRINUSE` and a raw Node stack trace — the first thing a new user
  saw. It now says what is holding the port, and whether that is another Motif:
  if so it points at `motif ui`, otherwise at `--port` and `lsof`. `EACCES` on a
  privileged port is explained too.
- The server commands now wait for the port to actually bind before continuing,
  so a failed bind no longer races ahead and reports a confusing error from the
  next step instead.

## [1.0.2] — 2026-08-31

### Fixed

- `motif --version` reported the previous release. The version was a hand-edited
  constant that did not track the manifest, so 1.0.1 shipped announcing itself as
  1.0.0. It is now injected from `package.json` at build time, and both CI and the
  release workflow fail if the binary and the manifest ever disagree again.

## [1.0.1] — 2026-08-31

### Changed

- README rewritten. It now opens with a real `motif recall` result rather than
  the handoff animation, states the single-machine case explicitly, and carries
  version, CI and license badges.

### Fixed

- The README claimed 62 tests (there are 64) and quoted an exact benchmark
  corpus size that grows over time. The durable claim replaced the drifting one.
- Image URLs are absolute, so they render on the npm package page as well as on
  GitHub.

## [1.0.0] — 2026-08-30

First public release.

### Added

- **Collection** — a daemon watches Claude Code, Codex and Cursor sessions on
  each machine and syncs them to a self-hosted server. Incremental sync with a
  prefix hash; the source files are the durable queue.
- **Native handoff, both directions** — a Claude Code session becomes a real
  Codex rollout (registered in Codex's thread database, so `codex resume` lists
  it), and a Codex or Cursor session becomes a real Claude Code transcript.
  `--to-member` hands a session to a teammate; their daemon materialises it.
- **Recall** — deterministic retrieval over the team's history: FTS/bm25 plus a
  session graph (handoff lineage, shared memory entities, overlapping files)
  plus human notes, packed into a token budget. No embeddings, no API key.
- **MCP server** — `motif mcp install` registers Motif with Claude Code, Codex
  and Cursor. Tools: `recall`, `search_sessions`, `list_sessions`,
  `get_session`, `ask_session`.
- **Ask a session** — resume any past Claude Code or Codex session read-only on
  the machine that owns it and get an answer from the agent that lived it.
- **Session memory** — entity-based notes with supersession and conflict
  detection, via a pluggable LLM provider (Anthropic, OpenAI, any
  OpenAI-compatible endpoint, or the local `claude` CLI).
- **Team dashboard** — session timeline, transcripts, search, memory, pinned
  notes with @mentions, and handoff controls, served by the same binary.
- **Team/personal scope** — joining a team shares nothing by default; sessions
  upload as personal until a project is marked team-visible.
- **Privacy controls** — per-project include/exclude, secret redaction over
  message text and tool inputs, and `--purge` to withdraw what was already sent.
- Docker image and compose file, retention pruning, health endpoint, and a
  benchmark harness (`npm run bench`).

### Security

- Identity derives from a per-device member token, never from a claimed name or
  header. Tokens are 192-bit, stored as SHA-256 hashes, compared in constant
  time, and rate-limited on failure.

[Unreleased]: https://github.com/motif-Labs/motif/compare/v1.0.4...HEAD
[1.0.4]: https://github.com/motif-Labs/motif/releases/tag/v1.0.4
[1.0.3]: https://github.com/motif-Labs/motif/releases/tag/v1.0.3
[1.0.2]: https://github.com/motif-Labs/motif/releases/tag/v1.0.2
[1.0.1]: https://github.com/motif-Labs/motif/releases/tag/v1.0.1
[1.0.0]: https://github.com/motif-Labs/motif/releases/tag/v1.0.0
