---
name: pre-push-review
kind: template
domain: engineering
inputs:
  - name: repo
    exemplar: "punchlist — 9 unpushed commits + 1 uncommitted change on top of origin/master"
  - name: base
    exemplar: "origin/master — the ref this push will update"
  - name: scope
    exemplar: "punchlist at ~/code/punchlist · origin (private), public (PUBLIC) · pushes in scope: origin/master (private); nothing to public"
output: markdown
tags: [git, review, prepush, release, lands]
---
## Purpose

Step 2 of the pre-push process (after `repo-leak-scan`): turn everything a
push would send — the diff from the push base to the working tree — into one
shareable review page so the owner can approve before pushing. Runs the
`av-prepush-review` skill to build + publish the page; the deliverable is the
**published link** plus a short finish report. The commit list is generated;
the summary and worked example are hand-written judgement.

## Output shape

The published page (favicon 🔍) contains the sections below, in order. Its `## Scope`
section renders this slot:

<!-- slot:scope required source=git -->
Which repo this is, where it lands, and which pushes approving it authorizes. Every line
comes from a command, never from memory:
- **Repo:** the repository name and its local path.
- **Remotes:** every `git remote -v` entry, as name · URL · visibility. Read visibility from
  the host, for example with `gh repo view <owner/name> --json visibility`. When the host
  gives no answer, write `unknown`. Never guess.
- **Lands on:** the remote branch the push updates, and any tag or release it cuts.
- **Pushes in scope:** the exact pushes this approval authorizes, for example
  `origin/master (private)` or `public/master + tag v1.1.0 (PUBLIC)`.
  Then list the pushes it does not authorize, by remote and branch. A push to a public
  remote is written `PUBLIC` in capitals and shown in a warning colour, so a reader
  cannot miss it.
<!-- /slot -->

```markdown
# <Repo> Pre-push Review   (title of the page)

Metrics: <N> commits (+ uncommitted), <F> files, +<ins> / −<del>.

## Scope
Repo · remotes with visibility · lands on · pushes in scope (PUBLIC ones loud) and not.

## What's in this push
- A hand-written bulleted summary: the themes, grouped — not a restatement
  of every commit subject.
- One or two WORKED EXAMPLES: a concrete before/after or scenario for the
  most notable change.
- (below) the auto-generated per-commit list, tagged feat/fix/docs/…, plus
  any uncommitted working-tree changes.

## Full diff · <F> files
Every file as a collapsible block with add/remove colouring; expand/collapse-all.
```

Finish report (what lands in the punchlist review lane):

```markdown
- Review: <artifact link>
- Pushes in scope: <remote/branch (+ tag)> (<visibility>); not in scope: <the rest>
- Push would send: <N> commits + <wt>, <F> files, +<ins>/−<del> vs <base>
- Leak scan: CLEAN ✓ (or: resolved — <note>)
- Notable: <one line on the headline change>
```

## Golden exemplar

# Punchlist Pre-push Review

Metrics: 9 commits + 1 uncommitted, 21 files, +656 / −83 vs `origin/master`.

## Scope

- **Repo:** `punchlist` at `~/code/punchlist`.
- **Remotes:** `origin` · `git@github.com:example/punchlist-internal.git` · private.
  `public` · `git@github.com:example/punchlist.git` · **PUBLIC**. Both read from
  `gh repo view --json visibility`.
- **Lands on:** `origin/master`. No tag, no release.
- **Pushes in scope:** `origin/master` (private). Not in scope: anything to `public`
  (**PUBLIC**), tags, force-pushes. The public push is a separate review with its own scan.

## What's in this push

Three themes plus small fixes:

- **Agent KB context** — projects, tags, and the instance gain a `kb_path`
  (a KB folder an agent reads before working that project/tag), with
  `pl.sh project-create` / `project-edit` / `tag-edit` to set it.
- **Safer working-dir browser** — `fs/dirs` shows hidden directories but
  denylists known-sensitive names, and `.claude` dirs are pickable again.
- **Deferred safe-restart** — `request-restart` / `safe-restart` /
  `restart-status`: a task can queue a server restart that applies only when
  no task is `in_progress` (agents idle).
- Uncommitted: a template-picker cache fix in `public/detail.js`.

**Worked example — deferred safe-restart.** You change punchlist code and
want the server to pick it up without interrupting an agent mid-task:
`punchlist request-restart "picked up X"` → the next cron tick sees 2 tasks
`in_progress` and **defers** → agents finish, the queue drains → the next
tick sees idle and **applies the restart**. Before this feature the only
option was a hard restart that could kill an in-flight task.

## Full diff · 21 files

Each file collapsible with +/− counts and add/remove colouring; everything
collapsed by default so the file list scans first. Published as a private
artifact; the link is the deliverable.
