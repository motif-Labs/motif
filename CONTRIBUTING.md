# Contributing to Motif

Thanks for helping. This file is short on purpose — read it once and you know
what a merged change looks like here.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting started

```bash
git clone https://github.com/motif-Labs/motif && cd motif
npm ci
npm run build                  # ui bundle, then the CLI bundle
npx vitest run                 # the suite should pass (62 tests)
npm run typecheck              # tsc -b across the three packages
```

To see the product with data in it, without touching your own agent history:

```bash
bash scripts/demo.sh           # two members, invented sessions, live dashboard
bash scripts/demo.sh clean     # remove everything it created
```

To run the CLI from source instead of the bundle:

```bash
npx tsx packages/cli/src/index.ts --help
```

Layout: `packages/core` (schema, readers, writers — pure, no I/O beyond files),
`packages/cli` (the `motif` binary, the sync daemon, the MCP server),
`packages/server` (Hono + SQLite, retrieval, memory), `ui/` (Preact dashboard).
The published npm package is `getmotif`; the binary it installs is `motif`.

## Developer Certificate of Origin (DCO)

Every commit must be signed off (`git commit -s`), which adds:

```
Signed-off-by: Your Name <you@example.com>
```

This certifies the [DCO](https://developercertificate.org/): you wrote the
change or have the right to submit it under the project license. Commits
without a sign-off can't be merged. It also keeps the project able to offer
commercial licensing for future `ee/` components without relicensing anyone's
work without their consent.

## What a good pull request looks like

- **Focused.** One problem per PR. A refactor and a fix in the same diff will be
  asked to split.
- **Tested.** A bug fix comes with a test that fails without the fix;
  `tests/regressions.test.ts` is where those live, one case per shipped bug.
- **Green.** `npx vitest run`, `npm run typecheck` and `npm run format:check`
  all pass. CI runs the suite on Linux, macOS and Windows.
- **Formatted.** `npm run format` before you push. Prettier config is in the
  repo; do not reformat code you did not otherwise touch.
- **Explained in the commit message.** Say what a user hit and why the change is
  right, not just what the diff does.

### Never commit

- personal data — real names, home-directory paths, machine names, emails
- captured session content from a real run, yours or anyone's
- third-party proprietary text (vendor system prompts, base instructions)
- real credentials, including expired ones; test tokens must be obviously fake

Fixtures are written by hand. If a new format needs one, keep the envelope and
replace the content with synthetic text — `fixtures/codex/rollout-0.150.1.jsonl`
is the pattern.

## Things especially worth contributing

- **New session readers.** The most welcome contribution by far. Model them on
  `packages/core/src/readers/codex.ts`: tolerant line-by-line parsing,
  fixture-backed tests, never fatal on schema drift — these formats change
  without notice, and a reader that throws takes the whole sync down.
- **Format fixes** when Claude Code, Codex or Cursor changes something under us.
  A failing fixture test plus the corrected parse is a perfect PR.
- **Retrieval quality.** `npm run bench` measures it; a change that moves the
  hit rate with the numbers to show is easy to review.

## Architecture notes

Read [CLAUDE.md](CLAUDE.md) before changing sync, handoff or scope — it records
the non-obvious invariants (the Claude Code transcript DAG, the Codex rollout
envelope, the prefix-hash sync protocol, why identity is the member token, and
why scope globs are prefix-matching).

## Security issues

Please do not open public issues for exploitable problems — see
[SECURITY.md](SECURITY.md) for private reporting.
