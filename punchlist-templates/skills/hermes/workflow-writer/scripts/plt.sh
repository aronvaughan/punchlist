#!/usr/bin/env bash
# Shim — the canonical resolver lives at skills/shared/plt-resolve.sh.
exec "$(dirname "$(readlink -f "$0")")/../../../shared/plt-resolve.sh" "$@"
