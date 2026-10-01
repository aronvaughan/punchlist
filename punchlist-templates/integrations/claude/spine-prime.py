#!/usr/bin/env python3
"""SessionStart: render prime for the run named by the current branch. UserPromptSubmit: tag re-prompt families and menu phrases."""
import glob, io, json, os, re, sys
sys.path.insert(0, os.path.dirname(__file__)); from spine_common import read_input, plt, current_run, emit, hook_cwd  # noqa: E402
d = read_input(); ev = d.get("hook_event_name", "")
run = current_run(cwd=hook_cwd(d), session_id=d.get("session_id") or os.environ.get("CLAUDE_SESSION_ID"))
if ev == "SessionStart":
    # `plt sync` first — "since your last session: …" — above the run's own prime, so the
    # human sees what moved across every run before diving into the one they're on. Best-effort:
    # a run to prime is not required for the sync line, and a sync failure must not lose the
    # prime. One emit at the end (the hook's single-emit discipline). Timeout matches `prime`'s
    # (8s, not 15s) — plt() already swallows a hang/crash and returns (99, ...), so a longer
    # timeout here only added SessionStart latency, never safety.
    parts = []
    scode, sout = plt("sync", cwd=hook_cwd(d), timeout=8)
    if scode == 0 and sout.strip():
        summary = sout.strip().splitlines()[-1]
        parts.append(f"since your last session: {summary}")
    if run:
        code, out = plt("prime", "--run", run, cwd=hook_cwd(d), timeout=8)
        if code == 0 and out.strip():
            parts.append(out)
    if parts:
        emit({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "\n\n".join(parts)}})
elif ev == "UserPromptSubmit" and run:
    p = d.get("prompt", "") or ""
    # A hook may print ONE JSON object. Collect every piece (banners, the matched menu phrase,
    # …) and emit once at the end — two emits in one run concatenate into text the harness
    # rejects as invalid JSON.
    system_parts, context_parts = [], []

    # Standing owner banners (ask for reviews, …): shown to the user on every prompt, and handed to
    # the agent as context, until the owner passes the step's gate.
    code, banners = plt("banners", "--run", run, cwd=hook_cwd(d), timeout=8)
    if code == 0 and banners.strip():
        system_parts.append(banners.strip())
        context_parts.append("Standing owner action still open on " + run + " — remind the user, and pass its gate in their name when they say it is done:\n" + banners.strip())

    # Prompt-menu phrase tagging: an exact (or `word: payload`) match records `menu:<id>` AND
    # surfaces `Menu phrase <id> → <command>` to the agent, so a matched phrase actually reaches
    # it rather than being logged and dropped. A prompt whose first word matches a menu word's
    # first word but the whole line doesn't parse records `menu:near-miss` only — never inferred
    # as the gate action itself, just a signal the wording is close. Both record as a `reprompt`
    # receipt, same as the FAMILIES tags below. `--run` is explicit throughout: when the run comes
    # from the session map rather than the branch, an unscoped call would silently fall back to
    # the default word overlay.
    code, raw = plt("menu", "parse", "--run", run, "--text", p, cwd=hook_cwd(d), timeout=8)
    parsed = None
    if code == 0:
        try: parsed = json.loads(raw)
        except Exception: parsed = None
    if parsed and parsed.get("id"):
        mid = parsed["id"]
        plt("receipt", "--run", run, "--kind", "reprompt", "--name", "menu:" + mid, "--actor", "human", cwd=hook_cwd(d), timeout=8)
        jcode, jraw = plt("menu", "json", "--run", run, cwd=hook_cwd(d), timeout=8)
        command = None
        if jcode == 0:
            try:
                menu = json.loads(jraw)
                command = next((ph.get("command") for ph in menu.get("phrases", []) if ph.get("id") == mid), None)
            except Exception:
                command = None
        context_parts.append(f"Menu phrase {mid} → {command}" if command else f"Menu phrase {mid}")
    else:
        wcode, wraw = plt("menu", "words", "--run", run, cwd=hook_cwd(d), timeout=8)
        try: words = json.loads(wraw) if wcode == 0 else {}
        except Exception: words = {}
        first_words = {w.strip().split()[0].lower() for w in words.values() if w.strip()}
        first = (p.strip().split() or [""])[0].lower()
        if first and first in first_words:
            plt("receipt", "--run", run, "--kind", "reprompt", "--name", "menu:near-miss", "--actor", "human", cwd=hook_cwd(d), timeout=8)
    # Word-bounded so e.g. "--verbose" (a CLI flag, not a style complaint) and "status.md"
    # (a filename, not the status-board family) don't false-tag a re-prompt.
    FAMILIES = {
        "links": r"\blink\b",
        "style": r"writing style|too (many )?words|gibberish|(?<!--)\bverbose\b",
        "skill": r"use (the|our) skill|\bpre-?pr\b",
        "jira": r"\bjira\b|\bsprint\b|\bassign\b",
        "status": r"\bstatus\b(?!\.md)|where are we|what'?s next",
    }
    tags = [k for k, rx in FAMILIES.items() if re.search(rx, p, re.I)]
    for t in tags: plt("receipt", "--run", run, "--kind", "reprompt", "--name", t, "--actor", "human", cwd=hook_cwd(d), timeout=8)

    # Fan-out reminder: when the prompt asks for the plan to be worked, `plt fan` says which tasks
    # may run AT ONCE, and that line reaches the agent unprompted — the wave is computed, never
    # remembered. Silent by design: no ledger, a first line that does not match, a non-zero
    # `plt fan`, unparsable JSON, or an empty wave all append nothing. A guessed wave is worse
    # than no wave.
    if re.search(r"\b(execute|implement|build|run the plan|continue|next task|fan out)\b", p, re.I):
        ledgers = sorted(glob.glob(os.path.join(hook_cwd(d), ".superpowers", "sdd", "*", "progress.md")),
                         key=lambda f: os.path.getmtime(f), reverse=True)
        plan = None
        if ledgers:
            try:
                with io.open(ledgers[0], encoding="utf-8") as fh:
                    m = re.match(r"^# SDD ledger — plan: (\S+)", fh.readline().strip())
                plan = m.group(1) if m else None
            except Exception:
                plan = None
        if plan:
            fcode, fraw = plt("fan", plan, "--json", cwd=hook_cwd(d), timeout=8)
            wave = None
            if fcode == 0:
                try: wave = json.loads(fraw).get("wave") or []
                except Exception: wave = None
            if wave:
                names = " ".join("T%d" % t["n"] for t in wave)
                context_parts.append(
                    "FAN-OUT: plt fan %s says the wave is %s — dispatch the whole wave, one agent per task, not the first task alone." % (plan, names))

    if system_parts or context_parts:
        obj = {}
        if system_parts: obj["systemMessage"] = "\n\n".join(system_parts)
        if context_parts: obj["hookSpecificOutput"] = {"hookEventName": "UserPromptSubmit", "additionalContext": "\n\n".join(context_parts)}
        emit(obj)
