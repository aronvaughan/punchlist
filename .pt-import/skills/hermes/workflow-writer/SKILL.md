---
name: workflow-writer
description: "Conversational authoring helper for punchlist-templates workflows — interview the owner one short question at a time, scaffold a file in workflows/authored/, validate it, render the mermaid, get a visual yes. Use when asked to 'create/write a workflow', 'turn this into a workflow', 'codify this process', 'make a template for X', 'we keep doing this — automate it', or to propose a workflow from a repeated pattern."
version: 0.1.0
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [workflows, authoring, punchlist, templates]
    related_skills: [punchlist-templates]
---

# workflow-writer — authoring playbook (chat edition)

You ARE the writer; this is a playbook, not a program. You're on
Telegram: keep every turn SHORT — one question, a few lines, no walls
of text. Tools:

```bash
scripts/wf-scaffold.sh <name>       # commented skeleton -> workflows/authored/<name>.md
scripts/plt.sh list                 # existing templates/workflows
scripts/plt.sh show <name>         # read one
scripts/plt.sh validate <file>      # fix EVERY error before presenting
scripts/plt.sh render <name>        # regenerate the mermaid in-file
```

(Shims — canonical: `skills/shared/wf-scaffold.sh` and `bin/plt` in the
punchlist-templates repo. Set `PUNCHLIST_TEMPLATES_DIR` if needed.)

## Interview — one short question per message

1. **Goal** — "what exists when this is done?" One sentence back.
2. **Actors** — per part: owner, or which agent? → `actors` + `assignee`.
3. **Happy path** — steps in order; each step = one punchlist task.
4. **Decision points** — forks become `outcomes:` steps. Push for NAMED
   outcomes ("approved/rejected"), never "it depends". Outcomes feed
   `when:` branches; the leftover goes to an `else_of:` step.
5. **Failure** per risky step — retry how many times, then escalate to
   whom? → `on_fail: { retry: N, then: <step> }`.
6. **Loops** — repeat-until-good = `outcomes: [good, again]` +
   `repeat_until: good`. The only sanctioned loops are `repeat_until`
   and `on_fail`; the validator rejects dependency cycles.

**Templates:** for each producing step ask "what does good output look
like?" If `plt list` has a match, set `template:` on the step. Else
draft one in `templates/authored/` WITH a real golden exemplar and get
an explicit yes before wiring it in.

## Rules

- Author into `workflows/authored/` and `templates/authored/` — never
  `packs/` (shipped content).
- Start from the scaffold; frontmatter is the simple YAML subset in the
  repo README "Format reference".
- `validate` and fix everything BEFORE showing a draft; then `render`
  and send the mermaid for a visual yes (Obsidian/GitHub render it).
- Edge vocabulary is closed: `needs`/`when`/`else_of`/`repeat_until`/
  `on_fail`. Need more? Simplify or split the workflow — never invent
  syntax.

## Proposing workflows yourself

Spot a repeated multi-step pattern in your punchlist history? DRAFT it
in `workflows/authored/` and file a punchlist task for the owner:
"review proposed workflow <name>". **Never launch an unreviewed
self-authored workflow** — the owner's review is the gate.

## Safety

- Never write step titles/notes that would trip screening (credential
  harvesting, exfiltration shapes, pipe-to-shell, persistence + download,
  prompt-injection phrasing) — flagged steps are dead on arrival.
- High-risk-but-legit steps (installs, purchases like an `order` step)
  are fine — note they'll hit the out-of-band Telegram confirm at
  runtime.
