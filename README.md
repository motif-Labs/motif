# Motif

**A unification layer for AI coding agent sessions.** Open source, fully self-hosted.

Your team writes code with Claude Code, Codex, and Cursor — each tool keeps its sessions
in its own format, in its own corner. Motif collects them in one place, makes them
searchable across tools and teammates, streams them live to a team dashboard, and can
hand a session started in one tool over to another tool **natively** — the target tool
treats it as its own history, not a summary.

## Features (v0.1)

- **Collect** — a lightweight daemon watches Claude Code sessions on each dev machine and
  syncs them live to your self-hosted server. Sessions never leave your infrastructure.
- **Native handoff** — convert a Claude Code session into a real Codex rollout file.
  `codex resume` picks it up as its own session; continue exactly where you left off.
- **Session memory** — the server distills sessions into entity-based notes (files,
  decisions, topics) with supersession and conflict detection, powered by a pluggable
  LLM provider (Anthropic, OpenAI, any OpenAI-compatible endpoint, or the local
  `claude` CLI).
- **Solo mode** — `motif up` runs the same server locally. No team required.

## Status

Early development. See `docs/` as it lands.

## License

MIT
