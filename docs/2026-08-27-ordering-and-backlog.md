# Ordering, agent backlog, reopen placement (design)

*Agreed with the owner 2026-08-27. Priority-as-enum is DEFERRED — position
IS priority (Kanban/Things model). One mechanism: per-view manual order.*

## Principles

- The order of a list IS its priority. No priority enum, no numeric rank
  field exposed. You drag; the position means "do this sooner."
- Deadlines are NOT an automatic override. Due/overdue tasks surface to the
  human in Today / Due Soon; agents work their backlog top-down. The human
  drags urgent things up. Simple and explicit beats hidden sort weights.

## Per-view manual order (view_ranks)

- New table `view_ranks(task_id, view, rank REAL, PRIMARY KEY(task_id,view))`.
  `view` ∈ `inbox | agents | human` for now. Dragging within one of these
  views sets that view's rank; each view is independent.
- Existing order stays as-is (do NOT refactor to avoid risk): Today uses
  `today_rank`, project sections use `tasks.rank`. Those already support
  drag and must keep working — verify, don't rewrite. (Unifying everything
  into view_ranks is a future cleanup, out of scope.)
- Today and a Project legitimately show different orders for the same task —
  that's expected and correct.
- Upcoming / Logbook stay date/status ordered (no manual drag).

## Single shared agent backlog

- The Agents view is ONE ordered backlog across all agent-assigned open
  tasks (active + in_progress), ordered by `view_ranks` view='agents'
  (nulls last, then created_at). Grouping by agent stays as a visual
  affordance, but the backlog order is global.
- **Claiming is assignee-filtered.** The backlog is shared for ordering and
  visibility, but `pl.sh queue` / MCP `punchlist_queue` return only the
  caller's OWN assigned open+vetted tasks, in agents-backlog rank order.
  Claude claims the top task assigned to Claude; Hermes the top assigned to
  Hermes. No agent ever picks up another agent's task. Safe to share the
  ranking because each agent only takes its own, in order.
- Dragging in the Agents view reorders the shared backlog (sets
  view='agents' rank).

## Agent reorder = reorder + a reason

- When an AGENT reorders a task in the backlog (or reprioritizes by moving
  it), it must post a comment explaining why — skill discipline, and the
  reorder endpoint auto-posts a `status` timeline entry
  ("<agent> moved this up: <reason>") when the actor is an agent and a
  reason is supplied. Humans reorder freely, no comment required.

## Reopen placement

- Reopening a task (review → active) sets its Agents-backlog rank to the
  TOP (min existing rank − gap), so it's the next thing an agent picks up.
  It was in-flight; the human can drag it down from there. The optional
  reopen comment (already designed) still posts to the timeline.

## Project-dialog fixes (the rejected task's 4 steps)

1. Remove the gear icon on the Projects section header (the "+ New project"
   and per-parent + already open the dialog).
2. Archived projects hidden by default; a small show-archived icon toggles
   them (prefer icons to text throughout the dialog).
3. **FIX drag-to-reparent — it does not work in the browser today.** The
   server PATCH is correct; the DnD wiring is broken. Verify by performing
   a REAL drag in a browser (not a curl PATCH), reparent + unparent, and
   confirm the tree persists.
4. Use the 3-vertical-bar grip (⋮⋮, same as step rows) instead of the wide
   dotted grabber.

## Tests / verification

- view_ranks CRUD + per-view independence; agents-backlog ordering; claim
  returns top; reorder-by-agent posts a status comment; reopen sets top
  rank. Browser: drag-reorder in inbox/agents actually persists; project
  dialog drag-reparent actually works.
