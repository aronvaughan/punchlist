---
name: digest
kind: workflow
version: 1
description: "Fixture digest cycle: collect, write, write-review, publish."
domain: engineering
tags: [spine, digest]
inputs: [date, kind]
actors: [agent]
---
steps:
  - id: collect
    assignee: agent
    title: "Collect the digest for {date}"
    files: [digest-json]
    outcomes: [done]
  - id: write
    assignee: agent
    title: "Write the digest for {date}"
    needs: [collect]
  - id: write-review
    assignee: agent
    title: "Writing review for {date}"
    needs: [write]
    outcomes: [pass, fail]
    on_fail: { retry: 2, then: write }
  - id: close-out
    assignee: agent
    title: "Publish and close out the digest for {date}"
    needs: [write-review]
    files: [digest-md]
    outcomes: [done]

<!-- plt:mermaid -->
```mermaid
flowchart LR
  collect --> write --> write-review --> close-out
  write-review -- fail --> write
```
<!-- /plt:mermaid -->
