# AI-assisted template editor — v2 candidates (proposal)

**Status: proposal for owner review — nothing here is decided or implemented.**

*Tracks task 01M15BR5N9QASBYAF5FZXFS38R. These 6 items were deferred out of
the v1 AI-assisted template editor
([2026-08-28-template-editor-design.md](2026-08-28-template-editor-design.md))
as out-of-scope. The owner asked for a written proposal covering all 6 so
they can pick which (if any) to schedule; this doc does not implement
anything and does not authorize any push/deploy action.*

## Context

v1 shipped 2026-08-28: an in-drawer, chat-based editor for a task's attached
template, backed by a tool-less `claude -p` spawn, gated by `plt validate`,
committing (never pushing) to the local `punchlist-templates` working tree.
Six extensions were explicitly deferred at design time. This doc lays each
one out with a description, motivation, rough scope, and risks, then
suggests a sequencing — for owner review, not as a plan of record.

## 1. Global template browser

**Description:** A top-level surface (outside the task drawer) to browse and
open the AI editor for *any* template in the templates repo, not just the
one attached to the task currently being edited.

**Motivation:** v1's entry point is the pencil icon next to a task's chosen
template field — so editing a template requires first having a task that
uses it. A global browser lets the owner maintain the template library
proactively (e.g. cleaning up a template nobody currently has assigned).

**Rough scope/complexity:** Medium. Needs a new route/page, a list endpoint
(`GET /api/v1/templates` enumerating pack + authored templates with
resolution source), and reuse of the existing editor panel/endpoints
unchanged (`GET/:name`, `ai-edit`, `save` already operate on a template name
independent of any task). Mostly additive; low risk to v1 code paths.

**Risks:** Surface-area growth (new admin-only route to gate and test). No
security novelty beyond what v1 already established (admin-only,
feature-gated, path-contained).

## 2. Edit pack files in place

**Description:** Allow saving directly over a shipped `packs/*` template
instead of always forking into `templates/authored/<name>.md`.

**Motivation:** The authored-override model is safe but creates drift —
pack updates (e.g. a `git pull` on the templates repo) won't affect a
template someone forked, even for unrelated fixes. Some owners may want to
edit the canonical pack file directly, especially for private, single-owner
setups where there's no "shared pack maintainer" to protect against.

**Rough scope/complexity:** Small-to-medium code change, but a real design
decision: needs a way to indicate intent (edit pack vs. fork), and pack
overwrites should probably require an explicit opt-in per template (not a
silent default flip) to avoid accidentally mutating a template that's meant
to be reusable, versioned pack content.

**Risks:** Loses the "authored override never destroys the original" safety
net; a bad AI edit approved by a distracted owner now damages the shipped
pack rather than a personal fork. Should keep `plt validate` and local-commit
gating regardless. Interacts with template versioning/upgrade semantics if
`punchlist-templates` ever ships pack updates — needs a merge/diff story
before this is safe to build.

## 3. Create brand-new templates in-app

**Description:** Support authoring an entirely new template from scratch in
the same chat-based editor UI, rather than only editing an existing one.

**Motivation:** Closes the loop so the owner never has to leave punchlist to
create a template — today, new-template authoring is explicitly routed to
the separate `workflow-writer` skill / `plt` CLI flow.

**Rough scope/complexity:** Medium. Needs: a "new template" entry point (name
+ initial description/prompt), a `plt`-compatible scaffold (frontmatter
skeleton) to seed the first draft so `plt validate` has something sane to
check, and a save path that writes a new file rather than overwriting one
(different failure mode: name collision check instead of "does this template
exist"). The chat/save/validate machinery is otherwise reusable as-is.

**Risks:** Overlaps functionally with `workflow-writer`/`plt` — risks two
divergent authoring UX paths for the same outcome unless one is clearly
positioned as "quick start" vs. the other's "full authoring." Worth deciding
whether this replaces, wraps, or coexists with `workflow-writer` before
building.

## 4. Server-side / multi-session chat state

**Description:** Persist the in-progress chat thread + draft server-side
(e.g. a DB table keyed by template name) instead of client-side
`localStorage`, so the same edit-in-progress is visible/resumable across
devices or browser sessions.

**Motivation:** `localStorage` is per-browser-profile; the owner switching
devices (or clearing browser storage) loses an in-progress edit. Multi-device
continuity would be nicer for longer editing sessions.

**Rough scope/complexity:** Medium-large relative to the others. Needs a new
table/schema, an endpoint to load/save/clear server state, and a decision on
whether this state is exposed to any agent surface (it should stay
admin-only, matching v1's posture) or scoped per-viewer if punchlist ever
supports multiple humans. Adds a new runtime dependency category (persistent
mutable state) that v1 explicitly avoided ("zero new runtime deps" for the
editor itself).

**Risks:** Largest architecture footprint of the six — turns a stateless
feature into a stateful one, with attendant migration/cleanup/GC questions
(what happens to abandoned drafts?). Should only be pursued if multi-device
editing is an actual observed pain point, not speculatively.

## 5. Push/deploy of the punchlist-templates repo

**Description:** After a successful `save` (validate + local commit), also
`git push` the templates repo (and/or trigger whatever deploy step makes the
change live beyond the local commit).

**Motivation:** Right now a saved template edit is committed locally only;
someone (or something) has to separately push it before it's "live" anywhere
that pulls from the remote. Automating that closes the last manual step.

**Rough scope/complexity:** Small code change (one more git subprocess call)
but the smallest code change of the six with the largest blast radius.

**Risks — requires explicit owner authorization before any implementation,
not just design review:** This is the one candidate that crosses punchlist's
standing "commit-locally, human-reviews-at-push" model (see v1 doc's
security posture #6 and this repo's general permission model, where `git
push` is an ask-gated operation, never something an automated agent path
should do silently). An AI-edited template — even after `plt validate` and a
human "Save" click — reaching a shared remote without a distinct, explicit
push/approve step removes the last human checkpoint before a template
change affects everyone who pulls that repo. If this is ever built, it
should be a **separate, explicit action** ("Push to remote") distinct from
Save, not something Save does automatically, and should almost certainly
still route through the same manual git-push review the owner already uses
everywhere else. **No agent should implement or invoke this without the
owner explicitly authorizing that specific run.**

## 6. Same editor for filling a template's per-task OUTPUT

**Description:** Reuse the chat-based editor UX for the *other* fork v1
didn't take: instead of editing the reusable template definition, use AI
assistance to help fill in one task's per-task output against an already
fixed template (e.g. drafting the answers/content for a specific task that
uses a review/decision template).

**Motivation:** The template definition and a task's filled-in instance are
different objects with different edit semantics (v1 discusses this
distinction directly). Owners may want the same "chat with AI, see live
draft, save" UX for populating a task's output, not just for editing the
template itself.

**Rough scope/complexity:** Medium — most of the pattern (chat loop, live
draft, save action) is directly reusable, but the "save" target and
validation rules differ entirely: this writes to a task's own output/notes
field rather than `templates/authored/*.md`, and there's no `plt validate`
step (that only makes sense for template *definitions*, not filled-in
content) — a different validation story would need to be designed per
template.

**Risks:** Conceptually the most distinct from the other five (not really a
"template editor" extension so much as a sibling feature that happens to
share UI patterns). Worth explicitly deciding whether this belongs under the
template-editor umbrella at all, or is really "AI-assisted task
answering" as its own feature.

## Recommendation / sequencing (non-binding)

If the owner wants to pick up more than zero of these, a reasonable order by
risk-adjusted value:

1. **#1 (global template browser)** — smallest, safest, purely additive; no
   design questions left open, reuses v1's endpoints as-is.
2. **#3 (create brand-new templates in-app)** — moderate value, moderate
   risk, but should be preceded by a short decision on how it relates to
   `workflow-writer`.
3. **#6 (fill per-task output)** — worth scoping as its own small design doc
   before building, since it's conceptually a different feature wearing the
   same UI.
4. **#2 (edit pack files in place)** and **#4 (server-side chat state)** —
   hold until there's a concrete pain point (an owner hitting the
   authored-fork drift, or actually losing work across devices); both add
   real architectural weight for a currently-hypothetical need.
5. **#5 (push/deploy)** — do not schedule without a separate, explicit
   owner conversation about the push-approval model; this is a policy
   decision first, an implementation task a distant second.

This is a starting opinion for discussion, not a commitment — the owner may
weight these differently based on which pain point they've actually hit.
