#!/usr/bin/env bash
# Shim — the canonical scaffolder lives at skills/shared/wf-scaffold.sh.
exec "$(dirname "$(readlink -f "$0")")/../../../shared/wf-scaffold.sh" "$@"
