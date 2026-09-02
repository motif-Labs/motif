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

- Identity always derives from the member token, never from a claimed
  name or header. Members cannot write as each other.
- Tokens are 192-bit random values and comparisons are constant-time;
  repeated failures are rate-limited per client (20/min → 429).
- **Member tokens are stored as SHA-256 hashes**, the server cannot recover
  one, so a stolen database does not yield anybody's write credential.
- **The team token is stored in plaintext**, because the server prints it on
  every start so a teammate can be invited. It is a read-only credential, and
  anyone who can read the database file already has every session in it, but
  it is stored differently from member tokens and that is worth knowing.
- Every synced session carries a scope, and **joining a team never
  auto-shares your history**: a freshly connected machine uploads
  everything as `personal`, stored on the server but visible to _you
  alone_ (lists, search, detail, export all filter it), until you mark
  projects team-visible (`motif projects team <path>`) or promote
  individual sessions from the dashboard. Handing a personal session to
  a teammate promotes it (handing it over _is_ sharing it), and only
  team-visible sessions feed the shared memory. Keeping something off
  the server entirely still happens on the source machine (below).
- Handoffs and asks execute on the machine that **owns** the session, through
  its own daemon, which for a handoff you were sent means a teammate's request
  runs on yours. That is the feature, and the section below states exactly what
  it can and cannot do.
- The owner (first member) can rename the team and revoke any member's
  device tokens; to keep a revoked member out permanently, also rotate
  the team token (restart with a new `MOTIF_TOKEN`).

## What a teammate can cause on your machine

Motif is a team tool, and two of its features let someone else's request reach
your computer. Neither is a loophole, they are the product, but you should
know their exact shape before you leave the daemon running.

**A teammate can:**

- Read your **team-visible** sessions. That is what marking a project
  team-visible means.
- Hand you a session. Your daemon writes it as a new transcript under
  `~/.claude/projects` or `~/.codex/sessions`, and it shows up in that tool's
  resume list. The content is theirs, so treat a handed-over session the way you
  would treat any text a colleague sent you: it is context, not instruction.
- Ask one of your sessions a question. Your daemon resumes it on your machine,
  under your own CLI and your own subscription, and returns the answer.

**A teammate cannot:**

- Read your personal sessions, or any excerpt, snippet, memory note or live
  event derived from them.
- Write, change, delete or re-scope anything of yours on the server.
- Act as you: identity comes from your member token and nothing else, and
  registering against an existing identity is refused without proof.
- Cause a write anywhere except inside your agent directories, or overwrite or
  delete any file you already have.

**The bounds on the ask.** The question is delivered on standard input, never on
a command line, so its text cannot become a command. It runs with read-only
tools (`Read`, `Grep`, `Glob` for Claude Code; `sandbox_mode="read-only"` for
Codex) and is fenced so the model is told it is quoted text rather than
instructions. What remains, and is worth being clear about: the answer is
produced by a model reading your files within that session's directory, and
whatever it prints goes back to the person who asked. **A question is therefore
a request to read something on your machine and report it.** Ask yourself
whether you would answer it if a colleague walked over and asked out loud.

**The levers you hold.** The daemon is opt-in, nothing arrives if it is not
running. `motif daemon pause` stops delivery while keeping everything else.
Every request is logged to `~/.motif/daemon.log`. If you would rather answer by
hand, leave the daemon off and run `motif asks <id>` yourself.

This is a trust model, not a sandbox. It assumes your teammates are your
teammates, the same assumption you already make by sharing a repository with
them. Do not hand the team token to anyone you would not give read access to
your work, and rotate it (restart the server with a new `MOTIF_TOKEN`, and
revoke the member) when someone leaves.

## Keeping personal work personal

Filtering happens on each machine, before anything is uploaded:

```bash
motif connect <url> --token <t> --name "Ada" --selected  # allowlist mode from day one
motif projects include ~/work/company-repo               # only this syncs
# or, in default mode:
motif projects exclude ~/personal --purge                # block + withdraw already-synced
```

`redactPatterns` in `~/.motif/config.json` scrub secrets from message
text _and_ tool inputs before upload. Cursor conversations that Motif can map to a project follow the same
include/exclude rules as any other session. Ones it **cannot** map have no
project path, so a path-based `exclude` cannot match them: in the default mode
they upload (as `personal`, visible only to you), and in `selected` mode they
stay local. If that matters to you, use `--selected`.

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
releases, or build from source, it's all here.

## Reporting a vulnerability

**Report it privately, here:**
<https://github.com/motif-Labs/motif/security/advisories/new>

Private reporting is enabled on the repository, so that form reaches the
maintainers without the problem becoming public first. If you cannot use
GitHub, the contact address is on <https://www.getmotif.dev>.

Please do not open a public issue for anything exploitable. Include what you
did, what happened, and the version (`motif --version`); a proof of concept
helps but is not required to file.

Expect an acknowledgement within a few days. Fixes land on the latest release,
there are no maintained back-branches, and the advisory is published once a
fixed version is out, crediting you unless you would rather stay anonymous.
