#!/usr/bin/env bash
# pane-state.sh — the spine step state → herdr pane state map, and the call that reports it on a
# pane.
#
#   pane-state.sh <step-state>
#       prints "<herdr-state> <icon>" for one spine step state. Exit 2 on an unknown state.
#   pane-state.sh report --pane <pane_id> --state <step-state> [--step <id>] [--run <run>]
#       reports the mapped state on the pane: herdr pane report-agent … --message "<icon> …".
#
# No caller yet. `plt watch` reads each run's whole state on every pass, so it can call `report`
# for every pane and correct any drift. A report at each step transition is the other way. The
# change that adds a caller chooses between them.
#
# The map is total over the step states lib/spine.js writes, so the icon on a pane can never
# disagree with the spine. `done` and `skipped` report as herdr `idle`. `herdr pane report-agent`
# accepts only idle, working, blocked and unknown; herdr derives `done` itself. `herdr --skill`
# (0.9.3) says "`idle` and `done` both mean the agent is ready for input". The icon keeps them apart.
set -u

HERDR="${HERDR_BIN:-herdr}"

map() {
  case "$1" in
    pending)     echo "idle ○" ;;
    ready)       echo "idle ◔" ;;
    in_progress) echo "working ●" ;;
    in_review)   echo "working ◑" ;;
    blocked)     echo "blocked ⚠" ;;
    done)        echo "idle ✓" ;;
    skipped)     echo "idle ⊘" ;;
    repeated)    echo "working ↻" ;;
    *) return 2 ;;
  esac
}

die() { echo "pane-state: $*" >&2; exit "${2:-1}"; }

if [ "${1:-}" != report ]; then
  [ $# -eq 1 ] || die "usage: pane-state.sh <step-state> | pane-state.sh report --pane <id> --state <step-state> [--step <id>] [--run <run>]" 2
  map "$1" || die "unknown step state: $1 (want pending|ready|in_progress|in_review|blocked|done|skipped|repeated)" 2
  exit 0
fi

shift
pane="" state="" step="" run=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pane)  pane="${2:-}"; shift 2 ;;
    --state) state="${2:-}"; shift 2 ;;
    --step)  step="${2:-}"; shift 2 ;;
    --run)   run="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done
[ -n "$pane" ] && [ -n "$state" ] || die "report needs --pane and --state" 2
mapped="$(map "$state")" || die "unknown step state: $state" 2
herdr_state="${mapped%% *}"
icon="${mapped#* }"
message="$icon ${run:+$run }${step:-$state}"

command -v "$HERDR" >/dev/null 2>&1 || die "herdr is not on PATH (plt deps install herdr)"
exec "$HERDR" pane report-agent "$pane" --source plt --agent plt --state "$herdr_state" --message "$message"
