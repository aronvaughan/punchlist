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
#              views: inbox today upcoming overdue due_soon logbook review delegated needs_input
#   pl.sh queue                        open work assigned to ME (active + in_progress,
#                                      vetted only — server-side view=queue)
#   pl.sh show <id>                    one task, full JSON
#   pl.sh claim <id>                   active -> in_progress (assignee only, vetted only)
#   pl.sh finish <id> "report"         -> review (or done if auto_close); report required
#                                      (warns on stderr, non-fatally, if the task
#                                      still has incomplete steps[])
#   pl.sh step <task_id> <step_id> [done|undone]
#                                      toggle one step's done flag (default: done);
#                                      assignee or admin only — use this as you
#                                      complete each step, before finishing/blocking
#   pl.sh block <id> "question"        stuck? -> blocked with ONE concrete question
#                                      for the admin (assignee only); returns to the
#                                      queue with the answer attached once answered
#   pl.sh answer <id> "text"           blocked -> active with the answer (admin only)
#   pl.sh comment <id> "text"          post a comment to the task's timeline
#                                      (non-blocking — think out loud / progress)
#   pl.sh comments <id>                 list a task's comment timeline (read-only)
#   pl.sh attachments <id>              list a task's attachments (id/filename/mime/bytes)
#   pl.sh attachment <id> <att_id> [--out path]
#                                      download one attachment's bytes (read-only;
#                                      no upload/delete surface). Default output
#                                      path is ./<attachment filename>; use --out -
#                                      to print text attachments to stdout.
#   pl.sh reorder <id> (--before <id>|--after <id>) [--list agents|inbox|human]
#                    --reason "why"    reprioritize your backlog; as an agent you
#                                      MUST give a reason (auto-posted to timeline)
#   pl.sh complete <id>                human-style done (the owner's own tasks)
#   pl.sh approve <id>                 review -> done (admin actor only)
#   pl.sh vet <id>                     mark an unvetted task safe for agents (admin only)
#   pl.sh allow-push <id> [--revoke]   authorize pushing this task's work (admin only;
#                                      lifts the commit-local-only rule for it)
#   pl.sh update <id> [--title T] [--notes N] [--project P] [--due D] [--due-time HH:MM]
#                    [--when W|someday|none] [--assignee A] [--status active|archived]
#                    [--tags a,b] [--auto-close 0|1]
#   pl.sh projects                     list projects ([context] = has a readme)
#   pl.sh project <name|id>            print a project's context notepad (readme/
#                                      overview) — read it before working its tasks
#   pl.sh tags                         list tags ([context] = has a readme)
#   pl.sh tag <name|id>                print a tag's context notepad — read it
#                                      AFTER instance + project context (root ->
#                                      project -> tag is the injection order)
#   pl.sh instance                     this deployment's global context + data-
#                                      isolation policy (applies to every agent)
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
      (if .status == "blocked" and .question then
        "Q: " + ((.question | split("\n")[-1]) as $q
                 | if ($q | length) > 60 then ($q[0:57] + "...") else $q end)
       else empty end),
      (if .due_date then "due:" + .due_date + (if .due_time then "T" + .due_time else "" end) else empty end),
      (if .when_type == "someday" then "someday"
       elif .when_type == "date" then "when:" + .when_date else empty end),
      ((.tags // [])[] | "#" + .),
      (if (.auto_close // 0) == 1 then "auto-close" else empty end),
      (if (.allow_push // 0) == 1 then "[push-ok]" else empty end)
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

resolve_tag() { # name-or-id (leading # tolerated) -> id on stdout
  local p="${1#\#}" id
  api GET /tags
  id=$(printf '%s' "$RESP" | jq -r --arg p "$p" \
    '.items[] | select(.id == $p or (.name | ascii_downcase) == ($p | ascii_downcase)) | .id' | head -n1)
  if [ -z "$id" ]; then
    echo "pl: unknown tag '$p' — existing: $(printf '%s' "$RESP" | jq -r '[.items[].name] | join(", ")')" >&2
    exit 1
  fi
  printf '%s' "$id"
}

[ $# -ge 1 ] || { sed -n '2,59p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
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
    api POST "/tasks/$(uri "$1")/finish" "$(jq -n --arg r "$2" '{report: $r}')"
    # Passive nudge, not a hard block: some tasks are legitimately finished
    # with steps left for a future increment. Warn on stderr only.
    incomplete=$(printf '%s' "$RESP" | jq '[(.task // .).steps[]? | select(.done == 0)] | length')
    if [ "${incomplete:-0}" -gt 0 ]; then
      echo "Warning: $incomplete step(s) still marked incomplete — consider \`pl.sh step $1 <step_id>\` first" >&2
    fi
    one ;;

  step)
    [ $# -ge 2 ] || { echo "usage: pl.sh step <task_id> <step_id> [done|undone]" >&2; exit 2; }
    tid="$1"; sid="$2"; action="${3:-done}"
    case "$action" in
      done)   val=true ;;
      undone) val=false ;;
      *) echo "usage: pl.sh step <task_id> <step_id> [done|undone]" >&2; exit 2 ;;
    esac
    api PATCH "/tasks/$(uri "$tid")/steps/$(uri "$sid")" "$(jq -n --argjson d "$val" '{done: $d}')"
    printf '%s' "$RESP" | jq -r '(if .done == 1 then "[x] " else "[ ] " end) + .title' ;;

  block)
    [ $# -eq 2 ] || { echo "usage: pl.sh block <id> \"question\"" >&2; exit 2; }
    api POST "/tasks/$(uri "$1")/block" "$(jq -n --arg q "$2" '{question: $q}')"; one ;;

  answer)
    [ $# -eq 2 ] || { echo "usage: pl.sh answer <id> \"text\"" >&2; exit 2; }
    api POST "/tasks/$(uri "$1")/answer" "$(jq -n --arg a "$2" '{answer: $a}')"; one ;;

  comment)
    [ $# -eq 2 ] || { echo "usage: pl.sh comment <id> \"text\"" >&2; exit 2; }
    api POST "/tasks/$(uri "$1")/comments" "$(jq -n --arg t "$2" '{text: $t}')"
    printf '%s' "$RESP" | jq -r '"commented on " + .task_id + " (@" + (.author // "?") + ")"' ;;

  comments)
    [ $# -eq 1 ] || { echo "usage: pl.sh comments <id>" >&2; exit 2; }
    api GET "/tasks/$(uri "$1")/comments"
    printf '%s' "$RESP" | jq -r '.items[] | .created_at + "  @" + .author + "  [" + .kind + "]  " + .text' ;;

  attachments)
    # Read-only listing — no upload/delete surface here (that stays server-side).
    [ $# -eq 1 ] || { echo "usage: pl.sh attachments <id>" >&2; exit 2; }
    api GET "/tasks/$(uri "$1")/attachments"
    printf '%s' "$RESP" | jq -r '.items[] | .id + "  " + .filename + "  " + .mime + "  " + (.bytes|tostring) + "b  [" + .kind + "]  " + .created_at' ;;

  attachment)
    # Download one attachment's raw bytes via GET /attachments/:id. Streamed
    # straight to disk with curl -o (never through a bash variable) so binary
    # image bytes aren't mangled. Read-only: no upload/delete subcommand here.
    [ $# -ge 2 ] || { echo "usage: pl.sh attachment <task_id> <attachment_id> [--out path]" >&2; exit 2; }
    task_id="$1"; att_id="$2"; shift 2
    out=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --out) out="$2"; shift 2 ;;
        *) echo "pl: unknown flag $1" >&2; exit 2 ;;
      esac
    done
    # Confirm the attachment belongs to the given task and get its filename
    # (also validates the task/attachment exist before we spend a download).
    api GET "/tasks/$(uri "$task_id")/attachments"
    meta=$(printf '%s' "$RESP" | jq -r --arg id "$att_id" '.items[] | select(.id == $id)')
    [ -n "$meta" ] || { echo "pl: attachment $att_id not found on task $task_id" >&2; exit 1; }
    fname=$(printf '%s' "$meta" | jq -r '.filename')
    if [ -z "$out" ]; then out="./$fname"; fi
    if [ "$out" = "-" ]; then
      curl -sS --max-time 30 -X GET "$API/attachments/$(uri "$att_id")" \
        -H "Authorization: Bearer $TOKEN" || { echo "pl: download failed" >&2; exit 1; }
    else
      code=$(curl -sS --max-time 30 -w '%{http_code}' -o "$out" -X GET "$API/attachments/$(uri "$att_id")" \
        -H "Authorization: Bearer $TOKEN") || { echo "pl: cannot reach $BASE" >&2; exit 1; }
      case "$code" in
        2*) echo "saved $out" ;;
        *) rm -f "$out"; echo "pl: HTTP $code downloading attachment $att_id" >&2; exit 1 ;;
      esac
    fi ;;

  reorder)
    # Reprioritize your backlog. As an agent you MUST give a --reason: it
    # auto-posts a status entry ("<you> moved this up: <reason>") to the task
    # timeline so the owner sees why. Position IS priority.
    [ $# -ge 3 ] || { echo "usage: pl.sh reorder <id> (--before <id>|--after <id>) [--list agents|inbox|human] --reason \"why\"" >&2; exit 2; }
    id="$1"; shift
    body=$(jq -n '{list: "agents"}')
    while [ $# -gt 0 ]; do
      case "$1" in
        --before) body=$(jq --arg v "$2" '.before_id=$v' <<<"$body"); shift 2 ;;
        --after)  body=$(jq --arg v "$2" '.after_id=$v' <<<"$body"); shift 2 ;;
        --list)   body=$(jq --arg v "$2" '.list=$v' <<<"$body"); shift 2 ;;
        --reason) body=$(jq --arg v "$2" '.reason=$v' <<<"$body"); shift 2 ;;
        *) echo "pl: unknown flag $1" >&2; exit 2 ;;
      esac
    done
    api POST "/tasks/$(uri "$id")/reorder" "$body"; one ;;

  complete)
    [ $# -eq 1 ] || { echo "usage: pl.sh complete <id>" >&2; exit 2; }
    api POST "/tasks/$(uri "$1")/complete" '{}'; one ;;

  approve)
    [ $# -eq 1 ] || { echo "usage: pl.sh approve <id>" >&2; exit 2; }
    api POST "/tasks/$(uri "$1")/approve" '{}'; one ;;

  vet)
    [ $# -eq 1 ] || { echo "usage: pl.sh vet <id>" >&2; exit 2; }
    api POST "/tasks/$(uri "$1")/vet" '{}'; one ;;

  allow-push)
    # Owner authorizes pushing THIS task's work to the remote (admin only).
    # Lifts the standing "commit-local-only" rule for this task. --revoke undoes.
    [ $# -ge 1 ] || { echo "usage: pl.sh allow-push <id> [--revoke]" >&2; exit 2; }
    body='{}'; [ "${2:-}" = "--revoke" ] && body='{"allow":false}'
    api POST "/tasks/$(uri "$1")/allow-push" "$body"; one ;;

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
    printf '%s' "$RESP" | jq -r '.items[] | .id + "  " + .name
      + (if .archived == 1 then "  [archived]" else "" end)
      + (if (.notes // "") != "" then "  [context]" else "" end)' ;;

  project)
    # Read ONE project's context notepad (its readme/overview). Read it for
    # background before working the project's tasks. name-or-id.
    [ $# -eq 1 ] || { echo "usage: pl.sh project <name|id>" >&2; exit 2; }
    pid=$(resolve_project "$1")
    api GET "/projects?limit=500"
    printf '%s' "$RESP" | jq -r --arg id "$pid" '
      .items[] | select(.id == $id)
      | "# " + .name + (if .archived == 1 then "  [archived]" else "" end)
        + (if (.template // "") != "" then "  [template: " + .template + "]" else "" end)
        + (if (.working_dir // "") != "" then "\nworking_dir: " + .working_dir else "" end) + "\n\n"
        + (if (.notes // "") != "" then .notes else "(no context set)" end)' ;;

  tags)
    api GET /tags
    printf '%s' "$RESP" | jq -r '.items[] | .id + "  #" + .name
      + "  (" + (.count | tostring) + " open)"
      + (if (.notes // "") != "" then "  [context]" else "" end)' ;;

  tag)
    # Read ONE tag's context notepad (its readme/overview) — mirrors `project`.
    # Injected AFTER root (instance) + project context, per the tag-context
    # design: root -> project -> tag. name-or-id (leading # tolerated).
    [ $# -eq 1 ] || { echo "usage: pl.sh tag <name|id>" >&2; exit 2; }
    gid=$(resolve_tag "$1") || exit 1
    api GET /tags
    printf '%s' "$RESP" | jq -r --arg id "$gid" '
      .items[] | select(.id == $id)
      | "# #" + .name
        + (if (.template // "") != "" then "  [template: " + .template + "]" else "" end) + "\n\n"
        + (if (.notes // "") != "" then .notes else "(no context set)" end)' ;;

  instance)
    # This deployment's global context + data-governance policy. Read it before
    # working — it applies to you and every subagent (deployment-wide rules).
    api GET /instance
    printf '%s' "$RESP" | jq -r '
      "# instance: " + (if (.name // "") != "" then .name else "(unnamed)" end)
      + "\ndata_isolation: " + (if .data_isolation then "ON — private by default; keep client/personal content out of publishable paths" else "off" end)
      + "\n\n" + (if (.context // "") != "" then .context else "(no instance context set)" end)' ;;

  counts)
    api GET /counts
    printf '%s' "$RESP" | jq -r '"actor: " + .actor
      + " | inbox: " + (.inbox | tostring)
      + " | today: " + (.today | tostring)
      + " | upcoming: " + (.upcoming | tostring)
      + " | due_soon: " + (.due_soon | tostring)
      + " | review: " + (.review | tostring)
      + " | delegated: " + (.delegated | tostring)
      + " | needs_input: " + (.needs_input | tostring)' ;;

  *)
    echo "pl: unknown subcommand '$cmd'" >&2
    sed -n '2,59p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2 ;;
esac
