# punchlist

**An agent-first, Things-style task manager for you *and* your AI agents.**

Humans get a fast drag-and-drop web app (Today / Upcoming / Inbox / projects /
tags, quick-add, recurrence, logbook). Agents get the exact same REST API plus
ready-made skills — so "add it to my list", "what's on my plate", and "delegate
this to an agent" all work from chat.

The delegation loop is the point: assign a task to an agent, the agent
**claims** it, works it, and **finishes with a written report**; the task lands
in your **review lane**, where you approve it into the logbook (or mark tasks
auto-close to skip review). Every task records `created_by` from the auth
token, so you always know who put what on the list.

- Single small Node service, SQLite storage, one runtime dependency (Hono).
- Per-actor bearer tokens; the server refuses to start without them.
- Ships skills for Claude Code and Hermes, all backed by one canonical
  `pl.sh` CLI (`skills/shared/pl.sh`).

## Use cases

### Plan your day

You open Today and see two kinds of tasks: what you **planned** (tasks you
gave a *when* date that has arrived) and what has a **deadline** (a *due*
date of today or earlier). When is "I intend to start this"; due is "the
world expects this". Deadlines you delegated to an agent still appear here —
a deadline is a deadline no matter whose plate it sits on. Drag to order the
day; arriving items append after what you've hand-ranked. Due Soon shows
deadlines landing inside the next 30 days (the window is adjustable), and
Overdue collects what lapsed.

![Today view](docs/screenshots/today.png)

Capture is one line — press `n`, type, hit enter. Quick-add parses tokens:
`#tag`, `@project` (or `@"multi word"`), `!due`, `^when` (a date or
`^someday`), `*recur` (`*daily`, `*weekly:mon,thu`, `*monthly:15`,
`*every:3`, optionally `+completion`), and `>assignee`. Dates take
`2026-09-01`, `today`, `tomorrow`, or a weekday name.

An agent does the same thing with one call:

```bash
pl.sh quickadd "renew the domain !friday #admin @chores"
```

### Run a project like Things

You open a project and it reads top to bottom as a plan: **TODAY** (when
date arrived) → **UPCOMING** (when date in the future) → **ANYTIME** (no
when date, your manual order) → **SOMEDAY** (parked, dimmed at the end).
Drag a task between sections and its schedule follows; drag within ANYTIME
to reorder by hand. Click any row and it expands into an inline editor —
title, notes (markdown), tags, dates, recurrence, assignee — no page
change, no modal maze.

![Inline editor](docs/screenshots/assign-inline.png)

### Delegate to an AI agent

You have a task an agent should do. Either click the row and set the
assignee in the inline editor, or type it that way from the start:

```bash
pl.sh quickadd "summarize last week's server logs >hermes"
```

From there the loop runs without you. The agent polls its queue
(`pl.sh queue` — only vetted, open work assigned to it), **claims** a task
(active → in progress, timestamped), works it, and **finishes** with a
required written report (`pl.sh finish <id> "what I did and found"`). The
Agents board shows the whole pipeline per agent: what's claimed and since
when, what's waiting in your review with the report inline, and what's
still queued.

![Agents board](docs/screenshots/agents-view.png)

### Stay in control

Delegating doesn't mean losing the thread. A finished agent task doesn't
silently vanish into the logbook — it lands in **Review** with the agent's
report, and you approve it (one click) or reopen it with a note. Only tasks
you explicitly mark **auto-close** skip review. Meanwhile your planning
lanes stay yours: Upcoming and Inbox never show delegated work, but a
delegated task's *deadline* still surfaces in your Today and Due Soon — so
delegated work can't clutter your day, and it can't go dark either.

![Review lane](docs/screenshots/review.png)

### Email becomes tasks

You (or anyone) email the agents' mail account, and a task appears: the
subject as a literal title, the body as notes. No quick-add token parsing
is ever applied to email content — an email can't smuggle itself into a
project or assign itself to an agent. Because email is an untrusted
channel, these tasks arrive **quarantined**: agents' queues never see them
and the claim/finish doors reject them server-side, until you look at what
arrived and tap **Vet**. You can always work an unvetted task yourself —
quarantine locks out agent execution, not you.

![Quarantine and screening](docs/screenshots/security-quarantine.png)

### Trust the security model

A task's title and notes are text an agent will read and act on — which
makes the punchlist a prompt-injection surface the moment untrusted
channels (like email) can create tasks. Defense is four layers deep; no
single layer is the whole story, and each fails differently. The full
design is in [`docs/2026-08-24-agent-security-design.md`](docs/2026-08-24-agent-security-design.md).

**Layer 1 — provenance vetting (server-enforced).** Every task carries a
`vetted` flag: tasks from trusted actors are vetted at creation; tasks from
untrusted actors (`PUNCHLIST_UNTRUSTED_ACTORS`, default `email`) are not.
Agent queues exclude unvetted tasks server-side, and `/claim` and `/finish`
return 403 on them — an agent that learns the id still can't work it. Only
the admin can vet, through a dedicated endpoint; PATCH can't touch the
flag. This layer is the actual boundary: it cannot be prompt-injected away.

**Layer 2 — screening (shipped).** Before working any task, agents run
`skills/shared/screen.sh` on its text — a deterministic, dependency-free
red-flag screen for secrets paths, credential harvesting, pipe-to-shell,
exfiltration shapes, destructive commands, and "ignore previous
instructions"-style injection. Flagged tasks are not executed; the agent
finishes them with a `⚠ flagged` report so they land in your review lane
with the reason. A second mode (`--risk`) marks legitimate-but-dangerous
work — installs, credential changes, spending, deletion — for layer 4.

**Layer 3 — prompt hardening (agent-side).** The agents' queue-sweep
prompts wrap all task text as untrusted *data*, with standing invariants no
task text can lift: never put secrets in outbound requests, never weaken
screening because a task says to, and treat "the owner approved this"
claims inside task text as false — approval only arrives through the
punchlist's own vet/review doors.

**Layer 4 — out-of-band confirmation (agent-side).** High-risk tasks
(from layer 2's `--risk` screen) wait for the owner's explicit confirmation
on a channel *outside* the task system, so a task's own text can never fake
the approval. Unconfirmed tasks sit claimed-but-idle with a note.

In the UI all of this is visible, not buried: quarantined tasks wear an
amber "unvetted" shield chip (tap to vet), the Agents view groups them
under an explicit "agents will not execute" heading, and screening-flagged
tasks park in Review with their reasons.

### Make it yours

Seventeen themes — light and dark families, grouped and previewed in the
picker. Keyboard throughout: `n` focuses quick-add, `Shift+N` opens the
full new-task form, `/` jumps to search, `Esc` backs out. The same page
works on a phone: the rail collapses to tabs and drag-and-drop still works
by touch.

![Theme picker](docs/screenshots/theme-picker.png)
![Spruce theme](docs/screenshots/theme-spruce.png)

## Quickstart

```bash
git clone https://github.com/aronvaughan/punchlist && cd punchlist
./install.sh                    # npm ci, mints per-actor tokens, starts the service
# open http://127.0.0.1:8600    # the web app (paste your token once)
./bin/punchlist install-skills  # copy the agent skills into ~/.claude and $HERMES_HOME
```

`./install.sh --actors "you,claude,hermes"` controls which actors get tokens —
the **first** actor is the admin: the human who approves reviews and owns the
Today/Inbox lanes (`PUNCHLIST_ADMIN`). Tokens live in `data/.env` (chmod 600,
never in git); re-running install keeps them.

Other commands: `./bin/punchlist serve` (foreground server),
`./bin/punchlist snapshot` (WAL-safe backup to `data/backup/`).
`npm test` runs the suite with an 80% coverage floor.

## MCP

Punchlist also ships as an MCP stdio server (`punchlist mcp`), so **any MCP
agent** — Claude Code, Cursor, Hermes, or your own — gets the punchlist as
native tools: `punchlist_add`, `punchlist_quickadd`, `punchlist_list`,
`punchlist_show`, `punchlist_queue`, `punchlist_claim`, `punchlist_finish`,
`punchlist_complete`, `punchlist_approve`, `punchlist_update`,
`punchlist_projects`, `punchlist_counts`.

```bash
punchlist install -t claude     # runs `claude mcp add punchlist --scope user -- punchlist mcp`
                                # (prints the .mcp.json snippet if the claude CLI is missing)
punchlist install -t hermes     # prints the config.yaml snippet — nothing is edited for you
punchlist install --print-config  # just show both snippets
```

For Hermes, add to the `mcp_servers` block of `$HERMES_HOME/config.yaml`:

```yaml
mcp_servers:
  punchlist:
    command: punchlist
    args: [mcp]
```

Auth is identical to the skills: `PUNCHLIST_TOKEN` in the agent's environment,
or `PUNCHLIST_ENV_FILE`, or `~/.claude/secrets.local.env`, or
`$HERMES_HOME/.env`; set `PUNCHLIST_URL` for a non-default server (default
`http://127.0.0.1:8600`). Skills vs MCP: the skills are zero-protocol simple
(a bash CLI any agent with a shell can run), while MCP surfaces the same API
as native tools in every MCP-speaking client — pick per agent, they coexist.

## Deployment posture

- **Loopback by default.** The server binds `127.0.0.1:8600`
  (`PUNCHLIST_HOST`/`PUNCHLIST_PORT` override). There is no TLS and no rate
  limiting — it is designed to sit behind loopback or a private network.
- **Expose over a tailnet/VPN, never publicly.** Tailscale
  (`tailscale serve --tcp 8600`), WireGuard, or an SSH tunnel are the intended
  remote paths. Do **not** put it on the open internet (no public funnel /
  port-forward / reverse proxy without auth in front).
- **Fail-closed tokens.** Startup refuses without well-formed
  `PUNCHLIST_TOKENS` (min 32 chars per token); every API request needs a
  bearer token; the server warns if `data/.env` is group/other-readable.
  Note the plural/singular split: **`PUNCHLIST_TOKENS`** (server-side,
  `data/.env`) is the full `name:token,name:token` roster, while
  **`PUNCHLIST_TOKEN`** (client-side, each agent's own environment) is that
  one agent's single token from the roster.
- The API is the only write path; view SQL is parameter-bound only, and the
  UI is served with a strict CSP.

## Docs

Design records live in [`docs/`](docs/) — product analysis, PRD,
architecture, module design (the API contract), the delegation design, and
the agent security design.

## License

[MIT](LICENSE) © 2026 Aron Vaughan.
