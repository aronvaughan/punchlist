---
name: release-notes
kind: template
domain: engineering
inputs:
  - name: version
    exemplar: "1.0.1-rc.1 (a release candidate — dist-tag next, not latest)"
  - name: range
    exemplar: "v1.0.0..HEAD — the commits since the previous release tag"
output: markdown
tags: [release, changelog, docs, versioning]
---
## Purpose

Release notes are read by one person: someone deciding **whether and how to
upgrade**. Write for them, not for the git log. That means:

- **Impact first.** Open with highlights — the 2–5 things a reader who reads
  nothing else must know. A commit dump is not release notes.
- **Every line is user-facing.** Say what the user can now do or what changed
  *for them*, in their vocabulary — never internal refactors or file names.
  If a commit has no user-visible effect, it belongs in the diff, not here.
- **Breaking changes and upgrade steps are unmissable and always present** —
  write "None." explicitly when there are none, so the reader never has to
  wonder whether you forgot.
- **Give exact, copy-pasteable commands** to upgrade and to verify, and make
  them dist-tag-aware (a candidate installs from `next`, not `latest`).
- **Signal risk in the header** via SemVer + stability + dist-tag, so the
  reader gauges blast radius before reading a word.
- **Be honest about known issues.** Trust is the point.
- **Curate the body; link the rest.** A compare link carries the full diff
  for the curious; the notes stay readable.

Categories follow *Keep a Changelog* (Added / Changed / Deprecated / Removed
/ Fixed / Security) — familiar and greppable. Omit any category that's empty.

## Output shape

```markdown
# <Project> <version> — <one-line theme>

<date> · <stable | release candidate | prerelease> · npm dist-tag: <latest | next>

## Highlights
2–5 bullets (or a short paragraph): the headline changes and why they matter.

## Upgrade
​```bash
npm install -g <pkg>@<version-or-dist-tag>   # a candidate: @next
<binary> --version                            # verify
​```
One line on promotion if this is a candidate (how it becomes `latest`).

## Breaking changes
None.   ← or, per change: what changed · why · the exact migration step.

## Changes
### Added
- <user-facing capability> (<ref>)
### Changed
- <behavior/UX change> (<ref>)
### Fixed
- <bug, described by its symptom> (<ref>)
### Security
- <security-relevant change> (<ref>)

## Known issues
- <issue> — <workaround / tracking link>.   (or "None known.")

## Details
Full changelog: <compare link  vPREV...vNEW>. <N> commits, <F> files, +<ins>/−<del>.
```

## Golden exemplar

# punchlist 1.0.1-rc.1 — safer pushes & agent KB context

2026-09-02 · release candidate · npm dist-tag: `next`

## Highlights
- **Agents get project context.** Projects, tags, and the instance now carry
  a `kb_path` — a KB folder an agent reads before working that project or tag.
- **Restart without interrupting work.** A task can queue a *deferred*
  restart that applies only once no task is in progress.
- **A pre-push safety gate.** A leak scan (secrets + PII, full history) and a
  shareable diff-review page now gate every push of the repo.
- Patch-level and backward compatible — safe to adopt from 1.0.0.

## Upgrade
```bash
npm install -g @aronvaughan/punchlist@next   # candidates ship under `next`
punchlist --version                          # expect 1.0.1-rc.1
```
When promoted, `1.0.1` becomes `latest`: `npm dist-tag add @aronvaughan/punchlist@1.0.1 latest`.

## Breaking changes
None. A patch release; existing tasks, tokens, and the DB schema are unchanged.

## Changes
### Added
- `kb_path` on projects and tags — a KB folder for agent context/notes (f07e6d6).
- Instance-level `working_dir` / `kb_path`, mirroring the project/tag pickers (14ab925).
- `pl.sh project-create`, and `project-edit` / `tag-edit` that set `kb_path`
  on existing rows (dd25e4d, 855578a).
- Deferred safe-restart: `request-restart` / `safe-restart` / `restart-status`
  — a restart that waits for the queue to go idle (7152caf).

### Changed
- The working-dir browser shows hidden directories but denylists
  known-sensitive names, and allows `.claude` dirs as targets (5682cf1, c2615bb).

### Fixed
- The timeline sparkline draws a dashed axis + today-ring when today has no
  activity, instead of a gap (aeb43d7).
- A failed `/templates` fetch no longer permanently blanks the task template
  picker — it retries on next open (public/detail.js).

## Known issues
- None known for this candidate. Report at the project tracker.

## Details
Full changelog: `v1.0.0...v1.0.1-rc.1`. 27 files, +943 / −84 across 10 commits.
