#!/usr/bin/env bash
# govern-hook.sh — PreToolUse (Write|Edit) guard wrapper for the data-governance
# rule. Reads the hook JSON on stdin, classifies the would-be write with
# govern.sh, and either WARNS (systemMessage, allows) or BLOCKS (permission deny).
#
#   govern-hook.sh --warn    # surface a warning, never block (rollout mode)
#   govern-hook.sh --block   # deny a private-content-in-publishable-path write
#
# Wire as a PreToolUse hook on Write|Edit. Never edits files; only inspects.
set -u
MODE="${1:---warn}"
GOVERN="$(cd "$(dirname "$0")" && pwd)/govern.sh"

command -v jq >/dev/null 2>&1 || exit 0        # no jq -> don't get in the way
IN="$(cat)"
FP="$(printf '%s' "$IN" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[ -n "$FP" ] || exit 0
CONTENT="$(printf '%s' "$IN" | jq -r '.tool_input.content // .tool_input.new_string // empty' 2>/dev/null)"

OUT="$(printf '%s' "$CONTENT" | bash "$GOVERN" classify "$FP" --stdin 2>&1)"
[ $? -eq 3 ] || exit 0                          # OK (0) or usage (2) -> allow silently

if [ "$MODE" = "--block" ]; then
  jq -n --arg r "punchlist-govern: $OUT" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
else
  jq -n --arg m "⚠ punchlist-govern (warn-only): $OUT" '{systemMessage:$m}'
fi
exit 0
