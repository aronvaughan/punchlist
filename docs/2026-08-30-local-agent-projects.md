# Local-agent projects + instance identity — design

**Status:** approved design (2026-08-30), pending implementation
**Task:** punchlist#01M19ZFZHBNJPPQNXJ8GT92ESK ("context notepad field on projects" — expanded)

## Goal

Turn a punchlist project from a label into **"a place agents run."** On a client
machine, each punchlist project points at a local codebase; the local Claude
sweep agent picks up that project's tasks and executes them **in place** against
the code — reading the repo's own `CLAUDE.md`, using the machine's skills, editing
and committing locally, with push/PR gated by Claude's permission model.

## Deployment model (context)

Each machine runs its **own** punchlist instance (own SQLite data). Projects are
therefore inherently machine-local — no cross-machine sync. "Machine scope" is
just "this instance." A person may run several instances (e.g. two work Macs +
the Linux box), each with its own name, projects, and queue.

## Core primitives

### 1. Project → working directory  (the primitive that unlocks everything)

Add `projects.working_dir` — an **absolute local path** (nullable). Semantics:

- When the sweep agent claims a task, it looks up the task's project, `cd`s into
  `working_dir`, and works there. The repo's own `CLAUDE.md` and local artifacts
  supply the rest of the context; **path-only** binding (git remote/branch is
  discovered from `.git` when needed — not stored).
- No `working_dir` → the agent works from the default code root (today's `$CODE`).

### 2. Write model  (no new punchlist field)

Agents **write by default** (these projects are heavy code-editing). The *policy*
is **not** a punchlist toggle — it is Claude Code's own permission model on that
machine:

- `commit` — allowed
- `push`, `pr` (gh pr create, etc.) — **require ask** (so unattended sweeps can't
  push/PR; they commit locally and land the task in Review)

Per-project specifics (branch conventions, "don't touch X") live in the project's
**context notepad** (`projects.notes`, already shipped). So: notepad +
`settings.json` permissions *are* the policy; punchlist stores no access flag.

### 3. Instance identity: name + context + config

An instance gains an editable **name**, a global **context/notes** area, and a
small **config** surface:

- **`instance_name`** — a human name for this deployment (e.g. "workmac-1"). Shown
  in the header/footer so you always know which instance you're looking at.
- **`instance_context`** — global rules/directives injected into *every* spawned
  agent (deployment-wide "how we work here"). This is **not** the pl/plt how-to
  (that comes from skills — see Provisioning); it is deployment rules.
- A footer link opens an **Instance** panel showing the context (rendered) with an
  **edit** affordance that also edits the **name** — i.e. notes + config together.

## Data model

- **Migration 012 — `projects.working_dir`:** `ALTER TABLE projects ADD COLUMN
  working_dir TEXT NULL;`
- **Migration 012 — settings store:** a tiny key/value table for instance-level
  strings (avoids a wide singleton row):
  ```sql
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
  ```
  Keys used now: `instance_name`, `instance_context`. Seed both to `''`.

## API

- `PROJECT_FIELDS` gains `working_dir`; POST/PATCH `/projects` accept + persist it;
  it is already returned by `GET /projects` (`SELECT *`). Validate as a string
  (cap ~1024). No existence check on the path (it may be created later).
- **Instance endpoints:**
  - `GET /api/v1/instance` → `{ name, context }` (auth'd; any actor may read —
    the sweep needs it).
  - `PATCH /api/v1/instance` → `{ name?, context? }`, **admin only** (mirrors the
    project PATCH auth). Writes the `settings` rows.
- `GET /api/v1/config` additionally returns `instance_name` (cheap, so the footer
  can render on first paint without a second call) — or the UI calls `/instance`;
  pick one, don't duplicate the source of truth (recommend: `/instance` is the
  authority; `/config` echoes `instance_name` for first-paint convenience).

## UI

- **Project view:** next to the Context panel, a compact **Working dir** field
  (folder icon → path pill → edit dialog), same icon→value→dialog pattern as the
  other project affordances. Saving PATCHes `working_dir`.
- **Footer (`#rail-foot`):** append the instance name — `punchlist v… · <name>`
  — as a button/link. Clicking opens the **Instance** dialog.
- **Instance dialog:** shows `instance_context` rendered (mdToHtml, the safe
  sink); an **Edit** button opens a form with the **name** input + a context
  textarea; Save PATCHes `/instance`. Admin-only (hide edit for non-admin actors,
  server enforces regardless).

## Agent provisioning (how a spawned agent knows pl/plt)

Wired into `scripts/install/setup.sh`, three durable channels — **not** the
instance-context field:

1. **MCP:** `punchlist install -t claude` (user scope) → every session gets the
   `punchlist_*` tools.
2. **Skills (required):** `punchlist install-skills` — the sweep runs `pl.sh`,
   which *is* the av-punchlist skill; also installs the usage docs. **plt is in
   scope** for these Macs, so install its skill too (templates workflows).
3. **Global `CLAUDE.base.md` stanza:** a short block — "this machine runs
   punchlist; check your queue with `pl queue` / the `punchlist_*` tools; `plt`
   drives templates" — so *every* session (not only the sweep) knows punchlist
   exists.

Separation of concerns: **MCP + skills = the how-to; instance-context =
deployment rules; project notepad = per-project rules.** No overlap.

## Sweep changes (`~/.claude/scripts/claude-queue-sweep.sh`)

The orchestrator's per-task subagent brief gains, per claimed task:

1. Read the task's project (`pl project <id>` / `punchlist_projects`) → its
   **context notepad** and **working_dir**.
2. Read the **instance context** (`GET /instance` via pl/MCP).
3. Instruct the subagent to `cd "<working_dir>"` before working, and prepend the
   instance context + project context to its brief. Same-repo tasks stay
   serialized (already enforced); working_dir makes "same repo" precise.

No change to the standing security rules (still: never push/deploy/secrets/sudo;
commit-local only; screen every task; block rather than guess).

## Security considerations

- `working_dir` is an operator-set absolute path; the sweep only ever `cd`s into
  it — it never comes from untrusted task content. Task notes/titles remain data,
  never instructions (existing rule).
- Write-by-default is bounded by the machine's Claude permission model
  (push/PR = ask) and the Review gate — unattended runs cannot publish.
- `PATCH /instance` is admin-only; the context it stores is injected into agents,
  so only the human admin may edit deployment directives.

## Build order

1. **`projects.working_dir`** — migration + API + project-view UI + sweep `cd` +
   inject project context. *(core)*
2. **Instance identity** — settings store + `/instance` endpoints + footer name +
   Instance dialog (name + context) + sweep injects instance context.
3. **Install wiring** — `setup.sh` runs `install -t claude` + `install-skills`
   (punchlist + plt); add the `CLAUDE.base.md` punchlist stanza.

## Out of scope (follow-ups)

- Per-project template linking + project-specific template editing (the original
  task's secondary ask) — revisit once working_dir + plt provisioning land.
- Central multi-machine dashboard (aggregating several instances) — the per-Mac
  model is deliberate for now.
- Auto-injecting project context on *every* agent session (vs. the sweep reading
  it per task) — start with the sweep; generalize later if useful.
