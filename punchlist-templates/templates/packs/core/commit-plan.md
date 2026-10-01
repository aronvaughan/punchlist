---
name: commit-plan
kind: template
version: 1
description: "How a card's change will be cut into commits — one commit per logical segment, in the order they will land. Written at dispatch, reconciled against git at pre-PR."
domain: engineering
tags: [spine, gate, commits]
inputs:
  - name: card
    exemplar: "T6"
  - name: touches
    exemplar: "lib/commit-plan.js, templates/packs/core/commit-plan.md, test/commit-plan.test.js"
  - name: base
    exemplar: "origin/main (merge-base a7b2c19)"
  - name: entries
    exemplar: "1 · lib: the reconcile library · `lib/commit-plan.js`"
  - name: gate
    exemplar: "gated — entry 3 shares templates/packs/core with T11 (open)"
  - name: order_note
    exemplar: "the shared-file commit is last, so the first two stay reviewable if T11 moves those files"
output: markdown
---

# Commit plan

A card's change lands as **one commit per logical segment**, and this page is the list of
segments, written before the work rather than reconstructed after it. It is an
`artifact:` requirement at dispatch.

Two things read this page after it is written, so its table is machine-readable:

- The **gate**. The plan needs a human ONLY when an entry's files intersect a lower open
  card's `touches`. Nothing else gates it — a plan that collides with nobody is the
  author's business. Where it does collide, the decision being asked for is about
  **order**: putting the shared-file commit last keeps the earlier commits reviewable
  even if the other card rewrites those files while this one is in review.
- The **`reconcile` step** at pre-PR, which reads `base..HEAD` and compares it with this
  table (`lib/commit-plan.js`). Divergence is a banner — the plan is rewritten from git
  and the diff recorded. It becomes a hard gate in exactly two cases: a commit went
  outside the card's `touches`, or the rewritten plan collides with a lower open card
  when the approved one did not. In both, someone already ruled on the old plan.

## Output shape

<!-- slot:meta required source=state -->
Card · branch · base ref and its sha · the card's declared `touches`.
<!-- /slot -->
<!-- slot:entries required source=inputs -->
ONE markdown table, columns `#`, `commit`, `files`, and `sha` once the commit exists.
Numbered 1..n with no gaps, in the order the commits will land. Every row names at least
one file: a row with no files can never intersect another card, so it would switch this
page's gate off silently. Paths are repo-relative, in backticks, comma-separated.
<!-- /slot -->
<!-- slot:gate required source=fan -->
`not gated`, or one line per intersection: entry number · the lower open card · the
shared path. The shared path is the DEEPER of the two declarations — the file, where the
other card declared the directory containing it — because that is the path the reader has
to reason about. Never a bare "gated": the reader is being asked to rule on order and
cannot do that without the path.

A page with no readable table is `gated`, not `not gated`. An unreadable plan cannot be
shown to collide with nothing.
<!-- /slot -->
<!-- slot:order_note source=inputs -->
One sentence: why the entries are in this order. Required whenever the gate is on.
<!-- /slot -->
<!-- slot:out_of_scope source=inputs -->
Anything found during the work that is NOT in this plan and NOT in `touches`, with where
it went instead (a new card, a note). Kept here so the escape is recorded rather than
committed.
<!-- /slot -->

## Golden exemplar

Card `T6` · branch `effort/T6-commit-plan-and-reconcile` · base `origin/main` at `a7b2c19` ·
touches `lib/commit-plan.js`, `templates/packs/core/commit-plan.md`, `test/commit-plan.test.js`.

A card that declares NO touches does not get a quiet pass here: there is nothing to check
its commits against, so `reconcile` raises it as a hard gate. Declaring the touches is the
one-line fix.

Every row has the same number of cells as the header, and a literal pipe inside a cell is
written `\|`. The `sha` column is a sha or an em-dash — never a word like "pending".

| # | commit | files | sha |
|---|--------|-------|-----|
| 1 | lib: the commit-plan artifact, its gate and reconcile | `lib/commit-plan.js` | `4f9a1c2` |
| 2 | test: the reconcile tests, each run against the naive version first | `test/commit-plan.test.js` | `b01d773` |
| 3 | templates: the commit-plan page the gate is read from | `templates/packs/core/commit-plan.md` | — |

Gate: **gated** — entry 3 shares `templates/packs/core/commit-plan.md` with `T11` (open).

Order: the shared-file commit is last on purpose. If T11 rewrites the pack while this card
is in review, only commit 3 needs redoing; commits 1 and 2 stay readable and stay approved.

Out of scope: `bin/plt` needs `plt card recommit` / `plt card replan` to drive this page.
That file belongs to another open card, so nothing here touches it — the library exports
`replanFromCommits`, `planDiff` and `reconcile().mode`, and the CLI is one call site in the
card that owns `bin/plt`.
