---
name: effort
kind: effort
version: 1
description: "One run per EFFORT, above the cards: open the workspace, plan a wave, dispatch it, steward the cards to the gate, roll up what happened, and put it to the owner. One wave, one human gate, one epoch."
domain: engineering
tags: [spine, effort]
inputs: [effort, repo_dir]
actors: [brain, owner]
---

# Effort

The cycle above the cards. A `kind: workflow` formula runs once per card; this runs once per
effort and drives the cards through waves.

`review → next-wave → dispatch` is the outer loop, and the shape is the contract: **one wave, one
human gate, one epoch.** The brain may decide anything `spine-gate` would not deny and must
escalate everything else; its authority resets
when `review` closes, which increments `gate_epoch`. So a wrong autonomous call can never travel
past one gate unreviewed, and "what did it decide on its own since I last looked" is a filter on
the epoch rather than a judgement.

Every `{{config.*}}` here is an override, never a requirement. Panes open through `windows.*`,
and herdr is declared in `deps`. An empty `windows:` means no panes and the cycle still runs — the
panes are where the work is *visible*, not where it happens.

steps:
  - id: open
    assignee: brain
    pane: brain
    title: "Open the workspace for {effort}"
    notes: "One workspace per effort, pane 1 is the brain. Panes are named `<effort>/brain` and `<effort>/<card>` so agents address each other by name. No `windows.*` configured: record the outcome and carry on."
    outcomes: [opened]
  - id: plan
    assignee: brain
    pane: brain
    title: "Plan the next wave of {effort}"
    needs: [open]
    artifact: effort-plan
    notes: "The wave comes from `plt effort plan` — touches and after, not judgement. The page must list every card NOT dispatched and which rule held it; a card in neither list is an error in the page."
    outcomes: [planned, nothing_to_do]
  - id: dispatch
    assignee: brain
    pane: brain
    title: "Dispatch the wave for {effort}"
    needs: [plan]
    when: { step: plan, outcome: planned }
    notes: "One worktree, one run and one pane per card. A window failure does not fail the card — the worktree and run already exist on disk by then."
    outcomes: [dispatched, wave_empty]
  - id: steward
    assignee: brain
    pane: brain
    title: "Steward the wave of {effort} to the gate"
    needs: [dispatch]
    notes: "The loop: answer what can be answered, escalate what cannot, and keep the cards moving toward the next human gate. Record the decision BEFORE sending it — a failed send still replays. `needs_human` ends the round; the brain does not sit on an escalation waiting."
    outcomes: [wave_done, needs_human]
    repeat_until: wave_done
  - id: roll-up
    assignee: brain
    pane: brain
    title: "Roll up the wave of {effort} for the owner"
    needs: [steward]
    artifact: effort-review
    agents: "{{config.review.effort_agents}}"
    gate:
      kind: adversarial
      mode: "{{config.review.effort_mode}}"
      agents: "{{config.review.effort_agents}}"
    notes: "An adversary reads the roll-up before the owner does. The decisions of THIS epoch are the substance: an empty list is a claim that the brain decided nothing, not an omission."
    outcomes: [ready]
  - id: review
    assignee: owner
    title: "Owner reviews the wave of {effort}"
    needs: [roll-up]
    notes: "The only human step in the cycle. Closing it increments `gate_epoch`, which is what bounds the brain's authority — the decisions rolled up here are exactly the ones made since the last time this step closed."
    gate:
      kind: human
      signal: effort-reviewed
    outcomes: [continue, park, discard]
  - id: next-wave
    assignee: brain
    pane: brain
    title: "Compute the next wave of {effort}"
    needs: [review]
    when: { step: review, outcome: continue }
    notes: "`more` re-enters at dispatch with a fresh epoch; `none` means every card is closed or dropped and the effort can close."
    outcomes: [more, none]
    repeat_until: none
  - id: close
    assignee: brain
    pane: brain
    title: "Close out {effort}"
    needs: [next-wave]
    notes: "Harvest, publish the index, close the workspace. The effort is not done until the index says so."
    outcomes: [closed]
  # THE TWO EXITS, together at the end because a reader should find both in one place.
  # `stand-down` is plan's else_of and it is NOT `park`; conflating them would be the wrong fix.
  #
  # Found by running this cycle rather than reading it. `dispatch` is gated on
  # `when: {step: plan, outcome: planned}`, everything after it needs `dispatch`, and `park` was
  # only `review`'s else_of — so an effort whose wave came back empty finished `plan` and then had
  # no ready step, no gate to reach and no command to run. It stopped, silently, with a declared
  # outcome that led nowhere. `nothing_to_do` READ as handled because it was in the outcome list.
  #
  # `park` means a person looked at a roll-up and chose to stop. `stand-down` means the fan had
  # nothing to dispatch: every card is closed, already running, or held behind one that is. No
  # human decided anything, and the effort should be re-entered by `plt effort start` when a card
  # closes — which is why this ends the run rather than looping back to `plan`. Looping would spin
  # a brain against an unchanged board.
  - id: stand-down
    else_of: plan
    assignee: brain
    pane: brain
    title: "Stand down {effort}: nothing to dispatch"
    notes: "Records WHY the wave was empty — every card closed, running, or held, with the rule that held each — and stops. Re-entering is a fresh `plt effort start` once a card closes; the wave plan is stale by then in any case."
    outcomes: [stood_down]
  # `park` is review's else_of, not a step in the loop: an effort the owner parks or discards leaves
  # the cycle rather than sitting in `steward` forever with nobody stewarding it.
  - id: park
    else_of: review
    assignee: brain
    pane: brain
    title: "Park {effort} and leave the loop"
    notes: "Records why, leaves the worktrees and runs as they are, and stops. Re-entering is a fresh `plt effort launch`, which is deliberate — a parked effort's wave plan is stale by definition."
    outcomes: [parked]
