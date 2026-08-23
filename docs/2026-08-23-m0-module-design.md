# M0 Module Design — code units & interfaces

*Design pass before coding. Reviewed adversarially before implementation
(see review log at bottom). Architecture: 2026-08-23-architecture.md.*

## Units (one file = one responsibility)

```
src/db.js        open(path) -> {db, migrate()}     ; node:sqlite, WAL,
                 applies migrations/NNN-*.sql in order, records in
                 schema_migrations(version)
src/rank.js      between(a,b) -> REAL              ; fractional rank
                 needsRenorm(list) / renormalize(db, scope)
src/recur.js     nextDue(rule, oldDue, completedAt, today) -> ISO date
                 spawn(db, task) -> newTaskId      ; copies steps/tags
src/quickadd.js  parse(text, {projects,tags}) ->   ; pure
                 {title, tags[], project?, due?, when?}
src/views.js     taskWhere(view, params) -> {sql, args}  ; inbox|today|
                 upcoming|logbook|project|tag|search; section() ->
                 TODAY|UPCOMING|ANYTIME|SOMEDAY for a task row
src/api.js       buildApp({db, token}) -> Hono app ; routes, bearer
                 middleware, zod-free hand validation (reject unknown
                 fields), JSON errors {error}
src/server.js    entry: env, db open, listen 127.0.0.1:8600
```

Dependency direction: server → api → (db, views, rank, recur, quickadd).
Pure units (rank, recur, quickadd, views) know nothing about HTTP; db
knows nothing about routes. Every pure unit is table-driven testable.

## Key decisions

1. **Arrived-when rule lives in ONE place** — views.js `today` query:
   `(when_type='date' AND when_date<=:today) OR (due_date<=:today AND
   status IN ('inbox','active'))`. `:today` is always passed in (server
   computes once per request; tests inject) — no SQL `date('now')`, so
   timezone behavior is explicit and testable.
2. **Timezone:** server runs in America/Chicago; "today" = local date
   string computed in server.js. All dates are ISO `YYYY-MM-DD` strings;
   no Date arithmetic across DST in SQL.
3. **Recurrence catches up:** due-anchored next = first schedule tick
   strictly after max(oldDue, today-1) — a task completed 3 weeks late
   spawns ONE next occurrence in the future, not 3 stale ones.
4. **Spawn transactionality:** complete+spawn in one transaction; the
   spawned task links `spawned_from` for traceability.
5. **Ranks are per-scope** (project+section for tasks, task for steps);
   renormalize lazily when |a-b| < 1e-9.
6. **API contract:** PATCH accepts sparse bodies; unknown field = 400;
   all list responses `{items:[...]}`; ids are ULIDs (sortable, no dep —
   26-char crockford from crypto.randomBytes).
7. **Auth:** constant-time token compare; /api/v1/health unauthenticated.

## Test plan (80% coverage floor)

- recur: table of ≥20 cases (daily/weekly-multi/monthly-31st/every-N ×
  both anchors × on-time/late/very-late; DST boundary dates)
- quickadd: ≥12 cases incl. escaping, unknown @project, date words
  (!fri, !2026-09-01, ^today, ^someday)
- rank: ordering invariants + renormalize trigger
- api: every route happy+auth-fail+validation-fail; views vs seeded
  fixture db; reorder; complete-spawns; steps CRUD
- Coverage: `node --test --experimental-test-coverage` gate ≥80% lines
  in package.json test script (CI-ready).

## Review log

- 2026-08-23: adversarial design review (2 independent reviewers) — see
  commit history for resolutions.
