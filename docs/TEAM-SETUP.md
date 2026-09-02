# Setting Motif up for a team

One person runs the server. Everyone else runs `connect` once and leaves the
daemon on. This page is the whole thing, including the details that bite.

## 1. Someone runs the server

On a machine the team can reach, a company box, a small VPS, or one person's
laptop on the office network.

```bash
docker compose up -d
# or, without Docker:
MOTIF_TOKEN=<pick-a-long-random-string> npx getmotif server --host 0.0.0.0
```

It prints the team token and the exact command teammates should run.

**Set `MOTIF_TOKEN` yourself.** If you leave it out, the server generates one and
stores it, which is fine, but you cannot recover it except from the server's
own output or its database, and if you ever start the server against a _fresh_
database you will get a different token. Choosing it makes the whole thing
reproducible.

**Bind explicitly.** The default is `127.0.0.1`, which nobody else can reach.
Teammates need `--host 0.0.0.0`, and then a firewall rule or a reverse proxy in
front, see [TLS](#tls) below.

### The database is the team

Everything, sessions, members, tokens, memory, lives in one SQLite file:
`~/.motif/motif.db`, or `/data/motif.db` in the Docker volume.

That file **is** your team. As long as the server starts against the same file:

- the team token stays the same across restarts
- every member stays connected; nobody re-authenticates
- an old invite token still works

Start the server against a different path and you have a **new, empty team**:
new token, no members, no history. Nobody is locked out permanently, the data
is still in the old file, but everyone must reconnect.

So: pin the path with `MOTIF_DB_PATH`, or use the Docker volume, and back the
file up. Backup is `cp` while the server is stopped, or
[Litestream](https://litestream.io) for continuous replication.

## 2. Each teammate connects, once

```bash
npm i -g getmotif
motif connect https://motif.internal.yourco.dev \
  --token <team-token> --name "Ada" --email ada@yourco.dev
motif daemon install     # starts at every login
```

`connect` mints a **member token** for that person and that machine, and stores
it in `~/.motif/config.json`. Only its hash reaches the server. Everything they
write afterwards is attributed to them; the team token cannot write anything.

One person, several machines: run `connect` on each. Use the same `--email` and
they stay one person in the dashboard.

## 3. Nothing is shared until someone says so

This is the part people get wrong. **Connecting shares nothing.** Every session
uploads as `personal`, stored on the server, visible only to its owner.

To share a project with the team:

```bash
motif projects team ~/work/payments-api
```

That covers the whole tree beneath the path, and it applies to sessions already
synced as well as new ones. Check what is happening with:

```bash
motif projects list
```

To keep something out entirely, not even uploaded as personal:

```bash
motif projects exclude ~/personal --purge
```

`--purge` also withdraws anything that was already sent. Run it and read the
count it prints.

On a shared or personal machine, start in allowlist mode instead, where nothing
syncs until you name it:

```bash
motif connect <url> --token <t> --name "Ada" --selected
motif projects include ~/work/company-repo
```

Promoting a single session by hand, from the dashboard, or
`motif projects team` on its project, sticks. A later re-sync will not undo a
choice a person made deliberately.

## 4. Check it worked

```bash
motif status     # server, identity, daemon, scope, what was detected
motif doctor     # the same, as a checklist, with the fix for each ✗
motif list       # you should now see teammates' team-visible sessions
```

If `doctor` says _member identity (writes enabled)_ is missing, you are signed in
with the team token, re-run `connect`.

## 5. What each person can do

|                                            | team token | member token |
| ------------------------------------------ | ---------- | ------------ |
| read team-visible sessions, search, recall | yes        | yes          |
| register a new machine                     | yes        |,            |
| upload sessions                            | no         | yes          |
| hand off, ask, pin notes                   | no         | yes          |
| see their own personal sessions            | no         | yes          |

The dashboard asks for a token on first load. Give people **their own member
token** (`~/.motif/config.json`, or just run `motif ui`, which signs the browser
in for you). Signing in with the team token gives a read-only dashboard with the
action buttons disabled.

## 6. Handoff and ask across machines

Both run on the machine that **owns** the session, through its daemon. So:

- The recipient's daemon must be running for a handoff to land. If it is off,
  the request waits and is delivered the next time they come online.
- `motif ask` on a teammate's session resumes it on their machine, under their
  own CLI and subscription. If they have not run `motif daemon start`, nothing
  happens until they do.

```bash
motif handoff <id> --to-member "Ben"    # waits and tells you when it lands
motif ask <id> "why did we rule that out?"
```

## TLS

The server speaks plain HTTP and expects a reverse proxy for anything beyond a
trusted network. Two lines of Caddy:

```
motif.internal.yourco.dev {
  reverse_proxy 127.0.0.1:4680
}
```

Then teammates connect to the `https://` address.

## Keeping it healthy

- `GET /api/health` for monitoring.
- `motif prune --older-than 90` drops old raw sessions; distilled memory notes
  survive. Minimum 7 days.
- The daemon logs to `~/.motif/daemon.log`, rotated at each start.
- Footprint on a real workload: ≈57 MB resident for server and daemon combined,
  ≈14 MB database.

## When something is wrong

| symptom                                    | what it usually is                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| teammates cannot connect after a restart   | the server started against a different database path                       |
| "member identity (writes enabled)" missing | signed in with the team token; re-run `connect`                            |
| a teammate's sessions are invisible        | their projects are still `personal`; they run `motif projects team <path>` |
| a handoff never lands                      | the recipient's daemon is not running                                      |
| the dashboard buttons are greyed out       | signed in with the team token; use `motif ui`                              |
