---
name: effort-review
kind: template
version: 1
description: "The page a human reads at an effort's gate: what the wave produced, what the brain decided without asking, what is blocked, and what the next wave would be. One page per epoch."
domain: engineering
tags: [spine, effort, gate]
inputs:
  - name: effort
    exemplar: "greenhouse-sensors"
  - name: decided
    exemplar: "3 decisions, all reversible — see the list; none touched a guarded command"
  - name: escalations
    exemplar: "1 — TRK-12 asked to add a dependency; guarded by gates.commands"
  - name: landed
    exemplar: "TRK-10, TRK-14 merged; TRK-12 held at review"
output: markdown
---

# Effort review

## Output shape
<!-- slot:meta required source=state -->
Effort · wave · gate epoch being closed · cards landed · cards open.
<!-- /slot -->
<!-- slot:landed required source=events -->
What this wave actually produced, per card, with the commits or the artifact each ended at.
<!-- /slot -->
<!-- slot:decided required source=events -->
THE BRAIN DECIDED, for this epoch only. One row per decision: what was asked, what it
answered, and the basis it claimed — `reversible`, `config` or `precedent`. This is the
list the epoch exists to bound: a wrong autonomous call cannot travel past this page
unreviewed. Empty is a claim, not an omission.
<!-- /slot -->
<!-- slot:escalations required source=events -->
What the brain refused to decide, and which rule stopped it. An escalation still open when
this page is read is the first thing the reader should see.
<!-- /slot -->
<!-- slot:blocked required source=events -->
Cards reporting blocked, and since when. A card blocked for longer than its estimate is
worth naming as such.
<!-- /slot -->
<!-- slot:next_wave required source=formula -->
What the next wave would dispatch, and what would still be held. The reader is deciding
whether to continue, park or discard; they need to know what continuing costs.
<!-- /slot -->
<!-- slot:notes -->
Free text the brain wants read. Kept short.
<!-- /slot -->

## Golden exemplar
Effort `greenhouse-sensors` · wave 2 · closing epoch 1 · 2 landed, 1 open.
Landed: TRK-10 — 4 commits, `lib/probe.js` +112/−8. TRK-14 — docs only.
The brain decided: TRK-10 asked whether to widen its touches to `test/probe.test.js` → yes, basis `reversible` (a test file, no guarded command). TRK-14 asked whether to split its commit → yes, basis `precedent` (K8).
Escalations: 1, open — TRK-12 asked to add a runtime dependency; `guarded_command`, `npm install` is in `gates.commands`. Nothing installed.
Blocked: none.
Next wave: TRK-11 (unblocked by TRK-10 closing) and TRK-13 (still shares `packages/resolvers` with TRK-12).
Notes: TRK-12's escalation is the only thing between this effort and a third wave.
