#!/usr/bin/env bash
# Spins up a complete two-person Motif team on this machine, with invented
# sessions, so you can see what the product does before pointing it at anything
# real. Nothing here reads or uploads your own agent history.
#
#   bash scripts/demo.sh          # start (server + 2 members + seeded sessions)
#   bash scripts/demo.sh clean    # remove everything it created
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOTIF="node $ROOT/packages/cli/dist/index.js"
PORT="${MOTIF_DEMO_PORT:-4680}"
DEMO="${MOTIF_DEMO_DIR:-$HOME/.motif-demo}"

if [ "${1:-}" = "clean" ]; then
  [ -f "$DEMO/server.pid" ] && kill "$(cat "$DEMO/server.pid")" 2>/dev/null || true
  rm -rf "$DEMO"
  echo "Demo removed. Your own ~/.motif was never touched."
  exit 0
fi

if [ ! -f "$ROOT/packages/cli/dist/index.js" ]; then
  echo "Build first:  npm install && npm run build"
  exit 1
fi

# a previous demo may still hold the port; without this the script would
# silently talk to the old server and show its data
[ -f "$DEMO/server.pid" ] && kill "$(cat "$DEMO/server.pid")" 2>/dev/null || true
if command -v lsof >/dev/null 2>&1; then
  { lsof -ti:"$PORT" -sTCP:LISTEN 2>/dev/null || true; } | while read -r p; do kill "$p" 2>/dev/null || true; done
fi
sleep 1

rm -rf "$DEMO"
mkdir -p "$DEMO"

# Each member gets their own config home and their own fake agent history.
for who in ada ben; do
  mkdir -p "$DEMO/$who/claude" "$DEMO/$who/codex"
done

echo "Seeding invented sessions…"
node "$ROOT/scripts/seed-sessions.mjs" "$DEMO/ada/claude" "$DEMO/ada/codex" ada
node "$ROOT/scripts/seed-sessions.mjs" "$DEMO/ben/claude" "$DEMO/ben/codex" ben

echo "Starting the team server on :$PORT …"
MOTIF_TEAM_NAME="Northwind Engineering" \
MOTIF_HOME="$DEMO/server" MOTIF_DB_PATH="$DEMO/motif.db" \
  $MOTIF server --port "$PORT" > "$DEMO/server.log" 2>&1 &
echo $! > "$DEMO/server.pid"

for _ in $(seq 1 20); do
  curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
TOKEN="$(grep -m1 'Team token' "$DEMO/server.log" | awk '{print $NF}')"
if [ -z "$TOKEN" ]; then echo "Server did not start — see $DEMO/server.log"; exit 1; fi

for who in ada ben; do
  name="$(printf '%s' "${who:0:1}" | tr '[:lower:]' '[:upper:]')${who:1}"
  MOTIF_HOME="$DEMO/$who" $MOTIF connect "http://127.0.0.1:$PORT" \
    --token "$TOKEN" --name "$name" --email "$who@northwind.test" >/dev/null
  # everything a fresh member uploads is personal by default; this is a demo team,
  # so mark the seeded workspace team-visible on purpose
  MOTIF_HOME="$DEMO/$who" $MOTIF projects team '/workspace/**' >/dev/null 2>&1 || true
  # every reader is pinned at the demo's own directories — the real ~/.claude,
  # ~/.codex and Cursor storage are never opened
  MOTIF_HOME="$DEMO/$who" CODEX_HOME="$DEMO/$who/codex" MOTIF_CURSOR_DIR="$DEMO/$who/cursor" \
    $MOTIF --claude-dir "$DEMO/$who/claude" sync >/dev/null
done

ADA_TOKEN="$(node -e "process.stdout.write(require('$DEMO/ada/config.json').memberToken)")"

BEN_TOKEN="$(node -e "process.stdout.write(require('$DEMO/ben/config.json').memberToken)")"

cat <<EOF

  Northwind Engineering is up — 2 members, sessions across Claude Code and Codex.

  Dashboard   http://127.0.0.1:$PORT   (or: motif ui — signs you in)
  Ada's token $ADA_TOKEN

  ── Terminal 1 · Ada ────────────────────────────────────────────────────────
  export MOTIF_HOME=$DEMO/ada CODEX_HOME=$DEMO/ada/codex MOTIF_CURSOR_DIR=$DEMO/ada/cursor
  alias motif="$MOTIF --claude-dir $DEMO/ada/claude"

      motif list
      motif recall "how do we handle retries"
      motif handoff <id> --to-member "Ben"

  ── Terminal 2 · Ben's machine ──────────────────────────────────────────────
  export MOTIF_HOME=$DEMO/ben CODEX_HOME=$DEMO/ben/codex MOTIF_CURSOR_DIR=$DEMO/ben/cursor
  alias motif="$MOTIF --claude-dir $DEMO/ben/claude"

      motif daemon start                       # background: keeps this prompt free
      tail -f $DEMO/ben/daemon.log &           # incoming handoffs appear here, live
      # when one lands:
      codex resume <the id it prints>

  Codex needs its credentials in the pinned home, or it answers 401:
      ln -sf ~/.codex/auth.json $DEMO/ada/codex/auth.json
      ln -sf ~/.codex/auth.json $DEMO/ben/codex/auth.json

  Each side reads only its own directories, so neither touches your real
  ~/.claude, ~/.codex or Cursor storage. Two terminals side by side is a
  convincing two-machine demo; the only thing they share is the server.

  Tear it down: bash scripts/demo.sh clean

EOF
