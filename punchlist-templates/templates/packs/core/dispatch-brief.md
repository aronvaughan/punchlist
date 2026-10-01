---
name: dispatch-brief
kind: template
version: 1
description: "The message that starts an agent on one step: run, step, inputs, required skills, the gate it must stop at, where receipts go, and the exact return shape."
domain: engineering
tags: [spine, dispatch]
inputs:
  - name: run
    exemplar: "TRK-42"
  - name: step
    exemplar: "build"
  - name: inputs
    exemplar: "card TRK-42, branch feat/TRK-42-soil-probe-units, repo_dir ./code/sprout-api"
  - name: skills
    exemplar: "[sprout-package-conventions]"
  - name: agents
    exemplar: "[]"
  - name: tools
    exemplar: "[graph_impact]"
  - name: gate
    exemplar: "none for this step — finish with `plt step finish build --outcome done`"
  - name: receipts_dir
    exemplar: "runs/TRK-42/build/"
output: markdown
---

# Dispatch brief

## Output shape
<!-- slot:header required source=state -->
`run · step · pin · owner`
<!-- /slot -->
<!-- slot:inputs required source=inputs -->
The filtered `inputs.yaml` for this step.
<!-- /slot -->
<!-- slot:requirements required source=formula -->
Skills to load (with paths) · agents to run · tools to call · artifact to produce.
<!-- /slot -->
<!-- slot:stop required source=formula -->
The gate this step ends at, and the phrase that satisfies it.
<!-- /slot -->
<!-- slot:verify -->
Hand-written checks the author wants before finish.
<!-- /slot -->
<!-- slot:refuse -->
Hand-written conditions under which the agent must block instead of guess.
<!-- /slot -->
<!-- slot:return required source=formula -->
```yaml
outcome: <one of the step's outcomes>
extrapolations: [{missing: {scope, key, where}, assumed: {value, basis, confidence}}]
artifacts: [<paths>]
```
<!-- /slot -->

## Golden exemplar
TRK-42 · build · tree 9f1c… · owner sprout-lead
Inputs: card TRK-42, branch feat/TRK-42-soil-probe-units, repo_dir ./code/sprout-api
Requirements: skills [sprout-package-conventions]; tools [graph_impact]; artifact none.
Stop: none — finish with `plt step finish build --outcome done`.
Verify: the probe unit is required at the API boundary.
Refuse: if the schema migration touches a table you did not expect, block with the table name.
Return: `outcome: done` · `extrapolations: [{missing: {scope: input, key: probe.default_unit, where: build}, assumed: {value: celsius, basis: "existing rows", confidence: medium}}]`
