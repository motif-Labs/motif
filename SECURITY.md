# Security

## Model

Motif is fully self-hosted: the server your team runs is the only place
session data ever goes. The code makes no calls to any third party except
the LLM provider _you_ configure for the optional memory feature.

Two credentials, two levels:

| Credential       | Who has it                                       | Can do                                             |
| ---------------- | ------------------------------------------------ | -------------------------------------------------- |
| **Team token**   | shared once, out-of-band                         | read dashboards/search; register a new member      |
| **Member token** | one per person/device, minted by `motif connect` | everything; every write is attributed to its owner |

- Identity always derives from the member token — never from a claimed
  name or header. Members cannot write as each other.
- Tokens are 192-bit random values; only SHA-256 hashes are stored
  server-side; comparisons are constant-time; repeated failures are
  rate-limited per client (20/min → 429).
- Every synced session carries a scope, and **joining a team never
  auto-shares your history**: a freshly connected machine uploads
  everything as `personal` — stored on the server but visible to _you
  alone_ (lists, search, detail, export all filter it) — until you mark
  projects team-visible (`motif projects team <path>`) or promote
  individual sessions from the dashboard. Handing a personal session to
  a teammate promotes it (handing it over _is_ sharing it), and only
  team-visible sessions feed the shared memory. Keeping something off
  the server entirely still happens on the source machine (below).
- Dashboard-initiated handoffs execute only on the requester's own
  machine via their own daemon; requests are invisible to other members.
- The owner (first member) can rename the team and revoke any member's
  device tokens; to keep a revoked member out permanently, also rotate
  the team token (restart with a new `MOTIF_TOKEN`).

## Keeping personal work personal

Filtering happens on each machine, before anything is uploaded:

```bash
motif connect <url> --token <t> --name "Ada" --selected  # allowlist mode from day one
motif projects include ~/work/company-repo               # only this syncs
# or, in default mode:
motif projects exclude ~/personal --purge                # block + withdraw already-synced
```

`redactPatterns` in `~/.motif/config.json` scrub secrets from message
text _and_ tool inputs before upload. In `selected` mode, Cursor
conversations Motif cannot map to a project stay local too; ones it can map
follow the same include/exclude rules as any other session.

## Transport

The server binds plainly and expects TLS from a reverse proxy for any
deployment beyond a trusted network:

```
motif.internal.example.com {
  reverse_proxy 127.0.0.1:4680
}
```

(two-line Caddyfile; certificates are automatic.)

## Supply chain

Releases will be published from CI with npm provenance attestations;
dependencies are deliberately minimal (4 runtime packages); the package
has no install scripts of its own. Pin versions, review diffs between
releases, or build from source — it's all here.

## Reporting

Open a GitHub security advisory or email the maintainer. Please do not
file public issues for exploitable problems.
