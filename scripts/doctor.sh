#!/usr/bin/env bash
# punchlist doctor — prerequisites + config + service + health checklist.
# Thin wrapper over the portable node CLI (`punchlist doctor`) so it works the
# same on Linux and macOS. Exits non-zero if a required check fails.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
command -v node >/dev/null || { echo "node not installed (need >=26)"; exit 1; }
exec node "$REPO/bin/punchlist" doctor "$@"
