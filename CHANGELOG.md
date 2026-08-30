# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **Ask a session** — resume any past session read-only on the machine that owns
  it and get an answer from the agent that lived it.
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

[Unreleased]: https://github.com/motif-Labs/motif/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/motif-Labs/motif/releases/tag/v1.0.0
