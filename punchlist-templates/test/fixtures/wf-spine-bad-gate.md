---
name: wf-spine-bad-gate
kind: workflow
actors: [agent, owner]
---
steps:
  - id: review
    assignee: agent
    gate:
      kind: sideways
  - id: approve
    assignee: owner
    needs: [review]
    gate:
      kind: human
  - id: build
    assignee: agent
    model: gpt-9
    reasoning: extreme
    skills: sprout
