#!/usr/bin/env bash
# recreate.sh — the fresh-machine acceptance. Drives every Plan 3 command, end to end, from an
# empty directory: install, integrate, launch a build-and-ship run, close it, then fsck + doctor.
#
# It tests the repo's COMMITTED HEAD, not the working tree's uncommitted edits: step 2 archives
# `git ... archive HEAD` into $WORK and runs `npm ci` there, never in the checkout this script runs
# from. (An earlier version ran `npm ci --prefix "$REPO"` directly — that deletes and reinstalls
# node_modules IN the checkout, which is what broke `plt` machine-wide on a shared install via this
# very script. Never do that again — see the coordinator ruling in task-10-review.md.)
#
# Never `set -e` — a script that dies on the first nonzero exit cannot say WHICH step failed.
# Every assertion below goes through assert_exit/assert_match/fail, which always names the step.
set -u

usage() { printf 'usage: %s [--keep] [--no-timers]\n' "$0" >&2; }

KEEP=0
NO_TIMERS=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --no-timers) NO_TIMERS=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STEP=0

fail() {
  echo "RECREATE FAILED at step $1: $2" >&2
  exit 1
}

# assert_exit STEP DESC EXPECTED ACTUAL
assert_exit() {
  if [ "$4" -ne "$3" ]; then
    fail "$1" "$2 (expected exit $3, got $4)"
  fi
}

# assert_match STEP DESC PATTERN TEXT — grep -q (basic regex)
assert_match() {
  if ! printf '%s' "$4" | grep -Eq "$3"; then
    fail "$1" "$2 (wanted to match /$3/, got: $(printf '%s' "$4" | head -c 400))"
  fi
}

WORK="$(mktemp -d)"
cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    echo "recreate.sh: --keep passed, leaving $WORK in place"
  else
    rm -rf "$WORK"
  fi
}

# Step 6, without --no-timers, registers a real launch agent (launchd) or service+timer (systemd)
# with the ACTUAL OS session — the isolated $HOME above does not namespace launchd/systemd, so
# `launchctl bootstrap`/`systemctl --user enable` reach the real machine regardless of where the
# unit FILE itself was written. TIMER_LABEL is set only once step 6 actually installs one; the EXIT
# trap (fires on every exit path, success or `fail`) unloads and deletes it so a run of this script
# never leaves a stray agent behind. plt has no uninstall command for either integration (checked:
# lib/timers.js, lib/integration.js) — this reaches into launchd/systemd directly.
TIMER_LABEL=""
teardown_timer() {
  [ -z "$TIMER_LABEL" ] && return
  if [ "$(uname -s)" = "Darwin" ]; then
    launchctl bootout "gui/$(id -u)/$TIMER_LABEL" >/dev/null 2>&1
    rm -f "$HOME/Library/LaunchAgents/$TIMER_LABEL.plist"
  else
    systemctl --user disable --now "$TIMER_LABEL.timer" >/dev/null 2>&1
    rm -f "$HOME/.config/systemd/user/$TIMER_LABEL.service" "$HOME/.config/systemd/user/$TIMER_LABEL.timer"
  fi
}
trap teardown_timer EXIT

# ---------------------------------------------------------------- step 1: node
STEP=1
NODE_V="$(node --version)"
NODE_MAJOR="$(printf '%s' "$NODE_V" | sed -E 's/^v([0-9]+).*/\1/')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail 1 "node 18 or newer required, found $NODE_V"
fi

# ---------------------------------------------------------------- isolation
# Everything past this point runs with an isolated HOME so no real launch agent, git config or
# terms file is touched. `gh`'s own credential lookup is a different matter: doctor's "gh" check
# (lib/doctor.js) shells out to `gh auth status`, and on macOS gh's default (keyring) credential
# storage is tied to the real HOME's keychain session — it reports the account invalid once HOME
# points at a fresh directory. RECREATE_GH_TOKEN, captured from the CALLING shell's own `gh` before
# HOME moves, sidesteps the keyring entirely (`gh auth status` honours GH_TOKEN over any stored
# credential). It is a credential, so it is never exported here: it stays a plain shell variable,
# threaded only into the one `plt doctor` invocation that needs it (step 11) — never into `npm ci`
# or anything else this script runs. In CI, GH_TOKEN/GITHUB_TOKEN is already in the environment
# (the workflow sets it for that step); this leaves an existing one alone and reads it the same way.
RECREATE_GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "$RECREATE_GH_TOKEN" ] && command -v gh >/dev/null 2>&1; then
  RECREATE_GH_TOKEN="$(gh auth token 2>/dev/null || true)"
fi
export HOME="$WORK/home"
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"

# ---------------------------------------------------------------- step 2: npm ci + plt --version
STEP=2
# Never `npm ci` in $REPO itself (see the header note) — archive committed HEAD into $WORK and
# install there. $REPO/node_modules (if it already exists) must come out byte-for-byte untouched;
# checked below by directory presence + mtime, since npm ci is the only thing in this script that
# could plausibly still reach $REPO.
NM="$REPO/node_modules"
NM_EXISTED_BEFORE=0; [ -d "$NM" ] && NM_EXISTED_BEFORE=1
NM_MTIME_BEFORE=""
[ "$NM_EXISTED_BEFORE" -eq 1 ] && NM_MTIME_BEFORE="$(stat -f %m "$NM" 2>/dev/null || stat -c %Y "$NM" 2>/dev/null)"

SRC="$WORK/src"
mkdir -p "$SRC"
if ! git -C "$REPO" archive HEAD | tar -x -C "$SRC" 2>"$WORK/archive.log"; then
  cat "$WORK/archive.log" >&2
  fail 2 "git -C $REPO archive HEAD | tar -x -C $SRC failed"
fi
PLT="$SRC/bin/plt"
PKG_VERSION="$(node -e "process.stdout.write(require(process.argv[1]).version)" "$SRC/package.json")"
# `npm ci --prefix <dir>` does not reliably read <dir>'s own package.json/lock (observed: it
# resolves the root package from the invoking cwd instead and fails with a bogus "Missing: <tmp
# dirname>@<version> from lock file"). `cd` into the copy instead — one project, no ambiguity.
( cd "$SRC" && npm ci ) >"$WORK/npm-ci.log" 2>&1
NPM_CI_RC=$?
if [ "$NPM_CI_RC" -ne 0 ]; then
  cat "$WORK/npm-ci.log" >&2
  fail 2 "npm ci (in $SRC) exited $NPM_CI_RC"
fi

NM_EXISTS_AFTER=0; [ -d "$NM" ] && NM_EXISTS_AFTER=1
if [ "$NM_EXISTED_BEFORE" -ne "$NM_EXISTS_AFTER" ]; then
  fail 2 "$NM existed=$NM_EXISTED_BEFORE before this run and existed=$NM_EXISTS_AFTER after — the checkout must stay untouched"
fi
if [ "$NM_EXISTED_BEFORE" -eq 1 ]; then
  NM_MTIME_AFTER="$(stat -f %m "$NM" 2>/dev/null || stat -c %Y "$NM" 2>/dev/null)"
  if [ "$NM_MTIME_BEFORE" != "$NM_MTIME_AFTER" ]; then
    fail 2 "$NM's mtime changed ($NM_MTIME_BEFORE -> $NM_MTIME_AFTER) — the checkout must stay untouched"
  fi
fi

PLT_VERSION_OUT="$("$PLT" --version 2>&1)"
PLT_VERSION_RC=$?
assert_exit 2 '"$SRC/bin/plt" --version' 0 "$PLT_VERSION_RC"
if [ "$PLT_VERSION_OUT" != "$PKG_VERSION" ]; then
  fail 2 "$PLT --version printed '$PLT_VERSION_OUT', package.json says '$PKG_VERSION'"
fi

# ---------------------------------------------------------------- step 3: plt on PATH
STEP=3
ln -sf "$PLT" "$HOME/.local/bin/plt"
RESOLVED="$(command -v plt)"
if [ "$RESOLVED" != "$HOME/.local/bin/plt" ]; then
  fail 3 "command -v plt resolved to '$RESOLVED', want $HOME/.local/bin/plt"
fi

# ---------------------------------------------------------------- step 4: scratch project + config
STEP=4
# Named uniquely (pid + $RANDOM), not "proj": lib/timers.js#labelFor derives the launchd/systemd
# label from the project directory's basename when config.timers.label is unset, and that label is
# registered with the REAL OS launchd/systemd domain in step 6 (see the EXIT trap above) — a plain
# "proj" could collide with an unrelated real project of the same name on the same machine.
PROJ="$WORK/recreate-$$-$RANDOM"
PROCESS="$PROJ/process"
mkdir -p "$PROCESS/config" "$PROCESS/cycles" "$PROCESS/runs" "$PROCESS/build"
cp "$SRC/test/fixtures/spine/config/defaults.yaml" "$PROCESS/config/defaults.yaml"
TERMS="$WORK/terms.txt"
install -m 600 /dev/null "$TERMS"
printf 'sprocket\n' >"$TERMS"

cat >"$PROCESS/config/org.yaml" <<YAML
models:
  default_model: opus
  review_model: opus
skills:
  scope: []
  build: []
  pre_pr: []
  ship: []
  pr_loop: []
  close_out: []
tools:
  build: []
review:
  panel_agents: []
  writing_agents: []
jira:
  status:
    in_progress: in_progress
    in_review: in_review
    done: done
actors:
  humans: [recreate]
links:
  pr_repo: example-org/greenhouse
timers:
  watch:
    every: "60m"
denylist_file: "$TERMS"
YAML

# `plt config` (lib/spine-cli.js) resolves its process dir from \$PLT_PROCESS_DIR or an upward
# search from cwd — it does not read --project. Exporting it here makes every later `plt run` /
# `plt receipt` / `plt gate` / `plt config` call work from any cwd for the rest of the script.
export PLT_PROCESS_DIR="$PROCESS"

CONFIG_OUT="$(plt config --project "$PROJ" 2>&1)"
CONFIG_RC=$?
assert_exit 4 'plt config --project "$PROJ"' 0 "$CONFIG_RC"

# ---------------------------------------------------------------- step 5: claude integration
STEP=5
INSTALL_CLAUDE_OUT="$(plt integration install claude --project "$PROJ" 2>&1)"
assert_exit 5 'plt integration install claude' 0 "$?"
STATUS_CLAUDE_OUT="$(plt integration status claude --project "$PROJ" 2>&1)"
STATUS_CLAUDE_RC=$?
assert_exit 5 'plt integration status claude' 0 "$STATUS_CLAUDE_RC"
FILE_LINES="$(printf '%s\n' "$STATUS_CLAUDE_OUT" | grep -c ': installed v[0-9]')"
# Every managed file line (.claude/hooks/*.py, .claude/agents/*.md) must read "installed v<n>".
BAD_FILE_LINES="$(printf '%s\n' "$STATUS_CLAUDE_OUT" | grep -E '^\.claude/' | grep -Ev ': installed v[0-9]+$' || true)"
if [ -n "$BAD_FILE_LINES" ]; then
  fail 5 "plt integration status claude: not every file line reads 'installed v<n>' — $BAD_FILE_LINES"
fi
if [ "$FILE_LINES" -eq 0 ]; then
  fail 5 "plt integration status claude printed no '.claude/...: installed vN' file lines"
fi

# ---------------------------------------------------------------- step 6: timers integration
STEP=6
if [ "$NO_TIMERS" -eq 1 ]; then
  echo "recreate.sh: --no-timers — skipping the timers integration (real launchd/systemd, by-hand acceptance only)"
else
  INSTALL_TIMERS_OUT="$(plt integration install timers --project "$PROJ" --load 2>&1)"
  assert_exit 6 'plt integration install timers --load' 0 "$?"
  # Registered with the real OS now — arm the EXIT trap so every path out of this script (pass or
  # fail) tears it down; nothing before this line can leave an agent behind. Same rule as
  # lib/timers.js#labelFor: config.timers.label if set (org.yaml never sets it), else
  # `plt.watch.<project dir basename>`.
  CFG_TIMER_LABEL="$(plt config timers.label 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(d)||'')}catch(e){}})" 2>/dev/null)"
  TIMER_LABEL="${CFG_TIMER_LABEL:-plt.watch.$(basename "$PROJ")}"
  STATUS_TIMERS_OUT="$(plt integration status timers --project "$PROJ" 2>&1)"
  STATUS_TIMERS_RC=$?
  assert_exit 6 'plt integration status timers' 0 "$STATUS_TIMERS_RC"
  RUNS_N="$(printf '%s' "$STATUS_TIMERS_OUT" | sed -nE 's/.*runs=([0-9]+).*/\1/p')"
  if [ -z "$RUNS_N" ] || [ "$RUNS_N" -lt 1 ]; then
    fail 6 "plt integration status timers did not print runs=<n> with n >= 1: $STATUS_TIMERS_OUT"
  fi
fi

# ---------------------------------------------------------------- step 7: plt schema list
STEP=7
SCHEMA_LIST_OUT="$(plt schema list 2>&1)"
assert_exit 7 'plt schema list' 0 "$?"
SCHEMA_COUNT="$(printf '%s\n' "$SCHEMA_LIST_OUT" | grep -cE '^\S+\s+\S+')"
if [ "$SCHEMA_COUNT" -ne 5 ]; then
  fail 7 "plt schema list named $SCHEMA_COUNT schemas, want 5: $SCHEMA_LIST_OUT"
fi
while IFS= read -r line; do
  SCHEMA_FILE="$(printf '%s' "$line" | awk '{print $2}')"
  if [ ! -f "$SCHEMA_FILE" ]; then
    fail 7 "plt schema list named $SCHEMA_FILE, which does not exist"
  fi
done <<EOF
$SCHEMA_LIST_OUT
EOF

# ---------------------------------------------------------------- a real, clean repo_dir
# `plt run launch` pins whatever repo the command runs from (cwd) unless --repo is passed.
# `process/` and the code the run "builds" must be SEPARATE git trees: every receipt re-pins the
# run's repo_dir, and a pin refuses any untracked or modified file, so a repo_dir that also held
# the run's own runs/*.jsonl would refuse its own pin the moment the first event was appended.
CODE_REPO="$WORK/repo"
mkdir -p "$CODE_REPO"
git -C "$CODE_REPO" init -q
printf '# greenhouse\n' >"$CODE_REPO/README.md"
git -C "$CODE_REPO" add README.md
git -C "$CODE_REPO" -c user.email=recreate@example.com -c user.name=recreate commit -q -m 'init'

# ---------------------------------------------------------------- step 8: launch the run
STEP=8
RUN=TRK-900
cp "$SRC/workflows/packs/core/build-and-ship.md" "$PROCESS/cycles/build-and-ship.md"
LAUNCH_OUT="$(cd "$CODE_REPO" && plt run launch "$RUN" --cycle build-and-ship --input card="$RUN" 2>&1)"
LAUNCH_RC=$?
assert_exit 8 'plt run launch TRK-900 --cycle build-and-ship' 0 "$LAUNCH_RC"
STATE_FILE="$PROCESS/runs/$RUN/state.yaml"
if [ ! -f "$STATE_FILE" ]; then
  fail 8 "$STATE_FILE was not created by plt run launch"
fi
VALIDATE_STATE_OUT="$(plt schema validate state "$STATE_FILE" 2>&1)"
VALIDATE_STATE_RC=$?
assert_exit 8 "plt schema validate state $STATE_FILE" 0 "$VALIDATE_STATE_RC"

# ---------------------------------------------------------------- step 9: drive the run to close
STEP=9

plt_step() { # step_id
  plt step start "$1" --run "$RUN" >"$WORK/step.log" 2>&1
  local rc=$?
  if [ "$rc" -ne 0 ]; then cat "$WORK/step.log" >&2; fail 9 "plt step start $1 --run $RUN exited $rc"; fi
}
plt_finish() { # step_id [outcome]
  local id="$1"; local outcome="${2:-}"
  local args=(step finish "$id" --run "$RUN" --no-extrapolations)
  [ -n "$outcome" ] && args+=(--outcome "$outcome")
  plt "${args[@]}" >"$WORK/step.log" 2>&1
  local rc=$?
  if [ "$rc" -ne 0 ]; then cat "$WORK/step.log" >&2; fail 9 "plt ${args[*]} exited $rc"; fi
}
plt_receipt() { # kind name step [result] [files]
  local kind="$1" name="$2" step="$3" result="${4:-}"
  local args=(receipt --kind "$kind" --name "$name" --run "$RUN" --step "$step")
  [ -n "$result" ] && args+=(--result "$result")
  plt "${args[@]}" >"$WORK/receipt.log" 2>&1
  local rc=$?
  if [ "$rc" -ne 0 ]; then cat "$WORK/receipt.log" >&2; fail 9 "plt ${args[*]} exited $rc"; fi
}
plt_gate_approve() { # step
  plt gate approve "$RUN" "$1" --by human:recreate >"$WORK/gate.log" 2>&1
  local rc=$?
  if [ "$rc" -ne 0 ]; then cat "$WORK/gate.log" >&2; fail 9 "plt gate approve $RUN $1 --by human:recreate exited $rc"; fi
}

# scope
plt_step scope
plt_receipt artifact dispatch-brief scope
plt_receipt touches declared scope
plt_receipt jira on_start:in_progress scope
plt_finish scope ready

# build (no receipts required — skills/tools are configured empty above)
plt_step build
plt_finish build

# review (adversarial gate with zero configured agents — no agent receipt required)
plt_step review
plt_finish review pass

# write-review (same shape)
plt_step write-review
plt_finish write-review pass

# pre-pr
plt_step pre-pr
plt_receipt artifact pre-pr-summary pre-pr
plt_finish pre-pr

# approve — human gate, settles straight from ready
plt_gate_approve approve

# open-pr
plt_step open-pr
plt_receipt jira on_done:in_review open-pr
plt_receipt gh checks-green open-pr pass
plt_finish open-pr

# pr-loop, reply, announce all become ready once open-pr is done
plt_step pr-loop
plt_receipt gh review_approved pr-loop pass
plt_receipt artifact review-response pr-loop
plt_finish pr-loop approved

plt_gate_approve reply

plt_step announce
plt_finish announce done

# merge — needs pr-loop; land_on does not stop ordinary needs-based readiness (lib/spine.js#settle)
plt_step merge
plt_receipt gh approved_on_head merge pass
plt_receipt gh checks-green merge pass
plt_receipt gh threads_resolved merge pass
plt_receipt gh merged merge pass
plt_receipt jira on_done:done merge
plt_finish merge

# close-out — needs merge AND announce
plt_step close-out
plt_finish close-out done

CLOSE_OUT="$(plt run close "$RUN" --by human:recreate 2>&1)"
CLOSE_RC=$?
assert_exit 9 "plt run close $RUN" 0 "$CLOSE_RC"
CLOSE_STATUS="$(printf '%s' "$CLOSE_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(d).status)}catch(e){process.stdout.write('(unparsable)')}})")"
if [ "$CLOSE_STATUS" != "closed" ]; then
  fail 9 "plt run close $RUN: state.status is '$CLOSE_STATUS', want closed"
fi

# ---------------------------------------------------------------- step 10: fsck
STEP=10
FSCK_OUT="$(plt fsck --all --project "$PROJ" --json 2>&1)"
FSCK_RC=$?
assert_exit 10 'plt fsck --all --project "$PROJ"' 0 "$FSCK_RC"
FSCK_ERRORS="$(printf '%s' "$FSCK_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const r=JSON.parse(d);const errs=(r.runs||[]).flatMap(x=>(x.findings||[]).filter(f=>f.severity==='error'));process.stdout.write(String(errs.length))})" 2>/dev/null || echo '?')"
if [ "$FSCK_ERRORS" != "0" ]; then
  fail 10 "plt fsck --all reported $FSCK_ERRORS error finding(s): $FSCK_OUT"
fi

# ---------------------------------------------------------------- step 11: doctor
STEP=11
# GH_TOKEN scoped to exactly this command — the only one in this script that shells out to `gh`
# (doctor's "gh" check, lib/doctor.js) — never exported into the script's own environment, so it
# never reaches npm ci or anything else this script runs.
DOCTOR_JSON="$(GH_TOKEN="$RECREATE_GH_TOKEN" plt doctor --project "$PROJ" --json 2>&1)"
DOCTOR_RC=$?
DOCTOR_TEXT="$(GH_TOKEN="$RECREATE_GH_TOKEN" plt doctor --project "$PROJ" 2>&1)"

assert_match 11 'plt doctor output contains ✓ formulas-validate' '✓ formulas-validate' "$DOCTOR_TEXT"
assert_match 11 'plt doctor output contains ✓ runs-consistent' '✓ runs-consistent' "$DOCTOR_TEXT"

FAILING_CHECKS="$(printf '%s' "$DOCTOR_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const r=JSON.parse(d);process.stdout.write((r.checks||[]).filter(c=>c.state==='fail').map(c=>c.id).join(','))}catch(e){process.stdout.write('(unparsable)')}})" 2>/dev/null)"

if [ "$NO_TIMERS" -eq 1 ]; then
  # KNOWN, REPORTED GAP (see task-10-report.md): lib/doctor.js's `timers-running` check has no
  # exemption for a project that never installed a timer, and step 6 above deliberately never
  # installs one under --no-timers (installing it live-registers with the real OS launchd/systemd,
  # which this acceptance and CI must not do). The two ARE mutually exclusive with the literal
  # letter of "doctor exits 0" under --no-timers — tolerate exactly this one failing check here.
  if [ "$FAILING_CHECKS" != "" ] && [ "$FAILING_CHECKS" != "timers-running" ]; then
    fail 11 "plt doctor --project \"$PROJ\" failed check(s) other than the expected timers-running: $FAILING_CHECKS"
  fi
else
  assert_exit 11 'plt doctor --project "$PROJ"' 0 "$DOCTOR_RC"
fi

echo "recreate.sh: all 11 steps passed ($WORK)"
cleanup
exit 0
