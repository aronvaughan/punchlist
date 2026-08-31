#!/usr/bin/env bash
# plt-resolve.sh — canonical resolver shim for agent skills.
#
# Locates the punchlist-templates checkout and forwards to bin/plt.
# Resolution order:
#   1. $PUNCHLIST_TEMPLATES_DIR (explicit override)
#   2. walk up from this script's real location until a dir containing
#      bin/plt is found (works from any copy inside the repo)
set -u

if [ -n "${PUNCHLIST_TEMPLATES_DIR:-}" ]; then
  ROOT="$PUNCHLIST_TEMPLATES_DIR"
else
  DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
  ROOT="$DIR"
  while [ "$ROOT" != "/" ] && [ ! -f "$ROOT/bin/plt" ]; do
    ROOT="$(dirname "$ROOT")"
  done
fi

if [ ! -f "$ROOT/bin/plt" ]; then
  echo "plt-resolve: cannot locate the punchlist-templates repo." >&2
  echo "Set PUNCHLIST_TEMPLATES_DIR to your checkout." >&2
  exit 1
fi

exec node "$ROOT/bin/plt" "$@"
