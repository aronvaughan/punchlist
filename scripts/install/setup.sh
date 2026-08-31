#!/usr/bin/env bash
# One-shot punchlist bootstrap for THIS machine (Linux or macOS). Detects the
# OS, installs prereqs, links the CLI, ensures data/.env, installs the always-on
# service, and runs the doctor. Idempotent — safe to re-run.
#
#   bash scripts/install/setup.sh                 # bootstrap (data/.env must exist)
#   bash scripts/install/setup.sh --init-tokens   # also create data/.env (owner+claude) if missing
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
    echo "--> generating data/.env (owner + claude)"
    mkdir -p "$REPO/data"
    ATOK="$(node bin/punchlist gen-token owner   | sed -n 's/^PUNCHLIST_TOKENS=owner://p')"
    CTOK="$(node bin/punchlist gen-token claude | sed -n 's/^PUNCHLIST_TOKENS=claude://p')"
    ( umask 177; printf 'PUNCHLIST_TOKENS=owner:%s,claude:%s\nPUNCHLIST_ADMIN=owner\n' "$ATOK" "$CTOK" > "$ENVF" )
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

# --- agent provisioning: MCP tools + skills + governance guard ---
echo "--> agent provisioning (MCP + skills + governance)"
need claude && node bin/punchlist install -t claude || echo "  · claude CLI absent — skipping MCP registration (run 'punchlist install -t claude' later)"
node bin/punchlist install-skills          # punchlist + punchlist-govern skills, govern hook scripts
# plt (templates) skill, if the templates repo is a sibling checkout
PLT="${PUNCHLIST_TEMPLATES_DIR:-$REPO/punchlist-templates}"
[ -d "$PLT/skills" ] && { mkdir -p "$HOME/.claude/skills/punchlist-templates"; cp -r "$PLT/skills/." "$HOME/.claude/skills/punchlist-templates/" 2>/dev/null && echo "  installed plt skill"; } || echo "  · punchlist-templates not found — skipping plt skill"

# private data homes (the private plane) + the skills-local surface + terms list
mkdir -p "$REPO/data/skills" "$REPO/data/templates" "$REPO/data/kb" "$REPO/data/govern"
ln -sfn "$REPO/data/skills" "$HOME/.claude/skills-local"
[ -f "$REPO/data/govern/private-terms.txt" ] || { printf '# private client/company/personal identifiers, one per line — read by govern.sh, never published.\n' > "$REPO/data/govern/private-terms.txt"; chmod 600 "$REPO/data/govern/private-terms.txt"; }

# wire the warn-only governance guard into settings.json (idempotent) if jq is present
SETTINGS="$HOME/.claude/settings.json"
if command -v jq >/dev/null 2>&1 && [ -f "$SETTINGS" ]; then
  if ! jq -e '.hooks.PreToolUse[]?.hooks[]?.command | select(test("govern-hook"))' "$SETTINGS" >/dev/null 2>&1; then
    tmp="$(mktemp)"; jq '.hooks.PreToolUse = ((.hooks.PreToolUse // []) + [{
      "matcher":"Write|Edit|MultiEdit",
      "hooks":[{"type":"command","command":"if [ -f \"$HOME/.claude/hooks/punchlist-govern/govern-hook.sh\" ]; then bash \"$HOME/.claude/hooks/punchlist-govern/govern-hook.sh\" --warn; fi","timeout":10,"statusMessage":"punchlist-govern: checking artifact placement"}]
    }])' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS" && echo "  wired govern guard (warn-only) into settings.json"
  else echo "  · govern guard already wired in settings.json"; fi
else echo "  · skipped settings.json hook wiring (need jq + an existing settings.json)"; fi

# --- doctor ---
echo "--> doctor"
node bin/punchlist doctor || true

echo
echo "Bootstrap done. Next:"
echo "  · Web UI:  http://127.0.0.1:8600  (paste your token)"
echo "  · Schedule the agent sweep — see docs/macos-setup.md §6 (cron or launchd)"
echo "  · Tailnet access (optional): tailscale serve --bg --tcp 8600 tcp://127.0.0.1:8600"
