---
name: repo-leak-scan
kind: template
domain: engineering
inputs:
  - name: repo
    exemplar: "punchlist — public repo (npm @aronvaughan/punchlist), scan before pushing"
  - name: base
    exemplar: "origin/master — history is scanned across ALL refs regardless"
output: markdown
tags: [security, secrets, pii, prepush, privacy]
---
## Purpose

Step 1 of the pre-push process: prove a repo isn't leaking a secret or the
owner's personal/sensitive information — in the **working tree** and across
its **full git history** (every commit, every ref; a history rewrite hides
nothing from `git rev-list --all`). Runs the `av-repo-leak-scan` skill and
reports what it found and what to do. A push of a public repo does not
proceed until this is clean or every finding is explained.

## Output shape

```markdown
# Leak scan: <repo>

**Scope:** working tree + full history (<N> revs). **Terms file:** present/absent.

## Verdict
CLEAN ✓  |  FINDINGS — <n> to resolve before push

## Findings (distinct; history-deduped)
### SECRET (<n>)   — real key/token formats; each is a compromise
- `path:line` — <what> — [worktree | N commits] — **rotate now**
### PII (<n>)      — owner terms from the private terms file
- `path:line` — <what matched> — [worktree | N commits] — leak vs. intentional (e.g. LICENSE author name)
### HEURISTIC (<n>) — `secret=`/`token=` assignments; lower-confidence, eyeball each
- `path:line` — <why it's benign or not>

## Actions
- Rotate any real SECRET (rotation > scrubbing — assume public = captured).
- Move working-tree secrets to the private `data/` plane or a gitignored env file.
- Note which PII/HEURISTIC hits are intentional (author name, doc references).
```

## Golden exemplar

# Leak scan: punchlist

**Scope:** working tree + full history (229 revs). **Terms file:** present
(`~/.config/leak-scan/terms.txt`, mode 600).

## Verdict
CLEAN ✓ — nothing to rotate or remove; the only matches are intentional.

## Findings (distinct; history-deduped)

### SECRET (0)
None. No private keys, cloud/API tokens, JWTs, or DB connection strings in
the tree or anywhere in history.

### PII (3 — all intentional)
- `LICENSE:3` — "Copyright (c) 2026 Riley Chen" — [worktree + 200+ commits]
  — **intentional**: author attribution in an MIT LICENSE.
- `punchlist-templates/LICENSE:3` — same copyright line — **intentional**.
- `README.md:459` — "© 2026 Riley Chen" — **intentional** license footer.

### HEURISTIC (2 — both false positives)
- `docs/2026-08-23-architecture.md:71` — "Single shared secret:
  `PUNCHLIST_TOKEN` in `data/.env` (gitignored)" — documentation *about*
  where the secret lives, not the value.
- `test/attachments.test.js:475` — `const secret = join(outside,
  'secret.md')` — a test fixture path named "secret", no value.

## Actions
- Nothing to rotate. The private `data/` plane + `punchlist-govern` guard
  keep real secrets out of tracked paths by construction; this scan confirms
  nothing slipped past into history.
- Re-run before each push (`av-repo-leak-scan <repo> --fetch`).
