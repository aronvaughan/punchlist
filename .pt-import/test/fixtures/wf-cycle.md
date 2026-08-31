---
name: wf-cycle
kind: workflow
actors: [hermes]
---
steps:
  - id: a
    assignee: hermes
    needs: [c]
  - id: b
    assignee: hermes
    needs: [a]
  - id: c
    assignee: hermes
    needs: [b]
