#!/usr/bin/env bash
# screen.sh — deterministic task-text screening (agent-security layer 2).
#
# Usage:
#   screen.sh "title" ["notes"]          malicious screen
#     exit 0  clean
#     exit 3  FLAGGED — reason lines on stdout; do NOT execute the task,
#             finish it with a "⚠ flagged: <reason>" report instead
#   screen.sh --risk "title" ["notes"]   high-risk classifier
#     exit 0  normal
#     exit 4  HIGH-RISK — reason lines on stdout; not malicious, but do NOT
#             execute until the owner confirms out-of-band (layer 4)
#   exit 2  usage error
#
# Pure grep -E -i (ERE, case-insensitive, \b word boundaries) over the
# concatenated title+notes. No network, no state, no dependencies beyond
# GNU grep. Patterns err toward precision: plain owner-style tasks
# ("install X", "look up Y", "email me a summary") must pass the malicious
# screen — see test/screen.test.js for the red-team + benign corpora.
set -u

MODE=screen
if [ "${1:-}" = "--risk" ]; then MODE=risk; shift; fi
[ $# -ge 1 ] || { echo "usage: screen.sh [--risk] \"title\" [\"notes\"]" >&2; exit 2; }
TEXT="${1}
${2:-}"

# ---- malicious red-flag patterns -------------------------------------------
# One per line: ERE<TAB>reason. Rationale per row:
#   .env / id_rsa / id_ed25519 / .aws/credentials / private key
#       — naming a secrets file in a task is a red flag by itself
#   harvesting — collection verb PAIRED with a secret-class object
#       (verb alone or "api" alone never fires: "look up the weather API" is clean)
#   pipe-to-shell / base64-to-shell — remote code execution one-liners
#   exfil — outbound verb PAIRED with a local-file/secret reference
#       ("email me the weekly summary" has no such reference: clean)
#   destructive — rm -rf on /, mkfs, dd onto a block device, fork bomb
#   persistence — crontab/systemd verbs PAIRED with a download
#   protection-override / injection — "disable your rules", "ignore previous
#       instructions": text talking AT the agent about its own safeguards
SCREEN_PATTERNS=$(cat <<'EOF'
\.env\b	references a .env secrets file
\bid_rsa\b|\bid_ed25519\b	references an SSH private key file
\.aws/credentials	references the AWS credentials file
\bprivate[ _-]+key\b	references a private key
\b(read|cat|dump|grab|collect|harvest|extract|exfiltrate|steal|list|find|copy|send|upload|fetch)\b.*\b(api[ _-]?keys?|tokens?|passwords?|credentials?|secrets?)\b	credential-harvesting verb paired with a secret object
(curl|wget)[^|;]*\|[[:space:]]*(sudo[[:space:]]+)?(ba|z|da|fi)?sh\b	pipes a download straight into a shell
\bbase64\b[^|]*(-d|--decode)[^|]*\|[[:space:]]*(sudo[[:space:]]+)?(ba|z)?sh\b	decodes base64 into a shell
\b(send|upload|post|email|copy|forward|transmit)\b.*\b(contents?[ ]of|\.ssh|/etc/|~/|home[ ]directory|local[ ]files?|browser[ ]history)\b	exfiltration shape: local files sent outward
\brm\b[[:space:]]+(-[[:alpha:]]+[[:space:]]+)*-[[:alpha:]]*(rf|fr)[[:alpha:]]*[[:space:]]+/	recursive force-delete from the filesystem root
\bmkfs(\.[a-z0-9]+)?\b	filesystem format command
\bdd\b.*\bof=/dev/	raw write to a block device
:\(\)[[:space:]]*\{[[:space:]]*:\|:	fork bomb
(crontab|cron[ ]?job|systemd|systemctl|\.service\b).*\b(curl|wget|download|fetch)(s|es|ed|ing)?\b	persistence mechanism paired with a download
\b(curl|wget|download|fetch)(s|es|ed|ing)?\b.*(crontab|cron[ ]?job|systemd|systemctl|\.service\b)	download paired with a persistence mechanism
\b(disable|ignore|bypass|skip|turn[ ]off|override)\b[^.]*\b(your[ ])?(rules|screening|security|safety|guardrails?|protections?)\b	asks the agent to disable its protections
\bignore\b[^.]*\b(previous|prior|above|earlier)[ ]instructions\b	prompt-injection phrasing
EOF
)

# ---- high-risk (NOT malicious) patterns ------------------------------------
# Legitimate-but-consequential work that must get an out-of-band human
# confirm (layer 4) before an agent executes it. Rationale per row:
#   software  — installing/upgrading changes the machine
#   system    — services, cron, /etc, daemons: persistent system state
#   secrets   — even legitimate credential work deserves a human ack
#   money     — anything that spends
#   data-loss — bulk deletion of data/files/backups
RISK_PATTERNS=$(cat <<'EOF'
\b(install|upgrade|reinstall|uninstall)\b	installs, upgrades or removes software
\b(apt|apt-get|npm|pip|pipx|brew|snap|cargo|gem)[ ]+(install|upgrade|update|remove)\b	package-manager operation
\b(systemctl|systemd|crontab|cron[ ]?jobs?|daemons?)\b|/etc/|\.service\b	modifies system services or config
\b(\.env|credentials?|api[ _-]?keys?|tokens?|secrets?|passwords?)\b	touches credentials or secret material
\b(buy|purchase|pay|subscribe|checkout|book|reserve)\b|credit[ ]card|\$[0-9]	spends money
\b(delete|drop|purge|wipe|erase|truncate)\b.*\b(data(base)?s?|tables?|files?|records?|backups?|logs?)\b	deletes data
EOF
)

hits=0
check() { # check PATTERNS -> prints reasons, sets hits
  while IFS=$'\t' read -r pattern reason; do
    [ -n "$pattern" ] || continue
    if printf '%s' "$TEXT" | grep -Eiq -- "$pattern"; then
      echo "$reason"
      hits=$((hits + 1))
    fi
  done <<<"$1"
}

if [ "$MODE" = "risk" ]; then
  check "$RISK_PATTERNS"
  [ "$hits" -eq 0 ] && exit 0 || exit 4
else
  check "$SCREEN_PATTERNS"
  [ "$hits" -eq 0 ] && exit 0 || exit 3
fi
