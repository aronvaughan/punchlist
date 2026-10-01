---
name: digest
kind: workflow
version: 1
description: "A daily or weekly rollup computed from every run's events: collect the numbers, write the digest, review the writing, publish it. The standup renders from the same collected data."
domain: engineering
tags: [spine, digest, writing]
inputs: [date, kind]
actors: [agent]
---

# Digest

One run per reporting period (`kind: daily` or `kind: weekly`). No branch, no PR, no owner step:
the agent collects, writes, gets its own writing reviewed, and publishes. `plt digest launch --for
<date> [--weekly]` is idempotent — a DIGEST run already closed for that date/week is a no-op.

steps:
  - id: collect
    assignee: agent
    title: "Collect the digest for {date}"
    notes: "`plt digest collect --for {date}` (add `--weekly` for a weekly run) writes process/digests/{date}.json, pure from every run's events.jsonl/state.yaml/inputs.yaml and efforts/*.yaml — no gh, no writes elsewhere. Then `plt receipt --kind file --name digest-json --ref process/digests/{date}.json`."
    files: [digest-json]
    outcomes: [done]
  - id: write
    assignee: agent
    title: "Write the digest for {date} from the collected numbers"
    needs: [collect]
    artifact: digest
  - id: write-review
    assignee: agent
    title: "Writing review of the draft digest for {date}"
    notes: "Before the adversary reads the text, run `plt lint prose <file>` on it (long sentences, banned words, internal ticket keys in code comments, undefined acronyms — config.writing.*), fix every hit, then record `plt receipt --kind tool --name lint-prose`. A `banner` gate never holds this step: a failing reviewer is shown by prime as a warning."
    needs: [write]
    agents: "{{config.review.writing_agents}}"
    gate:
      kind: adversarial
      mode: "{{config.review.writing_mode}}"
      agents: "{{config.review.writing_agents}}"
    outcomes: [pass, fail]
    on_fail: { retry: 2, then: write }
  - id: close-out
    assignee: agent
    title: "Publish and close out the digest for {date}"
    needs: [write-review]
    notes: "Write process/digests/{date}.md and publish it (the same place the standup skill posts from); `plt receipt --kind file --name digest-md --ref process/digests/{date}.md`. Then `plt run close`."
    files: [digest-md]
    outcomes: [done]

<!-- plt:mermaid -->
```mermaid
flowchart LR
  collect --> write --> write-review --> close-out
  write-review -- fail --> write
```
<!-- /plt:mermaid -->
