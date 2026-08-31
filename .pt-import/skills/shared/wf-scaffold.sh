#!/usr/bin/env bash
# wf-scaffold.sh <name> — start a new workflow from a commented skeleton.
#
# Writes workflows/authored/<name>.md containing valid frontmatter plus one
# commented-out example step of every kind (plain, needs, outcomes, when,
# else_of, on_fail, repeat_until). Uncomment what you need: with only the
# first step uncommented the file already passes `plt validate`.
#
# Repo resolution matches plt-resolve.sh:
#   1. $PUNCHLIST_TEMPLATES_DIR   2. walk up from this script's real path
set -eu

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "usage: wf-scaffold.sh <name>   (lowercase letters, digits, hyphens)" >&2
  exit 2
fi
case "$NAME" in
  *[!a-z0-9-]* | -* | *-)
    echo "wf-scaffold: bad name \`$NAME\` — use lowercase letters, digits, inner hyphens" >&2
    exit 2
    ;;
esac

if [ -n "${PUNCHLIST_TEMPLATES_DIR:-}" ]; then
  ROOT="$PUNCHLIST_TEMPLATES_DIR"
else
  DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
  ROOT="$DIR"
  while [ "$ROOT" != "/" ] && [ ! -f "$ROOT/bin/plt" ]; do
    ROOT="$(dirname "$ROOT")"
  done
  if [ ! -f "$ROOT/bin/plt" ]; then
    echo "wf-scaffold: cannot locate the punchlist-templates repo." >&2
    echo "Set PUNCHLIST_TEMPLATES_DIR to your checkout." >&2
    exit 1
  fi
fi

OUT="$ROOT/workflows/authored/$NAME.md"
if [ -e "$OUT" ]; then
  echo "wf-scaffold: $OUT already exists — refusing to overwrite" >&2
  exit 1
fi
mkdir -p "$ROOT/workflows/authored"

cat > "$OUT" <<EOF
---
name: $NAME
kind: workflow
actors: [owner]                 # everyone who does a step; add agents, e.g. [hermes, owner]
# inputs: [item, budget]        # optional launch inputs — usable as {item} in titles/notes
# tags: [example]
---
steps:
#  - id: first
#    assignee: owner
#    title: "Do the first thing"
#  - id: decide                            # a decision point: name its outcomes
#    assignee: owner
#    needs: [first]                        # sequence: runs after \`first\` completes
#    outcomes: [approved, rejected]        # completer checks exactly ONE Outcome: box
#  - id: act                               # "if": runs when decide records approved
#    assignee: owner
#    title: "Act on the approval"
#    when: { step: decide, outcome: approved }
#    on_fail: { retry: 1, then: recover }  # failure chain: retry once, then hand over
#  - id: shelve                            # "else": no when-branch of decide matched
#    assignee: owner
#    title: "Shelve it"
#    else_of: decide
#  - id: recover                           # on_fail target: spawns only via the chain
#    assignee: owner
#    title: "Act failed — take over"
#  - id: polish                            # loop: respawns until it records \`good\`
#    assignee: owner
#    needs: [first]
#    outcomes: [good, again]
#    repeat_until: good

Describe what this workflow does in a sentence or two, then:

    plt validate workflows/authored/$NAME.md
    plt render $NAME
EOF

echo "$OUT"
