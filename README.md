# av-tasks

Things-ish personal task manager, built agent-first: one REST API serving a
drag-and-drop web UI (humans) and the av-tasks skills (Claude + Hermes).
Self-hosted on the agent server, tailnet-only.

Docs: docs/ (product analysis, PRD, architecture). Built with GSD phases.

## M0 (API core)

- Run: `AV_TASKS_TOKENS="aron:<32+ char token>,claude:<token>" npm start`
  (or put `AV_TASKS_TOKENS=...` in `data/.env`, chmod 600 — the server
  warns at startup if the file is group/other-readable; the M3 install
  script will enforce this). Binds
  127.0.0.1:8600; `AV_TASKS_PORT`/`AV_TASKS_HOST`/`AV_TASKS_DATA` override.
  Startup fails closed without well-formed tokens.
- Test: `npm test` (node:test + coverage; 80% line floor over src/).
- Backup: `scripts/db-snapshot.sh` writes a WAL-safe
  `data/backup/av-tasks-snapshot.db` via `VACUUM INTO`; point restic at
  `data/backup/` + `data/.env` (cron: snapshot 2:50, restic 3:00).
- API: see `docs/2026-08-23-m0-module-design.md` (rev 2 is the contract).
