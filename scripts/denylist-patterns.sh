#!/usr/bin/env bash
# denylist-patterns.sh — the two pattern strings, sourced by both scanners (scripts/publish.sh
# and scripts/denylist-scan.sh) so the local pre-commit gate and the publish gate cannot drift.
#
# ALLOW: paths that are allowed to be publishable/staged without tripping the path check.
# DENY:  generic hosted-tool URL fragments only. The names that identify a client, tenant or
#        person live in a local terms file (see denylist-scan.sh / publish.sh) that is never
#        committed, so this file — and the gate itself — cannot leak the list.
ALLOW='^(bin|docs|migrations|packaging|public|punchlist-templates|schemas|scripts|skills|src|test)/|^(README\.md|LICENSE|install\.sh|package\.json|package-lock\.json|\.gitignore|\.gitleaks\.toml)$'
DENY='claude\.ai/|atlassian\.net|slack\.com'

# terms_alternation FILE — read the private terms file and print one ERE alternation.
#
# Every term is matched LITERALLY (metacharacters are escaped, so a term can never
# become a live pattern and silently disable the gate), except that a run of
# separators BETWEEN two alphanumerics matches any separator style or none:
# "Two Words" also catches two-words, two_words and TwoWords.
# A leading or trailing separator stays literal, so a trailing hyphen is not dropped.
# Callers grep case-insensitively (-i), so no case variants are needed in the file.
#
# A term WRAPPED IN DOUBLE QUOTES matches only as a whole word: "ward" then catches
# ward but not wardrobe or steward. Use it for a short term that is also an ordinary
# word or a common substring; a gate that fires on unrelated text gets waved through.
terms_alternation() {
  # `|| true`: a file with no terms makes grep exit 1, which under the callers' `set -e -o pipefail`
  # killed the scan with no message. The callers refuse an empty result explicitly instead.
  { grep -Ev '^[[:space:]]*(#|$)' "$1" || true; } | perl -ne '
    chomp;
    next unless length;
    my $word = s/^"(.*)"$/$1/;                            # "term" -> whole-word match
    next unless length;
    s/(?<=[A-Za-z0-9])[ ._\/-]+(?=[A-Za-z0-9])/\x01/g;   # internal separators -> marker
    s/([][(){}.*+?^\$\\|])/\\$1/g;                        # everything else is literal
    s/\x01/[-_. \/]*/g;                                   # marker -> any separator, or none
    $_ = "(^|[^A-Za-z0-9])$_([^A-Za-z0-9]|\$)" if $word;   # git grep -E does not honour \b
    push @t, $_;
    END { print join("|", @t) }
  '
}

# PRIVATE_ALLOW: private-plane paths. The pre-commit and CI scan (denylist-scan.sh) accepts them and
# scans their content. publish.sh drops them from each public snapshot, so they stay in the private
# repo.
#   .github/workflows/                      the CI workflows. GitHub reads them only at the repo
#                                           root, and the denylist job needs the private terms
#                                           secret and the root scripts.
#   punchlist-templates/process/            this project's own spine: its config, cycle overlays,
#                                           efforts and runs.
#   punchlist-templates/docs/plans/         internal plans.
#   docs/<date>-*.md and                    every dated document: designs, plans, PRDs and
#   punchlist-templates/docs/<date>-*.md    ADRs. The undated docs (docs/macos-setup.md,
#                                           docs/screenshots/, docs/releases/) stay public.
PRIVATE_ALLOW='^\.github/workflows/[^/]+\.ya?ml$|^punchlist-templates/process/|^punchlist-templates/docs/plans/|^(punchlist-templates/)?docs/[0-9]{4}-[0-9]{2}-[0-9]{2}-[^/]*\.md$'

# PRIVATE_EXCEPT: paths under a PRIVATE_ALLOW path that are published all the same. An empty
# pattern would match every path, so publish.sh reads an empty one as "no exceptions".
#   punchlist-templates/process/config/defaults.yaml   the generic spine defaults. The spine
#                                                       reads it as the base of this project's config
#                                                       (loadConfig in lib/spine.js). It stays public
#                                                       because it is the only copy that ships.
PRIVATE_EXCEPT='^punchlist-templates/process/config/defaults\.yaml$'
