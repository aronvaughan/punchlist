---
name: no-shape
kind: template
inputs:
  - name: topic
    exemplar: "an example topic"
output: markdown
tags: [fixture]
---
## Purpose

This fixture has a valid frontmatter and a golden exemplar but no
Output shape section, which must fail validation.

## Golden exemplar

A sufficiently long golden exemplar lives here so that the only error
the validator reports for this fixture is the missing Output shape
section. More padding text to comfortably clear the minimum length the
validator requires for exemplar content in a template file.
