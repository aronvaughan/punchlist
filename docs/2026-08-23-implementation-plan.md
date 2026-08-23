# av-tasks — Implementation Plan (v1)

*Step 5. Four milestones; each ends runnable + tested + committed, with a
summary to Aron before the next begins. Architecture:
2026-08-23-architecture.md.*

## M0 — Core: schema + API (no UI)

- [ ] Scaffold: package.json (hono only), src/, migrations/, test/,
      .gitignore (whitelist-first; data/ ignored), vendor/ dir
- [ ] migrations/001-init.sql per architecture data model; migration
      runner applies numbered files at boot
- [ ] src/db.js (node:sqlite open+WAL+migrate), src/rank.js (fractional
      ranking + renormalize)
- [ ] src/recur.js — pure recurrence engine (both anchors); table-driven
      tests first (late completion, month-end, weekly multi-day)
- [ ] src/quickadd.js — token parser (#tag @project !due ^when) + tests
- [ ] src/api.js — routes per architecture; bearer auth middleware;
      views as queries (inbox/today/upcoming/logbook, arrived-when rule)
- [ ] test/api.test.js — CRUD, views, sections ordering, reorder,
      complete-spawns-recurrence, quick-add
- [ ] `npm test` green; commit per component

## M1 — Web UI

- [ ] Vendor Web Awesome free core + SortableJS into vendor/
- [ ] public/index.html — rail (Inbox/Today/Upcoming/Logbook/project
      tree), list pane, slide-over detail (wa-drawer)
- [ ] public/app.js + views.js — hash routing, fetch wrapper w/ token
      prompt→localStorage, optimistic updates + rollback toast
- [ ] Project view: 4 sections (TODAY/UPCOMING/ANYTIME/SOMEDAY dimmed);
      drag within = rank, drag across sections = when edit; drag Inbox
      item onto project in rail = file it
- [ ] Quick-add bar (`n`), search (`/`, full-text), tag chips
- [ ] tokens.css — Things-ish look: airy lists, SF stack, soft shadows
- [ ] Acceptance: works thumb-sized on iPhone Safari over tailnet

## M2 — Agents

- [ ] ~/.claude/skills/av-tasks/ — SKILL.md + tasks.sh (add/list/
      complete/update/move/projects), token via secrets pattern
- [ ] hermes skills/common/av-tasks/ — same script, hermes wording
- [ ] Mail-to-Inbox: hermes email-triage rule → POST /tasks (created_by
      email)
- [ ] DOMAINS.md: projects↔domains linkage documented; both skills
      committed

## M3 — Deploy + ops

- [ ] scripts/install/setup-service.sh → av-tasks.service systemd user
      unit (bind 127.0.0.1:8600); tailscale serve --tcp 8600
- [ ] Token: data/.env generation; agents' secrets wiring
- [ ] restic: add av-tasks data dir; ecosystem-status + system-health
      lines; DOMAINS.md row (agent-ops)
- [ ] GitHub private repo + push; nightly-git-backup picks it up
      (parent dir scan)
- [ ] Restore drill: restic restore db → boot → health 200

## Working agreement

Subagent-driven per milestone (implementer + review), TDD for engine/API,
summary + Aron's go between milestones. Scope changes go to the PRD
first.
