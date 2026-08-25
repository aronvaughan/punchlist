#!/usr/bin/env bash
# Idempotent: run punchlist as a systemd user unit bound to 127.0.0.1:8600.
# Tokens come from data/.env (PUNCHLIST_TOKENS, chmod 600 — generated at
# deploy time, never in git). Tailnet exposure is handled separately via
# `tailscale serve --tcp 8600` (agentic-hermes2 scripts/install/setup-tailscale.sh).
#
#   bash scripts/install/setup-service.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
command -v node >/dev/null || { echo "node not installed"; exit 1; }
[ -f "$REPO/data/.env" ] || { echo "missing $REPO/data/.env (PUNCHLIST_TOKENS) — generate tokens first"; exit 1; }

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/punchlist.service" <<EOF
[Unit]
Description=punchlist task manager (127.0.0.1:8600)
After=network-online.target
StartLimitBurst=4

[Service]
Environment=PUNCHLIST_DATA=$REPO/data
WorkingDirectory=$REPO
ExecStart=$(command -v node) $REPO/src/server.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now punchlist.service
systemctl --user restart punchlist.service

for i in 1 2 3 4 5; do
  sleep 1
  if curl -sf --max-time 2 http://127.0.0.1:8600/api/v1/health >/dev/null; then
    echo "punchlist: healthy — $(curl -sf http://127.0.0.1:8600/api/v1/health)"
    exit 0
  fi
done
echo "punchlist: health check FAILED — journalctl --user -u punchlist.service -n 20" >&2
exit 1
