#!/usr/bin/env bash
# Install punchlist as an always-on service, cross-platform:
#   Linux  -> a systemd user unit (~/.config/systemd/user/punchlist.service)
#   macOS  -> a launchd LaunchAgent (~/Library/LaunchAgents/com.punchlist.plist)
# Both bind 127.0.0.1:8600 and restart on failure. Tokens come from data/.env
# (PUNCHLIST_TOKENS, chmod 600 — generate with `punchlist gen-token`, never in
# git). Tailnet exposure is separate (`tailscale serve --tcp 8600`).
#
# This is a thin wrapper over the portable node CLI so there is ONE source of
# truth for the unit contents (src/service.js).
#
#   bash scripts/install/setup-service.sh              # install + start
#   bash scripts/install/setup-service.sh --print      # show the unit, don't install
#   bash scripts/install/setup-service.sh --no-start   # write the unit, don't load
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
command -v node >/dev/null || { echo "node not installed (need >=26)"; exit 1; }
exec node "$REPO/bin/punchlist" install-service "$@"
