#!/usr/bin/env bash
# herdr-window.sh — the herdr driver behind the spine's `windows.*` contract.
#
# lib/effort.js (launchWave) and lib/spine-cli.js (watchOnce) run whatever `windows.command`,
# `windows.open` and `windows.notify` name. This script is one implementation of that contract,
# so nothing in lib/spine.js knows herdr exists. A project opts in through its config:
#
#   windows:
#     command: "bash {templates}/scripts/herdr/herdr-window.sh open --effort {effort} --card {card} --cwd {path} --workspace-cwd {umbrella}"
#     open:    "bash {templates}/scripts/herdr/herdr-window.sh seed --pane {pane_id} --run {card} --cwd {path} --process-dir {process_dir}"
#     notify:  "bash {templates}/scripts/herdr/herdr-window.sh notify --text {text} --next {next}"
#
#   {templates} is this checkout, filled in by plt: config never carries a path. launchWave quotes
#   {templates} {path} {umbrella} {process_dir} and plt watch quotes {templates} {text} {next}, so
#   the templates leave them bare.
#
#   open    one workspace per effort (reused by label), one tab per card, the card's root pane
#           renamed <effort>/<card>. Prints {"workspace","tab","root_pane"} as JSON: launchWave
#           reads pane_id, tab_id and the pane label from it. The workspace opens in
#           --workspace-cwd (the umbrella), not in the first card's worktree.
#           Two racing opens for one effort can both create a workspace, because herdr has no
#           create-if-absent. launchWave opens a wave's cards one at a time, so only two concurrent
#           `plt effort launch` runs for one effort can hit the race. Recovery: `herdr workspace list`,
#           then `herdr workspace close <id>` on the workspace whose tabs the runs did not record.
#   seed    runs `cd <cwd> && export PLT_PROCESS_DIR=<dir> PLT_WINDOW=<pane> && plt prime --run <card>`
#           in the pane. PLT_WINDOW tells the spine's owner-window guard which window drives the run.
#           PLT_PROCESS_DIR is required. A card's pane sits in its worktree, and plt looks for
#           process/runs from its cwd. The runs live in the canonical checkout.
#   notify  a herdr notification: the change as the title, the next command as the body.
#
# Every failure exits non-zero with one line on stderr. launchWave records a window failure per
# card, and `plt effort launch` prints it, so a missing herdr costs the window, never the run.
# The script reads JSON with node, which plt already requires; jq is not a dependency here.
set -u

HERDR="${HERDR_BIN:-herdr}"
NODE="${NODE_BIN:-node}"

die() { echo "herdr-window: $*" >&2; exit "${2:-1}"; }
need_herdr() { command -v "$HERDR" >/dev/null 2>&1 || die "herdr is not on PATH (plt deps install herdr)"; }

# herdr prints {"id":…,"result":{…}}; some calls print the result bare. Evaluate a JS expression
# against the result object `r`, reading the JSON from stdin. Values go in through the environment,
# never spliced into the expression, so a label with a quote in it cannot change the code.
jget() {
  "$NODE" -e '
    let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
      let j; try { j = JSON.parse(d); } catch (e) { process.stderr.write("herdr-window: herdr did not print JSON\n"); process.exit(1); }
      if (j && j.error) { process.stderr.write("herdr-window: herdr error: " + JSON.stringify(j.error) + "\n"); process.exit(1); }
      const r = (j && j.result) || j;
      const v = (new Function("r", "return (" + process.argv[1] + ")"))(r);
      if (v === undefined || v === null) process.exit(3);
      process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
    });' "$1"
}

# Runs one herdr call and returns its stdout, or dies naming the call and herdr's own message.
# stderr is kept apart: a warning on a successful call must not reach the JSON reader.
# On failure the reason may be on either stream: an API error can arrive as {"error":…} on stdout.
# So the message takes stderr, else stdout, joined onto one line. `oneline` caps it at 400 bytes:
# a backtrace or a whole JSON document is noise in a one-line failure. LC_ALL=C: macOS tr aborts
# on a byte that is not valid UTF-8, which would cut the message at a Latin-1 filename.
oneline() { LC_ALL=C tr '\n' ' ' | LC_ALL=C sed 's/ *$//' | LC_ALL=C cut -c1-400; }
call() {
  local out err rc errf
  errf="$(mktemp "${TMPDIR:-/tmp}/herdr-window.XXXXXX")" || die "cannot create a temp file in ${TMPDIR:-/tmp}"
  out="$("$HERDR" "$@" 2>"$errf")"; rc=$?
  err="$(oneline <"$errf")"; rm -f "$errf"
  [ -n "$err" ] || err="$(printf '%s' "$out" | oneline)"
  [ "$rc" -eq 0 ] || die "herdr $1 $2 failed: ${err:-exit $rc}"
  printf '%s' "$out"
}

cmd_open() {
  local effort="" card="" cwd="" wscwd=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --effort)        effort="${2:-}"; shift 2 ;;
      --card)          card="${2:-}"; shift 2 ;;
      --cwd)           cwd="${2:-}"; shift 2 ;;
      --workspace-cwd) wscwd="${2:-}"; shift 2 ;;
      *) die "open: unknown argument: $1" 2 ;;
    esac
  done
  [ -n "$effort" ] && [ -n "$card" ] || die "open needs --effort and --card" 2
  [ -n "$wscwd" ] || wscwd="$cwd"
  local label="$effort/$card"
  need_herdr

  # Reuse the effort's workspace when one already carries its label: every card of a wave lands
  # in one workspace, whichever card opens first.
  # jget exits 3 when no workspace carries the label. Any other failure (not JSON, an {error})
  # stops here. A fall-through to create would break one workspace per effort.
  local list ws created rc
  list="$(call workspace list)" || exit 1
  ws="$(printf '%s' "$list" | EFFORT="$effort" jget '(r.workspaces || []).filter((w) => w.label === process.env.EFFORT).map((w) => w.workspace_id)[0]')"; rc=$?
  case "$rc" in 0) ;; 3) ws="" ;; *) exit 1 ;; esac
  if [ -z "$ws" ]; then
    created="$(call workspace create --label "$effort" ${wscwd:+--cwd "$wscwd"} --no-focus)" || exit 1
    ws="$(printf '%s' "$created" | jget 'r.workspace && r.workspace.workspace_id')" || die "workspace create returned no workspace_id"
  fi

  local tab pane
  tab="$(call tab create --workspace "$ws" --label "$card" ${cwd:+--cwd "$cwd"} --no-focus)" || exit 1
  pane="$(printf '%s' "$tab" | jget 'r.root_pane && r.root_pane.pane_id')" || die "tab create returned no root pane"
  call pane rename "$pane" "$label" >/dev/null || exit 1

  printf '%s' "$tab" | WS="$ws" EFFORT="$effort" LABEL="$label" jget \
    '({ workspace: { workspace_id: process.env.WS, label: process.env.EFFORT }, tab: r.tab, root_pane: Object.assign({}, r.root_pane, { label: process.env.LABEL }) })'
  echo
}

cmd_seed() {
  local pane="" run="" cwd="" pdir=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --pane)        pane="${2:-}"; shift 2 ;;
      --run)         run="${2:-}"; shift 2 ;;
      --cwd)         cwd="${2:-}"; shift 2 ;;
      --process-dir) pdir="${2:-}"; shift 2 ;;
      *) die "seed: unknown argument: $1" 2 ;;
    esac
  done
  [ -n "$pane" ] && [ -n "$run" ] || die "seed needs --pane and --run" 2
  need_herdr
  local line
  line="export ${pdir:+PLT_PROCESS_DIR=$(printf '%q' "$pdir") }PLT_WINDOW=$(printf '%q' "$pane") && plt prime --run $(printf '%q' "$run")"
  [ -n "$cwd" ] && line="cd $(printf '%q' "$cwd") && $line"
  call pane run "$pane" "$line" >/dev/null || exit 1
}

cmd_notify() {
  local text="" next=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --text) text="${2:-}"; shift 2 ;;
      --next) next="${2:-}"; shift 2 ;;
      *) die "notify: unknown argument: $1" 2 ;;
    esac
  done
  [ -n "$text" ] || die "notify needs --text" 2
  need_herdr
  call notification show "$text" ${next:+--body "$next"} >/dev/null || exit 1
}

sub="${1:-}"; [ $# -gt 0 ] && shift
case "$sub" in
  open)   cmd_open "$@" ;;
  seed)   cmd_seed "$@" ;;
  notify) cmd_notify "$@" ;;
  *) die "usage: herdr-window.sh open|seed|notify … (see the header of this script)" 2 ;;
esac
