#!/usr/bin/env bash
# install-hooks.sh — writes the repo's git hooks.
#
#   pre-commit    runs the denylist scan on every commit (not just push): a committed client
#                 word is already in the history that scripts/publish.sh squashes to the public
#                 mirror, so the gate has to catch it at commit time.
#   post-merge    after a pull/merge changes the tree, rebuild the global install and restart
#                 the service (scripts/reinstall-local.sh --quiet).
#   post-checkout rebuilds the same way after a BRANCH switch (git passes flag=1), so the
#                 running daemon matches the branch you are on.
#
# Why post-merge/post-checkout exist: the service runs the globally installed package, NOT this
# checkout, so a pull changes nothing the daemon executes until the package is rebuilt. That gap
# is silent - source and behaviour simply disagree until someone notices.
#
# Because the denylist scripts live at the repo root (R3), git rev-parse --show-toplevel and the
# scripts' actual location agree here — no cross-boundary relative path is needed.
#
# Refuses (exit 1, printing the existing first line) to overwrite a pre-commit hook that isn't
# this one, so it never silently clobbers a hook someone else installed.
set -euo pipefail

MARKER='# installed by scripts/install-hooks.sh'
ROOT="$(git rev-parse --show-toplevel)"

# Refuses (exit 1, printing the existing first line) to overwrite a hook that isn't ours, so it
# never silently clobbers one someone else installed.
write_hook() { # name body
  local name="$1" body="$2" hook="$ROOT/.git/hooks/$1"
  if [ -e "$hook" ] && ! grep -qF "$MARKER" "$hook" 2>/dev/null; then
    echo "refused: $hook already exists and is not ours (first line: $(head -n 1 "$hook" 2>/dev/null))" >&2
    return 1
  fi
  printf '%s\n' '#!/usr/bin/env bash' "$MARKER" "$body" > "$hook"
  chmod +x "$hook"
  echo "installed: $hook"
}

write_hook pre-commit 'exec "$(git rev-parse --show-toplevel)/scripts/denylist-scan.sh" --staged'

write_hook post-merge 'exec "$(git rev-parse --show-toplevel)/scripts/reinstall-local.sh" --quiet'

# git passes: $1 prev HEAD, $2 new HEAD, $3 flag (1 = branch checkout, 0 = file checkout).
# Only a branch switch changes what the tree means; a `git checkout -- file` must not trigger it.
write_hook post-checkout '[ "$3" = 1 ] || exit 0
exec "$(git rev-parse --show-toplevel)/scripts/reinstall-local.sh" --quiet'
