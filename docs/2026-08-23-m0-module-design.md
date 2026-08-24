# M0 Module Design — code units & interfaces (rev 2, post-review)

*Design pass before coding. Rev 2 incorporates the 2026-08-23 adversarial
design review (2 independent reviewers, 31 findings — resolutions below).
Architecture: 2026-08-23-architecture.md.*

## Units (one file = one responsibility)

```
src/db.js        open(path) -> {db, migrate()}     ; node:sqlite, WAL,
                 PRAGMA foreign_keys=ON + busy_timeout=5000; migrations:
                 each NNN-*.sql runs in ONE transaction together with its
                 schema_migrations(version) insert; before applying, copy
                 db file aside (av-tasks.db.pre-NNN); on failure exit
                 with named error (no half-applied crash-loop)
src/rank.js      between(a,b) -> REAL; renormalize(db, scope) — same
                 transaction as the write that triggered it
src/recur.js     nextDue(rule, oldDueISO, completedISO, todayISO) -> ISO
                 spawn(tx, task, nextDue) -> newTaskId
src/quickadd.js  parse(text, {projects,tags}) -> fields   ; pure
src/views.js     taskWhere(view, params) -> {sql, args}   ; args only,
                 NO string interpolation, ever (invariant)
src/api.js       buildApp({db, tokens}) -> Hono app
src/server.js    entry; fail-closed startup; named EADDRINUSE error
```

Dependency direction: server → api → (db, views, rank, recur, quickadd).
Pure units know nothing about HTTP; db knows nothing about routes.
**The API is the only write path to the database — invariant.**

## Schema (rev 2)

```sql
projects(id TEXT PK, name TEXT UNIQUE, notes TEXT DEFAULT '',
         parent_id TEXT NULL REFERENCES projects(id) ON DELETE RESTRICT,
         domain TEXT NULL, rank REAL, archived INT DEFAULT 0,
         created_at, updated_at)
tasks(id TEXT PK, title, notes DEFAULT '',
      project_id TEXT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      status TEXT CHECK(status IN ('active','done','archived')),
      when_type TEXT NULL CHECK(when_type IN ('date','someday')),
      when_date TEXT NULL,
      CHECK ((when_type='date') = (when_date IS NOT NULL)),
      due_date TEXT NULL, due_time TEXT NULL,
      rank REAL,               -- order within (project, section)
      today_rank REAL NULL,    -- manual order in the global Today view
      recur TEXT NULL,         -- JSON; recur NOT NULL requires due_date
      spawned_from TEXT NULL REFERENCES tasks(id),
      created_by TEXT,         -- set by SERVER from auth token, never client
      completed_at NULL, created_at, updated_at)
steps(id PK, task_id REFERENCES tasks(id) ON DELETE CASCADE,
      title, done INT DEFAULT 0, rank REAL)
tags(id PK, name TEXT UNIQUE COLLATE NOCASE)
task_tags(task_id REFERENCES tasks(id), tag_id REFERENCES tags(id),
          PRIMARY KEY(task_id, tag_id))
```

**Inbox is DERIVED, not stored** (review C5): inbox = `status='active' AND
project_id IS NULL AND when_type IS NULL`. No 'inbox' enum value; the
whole graduation-rule class of bugs disappears.

## View semantics (single source: views.js)

- Live filter used by today/upcoming/overdue: `status='active'`.
- **today**: `status='active' AND ((when_type='date' AND
  when_date<=:today) OR due_date<=:today)` (status filter covers BOTH
  disjuncts — review C1). Sort: `today_rank ASC NULLS LAST, when_date,
  rank`; manual drag in Today sets `today_rank` (review C3); arrivals
  append after manually-placed items (review I11).
- **overdue**: `status='active' AND due_date<:today` (review C6 — agent
  contract).
- **upcoming**: future `when_date`, grouped by date. **logbook**: done,
  by completed_at desc. **search**: LIKE with `ESCAPE '\'`, server
  escapes `% _ \` in the query (no FTS5 in v1 — review O6).
- Sections in a project: TODAY (arrived) → UPCOMING → ANYTIME → SOMEDAY.
  A someday task with an arrived due appears in Today (deadline chip) but
  its project section stays SOMEDAY (review C13).
- All list endpoints: `?limit=` (default 100, max 500) + keyset
  `?cursor=` (ULID); response `{items, next_cursor?}` (review O5).

## Recurrence (rev 2)

- `recur` requires `due_date`; quick-add/POST default due=today when a
  recurrence is given without one (review C4).
- Anchors: `due` — next = first schedule tick **strictly after
  max(oldDue, today)** (always future; no same-day respawn — review I7);
  `completion` — next = tick relative to completion DATE (local ISO;
  server converts completed_at before calling — review I9);
  completion-anchored weekly(days) = first listed weekday strictly after
  completion date.
- monthly(dom): clamp to last day of short months, non-sticky (March
  returns to the 31st) (review I8).
- Spawn = `{status:'active', when_type:'date', when_date:nextDue,
  rank:end of target section, spawned_from:old id, copies steps
  (unchecked), tags, project}` (review I10).
- **Completion is a guarded transition** (review O4): `UPDATE ... SET
  status='done' WHERE id=? AND status='active'`; spawn only if
  changes==1; repeat call → 200 with the already-done task (idempotent).
- `PATCH status:'done'` → 400 "use /complete" (all tasks — one door for
  done; review C2). PATCH to 'archived' on a recurring task ends the
  series (documented). Undo-complete does NOT retract a spawn (v1 call —
  review M18).

## API (rev 2)

```
GET  /api/v1/tasks?view=inbox|today|upcoming|overdue|logbook
                  &project=&tag=&q=&limit=&cursor=
POST /api/v1/tasks                (structured fields only)
POST /api/v1/tasks/quickadd       {text} — token parsing lives here only
                                  (review C15); Mail-to-Inbox uses
                                  structured POST with literal title —
                                  email content NEVER goes through token
                                  parsing (review O11)
PATCH /api/v1/tasks/:id           sparse; unknown field=400; size caps:
                                  title<=500, notes<=64KB, steps<=100,
                                  tags<=20 (review O11); all JSON bodies
                                  (every POST/PATCH) capped at 256KB
                                  BEFORE parsing -> 413
POST /api/v1/tasks/:id/complete   idempotent (above)
POST /api/v1/tasks/:id/reorder    {before_id?, after_id?, list?} —
                                  neighbor ids, never raw ranks;
                                  list: 'project' (default) reorders rank
                                  within the (project, section) scope,
                                  'today' reorders today_rank in the
                                  global Today view (review C3);
                                  validates neighbors still in scope else
                                  409 + current list; renormalize in same
                                  tx (review M10)
POST /api/v1/tasks/:id/steps      create
PATCH/DELETE /api/v1/tasks/:id/steps/:sid   title/done/rank; delete
GET/POST/PATCH /api/v1/projects   tree via parent_id; GET takes
                                  &limit=&cursor= like every list
                                  endpoint (review O5); cycle check walks
                                  ancestors on PATCH (review I12)
GET  /api/v1/health               unauthenticated
```

## Auth & headers (rev 2)

- `AV_TASKS_TOKENS` = `name:token,name:token` (aron, claude, hermes,
  email) — middleware maps token → actor, **server sets created_by**;
  client-supplied created_by rejected (review O3). Rotation = add new,
  remove old; runbook line in kb/ops.
- Fail closed: no tokens configured or any token <32 chars → refuse to
  start, loud message. Install script chmod 600 data/.env (review O9).
- Invariant: auth is header-only bearer (CSRF-immune); never move to
  cookies without adding CSRF defenses.
- Static UI served with CSP: `default-src 'self'; script-src 'self';
  connect-src 'self'; object-src 'none'; base-uri 'none'` (review O1).
  Titles render as text always; notes markdown rendered with raw HTML
  disabled + sanitizer (M1, but the API commits now: stored raw,
  encoded at render; email-derived content is untrusted).

## Backup (rev 2 — review O2)

restic must never read the live WAL db. server exposes nothing; instead
`scripts/db-snapshot.sh` runs `VACUUM INTO data/backup/av-tasks-snapshot.db`
(atomic), and the restic set includes `data/backup/` + `data/.env`
(caveat documented: token rotation assumes old backups burned).
Cron: snapshot at 2:50, restic at 3:00.

## Test plan (80% coverage floor)

recur ≥24 table cases (both anchors × on-time/late/very-late ×
daily/weekly-multi/monthly-31st/every-N; DST dates; null-due rejection);
quickadd ≥12; rank invariants + renorm; views: today excludes done
(review C1 pin), overdue, someday+due chip case (C13 pin), LIKE escaping
(`% _ " '`); api: every route happy+auth+validation, complete-twice→one
spawn, PATCH done→400, reorder stale-neighbor→409, pagination, size
caps, per-token created_by. Gate: `node --test
--experimental-test-coverage` ≥80% lines.

## Review log

- 2026-08-23 rev 1 → adversarial review: correctness reviewer (19
  findings) + security/ops reviewer (12 findings). All CRITICAL/IMPORTANT
  resolved in rev 2 (this doc); notable accepted-risks: undo doesn't
  retract spawns; .env inside backup set (rotation caveat).
```
