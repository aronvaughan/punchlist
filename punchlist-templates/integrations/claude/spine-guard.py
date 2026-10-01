#!/usr/bin/env python3
"""Reject hand edits under process/runs/** — those files are written only by plt."""
import os, re, sys
sys.path.insert(0, os.path.dirname(__file__)); from spine_common import read_input, emit  # noqa: E402
d = read_input(); fp = str(d.get("tool_input", {}).get("file_path", ""))
if re.search(r"(^|/)process/runs/[^/]+/(state\.yaml|events\.jsonl|HANDOFF\.md)$", fp):
    emit({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
          "permissionDecisionReason": f"{os.path.basename(fp)} is plt-only. Use plt step/receipt/gate/handoff."}})
