# Event dispatch — implementation plan

*Execution plan for [2026-09-03-event-dispatch.md](2026-09-03-event-dispatch.md)
(Revision 2). Built in safe increments, each ending green (461+ tests, ≥80%
coverage), everything behind `dispatch_enabled=0` so there is NO behavior
change until it's deliberately switched on. Alongside the crons; retire them
last.*

## Guardrails for every increment
- `node scripts/check-coverage.mjs` green (the fixed harness: force-exit + per-test timeout).
- No route/response shape changes — the dispatcher is additive.
- `dispatch_enabled` defaults `0`; with it off, the server behaves exactly as today.
- Commit per increment.

---

## Increment 1 — the dispatch brain, in isolation (no wiring yet)
Build the decision logic as a pure, injectable module so it's unit-tested
without a live server, real processes, or touching the hot write paths.

**Files:** create `src/dispatch.js`, `test/dispatch.test.js`.

- `createDispatcher({ db, spawn, now })` returns `{ onChange(), reconcile(), liveCount(), stop() }`.
- **Config read** (hybrid, from `settings`): `dispatch_enabled`, `dispatch_interval_ms`,
  `dispatch_debounce_ms`, `reconcile_interval_ms`, and `dispatch_agents` (JSON,
  validated, default `{}` → `{claude:{cmd,max}, …}`). Bad JSON → `{}` + a warn, never throw.
- **Predicates** (Q3): `claimable(agent)` = `status='active' AND assignee=? AND vetted=1`;
  `executing(agent)` = `count(status='in_progress' AND assignee=?)`. Reuse the
  exact `queue`-view filter.
- **Decision** `onChange(agent)`: enabled? agent in config? `claimable(agent)>0`?
  `executing(agent) < max`? no live orchestrator for agent? → debounce → `spawn(cmd, agent)`.
- **Registry**: in-memory `{agent → {pid, startedAt}}`, cleared on child exit.
- `spawn` is **injected** — tests pass a fake; real wiring comes in Increment 3.
- **Tests**: disabled → no spawn; not-configured agent → no spawn; at watermark → hold;
  live orchestrator → skip; debounce coalesces a burst into one spawn; claimable=0 → no spawn;
  reconcile spawns for an agent with claimable work the event path "missed".

*Zero production wiring — the module isn't imported by the server yet. Green by construction.*

## Increment 2 — the event bus + emit at the write sites
**Files:** modify `src/api.js` (buildApp), `test/api.test.js`.

- In `buildApp`, create `const bus = opts.bus ?? new EventEmitter()`; return it on the app handle.
- Add `changed(task)` → `bus.emit('task.changed', { id: task.id, assignee: task.assignee, status: task.status })`.
- Call `changed(...)` after each mutation that can produce a claimable state:
  `createTask`, claim, finish, block, **answer**, **vet**, complete, approve, and the
  PATCH path (assignee/status changes). (These are the existing `postEvent` sites plus
  create/claim/vet/PATCH.)
- **Tests**: subscribe a spy to the bus; assert exactly one `task.changed` per mutation with
  the right assignee/status. No response-shape change (existing api tests stay green).

*Bus has no consumer in this increment → still zero behavior change.*

## Increment 3 — wire the dispatcher to the bus + real spawn
**Files:** modify `src/server.js` (bootstrap), maybe `src/service.js` (spawn helper).

- Bootstrap: `const dispatcher = createDispatcher({ db, spawn: realSpawn, now });`
  `bus.on('task.changed', ({assignee}) => dispatcher.onChange(assignee));`
- `realSpawn(cmd, agent)`: `child_process.spawn` the configured `cmd` with the agent name in
  env/argv (absolute-path, reviewed script only; validate; never shell-interpolate task data).
  Register pid; unref; reap on exit.
- Start the reconcile timer (`reconcile_interval_ms`).
- **Still `dispatch_enabled=0`** → `onChange` short-circuits, nothing spawns. Manual test:
  set enabled + a fake `dispatch_agents.cmd=echo`, create a task, watch it fire once.

## Increment 4 — enable on this box, prove it, retire crons
- Set `dispatch_enabled=1` and `dispatch_agents.claude.cmd` = the real headless orchestrator
  (today's `claude-queue-sweep`, given the assignee), `max:1`.
- Leave the 3-min cron running as the reconcile backstop; watch the dispatcher beat it
  (sub-second pickup, zero empty wakes) in the doctor's Cron/logs.
- Once trusted: drop `claude-queue-sweep`/`punchlist-queue-sweep` from `directives.json`;
  the in-server reconcile is the safety net. Update the doctor (crons section) + KB.

## Deferred (unchanged from the design doc)
Per-task concurrency mode (`dispatch_mode=per_task`); `event_consumers(name,cursor)` when a
2nd consumer appears; outbound webhooks (the other half of the 011 event log).

## Order of risk
Inc 1 (isolated, pure) → Inc 2 (additive emits, no consumer) → Inc 3 (wire + spawn, still
gated off) → Inc 4 (flip the flag). The first live behavior change is Increment 4, one config
flip, reversible by setting `dispatch_enabled=0`.
