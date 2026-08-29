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

## Quick start

**Solo (one machine):**

```bash
npx motif up          # server + live sync on localhost:4680
npx motif ui          # open the dashboard
```

**Team (self-hosted server):**

```bash
# On your server (or: docker compose up)
npx motif server --port 4680
# → prints the team token

# On each dev machine
npx motif connect http://your-server:4680 --token <token> --name "Ada" --email ada@team.dev
motif daemon start    # sessions now stream to the server live
```

**Everyday commands:**

```bash
motif list                 # sessions across the whole team, newest first
motif search "rclone"      # full-text search over everyone's sessions
motif show <id>            # read any session as a transcript
motif handoff <id>         # continue a Claude Code session in Codex, natively
```

## Session memory

Set an LLM provider on the server and Motif distills idle sessions into
entity-based notes — decisions, files, topics — where new knowledge supersedes
old (history kept) and contradictions are flagged instead of silently piling up:

```bash
MOTIF_LLM_PROVIDER=anthropic MOTIF_LLM_API_KEY=sk-... npx motif server
# or: openai | openai-compatible (any baseURL: Ollama, vLLM, OpenRouter) | claude-code (local CLI, no key)
```

## Privacy

Sessions sync to **your** server and nowhere else. The daemon applies
`exclude` globs and `redactPatterns` regexes from `~/.motif/config.json`
before anything leaves the machine. Put TLS in front with your reverse proxy
(e.g. Caddy) for teams outside a trusted network.

## Status

Early development (v0.1). Claude Code reader and native handoff
(Claude Code → Codex) are live — the handoff writes a real Codex rollout file
and registers the thread in Codex's state DB, verified against Codex 0.150.1:
`codex resume` lists the session and appends to it as its own history.
Codex reader and Cursor reader are next.

## License

MIT
