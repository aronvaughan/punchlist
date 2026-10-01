#!/usr/bin/env python3
"""Stop/PreCompact: record the turn as time, and warn when HANDOFF.md is older than the last event."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(__file__)); from spine_common import read_input, plt, current_run, emit, project_path, hook_cwd  # noqa: E402
d = read_input(); run = current_run(cwd=hook_cwd(d), session_id=d.get("session_id") or os.environ.get("CLAUDE_SESSION_ID"))
if not run: sys.exit(0)
plt("receipt", "--run", run, "--kind", "time", "--name", d.get("hook_event_name", "stop").lower(), "--actor", "agent", cwd=hook_cwd(d), timeout=8)
# A hook may print ONE JSON object. Every message below is collected and emitted once at the end —
# two emits in one run concatenate into text the harness rejects as invalid JSON.
messages = []
code, banners = plt("banners", "--run", run, cwd=hook_cwd(d), timeout=8)
if code == 0 and banners.strip(): messages.append(banners.strip())
# Every stop ends with the prompt menu — "what do I say now?" — so the next prompt has it in view.
code, menu = plt("prime", "--run", run, "--menu-only", cwd=hook_cwd(d), timeout=8)
if code == 0 and menu.strip(): messages.append(menu.strip())
rd = project_path("process", "runs", run)
if rd is None: sys.exit(0)  # no project root → nothing to compare against
try:
    h = os.path.getmtime(os.path.join(rd, "HANDOFF.md")); e = os.path.getmtime(os.path.join(rd, "events.jsonl"))
    if e - h > 600: messages.append(f"HANDOFF.md for {run} is {int((e-h)/60)} min older than the last event — run `plt handoff {run} --goal … --next …`.")
except FileNotFoundError:
    messages.append(f"{run} has no HANDOFF.md yet — write one before you stop: `plt handoff {run} --goal … --next …`.")

# The published effort index must show this run's current state before the window stops. The
# receipt hook stamps process/.index-published on every effort-index publish; compare it with
# THIS run's newest event (a sibling window's run is that window's responsibility).
try:
    e = os.path.getmtime(os.path.join(rd, "events.jsonl"))
    def age_of(stamp):
        published = os.path.getmtime(stamp) if os.path.exists(stamp) else 0
        if e - published <= 300: return None
        return "never published" if not published else f"{int((e - published) / 60)} min behind {run}'s last event"
    stale = []
    a = age_of(project_path("process", ".pages", run))
    if a: stale.append(f"run page ({a}): `plt render run {run}` → publish process/build/run-{run}.html at the url in process/build/publish.json (runs.{run}.url; a new page otherwise), then `plt render --published {run} <url>`")
    a = age_of(project_path("process", ".index-published"))
    if a: stale.append(f"effort index ({a}): `plt render index` → republish process/build/index.html to config.links.effort_index, then `plt render --published index <url> --run {run}`")
    if stale:
        messages.append("Before you stop, republish what the owner opens (publish.json lists the pages whose content changed) — " + " · ".join(stale))
except Exception:
    pass

if messages:
    emit({"systemMessage": "\n".join(messages)})
