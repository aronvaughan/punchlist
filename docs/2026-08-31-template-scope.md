# Template scope (global vs instance) — design

**Status:** approved design (2026-08-31), pending implementation.
**Tracks:** template-editor v2 (`docs/2026-08-30-template-editor-v2-candidates.md`),
distilled to the one piece worth building; the rest runs through tasks.

## Goal

Give every template a **scope** — `global` or `instance` — and make the private
plane a first-class citizen. Then template authoring/editing needs no bespoke UI:
an agent working a "write a template with me" task uses the existing API
(`ai-edit` → `save`), and the owner reviews. The only new capability is *where a
template lives* and *the API to put it there.*

## Two planes (governance)

Mirrors the data-governance model (`docs/2026-08-30-local-agent-projects.md`):

- **`global`** — publishable, shipped: lives in `punchlist-templates`
  (`packs/` = shipped, `authored/` = repo-local overrides). Generic, no client/
  personal specifics. Leaves the machine when the repo is shared.
- **`instance`** — private: lives in `data/templates/<name>.md` (gitignored,
  never published). Client- or owner-specific templates.

**Default new templates to `instance`** (private by default); promoting to
`global` is a deliberate act, and the `punchlist-govern` guard already blocks
private content reaching a tracked (`global`) path.

## Resolution

One resolver, three roots, highest precedence first:

    instance (data/templates)  >  global authored  >  global packs

So a same-named `instance` template overrides a global one locally — the private
plane wins, matching "your machine, your override." A template's **scope is
derived from which root resolved it** (no stored scope field needed).

## Data model

No DB migration. Templates are files:

- `instance` → `<PUNCHLIST_DATA>/templates/<name>.md` (already scaffolded, gitignored)
- `global`   → `<PUNCHLIST_TEMPLATES_DIR>/templates/authored/<name>.md` (create path)
             / `.../packs/*/<name>.md` (shipped, read-only from the app)

## API changes

- **Read path (`src/templates.js`):** `resolveTemplatePath` gains the instance
  root at top precedence. Add a `templateScope(name)` helper → `instance |
  global | null`. Instance templates become readable + AI-editable through the
  existing `GET /templates/:name` and `ai-edit` unchanged.
- **List (`GET /api/v1/templates`):** merge the global `index.json` items with a
  live scan of `data/templates/*.md`; tag every item `scope`. Instance overrides
  a same-named global entry (dedupe by name, instance wins).
- **Write (`POST /api/v1/templates/:name/save`):** accept `scope` (default
  `instance`). `instance` writes `data/templates/<name>.md`; `global` writes
  `authored/` (today's behavior). `plt validate` runs for both. Create-new is the
  same path with a fresh name (name-collision check across BOTH planes).
- **Guard:** a `global` save runs the content through the governance rule (no
  private markers); an `instance` save is always allowed (private path).

## plt awareness

`plt` (agents/sweep use it) searches its `SEARCH_DIRS` under
`PUNCHLIST_TEMPLATES_DIR`. Add an **instance search dir** (`PLT_INSTANCE_DIR`,
default `<PUNCHLIST_DATA>/templates`) at top precedence, so `plt show/list/launch`
see instance templates too. Same precedence rule as the API.

## The split: UI does manual, tasks do AI

**UI (direct, manual — admin only):**
- **Create** a new template: name + scope + starter content (seeded with a valid
  frontmatter skeleton so `plt validate` passes).
- **Edit** an existing template's text and **Save** (plain save — not only AI).
- **Scope** control: set/switch `global` ⇄ `instance` (moving planes on save).
- Entry points: a "New template" action + editing any template (the existing
  template-picker pencil, extended from AI-only to create/edit/save/scope).

**Task system (AI improvement pass):** "improve template X with AI" is a task an
agent works — `POST /templates/<name>/ai-edit` (tool-less `claude -p`, as v1) →
owner reviews → `save`. The heavy/iterative AI work lives in the queue, not a
long-held UI session.

So: **UI to create/edit/save/scope; tasks to improve with AI.** Both write through
the same `save` endpoint (validate + scope routing); push stays ask-gated /
`allow_push`-authorized.

Later (optional): a dedicated "move scope" affordance beyond save-with-new-scope.

## Security / governance

- `instance` templates are private (`data/`, gitignored) — never published,
  backed up only via the instance backup config.
- `global` saves are content-guarded (govern) and reach a remote only through the
  human push gate — never automatically.
- Template editing stays admin-only + feature-gated (unchanged
  `requireTemplateEditing`).

## Build order

1. **Read path** — instance root in `resolveTemplatePath` + `templateScope()`; tests.
2. **List + scope** — `GET /templates` merges planes, tags scope; tests.
3. **Write path** — `save` honors `scope` (default instance) + create-new +
   collision check + global-content guard; tests.
4. **plt** — instance search dir; tests.
5. **UI — create/edit/save/scope** — a "New template" action + an editor that
   loads a template's text, edits it, sets scope (global/instance), and Saves
   through the endpoint; the existing template-picker pencil extends from AI-only
   to this create/edit/save/scope surface. Admin-only, feature-gated. Tests.

(1–5 = MVP.) Later: a dedicated move-scope affordance; keeping/relocating the
in-UI AI chat if wanted (default is AI-via-tasks).

## Out of scope

- workflow-writer (deferred; workflows reference templates per-step — build with
  the first real workflow).
- The other five v2 candidates (browser, in-place pack edits, server-side chat
  state, auto push/deploy, per-task-output filling) — all requestable via tasks
  once this API exists, or explicitly declined (#6 redundant with agents).
