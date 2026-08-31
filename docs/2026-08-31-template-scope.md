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

## Task-driven authoring (the point)

No new UI required. An agent working a template task:

1. `plt validate` / read existing (or scaffold a new frontmatter skeleton).
2. `POST /templates/<name>/ai-edit` to draft (tool-less `claude -p`, as v1).
3. Owner reviews the live draft.
4. `POST /templates/<name>/save` with `scope` (default `instance`) — validate +
   local commit (global) or write to `data/templates` (instance). Push stays
   ask-gated / `allow_push`-authorized.

Optional later: a scope toggle in the existing editor dialog; a "move scope"
action (instance ↔ global = read one plane, write the other, remove source).

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

(1–4 = MVP.) 5. move-scope + UI toggle — later, only if wanted.

## Out of scope

- workflow-writer (deferred; workflows reference templates per-step — build with
  the first real workflow).
- The other five v2 candidates (browser, in-place pack edits, server-side chat
  state, auto push/deploy, per-task-output filling) — all requestable via tasks
  once this API exists, or explicitly declined (#6 redundant with agents).
