---
name: fix-summary
kind: template
version: 1
description: "The page a human approves before a follow-on change (a CI fix, a review fix) is committed to an already-approved branch: what broke, the diff, the commit message, the gates run."
domain: engineering
tags: [spine, gate]
inputs:
  - name: card
    exemplar: "TRK-42"
  - name: broke
    exemplar: "CI: 33 gql suites cannot construct CodeSyncResolvers — the shared test container lacks the new stub"
  - name: change
    exemplar: "1 file +6/−6 (test scaffolding)"
  - name: commit_message
    exemplar: "test(TRK-42): stub the mapping service in the shared gql test container"
  - name: gates
    exemplar: "resource:test:gql 35 files ✓ · oxfmt ✓"
output: markdown
---

# Fix summary

## Output shape
The same page as the pre-PR summary, scoped to one follow-on change. The commit message and the comment blocks in the diff are editable; the owner Saves, then re-approves the run's approve gate for the new tree.

<!-- slot:meta required source=state -->
Card · change (files, +/−) · branch · base (the PR head) · pin · state (not committed, not pushed).
<!-- /slot -->
<!-- slot:broke required -->
What failed and where it was read from (a CI log, a review thread), with the link.
<!-- /slot -->
<!-- slot:commit_message required editable -->
Exactly what will be committed; the PR body is unchanged.
<!-- /slot -->
<!-- slot:gates required source=events -->
The gates re-run for this change, with counts.
<!-- /slot -->
<!-- slot:next_steps required source=formula -->
Re-approve the gate on this tree; commit and push; watch CI; continue the step that was interrupted.
<!-- /slot -->
<!-- slot:diff required source=git -->
The staged diff of the fix.
<!-- /slot -->

## Golden exemplar
TRK-42 · 1 file +6/−6 · base = PR head `9f1c2e3` · not committed.
Broke: CI `🧪 GraphQL tests` — 33 suites could not construct `CodeSyncResolvers` (unregistered token), read from run 349…390.
Commit: `test(TRK-42): stub the mapping service in the shared gql test container`.
Gates: `resource:test:gql` 35 files 542 ✓ · oxfmt ✓.
On approval: `plt gate approve TRK-42 approve --by <owner>`; commit; push; watch CI; when green record `checks-green`.
