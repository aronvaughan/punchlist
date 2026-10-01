---
name: fix-summary
kind: template
version: 1
description: "The page a human approves before a follow-on change (a CI fix, a review fix) is committed to an already-approved branch: what broke, the diff, the commit message, the gates run."
domain: engineering
tags: [spine, gate, lands]
inputs:
  - name: card
    exemplar: "TRK-42"
  - name: broke
    exemplar: "CI: 33 gql suites cannot construct CodeSyncResolvers — the shared test container lacks the new stub"
  - name: scope
    exemplar: "soil-station at ~/code/soil-station · origin (private) · pushes in scope: origin/feat/TRK-42-soil-probe-units (private)"
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
<!-- slot:scope required source=git -->
Which repo this is, where it lands, and which pushes approving it authorizes. Every line
comes from a command, never from memory:
- **Repo:** the repository name and its local path.
- **Remotes:** every `git remote -v` entry, as name · URL · visibility. Read visibility from
  the host, for example with `gh repo view <owner/name> --json visibility`. When the host
  gives no answer, write `unknown`. Never guess.
- **Lands on:** the branch the fix is committed to. Say whether it is pushed (a PR cycle)
  or fast-forwarded locally (a commit-review cycle).
- **Pushes in scope:** the exact pushes this approval authorizes, for example
  `origin/feat/TRK-42-soil-probe-units (private)`, or
  `none — lands on local main only`.
  Then list the pushes it does not authorize, by remote and branch. A push to a public
  remote is written `PUBLIC` in capitals and shown in a warning colour, so a reader
  cannot miss it.
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
Scope: repo `soil-station` at `~/code/soil-station` · remote `origin` `git@github.com:example/soil-station.git`, private (from `gh repo view`) · lands on `feat/TRK-42-soil-probe-units` · pushes in scope: `origin/feat/TRK-42-soil-probe-units` (private). Not in scope: `origin/main`, force-pushes.
Broke: CI `🧪 GraphQL tests` — 33 suites could not construct `CodeSyncResolvers` (unregistered token), read from run 349…390.
Commit: `test(TRK-42): stub the mapping service in the shared gql test container`.
Gates: `resource:test:gql` 35 files 542 ✓ · oxfmt ✓.
On approval: `plt gate approve TRK-42 approve --by <owner>`; commit; push; watch CI; when green record `checks-green`.
