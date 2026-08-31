---
name: coding-task
kind: template
domain: engineering
inputs:
  - name: goal
    exemplar: "add a Delete-tag capability: an admin can remove a tag and its task links, tasks keep their other tags"
  - name: repo
    exemplar: "~/code/punchlist — Hono + node:sqlite service, node:test suite, 80% coverage floor"
  - name: constraints
    exemplar: "keep tests green, theme tokens only in UI, no new runtime deps, commit atomically, do NOT push"
output: markdown
tags: [code, engineering, tdd]
---
## Purpose

A coding task turns a goal into a reviewed, tested change on a branch. It
is not "write some code" — it is a small, honest loop: understand the
codebase, propose a plan and get it reviewed BEFORE building, build
test-first in small commits, verify against reality (tests AND the running
thing), then hand back a report a reviewer can act on. The unit of work is
a change small enough to hold in your head and review in one sitting; if it
isn't, split it.

The shape below is what an agent PRODUCES while working the task — a plan
posted for review, then a finishing report. It is deliberately close to how
punchlist itself is built: think → file a plan (block with a question) →
build (TDD, subagent-friendly) → verify → finish with a report → the owner
reviews.

## Output shape

```markdown
# Coding task: <goal>

**Repo:** path + what kind of project (stack, test runner, coverage gate).
**Constraints:** the hard rules (tests green, tokens only, no deps, commit
style, push policy) — each one you will be held to.

## Plan (filed for review BEFORE building)
1–5 numbered steps describing the change: the files you will touch, the
data/API/UI surface that changes, and the test you will write first for
each. Name the ONE open question that must be answered before you build, if
any — this is what you `block` on. If nothing is genuinely blocking, say
"no blocking questions" and proceed.

## Build log
Per commit, one line: `<commit subject>` — what it did + the test that now
passes. Small commits, each green. Note any deviation from the plan and why.

## Verification
- **Tests:** the exact command run and its result (counts + coverage vs the
  floor). New tests listed by what they assert.
- **Live check:** how you exercised the real thing — a throwaway server on
  a spare port, a browser/CLI transcript, a screenshot — not just unit
  tests. Cite the actual observed output.

## Report (what the reviewer reads)
- What changed, where (files, endpoints, migrations) and the commit(s).
- What you verified and how (paste the key transcript line).
- Anything deferred, any risk, and the ONE thing the reviewer should double
  check. End with "(per the `coding-task` template)".
```

## Golden exemplar

# Coding task: add a Delete-tag capability

**Repo:** `~/code/punchlist` — a Hono + `node:sqlite`
service; UI is vanilla ES modules under `public/`; tests are `node:test`
with an 80% line-coverage floor enforced by `scripts/check-coverage.mjs`.
**Constraints:** keep the suite green, theme tokens only in any CSS, no new
runtime dependencies, commit atomically on a branch, do NOT push.

## Plan (filed for review BEFORE building)
1. **API** — add `DELETE /api/v1/tags/:id` in `src/api.js`: admin-actor
   only (403 otherwise), 404 on unknown id, and inside one transaction
   delete the `task_tags` rows then the `tags` row. Response
   `{ ok: true, removed: <task_tags count> }`. Tasks are untouched — they
   just lose the tag. First test: admin deletes a tag on a two-tag task →
   200, the task keeps its other tag, the tag is gone from `GET /tags`.
2. **AuthZ test** — a non-admin token gets 403 and the tag survives.
3. **UI** — in `public/views.js`, add a small ✕ on each rail tag row that
   calls the endpoint and reloads; guard it behind the same admin check the
   vet control uses. Style with existing tokens (`--danger`, `--ink-soft`).
4. **Docs** — one line in the tag section of `README.md`.

Open question filed as a `block`: *"When a tag is deleted, should tasks
that would become tag-less be flagged, or silently keep zero tags?"* —
this changes the data model note and the test, so I am not guessing it.
(Owner answered: silently keep zero tags. Proceeding.)

## Build log
- `feat(api): DELETE /tags/:id — admin-only, cascades task_tags in a tx` —
  adds the route; `tag delete: admin removes a tag, tasks keep other tags`
  passes.
- `test(api): non-admin tag delete is 403 and non-destructive` — the
  authZ test passes; coverage of the new branch confirmed.
- `feat(ui): rail tag ✕ for the admin, token-styled, reload on success` —
  manual check in the browser; no hex colors added.
- `docs(readme): note the admin tag-delete affordance` — one line.

## Verification
- **Tests:** `node scripts/check-coverage.mjs` → `tests 225, pass 225,
  fail 0`; `all files 95.4%` line coverage, above the 80% floor. New
  asserts: 200 + `removed` count + surviving sibling tag; 403 + tag
  survives; `GET /tags` no longer lists the deleted id.
- **Live check:** booted a throwaway server on `:8691` with a temp data
  dir and throwaway tokens, created a task with tags `#a #b`, deleted `#a`
  as the admin: `{"ok":true,"removed":1}`, and `GET /tasks` showed the
  task still carrying `#b`. A non-admin `DELETE` returned
  `403 {"error":"only the admin (alex) can delete tags"}`. Killed the
  server and removed the temp dir.

## Report (what the reviewer reads)
Added an admin-only `DELETE /api/v1/tags/:id` (transactional cascade of
`task_tags` then the tag; `{ok, removed}`) and a token-styled ✕ on rail tag
rows, plus a README line. Migrations: none. Files: `src/api.js`,
`public/views.js`, `public/tokens.css`, `test/api.test.js`, `README.md`.
Commits: four, atomic, on branch `feat/tag-delete` — NOT pushed. Verified
green (225 tests, 95.4% coverage) and live on a throwaway server (transcript
above). Deferred: bulk multi-tag delete (out of scope). Reviewer should
double-check the authZ branch — deletion is destructive, so confirm the 403
path and that tasks never lose unrelated tags. (per the `coding-task`
template)
