#!/usr/bin/env bash
# advance-sweep.sh — cron entry point: advance every running workflow run.
#   */10 * * * * bash $HOME/code/punchlist-templates/scripts/advance-sweep.sh
# bin/plt resolves the punchlist token itself (PUNCHLIST_TOKEN, then the
# pl.sh env-file conventions); sourcing hermes-env.sh exports HERMES_HOME so
# the $HERMES_HOME/.env fallback works on machines that run Hermes.
set -u

LOG="$HOME/.local/state/plt-advance.log"
LOCK="$HOME/.local/state/plt-advance.lock"
mkdir -p "$(dirname "$LOG")"

# one sweep at a time — a slow run must not stack with the next cron tick
exec 9>"$LOCK"
flock -n 9 || exit 0

if [ -r "$HOME/.claude/scripts/hermes-env.sh" ]; then
  # shellcheck source=/dev/null
  . "$HOME/.claude/scripts/hermes-env.sh"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
{
  echo "=== $(date -Is)"
  node "$ROOT/bin/plt" advance --all
} >>"$LOG" 2>&1
