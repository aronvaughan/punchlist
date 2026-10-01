---
name: review-outbound
kind: template
domain: engineering
inputs:
  - name: pr
    exemplar: "#42 — add retry to the ingestion pipeline"
  - name: verdict
    exemplar: "request changes"
  - name: findings
    exemplar: "one row per finding: severity · mandate (block / suggestion / nit / question) · location · draft comment · include"
output: html
tags: [spine, review, writing]
---
## Purpose

The outbound review page is the last thing the owner sees before a review is posted on someone
else's pull request. It carries every draft comment as an editable block with a mandate, an include
switch and a permalink, plus the page-level verdict and summary. The owner edits, drops, and
re-mandates; their edits are final. Nothing is posted until the owner approves.

## Output shape

```markdown
# Review — <pr>

**Verdict:** approve | comment | request changes   (warns when a `block` is still included under approve)
**Summary:** two or three sentences the author reads first — what the change does well, what must change.

## What this does well
- one line each, specific to the diff

## Findings
| # | severity | mandate | location (permalink) | draft comment | include |
| 1 | high | block | path:line | <the comment as it will be posted> | yes |
| 2 | low | nit | path:line | … | no |

## Not raised
- findings the panel produced that the owner chose not to post, with the reason
```

## Rules

- Every finding names a location the author can open and a concrete fix; a mandate says what we expect (`block` = must change before we approve; `suggestion` = the author decides; `nit`; `question`).
- Draft comments are written to the author, in the house style: short sentences, the defect first, the fix second, no internal ticket numbers or panel jargon.
- The verdict and the included blocks must agree: a `block` included under `approve` is an error the page shows.

## Golden exemplar

```markdown
# Review — #42 add retry to the ingestion pipeline

**Verdict:** request changes
**Summary:** The retry policy is the right shape — bounded, jittered, and tested for the cap. Two things must change before it ships: the retry wraps a non-idempotent write, and the jitter uses `Math.random` in a path the tests seed deterministically.

## What this does well
- The cap is tested at the boundary (attempt 5 succeeds, attempt 6 fails) rather than "some retries happen".
- Backoff is a pure function; the scheduler is the only place that sleeps.

## Findings
| # | severity | mandate | location | draft comment | include |
| 1 | high | block | src/ingest/retry.ts:41 | `commitBatch` is retried, but a partial commit is not rolled back before the retry, so a second attempt double-writes rows 1..k. Either make `commitBatch` idempotent on batch id or roll back in the catch before scheduling the retry. | yes |
| 2 | medium | block | src/ingest/retry.ts:18 | `Math.random()` here defeats the seeded RNG the tests inject, so the jitter test passes only because the assertion tolerates the whole range. Take the RNG from the same source the scheduler already receives. | yes |
| 3 | low | nit | src/ingest/retry.ts:7 | `MAX_TRIES` reads as "tries", but the loop counts retries — attempt 1 is not a retry. `MAX_ATTEMPTS`? | yes |
| 4 | low | question | src/ingest/index.ts:88 | Is the 30 s ceiling a product number or a guess? If it comes from the upstream SLA, a comment naming it would stop the next person lowering it. | no |

## Not raised
- Finding 4 dropped by the owner: the ceiling is documented in the runbook already.
```
