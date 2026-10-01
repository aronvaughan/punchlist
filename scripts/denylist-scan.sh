#!/usr/bin/env bash
# denylist-scan.sh — the shared gate behind the pre-commit hook (scripts/install-hooks.sh) and
# CI (.github/workflows/denylist.yml at the repo root). Runs the same three checks, in the
# same order, as scripts/publish.sh: (1) the path allowlist, (2) the denylist — extended by the
# private terms file — and (3) gitleaks over the range, when a range is given.
#
#   scripts/denylist-scan.sh --staged
#   scripts/denylist-scan.sh --tree
#   scripts/denylist-scan.sh --range <a>..<b>
#
# Exit 0 clean, 1 on a hit, 2 on a usage or configuration error.
#
# A hit is reported as "<file>:<line>: denylisted string" — the file and line, never the
# matched word, so this scan's own output (a CI log, a terminal) cannot leak the list.
set -euo pipefail

usage() { echo "usage: scripts/denylist-scan.sh [--staged|--tree|--range <a>..<b>]" >&2; }

MODE=""
RANGE_A=""
RANGE_B=""
case "${1:-}" in
  --staged) MODE=staged ;;
  --tree) MODE=tree ;;
  --range)
    MODE=range
    RANGE="${2:-}"
    [ -n "$RANGE" ] || { usage; exit 2; }
    case "$RANGE" in
      *..*) RANGE_A="${RANGE%%..*}"; RANGE_B="${RANGE##*..}" ;;
      *) echo "usage: scripts/denylist-scan.sh --range <a>..<b>" >&2; exit 2 ;;
    esac
    [ -n "$RANGE_A" ] && [ -n "$RANGE_B" ] || { echo "usage: scripts/denylist-scan.sh --range <a>..<b>" >&2; exit 2; }
    ;;
  *) usage; exit 2 ;;
esac

ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=./denylist-patterns.sh
source "$ROOT/scripts/denylist-patterns.sh"
cd "$ROOT"

TERMS="${LEAK_TERMS:-$HOME/.config/leak-scan/terms.txt}"
[ -f "$TERMS" ] || { echo "REFUSED — no terms file at $TERMS (one extended regex per line, mode 600)" >&2; exit 2; }
extra=$(terms_alternation "$TERMS")
# No terms means the scan proves nothing — in CI that is an unset LEAK_TERMS secret. Refuse, loudly.
[ -n "$extra" ] || { echo "REFUSED — the terms file at $TERMS has no terms (in CI: set the LEAK_TERMS repository secret)" >&2; exit 2; }
FULL_DENY="$DENY"
[ -z "$extra" ] || FULL_DENY="$FULL_DENY|$extra"

fail=0

case "$MODE" in
  staged) files=$(git diff --cached --name-only --diff-filter=ACMR) ;;
  tree) files=$(git ls-files) ;;
  range) files=$(git diff --name-only --diff-filter=ACMR "$RANGE_A".."$RANGE_B") ;;
esac

# 1. Path allowlist — anything outside these paths is private-plane or local state and must
#    never be staged/committed/pushed through this gate. PRIVATE_ALLOW paths are committable here
#    but never published (publish.sh drops them).
COMMIT_ALLOW="$ALLOW|$PRIVATE_ALLOW"
bad_paths=$(printf '%s\n' "$files" | sed '/^$/d' | grep -Ev "$COMMIT_ALLOW" || true)
if [ -n "$bad_paths" ]; then
  while IFS= read -r p; do echo "$p:0: outside the publishable paths"; done <<< "$bad_paths"
  fail=1
fi

# 2. Denylist — generic patterns plus the private terms file, over the files' actual content.
good_files=$(printf '%s\n' "$files" | sed '/^$/d' | grep -E "$COMMIT_ALLOW" || true)
if [ -n "$good_files" ]; then
  # A read loop, not mapfile: stock macOS /bin/bash is 3.2, which has no mapfile.
  grep_files=()
  while IFS= read -r f; do grep_files+=("$f"); done <<< "$good_files"
  # -z separates path, line number and content with NUL, so cut keeps the first two fields and
  # the content (the matched word) is dropped before anything is printed — in every mode, and
  # for a path that holds a colon. With a revision, git prefixes the path with "<rev>:".
  case "$MODE" in
    staged) hits=$( { git grep -z --cached -EIni "$FULL_DENY" -- "${grep_files[@]}" 2>/dev/null || true; } | tr '\0' '\t' | cut -f1,2) ;;
    tree) hits=$( { git grep -z -EIni "$FULL_DENY" -- "${grep_files[@]}" 2>/dev/null || true; } | tr '\0' '\t' | cut -f1,2) ;;
    range) hits=$( { git grep -z -EIni "$FULL_DENY" "$RANGE_B" -- "${grep_files[@]}" 2>/dev/null || true; } | tr '\0' '\t' | cut -f1,2) ;;
  esac
  if [ -n "$hits" ]; then
    while IFS="$(printf '\t')" read -r hit_file hit_line; do
      [ "$MODE" != range ] || hit_file="${hit_file#"$RANGE_B":}"
      echo "$hit_file:$hit_line: denylisted string"
    done <<< "$hits"
    fail=1
  fi
fi

# 3. gitleaks over the range — only when a range is given (CI). Required: a missing scanner
#    is a failed scan, never a silent pass.
if [ "$MODE" = "range" ]; then
  if command -v gitleaks >/dev/null 2>&1; then
    if ! gitleaks git . --log-opts="$RANGE_A..$RANGE_B" --no-banner --redact >/dev/null 2>&1; then
      echo "REFUSED — gitleaks found secrets in $RANGE_A..$RANGE_B"
      fail=1
    fi
  else
    echo "REFUSED — gitleaks is not installed (brew install gitleaks)"
    fail=1
  fi
fi

[ "$fail" -eq 0 ] || exit 1
exit 0
