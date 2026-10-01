# punchlist-templates

Templates and workflows for agent-assisted work — the driving-context
layer above [punchlist](https://github.com/aronvaughan/punchlist).
Templates define what good output looks like (inputs + golden exemplars);
workflows choreograph multi-step, multi-actor work by compiling to
punchlist tasks. Markdown-first, Obsidian-curatable, mermaid-visualized,
agent-agnostic.

Shipped so far (P1 + P3 + P4): the template format, the `plt` CLI
(validate/list/show/render/launch/advance/runs), three core templates,
resolver and workflow-writer skills for claude and hermes, and the
workflow runtime — the format, validator, mermaid renderer, compiler
(`launch`) and advancer (`advance`), plus two shipped workflows
(`research-and-buy`, `weekly-review-flow`). See
[docs/2026-08-25-prd.md](docs/2026-08-25-prd.md).

## Quickstart

```bash
git clone <this-repo> punchlist-templates
cd punchlist-templates

bin/plt list                    # what templates/workflows exist (name, kind, tags, path)
bin/plt show research-brief     # print a template — agents cat this into context
bin/plt validate all            # check every template and workflow (also refreshes index.json)
bin/plt index                   # regenerate templates/index.json (the punchlist bridge)
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

The **workflow-writer** skill (`skills/{claude,hermes}/workflow-writer`,
installed the same way) is the authoring playbook: it interviews you one
question at a time — goal, actors, happy-path steps, named decision
outcomes, failure handling, loops — starts from a commented skeleton
(`skills/shared/wf-scaffold.sh <name>` → `workflows/authored/<name>.md`),
drafts any missing templates with golden exemplars, then validates and
renders the mermaid for a visual yes. Agents may use it to *propose*
workflows from repeated patterns: the draft lands in `authored/` with a
review task for the owner — an agent never launches a workflow it
authored without that review.

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

The process spine (`plt run`, `plt step`) reads `repeat_until` the same way.
A step settled with any other outcome goes back to `ready` and records a
`repeated` time event; the steps that need it stay pending. A human gate on
a re-opened step counts only approvals given after the re-open, so each round
asks again. The `reply` step uses this: `outcomes: [replied, done]` and
`repeat_until: done` make it one owner approval per reply, at the same pin or
a new one. `plt run close` retires it.

`pr-loop` (`repeat_until: approved`) now loops too: finishing it with
`changes_requested` re-opens it, and `merge` stays pending. This changes
landing: when GitHub reports a PR merged while `pr-loop` is re-opened, the
poll walks `pr-loop` as an unfinished step, finds its owner gate unapproved
for this round, and stops the landing with `cannot satisfy gate:reply-approved
from a poll`. The PR lands after a human approves the round. An `arm_on` loop
step re-opens to `pending`, and the poll re-arms it when its fact holds again.

Between rounds (the step's last event is `repeated` and no poll has re-armed
it since) there is nothing to approve. Prime's NEXT line, the run page and the
board name the wait (`waiting on the next reply`), the menu is in `WAITING`
mode (`where`, `next`, `capture`: no `approve`, no `go`), and the run is not in
Needs you. When the next reply arrives, every surface offers the approval
again.

A formula's `menu:` frontmatter block is parsed and read by nothing. The menu
words come from `config.menu.words`; the commands are constants in
`lib/spine.js`.

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

### Validation: `plt validate`, and at launch

`plt validate [path|all] [--project <dir>]` checks the grammar of each file.
With a process directory (`--project`, else `$PLT_PROCESS_DIR`, else the
nearest `process/config` above the cwd) it also checks the values that need
the project:

- `gate.signal` is in `config.gates.human_signals`;
- `jira.on_start` / `on_done` are in `config.jira.statuses`;
- each `skills` name is a directory holding `SKILL.md` under
  `<project>/.claude/skills` or `~/.claude/skills` (a `plugin:skill` name is
  not checked), and each `agents` name is an `.md` file under
  `<project>/.claude/agents` or `~/.claude/agents`;
- an `artifact` names a template plt resolves, or one under
  `<project>/process/templates`.

With no process directory these checks have no lists to check against, and
`plt validate` says so on stderr.

`plt run launch` and `plt run recompile` run the same validator on the
formula that launches: an overlay (`extends: core/<name>`) merged with its
base, not the overlay file alone. Any error refuses the launch before anything
is written, one line per error:

```
formula process/cycles/spike.md:14: step `investigate`: notes uses {bench} which is not a declared input
```

The file is the one to edit: an error on a step the overlay overrides names
the overlay; an error on a step it inherits names the pack file.

### Efforts and parallel lanes

An *effort* groups the cards of one body of work so several can run at once
without stepping on each other. It lives at `process/efforts/<slug>.yaml`:

```yaml
slug: greenhouse
title: Greenhouse telemetry
cards:
  - { id: TRK-10, title: rename the sampler, cycle: build-and-ship, estimate: 0.25,
      touches: [packages/sensors, packages/dashboard], after: [] }
  - { id: TRK-11, title: dashboard store, touches: [packages/dashboard/src/store], after: [TRK-10] }
  - TRK-14          # a bare id: cycle build-and-ship, no touches, no after
```

Per card: `id` (a plain identifier — letters, digits, `.`, `_`, `-`), `title`,
`cycle` (a workflow name; default `build-and-ship`), `estimate`, `touches`
(path prefixes the card expects to change) and `after` (card ids that must
be closed first).

```bash
bin/plt effort plan <slug>                    # the wave: cards that can start now, and why the rest can't
bin/plt effort launch <slug> [--parallel] [--dry-run] [--only ID,ID] [--owner who]
```

`plan` puts a card in the wave when every `after` card is closed and its
`touches` overlap no running card and no card already in the wave. `launch`
makes, per card in the wave, a worktree off the canonical checkout
(`config.worktree`), a run, and a window (`config.windows`); without
`--parallel` it launches only the wave's first card. `--dry-run` prints every
command and changes nothing.

Three points in a cycle evaluate the lanes live (no receipt is recorded):

- `scope` — a step with `touches: declared` records the card's declared
  touches (`plt receipt --kind touches --name declared --files a,b`).
- `pre-pr` — a step with `overlap: effort` is blocked while another in-flight
  run of the same effort has changed one of the same files. The same step
  compares the files actually changed against the declared touches; each file
  outside them becomes a `touches-drift` extrapolation on the run page (a
  flag, not a gate).
- `open-pr` / `merge` — file overlap again, plus base freshness: the branch is
  fresh only while `origin/main` is one of its ancestors; otherwise the gate
  asks for a rebase.

Diffs are measured from the branch base — the merge-base with `origin/main`,
or, with no remote, the commit the run launched from — so committed work
counts, not only what is staged.

### Boards: `plt render`

The effort index and each run's status page are rendered from state alone —
`process/efforts/*.yaml`, `process/runs/*/{state.yaml,inputs.yaml,events.jsonl,HANDOFF.md}`
and the facts snapshot `plt facts` keeps on a run. Nothing here calls `gh`; a
run whose facts were never collected says "not collected yet".

```bash
bin/plt render index                          # process/build/index.html
bin/plt render run TRK-10                     # process/build/run-TRK-10.html
bin/plt render all [--out <dir>]              # every page; prints the ones whose content changed
bin/plt render --published TRK-10 <url>       # after publishing: store the url, record the run-TRK-10 receipt
bin/plt render --published index <url> --run TRK-10   # same for the index (effort-index receipt on --run)
```

`process/build/publish.json` is the manifest — `{index: {sha, url?, changed},
runs: {<id>: {sha, url?, changed}}}`. A page is `changed` when its content
differs from the last render (or from what was last published), so the session
that owns the boards republishes only those. Ignore `process/build/*` except
`publish.json`: the pages are derived, the manifest carries the urls.

Project literals come from `config.links`: `card` (url template, `{card}`),
`pr_repo` (`owner/name`, for PR urls built from a bare number), and optionally
`repo_blob` (`{path}`, for an effort's relative links) and `board` (the curated
narrative board the index footer names).

#### Publishing: `plt publish`

`plt render` never publishes. Publishing reaches people, so it stays a
deliberate act. After `changed: …`, `plt render` prints `next: plt publish
<target>` (or `next: plt publish` when several pages are behind).

```bash
bin/plt publish                                   # every page behind its last publish
bin/plt publish TRK-10 [--json]                   # one page
bin/plt publish --record index --url <url>        # an artifact that already exists: record its url
```

A page is behind when the sha256 of its bytes on disk differs from
`published_sha` in `publish.json`. For each one, `plt publish` prints the exact
Artifact call: the update in place when a url is on record, else the step to
record an existing url, then a create call for the case where none exists.
It writes nothing. After the call, `plt render --published <target> <url>`
records the sha of the page on disk and the artifact receipt. It records
before it renders anything in the same call, so the sha is the page the human
published; a render after it that differs stays pending. `--record` stores
a url with no publish, so the page stays pending until it is republished.

### Watch: `plt watch` and the timer

`plt watch [--once]` is `facts` → `render all` → notify, on a timer, with
catch-up. Each pass:

1. `facts.collect` — every in-flight run naming a PR, refreshed.
2. `render.renderAll` + `writeBuild` + `publishManifest` — every page.
3. For each run under `process/runs`, compares `spine.nextCommand(state)`
   against the value `process/build/watch.json` recorded for it last time.
   A run seen for the first time only records its baseline — nothing to
   compare against yet, so nothing is notified. A run whose next command is
   unchanged stays silent. A run whose next command changed runs
   `config.windows.notify`, rendering `{run} {text} {next} {tab_id} {pane_id}
   {label}` (`text` is `"<run>: <old next> → <new next>"`; `tab_id`/`pane_id`/
   `label` come from the run's `inputs.window`, recorded by `effort launch`
   when a window actually opened). A run with no `inputs.window` still
   notifies when the template names none of those three placeholders; when it
   does, the run is skipped and logged instead of crashing the pass.

Without `--once`, `plt watch` loops forever on `config.timers.watch.every`
(`"10m"`, `"90s"`); `--once` is what the installed timer actually runs.
Notification failures are logged to stderr and never fail the pass.

```bash
bin/plt watch --once     # one pass — what the installed timer runs
bin/plt watch            # loop forever on timers.watch.every
```

Install the OS timer that runs `plt watch --once` on a schedule:

```bash
bin/plt integration install timers --project <dir> [--load]
bin/plt integration status timers  --project <dir>
```

`install` always writes the unit file(s) — a macOS launchd agent
(`~/Library/LaunchAgents/<label>.plist`, `StartInterval` in seconds) or a
Linux systemd user service+timer pair
(`~/.config/systemd/user/<label>.{service,timer}`, `OnUnitActiveSec`,
`Persistent=true`); both are idempotent — the same config writes the same
bytes every time. `--load` is the only thing that talks to the OS
(`launchctl load` / `systemctl --user enable --now`) — without it the timer
is on disk but not yet running. `status` reports `installed <path>
(loaded|not loaded)`, or `not installed`.

Config: `timers.watch.every` (the poll interval) and `timers.label` (unit
name; defaults to `plt.watch.<project dir basename>`).

**Upgrading an existing project to this version.** Re-run `plt integration
install timers --project <dir> --load`: the macOS launchd path moved from
`load` to bootout/bootstrap/kickstart, and `status` now fails a timer that has
NEVER RUN, so an already-installed timer keeps running the old unit until it is
reinstalled. Add `process/suggestions.md` to the project's private `.gitignore`
before the first `plt mine` — it is a generated backlog, not a tracked file.

### Blocking on a question: `plt step block` and `plt answer`

An agent that needs a person to answer something before it can go on blocks
the step. The question goes into the ledger, not into chat.

```bash
bin/plt step block [<step>] --run TRK-10 --question "which bench gets the seedlings?"
bin/plt step answer [<step>] --run TRK-10 --text "bench 3" --by human:pat
bin/plt block TRK-10 [<step>] --question "…"     # the same writers, run first
bin/plt answer TRK-10 [<step>] --text "…" --by pat
```

- `block` takes an `in_progress` or `in_review` step (default: the current
  step) to `blocked` and appends a `question` event.
- `answer` returns the step to the status it had and appends an `answer`
  event that points at the question (default step: the one blocked step).
  `--by` must name a person, and one on `config.actors.humans` when the config
  has that list.
- Both take `--take-over` and refuse a window that does not drive the run, as
  every other step writer does.
- A blocked step wins over the current step: prime, the menu (`BLOCKED`) and
  the board show it with the question text.

### Dropping a card: the discard exit

A run on any cycle can end early through the `discard` exit
(`workflows/packs/core/discard.md`). It is not a cycle of its own — it
replaces the rest of the running cycle, so a dropped card leaves the same
kind of record as a merged one instead of stalling at whatever step it was on.

```bash
bin/plt run discard TRK-12 --by human:o --reason "adds code we would delete" --replaced-by TRK-99
```

That command is the owner's gate. It retires every unfinished step of the
cycle (`skipped` / `discarded`), records `run-discarded` on the exit's `drop`
step in the owner's name, and appends the exit's steps; the agent then walks
them like any other step:

- `record` — needs the tracker status from `config.jira.status.discarded`,
  the skills in `config.skills.discard`, and — checked live against the file,
  never from a receipt — the card listed under `dropped:` in its effort file.
  Its outcome states what became of the branch: `worktree_kept`, or
  `worktree_removed`, which is refused while the run's `repo_dir` still exists.
- `close-out` — whatever the overlay requires (typically the republished
  effort index), then `plt run close`, which marks the run `closed_as:
  discarded`.

```yaml
dropped:
  - { id: TRK-12, reason: adds code we would delete, replaced_by: TRK-99 }
  - TRK-14
```

`plan` never schedules a dropped card, and a card whose `after` names one is
excluded with "re-point the dependency": a discarded run does not count as
closed for anything that waited on it.

### Digest: `plt digest` and the standup

A digest is a daily or weekly rollup computed PURELY from every run's
`events.jsonl`/`state.yaml`/`inputs.yaml` and `efforts/*.yaml` — no `gh`, no
side effects. `lib/digest.js#collectDigest(processDir, {from, to})` reads the
window `[from, to)` and returns:

```
{ runs: [{id, effort, cycle, from_step, to_step, transitions}],
  time: { by_category: {<step id>: hours}, by_actor: {human, agent} },
  gates: [{run, step, signal, by, at}],
  decisions: { settled: [{id, question, effort}], open: [{id, question, age_days, effort}] },
  extrapolations: [{run, step, key, assumed}],
  estimates: [{run, estimate: {value, unit}, actual: {value, unit} | null, actual_missing}],
  reviews: [{pr, step}] }
```

Run ids are `DIGEST-<yyyymmdd>` (daily) / `DIGEST-<yyyy>W<ww>` (weekly, ISO
week), and every window is **UTC midnight to midnight** — a fixed `--for
<date>` collects the same window regardless of the machine's local time.

Time by category is wall-clock between a step's `started`/`finished` time
events, clipped to the window, and categorised two ways: by step id
(`by_category`) and by that step's assignee in its run's own formula — an
`owner` step reads as `human`, everything else as `agent` (`by_actor`). A step
still in progress at the window's end (`started`, never `finished`) counts
from `max(started, from)` up to `to` — it is doing real work through the
window, not zero hours for not having finished yet. Decisions are a live
snapshot of `efforts/*.yaml`, not window-scoped, and each carries the
`effort` it belongs to (decision ids are only unique WITHIN an effort — two
efforts can each have their own `D-002`): an open decision's `age_days` is
measured from its `since`/`opened` date to the window's end, or `null` when
no date was recorded — never derived from a file's mtime.

```bash
bin/plt digest launch --for 2026-09-18 [--weekly] [--owner who]
                                           # start a DIGEST run for that date/week;
                                           # idempotent — a no-op when that run already closed
bin/plt digest collect --for 2026-09-18 [--weekly] [--out f]
                                           # pure rollup -> process/digests/2026-09-18.json
bin/plt digest standup --for 2026-09-18   # Preparing/Ready/Blockers as Slack bullets (`*`, never `-`)
```

The `digest` cycle (`workflows/packs/core/digest.md`) is `collect` (a `files:
[digest-json]` receipt — `plt digest collect` writes the JSON directly, then
`plt receipt --kind file --name digest-json --ref process/digests/<date>.json`)
→ `write` (the `digest` template, from the collected numbers) → `write-review`
(the writing-adversary gate) → `close-out` (`files: [digest-md]`, publishes
`process/digests/<date>.md`). No owner step: the write-review gate is the
only review, and there is nothing for a human to approve before it publishes.
`--weekly` merges the ISO week's five daily JSONs (Monday–Friday) when they
exist, or falls back to a direct 7-day collect. A run active across several
days of the week appears ONCE in the merged `runs`: the earliest day's
`from_step`, the latest day's `to_step`, `transitions` summed.

`plt digest standup` reads the same collected decisions (every open one
becomes a Blocker) plus each run's LIVE current-step status: `in_progress` is
Preparing; a step `in_review` on a HUMAN gate is a Blocker (`<run>: my
approval — <step>`) — every human gate in the shipped formulas is the
owner's, and the owner is the standup's own poster, so it is never "waiting on a human", it is the
poster's own approval sitting there; a step `in_review` on an EXTERNAL gate,
or a run with no current step still waiting on a formula's `arm_on` condition
(an author's reply, GitHub going green, a reviewer's approval), is Ready
("waiting on others"); `blocked` is a Blocker.

The spine does not schedule anything: whatever runs `plt digest launch` on a
timer owns the time of day and the weekday. There is no `digest.*` config key.

### Sync and mine

`plt sync [--since <iso>] [--json]` answers "what moved since the last
session": one `facts.collect` pass (best-effort — a `gh`/auth hiccup is
logged and never crashes the pass), then every run's
`spine.nextCommand(state)` is compared against `process/build/sync.json`,
the snapshot the last `plt sync` recorded. Separate from `watch.json`
(`plt watch` notifies windows on a timer; `sync` reports to a human) —
the two never share or reset each other's baseline. A run seen for the
first time (a new run, or the very first `plt sync` ever) is seeded
silently — nothing has "moved" relative to a baseline that did not exist.

```bash
bin/plt sync
# TRK-12: plt step start build --run TRK-12 → plt step finish build --run TRK-12 --outcome <outcome>
# since 2026-09-24T09:00:00.000Z: 1 moved, 3 unchanged

bin/plt sync         # nothing changed since last time
# nothing moved
```

The SessionStart hook (`integrations/claude/spine-prime.py`) runs `plt sync`
first and puts its last line above the run's own prime as "since your last
session: …" — one read of the whole board before the one run you're on.

`plt mine [--effort <slug>] [--since <iso>] [--out <file>] [--json]` is
deterministic aggregation — **no model** — across every run's
`events.jsonl`, written as a markdown report (`process/suggestions.md` by
default; `--out` overrides). Four sections, each row ordered by count
descending then id ascending:

- **Re-prompt families** — `reprompt` receipts (menu near-misses, style/skill/
  jira/status families the `UserPromptSubmit` hook tags) grouped by `name`,
  with the count and the run ids.
- **Extrapolations** — `extrapolation` events grouped by `missing.key`, with
  the count, the run ids, and the most recent `assumed` text.
- **Gate re-approvals** — a step approved more than once within a run (a
  follow-on fix re-approved after the first pass), grouped by step, with the
  count of re-approvals and the run ids.
- **Writing-adversary fail rate** — for every agent named in a run's own
  `config.review.writing_agents`, the fail/total tally per step.

Each row ends with a proposed target (a formula key, a template section, a
config value, or a skill) — a place a human might look to fix the pattern.
`plt mine` never edits a formula or config; acting on a row is a human
decision.

```bash
bin/plt mine                       # process/suggestions.md
bin/plt mine --effort taxonomy-p2  # only runs whose inputs.effort matches
bin/plt mine --json                # the same structure as JSON
```

### Gates: `hard` and `banner`; `plt lint prose`

Every `kind: adversarial` gate declares what a failing reviewer does —
`mode: hard` holds the step (the reviewer's pass is a missing receipt until it
lands), `mode: banner` records the fail and prime shows it as
`⚠ banner: <agent> failed`, nothing held. The core formulas take the mode
from config: `review.panel_mode` for the defect panels, `review.writing_mode`
for the writing reviews. A `{{config.*}}` mode ref that the project's config
does not define falls back to `hard` — the safe mode, which holds the step
rather than waving a fail through — so a config key is an override, never a
requirement, and a new adversarial gate can never crash `plt run launch`. A step's
requirements are recompiled from the formula and config on every
`plt step start`, so a mode or reviewer change lands on the next step, not
the next run.

`plt lint prose <file|->` is the deterministic pass a writing review runs
before the adversary reads the text: sentences over 25 words, words in
`config.writing.banned`, tracker keys matching `config.writing.ticket_pattern`
in code comments (and anywhere in a test file), and an ALL-CAPS acronym used
before `Long Form (ACRONYM)` defines it (a shipped default list — CLI, JSON,
YAML, URL, API, HTTP(S), ISO, UTC, MIT, and others — plus
`config.writing.known_acronyms` are exempt, and so is a token that also
appears elsewhere in the file in a non-all-caps form, e.g. `PURELY` .. `purely`
— an ordinary word capitalized for emphasis, not an acronym). One
`file:line: rule — text` per hit, exit 1 on any; `--json` for the list.

`lint-prose` is **advisory**: the write-review steps name it in their `notes`
(run it, fix every hit, then record `plt receipt --kind tool --name
lint-prose`), but it is never compiled into `receipts_required` — a missing
or failing lint-prose receipt never blocks a gate.

One window drives a run at a time. `plt step start` claims the caller's
window — `$PLT_WINDOW`, which a seeded window exports because `windows.open`
renders `PLT_WINDOW={pane_id}` into the command it launches — as
`state.owner_window`; `plt handoff` and `plt run close` release it. A step,
receipt or gate call from another window is refused with `run <id> is driven
by window <w>; hand off first (or --take-over)`; `--take-over` moves the claim
and logs a `taken-over` event. A caller with no window never claims and is
never refused.

### Fanning a plan out

`plt fan <plan-file> [--ledger <path>] [--json]` prints the wave: the plan's
tasks that can run at the same time now. It is read-only. It runs the same
computation `plt effort plan` runs over an effort's cards.

A task block in the plan declares two facts. Its `**Files:**` bullets list
every file it writes. Each `Consumes: … (Task N)` bullet under
`**Interfaces:**` declares a dependency on task N. A `Task N` string anywhere
else in the block creates no dependency, and fan reads nothing past the
Interfaces section.

A task joins the wave when all of these are true:

- the ledger (`--ledger`, default `.superpowers/sdd/<plan-slug>/progress.md`)
  has no `- Task N: complete` line for it;
- every task it consumes is complete;
- it declares at least one file;
- no lower-numbered open task declares a file it declares. The lower number
  gets the file; the higher one waits for the next wave.

```bash
bin/plt fan docs/plans/greenhouse-plan.md
# wave: T2 T4
# excluded: T3 — after Task 2 (not complete)
# excluded: T5 — shares lib/sensor.js with Task 4
```

The rule for a wave: *dispatch the computed wave; the per-task reviewer and
the fix loop stay serial per task; two agents never share a file, which is
what makes the wave safe.*

This supersedes the older blanket guidance "never parallelise implementers".
The wave computation supersedes it, not judgement. A task is parallel-safe
only when `plt fan` puts it in the wave. A task with no declared `**Files:**`
block is never parallel-safe.

### Command registry

`bin/plt` does not name its verbs. At start it loads every `lib/*.js`, collects
each module's `commands` export, and dispatches on the first argument. To add
a verb, export one descriptor from the module that owns it:

```js
module.exports = {
  commands: [{ name: 'fan', usage: 'plt fan <plan-file> [--json]', handler: (argv, ctx) => 0 }],
};
```

`argv` is the arguments after the verb. `ctx` is `{cwd, env}`. The handler
returns the exit code (or a promise of one) and never calls `process.exit`,
so a test can call it in-process. Two modules that export the same verb stop
the CLI with an error that names both files. `plt help` prints every usage
line, sorted. No other file changes when a verb is added.

### Doctor and fsck

`plt doctor [--project <dir>] [--json]` proves the framework works on this
machine, for this project. It is read-only. It runs eleven checks:
`plt-resolvable`, `process-dir`, `config-layering`, `formulas-validate`,
`schemas`, `hooks-installed`, `timers-running`, `denylist-file`, `gh`,
`tracker` and `runs-consistent`. Each check reports what it proved, not what a
state file claims. For example, `gh` runs `gh auth status`; it does not only
look for a config key. A shell-out that takes more than 5 seconds reports
`skip`, not `fail`. Every failed check prints one pasteable fix command, in
order. Exit 0 when nothing failed, else 1.

`plt fsck <run> | --all [--fix] [--project <dir>] [--json]` checks each run's
four parts against each other: the event ledger, the state, the formula the
state follows, and the receipts in the ledger. Each finding has a code, a
severity, the full path of the file, and the command that fixes it:

| Code | Severity | `--fix` |
| --- | --- | --- |
| `E_EVENT_TRUNCATED` — the last ledger line does not parse (a crash mid-append) | error | drops the line |
| `E_EVENT_PARSE` — an earlier line does not parse | error | no |
| `E_EVENT_IDS` — a byte-identical repeat of the line before it (a retried append) | error | drops the repeat |
| `E_EVENT_IDS` — any other gap or repeat in the ids | error | no |
| `E_UNKNOWN_STEP` — state names a step the formula does not define | error | no |
| `E_MISSING_STEP` — the formula defines a step state does not carry | error | adds it: `pending` on an open run, `skipped` / `retired` on a closed run |
| `E_NO_REQUIREMENTS` — a step that is not skipped has no `receipts_required` | error | recompiles it |
| `E_REQUIREMENTS_DRIFT` — an unfinished step's requirements differ from a fresh compile | warn | recompiles it |
| `E_PIN_UNRESOLVED` — a commit pin the run's repo cannot resolve | error | no |
| `E_RECEIPT_ORPHAN` — an event names a step state does not carry | error | no |
| `E_EVENT_SCHEMA`, `E_STATE_SCHEMA`, `E_INPUTS_SCHEMA` — a file fails its schema | error | no |
| `W_GH_NAME_SPELLING` — a gh receipt and its requirement differ only in `_` vs `-` | warn | no |
| `W_RECEIPT_UNUSED` — a receipt no requirement of its step asks for | warn | no |
| `W_NO_FACTS_SNAPSHOT` — a closed run with no facts snapshot | warn | no |

Without `--fix`, fsck changes nothing. With `--fix`, it repairs only what it
proved wrong. It writes only through `spine.writeState`, `spine.appendEvent`
and `spine.rewriteEvents`, so every repair takes the run lock (see "Write
discipline"). It records what it fixed as one `fsck-fixed` time event, unless
the ledger ids are still broken. A run is ok when it has no error finding.
`plt doctor`'s `runs-consistent` check is `plt fsck --all`.

### Schemas

Five JSON Schemas (draft 2020-12) in `schemas/` state the shape of every file
the spine writes: `state`, `event`, `inputs`, `effort` and `config`. They are
data, so an editor or a CI step can read them without plt.

```bash
bin/plt schema list                                          # each kind and its file
bin/plt schema validate state process/runs/TRK-12/state.yaml
bin/plt schema validate event process/runs/TRK-12/events.jsonl   # one event per line
```

`validate` exits 0 on a valid file. On an invalid file it prints one
`<path>: <message>` line per problem and exits 1. `plt fsck` validates each
run's state, inputs and events. `plt doctor`'s `schemas` check validates every
run. The event kind list in `schemas/event.schema.json` is the only list:
`appendEvent` refuses an event with no kind or a kind that list does not name.

### Receipts the spine did not earn: `out_of_band`

A receipt is evidence the spine collected while a step ran. Two paths write
one that is not:

- `plt receipt` for a step that is not `in_progress` or `in_review` (not
  started yet, or already done), or with no step;
- the landing path, which back-fills a passing `gh` receipt for each missing
  `gh` requirement once GitHub says `MERGED`.

Both record the receipt with `out_of_band: true`. A `gh` fact that `plt facts`
(actor `facts`) records on a step whose requirements name it is not marked,
even when that step has not started (`merge` waits on `pr-loop`): the spine
collected it. The exemption follows the collector's code path, not the actor
name: `plt receipt --actor facts` is refused. It still counts toward the
gate: the spine records and marks it, and never refuses it. Prime prints
`⚠ <n> receipts recorded out of band`. The run page shows them per step as
`(+n out of band)`, apart from the receipts seen, and on its Signals line. The
index row adds an `o` counter.

### Write discipline

Every write to a run's `state.yaml` or `events.jsonl` holds the run lock. The
lock is `process/runs/<run>/.plt.lock`, created with an exclusive open. The
calls that take it:

- `spine.writeState` writes to a temp file under the lock, then renames it
  onto `state.yaml`. A reader sees the old state or the new one, never half a
  file.
- `spine.readState` remembers a hash of the text it read. Under the lock,
  `writeState` compares that hash with the file. If another writer changed the
  file after the read, the write fails with `state.yaml for <run> changed
  since it was read — re-read and retry`. A lost update becomes a refusal.
  A state object that was not read from the file, such as a new launch,
  writes without the check.
- `spine.appendEvent` holds the lock across the read and the write. The new
  event's id comes from the ledger's length, so two writers that both read
  first would take the same id. It still drops a torn last line before it
  appends.
- `spine.rewriteEvents` rewrites the ledger under the lock. Only `plt fsck
  --fix` calls it. fsck abandons the rewrite if the ledger changed after it
  read it.

A writer that finds the lock held retries for 5 seconds. Then it fails with
`another plt is writing <dir>; retry in a moment`. It never writes without
the lock. A lock older than 30 seconds belongs to a writer that crashed, so
the next writer removes it once and retries. Two processes that append 50
events each to one run produce `e000001` to `e000100`, with no gap and no
repeat.

### Denylist gate

The publishable tree must never carry a client word. A denylist scan guards
it at commit time and in CI. The scan runs three checks, in the same order as
the publish script:

1. The path allowlist. A file outside the publishable paths is a hit.
2. The denylist. Generic patterns, plus the private terms file, match against
   the file contents.
3. gitleaks, over a commit range.

A hit prints `<file>:<line>: denylisted string`. It never prints the matched
word, so a CI log cannot leak the list. Exit 0 is clean, 1 is a hit, 2 is a
usage or configuration error.

The terms file is never committed. It is `$LEAK_TERMS`, default
`~/.config/leak-scan/terms.txt`, one extended regex per line, mode 600. The
scan refuses to run without it. The pre-commit hook runs the scan with
`--staged`. The install script refuses to replace a pre-commit hook it did
not write. The CI job (`.github/workflows/denylist.yml` at the repo root, where GitHub reads workflows) writes the terms
file from the `LEAK_TERMS` secret and scans the pull request's range.
`plt doctor`'s `denylist-file` check proves the terms file exists, is not
empty, and has mode 600.

### Harvest and bump

`plt mine` writes suggestions. A human picks one row.
`plt harvest <id> [--dry-run] [--json]` turns that row into one bounded edit
on a new branch, `harvest/<id>-<signal>`:

- The edit writes only the value the row names after `proposed: `. A row
  with no proposed value is refused.
- The row's target says where the edit goes.
  `config:<dotted.path>` changes one line of a config file.
  `formula:<cycle>:<step>:<key>` changes one key of one step.
  `template:<pack>/<name>:<slot>` adds one comment line above the slot marker.
- A shipped pack file or a default config key is edited in the templates
  checkout. An overlay or an org config key is edited in the project repo.
  One call never writes to both.
- harvest commits on the new branch, prints the diff and the
  `gh pr create` command, and returns the repo to the branch it was on. It
  never merges, pushes or opens a pull request. A human does that.
- A second harvest of the same row finds the branch and does nothing.

The project names the templates checkout in `harvest.templates_dir`, or in
`$PUNCHLIST_TEMPLATES_DIR`.

`plt bump --target <t> --expected <text> --measure-at <date> [--id <id>]`
adds an entry to the top of `process/CHANGELOG.md`: the target, the source
suggestion, the change, what it is expected to do, and when to measure that.
When the target is a formula or a template, bump also increments its
frontmatter `version:`, so a run launched after the change shows it.

### Per-window worktrees

A run's `owner_window` protects the run. The repo-window guard protects the
checkout the run works in: two windows in one checkout overwrite each other's
uncommitted work. Give each window its own worktree:

```bash
scripts/plt-worktree.sh alice
# /path/to/repo/.worktrees/alice
# export PLT_WINDOW=alice
```

The script creates `.worktrees/<name>` on branch `window/<name>` from
`master`, or reuses it, and installs dependencies when they are missing.

`plt repo claim|status|release [--repo <dir>] [--take-over]` manages a claim
on a checkout. The window is `$PLT_WINDOW`. A claim is the file
`.plt-owner.json` in the checkout's own git dir (`git rev-parse --git-dir`), so
each worktree has its own claim. It is written under a lock in the same
directory. Git never lists either file, so a claimed checkout still pins
clean and needs no `.gitignore` line. `claim` refuses a checkout another
window holds, unless `--take-over` is given. `status` only reads.

`plt step start`, `plt step finish` and `plt receipt` check the claim on the
run's `repo_dir` before they check the run's `owner_window`. Any other window
is refused with `repo <dir> is being driven by window <w>; use your own
worktree (scripts/plt-worktree.sh <you>) or pass --take-over`. A caller with
no `$PLT_WINDOW` passes, as it passes the run guard: the watch timer, a poll
and a plain shell are not windows. The run-level `--take-over` does not move a
repo claim; use `plt repo claim --take-over`. A run with no `repo_dir` has no
checkout to guard, and an unclaimed checkout refuses nobody.

## Layout

```
templates/{packs,authored}/   # what good OUTPUT looks like
templates/index.json          # generated: {templates:[{name,kind,tags,domain,output,path}]}
                              #   the least-coupled bridge — punchlist READS it
                              #   for its template picker (never shells plt).
                              #   Regenerated by `plt index` / `plt validate all`.
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
