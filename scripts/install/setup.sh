#!/usr/bin/env bash
# One-shot punchlist bootstrap for THIS machine (Linux or macOS). Detects the
# OS, installs prereqs, links the CLI, ensures data/.env, installs the always-on
# service, and runs the doctor. Idempotent — safe to re-run.
#
#   bash scripts/install/setup.sh                 # bootstrap (data/.env must exist)
#   bash scripts/install/setup.sh --init-tokens   # also create data/.env (aron+claude) if missing
#
# Everything OS-specific lives here (prereq install) or in the node CLI
# (systemd-vs-launchd service). pl.sh / plt are already portable.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

INIT_TOKENS=0
for a in "$@"; do case "$a" in --init-tokens) INIT_TOKENS=1 ;; *) echo "unknown flag: $a"; exit 2 ;; esac; done

case "$(uname -s)" in
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *) echo "unsupported OS: $(uname -s)"; exit 1 ;;
esac
echo "==> punchlist bootstrap ($PLATFORM) in $REPO"
need() { command -v "$1" >/dev/null 2>&1; }

# --- prereqs (machine-specific installs) ---
echo "--> prerequisites"
if [ "$PLATFORM" = macos ]; then
  need brew || { echo "  ! Homebrew required first: https://brew.sh"; exit 1; }
  need node     || brew install node
  need jq       || brew install jq
  need gtimeout || brew install coreutils        # gtimeout for the agent sweep
else
  need node || echo "  ! node missing — install node>=26 (nodesource/nvm/apt) and re-run"
  need jq   || { sudo apt-get install -y jq || sudo dnf install -y jq || true; }
fi
need claude    || echo "  ! claude CLI not on PATH (needed for the agent sweep — install & sign in)"
need tailscale || echo "  · tailscale not found (optional — for tailnet access)"

# node version gate
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "${NODE_MAJOR:-0}" -ge 26 ] || { echo "  ! node >= 26 required (found: $(node -v 2>/dev/null || echo none))"; exit 1; }

# --- CLI on PATH ---
echo "--> npm install + link"
npm install --silent
npm link 2>/dev/null || npm install -g . || echo "  ! could not link 'punchlist' onto PATH — add $REPO/bin to PATH manually"

# --- tokens / data/.env ---
ENVF="$REPO/data/.env"
if [ ! -f "$ENVF" ]; then
  if [ "$INIT_TOKENS" = 1 ]; then
    echo "--> generating data/.env (aron + claude)"
    mkdir -p "$REPO/data"
    ATOK="$(node bin/punchlist gen-token aron   | sed -n 's/^PUNCHLIST_TOKENS=aron://p')"
    CTOK="$(node bin/punchlist gen-token claude | sed -n 's/^PUNCHLIST_TOKENS=claude://p')"
    ( umask 177; printf 'PUNCHLIST_TOKENS=aron:%s,claude:%s\nPUNCHLIST_ADMIN=aron\n' "$ATOK" "$CTOK" > "$ENVF" )
    chmod 600 "$ENVF"
    echo "    created $ENVF (chmod 600)"
    echo "    → give the agent its client token: put 'PUNCHLIST_TOKEN=$CTOK' in ~/.claude/secrets.local.env (chmod 600)"
  else
    echo "  ! $ENVF missing — create it (chmod 600) or re-run with --init-tokens. Skipping service install."
    exit 1
  fi
fi

# --- always-on service (systemd on Linux, launchd on macOS) ---
echo "--> install-service"
node bin/punchlist install-service

# --- doctor ---
echo "--> doctor"
node bin/punchlist doctor || true

echo
echo "Bootstrap done. Next:"
echo "  · Web UI:  http://127.0.0.1:8600  (paste your token)"
echo "  · Schedule the agent sweep — see docs/macos-setup.md §6 (cron or launchd)"
echo "  · Tailnet access (optional): tailscale serve --bg --tcp 8600 tcp://127.0.0.1:8600"
