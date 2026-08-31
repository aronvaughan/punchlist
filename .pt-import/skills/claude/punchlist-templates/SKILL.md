---
name: punchlist-templates
description: Resolve and apply output templates from the punchlist-templates repo. Use when the user says "use the X template", "what templates do we have", "produce this per the template", asks for a template for research/review/purchase decisions, or when a punchlist task carries a template ref.
license: MIT
metadata:
  version: "0.1"
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
3. **Use the input exemplars** to interpret what the user gave you and
   to ask for anything missing.
4. **Say which template you used** — one line at the end or in your
   summary, e.g. "(per the `research-brief` template)".

## Browsing

"What templates do we have (for research)?" → `scripts/plt.sh list`
(optionally `--tag research`) and summarize the table for the user.
