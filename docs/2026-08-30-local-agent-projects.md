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

## Data governance & isolation (foundational — read first)

**Principle: private by default; publish deliberately.** Two planes:

- **Public / open-source-safe** — the ONLY plane that leaves a machine: punchlist
  code, the templates/workflows we ship (`packs/`), the global pl skills + KB that
  ship with punchlist. Generic, with **no client *or personal* specifics**. When
  punchlist is open-sourced, only this plane is exposed.
- **Private (the default for everything else):** an instance's task data, client
  codebases, **and Aron's own personal work.** Personal work follows the SAME
  isolation rules as client work — open-sourcing pl would leak it too. Private
  content never enters the public plane.

Classification is therefore binary and default-private: an artifact is either
**generic → open-source-safe (global)** or **private (client OR personal) → local,
isolation applies.**

### Artifact homes (global vs `data/`)

| Kind | Global (shipped, tracked, publishable) | Instance-local (private, under `data/`) |
|---|---|---|
| Templates | `punchlist-templates/**/packs/` (+ pl-shipped) | `data/templates/` |
| Skills | pl-shipped + global `~/.claude/skills/**` (generic only) | `data/skills/` |
| KB articles | pl-shipped KB | `data/kb/` |
| Task data | — (never global) | `data/` (SQLite) |

`data/` is already gitignored from the pl repo, so everything private sits under
one boundary. Instance skills under `data/skills/` are surfaced to the local
Claude via a known path/symlink (e.g. a gitignored `~/.claude/skills-local` →
`data/skills`) so agents can use them without them entering tracked
`~/.claude/skills/`.

**Gap to close:** templates `authored/` is currently *tracked* — on an isolated
instance, locally-authored templates must live in `data/templates/`, not the
shared repo.

### Instance data persistence (the private plane needs a safe home)

`data/` holds private IP and must be durable **without leaking**. pl gains a
per-instance **backup config**:

- **`backup_mode`**: `repo` | `snapshot` | `both`
- **`repo`** — commit a *scrubbed* dump (tasks/projects/context +
  `data/{skills,templates,kb}`; **never `.env`/tokens/secrets**) to a **private,
  safe-to-push repo** (configurable path/remote + `gh` login). This is "the data
  dir optionally committed to a repo safe to push to."
- **`snapshot`** — the existing nightly WAL-safe `scripts/db-snapshot.sh` +
  `nightly-restic-backup.sh` (the cron you remembered).
- **`both`** — repo for portability/history + snapshot for disaster recovery.

Secrets are ALWAYS excluded from any pushable backup.

### Making agents comply

`data_isolation` (default **ON**) drives the sweep directive:
- Default every new artifact to `data/` (private).
- Write to a global/tracked location ONLY when the content is generic and
  open-source-safe — and even then via a task/local-commit the human reviews
  (push = ask).
- Client code → local commits to its own `working_dir` repo.
- Routing is **structural**: tracked path = publishable, `data/` = private; the
  agent is handed both paths and the rule.

### Governance audit (compliance check — do before relying on this)

Evaluate existing on-disk artifacts (skills, templates, KB, notes) and classify
each: keep in the **global/open-source** plane, or move to **private** (`data/`,
isolation applies — client OR personal). Verify nothing private currently sits in
a to-be-published location, and that we comply going forward. Tracked as its own
audit task(s).

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
  Keys used now: `instance_name`, `instance_context`, `data_isolation` (default
  `'1'` = on), `backup_mode` (`repo|snapshot|both`, default `snapshot`),
  `backup_repo` (path/remote, default `''`). Seed strings to `''` / defaults above.

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

0. **Governance foundation** *(bumped ahead — everything else assumes it):*
   settings store + `data_isolation` flag; create the `data/{skills,templates,kb}`
   private dirs + the `~/.claude/skills-local → data/skills` surface; the sweep
   directive that routes artifacts (private-by-default); and the **audit** pass to
   classify existing on-disk artifacts (global vs private) and verify compliance.
1. **`projects.working_dir`** — migration + API + project-view UI + sweep `cd` +
   inject project context. *(core)*
2. **Instance identity** — `/instance` endpoints (name, context, isolation) +
   footer name + Instance dialog + sweep injects instance context.
3. **Instance data persistence** — `backup_mode`/`backup_repo`; a scrubbed dump
   command (never secrets) + wire `repo`/`snapshot`/`both` to the existing crons.
4. **Install wiring** — `setup.sh` runs `install -t claude` + `install-skills`
   (punchlist + plt); add the `CLAUDE.base.md` punchlist + two-planes stanza.

## Out of scope (follow-ups)

- Per-project template linking + project-specific template editing (the original
  task's secondary ask) — revisit once working_dir + plt provisioning land.
- Central multi-machine dashboard (aggregating several instances) — the per-Mac
  model is deliberate for now.
- Auto-injecting project context on *every* agent session (vs. the sweep reading
  it per task) — start with the sweep; generalize later if useful.
