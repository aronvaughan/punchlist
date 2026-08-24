---
name: punchlist
description: "Work the shared punchlist task system — check your queue of tasks assigned to you, claim them, finish them with a report, add tasks for the owner, and read counts for the morning brief. Use when asked about tasks, the punchlist, your queue, delegation, 'what's on the list', or when a cron prompt tells you to check your punchlist queue."
version: 0.1.0
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [tasks, punchlist, delegation, queue, todo]
---

# Punchlist (shared task system)

The punchlist service (default http://127.0.0.1:8600, override with
`PUNCHLIST_URL`) is the task list shared by the owner and their agents.
Tasks carry `created_by` (set from the auth token) and `assignee` (who must
do it). Actor names come from the server's `AV_TASKS_TOKENS` config; the
admin actor (the owner) approves reviews. Your delegated work flows:
active → `claim` → in_progress → `finish` (with report) → review → the
owner approves → done.

All via `scripts/pl.sh` (auth automatic — token read from
`$HERMES_HOME/.env` `PUNCHLIST_TOKEN`; never print it):

```bash
scripts/pl.sh queue                                # open work assigned to you
scripts/pl.sh claim  <id>                          # take a task BEFORE working it
scripts/pl.sh finish <id> "what I did + where"     # -> review lane; report required
scripts/pl.sh show <id>                            # full task JSON (notes, steps)
scripts/pl.sh add "title" --assignee <owner> --due 2026-08-30 --notes "..."
scripts/pl.sh list today|review|delegated|overdue  # filtered views
scripts/pl.sh update <id> --assignee <owner> --notes "needs a human hand"
scripts/pl.sh counts                               # nav counts incl. review
```

## Guidance

- **Queue discipline**: check `queue`, claim a task before starting, work
  it, then `finish` with a SUBSTANTIVE report — what you did, where output
  lives, what the reviewer should check. "Done" alone is not a report.
- **Physical/meatspace tasks are not yours**: anything needing hands in
  the world gets reassigned — `update <id> --assignee <the owner's actor>`
  plus a note explaining why. Same for new reminders the owner asks you to
  record: `add` with `--assignee <the owner's actor>`.
- **Morning brief**: include a punchlist line built from `counts` and
  `list`, e.g. "N tasks waiting on you (today), M in review" — today +
  due_soon are the owner's plate; review is work of yours awaiting their
  approval; nudge them when review is non-empty.
- Cite task ids (26-char ULIDs) when referring to tasks.
- Finishing puts the task in review for the owner unless it was marked
  auto-close; do not try to `approve` — only the admin actor's token can.
- If the service is unreachable, say so; never fake queue results.
