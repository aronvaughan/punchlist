#!/usr/bin/env bash
# install-hooks.sh — writes an executable .git/hooks/pre-commit that runs the denylist scan on
# every commit (not just push): a committed client word is already in the history that
# scripts/publish.sh squashes to the public mirror, so the gate has to catch it at commit time.
#
# Because the denylist scripts live at the repo root (R3), git rev-parse --show-toplevel and the
# scripts' actual location agree here — no cross-boundary relative path is needed.
#
# Refuses (exit 1, printing the existing first line) to overwrite a pre-commit hook that isn't
# this one, so it never silently clobbers a hook someone else installed.
set -euo pipefail

MARKER='# installed by scripts/install-hooks.sh — denylist pre-commit gate'
ROOT="$(git rev-parse --show-toplevel)"
HOOK="$ROOT/.git/hooks/pre-commit"

if [ -e "$HOOK" ]; then
  first_line=$(head -n 1 "$HOOK" 2>/dev/null || true)
  if ! grep -qF "$MARKER" "$HOOK" 2>/dev/null; then
    echo "refused: $HOOK already exists and is not ours (first line: $first_line)" >&2
    exit 1
  fi
fi

cat > "$HOOK" <<HOOK_EOF
#!/usr/bin/env bash
$MARKER
exec "\$(git rev-parse --show-toplevel)/scripts/denylist-scan.sh" --staged
HOOK_EOF
chmod +x "$HOOK"
echo "installed: $HOOK"
