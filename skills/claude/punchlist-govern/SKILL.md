---
name: punchlist-govern
description: Use before creating or writing ANY data artifact (skill, template, KB article, note, doc, config) on a punchlist machine — classifies it as publishable vs private and keeps private content (client OR personal) out of open-source-safe locations. Runs automatically as a PreToolUse guard; invoke manually when unsure where an artifact belongs.
---

# Punchlist data governance

**Private by default; publish deliberately.** Every data artifact lives in one of
two planes:

- **Publishable (open-source-safe):** the ONLY plane that ever leaves a machine —
  punchlist code, shipped templates (`packs/`), the global pl skills + KB. Generic,
  with **no client *or personal* specifics.** When punchlist is open-sourced, only
  this is exposed.
- **Private (default for everything else):** task data, client codebases, **and
  your own personal work** — because open-sourcing pl would leak that too. Private
  content never enters the publishable plane.

## The one rule

> **Never let private content — secrets, or client/company/personal identifiers —
> land in a publishable path.**

The test is **structural and exact:** a path that git would **track** in a
publishable repo (pl, punchlist-templates, global `~/.claude/skills`) is
publishable; a **gitignored** or non-repo path (anything under `data/`) is private.
So `data/` is always a safe home, and a tracked skill/template/kb file must be
generic.

## Where artifacts go

| Kind | Publishable (tracked) | Private (under `data/`) |
|---|---|---|
| Templates | `punchlist-templates/**/packs/` | `data/templates/` |
| Skills | `~/.claude/skills/**` (generic only) | `data/skills/` (→ `~/.claude/skills-local`) |
| KB articles | pl-shipped KB | `data/kb/` |
| Task data | — never | `data/` (SQLite) |

**Default a new artifact to `data/` (private).** Only write to a tracked location
when the content is genuinely generic and open-source-safe — and even then it
leaves only through a human-reviewed commit (push/PR require ask).

## The guard (runs before every write)

`skills/shared/govern.sh` is wired as a **PreToolUse hook** on `Write|Edit`. Before
a write lands it runs:

```
govern.sh classify <path> --stdin   # content on stdin
# exit 0 = OK    exit 3 = BLOCK (private content → publishable path)
```

- **Private path** → always OK (write anything).
- **Publishable path** → the content is scanned for secrets + the machine-local
  private-terms list (`$GOVERN_TERMS`, default `data/govern/private-terms.txt`).
  Any hit **blocks** the write with guidance to move it under `data/`.

If the guard blocks you: either the artifact is private (write it under `data/`),
or you must remove the private content before it can be published.

## Audit (verify compliance)

```
govern.sh audit ~/code/punchlist ~/code/punchlist-templates ~/.claude
```

Read-only: scans every tracked (publishable) file for private markers and reports
anything that must move to `data/`. Run it before publishing / open-sourcing, and
after large imports.

## Keeping the terms list current

`data/govern/private-terms.txt` (private, never published) holds client/company/
personal identifiers — one per line. Widen it as you take on work; the guard and
audit both read it. Without it, only high-signal secrets are caught.
