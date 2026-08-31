#!/usr/bin/env bash
# reap-media.sh — daily attachment retention sweep. Thin wrapper around
# `node src/reap.js` that pins the same PUNCHLIST_DATA / PUNCHLIST_MEDIA_DIR the
# server uses and appends every run to a state log. Safe to run repeatedly: the
# reaper only deletes files+rows whose retention rule has fired.
#
# Cron (personal box) is registered via ~/.claude/setup/directives.json
# (machines.<hostname>.crons) + register-crons.sh. Run by hand any time:
#   PUNCHLIST_DATA=… PUNCHLIST_MEDIA_DIR=… scripts/reap-media.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${PUNCHLIST_REAP_LOG:-$HOME/.local/state/punchlist-reap.log}"
mkdir -p "$(dirname "$LOG")"

# PUNCHLIST_DATA / PUNCHLIST_MEDIA_DIR are honoured by src/reap.js directly; if
# a data/.env carries them (like the server), source it so cron matches prod.
if [ -z "${PUNCHLIST_DATA:-}" ] && [ -f "$ROOT/data/.env" ]; then
  set -a; . "$ROOT/data/.env"; set +a
fi

exec >>"$LOG" 2>&1
echo "--- reap-media $(date -Is) ---"
node "$ROOT/src/reap.js"
