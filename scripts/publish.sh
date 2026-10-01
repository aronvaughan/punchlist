#!/usr/bin/env bash
# Publish the private repo (remote `origin`) to the public one (remote `public`).
#
# Each run pushes one commit to public/master: a snapshot of the private tree at one commit, less
# the private-plane paths. Private history and commit messages never leave. Nothing reaches
# `public` unless every check below passes and you answer yes. The pre-push hook
# (scripts/pre-push) refuses any other push to `public`.
#
#   scripts/publish.sh <version> [--at <sha>] [--message <file>] [--no-tag] [--dry-run]
#
#   --at <sha>        publish the tree at <sha> (default: master). <sha> must be a first-parent
#                     commit of origin/master, so every public commit is a state master was in.
#   --message <file>  the commit message (default: docs/releases/<version>.md in the tree at
#                     <sha>). It is scanned like the tree.
#   --no-tag          push the commit and make no tag.
#   --dry-run         build and check the commit on a local branch; push nothing.
#
# One release, one run: write the release note at docs/releases/<version>.md (it is the commit
# message and the public changelog), then run `scripts/publish.sh <version>`.
#
# One release, several bundles: publish the private history as a series of commits, oldest
# first. Each bundle is its own run, and each run builds on the public/master the run before it
# pushed. Give every bundle but the last `--no-tag`; the last one carries the tag:
#
#   scripts/publish.sh v1.1.0 --at <sha1> --message <bundle-1-message> --no-tag
#   scripts/publish.sh v1.1.0 --at <sha2> --message <bundle-2-message> --no-tag
#   scripts/publish.sh v1.1.0 --at <sha3>
#
# An edit made on public itself survives the bundles. Take it into private first, with a merge of
# public/master on master that keeps public's version of each path public changed. A bundle cut
# before that merge then carries those paths, so it does not revert the edit on public.
set -euo pipefail

usage() { echo "usage: scripts/publish.sh <version> [--at <sha>] [--message <file>] [--no-tag] [--dry-run]" >&2; exit 2; }
VERSION="${1:-}"
case "$VERSION" in ''|-*) usage ;; esac
shift
DRY=0; TAG=1; AT=master; MSG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --no-tag) TAG=0 ;;
    --at) [ -n "${2:-}" ] || usage; AT="$2"; shift ;;
    --message) [ -n "${2:-}" ] || usage; MSG="$2"; shift ;;
    *) usage ;;
  esac
  shift
done
# A relative --message path is relative to where the script was started, not to the repo root.
MSG_LABEL="$MSG"
case "$MSG" in ''|/*) ;; *) MSG="$PWD/$MSG" ;; esac

ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "REFUSED — the worktree is dirty. Commit the work, or set it aside with: git stash -u"; exit 2; }

# The patterns come from this checkout, read before the checkout of the tree at <sha>. An older
# tree carries an older PRIVATE_ALLOW, which would let through a path that is private today.
# scripts/denylist-scan.sh reads the same file, so the pre-commit gate and this gate cannot drift.
source "$ROOT/scripts/denylist-patterns.sh"
# An empty exception pattern matches every path; read it as "no exceptions".
[ -n "${PRIVATE_EXCEPT:-}" ] || PRIVATE_EXCEPT='^$'
# Path lists are read unquoted: git quotes a non-ASCII path by default ("caf\303\251.md"), and a
# quoted path would not match the anchored patterns.
g() { git -c core.quotePath=false "$@"; }
# private_paths — the stdin paths that a publish drops: PRIVATE_ALLOW, less PRIVATE_EXCEPT. The
# drop (below) and the check on public/master both use it, so they cannot disagree.
private_paths() { { grep -E "$PRIVATE_ALLOW" || true; } | { grep -Ev "$PRIVATE_EXCEPT" || true; }; }

# The terms file, required. The patterns file carries only generic patterns (hosted-tool URLs).
# The names that identify a client, tenant or person live in a local terms file. That file is
# never committed, so the gate cannot leak its own list.
TERMS="${LEAK_TERMS:-$HOME/.config/leak-scan/terms.txt}"
[ -f "$TERMS" ] || { echo "REFUSED — no terms file at $TERMS. Create it with install -m 600 /dev/null $TERMS, then add one term per line"; exit 1; }
extra=$(terms_alternation "$TERMS")
# No terms means the scan proves nothing — in CI that is an unset LEAK_TERMS secret. Refuse, loudly.
[ -n "$extra" ] || { echo "REFUSED — the terms file at $TERMS has no terms. Add one term per line (in CI: set the LEAK_TERMS repository secret)" >&2; exit 1; }
DENY="$DENY|$extra"

git fetch -q origin; git fetch -q public
[ "$(git rev-parse master)" = "$(git rev-parse origin/master)" ] || { echo "REFUSED — master is not what origin (private) has, so the public commit might not be a private one. Run git pull origin master if origin is ahead, or git push origin master if master is ahead"; exit 1; }
[ "$TAG" -eq 0 ] || ! git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null || { echo "REFUSED — tag $VERSION already exists here. If it is left from a failed run, delete it: git tag -d $VERSION. If it is published, pick a new version."; exit 1; }
AT_SHA=$(git rev-parse --verify -q "$AT^{commit}") || { echo "REFUSED — --at $AT is not a commit. Pick one from: git log --first-parent --oneline origin/master"; exit 1; }
# A first-parent commit, not only an ancestor. The check on public/master below walks first
# parents to find the previous bundle. A bundle taken from a merged branch would stop the next one.
# grep reads all of the rev-list output (no -q). If grep exits early, rev-list dies on a broken
# pipe, and pipefail then reads a found commit as a missing one.
git rev-list --first-parent origin/master | grep -x "$AT_SHA" >/dev/null || { echo "REFUSED — $AT is not a first-parent commit of origin/master. A public commit must be a state master was in. Pick one from: git log --first-parent --oneline origin/master (if $AT is not on origin yet: git push origin master)"; exit 1; }

# bundle_listing <rev> [<carry>] — one "<mode> <type> <object>\t<path>" line per path that a
# publish of <rev> keeps, sorted. <carry> (see carry below) replaces or deletes paths first. Two
# equal listings publish the same tree.
bundle_listing() {
  local all
  # Each first file starts with an empty line so it is never empty: with an empty first file, awk
  # would read stdin as that file and print nothing.
  all=$(g ls-tree -r "$1" | awk -F'\t' '
    NR == FNR { if ($0 != "") { if ($1 == "-") del[$2] = 1; else put[$2] = $0 }; next }
    $2 in put { print put[$2]; delete put[$2]; next }
    !($2 in del) { print }
    END { for (p in put) print put[p] }' <(echo; printf '%s\n' "${2:-}") -)
  printf '%s\n' "$all" | drop_private | LC_ALL=C sort
}
# drop_private — the stdin ls-tree lines, less the private-plane paths.
drop_private() {
  local l
  l=$(cat)
  printf '%s\n' "$l" | awk -F'\t' 'NR == FNR { drop[$0] = 1; next } !($2 in drop)' \
    <(echo; printf '%s\n' "$l" | cut -f2 | private_paths) -
}

# Public's own edits. Someone can commit to public directly. Private takes such an edit with a
# reconcile merge: a first-parent commit of origin/master that brings public history in. Public
# history is the merge base of a merged parent and public/master, and the merge brings it in when the first
# parent does not have it yet. The merge can be of public/master itself or of a branch that merged
# it. A bundle cut before that merge does not have the edit, so a plain snapshot would revert it on
# public. The bundle carries the edit instead.
# RECONCILE: one "<merge> <public base>" line per reconcile merge, oldest first.
RECONCILE=""
for m in $(git rev-list --first-parent --merges --reverse origin/master); do
  for p in $(git rev-parse "$m^@" | tail -n +2); do
    b=$(git merge-base "$p" public/master) || continue
    if ! git merge-base --is-ancestor "$b" "$m^1"; then RECONCILE="$RECONCILE$m $b"$'\n'; break; fi
  done
done
# reconcile_after <rev> — the RECONCILE lines for the merges after <rev>, oldest first.
reconcile_after() {
  local m b
  while read -r m b; do
    [ -n "$m" ] || continue
    [ "$m" = "$1" ] || ! git merge-base --is-ancestor "$1" "$m" || echo "$m $b"
  done <<< "$RECONCILE"
}
# taken <merge> <public base> — "<merge>\t<path>" for each path the merge took from public. Such a
# path differs from the merge's first parent, and the merge has the public base's version of it.
# A path that a merged branch changed any other way is a private change, not a public edit.
taken() {
  local p
  LC_ALL=C comm -23 <(g diff --name-only --no-renames "$1^1" "$1" | LC_ALL=C sort) \
    <(g diff --name-only --no-renames "$2" "$1" | LC_ALL=C sort) | while IFS= read -r p; do
      # A deletion is public's only when public's history once had the path. Otherwise the merged
      # branch deleted a private file.
      if [ -z "$(g ls-tree "$1" -- "$p")" ] && [ -z "$(git rev-list -1 "$2" -- "$p")" ]; then continue; fi
      printf '%s\t%s\n' "$1" "$p"
    done
}
# carry <rev> — the carry for a bundle cut at <rev>. It prints one line for each path that a
# reconcile merge after <rev> took from public. The line is the path's ls-tree line in the last
# merge that took it, or "-\t<path>" when that merge deleted it. It returns 1 when a private
# commit between <rev> and that merge also changes the path, and prints
# "<path>\t<commit>\t<merge>". The bundle would then have to mix the two edits, and the script
# does not guess how. With a second argument "loose" it takes the merge's version anyway. Public
# holds its edit whatever private did meanwhile, so that is the tree to compare public with.
carry() {
  local after m b pairs=""
  after=$(reconcile_after "$1")
  [ -n "$after" ] || return 0
  while read -r m b; do pairs="$pairs$(taken "$m" "$b")"$'\n'; done <<< "$after"
  # The log gives each path each first-parent commit after <rev> changes against its first parent,
  # oldest first. A change is public's when the pair is in the taken list, and private otherwise.
  g log --first-parent --diff-merges=first-parent --no-renames --name-only --reverse --format='%x01%H' "$1..origin/master" \
    | awk -F'\t' -v loose="${2:-}" '
      NR == FNR { if ($0 != "") took[$0] = 1; next }
      /^\001/ { c = substr($0, 2); i++; next }
      NF == 0 { next }
      (c "\t" $0) in took { last[$0] = c; lastpos[$0] = i; next }
      !($0 in priv) { priv[$0] = c; privpos[$0] = i }
      END {
        bad = 0
        if (loose == "") for (p in last) if ((p in priv) && privpos[p] < lastpos[p]) { print p "\t" priv[p] "\t" last[p]; bad = 1 }
        if (bad) exit 1
        for (p in last) print "+\t" p "\t" last[p]
      }' <(echo; printf '%s' "$pairs") - | {
      local out="" rc=0 kind p m line
      while IFS=$'\t' read -r kind p m; do
        if [ "$kind" != "+" ]; then rc=1; out="$out$kind"$'\t'"$p"$'\t'"$m"$'\n'; continue; fi
        line=$(g ls-tree "$m" -- "$p")
        [ -n "$line" ] || line="-"$'\t'"$p"
        out="$out$line"$'\n'
      done
      printf '%s' "$out"; return "$rc"
    }
}

# public/master is safe to build on when public has not moved on its own. There are two safe
# cases, and anything else is refused, because the snapshot would overwrite it.
#   (a) It is a private commit at or below <sha>.
#   (b) Its tree is what this script publishes for a first-parent commit at or below <sha>: that
#       commit's snapshot and carry. The previous bundle is one such tree. So is a public/master
#       that private merges later: its private base plus the edits the merge takes from public.
#       The tree match does not need public's history to be part of private's, so it still holds
#       after public's history is rewritten. A cut older than public's private base matches nothing.
# A commit made on public that private never merged, or a bundle out of order, fails both.
CARRY=""; PREV=""
if ! git merge-base --is-ancestor public/master "$AT_SHA"; then
  # Unmerged, the script compares public whole. A snapshot never holds a private path, so a
  # private path on public means someone committed it there, and the next snapshot would delete it.
  # Merged, that is an ancestor of origin/master but not a first-parent commit of it, the script
  # compares public less its private-plane paths. Private has seen them at the merge, and every bundle
  # drops them.
  merged=0
  if git merge-base --is-ancestor public/master origin/master && ! git rev-list --first-parent origin/master | grep -x "$(git rev-parse public/master)" >/dev/null; then merged=1; fi
  want=$(g ls-tree -r public/master | LC_ALL=C sort)
  [ "$merged" -eq 0 ] || want=$(printf '%s\n' "$want" | drop_private)
  for c in $(git rev-list --first-parent "$AT_SHA" ^public/master); do
    cc=$(carry "$c" loose)
    [ "$(bundle_listing "$c" "$cc")" != "$want" ] || { PREV="$c"; break; }
  done
  if [ -z "$PREV" ] && [ "$merged" -eq 1 ]; then
    echo "REFUSED — private merges public/master after $AT. No first-parent commit at or before $AT gives public's tree with the edits that the merges took from public. Publish at or after the merge of public/master. The usual causes: (1) $AT is older than public's private base, so this bundle would roll public back. (2) Private took public's edits outside a merge (a cherry-pick), or the merge did not take them. (3) Public deleted a path after a rewrite of its history removed the path's past."; exit 1
  fi
  [ -n "$PREV" ] || { echo "REFUSED — public/master is neither an ancestor of $AT nor the bundle of a first-parent ancestor of it. Public moved on its own, or this bundle is out of order. If public has commits that private lacks: (1) git merge -s ours --no-commit public/master (add --allow-unrelated-histories if public's history was rewritten). (2) git checkout public/master -- <each path public changed>, then git commit. (3) git push origin master. (4) Publish again: a bundle cut before that merge carries what it took from public. If this bundle is out of order, publish a later commit."; exit 1; }
  CARRY=$(carry "$AT_SHA") || {
    echo "REFUSED — a private commit changes a path between $AT and the merge that takes public's version of that path. The bundle cannot carry public's edit without mixing the two. Publish with --at at or after the private commit:"
    printf '%s\n' "$CARRY" | awk -F'\t' 'NF == 3 { printf "  %s: changed in %s, taken from public in %s\n", $1, substr($2, 1, 7), substr($3, 1, 7) }'
    exit 1
  }
  # A carried path that is private-plane is an edit that public made to a private path. Every
  # bundle drops the path, so public would lose the edit. A carried deletion loses nothing.
  carried_private=$(printf '%s\n' "$CARRY" | awk -F'\t' '$1 != "-" { print $2 }' | private_paths)
  [ -z "$carried_private" ] || { echo "REFUSED — a merge after $AT took public's edits to private-plane paths. Every bundle drops these paths, so public would lose the edits. Move the content out of the private-plane paths on master, or remove it from public, then publish again:"; printf '%s\n' "$carried_private" | sed 's/^/  /'; exit 1; }
  echo "public/master is the bundle of private $(git rev-parse --short "$PREV"); this bundle builds on it"
  [ -z "$CARRY" ] || { echo "this bundle carries public's own edits, as the merges after $AT took them:"; printf '%s\n' "$CARRY" | cut -f2 | sed 's/^/  /'; }
  # Merged, the match left out the private-plane paths public still holds. The bundle deletes them
  # from public, so say so before the diff.
  if [ "$merged" -eq 1 ]; then
    n=$(g ls-tree -r --name-only public/master | private_paths | wc -l | tr -d ' ')
    [ "$n" -eq 0 ] || echo "this bundle removes the $n private-plane path(s) that public still holds"
  fi
fi

BRANCH="publish/$(date +%F)"
ON_BRANCH=0
cleanup() { ON_BRANCH=0; git reset -q --hard; git checkout -q master; git branch -q -D "$BRANCH"; }
# A failed run leaves master checked out and deletes the publish branch. That covers a refusal and
# also a git command that fails under set -e. A gitleaks refusal keeps the branch (see step 3). The
# message copy is removed on every exit.
MSG_TMP=$(mktemp "${TMPDIR:-/tmp}/publish-msg.XXXXXX")
on_exit() { rc=$?; rm -f "$MSG_TMP"; if [ "$rc" -ne 0 ] && [ "$ON_BRANCH" -eq 1 ]; then cleanup; fi; }
trap on_exit EXIT

# The message is copied out before the checkout. The checkout would replace a --message file
# inside the repo. The default note is read from the tree at <sha>, not from this checkout.
NOTE="docs/releases/$VERSION.md"
if [ -n "$MSG" ]; then
  [ -f "$MSG" ] || { echo "REFUSED — no message file at $MSG_LABEL. Write the bundle's commit message there, or leave out --message to use $NOTE"; exit 2; }
  cp "$MSG" "$MSG_TMP"
else
  MSG_LABEL="$NOTE"
  git show "$AT_SHA:$NOTE" > "$MSG_TMP" 2>/dev/null || { echo "REFUSED — the tree at $AT has no release note. Write and commit $NOTE, or pass --message <file>"; exit 2; }
fi

git checkout -q -B "$BRANCH" public/master
ON_BRANCH=1
# The snapshot: the index and the worktree become the tree at <sha>, whatever public/master held.
git read-tree -u --reset "$AT_SHA"
# The carry: each path a later reconcile merge took from public, as that merge has it.
while IFS=$'\t' read -r meta p; do
  [ -n "$meta" ] || continue
  if [ "$meta" = "-" ]; then
    git rm -q -f --ignore-unmatch -- "$p"
  else
    printf '%s\t%s\n' "$meta" "$p" | git update-index --index-info
    git checkout-index -f -- "$p"
  fi
done <<< "$CARRY"

fail=0
# 1. Only publishable paths. Anything outside this list is private-plane or local state.
# Private-plane paths (PRIVATE_ALLOW, less PRIVATE_EXCEPT) are committed in the private repo and
# never published: drop them from the snapshot before the path check.
while IFS= read -r p; do
  [ -z "$p" ] || git rm -q -r -f --ignore-unmatch -- "$p"
done <<< "$(g ls-files | private_paths)"
bad_paths=$(g diff --cached --name-only --diff-filter=ACMR public/master | grep -Ev "$ALLOW" || true)
[ -z "$bad_paths" ] || { echo "REFUSED — files outside the publishable paths. Remove them on master and publish a later commit, or add them to ALLOW or PRIVATE_ALLOW in scripts/denylist-patterns.sh:"; echo "$bad_paths" | sed 's/^/  /'; fail=1; }

# 2. Denylist, over the tree and the message. The tree scan covers every release note, so a note
# is scanned even when --message replaces it. The note that is the message is left to the
# message scan, so its lines are named once.
# A hit prints its file and line, never the matched text. The terminal and any log then never
# carry a private word. Same rule as denylist-scan.sh: -z separates path, line and content with a
# zero byte, and cut keeps only the first two fields.
skip=(); [ -n "$MSG" ] || skip=(":!$NOTE")
hits=$( { git grep -z --cached -EIni "$DENY" -- . "${skip[@]+"${skip[@]}"}" || true; } | tr '\0' '\t' | cut -f1,2 | tr '\t' ':')
[ -z "$hits" ] || { echo "REFUSED — denylisted strings in the tree. Fix these lines on master, push to origin, and publish again with --at at the fixed commit:"; echo "$hits" | sed 's/^/  /; s/$/: denylisted string/'; fail=1; }
msg_hits=$( { grep -Eni "$DENY" "$MSG_TMP" || true; } | cut -d: -f1)
[ -z "$msg_hits" ] || { echo "REFUSED — denylisted strings in the commit message. Fix these lines and publish again:"; echo "$msg_hits" | sed "s|^|  $MSG_LABEL:|; s/$/: denylisted string/"; fail=1; }

[ "$fail" -eq 0 ] || exit 1
git diff --cached --quiet public/master && { echo "REFUSED — nothing to publish: the tree at $AT is what public/master already holds. Pick a later commit for --at."; exit 1; }

git commit -q -F "$MSG_TMP"
# The tree check, whenever public/master is not an ancestor of <sha>. It reads trees only: the
# commit, the snapshot at <sha>, public/master as compared above, and the snapshot at PREV (public's
# private base). So a wrong or missing carry cannot pass it.
#   new:     every path of the commit is as the snapshot at <sha> has it, or as public/master has
#            it. A missing path counts as a value. Nothing comes from anywhere else.
#   revert:  public loses no edit of its own. Where public differs from the snapshot at PREV,
#            public (or a carry) edited the path. If private leaves the path as PREV had it up to
#            <sha>, the commit must keep public's version.
if [ -n "$PREV" ]; then
  tree_bad=$(awk -F'\t' '
    FILENAME == ARGV[1] { t[$2] = $1; all[$2] = 1; next }
    FILENAME == ARGV[2] { s[$2] = $1; all[$2] = 1; next }
    FILENAME == ARGV[3] { p[$2] = $1; all[$2] = 1; next }
    FILENAME == ARGV[4] { b[$2] = $1; next }
    END {
      for (f in all) {
        if (t[f] != s[f] && t[f] != p[f]) print "  " f ": in neither the tree at --at nor public/master"
        else if (p[f] != b[f] && s[f] == b[f] && t[f] != p[f]) print "  " f ": would revert an edit made on public"
      }
    }' <(g ls-tree -r HEAD) <(bundle_listing "$AT_SHA") <(printf '%s\n' "$want") <(bundle_listing "$PREV"))
  [ -z "$tree_bad" ] || { echo "REFUSED — the bundle's tree fails the check against the tree at $AT and public/master. Nothing was pushed. Publish with --at at or after the merge of public/master. If private took public's edit with a cherry-pick, make the merge that docs/releases/README.md describes, then publish at or after it:"; printf '%s\n' "$tree_bad" | LC_ALL=C sort; exit 1; }
fi
# 3. Secrets, scanned on the commit itself (not the working directory, which holds gitignored
#    local state). gitleaks is required: a missing scanner is a failed scan.
if command -v gitleaks >/dev/null; then
  if ! gitleaks git . --log-opts="public/master..HEAD" --no-banner --redact >/dev/null 2>&1; then
    # The branch is kept, so the finding can be read on exactly the commit the gate scanned.
    ON_BRANCH=0; git checkout -q master
    echo "REFUSED — gitleaks found secrets in the publish commit. Branch $BRANCH is kept; see them with: gitleaks git . --log-opts=public/master..$BRANCH --redact, then delete it: git branch -D $BRANCH"
    exit 1
  fi
else
  echo "REFUSED — gitleaks is not installed. Run: brew install gitleaks"; exit 1
fi
what="$VERSION"; [ "$TAG" -eq 1 ] || what="$VERSION bundle, no tag"
echo; echo "== $what: private $(git rev-parse --short "$AT_SHA") as public/master $(git rev-parse --short public/master) -> $(git rev-parse --short HEAD)"; echo
git diff --stat public/master..HEAD | tail -n 25
echo
if [ "$DRY" -eq 1 ]; then
  echo "dry run — nothing pushed. Branch $BRANCH left for inspection; delete with: git branch -D $BRANCH"
  ON_BRANCH=0; git checkout -q master; exit 0
fi
if [ "$TAG" -eq 1 ]; then ask="push to public/master and tag $VERSION?"; else ask="push to public/master without a tag?"; fi
read -r -p "$ask [y/N] " ans
[ "$ans" = "y" ] || { echo "not pushed. Branch $BRANCH left for inspection."; ON_BRANCH=0; git checkout -q master; exit 0; }
# The tag is made only after the commit is on public, so a failed push leaves no local tag behind
# to block the next run.
PLT_PUBLISH=1 git push public "HEAD:master" || { echo "REFUSED — the push to public/master failed; nothing was published. Fix the cause above and run this command again."; exit 1; }
if [ "$TAG" -eq 1 ]; then
  git tag -a "$VERSION" -m "$VERSION" || { echo "REFUSED — public/master is pushed, but tag $VERSION could not be made. Make and push it: git tag -a $VERSION -m $VERSION $(git rev-parse HEAD) && PLT_PUBLISH=1 git push public $VERSION"; exit 1; }
  PLT_PUBLISH=1 git push public "$VERSION" || { echo "REFUSED — public/master is pushed, but tag $VERSION is not. Push it: PLT_PUBLISH=1 git push public $VERSION"; exit 1; }
fi
ON_BRANCH=0; git checkout -q master; git branch -q -D "$BRANCH"
if [ "$TAG" -eq 1 ]; then echo "published $VERSION"; else echo "published a $VERSION bundle (no tag)"; fi
