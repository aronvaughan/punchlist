---
name: pre-commit-summary
kind: template
version: 1
description: "The artifact a human approves before a change lands on a commit-review project. It shows the commits in reading order, what was verified, what the panel found, and the exact next steps. No pull request is opened."
domain: engineering
tags: [spine, gate, lands]
inputs:
  - name: card
    exemplar: "TRK-42"
  - name: branch
    exemplar: "feat/TRK-42-soil-probe-units"
  - name: pin
    exemplar: "tree 9f1c… on a7b2…"
  - name: scope
    exemplar: "soil-station at ~/code/soil-station · origin (private) · lands on local main by fast-forward · pushes in scope: none"
  - name: gates
    exemplar: "typecheck ✓ · lint ✓ · unit 212 ✓"
  - name: findings
    exemplar: "HIGH · panel · Celsius readings written to the Fahrenheit column when the probe reported no unit → FIXED"
  - name: diff_stat
    exemplar: "3 files +61/−4"
  - name: overview
    exemplar: "Probe readings carry a unit end to end; the resolver rejects a reading without one instead of guessing Fahrenheit."
  - name: arch_gist
    exemplar: "One boundary check replaces three call-site guards. No new module; the unit becomes part of the reading type."
  - name: arch_questions
    exemplar: "Should a legacy reading with no unit be rejected or defaulted at import? Rejecting blocks the nightly load."
  - name: next_steps
    exemplar: "fast-forward the base branch to feat/TRK-42-soil-probe-units (3 commits); card → Done"
output: markdown
---

# Pre-commit summary

## Output shape
A page with these slots, in this order. Every slot renders from `state.yaml` and `events.jsonl`; the only free text is inside `notes`.

<!-- slot:meta required source=state -->
Card · branch · pin (kind + value) · change vs base (files, +/−) · state.
<!-- /slot -->
<!-- slot:scope required source=git -->
Which repo this is, where it lands, and which pushes approving it authorizes. Every line
comes from a command, never from memory:
- **Repo:** the repository name and its local path.
- **Remotes:** every `git remote -v` entry, as name · URL · visibility. Read visibility from
  the host, for example with `gh repo view <owner/name> --json visibility`. When the host
  gives no answer, write `unknown`. Never guess.
- **Lands on:** the base branch the approval fast-forwards, and whether it is local only.
  On this cycle no push follows the fast-forward.
- **Pushes in scope:** the exact pushes this approval authorizes, for example
  `none — lands on local main only`.
  Then list the pushes it does not authorize, by remote and branch. A push to a public
  remote is written `PUBLIC` in capitals and shown in a warning colour, so a reader
  cannot miss it.
<!-- /slot -->
<!-- slot:overview required -->
What the change does, for a reader who has not seen the card. Two or three sentences,
in the reader's terms, not the code's.
<!-- /slot -->
<!-- slot:arch_gist required -->
The SHAPE of the change in a few lines: what moved, what it replaced, what boundary it
sits on, what it deliberately did not add. An approver judging a diff alone cannot see
whether the shape is right, which is the expensive thing to get wrong.
<!-- /slot -->
<!-- slot:arch_questions -->
Architectural questions still open, each with the consequence of each answer. Absent is a
claim — write "none" rather than omitting the slot, so a silent omission cannot pass for
"nothing to ask".
<!-- /slot -->
<!-- slot:gates required source=events -->
One chip per local gate with its count, asserted from the receipt, never inferred.
<!-- /slot -->
<!-- slot:findings required source=events -->
Table: severity · raised by · finding · disposition (fixed | deferred | dismissed with file:line).
<!-- /slot -->
<!-- slot:next_steps required source=formula -->
The exact steps that run on approval, from the formula, and the gate that stays human.
<!-- /slot -->
<!-- slot:notes -->
Free text the author wants the approver to read. Kept short.
<!-- /slot -->
<!-- slot:commits required source=git -->
The commits that will land, in reading order: sha · subject · files · +/−. This is the
review surface for a commit-review project. A reviewer reads the change as the series of
steps the author took, not as one diff. That is why the author splits the work into
one commit per logical step.
<!-- /slot -->
<!-- slot:diff required source=git -->
The full diff at the pin. Rendered below the commits list.
<!-- /slot -->

## Golden exemplar
Card TRK-42 · branch `feat/TRK-42-soil-probe-units` · pin tree `9f1c…` on `a7b2…` · 3 files +61/−4 · in_review.
Scope:
- Repo: `soil-station` at `~/code/soil-station`.
- Remotes: `origin` · `git@github.com:example/soil-station.git` · private (from `gh repo view`).
- Lands on: local `main`, by fast-forward. Local only.
- Pushes in scope: none. Not in scope: `origin/main` and every other push; a push is a separate approval.
Gates: typecheck ✓ · lint ✓ · unit 212 ✓.
Overview: probe readings carry a unit end to end; the resolver rejects a reading without one instead of guessing Fahrenheit.
Arch gist: one boundary check replaces three call-site guards. No new module; the unit becomes part of the reading type, so a caller cannot construct one without it.
Arch questions: should a legacy reading with no unit be rejected or defaulted at import? Rejecting blocks the nightly load until the exporter is fixed; defaulting reintroduces the guess this card removed.
Findings: high · panel · "Celsius readings were written to the Fahrenheit column when the probe reported no unit" → FIXED. Unit is now required at the boundary; 4 tests.
On approval: fast-forward the base branch to the tip of `feat/TRK-42-soil-probe-units` (3 commits, listed below); card → Done. This is the last human gate; no pull request follows.
Notes: none.

Commits (reading order):
1. `a7b2c01` feat(TRK-42): require a unit on every probe reading · 2 files +38/−2
2. `a7b2c02` fix(TRK-42): write Celsius readings to the Celsius column · 1 file +9/−2
3. `a7b2c03` test(TRK-42): cover a probe that reports no unit · 1 file +14/−0
