#!/usr/bin/env bash
exec env PUNCHLIST_ENV_FILE="$HOME/.claude/secrets.local.env" "$(dirname "${BASH_SOURCE[0]}")/../../../shared/pl.sh" "$@"
