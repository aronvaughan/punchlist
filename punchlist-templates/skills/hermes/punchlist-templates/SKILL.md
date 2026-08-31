---
name: punchlist-templates
description: "Resolve and apply output templates from the punchlist-templates repo — list what templates exist, load one before producing output, and match its output shape. Use when asked to 'use the X template', 'what templates do we have', to produce something per a template, for research/review/purchase-decision outputs, or when a punchlist task carries a template ref."
version: 0.1.0
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [templates, punchlist, output, research, review]
    related_skills: []
---

# punchlist-templates — template resolver

> `scripts/plt.sh` here is a shim — the canonical resolver lives in the
> punchlist-templates repo at `skills/shared/plt-resolve.sh` and wraps
> `bin/plt`. Set `PUNCHLIST_TEMPLATES_DIR` if your checkout is somewhere
> the shim cannot find by walking up from its own location.

Templates define what good OUTPUT looks like: declared inputs (each with
an exemplar), an `## Output shape` skeleton, and a `## Golden exemplar`
showing a complete real-quality example.

## Commands

```bash
scripts/plt.sh list                       # all templates: name, kind, tags, path
scripts/plt.sh list --tag research        # filter by tag (also --kind, --domain)
scripts/plt.sh show <name>                # full template markdown — read this
scripts/plt.sh validate all               # check every template in the repo
```

## How to work with a template

1. **Always `show` before producing.** Run `scripts/plt.sh show <name>`
   and load the full markdown into context before writing any output.
2. **Match the Output shape.** Your output must follow the `## Output
   shape` skeleton — same sections, same order, same table/list forms.
   The `## Golden exemplar` shows the quality bar and tone; match it,
   don't copy its content.
3. **Use the input exemplars** to interpret what you were given and to
   ask (or block with a question) for anything missing.
4. **Say which template you used** — one line in your report, e.g.
   "(per the `research-brief` template)".

## Browsing

"What templates do we have (for research)?" → `scripts/plt.sh list`
(optionally `--tag research`) and summarize the table.
