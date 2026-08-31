---
name: wf-unknown-edge
kind: workflow
actors: [hermes]
---
steps:
  - id: one
    assignee: hermes
  - id: two
    assignee: hermes
    needs: [ghost]
