#!/usr/bin/env bash
# Publish the private repo (remote `origin`) to the public one (remote `public`).
#
# One squash commit per release, fast-forwarded onto public/master, tagged. Private history and
# commit messages never leave. Nothing reaches `public` unless every check below passes and you
# answer yes. The pre-push hook (scripts/pre-push) refuses any other push to `public`.
#
#   scripts/publish.sh <version> [--dry-run]     e.g. scripts/publish.sh v0.2.0
#
# Before running, write the release note at docs/releases/<version>.md (it is the commit message
# and the public changelog). The note is scanned too.
set -euo pipefail

VERSION="${1:-}"; DRY=0
[ -n "$VERSION" ] || { echo "usage: scripts/publish.sh <version> [--dry-run]"; exit 2; }
[ "${2:-}" = "--dry-run" ] && DRY=1
ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"
NOTE="docs/releases/$VERSION.md"
[ -f "$NOTE" ] || { echo "write the release note first: $NOTE"; exit 2; }
[ -z "$(git status --porcelain)" ] || { echo "worktree is dirty; commit or set the work aside first"; exit 2; }

git fetch -q origin; git fetch -q public
[ "$(git rev-parse master)" = "$(git rev-parse origin/master)" ] || { echo "master is not what origin (private) has — push or pull first, so the public release equals a private commit"; exit 1; }
git merge-base --is-ancestor public/master master || { echo "public/master is not an ancestor of master — public moved on its own; reconcile first"; exit 1; }

BRANCH="publish/$(date +%F)"
cleanup() { git reset -q --hard; git checkout -q master; git branch -q -D "$BRANCH"; }
git checkout -q -B "$BRANCH" public/master
git merge --squash -q master >/dev/null || true

fail=0
# 1. Only publishable paths. Anything outside this list is private-plane or local state.
#    ALLOW/DENY are shared with scripts/denylist-scan.sh via denylist-patterns.sh so the
#    pre-commit gate and this publish gate cannot drift.
source "$ROOT/scripts/denylist-patterns.sh"
# Private-plane root paths (PRIVATE_ALLOW: the CI workflows) are committed in the private repo and
# never published: drop them from the squash before the path check.
while IFS= read -r p; do
  [ -z "$p" ] || git rm -q -r -f --ignore-unmatch -- "$p"
done <<< "$(git diff --cached --name-only | grep -E "$PRIVATE_ALLOW" || true)"
bad_paths=$(git diff --cached --name-only --diff-filter=ACMR | grep -Ev "$ALLOW" || true)
[ -z "$bad_paths" ] || { echo "REFUSED — files outside the publishable paths:"; echo "$bad_paths" | sed 's/^/  /'; fail=1; }

# 2. Denylist. The script carries only generic patterns (hosted-tool URLs); the
#    names that identify a client, tenant or person live in a local terms file that is never
#    committed, so the gate cannot leak its own list. The file is required.
TERMS="${LEAK_TERMS:-$HOME/.config/leak-scan/terms.txt}"
[ -f "$TERMS" ] || { echo "REFUSED — no terms file at $TERMS (one extended regex per line, mode 600)"; cleanup; exit 1; }
extra=$(terms_alternation "$TERMS")
# No terms means the scan proves nothing — in CI that is an unset LEAK_TERMS secret. Refuse, loudly.
[ -n "$extra" ] || { echo "REFUSED — the terms file at $TERMS has no terms (in CI: set the LEAK_TERMS repository secret)" >&2; cleanup; exit 1; }
[ -z "$extra" ] || DENY="$DENY|$extra"
# A hit prints its file and line (for the note, the line) — never the matched text, so the terminal
# and any log never carry a private word. Same rule as denylist-scan.sh: -z separates path, line and
# content with NUL, and cut keeps only the first two fields.
hits=$( { git grep -z --cached -EIni "$DENY" -- . ':!docs/releases' || true; } | tr '\0' '\t' | cut -f1,2 | tr '\t' ':')
[ -z "$hits" ] || { echo "REFUSED — denylisted strings in the tree:"; echo "$hits" | sed 's/^/  /; s/$/: denylisted string/'; fail=1; }
note_hits=$( { git show ":$NOTE" | grep -Eni "$DENY" || true; } | cut -d: -f1)
[ -z "$note_hits" ] || { echo "REFUSED — denylisted strings in the release note:"; echo "$note_hits" | sed "s|^|  $NOTE:|; s/$/: denylisted string/"; fail=1; }

if [ "$fail" -ne 0 ]; then cleanup; exit 1; fi

git commit -q -F "$NOTE"
# 3. Secrets, scanned on the release commit itself (not the working directory, which holds
#    gitignored local state). gitleaks is required: a missing scanner is a failed scan.
if command -v gitleaks >/dev/null; then
  gitleaks git . --log-opts="public/master..HEAD" --no-banner --redact >/dev/null 2>&1 || { echo "REFUSED — gitleaks found secrets in the release commit"; cleanup; exit 1; }
else
  echo "REFUSED — gitleaks is not installed (brew install gitleaks)"; cleanup; exit 1
fi
echo; echo "== $VERSION: public/master $(git rev-parse --short public/master) -> $(git rev-parse --short HEAD)"; echo
git diff --stat public/master..HEAD | tail -n 25
echo
if [ "$DRY" -eq 1 ]; then
  echo "dry run — nothing pushed. Branch $BRANCH left for inspection; delete with: git branch -D $BRANCH"
  git checkout -q master; exit 0
fi
read -r -p "push to public/master and tag $VERSION? [y/N] " ans
[ "$ans" = "y" ] || { echo "not pushed. Branch $BRANCH left for inspection."; git checkout -q master; exit 0; }
git tag -a "$VERSION" -m "$VERSION"
PLT_PUBLISH=1 git push public "HEAD:master"
PLT_PUBLISH=1 git push public "$VERSION"
git checkout -q master; git branch -q -D "$BRANCH"
echo "published $VERSION"
