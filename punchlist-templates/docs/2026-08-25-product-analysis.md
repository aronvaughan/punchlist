# punchlist-templates — Product Analysis

*Templates and workflows for agent-assisted work: the "driving context"
layer above punchlist. Decisions agreed 2026-08-25.*

## Problem

Tasks say WHAT; steps say roughly HOW-MUCH. Two things are missing:

1. **Templates** — what good OUTPUT looks like. Agents produce better work
   from exemplars ("a weekly review looks like THIS") than from prose
   instructions. Today that knowledge lives nowhere reusable.
2. **Workflows** — multi-step, multi-actor sequences with branching,
   loops, and error chains ("intake → research → draft → my review →
   publish, retry twice on failure"). Today each run is improvised.

Both must be: agent-parseable, human-curatable (Obsidian/markdown),
visual (rendered, not hand-drawn), agent-agnostic, and integrated with
punchlist's assignment/monitoring/security rails.

## The load-bearing bet (agreed)

**Workflows compile to punchlist tasks; there is no workflow engine.**
Each step becomes a discrete punchlist task (assignee, template ref,
workflow/step metadata). A tiny *advancer* reacts to task completion and
spawns the next step(s) per the workflow's edges. Everything else is
inherited from punchlist: the Agents board is workflow monitoring, the
review lane is approval, vetting/screening is security, Telegram is
notification. We deliberately do NOT build engine #5 alongside n8n, GSD,
hermes kanban, and Claude's Workflow tool — those orchestrate
computation; this choreographs *accountable work items*.

## Concept boundaries (agreed)

| Concept | Answers | Lives in |
|---|---|---|
| Skill | how an agent DOES something | agent skill dirs |
| Template | what OUTPUT should look like (inputs + golden exemplars) | this repo |
| Workflow | what happens in what ORDER, by WHOM | this repo |
| KB | what we KNOW | kb vaults |
| Task | one accountable unit of work | punchlist |

Skills SHOULD reference templates/workflows for context (agreed) — a
skill's "produce X" step cites `template: weekly-review` rather than
inlining an example.

## How agents consume it (agreed mechanics)

CLI claude/hermes already read punchlist tasks as JSON (pl.sh / MCP). A
workflow-spawned task carries `workflow`, `step`, and `template` refs in
its metadata; the agent resolves those to markdown files in its local
clone of this repo and loads them as driving context before working.
Pointer-following, no new protocol.

## Stuck agents: "needs input" as a punchlist primitive

An agent that cannot proceed finishes its task into a **blocked** state
with a concrete question. Punchlist grows a "Needs input" lane (sibling
of Review); the question rides the existing Telegram brief; the human's
answer un-blocks, and the advancer respawns the step with the answer in
context. Same rails as approval — no new channel. (This lands in
punchlist proper as a prerequisite.)

## Alternatives considered

- **n8n / node-RED**: real engines, wrong grain — they run computations,
  not accountable human/agent work items; poor markdown/curation story.
- **GSD / Claude Workflow tool**: session-scoped orchestration; not
  cross-agent, not human-curatable artifacts.
- **Plain skills**: no visual, no per-run state, collapse the
  output-shape/process distinction.
- **BPMN tooling**: heavyweight, hostile to markdown curation.

**Verdict: build** — thin by design: markdown + frontmatter + a compiler
+ an advancer + mermaid generation. The hard parts (state, security,
approval, monitoring) are already shipped in punchlist.

## Risks

1. *Advancer correctness* (branching/loops over an async task store) —
   mitigate: tiny pure function over explicit edge types, table-driven
   tests, same discipline as the recurrence engine.
2. *Template sprawl / curation debt* — mitigate: packs/ vs authored/
   split, a periodic curation audit checks placement, every template must carry
   at least one golden exemplar to be valid.
3. *Scope creep toward engine #5* — mitigate: the bet above is written
   down; anything needing timers, webhooks, or parallel joins beyond
   punchlist semantics is out of scope v1.
4. *Two sources of visual truth* — mitigate: mermaid is GENERATED from
   step definitions; hand-edited diagrams are forbidden.

## Success criteria (v1)

1. One real template pack (e.g. weekly-review, research-brief,
   purchase-decision) used by both claude and hermes from CLI.
2. One real workflow (multi-step, one branch, one human-review step)
   compiled into punchlist tasks and driven to completion by hermes with
   one human approval and one needs-input round-trip.
3. A human edits a template in Obsidian, and the next agent run uses the
   edit with no other action.
4. Mermaid renders for every workflow with zero hand-drawn diagrams.
