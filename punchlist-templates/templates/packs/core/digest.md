---
name: digest
kind: template
domain: engineering
inputs:
  - name: date
    exemplar: "2026-09-18"
  - name: kind
    exemplar: "daily"
  - name: digest_json
    exemplar: '{"runs":[{"id":"TRK-10","effort":"greenhouse","cycle":"build-and-ship","from_step":"build","to_step":"review","transitions":2}],"time":{"by_category":{"build":3.5,"approve":0.4},"by_actor":{"human":0.4,"agent":3.5}},"gates":[{"run":"TRK-10","step":"approve","signal":"artifact-approved","by":"human:o","at":"2026-09-18T15:02:00.000Z"}],"decisions":{"settled":[],"open":[{"id":"D-004","question":"does the resolver need a cache?","age_days":3,"effort":"greenhouse"}]},"extrapolations":[],"estimates":[],"reviews":[]}'
output: markdown
tags: [spine, digest, writing]
---
## Purpose

A digest reports what a reporting period actually did — numbers first, narrative built FROM
those numbers, never a paraphrase of the plan. It reads `digest_json` (the collected rollup:
`plt digest collect`) and writes the sections in the fixed order below. No number is invented:
every figure in the prose traces to a field in the input.

## Output shape

```markdown
# Digest: <date> (<kind>)

## What moved
- <run id> — <from_step> → <to_step> (<transitions> transitions)
- …  (or: "No run had a step transition in this period.")

## Waiting on a human
- <run id> — <step>: <signal>, approved by <by> at <at>
- …  (or: "Nothing waited on a human this period.")

## Time by category and actor
- <step id>: <hours>h
- …
- Human: <hours>h · Agent: <hours>h

## Gates passed
- <run id> · <step> · <signal> · by <by>
- …

## Decisions
- Settled: <id> (<effort>) — <question>
- Open: <id> (<effort>) — <question> (<age_days>d open, or "age unknown")

## Extrapolations
- <run id> · <step>: <assumed>
- …  (or: "None flagged.")

## Estimate vs actual
- <run id>: estimated <estimate>d, actual <actual_days>d (<over/under> by <diff>d)
- …  (or: "No run closed in this period.")

## Reviews
- PR #<pr> — <count> review-activity event(s) at <step>
- …  (or: "No review activity.")
```

## Rules

- Numbers first, one line per fact; the narrative sentence (if any) restates a number already
  shown, never adds a new claim.
- An empty section says so in one line ("Nothing waited on a human this period") — never omitted,
  never padded with filler.
- No internal ticket numbers beyond the run/card ids and PR numbers already in the data.
- A decision id is only unique WITHIN its effort — always show `(<effort>)` next to it, even when
  only one effort has decisions this period.
- Ages and hours are rounded to one decimal place; a null age reads "age unknown", never "0d".

## Golden exemplar

```markdown
# Digest: 2026-09-18 (daily)

## What moved
- TRK-10 — build → review (2 transitions)

## Waiting on a human
- TRK-10 — approve: artifact-approved, approved by human:o at 2026-09-18 15:02

## Time by category and actor
- build: 3.5h
- approve: 0.4h
- Human: 0.4h · Agent: 3.5h

## Gates passed
- TRK-10 · approve · artifact-approved · by human:o

## Decisions
- Settled: none this period
- Open: D-004 (greenhouse) — does the resolver need a cache? (3d open)

## Extrapolations
None flagged.

## Estimate vs actual
No run closed in this period.

## Reviews
No review activity.
```
