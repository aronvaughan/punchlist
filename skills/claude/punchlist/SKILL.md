---
name: punchlist
description: Manage the shared punchlist task system — add tasks, check queues, delegate to agents, claim and finish agent work. Use when the user says "add a task", "put X on the punchlist", "my punchlist", "what's on my list", "check my tasks", "task queue", "delegate this", or when checking for work assigned to you.
license: MIT
metadata:
  version: "1.0"
---

# punchlist — shared task list & agent delegation

The punchlist service (default http://127.0.0.1:8600) is the task system
shared by the owner and their agents. Every task has a `created_by` (set by
the server from the auth token — never claim otherwise) and an `assignee`
(who must do it). Actor names come from the server's `AV_TASKS_TOKENS`
config; the admin actor (the owner) is the first one, or `AV_TASKS_ADMIN`.
Agent work flows
active → claim → in_progress → finish(report) → review → the owner
approves → done.

Auth: `scripts/pl.sh` sends `Bearer $PUNCHLIST_TOKEN` (this agent's actor
token) to `$PUNCHLIST_URL` (default http://127.0.0.1:8600). Export
`PUNCHLIST_TOKEN`, or — as an optional convention — put
`PUNCHLIST_TOKEN=...` in `~/.claude/secrets.local.env` (chmod 600), which
the script reads as a fallback. NEVER print or log the token; never run the
script with `bash -x` or other tracing.

## Usage

```bash
S=<this skill dir>/scripts/pl.sh
"$S" queue                                # open work assigned to you
"$S" claim  <id>                          # take a queued task before working it
"$S" finish <id> "what was done + where"  # -> review lane (report REQUIRED)
"$S" add "title" --project X --due 2026-08-30 --when someday \
        --tags a,b --assignee <actor> --notes N --steps "a;b"
"$S" quickadd "buy solder #electronics"   # server-side token parsing
"$S" list today|inbox|upcoming|overdue|due_soon|review|delegated|logbook \
        [--project P --tag T --assignee A --window N --q S]
"$S" show <id>                            # full JSON (incl. notes, steps, report)
"$S" update <id> --assignee <actor> --due 2026-08-30 ...  # sparse PATCH
"$S" complete <id>   "$S" approve <id>    # human doors (approve = admin only)
"$S" projects        "$S" counts
```

## Behavior

- **Check the queue**: when asked "is there work for you" (or at natural
  checkpoints), run `queue` — it lists active + in_progress tasks assigned
  to your actor. **Claim before working** a task; never work unclaimed items.
- **Finish with a substantive report**: what was done, where the output
  lives (paths, commits, links), and anything the reviewer should check.
  A bare "done" is not a report. Finishing normally lands the task in the
  review lane for the owner; only `--auto-close` tasks go straight to done.
- **Meatspace asks for the user** ("remind me to buy X", physical-world
  tasks): `add` with `--assignee <the owner's actor>` — created_by shows
  your actor automatically. Never assign physical-action tasks to an agent.
- **Delegate to another agent**: `add ... --assignee <agent>` (or
  `update <id> --assignee <agent>`). Agents poll their own queues.
- **Cite task ids** (the 26-char ULIDs) whenever referring to tasks, so
  the user can find them in the UI.
- `approve` only works with the admin actor's token — any other will get a
  403; leave review items for the owner (UI or their own CLI).
- Statuses done/in_progress/review are transitions, not PATCH values: use
  `complete`/`claim`/`finish` (the API rejects PATCHing them by design).
