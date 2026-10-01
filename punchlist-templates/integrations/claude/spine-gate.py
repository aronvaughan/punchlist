#!/usr/bin/env python3
"""PreToolUse gate: block commit/push/PR/merge commands until every guarded pattern the
command matches has its mapped step's human gates (kind `gate`) satisfied at the current
pin, with no pin/requirements errors. Fails closed (denies) when
the run has a state.yaml but plt itself is unavailable/erroring/non-JSON; fails open (no
run file yet) when the run hasn't been created."""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(__file__)); from spine_common import read_input, plt, current_run, branch_run, run_repo_dir, emit, strip_heredocs, project_dir, project_path, target_dir, hook_cwd, resolve_target_token  # noqa: E402

GUARDED = [
    ("git commit",   r"\bgit(\s+-[cC]\s*\S+)*\s+commit(?![\w-])"),  # not commit-tree / commit-graph (plumbing, no hooks)
    ("git push",     r"\bgit(\s+-[cC]\s*\S+)*\s+push\b"),
    ("gh pr create", r"\bgh\s+pr\s+create\b"),
    ("gh pr comment", r"\bgh\s+pr\s+comment\b"),
    ("gh api",       r"\bgh\s+api\b.*(comments|pulls|graphql)"),
    ("gh pr merge",  r"\bgh\s+pr\s+merge\b"),
]
FALLBACK_STEPS = {
    "git commit": "approve", "git push": "approve", "gh pr create": "open-pr",
    "gh pr comment": "pr-loop", "gh api": "pr-loop", "gh pr merge": "merge",
}

# "Own repo push is never gated": a single command segment counts as the exempt push only if
# it IS `git -C <path> push origin main`, start to end — not "contains" it (so a trailing
# comment or a chained second command can't ride along on the exemption) — AND <path>
# resolves to the project root (the directory that holds process/config). The exemption is
# derived from the path, never from a repo name.
EXEMPT_SEG_RE = r"^\s*git\s+-C\s+(\S+)\s+push\s+origin\s+main\s*$"
SPLIT_OPS_RE = re.compile(r"&&|\|\||;|\|")

def exempt_segment(seg, base):
    root = project_dir()
    m = re.match(EXEMPT_SEG_RE, seg)
    if not m or root is None:   # no project root → no exemption is ever claimed
        return False
    p = m.group(1).strip("'\"")
    p = p if os.path.isabs(p) else os.path.join(base, p)
    return os.path.realpath(p) == os.path.realpath(root)

def deny(reason):
    emit({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}})
    sys.exit(0)

d = read_input()
if d.get("tool_name") != "Bash": sys.exit(0)
cmd = strip_heredocs(d.get("tool_input", {}).get("command", "") or "")

segments = SPLIT_OPS_RE.split(cmd)
nonblank_segments = [s for s in segments if s.strip()]
base = hook_cwd(d)

# The own-repo exemption applies only when the WHOLE command is nothing but that one
# push — every non-blank segment must be an exempt segment — AND the command's resolved
# target really is the project root (defense in depth against a forged path string).
root = project_dir()
whole_command_exempt = bool(nonblank_segments) and all(exempt_segment(s, base) for s in nonblank_segments)
if whole_command_exempt and target_dir(d) == os.path.realpath(root):
    sys.exit(0)

# Match against the command with quoted strings blanked: a `--next "… git commit …"` handoff note
# or a commit message that mentions `gh pr create` is prose, not a guarded command.
cmd_for_match = re.sub(r'"[^"]*"|\'[^\']*\'', '""', cmd)
hits = [k for k, rx in GUARDED if re.search(rx, cmd_for_match)]
if not hits: sys.exit(0)
if root is None: sys.exit(0)  # no process/config anywhere above cwd → nothing to gate against

# Run resolution: if the command isn't wholly the own-repo exemption (chained commands,
# or a lone non-exempt push), resolve the target directory from the first NON-exempt
# segment's own `-C`/`cd` (so `git -C <project> push origin main && git -C /x push`
# gates against /x, not the project root it opens with) — falling back to the
# whole-command heuristic when no segment carries its own `-C`/`cd`.
tdir = None
for seg in nonblank_segments:
    if exempt_segment(seg, base):
        continue
    p = resolve_target_token(seg, require_trailing_cd_op=False)
    if p:
        p = p if os.path.isabs(p) else os.path.join(base, p)
        tdir = os.path.realpath(p)
        break
if tdir is None:
    tdir = target_dir(d)

# A command that targets the project root itself (docs, boards, process state) is never gated by
# the product run this session happens to drive — resolve from the target branch only there.
if tdir == os.path.realpath(root):
    run = current_run(cwd=tdir)
else:
    run = current_run(cwd=tdir, session_id=d.get("session_id") or os.environ.get("CLAUDE_SESSION_ID"))
if not run: sys.exit(0)  # no run → the old prose gate still nudges

# A run remembered from PLT_RUN or the session cache gates only its OWN repo: a command in some other
# checkout (the templates repo, a second product worktree) is not that run's business. Only a run
# named by the target's own branch is trusted without this check.
if branch_run(tdir) != run:
    repo_dir = run_repo_dir(run)
    if repo_dir and not (tdir == repo_dir or tdir.startswith(repo_dir + os.sep)):
        sys.exit(0)

state_path = project_path("process", "runs", run, "state.yaml")
run_exists = os.path.isfile(state_path)

# Which formula step each guarded command belongs to: config.gates.commands, read through plt
# (the merged process/config/*.yaml). A readable config with no `gates.commands` key uses the
# FALLBACK_STEPS map. An UNREADABLE config (plt failing, an older plt without `config`, non-JSON
# output) fails closed when the run exists — the fallback maps commands to different steps than
# a project's config may, and gating the wrong human gate is worse than a denied command.
code, raw = plt("config", "gates.commands", cwd=tdir)
cmds_cfg = None
if code == 0:
    try:
        cmds_cfg = json.loads(raw)
    except Exception:
        cmds_cfg = None
elif code == 1 and "no value at" in raw:
    cmds_cfg = {}
if not isinstance(cmds_cfg, dict):
    if run_exists:
        last_line = raw.strip().splitlines()[-1] if raw.strip() else "no output"
        deny(f"spine gate: {run} — config unavailable — {last_line}")
    cmds_cfg = {}  # no state.yaml yet → silent allow, unchanged ruling

steps = []
for hit in hits:
    step = cmds_cfg.get(hit) or FALLBACK_STEPS[hit]
    if step not in steps:
        steps.append(step)

failures = []  # (step, missing[])
for step in steps:
    code, out = plt("gate", "check", run, step, cwd=tdir)
    if code == 0:
        continue
    try:
        result = json.loads(out)
    except Exception:
        if run_exists:
            last_line = out.strip().splitlines()[-1] if out.strip() else "no output"
            deny(f"spine gate: {run} step `{step}` — gate unavailable — {last_line}")
        continue  # no state.yaml yet → silent allow, unchanged ruling
    if result.get("ok", True):
        continue
    # A command guard enforces only the human gates (kind `gate`) plus pin/requirements errors.
    # Every other receipt (gh, jira, skill, agent) is an outcome the step produces — often of the
    # guarded command itself (open-pr needs checks-green, which needs the PR) — and is enforced
    # by `plt step finish`, not here.
    missing = [m for m in result.get("missing", []) if m.get("kind") in ("gate", "pin", "requirements")]
    if not missing:
        continue
    failures.append((step, missing))

if not failures: sys.exit(0)

parts = [
    f"`{step}`: " + "; ".join(f"{m['kind']} {m['name']} ({m.get('reason', '')})" for m in missing)
    for step, missing in failures
]
reason = f"spine gate: {run} is not satisfied for `{'`, `'.join(hits)}`. " + " | ".join(parts) + ". Next: `plt prime`."
emit({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}})
