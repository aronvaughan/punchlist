#!/usr/bin/env bash
# reinstall-local.sh — rebuild this checkout into the GLOBAL npm install and
# restart the service, so the daemon actually runs what the working tree says.
#
#   scripts/reinstall-local.sh [--force] [--no-restart] [--quiet]
#
# The service does NOT run this checkout. It runs the package installed at
# <npm prefix>/lib/node_modules/@aronvaughan/punchlist, so a pull or an edit
# changes nothing until the package is rebuilt — a gap that is invisible
# until behaviour and source disagree. This closes it: pack, install, restart.
#
#   --force       restart even while a task is in_progress (default: defer,
#                 via `punchlist safe-restart`, which leaves agent work alone)
#   --no-restart  install only; the running service keeps serving the old code
#   --quiet       print only on change or error (for the post-merge hook)
#
# Packing (rather than `npm i -g .`) is deliberate: npm SYMLINKS a local
# directory install, which would make the daemon follow whatever is checked
# out — including a half-finished branch. A tarball is an immutable copy, and
# it exercises package.json `files`, so a packaging mistake fails here rather
# than on someone else's machine.
set -euo pipefail

FORCE=0; RESTART=1; QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force)      FORCE=1; shift ;;
    --no-restart) RESTART=0; shift ;;
    --quiet)      QUIET=1; shift ;;
    -h|--help)    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "reinstall-local: unknown flag $1 (see --help)" >&2; exit 2 ;;
  esac
done
say() { [ "$QUIET" = 1 ] || echo "$@"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The service is pinned to a node >= 26 (node:sqlite DatabaseSync). A PATH
# that leads with an older node — nvm is the usual culprit — would pack and
# install fine and then fail at runtime, so resolve a good node up front and
# use it for every step.
NODE=""
for cand in "$(command -v node || true)" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  [ -n "$cand" ] && [ -x "$cand" ] || continue
  if [ "$("$cand" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)" -ge 26 ]; then
    NODE="$cand"; break
  fi
done
if [ -z "$NODE" ]; then
  echo "reinstall-local: no node >= 26 found (punchlist needs node:sqlite DatabaseSync)" >&2
  echo "  install one, e.g. brew install node@26" >&2
  exit 1
fi
# npm's shebang is `#!/usr/bin/env node`, so npm runs under whatever node
# PATH finds first - not necessarily $NODE. Put $NODE's directory in front so
# pack/install run on the same runtime the service will use.
export PATH="$(dirname "$NODE"):$PATH"
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM="$(command -v npm)"

# Skip the whole dance when the installed package already matches this tree.
# The hook runs on every merge; a no-op merge should cost nothing.
INSTALLED_DIR="$("$NPM" root -g 2>/dev/null)/@aronvaughan/punchlist"
tree_rev="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
stamp="$INSTALLED_DIR/.installed-from"
if [ "$FORCE" = 0 ] && [ -f "$stamp" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$tree_rev" ] \
   && [ -z "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
  say "reinstall-local: global install already at $tree_rev with a clean tree — nothing to do"
  exit 0
fi

health() { curl -sf -m 2 http://127.0.0.1:8600/api/v1/health 2>/dev/null || true; }
field() { "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s)["'"$1"'"]??""))}catch{}})' 2>/dev/null || true; }
build_before="$(health | field build)"

say "== packing $ROOT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TARBALL="$(cd "$ROOT" && "$NPM" pack --pack-destination "$TMP" 2>/dev/null | tail -1)"
[ -n "$TARBALL" ] && [ -f "$TMP/$TARBALL" ] || { echo "reinstall-local: npm pack produced nothing" >&2; exit 1; }

say "== installing $TARBALL globally"
"$NPM" i -g "$TMP/$TARBALL" >/dev/null
printf '%s\n' "$tree_rev" > "$stamp" 2>/dev/null || true

if [ "$RESTART" = 0 ]; then
  say "== --no-restart: the service is still running the PREVIOUS code"
  exit 0
fi

# safe-restart defers while a task is in_progress, so an agent mid-task is not
# cut off; --force is the explicit override.
# request-restart QUEUES the restart; safe-restart APPLIES it once no task is
# in_progress. safe-restart alone is a no-op ("no restart pending"), which is
# how this script first appeared to work while never restarting anything.
say "== restarting"
"$NODE" "$INSTALLED_DIR/bin/punchlist" request-restart "reinstall-local: $tree_rev" >/dev/null || true
if [ "$FORCE" = 1 ]; then
  "$NODE" "$INSTALLED_DIR/bin/punchlist" safe-restart --force || true
else
  "$NODE" "$INSTALLED_DIR/bin/punchlist" safe-restart || true
fi

# Confirm the thing that actually matters: the LIVE service reports the
# version we just built. An install that silently kept serving the old code
# is the exact failure this script exists to prevent.
want="$("$NODE" -e 'process.stdout.write(require("'"$ROOT"'/package.json").version)')"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  h="$(health)"
  got="$(printf '%s' "$h" | field version)"
  build_now="$(printf '%s' "$h" | field build)"
  if [ "$got" = "$want" ] && [ -n "$build_now" ] && [ "$build_now" != "$build_before" ]; then
    say "== live: $got (build $build_now)"
    exit 0
  fi
  sleep 1
done
if [ "$got" = "$want" ] && [ "$build_now" = "$build_before" ]; then
  echo "reinstall-local: installed $want, but the service did NOT restart (build still $build_before)." >&2
  echo "  a task is probably in_progress and the restart is deferred - check: punchlist restart-status" >&2
  echo "  re-run with --force to restart anyway." >&2
else
  echo "reinstall-local: service is not reporting $want (got '${got:-no response}')" >&2
fi
exit 1
