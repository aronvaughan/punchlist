---
name: review-followup
kind: template
domain: engineering
inputs:
  - name: pr
    exemplar: "#42 — add retry to the ingestion pipeline"
  - name: threads
    exemplar: "one row per thread we opened: where · what we asked · what the author replied · verdict (verified / verified-deferred / not-as-described / disagree) · draft reply"
  - name: recommendation
    exemplar: "re-approve"
output: html
tags: [spine, review, writing]
---
## Purpose

The follow-up page is what the owner sees after the author has answered our review. It is a
**verification, not a new review**: the only question is whether each thing we raised was
remediated — fixed on the branch (the claimed commit is on the PR and the code or test does what
the reply says), deferred to a ticket that exists, or argued down with a reason that holds. No new
issues are hunted. Each thread carries one editable reply; the owner edits, then approves. On their
yes the replies go into the threads, the threads are resolved, and a review is submitted — approve
when every thread is verified or verified-deferred. Replies never restate a mandate.

## Output shape

```markdown
# Did the author address our review of <pr>?

**New head:** <sha>   **Threads:** verified n · verified-deferred n · not-as-described n · disagree n
**Recommendation:** re-approve | do not re-approve yet

## Threads
| # | where (permalink) | we asked | he replied | verdict | evidence at the new head |
| 1 | path:line | … | "Fixed in abc123…" | verified | path:line |

## Our replies
- one editable box per thread — exactly what will be posted
```

## Rules

- Verification only. The verdict on a thread answers one question — was what we raised remediated? — never whether the new code has other problems. New issues, if any are noticed, go to a separate review, not into this page.
- A "fixed in <sha>" claim is verified only when the commit is on the PR and the code or test at the new head does what the reply says; a "deferred" claim only when the ticket is linked; an "intended" claim only when the reasoning holds and a test pins it.
- Replies are one line, in the house style, and never restate a mandate; approve when every thread is verified or verified-deferred.

## Golden exemplar

```markdown
# Did the author address our review of #42?

**New head:** 9f1e2c4   **Threads:** verified 3 · verified-deferred 1 · not-as-described 0 · disagree 0
**Recommendation:** re-approve

## Threads
| # | where | we asked | he replied | verdict | evidence at the new head |
| 1 | src/ingest/retry.ts:41 | `commitBatch` is retried without rollback, so a second attempt double-writes. | "Fixed in a1b2c3d — rollback in the catch, test added." | verified | retry.ts:44 rolls back; retry.test.ts:88 asserts rows 1..k once |
| 2 | src/ingest/retry.ts:18 | `Math.random()` defeats the seeded RNG the tests inject. | "Fixed in a1b2c3d — takes the scheduler's RNG." | verified | retry.ts:18 `rng()` from the constructor |
| 3 | src/ingest/retry.ts:7 | `MAX_TRIES` counts retries, not tries. | "Renamed in d4e5f6a." | verified | retry.ts:7 `MAX_ATTEMPTS` |
| 4 | src/ingest/index.ts:88 | Is the 30 s ceiling a product number? | "Deferred to ING-118 with the SLA owner." | verified-deferred | ticket linked |

## Our replies
- 1 · retry.ts:41 — Verified in a1b2c3d; the rollback test covers the partial-commit case. Thanks.
- 2 · retry.ts:18 — Verified in a1b2c3d.
- 3 · retry.ts:7 — Verified in d4e5f6a.
- 4 · index.ts:88 — Fine to settle in ING-118.
```
