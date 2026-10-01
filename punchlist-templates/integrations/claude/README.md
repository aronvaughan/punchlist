# Claude Code integration for the process spine

`plt integration install claude --project <dir>` installs the spine's Claude Code hooks and
framework agents into a project. `plt integration status claude --project <dir>` reports
their state so a stale or hand-edited hook is reported, not discovered.

## What gets installed

| Shipped here | Installed at | Role |
| --- | --- | --- |
| `spine_common.py` | `<project>/.claude/hooks/` | shared helpers; `VERSION = 1` is the single version source |
| `spine-prime.py` | `<project>/.claude/hooks/` | SessionStart: render the run's prime; UserPromptSubmit: banners, menu phrases, re-prompt tags |
| `spine-gate.py` | `<project>/.claude/hooks/` | PreToolUse (Bash): deny commit/push/PR/merge until the step's human gates pass |
| `spine-guard.py` | `<project>/.claude/hooks/` | PreToolUse (Write/Edit): reject hand edits under `process/runs/**` |
| `spine-receipt.py` | `<project>/.claude/hooks/` | PostToolUse: record skills, agents, gh calls and artifacts as receipts |
| `spine-stop.py` | `<project>/.claude/hooks/` | Stop/PreCompact: record the turn, warn on a stale HANDOFF.md or index |
| `agents/writing-adversary.md` | `<project>/.claude/agents/` | adversarial prose review; ends with a single `verdict:` line |
| `hooks.json` | merged into `settings.json` / `settings.local.json` | hook wiring, `ask` and `allow` rules |

Every installed file carries a managed header — hooks on the line after the shebang,
agents as an HTML comment after the frontmatter:

```
# installed by plt integration claude v1 — reinstalling overwrites
```

Do not hand-edit an installed file: the next install overwrites it. Change the shipped copy
here, bump `VERSION` in `spine_common.py`, and re-install.

A version bump only ships once `plt integration install claude --project <dir>` is re-run against
it — `plt integration status claude --project <dir>` reports `stale (installed vN, shipped vM)`
for every project still on the old header until then (see the table below).

## Client-free rule

The shipped scripts carry no project literals. Every project-specific value is read through
`plt config <key>` from the merged `process/config/*.yaml`:

- `gates.commands` — which formula step a guarded command (`git commit`, `gh pr merge`, …) belongs to.
- `denylist_file` — the private word list the writing adversary checks public-bound text against.
- `writing.style_skills` — the style guides the writing adversary reads first (paths relative to
  the project root, or `~`-prefixed).
- `actors.humans`, `jira.script`, … — read by plt itself.

The project root is `CLAUDE_PROJECT_DIR` inside a hook, else the nearest directory at or above
the cwd that holds `process/config`; with neither, the hooks claim no exemption and record
nothing. "A push to the project's own repo is never gated" means: a command that is exactly
`git -C <path> push origin main` whose `<path>` resolves to the project root — never a repo name.

The gate fails closed: when a run has a `state.yaml` and `plt config gates.commands` cannot be
read (plt failing, an older plt without `config`, non-JSON output), the command is denied with
`spine gate: <run> — config unavailable — <plt's last line>`. A readable config without a
`gates.commands` key uses the built-in step map; a run with no `state.yaml` yet is not gated.

## Permission model

`hooks.json` merges into `<project>/.claude/settings.local.json` under `permissions`:

- `ask` — `plt gate approve` (and its `node … gate approve` form). A human gate is passed by a
  human; the approval prompt is that gate. Never move these to `allow`.
- `allow` — the spine's own read/record commands (`plt run|step|receipt|gate check|prime|handoff|
  pin|recompile|effort|menu|banners|facts|render|config`, plus the `node …` forms) so the hooks and
  the agent run without a prompt.

Project-specific agents (reviewers named in `config.review.*`) stay in the project repo; only
the framework agent ships here.

## Installing and re-installing

```
plt integration install claude --project /path/to/project
```

- copies the hooks to `.claude/hooks/` and the agent to `.claude/agents/`, with the header;
- merges the hook groups into `.claude/settings.json` — appends to existing event arrays, joins an
  existing matcher group, dedupes by command string, never removes a hook that is not the spine's;
- merges `ask`/`allow` into `.claude/settings.local.json` `permissions` (creates the file when absent);
- is idempotent: a second run changes nothing and `git diff` stays empty.

## How status reports

```
plt integration status claude --project /path/to/project
```

One line per managed file, then one for settings and one for permissions:

| Line | Meaning |
| --- | --- |
| `installed v1` | header version matches, body identical to the shipped copy |
| `stale (installed v0, shipped v1)` | header carries an older version — re-install |
| `modified (v1; content differs from shipped)` | same version, body hand-edited (line endings and a final newline are ignored) — re-install (or move the change here) |
| `unmanaged` | file exists without a managed header |
| `missing` | file absent |
| `settings: ok` / `settings: missing <event, …>` | every shipped hook command is wired for the event |
| `permissions: ok` / `permissions: missing …` | every shipped `ask`/`allow` rule is present |
| `permissions: violation — Bash(plt gate approve *) present in allow` | an `ask` rule also sits in `allow`; the human gate would pass without a prompt |

Exit code 0 only when every file is `installed`, settings are `ok` and permissions are `ok`;
otherwise 1. Wire the status command into a doctor or a scheduled check so drift is reported.
