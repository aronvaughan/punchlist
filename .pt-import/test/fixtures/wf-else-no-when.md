---
name: wf-else-no-when
kind: workflow
actors: [hermes]
---
steps:
  - id: one
    assignee: hermes
  - id: two
    assignee: hermes
    else_of: one
