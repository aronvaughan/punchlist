#!/usr/bin/env bash
# install.sh — one-shot, idempotent setup: deps, per-actor tokens, service.
#
#   ./install.sh [--actors "owner,claude,hermes,email"] [--no-service]
#
# --actors     comma-separated actor names to mint bearer tokens for. The
#              FIRST actor is the admin (approves reviews, owns the
#              Today/Inbox lanes) — written as AV_TASKS_ADMIN.
#              Default: owner,claude,hermes,email
# --no-service install everything but do not start/register the service.
#
# Existing data/.env is NEVER overwritten (tokens are kept). Safe to re-run.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${AV_TASKS_DATA:-$REPO/data}"
PORT="${AV_TASKS_PORT:-8600}"
ACTORS="owner,claude,hermes,email"
SERVICE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --actors)     ACTORS="$2"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    -h|--help)    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install: unknown flag $1 (see --help)" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null || { echo "install: node >= 26 is required" >&2; exit 1; }

echo "== dependencies (npm ci)"
(cd "$REPO" && npm ci)

echo "== tokens ($DATA_DIR/.env)"
mkdir -p "$DATA_DIR"
if [ -f "$DATA_DIR/.env" ]; then
  echo "   exists — keeping your tokens (delete it to re-mint)"
else
  PAIRS=""
  FIRST=""
  IFS=',' read -ra NAMES <<<"$ACTORS"
  for raw in "${NAMES[@]}"; do
    name="$(echo "$raw" | tr -d '[:space:]')"
    [ -n "$name" ] || continue
    [ -n "$FIRST" ] || FIRST="$name"
    tok="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("hex"))')"
    PAIRS="${PAIRS:+$PAIRS,}$name:$tok"
  done
  [ -n "$FIRST" ] || { echo "install: --actors produced no actors" >&2; exit 2; }
  umask 077
  {
    echo "AV_TASKS_TOKENS=$PAIRS"
    echo "AV_TASKS_ADMIN=$FIRST"
  } >"$DATA_DIR/.env"
  chmod 600 "$DATA_DIR/.env"
  echo "   minted tokens for: $ACTORS (admin/approver: $FIRST)"
  echo "   each actor's Bearer token lives in $DATA_DIR/.env — hand them out from there"
fi

if [ "$SERVICE" = 0 ]; then
  echo "== service skipped (--no-service). Start manually with: npm start"
  exit 0
fi

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  echo "== systemd user unit (scripts/install/setup-service.sh)"
  bash "$REPO/scripts/install/setup-service.sh"
else
  echo "== no systemd — start it yourself, e.g.:"
  echo "   nohup node $REPO/src/server.js >>$DATA_DIR/punchlist.log 2>&1 &"
  echo "   then verify: curl -sf http://127.0.0.1:$PORT/api/v1/health"
  exit 0
fi

echo "== done. Open http://127.0.0.1:$PORT then run: ./bin/punchlist install-skills"
