# Contributing to Motif

Thanks for helping! A few ground rules keep the project healthy.

## Developer Certificate of Origin (DCO)

Every commit must be signed off (`git commit -s`), which adds:

```
Signed-off-by: Your Name <you@example.com>
```

This certifies the [DCO](https://developercertificate.org/): you wrote the
change or have the right to submit it under the project license. Commits
without a sign-off can't be merged. (This also preserves the project's
ability to offer commercial licensing for future `ee/` components without
relicensing anyone's work without consent.)

## Getting started

```bash
git clone https://github.com/motifhq/motif && cd motif
npm ci
npx vitest run                 # the suite should pass (62 tests)
npx tsx packages/cli/src/index.ts scan   # run the CLI from source
npm run build -w @motif/ui && npm run build -w motifhq   # full bundle
```

Layout: `packages/core` (schema, readers, writers — pure), `packages/cli`
(the `motif` binary + daemon), `packages/server` (Hono + SQLite), `ui/`
(Preact dashboard).

## Pull requests

- Keep PRs focused; add or update tests for behavior changes.
- `npx tsc -b packages/core packages/cli packages/server` and
  `npx vitest run` must pass (CI runs them on Linux, macOS, and Windows).
- New session readers are the most welcome contribution — model them on
  `packages/core/src/readers/codex.ts` (tolerant line-by-line parsing,
  fixture-backed tests, never fatal on schema drift).

## Security issues

Please do not open public issues for exploitable problems — see
[SECURITY.md](SECURITY.md).
