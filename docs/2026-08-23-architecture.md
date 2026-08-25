# av-tasks — Architecture (v1)

*Step 3 of the build plan. How it's built. PRD: 2026-08-23-prd.md.*

## Principles

Agent-friendly means: no build step, tiny dependency surface, one process,
plain files an agent can read end-to-end, JSON API identical for humans'
UI and agents' skills. Boring on purpose.

## Stack

- **Runtime:** Node 26 (already on the box), single process.
- **HTTP:** Hono (one small dep) serving both `/api/v1/*` and static UI.
- **Storage:** `node:sqlite` (built-in, zero native deps — same engine the
  hermes sweep reads), WAL mode, one file `data/punchlist.db`.
- **Frontend:** vanilla ES modules + **Web Awesome** free core (the
  Shoelace successor — Shoelace archived 2026-05; wa- components, vendored
  ESM, no build) for inputs/drawer/toasts, + SortableJS (vendored, no CDN,
  no bundler). One HTML page, hash-routed views.
- **Tests:** `node:test` against the API over an in-memory/db-file.

## Data model (SQLite)

```sql
projects(id, name, notes, parent_id NULL→projects.id, domain TEXT NULL,
         rank REAL, archived INT, created_at, updated_at)
tasks(id, title, notes, project_id NULL, status TEXT
        CHECK(status IN ('inbox','active','done','archived')),
      when_type TEXT NULL CHECK(when_type IN ('date','someday')),
      when_date TEXT NULL,          -- ISO date; arrived = when_date <= today
      due_date TEXT NULL, due_time TEXT NULL,
      rank REAL,                    -- manual order within its section
      recur JSON NULL,              -- {freq, days?, dom?, n?, anchor:'due'|'completion'}
      created_by TEXT,              -- alex|claude|hermes|email
      completed_at NULL, created_at, updated_at)
steps(id, task_id, title, done INT, rank REAL)
tags(id, name UNIQUE);  task_tags(task_id, tag_id)
```

Views are queries, not state: Today = `when arrived OR due<=today`,
Upcoming = future when_date, Logbook = done ordered by completed_at.
Section membership inside a project derives from when-fields; `rank`
orders within a section (fractional re-rank on drag, renormalize when
gaps exhaust).

## Recurrence engine

On completing a task with `recur`: compute next due — anchor `due`:
next = schedule tick after the OLD due (never skips; catches up to the
first future tick); anchor `completion`: next = completed_at + interval.
Spawn a fresh task (copying steps unchecked, tags, project) with
`when_date = next due`. Pure function + table-driven tests; no cron
needed (spawn happens at completion time).

## API (bearer-token, JSON)

```
GET/POST/PATCH        /api/v1/tasks         ?view=inbox|today|upcoming|logbook
                                            &project=&tag=&q=
POST                  /api/v1/tasks/:id/complete | /reorder | /steps ...
GET/POST/PATCH        /api/v1/projects      (tree via parent_id)
GET                   /api/v1/health
```

Quick-add parsing (`#tag @project !due ^when` tokens) happens server-side
so agents and UI share it.

## Auth & deploy

- Single shared secret: `PUNCHLIST_TOKEN` in `data/.env` (gitignored).
  Browser: token pasted once into localStorage via a login prompt; agents:
  env/secrets.local.env. Single-user by design.
- Bind 127.0.0.1:8600; expose via `tailscale serve --tcp 8600` (same
  pattern as OV :1933 — no Host-header trap, tailnet-encrypted).
- systemd user unit `av-tasks.service` (install script, register-crons
  pattern); restic covers `data/`; health line added to ecosystem-status
  and system-health-check; DOMAINS.md row under agent-ops.

## Agent access

- `av-tasks` skill in claude-config and hermes (thin curl wrappers over
  the API, same shape as av-ov). Mail-to-Inbox = a hermes email-triage
  rule that POSTs to /tasks. MCP wrapper deferred until skills prove
  insufficient.

## Error handling

API: 4xx with `{error}` JSON, never HTML; unknown fields rejected.
UI: optimistic updates with rollback on non-2xx + toast. DB: WAL +
restic; schema migrations = numbered SQL files applied at boot.
