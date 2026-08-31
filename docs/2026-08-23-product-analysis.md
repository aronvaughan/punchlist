# av-tasks — Product Analysis & Feasibility

*Step 1 of the build plan. Decision: build vs use, scope, risks.*

## Problem

One task system usable equally by the human (phone + computers, visual,
drag-and-drop) and by agents (Claude Code, Hermes — create/query/complete
tasks conversationally, tie tasks to our DOMAINS). Must be free, private,
reachable from anywhere on the tailnet, and survive disk loss.

Requirements (v1): tasks, steps (sub-items), projects mapped to domains,
due dates, tags, **Inbox for triage**, **recurring tasks**, drag-and-drop
ordering, done/archive. Out of v1: sharing/multi-user, push notifications
(agents nag via Telegram instead).

## Alternatives considered

| Option | Why not |
|---|---|
| TickTick / Todoist | API paywalled / subscription; data off-prem. Removed their artifacts 2026-08-23. |
| Things | One-time paid, Apple-only, effectively no read API — agents blind. |
| Apple Reminders + CalDAV | Native polish, but iOS's own subtask/tag features don't round-trip over CalDAV, and agent access from Linux is fragile. Rejected in brainstorm. |
| Vikunja (FOSS) | Closest existing fit: projects, labels, due dates, REST API. But: PWA-grade UI (dnd is clunky), recurring model limited, no notion of our domains, another upstream to track, and the API surface is large where we need ~10 endpoints. |
| taskwarrior | Great CLI/agent story, no acceptable phone/visual story. |
| Obsidian-tasks in kb | Free + versioned, but no dnd, fragile parsing for agents, sync friction on phone. |

**Verdict: build.** The scope is genuinely small (single user, one server,
~10 API endpoints, one page of UI), and the differentiators we actually
want — domain integration, agent-first API, our recurrence rules, our
backup/tailnet posture — are exactly the parts that are awkward to bolt
onto someone else's product. Vikunja is the fallback if this stalls.

## Feasibility

- **Stack fit:** the home server already runs node services under systemd user
  units with tailnet serve, restic backup, health checks, cron
  registration — av-tasks slots into every one of those patterns.
- **Effort estimate:** M0 API ~1 session; M1 UI (list + dnd + quick-add)
  1–2 sessions; M2 agent skills ~1 session; M3 deploy <1 session (patterns
  exist). Recurring engine is the only algorithmically fiddly part.
- **Risks:**
  1. *Recurring tasks* — completion-relative vs schedule-relative repeats;
     mitigate by supporting a small explicit set (daily/weekly/monthly/
     every-N, from-completion flag), not RRULE generality.
  2. *Drag-and-drop* — solved problem (SortableJS / native HTML5 DnD);
     keep ordering server-side as a float/rank column.
  3. *Maintenance burden* — we own bugs; mitigated by tiny scope, tests in
     M0, and the agents themselves being the maintainers.
  4. *Phone experience* — web app over tailnet; must stay fast and
     thumb-usable; test on the iPhone early (M1 acceptance).

## Success criteria (v1)

1. The maintainer manages a real week of tasks in it, from phone and desktop.
2. Claude and Hermes can each: add to Inbox, list today/overdue, complete,
   and file a task under a domain project — via the skill, no UI.
3. A recurring task regenerates correctly at least once in production.
4. Restore-from-restic drill passes (same as OV: dump → restore → serve).
