---
name: workflow-writer
description: Conversational authoring helper for punchlist-templates workflows. Use when the user says "create/write a workflow", "turn this into a workflow", "codify this process", "make a template for X", "we keep doing this — automate it", or when an agent wants to propose a workflow from a repeated pattern.
license: MIT
metadata:
  version: "0.1"
---

# workflow-writer — authoring playbook

You ARE the writer. This skill is the playbook, not a program: interview,
draft, validate, render, get a visual yes. The only tools you need:

```bash
scripts/wf-scaffold.sh <name>       # commented skeleton -> workflows/authored/<name>.md
scripts/plt.sh list                 # what templates/workflows already exist
scripts/plt.sh show <name>         # read a template/workflow
scripts/plt.sh validate <file>      # check the draft — fix EVERY error
scripts/plt.sh render <name>        # (re)generate the mermaid diagram in-file
```

(Shims — canonical: `skills/shared/wf-scaffold.sh` and `bin/plt` in the
punchlist-templates repo. Set `PUNCHLIST_TEMPLATES_DIR` if needed.)

## The interview — one question at a time

Never present a wall of questions. Ask, listen, ask the next. In order:

1. **Goal.** "What should exist when this workflow finishes?" One sentence.
2. **Actors.** For each part of the work: who does it — the owner (a human
   task) or which agent? These become `actors: [...]` and per-step
   `assignee`.
3. **Happy path.** Walk the steps in order, as if everything goes right.
   Each step = one real punchlist task someone completes.
4. **Decision points.** Wherever the path forks, that step becomes an
   `outcomes:` step — push the user to NAME the outcomes ("approved /
   rejected", "found / not-found"), don't accept "it depends". Each
   outcome either feeds a `when:` branch or falls to an `else_of:` step.
5. **Failure handling** for each risky step: retry how many times?
   Then escalate to whom? That's `on_fail: { retry: N, then: <step> }`.
   Steps that can't meaningfully fail need nothing.
6. **Loops.** Anything repeated until good? `outcomes: [good, again]` +
   `repeat_until: good`. Loops are ONLY expressed this way (or via
   `on_fail`) — the validator rejects dependency cycles.

**Templates.** For each step that produces output, ask: "what does good
output look like?" Check `scripts/plt.sh list` — if a matching template
exists, set `template: <name>` on the step. If not, draft one under
`templates/authored/` WITH a complete golden exemplar (the validator
rejects thin ones) and get the user's explicit yes on it before wiring
it in.

## Authoring rules

- **Files go to `workflows/authored/`** (and `templates/authored/`).
  `packs/` is shipped content — never write there.
- Start from `scripts/wf-scaffold.sh <name>` and uncomment/edit; the
  skeleton shows one example of every step kind.
- Frontmatter is the documented **simple subset of YAML** — see the repo
  README "Format reference". Nothing fancier parses.
- **Validate before presenting**: `scripts/plt.sh validate <file>` and
  fix every error — never show the user a draft that fails validation.
- Then `scripts/plt.sh render <name>` and **show the user the mermaid
  diagram** for a visual yes. Diagrams are generated, never hand-drawn.
- **Keep the edge vocabulary minimal.** The whole language is
  `needs` / `when` / `else_of` / `repeat_until` / `on_fail`. If the
  user's process seems to need more, simplify the process or split it
  into two workflows — never invent syntax.

## Agent-proposed workflows

When you (as an agent) notice a repeated multi-step pattern in your
punchlist history, you may DRAFT a workflow in `workflows/authored/`
and create a punchlist task for the owner: "review proposed workflow
<name>". **Never launch an unreviewed self-authored workflow.** The
owner's review of the draft is the gate.

## Safety

- Never author step titles/notes that would trip punchlist screening
  (credential harvesting, exfiltration shapes, pipe-to-shell,
  persistence-plus-download, "ignore previous instructions" phrasing) —
  a workflow whose steps get flagged is dead on arrival.
- High-risk-but-legitimate steps (installs, purchases — like
  research-and-buy's `order` step) are fine to author; just note to the
  user that they'll hit the out-of-band human confirm at runtime.
