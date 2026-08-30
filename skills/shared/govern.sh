#!/usr/bin/env bash
# govern.sh — punchlist DATA-GOVERNANCE guard (canonical: skills/shared/govern.sh).
#
# Enforces "private by default, publish deliberately." Every data artifact is
# either PUBLISHABLE (a tracked path in an open-source-safe repo — pl, templates
# packs, global ~/.claude skills) or PRIVATE (gitignored / under data/ — client
# OR personal; anything may go there). The one rule this guards:
#
#     NEVER let private content (secrets, client/company/personal identifiers)
#     land in a PUBLISHABLE path.
#
# The structural test is exact: a path that git would TRACK in one of these repos
# is publishable; a gitignored / non-repo path is private. So `data/` (gitignored)
# is always a safe home, and a tracked skill/template/kb file must be generic.
#
# Two entry points:
#   govern.sh classify <path> [--stdin | --content <file>]
#       Guard ONE write. Reads the would-be content (stdin, a file, or the path
#       itself) and checks it against the private markers when the path is
#       publishable. Exit: 0 = OK   3 = BLOCK   2 = usage.
#       Designed to be a PreToolUse hook on Write|Edit (see the punchlist-govern
#       skill) so it runs BEFORE any artifact write.
#   govern.sh audit [<root>...]
#       Read-only scan: for each root, check every TRACKED (publishable) file for
#       private markers and print a report. Never writes. Exit 0 always.
#
# Private markers = built-in secret regexes + a machine-local TERMS list
# ($GOVERN_TERMS, default $PUNCHLIST_DATA/govern/private-terms.txt — itself
# private, never published) holding client/company/personal identifiers.
set -u

DATA="${PUNCHLIST_DATA:-$HOME/code/punchlist/data}"
TERMS="${GOVERN_TERMS:-$DATA/govern/private-terms.txt}"

# secrets that must never reach a publishable path. High-signal ONLY — match real
# VALUES, not references. A bare `PUNCHLIST_TOKEN=` (the code that reads the var)
# or the word "password" is NOT a secret; an assigned long token IS. Generic
# password/identifier catching is left to the machine-local $GOVERN_TERMS list.
SECRET_RE='PUNCHLIST_TOKEN=["'\'']?[A-Za-z0-9+/_-]{24,}|-----BEGIN [A-Z ]*PRIVATE KEY|xox[baprs]-[0-9A-Za-z-]{10,}|ghp_[0-9A-Za-z]{20,}|AKIA[0-9A-Z]{16}'
# lines carrying these are examples/docs, not real secrets — never flag them
SECRET_ALLOW='EXAMPLE|process\.env|YourPassword|password123|SuperSecret|\$\{|\$\(|<[A-Za-z._-]+>|xxx+|\.\.\.'

# publishable? 0 = tracked in a repo (must be generic); 1 = gitignored / no repo
# (private — any content allowed). New/unadded files: check-ignore still answers.
is_publishable() {
  local p="$1" d
  d="$(cd "$(dirname "$p")" 2>/dev/null && pwd)" || return 1
  git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  git -C "$d" check-ignore -q "$p" && return 1   # gitignored -> private
  return 0                                        # tracked -> publishable
}

# grep content for private markers -> prints matches (empty = clean)
scan_content() { # scan_content <<<"$content"
  local content; content="$(cat)"
  # secrets: match real values, then drop known example/reference lines
  printf '%s' "$content" | grep -nE "$SECRET_RE" 2>/dev/null | grep -vE "$SECRET_ALLOW" 2>/dev/null
  if [ -s "$TERMS" ]; then
    # one term per line, blanks/# ignored; literal, case-insensitive
    printf '%s' "$content" | grep -niF -f <(grep -vE '^[[:space:]]*(#|$)' "$TERMS") 2>/dev/null
  fi
  return 0
}

classify() {
  [ $# -ge 1 ] || { echo "usage: govern.sh classify <path> [--stdin|--content <file>]" >&2; exit 2; }
  local path="$1"; shift
  local content=""
  case "${1:-}" in
    --stdin)   content="$(cat)" ;;
    --content) content="$(cat "$2" 2>/dev/null || true)" ;;
    "")        content="$(cat "$path" 2>/dev/null || true)" ;;  # scan the file on disk
    *) echo "govern: unknown flag $1" >&2; exit 2 ;;
  esac
  if ! is_publishable "$path"; then
    echo "OK  private path (gitignored/data) — any content allowed: $path"
    exit 0
  fi
  local hits; hits="$(printf '%s' "$content" | scan_content)"
  if [ -n "$hits" ]; then
    echo "BLOCK  private markers in a PUBLISHABLE path: $path" >&2
    printf '%s\n' "$hits" | sed 's/^/    /' >&2
    echo "  → write this under data/ (private), or remove the private content before publishing." >&2
    exit 3
  fi
  echo "OK  publishable path, no private markers: $path"
  exit 0
}

audit() {
  local roots=("$@"); [ ${#roots[@]} -gt 0 ] || roots=(".")
  local total=0 flagged=0
  [ -s "$TERMS" ] || echo "note: no private-terms list at $TERMS — scanning secrets only (add client/personal identifiers there to widen coverage)"
  for r in "${roots[@]}"; do
    [ -e "$r" ] || { echo "skip (missing): $r"; continue; }
    if ! git -C "$r" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      echo "skip (not a git repo, so nothing is publishable): $r"; continue
    fi
    echo "== $r =="
    # only TRACKED files are publishable; scan each for private markers
    while IFS= read -r f; do
      [ -f "$r/$f" ] || continue
      grep -Iq . "$r/$f" 2>/dev/null || continue   # skip binary files (images, .d.ts blobs)
      total=$((total+1))
      local hits; hits="$(scan_content < "$r/$f")"
      if [ -n "$hits" ]; then
        flagged=$((flagged+1))
        echo "  FLAG $f"
        printf '%s\n' "$hits" | sed 's/^/        /'
      fi
    done < <(git -C "$r" ls-files)
  done
  echo
  echo "audit: scanned $total tracked (publishable) files; $flagged flagged."
  [ "$flagged" -eq 0 ] && echo "audit: clean — no private markers in publishable paths."
}

cmd="${1:-}"; shift || true
case "$cmd" in
  classify) classify "$@" ;;
  audit)    audit "$@" ;;
  *) echo "usage: govern.sh classify <path> [--stdin|--content <file>] | audit [<root>...]" >&2; exit 2 ;;
esac
