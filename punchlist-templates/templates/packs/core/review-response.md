---
name: review-response
kind: template
version: 1
description: "The page a human approves before any reply reaches the PR: what the reviewers said, one reply per thread exactly as it will be posted (editable), the merge state, and the exact next steps."
domain: engineering
tags: [spine, gate]
inputs:
  - name: pr
    exemplar: "#42"
  - name: head
    exemplar: "9f1c2e3"
  - name: incoming
    exemplar: "reviewer · where · what was said · class (one-off | rule) · disposition (reply n | fix | none)"
  - name: replies
    exemplar: "Reply 1 → thread on units.ts:16 — the exact text to post"
  - name: merge_state
    exemplar: "approved on HEAD ×2 · CI green · 1 thread unresolved"
  - name: next_steps
    exemplar: "post reply 1 into the thread and resolve it; post reply 2; confirm the merge queue took the PR"
output: markdown
---

# Review response

## Output shape
A page with these slots, in this order. Incoming items render from the PR (reviews, threads, comments); the replies are the only free text, and the owner edits them on the page. Nothing is posted before the owner has Saved and said so.

<!-- slot:meta required source=pr -->
PR · card · head · review decision · merge state · state (nothing posted, nothing pushed).
<!-- /slot -->
<!-- slot:incoming required source=pr -->
Table, newest last: when · who · where (permalink) · what was said · class (one-off | rule) · disposition (reply n | fix page | none).
<!-- /slot -->
<!-- slot:replies required editable -->
One block per reply: label · target (thread permalink or the PR conversation) · the exact text. Editable; the saved text is what gets posted, one at a time.
<!-- /slot -->
<!-- slot:merge_state required source=pr -->
Chips: approvals on HEAD · CI · mergeStateStatus · unresolved threads. A note on the no-push-after-approval rule.
<!-- /slot -->
<!-- slot:next_steps required source=formula -->
Post order, thread resolution, the merge-queue check, and what runs on MERGED.
<!-- /slot -->

## Golden exemplar
PR #42 · head `9f1c2e3` · approved ×2 · CLEAN · 1 thread open.
Incoming: 11:54 · reviewer · `units.ts:16` · "Is the missing-unit case handled on boot?" · one-off · REPLY 1. 12:01 · reviewer · review APPROVED · "LGTM; the PR touched many packages, smaller ones would be nicer" · rule · REPLY 2 + harvested.
Replies: 1 → the thread: "Yes — it fails closed before any row is written: … (links to the validator and the sync)". 2 → the PR: "Fair; registry first, bindings second next time."
On approval: post 1, resolve the thread; post 2; the merge queue takes the PR; on MERGED card → Done.
