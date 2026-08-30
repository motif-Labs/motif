## What this changes

<!-- One or two sentences. If it fixes an issue, write "Fixes #123". -->

## Why

<!-- The problem, not the patch. What did a user hit? -->

## How it was verified

<!-- Commands you ran, or the manual steps. "npx vitest run" alone is fine for
     small changes; anything touching sync, handoff or scope deserves a note on
     what you exercised by hand. -->

## Checklist

- [ ] `npx vitest run` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run format:check` passes
- [ ] A test covers the change (a bug fix gets a test that fails without it)
- [ ] No personal data, real credentials, captured session content, or
      third-party proprietary text in code, fixtures or commit messages
- [ ] Commits are signed off (`git commit -s`) per [CONTRIBUTING.md](../CONTRIBUTING.md)
