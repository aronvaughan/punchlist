#!/usr/bin/env bash
# pl.sh — punchlist CLI for agents (canonical copy: skills/shared/pl.sh).
#
# Subcommands:
#   pl.sh add "title" [--project X] [--due YYYY-MM-DD] [--due-time HH:MM]
#                     [--when YYYY-MM-DD|someday] [--tags a,b]
#                     [--assignee <actor>] [--notes N]
#                     [--steps "a;b;c"] [--auto-close]
#   pl.sh quickadd "text"              server-side token parsing (#tag @project ...)
#   pl.sh list [view] [--project P] [--tag T] [--assignee A] [--window N] [--limit N] [--q S]
#              views: inbox today upcoming overdue due_soon logbook review delegated
#   pl.sh queue                        open work assigned to ME (active + in_progress,
#                                      vetted only — server-side view=queue)
#   pl.sh show <id>                    one task, full JSON
#   pl.sh claim <id>                   active -> in_progress (assignee only, vetted only)
#   pl.sh finish <id> "report"         -> review (or done if auto_close); report required
#   pl.sh complete <id>                human-style done (the owner's own tasks)
#   pl.sh approve <id>                 review -> done (admin actor only)
#   pl.sh vet <id>                     mark an unvetted task safe for agents (admin only)
#   pl.sh update <id> [--title T] [--notes N] [--project P] [--due D] [--due-time HH:MM]
#                    [--when W|someday|none] [--assignee A] [--status active|archived]
#                    [--tags a,b] [--auto-close 0|1]
#   pl.sh projects                     list projects
#   pl.sh counts                       nav counts (inbox/today/review/delegated...)
#
# Auth: Bearer $PUNCHLIST_TOKEN. Base URL: $PUNCHLIST_URL (default 127.0.0.1:8600).
# NEVER print the token.
set -u

BASE="${PUNCHLIST_URL:-http://127.0.0.1:8600}"
API="$BASE/api/v1"

# --- token resolution ---
# 1. $PUNCHLIST_TOKEN in the environment (canonical).
# 2. $PUNCHLIST_ENV_FILE — a KEY=value file to read PUNCHLIST_TOKEN from. The
#    per-agent shim sets this so each agent authenticates as ITSELF even on a
#    machine where several agents (and their secrets files) coexist.
# 3. Conventions, as a last resort: ~/.claude/secrets.local.env (Claude Code),
#    then $HERMES_HOME/.env (Hermes).
# Never echo/log the token — it is only ever passed to curl via a variable.
read_env_token() { # read_env_token FILE -> token on stdout (trimmed, unquoted)
  sed -n 's/^PUNCHLIST_TOKEN=//p' "$1" | head -n1 \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^["'\'']//' -e 's/["'\'']$//'
}
if [ -z "${PUNCHLIST_TOKEN:-}" ] && [ -n "${PUNCHLIST_ENV_FILE:-}" ] && [ -r "$PUNCHLIST_ENV_FILE" ]; then
  PUNCHLIST_TOKEN=$(read_env_token "$PUNCHLIST_ENV_FILE")
fi
if [ -z "${PUNCHLIST_TOKEN:-}" ] && [ -r "$HOME/.claude/secrets.local.env" ]; then
  PUNCHLIST_TOKEN=$(read_env_token "$HOME/.claude/secrets.local.env")
fi
if [ -z "${PUNCHLIST_TOKEN:-}" ] && [ -n "${HERMES_HOME:-}" ] && [ -r "$HERMES_HOME/.env" ]; then
  PUNCHLIST_TOKEN=$(read_env_token "$HERMES_HOME/.env")
fi
TOKEN="${PUNCHLIST_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  echo "pl: PUNCHLIST_TOKEN is not set (export it, or put PUNCHLIST_TOKEN=... in ~/.claude/secrets.local.env or \$HERMES_HOME/.env)" >&2
  exit 1
fi

command -v jq >/dev/null 2>&1 || { echo "pl: jq is required" >&2; exit 1; }

RESP=""
api() { # api METHOD PATH [json-body] -> sets RESP, exits on error
  local method="$1" path="$2" body="${3:-}" out code
  if [ -n "$body" ]; then
    out=$(curl -sS --max-time 15 -w $'\n%{http_code}' -X "$method" "$API$path" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "$body" 2>&1) || { echo "pl: cannot reach $BASE ($out)" >&2; exit 1; }
  else
    out=$(curl -sS --max-time 15 -w $'\n%{http_code}' -X "$method" "$API$path" \
      -H "Authorization: Bearer $TOKEN" 2>&1) || { echo "pl: cannot reach $BASE ($out)" >&2; exit 1; }
  fi
  code="${out##*$'\n'}"
  RESP="${out%$'\n'*}"
  case "$code" in
    2*) ;;
    *) echo "pl: HTTP $code — $(printf '%s' "$RESP" | jq -r '.error // .' 2>/dev/null || printf '%s' "$RESP")" >&2
       exit 1 ;;
  esac
}

uri() { jq -rn --arg v "$1" '$v|@uri'; }

# one-task-per-line formatter: id  title  chips
ROWFMT='
  def chips:
    [ (if (.vetted // 1) == 0 then "[UNVETTED]" else empty end),
      (if .status != "active" then "[" + .status + "]" else empty end),
      ("@" + .assignee),
      (if .due_date then "due:" + .due_date + (if .due_time then "T" + .due_time else "" end) else empty end),
      (if .when_type == "someday" then "someday"
       elif .when_type == "date" then "when:" + .when_date else empty end),
      ((.tags // [])[] | "#" + .),
      (if (.auto_close // 0) == 1 then "auto-close" else empty end)
    ] | join(" ");
  .id + "  " + .title + "  " + chips
'
rows() { printf '%s' "$RESP" | jq -r ".items[] | $ROWFMT"; }
one()  { printf '%s' "$RESP" | jq -r ".task // . | $ROWFMT"; }

resolve_project() { # name-or-id -> id on stdout
  local p="$1" id
  api GET "/projects?limit=500"
  id=$(printf '%s' "$RESP" | jq -r --arg p "$p" \
    '.items[] | select(.id == $p or (.name | ascii_downcase) == ($p | ascii_downcase)) | .id' | head -n1)
  if [ -z "$id" ]; then
    echo "pl: unknown project '$p' — existing: $(printf '%s' "$RESP" | jq -r '[.items[].name] | join(", ")')" >&2
    exit 1
  fi
  printf '%s' "$id"
}

[ $# -ge 1 ] || { sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
cmd="$1"; shift

case "$cmd" in
  add)
    [ $# -ge 1 ] || { echo "usage: pl.sh add \"title\" [flags]" >&2; exit 2; }
    title="$1"; shift
    body=$(jq -n --arg t "$title" '{title: $t}')
    while [ $# -gt 0 ]; do
      case "$1" in
        --project)  pid=$(resolve_project "$2"); body=$(jq --arg v "$pid" '.project_id=$v' <<<"$body"); shift 2 ;;
        --due)      body=$(jq --arg v "$2" '.due_date=$v' <<<"$body"); shift 2 ;;
        --due-time) body=$(jq --arg v "$2" '.due_time=$v' <<<"$body"); shift 2 ;;
        --when)     if [ "$2" = "someday" ]; then body=$(jq '.when_type="someday"' <<<"$body")
                    else body=$(jq --arg v "$2" '.when_type="date" | .when_date=$v' <<<"$body"); fi; shift 2 ;;
        --tags)     body=$(jq --arg v "$2" '.tags=($v | split(",") | map(gsub("^\\s+|\\s+$";"")) | map(select(. != "")))' <<<"$body"); shift 2 ;;
        --assignee) body=$(jq --arg v "$2" '.assignee=$v' <<<"$body"); shift 2 ;;
        --notes)    body=$(jq --arg v "$2" '.notes=$v' <<<"$body"); shift 2 ;;
        --steps)    body=$(jq --arg v "$2" '.steps=($v | split(";") | map(gsub("^\\s+|\\s+$";"")) | map(select(. != "")))' <<<"$body"); shift 2 ;;
        --auto-close) body=$(jq '.auto_close=1' <<<"$body"); shift ;;
        *) echo "pl: unknown flag $1" >&2; exit 2 ;;
      esac
    done
    api POST /tasks "$body"; one ;;

  quickadd)
    [ $# -eq 1 ] || { echo "usage: pl.sh quickadd \"text\"" >&2; exit 2; }
    api POST /tasks/quickadd "$(jq -n --arg t "$1" '{text: $t}')"; one ;;

  list)
    view=""; qs=""
    if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then view="$1"; shift; fi
    [ -n "$view" ] && qs="view=$(uri "$view")"
    while [ $# -gt 0 ]; do
      case "$1" in
        --project)  pid=$(resolve_project "$2"); qs="$qs&project=$(uri "$pid")"; shift 2 ;;
        --tag)      qs="$qs&tag=$(uri "$2")"; shift 2 ;;
        --assignee) qs="$qs&assignee=$(uri "$2")"; shift 2 ;;
        --window)   qs="$qs&window=$(uri "$2")"; shift 2 ;;
        --limit)    qs="$qs&limit=$(uri "$2")"; shift 2 ;;
        --q)        qs="$qs&q=$(uri "$2")"; shift 2 ;;
        *) echo "pl: unknown flag $1" >&2; exit 2 ;;
      esac
    done
    api GET "/tasks?${qs#&}"
    rows
    nc=$(printf '%s' "$RESP" | jq -r '.next_cursor // empty')
    if [ -n "$nc" ]; then echo "(more — refine filters or raise --limit)"; fi ;;

  queue)
    api GET /counts
    me=$(printf '%s' "$RESP" | jq -r .actor)
    # view=queue is server-enforced: active+in_progress, VETTED tasks only
    api GET "/tasks?view=queue&assignee=$(uri "$me")&limit=500"
    printf '%s' "$RESP" | jq -r "
      if (.items | length) == 0 then \"queue empty — nothing assigned to $me\"
      else .items[] | $ROWFMT end" ;;

  show)
    [ $# -eq 1 ] || { echo "usage: pl.sh show <id>" >&2; exit 2; }
    api GET "/tasks?limit=500"
    t=$(printf '%s' "$RESP" | jq --arg id "$1" '.items[] | select(.id == $id)')
    if [ -n "$t" ]; then printf '%s\n' "$t" | jq .
    else # not in the open default view — check logbook/review too
      for v in review logbook delegated; do
        api GET "/tasks?view=$v&limit=500"
        t=$(printf '%s' "$RESP" | jq --arg id "$1" '.items[] | select(.id == $id)')
        [ -n "$t" ] && { printf '%s\n' "$t" | jq .; exit 0; }
      done
      echo "pl: task $1 not found in open/review/logbook views" >&2; exit 1
    fi ;;

  claim)
    [ $# -eq 1 ] || { echo "usage: pl.sh claim <id>" >&2; exit 2; }
    api POST "/tasks/$(uri "$1")/claim" '{}'; one ;;

  finish)
    [ $# -eq 2 ] || { echo "usage: pl.sh finish <id> \"report\"" >&2; exit 2; }
    api POST "/tasks/$(uri "$1")/finish" "$(jq -n --arg r "$2" '{report: $r}')"; one ;;

  complete)
    [ $# -eq 1 ] || { echo "usage: pl.sh complete <id>" >&2; exit 2; }
    api POST "/tasks/$(uri "$1")/complete" '{}'; one ;;

  approve)
    [ $# -eq 1 ] || { echo "usage: pl.sh approve <id>" >&2; exit 2; }
    api POST "/tasks/$(uri "$1")/approve" '{}'; one ;;

  vet)
    [ $# -eq 1 ] || { echo "usage: pl.sh vet <id>" >&2; exit 2; }
    api POST "/tasks/$(uri "$1")/vet" '{}'; one ;;

  update)
    [ $# -ge 3 ] || { echo "usage: pl.sh update <id> --field val ..." >&2; exit 2; }
    id="$1"; shift
    body='{}'
    while [ $# -gt 0 ]; do
      case "$1" in
        --title)    body=$(jq --arg v "$2" '.title=$v' <<<"$body"); shift 2 ;;
        --notes)    body=$(jq --arg v "$2" '.notes=$v' <<<"$body"); shift 2 ;;
        --project)  if [ "$2" = "none" ]; then body=$(jq '.project_id=null' <<<"$body")
                    else pid=$(resolve_project "$2"); body=$(jq --arg v "$pid" '.project_id=$v' <<<"$body"); fi; shift 2 ;;
        --due)      if [ "$2" = "none" ]; then body=$(jq '.due_date=null' <<<"$body")
                    else body=$(jq --arg v "$2" '.due_date=$v' <<<"$body"); fi; shift 2 ;;
        --due-time) body=$(jq --arg v "$2" '.due_time=$v' <<<"$body"); shift 2 ;;
        --when)     case "$2" in
                      someday) body=$(jq '.when_type="someday" | .when_date=null' <<<"$body") ;;
                      none)    body=$(jq '.when_type=null | .when_date=null' <<<"$body") ;;
                      *)       body=$(jq --arg v "$2" '.when_type="date" | .when_date=$v' <<<"$body") ;;
                    esac; shift 2 ;;
        --assignee) body=$(jq --arg v "$2" '.assignee=$v' <<<"$body"); shift 2 ;;
        --status)   body=$(jq --arg v "$2" '.status=$v' <<<"$body"); shift 2 ;;
        --tags)     body=$(jq --arg v "$2" '.tags=($v | split(",") | map(gsub("^\\s+|\\s+$";"")) | map(select(. != "")))' <<<"$body"); shift 2 ;;
        --auto-close) body=$(jq --argjson v "$2" '.auto_close=$v' <<<"$body"); shift 2 ;;
        *) echo "pl: unknown flag $1" >&2; exit 2 ;;
      esac
    done
    api PATCH "/tasks/$(uri "$id")" "$body"; one ;;

  projects)
    api GET "/projects?limit=500"
    printf '%s' "$RESP" | jq -r '.items[] | .id + "  " + .name + (if .archived == 1 then "  [archived]" else "" end)' ;;

  counts)
    api GET /counts
    printf '%s' "$RESP" | jq -r '"actor: " + .actor
      + " | inbox: " + (.inbox | tostring)
      + " | today: " + (.today | tostring)
      + " | upcoming: " + (.upcoming | tostring)
      + " | due_soon: " + (.due_soon | tostring)
      + " | review: " + (.review | tostring)
      + " | delegated: " + (.delegated | tostring)' ;;

  *)
    echo "pl: unknown subcommand '$cmd'" >&2
    sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2 ;;
esac
