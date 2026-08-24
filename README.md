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

## Quickstart

```bash
git clone https://github.com/aronvaughan/punchlist && cd punchlist
./install.sh                    # npm ci, mints per-actor tokens, starts the service
# open http://127.0.0.1:8600    # the web app (paste your token once)
./bin/punchlist install-skills  # copy the agent skills into ~/.claude and $HERMES_HOME
```

`./install.sh --actors "you,claude,hermes"` controls which actors get tokens —
the **first** actor is the admin: the human who approves reviews and owns the
Today/Inbox lanes (`AV_TASKS_ADMIN`). Tokens live in `data/.env` (chmod 600,
never in git); re-running install keeps them.

Other commands: `./bin/punchlist serve` (foreground server),
`./bin/punchlist snapshot` (WAL-safe backup to `data/backup/`).
`npm test` runs the suite with an 80% coverage floor.

## Screenshots

*(coming soon — Today view, the review lane, and the Agents board)*

## Security posture

- **Loopback by default.** The server binds `127.0.0.1:8600`
  (`AV_TASKS_HOST`/`AV_TASKS_PORT` override). There is no TLS and no rate
  limiting — it is designed to sit behind loopback or a private network.
- **Expose over a tailnet/VPN, never publicly.** Tailscale
  (`tailscale serve --tcp 8600`), WireGuard, or an SSH tunnel are the intended
  remote paths. Do **not** put it on the open internet (no public funnel /
  port-forward / reverse proxy without auth in front).
- **Fail-closed tokens.** Startup refuses without well-formed
  `AV_TASKS_TOKENS` (min 32 chars per token); every API request needs a
  bearer token; the server warns if `data/.env` is group/other-readable.
- The API is the only write path; view SQL is parameter-bound only, and the
  UI is served with a strict CSP.

## Docs

Design records live in [`docs/`](docs/) — product analysis, PRD,
architecture, module design (the API contract), and the delegation design.

## License

[MIT](LICENSE) © 2026 Aron Vaughan.
