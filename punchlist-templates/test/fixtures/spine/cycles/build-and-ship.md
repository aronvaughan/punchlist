---
name: build-and-ship
kind: workflow
version: 1
description: "Take one card from claimed to merged: build, adversarial review, writing review, editable pre-PR artifact (owner edits are final), two human gates, PR loop, automatic merge, close-out."
domain: engineering
tags: [spine, delivery]
inputs: [card, effort, branch, repo_dir]
actors: [agent, owner]
---

# Build and ship

One run per card. The agent builds and reviews; the owner approves the artifact and each reply; merge is automatic once GitHub says approved, green and resolved.

steps:
  - id: scope
    assignee: agent
    title: "Scope {card}"
    skills: "{{config.skills.scope}}"
    artifact: dispatch-brief
    touches: declared
    jira:
      on_start: "{{config.jira.status.in_progress}}"
    outcomes: [ready, needs_input]
  - id: build
    assignee: agent
    title: "Build {card}"
    needs: [scope]
    when: { step: scope, outcome: ready }
    skills: "{{config.skills.build}}"
    tools: "{{config.tools.build}}"
  - id: review
    assignee: agent
    title: "Adversarial review of {card}"
    needs: [build]
    agents: "{{config.review.panel_agents}}"
    gate:
      kind: adversarial
      mode: "{{config.review.panel_mode}}"
      agents: "{{config.review.panel_agents}}"
    outcomes: [pass, fail]
    on_fail: { retry: 2, then: build }
  - id: write-review
    assignee: agent
    title: "Writing review of the draft PR message and code comments for {card}"
    needs: [review]
    agents: "{{config.review.writing_agents}}"
    gate:
      kind: adversarial
      mode: "{{config.review.writing_mode}}"
      agents: "{{config.review.writing_agents}}"
    outcomes: [pass, fail]
    on_fail: { retry: 2, then: build }
  - id: pre-pr
    assignee: agent
    title: "Editable pre-PR summary for {card}, built from the reviewed text"
    needs: [write-review]
    skills: "{{config.skills.pre_pr}}"
    artifact: pre-pr-summary
    overlap: effort
  - id: approve
    assignee: owner
    title: "Approve the pre-PR artifact for {card}"
    needs: [pre-pr]
    gate:
      kind: human
      signal: artifact-approved
    reapprove:
      artifact: fix-summary
      rearm: [announce]
  - id: resync
    assignee: agent
    title: "Bring {card} up to date with main after a conflict"
    needs: [open-pr]
    arm_on: { gh: mergeStateStatus, equals: DIRTY }
    artifact: fix-summary
    banner: "🔀 MERGE CONFLICT — {card}"
    outcomes: [resynced]
  - id: reply
    assignee: owner
    title: "Approve each review reply for {card}"
    needs: [open-pr]
    manual: true
    gate:
      kind: human
      signal: reply-approved
    # One approval per reply: `replied` re-opens the step for the next one; it never settles on its
    # own, and `plt run close` retires it.
    outcomes: [replied, done]
    repeat_until: done
  - id: announce
    assignee: owner
    title: "Ask the team for reviews on {card}"
    needs: [open-pr]
    manual: true
    banner: "📣 SLACK FOR REVIEWS — {card} · {pr_url}"
    outcomes: [done, skipped]
  - id: open-pr
    assignee: agent
    title: "Push and open the PR for {card}"
    needs: [approve]
    skills: "{{config.skills.ship}}"
    jira:
      on_done: "{{config.jira.status.in_review}}"
    verify:
      gh: [checks-green]
    overlap: effort
  - id: pr-loop
    assignee: agent
    title: "Work the review loop for {card}"
    needs: [open-pr]
    skills: "{{config.skills.pr_loop}}"
    agents: "{{config.review.writing_agents}}"
    gate:
      kind: human
      signal: reply-approved
    outcomes: [approved, changes_requested]
    repeat_until: approved
  - id: merge
    assignee: agent
    title: "Merge {card}"
    needs: [pr-loop]
    land_on: { gh: state, equals: MERGED }
    gate:
      kind: external
      checks: [approved_on_head, checks-green, threads_resolved]
    verify:
      gh: [merged]
    jira:
      on_done: "{{config.jira.status.done}}"
    overlap: effort
  - id: close-out
    assignee: agent
    title: "Close out {card}"
    needs: [merge]
    skills: "{{config.skills.close_out}}"
    outcomes: [done, suggest]

<!-- plt:mermaid -->
```mermaid
flowchart TD
  scope["scope (agent)"]
  build["build (agent)"]
  review["review (agent)"]
  write-review["write-review (agent)"]
  pre-pr["pre-pr (agent)"]
  approve["approve (owner)"]
  resync["resync (agent)"]
  announce["announce (owner)"]
  open-pr["open-pr (agent)"]
  pr-loop["pr-loop (agent)"]
  merge["merge (agent)"]
  close-out["close-out (agent)"]
  scope --> build
  scope -- ready --> build
  build --> review
  review --> write-review
  write-review --> pre-pr
  pre-pr --> approve
  open-pr --> resync
  open-pr --> announce
  approve --> open-pr
  open-pr --> pr-loop
  pr-loop -- until approved --> pr-loop
  pr-loop --> merge
  merge --> close-out
  review -. fail x2 .-> build
  write-review -. fail x2 .-> build
  pre-pr -- overlap check --> blocked
  open-pr -- overlap check --> blocked
  merge -- overlap check --> blocked
```
<!-- /plt:mermaid -->
