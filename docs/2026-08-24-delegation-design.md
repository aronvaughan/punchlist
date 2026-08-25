# Delegation — agent-native tasks (design)

*Agreed with Aron 2026-08-24: assignee model, agent lifecycle with claim/
report, review lane by default with per-task auto-close, Agents nav view.*

## Model deltas (migration 002 — table rebuild for the status CHECK)

```sql
tasks + assignee   TEXT NOT NULL DEFAULT 'alex'   -- actor names (alex|claude|hermes|email…)
      + auto_close INT NOT NULL DEFAULT 0         -- finish goes straight to done
      + claimed_at TEXT NULL                      -- set on claim
      + report     TEXT NULL                      -- agent's outcome note (markdown, same caps as notes)
      status CHECK extended: ('active','in_progress','review','done','archived')
```

created_by = who asked; assignee = who must do it. Both rendered as chips.

## Lifecycle

- Human tasks (assignee=alex): unchanged — active → done via /complete.
- Agent tasks:
  - `POST /tasks/:id/claim` — actor must equal assignee; active → in_progress
    (sets claimed_at). Idempotent (claiming own in_progress task = 200).
  - `POST /tasks/:id/finish {report}` — actor must equal assignee; from
    active|in_progress → `review` (or → `done` when auto_close=1). Report
    required (non-empty), stored, shown in UI + logbook.
  - `POST /tasks/:id/approve` — human (alex) only; review → done.
  - Reopen = PATCH status:'active' from review (report kept, appended to
    on next finish: reports concatenate with a timestamped rule).
- Recurrence: the spawn happens at the FINAL transition to done
  (complete, approve, or auto-close finish) — never on entering review.
- PATCH rules: status 'done' still rejected (use the doors above);
  'in_progress'/'review' not settable via PATCH either. assignee IS
  patchable (reassign); reassigning an in_progress task resets it to
  active + clears claimed_at.

## Views & visibility

*Amended 2026-08-24 (approved): due-dates override assignee scoping;
when-dates don't. A deadline is a deadline no matter whose plate it's on.*

- `?assignee=` filter on task lists. New views: `review` (status=review),
  `delegated` (assignee != 'alex' AND status IN
  (active,in_progress,review)).
- **Upcoming / Inbox = alex's lanes**: filtered to assignee='alex'
  (when-driven planning; delegated work must not clutter the human's day).
- **Today**: the WHEN disjunct is alex-only, the DUE disjunct includes ALL
  assignees — `(assignee='alex' AND when arrived) OR due_date<=today`.
- **Due Soon / Overdue**: unscoped — windowed/lapsed deadlines for every
  assignee.
- Delegated tasks never hold `today_rank`: delegating clears it, and
  due-driven Today appearances sort after manually-ranked items (they
  can't be dragged in Today).
- Project views show ALL tasks with assignee chips.
- counts: inbox/upcoming stay alex-scoped; today/due_soon follow the
  amended definitions above; add `review` and `delegated` counts.
- **Agents view** (nav, between Logbook and Projects): everything
  delegated, grouped by agent then status (in_progress first, then
  review — with inline report preview + Approve button — then queued
  active). Review items also surface as a badge on the nav entry.

## UI

- Assignee control in the inline card + drawer: segmented [Me | Claude |
  Hermes] + auto-close toggle (visible only when assignee != Me).
- Chips on rows: assignee chip (e.g. ⚙ hermes) when not alex; "review"
  state renders an accent-outline chip; report shown in expanded card,
  drawer, and logbook entry.
- Approve = one tap on the row chip or button in Agents view.

## Agent pickup (M2 wiring)

- Skills gain: `queue` (list assignee=me, active+in_progress),
  `claim <id>`, `finish <id> "report"`. Cron heartbeat per agent polls
  the queue (same pattern as ov sweeps); hermes' morning brief includes
  alex's meatspace lane ("N tasks waiting on you, M in review").

## Non-goals (v1)

Multi-agent negotiation, task splitting, priorities, SLAs, notifications
beyond the Telegram brief, per-domain auto-routing (a project
default_assignee may come later).
