---
name: handoff
kind: template
version: 1
description: "The one-page note a session leaves for the next one: goal, next command, what is verified at which pin, open questions."
domain: engineering
tags: [spine, handoff]
inputs:
  - name: run
    exemplar: "TRK-42"
  - name: step
    exemplar: "build"
  - name: goal
    exemplar: "keep the probe's unit through ingestion"
  - name: next_command
    exemplar: "plt step start build --run TRK-42"
  - name: verified
    exemplar: "unit required at boundary (tree 9f1c…) · 212 unit tests green (tree 9f1c…)"
  - name: questions
    exemplar: "none"
  - name: pin
    exemplar: "tree 9f1c… on a7b2…"
output: markdown
---

# Handoff

## Output shape
<!-- slot:goal required source=inputs -->One sentence.<!-- /slot -->
<!-- slot:next required source=state -->One validated command.<!-- /slot -->
<!-- slot:verified required source=events -->Bullets, each with its pin.<!-- /slot -->
<!-- slot:questions source=events -->Open questions, newest first.<!-- /slot -->
<!-- slot:pinned required source=state -->Pin kind + value + base.<!-- /slot -->

## Golden exemplar
Goal: keep the probe's unit through ingestion.
Next: `plt step start build --run TRK-42`
Verified: unit required at boundary (tree 9f1c…) · 212 unit tests green (tree 9f1c…)
Questions: none
Pinned: tree 9f1c… on a7b2…
