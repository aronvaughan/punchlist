# punchlist-templates

Templates and workflows for agent-assisted work — the driving-context
layer above [punchlist](https://github.com/aronvaughan/punchlist).
Templates define what good output looks like (inputs + golden exemplars);
workflows choreograph multi-step, multi-actor work by compiling to
punchlist tasks. Markdown-first, Obsidian-curatable, mermaid-visualized,
agent-agnostic.

Shipped so far (P1 + P3): the template format, the `plt` CLI
(validate/list/show/render/launch/advance/runs), three core templates,
resolver skills for claude and hermes, and the workflow runtime — the
format, validator, mermaid renderer, compiler (`launch`) and advancer
(`advance`), plus one shipped workflow (`research-and-buy`). See
[docs/2026-08-25-prd.md](docs/2026-08-25-prd.md).

## Quickstart

```bash
git clone <this-repo> punchlist-templates
cd punchlist-templates

bin/plt list                    # what templates/workflows exist (name, kind, tags, path)
bin/plt show research-brief     # print a template — agents cat this into context
bin/plt validate all            # check every template and workflow
bin/plt render research-and-buy # regenerate a workflow's mermaid diagram in-file

# runtime (needs a punchlist server + $PUNCHLIST_TOKEN; see Workflows below)
bin/plt launch research-and-buy --input item="label printer" --input budget='$150'
bin/plt advance --all           # cron calls this; spawns next-step tasks
bin/plt runs                    # list run states

npm test                        # run the test suite (zero dependencies)
```

Install the resolver skill by copying the agent's directory from
`skills/` into that agent's skill dir:

```bash
# claude (Claude Code)
cp -r skills/claude/punchlist-templates ~/.claude/skills/

# hermes (or any agent with a skills dir)
cp -r skills/hermes/punchlist-templates <agent-skills-dir>/
```

The copied `scripts/plt.sh` forwards to the canonical resolver
(`skills/shared/plt-resolve.sh`), which locates this repo via
`$PUNCHLIST_TEMPLATES_DIR` or by walking up from its own real path — so
a symlinked install needs nothing, and a plain copy just needs the env
var set (or edit the shim to point at your checkout, as the reference
installs do).

## Format reference

Full contract: [docs/2026-08-25-prd.md](docs/2026-08-25-prd.md). A
template is markdown + frontmatter:

```markdown
---
name: weekly-review          # must match the filename
kind: template
domain: personal             # optional
inputs:                      # at least one, each WITH an exemplar
  - name: week_notes
    exemplar: "raw bullet notes, links, half-thoughts…"
output: markdown             # or json|table|email
tags: [review, writing]
---
## Output shape
<the skeleton the output must follow>

## Golden exemplar
<a complete, real-quality example — REQUIRED, validation fails without it>
```

Frontmatter is a deliberate **simple subset of YAML** — exactly what
`bin/plt` parses, nothing more:

- `key: value` scalars (optionally quoted; `# comments` stripped when
  unquoted)
- inline lists: `tags: [a, b]`
- inline maps: `when: { step: decide, outcome: approved }`
- one level of block lists of maps (`inputs:` with `- name:` /
  `exemplar:` pairs; a workflow's body-level `steps:` block follows the
  same rules)

`## Golden exemplar` is by convention the **last** section and may
contain its own `##` headings; every other section ends at the next
`##` heading (headings inside code fences don't count).

Files live at `templates/packs/<pack>/<name>.md` (shipped) and
`templates/authored/<name>.md` (yours). On a name collision, authored
wins.

## Authoring rules

1. **Golden exemplar required.** Write it as if a thoughtful person
   produced it for real — validation rejects missing or thin exemplars.
   Agents learn the quality bar from this section; it is the product.
2. **Every input carries an exemplar** showing what the raw input
   actually looks like, not a description of it.
3. **`name` matches the filename**; `plt validate` enforces it.
4. **Author under `templates/authored/`**, not in packs. Copy a pack
   template there to customize it.
5. Run `bin/plt validate all` before committing.

## Workflows

Workflows choreograph multi-step, multi-actor work. The core bet: **a
workflow compiles to punchlist tasks — there is no engine.** Each step
becomes a real task with an assignee; a small *advancer* watches for
completed steps and spawns the next ones. Monitoring, review, security
(vetting/screening), and notifications are all inherited from punchlist.
(Shipped in P3: format, validator, mermaid renderer, `launch` compiler and
`advance` advancer, plus the `research-and-buy` pack workflow.)

A workflow is one markdown file, `workflows/{packs,authored}/<name>.md`:

```yaml
---
name: research-and-buy
kind: workflow
inputs: [item, budget]
actors: [hermes, owner]
---
steps:
  - id: research
    assignee: hermes
    template: research-brief          # steps may reference templates
    title: "Research {item} under {budget}"
  - id: decide
    assignee: owner                   # a human step = a plain task for you
    needs: [research]
    outcomes: [approved, rejected]    # recorded as a check-one checklist
  - id: order                         # if …
    assignee: hermes
    when: { step: decide, outcome: approved }
    on_fail: { retry: 2, then: escalate }
  - id: shelve                        # … else
    else_of: decide
  - id: escalate
    assignee: owner
    title: "Ordering failed twice — take over"
```

The whole logic vocabulary, by design nothing more:

| Edge | Meaning |
|---|---|
| `needs: [ids]` | run after those steps complete (sequence / join) |
| `when: {step, outcome}` | branch: run if that step recorded that outcome ("if") |
| `else_of: <step>` | run when none of that step's `when` branches matched ("else") |
| `repeat_until: <cond>` | loop the step until the condition holds |
| `on_fail: {retry, then}` | error chain: retry N times, then hand to another step |

Branching runs on **outcomes**: a step may declare
`outcomes: [approved, rejected]`; its punchlist task gets one checklist
item per outcome (`Outcome: approved` …) and whoever completes the task
checks exactly one. That recorded value is what `when:` / `else_of` /
`repeat_until` react to. A step without `outcomes` records the outcome
`done` when its task completes. A step's task being *archived* without
completing means the step **failed**: `on_fail` retries it (fresh task,
same step) and then hands over to its `then` step; with no `on_fail` the
run halts as failed and the admin gets a notification task — once.

Diagrams are **generated, never drawn**: `plt render <workflow>` writes a
mermaid block into the file between markers — it renders in Obsidian, on
GitHub, and in web UIs. Hand-edited diagrams are invalid by rule.

### Running workflows

```bash
bin/plt launch research-and-buy --input item="label printer" --input budget='$150'
bin/plt advance --all        # apply edges: spawn next steps for every running run
bin/plt runs                 # run id, status, per-step state
```

`launch` validates, creates the initial step task(s) in punchlist, and
writes `runs/<run-id>.json`. `advance` is cron-friendly (see
`scripts/advance-sweep.sh`): it reads each running run, checks its
in-flight tasks (completed? outcome checked? archived?), and spawns the
next tasks — the decision logic is a pure function with table-driven
tests. Spawned tasks carry a machine-parseable trailer at the end of
their notes (`plt: workflow=… run=… step=… template=… attempt=…`) so the
advancer, agents, and searches can all find them.

Auth matches punchlist's `pl.sh`: `$PUNCHLIST_URL` +
`$PUNCHLIST_TOKEN`, with the same env-file fallbacks
(`$PUNCHLIST_ENV_FILE`, `~/.claude/secrets.local.env`,
`$HERMES_HOME/.env`). **Workflows that assign steps to `owner` require
`$PUNCHLIST_OWNER`** (the punchlist actor name of the human admin,
resolvable from the same env files) — `launch`/`advance` refuse to spawn
an owner step without it.

Agents that get stuck mid-step don't guess: they *block* their task with
one concrete question, the owner answers from the punchlist "Needs input"
lane (or chat), and the step resumes with the answer in context.

## Layout

```
templates/{packs,authored}/   # what good OUTPUT looks like
workflows/{packs,authored}/   # what happens in what ORDER, by WHOM
runs/                         # (gitignored) per-run advancer state
skills/{claude,hermes,shared} # resolver skills + canonical shim
bin/plt                       # zero-dependency CLI
scripts/advance-sweep.sh      # cron wrapper for `plt advance --all`
docs/                         # product analysis, PRD
test/                         # node:test suite
```

## License

MIT — see [LICENSE](LICENSE).
