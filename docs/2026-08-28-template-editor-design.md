# AI-assisted template editor (design)

**Shipped 2026-08-28.**

*Agreed with the owner 2026-08-28. Resolves task 01M1569 ("for a task —
there should be a way to edit a template with AI assistance"). Deferred
scope is tracked in 01M15BR5N9QASBYAF5FZXFS38R (v2 candidates).*

## What this is

From within punchlist, edit the **reusable template definition** (the
canonical `.md` in the separate `punchlist-templates` repo) with AI help,
conversationally, and save it back — validated and committed. It edits the
template *definition* (affects all future tasks that use it), not any one
task's filled-in output.

The AI is the local `claude` CLI, shelled out **text-only**: it returns
revised template markdown and a one-line note, nothing more. punchlist does
the file write, `plt validate`, and git commit itself. The spawned Claude
gets no tools, so a template edit can never execute anything on the machine.

## Decisions (locked)

1. **Target:** the reusable template definition → writes
   `templates/authored/<name>.md` in the templates repo. Editing a shipped
   `packs/*` template forks a copy into `authored/` (an override) rather
   than mutating the pack; `plt` already resolves authored over pack.
2. **Backend:** shell out to `claude -p` with the prompt on **stdin** (reuses
   the owner's Claude Code auth, no API key in env or repo). Feature is
   **off** — endpoints 404 — unless ALL hold: `PUNCHLIST_TEMPLATES_DIR` is a
   git working tree, the repo's own `bin/plt` exists (validation runs it —
   there is no global `plt`), AND the `claude` binary is on PATH. Public users
   without Claude Code simply don't see the feature; nothing breaks.
3. **Interaction:** conversational chat in the task drawer with a live
   rendered draft; iterate; **Save current draft**. The draft is the source
   of truth, re-sent each turn (claude `-p` is one-shot /
   `--no-session-persistence`).
4. **Entry point:** the template field in the inline task editor. Once a
   template is chosen there, a small **pencil** next to it opens the editor
   for that template. No new top-level surface. (A global template browser
   is v2.)
5. **Draft durability:** the in-progress draft + chat thread autosave to
   **`localStorage`, keyed by template name** — per-viewer, no server state,
   no DB table. Close/reopen restores them; **Save** clears them; an
   **"unsaved changes"** dot shows while a stored draft exists.

## Architecture

### Endpoints (punchlist, zero new runtime deps)

All three are **admin-only** (`actor === HUMAN`, else 403) and
**feature-gated** (404 unless templates-dir-is-git AND claude-on-PATH).

- `GET /api/v1/templates/:name`
  Returns the raw markdown of the resolved template (authored over pack).
  `:name` is sanitised (`^[a-z0-9-]+$`), the resolved path is
  realpath-contained under `PUNCHLIST_TEMPLATES_DIR/templates/` (the
  containment pattern already used for `PUNCHLIST_DOC_ROOTS`). 404 if no
  such template.

- `POST /api/v1/templates/:name/ai-edit`
  Body `{ messages: [{role, content}...], draft: string }`.
  Compiles a prompt = system(role + strict output contract) + the current
  `draft` + the `messages` thread, spawns `claude -p --no-session-persistence`
  with a bounded timeout (e.g. 120s) and **no tool access**, and parses the
  reply into `{ reply: string, draft: string }`. On timeout / spawn failure
  / unparseable output → 502 with a clear message; the client keeps the last
  good draft.

- `POST /api/v1/templates/:name/save`
  Body `{ draft: string }`. **Validate-then-write-then-commit:**
  1. Write `draft` to a temp file **named `<name>.md`** in a fresh temp dir
     (the filename must match so any filename↔frontmatter-`name` check in
     `plt validate` passes).
  2. Spawn `node <dir>/bin/plt validate <tempdir>/<name>.md` (the repo ships
     its own `plt`; it is not a global binary). A non-zero exit or any `FAIL
     <file>:<line>: <msg>` line means invalid — the `plt` findings (stdout)
     are captured and returned.
  3. If **invalid** → 422 `{ ok:false, validation }`, nothing written to the
     repo.
  4. If **valid** → write `templates/authored/<name>.md`, `git -C
     <templates repo> add` + `commit` (message
     `template(<name>): AI-assisted edit via punchlist`). **No push.**
  5. Return `{ ok:true, validation }`.

### AI invocation detail (the text-only contract)

The system prompt instructs Claude to act as a template editor and to
**return exactly two things, delimited**: a one-line human note and the full
revised template markdown (frontmatter + body). Example contract:

```
Return your answer as:
<<<NOTE
one sentence describing what you changed
NOTE
<<<TEMPLATE
---
name: ...
---
...full revised template...
TEMPLATE
```

punchlist splits on the delimiters. The template block becomes the new
`draft`; the note becomes the assistant `reply` shown in the thread. No
tools are offered to the spawned process, so the worst a bad/injected reply
can do is produce markdown — which is then gated by `plt validate` and the
owner's review before it can ever be written.

### Why stateless

The server persists nothing about the chat — no session table, no draft
row. Each turn reconstructs context from the client-sent `draft` + `messages`
(cheap, and claude `-p` is one-shot regardless). The only durable artifacts
are the saved `.md` file and its git commit. Client-side `localStorage`
covers "don't lose my work on close" without server or multi-session state.
(Server-side / multi-session chat state is a v2 candidate.)

## UI (task drawer)

- In the inline editor's **template field**: when a template is set, render a
  small pencil affordance beside its name. Click → open the editor panel.
- **Editor panel** (drawer-scoped, existing `wa-*` + `md.js`):
  - Header: `Editing template: <name>` + an "unsaved changes" dot when a
    stored draft exists.
  - Left/top: the **chat thread** (user instructions + assistant notes) and
    an instruction input.
  - Right/bottom: the **live rendered draft** (`md.js` renders the markdown;
    raw-markdown toggle for the frontmatter-heavy parts).
  - Actions: **Save current draft** (runs the save endpoint; shows the
    validation result inline — green check, or the `plt` errors), **Revert to
    saved** (drop the localStorage draft, re-`GET` the on-disk template),
    **Close** (keeps the draft in localStorage).
- Draft + thread autosave to `localStorage["pl.tpl-edit.<name>"]` on every
  turn; cleared on a successful Save.

## Security posture

Defense stack, each failing differently:

1. **Admin-only.** Only `HUMAN` can read-for-edit, ai-edit, or save. Agents
   get 403 — this feature is not part of the delegated-work surface.
2. **Text-only spawn.** The `claude -p` call passes `--tools ""` (the CLI's
   documented way to disable ALL tools) plus `--no-session-persistence`, so
   the process is given nothing to act with and can only emit text. A
   prompt-injected template body cannot make it act.
3. **Validation gate.** `plt validate` runs on a temp file *before* any repo
   write; invalid drafts never touch `authored/`.
4. **Human review.** The owner sees the rendered draft and explicitly hits
   Save; nothing auto-commits.
5. **Path containment.** `:name` is charset-restricted and every resolved
   path is realpath-contained under the templates repo; writes only ever go
   to `templates/authored/`.
6. **Commit, not push.** Saves commit locally in the templates repo; pushing
   stays a deliberate human step (matches punchlist's review-at-push-gate
   model).

## Out of scope (v1) — tracked in 01M15BR5N9QASBYAF5FZXFS38R

Global template browser; editing pack files in place; creating brand-new
templates in-app; server-side/multi-session chat state; push/deploy of the
templates repo; the "fill this task's output from the template" fork.

## Testing

- **Endpoints:** feature-gate (404 when templates dir absent / not git / no
  claude binary); admin-only 403s; `GET` resolves authored-over-pack and
  rejects traversal/unknown names; `save` writes to `authored/` + commits on
  valid, 422s without writing on invalid. The `claude`/`plt`/`git` spawns are
  stubbed via injectable runners so tests stay hermetic (no real CLI, no
  network) — mirror how the suite already isolates the filesystem.
- **Parser:** the `<<<NOTE / <<<TEMPLATE` splitter — well-formed, missing
  block, extra prose around the delimiters.
- **UI smoke:** pencil appears only when a template is set; editor opens;
  localStorage round-trips a draft across close/reopen and clears on save.
