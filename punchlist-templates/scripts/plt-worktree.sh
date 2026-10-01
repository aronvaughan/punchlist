#!/usr/bin/env bash
# plt-worktree.sh <name> — per-window worktree. Two windows sharing
# one checkout have twice destroyed each other's uncommitted work here; the
# fix is structural — give each window its own worktree instead of a shared
# mutable checkout. Creates (or reuses) <repo>/.worktrees/<name> on branch
# window/<name> off master, installs deps if missing, and prints the
# worktree path on line 1 and the PLT_WINDOW export to paste on line 2.
#   scripts/plt-worktree.sh alice
set -euo pipefail

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "usage: plt-worktree.sh <name>" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKTREE="$REPO/.worktrees/$NAME"

if [ -d "$WORKTREE" ]; then
  echo "$WORKTREE"
  echo "export PLT_WINDOW=$NAME"
  exit 0
fi

git -C "$REPO" worktree add "$WORKTREE" -b "window/$NAME" master >&2

if [ -f "$WORKTREE/package.json" ] && [ ! -d "$WORKTREE/node_modules" ]; then
  npm ci --prefix "$WORKTREE" >&2
fi

echo "$WORKTREE"
echo "export PLT_WINDOW=$NAME"
