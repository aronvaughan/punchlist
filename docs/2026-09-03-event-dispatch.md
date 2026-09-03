# Event-driven agent dispatch (retiring the poller)

*Design record — 2026-09-03. Move autonomous task pickup from external cron
pollers to a server-internal, event-driven dispatcher. Status: design agreed,
not yet built.*

## Problem

Today an agent works delegated tasks only when an **external cron** wakes it:
`~/.claude/scripts/claude-queue-sweep.sh` (every 3 min) and the Hermes
`punchlist-queue-sweep.sh` (every 20 min) launch a headless orchestrator that
drains its own claimable queue, then exits. Three problems:

1. **Latency** — a task sits up to the cron interval (3–20 min) before pickup.
2. **Waste** — most wakes find an empty queue but still spend a full agent run
   (tokens) to discover that.
3. **Hidden dependency** — punchlist is pull-based ("agents poll their own
   queues"); the server never signals work. If the agent-side cron isn't
   installed, delegated tasks silently never run. The task server neither
   installs nor mentions this dependency.

## What already exists (80% of the machinery)

- **`task_events`** (migration 011) — a durable, ordered log: `seq` autoincrement
  cursor, `task_id`, `event` type, JSON `payload` snapshot, `created_at`, and a
  **`delivered_at`** column the migration explicitly **reserved** for "a future
  outbound-delivery worker to mark rows it has processed." One row per notable
  transition. Survives restarts (`ON DELETE CASCADE` with the task).
- **`GET /api/v1/events?since=&assignee=`** — the cursor-paged feed the web UI
  already polls.
- **`settings`** (migration 014) — a key/value config store already used for
  instance config. New dispatch knobs drop straight in.
- The server is a **single Node + Hono process**, so the dispatcher is a
  `setInterval` loop in-process — no new runtime, no new service.

This is not a new event system; it is **adding a consumer** to an event log the
server already writes.

## Decisions

1. **The server spawns the agent** (not push/SSE). A headless Claude Code /
   Hermes run isn't a long-lived listener, so *something* must start it; a
   subscribe-and-push model still needs a running agent to receive the push.
   The server spawns the agent via a **per-agent command in config** — generic
   server, agent-specifics stay in operator config. This is the linchpin that
   makes punchlist self-contained.
2. **Wake-to-drain**, and **detection is a free DB query, not an agent.** The
   dispatcher tick is pure SQL over `task_events` + `tasks` (zero tokens); it
   spawns the (token-costing) orchestrator **only** when there is claimable,
   actionable work for an assignee **and** no orchestrator is already running
   for it. Each wake drains that assignee's queue and exits. (A finer per-task
   concurrency mode is deferred — see Future.)
3. **`delivered_at`** is the dispatcher's processed-marker for now (single
   consumer; the UI reads by its own `since` cursor, so no conflict). Add a
   migration note: generalize to `event_consumers(name, cursor)` if/when a
   second consumer (e.g. an outbound webhook) appears.
4. **Polling demotes, it doesn't die.** A low-frequency **reconcile** pass
   inside the server (scan active-unclaimed-vetted tasks the event path missed)
   is the safety net for missed/handled-but-unclaimed events. The aggressive
   3-min external cron becomes a rare, in-server reconcile.

## Architecture

```
transition (task created-for-agent · reassigned to agent · block→answered ·
            an orchestrator finished → capacity freed)
  └─> task_events row written atomically with the transition (as today,
      broadened to cover the agent-actionable transitions)

dispatcher tick  (every dispatch_interval_ms, in-process, NO tokens):
  1. free SQL: is there an actionable task per assignee?  (see query below)
  2. for each assignee WITH work:
       - is an orchestrator already live for it?  (process registry) → skip
       - is it under its watermark (max orchestrators)?             → else skip
       - debounce: coalesce a burst of events into ONE wake
       - SPAWN the assignee's configured wake command
       - mark the consumed events delivered_at = now
  3. (separately) reconcile pass every reconcile_interval_ms: catch anything
     the event path missed; belt-and-suspenders.
```

**Detection query (the free, no-token core)** — an assignee has work when it
has a task that is `active`, vetted, assigned to it, unclaimed, and not blocked:

```sql
SELECT assignee, COUNT(*) AS n
FROM tasks
WHERE status = 'active' AND assignee = ? AND vetted = 1
      AND blocked = 0            -- or: status not in the needs-input lane
GROUP BY assignee;
```

The `task_events` feed is the **trigger** (cheap "something changed, look now")
and `delivered_at` the de-dupe marker; the `tasks` query is the **truth** of
whether a wake is warranted right now. Events can be stale, so the tick always
re-validates against live task state before spawning.

## Actionable events

`task_events` today is written for the "needs a human's attention" set
(finish→review, block, answer, approve). The dispatcher needs the
**agent-actionable** set, which overlaps but differs:

| Transition | Agent-actionable? |
| --- | --- |
| task created with `assignee = <agent>` (vetted) | **yes** |
| task reassigned to `<agent>` | **yes** |
| blocked task answered (block → active) | **yes** |
| an orchestrator finished → capacity freed | **yes** (pull next) |
| finish → review, approve, complete | no (human-ward) |

Action: ensure the create/reassign/answer transitions emit a `task_events` row
(broaden emission if any don't today). No new table.

## The orchestrator model (fresh-per-wake)

Each wake is a **fresh, stateless orchestrator run** — exactly like today's
cron run: read the claimable queue → delegate each task to a subagent → exit.
**Not** a long-lived context.

- **The DB is the state.** The orchestrator carries nothing between wakes.
- Fresh runs are bounded and self-healing; a long-running orchestrator would
  accumulate context, go stale, and strand on a crash.
- **Context is set up per-wake by the orchestrator prompt**, and correctly:
  `pl instance` once (deployment context + data-isolation policy), then per
  task `pl project <id>` (readme + working_dir) and `plt show <template>`.
  Today's `claude-queue-sweep` prompt already does this — no change needed.
- **Debounce** coalesces a burst into one wake: five tasks landing together =
  one orchestrator draining all five, not five runs.

## Multi-agent model

The dispatcher is **agent-agnostic**. It groups undelivered actionable events by
`assignee` and, for each assignee with work + under its watermark + no live
orchestrator, runs that assignee's configured wake command:

```
dispatch:
  claude:  { cmd: "<claude headless orchestrator, given the assignee>", max: 1 }
  hermes:  { cmd: "<hermes orchestrator>",                              max: 1 }
  # add an agent = add one entry; the dispatch loop is unchanged
```

Scaling to N agents is just more entries. **Agents are dispatch *targets*, not
event-log *consumers*** — the dispatcher is the single consumer of `task_events`
that fans out to agents. `event_consumers` (a cursor per consumer) only appears
if a *second kind* of consumer (webhook, external bus) shows up.

## Config surface (`settings` keys)

| key | meaning | default |
| --- | --- | --- |
| `dispatch_enabled` | master on/off | `0` (opt-in) |
| `dispatch_interval_ms` | dispatcher tick | `500` |
| `dispatch_debounce_ms` | coalesce an event burst into one wake | `2000` |
| `dispatch_max_<agent>` | max concurrent orchestrators for an assignee | `1` |
| `dispatch_cmd_<agent>` | the wake command template for an assignee | — |
| `reconcile_interval_ms` | safety-net rescan cadence | `300000` (5 min) |

(Exact key naming — flat `dispatch_cmd_claude` vs a single JSON `dispatch`
blob — decided at build time; the `settings` store holds strings, so a JSON
blob under one key is fine.)

## Concurrency & watermark

Under wake-to-drain, the watermark is **max concurrent orchestrator processes
per assignee** (default 1 — never spawn a second Claude orchestrator while one
is still draining Claude's queue). The server tracks live orchestrators in an
in-memory registry (pid + assignee + started_at), reaped on process exit; a
stale entry (process died) is cleaned by the reconcile pass. The finer
"executing-tasks count" watermark belongs to the deferred per-task mode.

## Idempotency, at-least-once, crash-safety

- **Re-validate before spawn.** An event may be stale (task already claimed,
  reassigned, or done). The tick checks live `tasks` state, so a duplicated or
  replayed event never double-launches.
- **At-least-once.** If the server crashes between spawning and marking
  `delivered_at`, the event replays and the tick re-validates — worst case a
  redundant wake that finds nothing (cheap, no tokens wasted beyond one query).
- **Reconcile** is the backstop for the opposite failure: an event marked
  delivered but the spawned orchestrator died before claiming — the rescan
  finds the still-active task and re-dispatches.

## Security posture

A task server that spawns processes is a real change and is treated as such:

- **Opt-in** (`dispatch_enabled = 0` by default).
- The wake command is **operator config**, never task-controlled. The only
  task-derived value passed to it is an assignee name (and, in the future
  per-task mode, a validated `task_id` ULID) — no task title/notes/body ever
  reaches a shell.
- Tasks remain **screened by the agent** on pickup (the existing untrusted-task
  protocol is unchanged). Dispatch decides *when* to run an agent, never *what*
  the agent trusts.
- The spawn inherits the server's privileges; the wake command should be a
  fixed, reviewed script (as `claude-queue-sweep.sh` is today), not an inline
  string assembled from data.

## Rollout (no flag day)

1. Build the dispatcher **alongside** the existing crons, `dispatch_enabled = 0`.
2. Enable it on this box; leave the 3-min cron running as the safety net.
3. Watch the dispatcher beat the cron to every task (latency + zero empty
   wakes).
4. Once trusted, retire `claude-queue-sweep` / `punchlist-queue-sweep` crons —
   their job is now the in-server reconcile pass.

## Future / deferred

- **Per-task concurrency mode** — spawn one run per task up to an
  executing-count watermark, each claiming its `task_id` first so runs don't
  collide. Real parallelism; more processes. Config: `dispatch_mode` =
  `drain | per_task`.
- **`event_consumers(name, cursor)`** — when a second consumer appears
  (outbound webhook, external event bus), replace the single `delivered_at`
  marker with a per-consumer cursor so each consumer advances independently.
- **Outbound webhooks** — the original 011 design's other half; the same event
  log, a different consumer.

## Open questions for the build

1. `dispatch_cmd_<agent>` as flat keys vs a single JSON `dispatch` blob in
   `settings` (leaning JSON blob — one key, structured).
2. Do all three agent-actionable transitions already emit `task_events`, or must
   emission be broadened? (Audit `postComment`/event writes in `api.js`.)
3. Exact "unclaimed & not-in-needs-input" predicate for the detection query
   against the current schema (`blocked` flag vs a status/lane check).
