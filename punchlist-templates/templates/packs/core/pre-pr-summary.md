---
name: pre-pr-summary
kind: template
version: 1
description: "The artifact a human approves before anything is pushed: what changed, what was verified, what the panel found, and the exact next steps."
domain: engineering
tags: [spine, gate]
inputs:
  - name: card
    exemplar: "TRK-42"
  - name: branch
    exemplar: "feat/TRK-42-soil-probe-units"
  - name: pin
    exemplar: "tree 9f1c… on a7b2…"
  - name: gates
    exemplar: "typecheck ✓ · lint ✓ · unit 212 ✓"
  - name: findings
    exemplar: "HIGH · panel · Celsius readings written to the Fahrenheit column when the probe reported no unit → FIXED"
  - name: diff_stat
    exemplar: "3 files +61/−4"
  - name: next_steps
    exemplar: "commit and push feat/TRK-42-soil-probe-units; open the PR; card → In Review"
output: markdown
---

# Pre-PR summary

## Output shape
A page with these slots, in this order. Every slot renders from `state.yaml` and `events.jsonl`; the only free text is inside `notes`.

<!-- slot:meta required source=state -->
Card · branch · pin (kind + value) · change vs base (files, +/−) · state.
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
<!-- slot:diff required source=git -->
The full diff at the pin.
<!-- /slot -->

## Golden exemplar
Card TRK-42 · branch `feat/TRK-42-soil-probe-units` · pin tree `9f1c…` on `a7b2…` · 3 files +61/−4 · in_review.
Gates: typecheck ✓ · lint ✓ · unit 212 ✓.
Findings: HIGH · panel · "Celsius readings were written to the Fahrenheit column when the probe reported no unit" → FIXED (unit is now required at the boundary; 4 tests).
On approval: commit and push `feat/TRK-42-soil-probe-units`; open the PR; card → In Review; the reply gate stays yours.
Notes: none.
