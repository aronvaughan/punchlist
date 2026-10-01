---
name: effort-plan
kind: template
version: 1
description: "The page the brain writes when it plans a wave: which cards go now, which are held and by what, and what the wave is for. Read before the cards start, not after."
domain: engineering
tags: [spine, effort]
inputs:
  - name: effort
    exemplar: "greenhouse-sensors"
  - name: wave
    exemplar: "TRK-10, TRK-12, TRK-14 — three cards, no shared files"
  - name: held
    exemplar: "TRK-11 waits on TRK-10; TRK-13 shares packages/resolvers with TRK-12"
  - name: arc
    exemplar: "wave 1 lands the reading path, wave 2 the writes that depend on it"
output: markdown
---

# Effort plan

## Output shape
<!-- slot:meta required source=state -->
Effort · wave number · gate epoch · cards in the wave · cards held.
<!-- /slot -->
<!-- slot:arc required -->
What this effort is for, and where this wave sits in it. Two or three sentences. A reader
who arrives at wave three should not have to reconstruct waves one and two.
<!-- /slot -->
<!-- slot:wave required source=formula -->
The cards dispatched now, each with the files it declared. This is the parallelism claim:
if two cards here share a file, say so and say why it was accepted.
<!-- /slot -->
<!-- slot:held required source=formula -->
Every card NOT dispatched, with which rule held it — a dependency, a file collision, or a
card already running. An absent entry is a claim that nothing else was excluded, so a card
missing from both lists is an error in this page.
<!-- /slot -->
<!-- slot:decisions source=events -->
What the brain decided on its own while planning, with the basis for each. Empty is a
claim that it decided nothing.
<!-- /slot -->
<!-- slot:next_steps required source=formula -->
The command that dispatches this wave, and the gate it ends at.
<!-- /slot -->

## Golden exemplar
Effort `greenhouse-sensors` · wave 2 · epoch 1 · 3 dispatched, 2 held.
Arc: wave 1 landed the reading path; this wave adds the writes that depend on it; wave 3 is the UI.
Wave: TRK-10 (`lib/probe.js`, `test/probe.test.js`) · TRK-12 (`lib/store.js`) · TRK-14 (`docs/`).
Held: TRK-11 — after TRK-10, not closed. TRK-13 — shares `packages/resolvers` with TRK-12; holding rather than accepting the rebase.
Decisions: none this epoch.
On dispatch: `plt effort launch greenhouse-sensors --parallel`; ends at the `review` gate, which closes epoch 1.
