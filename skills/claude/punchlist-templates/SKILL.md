---
name: punchlist-templates
description: Resolve and apply output templates from the punchlist template packs. Use when the user says "use the X template", "what templates do we have", "produce this per the template", asks for a template for research/review/purchase decisions, or when a punchlist task carries a template ref.
license: MIT
metadata:
  version: "1.0"
---

# punchlist-templates — template resolver

Templates define what good OUTPUT looks like: declared inputs (each with
an exemplar), an `## Output shape` skeleton, and a `## Golden exemplar`
showing a complete real-quality example.

`plt` is installed alongside `punchlist` (both ship in the
`@aronvaughan/punchlist` package). Point it at a different pack set with
`$PLT_TEMPLATES_DIR` if you keep private templates outside the package.

## Commands

```bash
plt list                       # all templates: name, kind, tags, path
plt list --tag research        # filter by tag (also --kind, --domain)
plt show <name>                # full template markdown — read this
plt validate all               # check every template
```

## How to work with a template

1. **Always `show` before producing.** Run `plt show <name>` and load the
   full markdown into context before writing any output.
2. **Match the Output shape.** Your output must follow the `## Output
   shape` skeleton — same sections, same order, same table/list forms.
   The `## Golden exemplar` shows the quality bar and tone; match it,
   don't copy its content.
3. **Use the input exemplars** to interpret what the user gave you and
   to ask for anything missing.
4. **Say which template you used** — one line at the end or in your
   summary, e.g. "(per the `research-brief` template)".

## Browsing

"What templates do we have (for research)?" → `plt list` (optionally
`--tag research`) and summarize the table for the user.

## With punchlist tasks

A task carrying a `template` field means the finished work must match
that template. `plt show <template>` first, produce to its Output shape,
then `punchlist finish` with the report.
