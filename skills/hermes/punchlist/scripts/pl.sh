#!/usr/bin/env bash
exec env PUNCHLIST_ENV_FILE="${HERMES_HOME:-$HOME/.hermes}/.env" "$(dirname "${BASH_SOURCE[0]}")/../../../shared/pl.sh" "$@"
