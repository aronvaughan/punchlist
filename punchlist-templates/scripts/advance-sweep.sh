#!/usr/bin/env bash
# advance-sweep.sh — cron entry point: advance every running workflow run.
#   */10 * * * * bash /path/to/punchlist-templates/scripts/advance-sweep.sh
# bin/plt resolves the punchlist token itself (PUNCHLIST_TOKEN, then the
# pl.sh env-file conventions); sourcing hermes-env.sh exports HERMES_HOME so
# the $HERMES_HOME/.env fallback works on machines that run Hermes.
set -u

LOG="$HOME/.local/state/plt-advance.log"
LOCK="$HOME/.local/state/plt-advance.lock"
mkdir -p "$(dirname "$LOG")"

# one sweep at a time — a slow run must not stack with the next cron tick.
# macOS ships no flock, and `flock -n 9 || exit 0` swallowed its own
# "command not found" (127) as if the lock were held: the sweep exited 0
# and never ran, every ten minutes, silently. Fall back to an atomic
# mkdir lock there, released by the EXIT trap (a hard SIGKILL leaves it —
# rmdir it by hand).
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  flock -n 9 || exit 0
else
  LOCKDIR="$LOCK.d"
  mkdir "$LOCKDIR" 2>/dev/null || exit 0
  trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT
fi

if [ -r "$HOME/.claude/scripts/hermes-env.sh" ]; then
  # shellcheck source=/dev/null
  . "$HOME/.claude/scripts/hermes-env.sh"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# BSD date has no -I: `date -Is` errors out and the log line loses its
# timestamp. Spell the ISO format explicitly - it is identical on both.
now() { date +%Y-%m-%dT%H:%M:%S%z; }
{
  echo "=== $(now)"
  node "$ROOT/bin/plt" advance --all
} >>"$LOG" 2>&1
