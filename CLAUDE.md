# Motif, working notes for agents

A self-hosted unification layer for AI coding-agent sessions: it collects
sessions from Claude Code, Codex and Cursor on every dev machine, makes them
searchable across the team, hands a session from one tool to another
_natively_, and distils them into team memory that agents query over MCP.

## Ground rules

**This repository is public. Nothing personal belongs in it.** Someone should
be able to clone it, run it, and find no trace of whoever wrote it.

- **No personal data, ever**, no real names in code, tests or fixtures; no
  home-directory paths (`/Users/<name>`, `C:\Users\<name>`); no machine names,
  timezones or locales; no real email addresses. Test fixtures use `alice`,
  `ben`, `ada` and paths like `/workspace/app` or `/tmp/demo`.
- **No captured session content.** Fixtures are written by hand, not copied
  from a real run. `fixtures/codex/rollout-0.150.1.jsonl` keeps the _envelope_
  of a real rollout with every message replaced by synthetic text, that is the
  pattern to follow if a new format needs a fixture.
- **No third-party proprietary text.** Vendor system prompts, base instructions
  and internal model identifiers are not ours to redistribute. If a format
  capture contains them, replace them with a placeholder that keeps the shape.
- **No real credentials, expired ones included.** A token that matches the
  shape of a live one (`mm_…`, `sk-…`, `ghp_…`) must be obviously fake:
  `mm_EXAMPLEtokenNOTreal000000000000000`.
- **No competitor company names** anywhere, source, docs, or commit messages.
  Name a competing product only where it is an integration target (Claude Code,
  Codex, Cursor are unavoidable; nothing else is).
- **Commit messages carry no personal information**, no pasted conversation,
  and no competitor names. Write them about the code.
- `research/` is git-ignored strategy material. It never enters the repository,
  and nothing in it should be quoted into code comments or docs.
- The repository is written in **English**, including comments and commits.

**Never read or sync the machine's real agent history in a test, script or
demo.** Every reader takes an override, `--claude-dir`, `CODEX_HOME`,
`MOTIF_CURSOR_DIR`, and `MOTIF_HOME` relocates config _and_ the database. Pin
all four; an override that silently falls back to the real directory is a bug,
not a convenience.

## Layout

```
packages/core     session schema, readers (Claude Code, Codex), writers (handoff)
packages/cli      the `motif` binary, the sync daemon, the MCP server, Cursor reader
packages/server   Hono API + better-sqlite3 store, retrieval, memory distillation
ui/               Preact dashboard (no framework beyond Preact; hand-rolled CSS)
bench/            retrieval benchmark, `npm run bench`
```

## Commands

```bash
npm install && npm run build     # build ui then the CLI bundle
npx vitest run                   # 62 tests
npm run typecheck                # tsc -b across the three packages
npm run bench                    # retrieval hit rate and token size
```

The published npm package is **`getmotif`**; the binary it installs is `motif`
(the name `motif` was already taken on npm). Any user-facing install string
must say `getmotif`.

## Things worth knowing before changing code

- **Claude Code transcripts are a DAG, not a list.** Lines link by
  `parentUuid`, and a session must be linearised from the last leaf. Two
  different `user` line shapes exist.
- **Codex rollouts** are `{timestamp, ordinal, type, payload}` per line, and
  `function_call.arguments` is a JSON _string_, not an object. A handoff also
  has to register the thread in `~/.codex/state_5.sqlite` or `codex resume`
  will not list it.
- **Sync is incremental with a prefix hash.** A mismatch (or a 409) falls back
  to a full PUT. The source `.jsonl` files are the durable queue; daemon state
  only memoises what the server already acknowledged.
- **Identity is the member token**, never a header. Anything that attributes a
  write to a claimed name is a security bug.
- **Joining a team shares nothing by default.** Fresh machines upload as
  `personal`; only explicitly listed projects go up as `team`. `canView()`
  gates every read path, list, search, detail, export, asks, comments.
- **Scope globs are prefix-matching**: a plain directory covers its whole tree.
  This is the privacy gate; `tests/regressions.test.ts` pins the semantics.
- **Retrieval is deterministic**, FTS/bm25 + the session graph + human notes,
  no embeddings and no API key. Search uses AND, recall uses OR; the difference
  is the reason recall works on natural-language questions at all.
- Migrations are numbered in `packages/server/src/db/database.ts` and applied
  by `PRAGMA user_version`. Add one; never edit an old one.
