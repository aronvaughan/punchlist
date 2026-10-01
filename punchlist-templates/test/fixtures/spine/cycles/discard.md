---
name: discard
kind: workflow
version: 1
extends: core/discard
description: "Drop a card from any point in its run: the owner's decision is the gate; the agent records it on the tracker and the effort, settles the branch, and closes out so every board shows the card as discarded rather than stalled."
domain: engineering
tags: [spine, exit]
inputs: [card, effort, repo_dir]
actors: [agent, owner]
---

# Discard

An exit, not a cycle. A run on any cycle can end here: `plt run discard <id> --by <owner> --reason "…" [--replaced-by <card>]` is the owner's gate. It retires every unfinished step of the running cycle, appends these steps to the run, and records the decision in the owner's name — that is the `drop` step passing. From there the agent walks `record` and `close-out` like any other step, receipts and all, and `plt run close` marks the run closed as discarded. A discarded run never satisfies another card's `after:` dependency; the effort file's `dropped:` list is what the planner reads.

steps: []
