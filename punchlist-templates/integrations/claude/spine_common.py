#!/usr/bin/env python3
"""Shared helpers for the spine hooks. Never raises past the caller: a hook that crashes is a silent no-op."""
import json, os, re, shlex, subprocess, sys

# Shipped version of the claude integration (hooks + agents). `plt integration install claude`
# stamps it into every installed file's managed header; `plt integration status claude` compares.
# 5: spine-prime's UserPromptSubmit branch now appends the `plt fan` wave line.
VERSION = 6

def read_input():
    try: return json.load(sys.stdin)
    except Exception: return {}

def project_dir():
    """The project root: CLAUDE_PROJECT_DIR when Claude Code sets it, else the nearest directory at
    or above cwd that holds process/config. None when neither exists — callers then claim no
    exemption and record nothing."""
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env:
        return env
    d = os.path.realpath(os.getcwd())
    while True:
        if os.path.isdir(os.path.join(d, "process", "config")):
            return d
        up = os.path.dirname(d)
        if up == d:
            return None
        d = up

def project_path(*parts):
    """os.path.join(project_dir(), *parts), or None when there is no project root."""
    root = project_dir()
    return os.path.join(root, *parts) if root else None

def _plt_argv():
    """Resolve the plt binary: PLT_BIN env override (may be a multi-word invocation
    like "node /path/to/plt"), else whatever `plt` resolves to on PATH."""
    override = os.environ.get("PLT_BIN")
    if override:
        return shlex.split(override)
    return ["plt"]

def plt(*args, cwd=None, timeout=20):
    """Run plt; return (code, stdout+stderr). Uses PLT_PROCESS_DIR so hooks work from product worktrees."""
    env = dict(os.environ)
    root = project_dir()
    if root:
        env["PLT_PROCESS_DIR"] = os.path.join(root, "process")
    try:
        r = subprocess.run([*_plt_argv(), *args], cwd=cwd or os.getcwd(), env=env, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return 99, str(e)

RUN_KEY_RE = r"[A-Z][A-Z0-9]+-\d+"

def _session_map_path(session_id):
    p = project_path("process", ".sessions", session_id)
    if p is None:
        raise FileNotFoundError("no project root")
    return p

def remember_session_run(session_id, run):
    """Record that this Claude session drives `run`, so later hooks resolve the run even when the
    session's cwd is the project root (branch main) rather than the product worktree. Written when a
    `plt step start`/`plt run launch --run` passes through the Bash tool; best-effort, never raises."""
    if not session_id or not re.fullmatch(RUN_KEY_RE, run or ""):
        return
    try:
        path = _session_map_path(session_id)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(run + "\n")
    except Exception:
        pass

def session_run(session_id):
    if not session_id:
        return None
    try:
        with open(_session_map_path(session_id)) as f:
            v = f.read().strip()
        return v if re.fullmatch(RUN_KEY_RE, v) else None
    except Exception:
        return None

def branch_run(cwd=None):
    try:
        b = subprocess.run(["git", "branch", "--show-current"], cwd=cwd or os.getcwd(), capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return None
    m = re.search(RUN_KEY_RE, b)
    return m.group(0) if m else None

def current_run(cwd=None, session_id=None):
    """Card key, in precedence order: PLT_RUN (a window seeded for one run) · the current branch of
    `cwd` (a product worktree) · the run this session last started a step on (see
    remember_session_run — covers a session whose cwd drifted back to the project root). None if all miss."""
    env = os.environ.get("PLT_RUN", "").strip()
    if re.fullmatch(RUN_KEY_RE, env):
        return env
    return branch_run(cwd) or session_run(session_id)

def run_repo_dir(run):
    """Absolute real path of the run's repo_dir from state.yaml (a relative path resolves against
    the project root), or None when the run has no state or no repo_dir."""
    try:
        for line in open(project_path("process", "runs", run, "state.yaml")):
            if line.startswith("repo_dir:"):
                v = line.split(":", 1)[1].strip().strip("'\"")
                if not v or v == "null":
                    return None
                return os.path.realpath(v if os.path.isabs(v) else os.path.join(project_dir(), v))
    except Exception:
        return None
    return None

def session_of(d):
    return d.get("session_id") or os.environ.get("CLAUDE_SESSION_ID")

def emit(obj):
    sys.stdout.write(json.dumps(obj)); sys.stdout.flush()

def strip_heredocs(cmd):
    lines, out, skip = cmd.split("\n"), [], None
    for line in lines:
        if skip is not None:
            if line.strip() == skip: skip = None
            continue
        out.append(line)
        m = re.search(r"<<[-~]?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?", line)
        if m: skip = m.group(1)
    return "\n".join(out)

def hook_cwd(d):
    """The hook's own working directory, as reported by Claude Code (falls back to os.getcwd())."""
    return d.get("cwd") or os.getcwd()

def _tokenize(cmd):
    """shlex tokenizer with `;`/`&&`/`|`/etc. split out as their own tokens (plain
    shlex.split leaves them glued to an adjacent word, e.g. `cd /x;` -> one token
    `/x;` instead of `/x` then `;`) while still honoring quotes."""
    lex = shlex.shlex(cmd, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    return list(lex)

def resolve_target_token(cmd, require_trailing_cd_op=True):
    """Return the raw path argument to `git -C <path>` or a leading `cd <path>` in `cmd`,
    or None. Tokenizes with shlex (posix mode, punctuation split out) so quoted paths and
    a path glued to a trailing `;`/`&&` resolve correctly; falls back to a plain regex scan
    on ValueError (e.g. unbalanced quotes — shell syntax the hook can't parse safely).
    `require_trailing_cd_op`: when True (the whole-command case), a leading `cd <path>`
    only counts if immediately followed by `&&` or `;` — a bare `cd` with nothing after it
    isn't "targeting" anything for the rest of the command. Callers scoped to a single
    already-split command segment (no trailing operator to find) pass False."""
    try:
        tokens = _tokenize(cmd)
    except ValueError:
        m = re.search(r"\bgit\s+-C\s+(\S+)", cmd)
        if not m:
            cd_pat = r"\s*cd\s+(\S+)\s*(?:&&|;)" if require_trailing_cd_op else r"\s*cd\s+(\S+)"
            m = re.match(cd_pat, cmd)
        return m.group(1).strip("'\"") if m else None
    for i, tok in enumerate(tokens):
        if tok == "-C" and i > 0 and tokens[i - 1] == "git" and i + 1 < len(tokens):
            return tokens[i + 1]
    if tokens and tokens[0] == "cd" and len(tokens) >= 2:
        if not require_trailing_cd_op or (len(tokens) >= 3 and tokens[2] in ("&&", ";")):
            return tokens[1]
    return None

def target_dir(d):
    """Resolve the directory a Bash command actually targets: a `git -C <path>` or a
    leading `cd <path> &&`/`;` in the (heredoc-stripped) command wins over the hook's own
    cwd — this is what stops a session running from the project root (branch main) from being
    read as "no run" when the command it's about to execute targets a product worktree.

    Best-effort only: only `git -C <path>` and a LEADING `cd <path> &&`/`;` are recognised.
    A `cd` inside a subshell, or one that isn't the first thing in the command, resolves to
    the hook's own cwd instead — a known limitation, not a security boundary (Claude Code
    reports the hook's cwd, not the Bash tool's effective cwd, so the command text is the
    only source). Non-Bash tools, or a Bash command with neither form, just use the hook's
    cwd."""
    base = hook_cwd(d)
    if d.get("tool_name") != "Bash":
        return os.path.realpath(base)
    cmd = strip_heredocs(d.get("tool_input", {}).get("command", "") or "")
    path = resolve_target_token(cmd)
    if path:
        path = path if os.path.isabs(path) else os.path.join(base, path)
        return os.path.realpath(path)
    return os.path.realpath(base)
