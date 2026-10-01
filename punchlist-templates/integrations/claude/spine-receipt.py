#!/usr/bin/env python3
"""PostToolUse: turn a tool call into a receipt for the current run/step. Silent when no run is active."""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(__file__)); from spine_common import read_input, plt, current_run, emit, hook_cwd, remember_session_run, session_of, project_path  # noqa: E402

def _extract_text(resp):
    """Pull the agent's actual message text out of a (possibly nested) tool_response.
    `str(resp)` on a dict/list JSON-escapes real newlines into literal `\\n`, which breaks
    every `^...$`-anchored, MULTILINE regex downstream (the verdict line included) — so
    walk the structure and collect every string found under a key named `text` or
    `content` (recursing into `content` when it's a list of blocks, using it directly when
    it's already a string), joined by real newlines. Falls back to a newline-decoded
    `json.dumps` of the whole structure when nothing named text/content turns up."""
    if isinstance(resp, str):
        return resp
    found = []
    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k in ("text", "content"):
                    if isinstance(v, str):
                        found.append(v)
                    else:
                        walk(v)
                else:
                    walk(v)
        elif isinstance(o, list):
            for item in o:
                walk(item)
    walk(resp)
    if found:
        return "\n".join(found)
    try:
        return json.dumps(resp).replace("\\n", "\n")
    except Exception:
        return str(resp)

d = read_input(); tool = d.get("tool_name", ""); inp = d.get("tool_input", {}) or {}; resp = d.get("tool_response", {}) or {}
session_id = session_of(d)
if tool == "Bash":
    # `plt step start <id> --run <RUN>` / `plt run launch ... --run <RUN>` binds this session to that run.
    m = re.search(r"\bplt\s+(?:step\s+start\s+\S+|run\s+launch\b[^;&|]*?)\s+--run\s+([A-Z][A-Z0-9]+-\d+)", inp.get("command", "") or "")
    if m: remember_session_run(session_id, m.group(1))
if tool == "Artifact" and inp.get("action") in (None, "publish"):
    # Stamp page publishes for every window, run or not: the stop hook compares these with the
    # newest run event to decide whether the published index / run page still reflect the run.
    # effort-index.html → process/.index-published; run-<RUN>.html → process/.pages/<RUN>.
    base = os.path.basename(str(inp.get("file_path", "")))
    m = re.search(r"https://claude\.ai/(?:code/)?artifact/[A-Za-z0-9-]+", str(resp))
    stamp = None
    if base.startswith("effort-index."):
        stamp = project_path("process", ".index-published")
    else:
        rm = re.match(r"run-([A-Z][A-Z0-9]+-\d+)\.", base)
        if rm: stamp = project_path("process", ".pages", rm.group(1))
    if stamp:
        try:
            os.makedirs(os.path.dirname(stamp), exist_ok=True)
            with open(stamp, "w") as f:
                f.write((m.group(0) if m else "") + "\n")
        except Exception:
            pass
run = current_run(cwd=hook_cwd(d), session_id=session_id)
if not run: sys.exit(0)
kind = name = verdict = ref = None
if tool == "Skill": kind, name = "skill", inp.get("skill")
elif tool == "Agent":
    kind, name = "agent", inp.get("subagent_type") or "general-purpose"
    text = _extract_text(resp)
    # Anchored to a line consisting only of `verdict: pass|fail` — a stray "verdict: pass"
    # embedded mid-sentence in agent chatter (or planted by an adversarial prompt) doesn't
    # count. The LAST such line wins, so a corrected final verdict overrides an earlier one.
    matches = re.findall(r"^\s*verdict:\s*(pass|fail)\s*$", text, re.I | re.M)
    verdict = matches[-1].lower() if matches else None
elif tool == "Workflow": kind, name = "workflow", "workflow"
elif tool.startswith("mcp__gitnexus__"): kind, name = "tool", tool
elif tool == "Bash":
    m = re.search(r"\bgh\s+(pr|api)\s+(\w+)?", inp.get("command", ""))
    if m: kind, name = "gh", (m.group(1) + (":" + m.group(2) if m.group(2) else ""))
elif tool == "Artifact" and (inp.get("action") in (None, "publish")):
    kind, name = "artifact", os.path.basename(str(inp.get("file_path", ""))).split(".")[0]
    # Both URL shapes the Artifact tool has returned: /code/artifact/<uuid> and /artifact/<base58 id>.
    m = re.search(r"https://claude\.ai/(?:code/)?artifact/[A-Za-z0-9-]+", str(resp)); ref = m.group(0) if m else None
if not kind: sys.exit(0)
args = ["receipt", "--run", run, "--kind", kind, "--name", str(name)]
if verdict: args += ["--verdict", verdict]
if ref: args += ["--ref", ref]
if session_id: args += ["--session", session_id]
code, out = plt(*args, cwd=hook_cwd(d), timeout=8)
if code != 0 and "unpinnable" in out:
    emit({"systemMessage": f"receipt for {kind} {name} not recorded — {out.strip().splitlines()[-1]}"})
