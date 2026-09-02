# Pre-push process (public repo)

*Maintainer process for pushing this repo (and any public repo). Two gated
steps before a push, then the push itself.*

punchlist is public (npm `@aronvaughan/punchlist`), so a push must never
leak a secret or personal information, and the exact diff should be reviewed
first. The process is encoded as the `pre-push` workflow in
`punchlist-templates/` and two agent skills; run it before every push.

## Step 1 — Leak scan (gate)

Skill: **`av-repo-leak-scan`** (template: `repo-leak-scan`).

Scans the **working tree and full git history** (every commit on every ref —
a rewrite hides nothing from `git rev-list --all`) for:

- **Secret formats** — private keys, cloud/API tokens, JWTs, DB URIs with
  inline credentials (generic, shipped patterns).
- **Owner PII** — from a private, never-committed terms file
  (`~/.config/leak-scan/terms.txt`, mode 600): name, emails, addresses,
  client/tenant names, claim numbers, dollar figures, known passwords.

```bash
av-repo-leak-scan <repo> --fetch    # exit 0 clean · 1 findings · 2 error
```

Must be **clean**, or every finding explained as intentional (e.g. the
author name in `LICENSE`). A real SECRET already in public history means
**rotate the credential now** — rotation matters more than scrubbing.

## Step 2 — Pre-push review

Skill: **`av-prepush-review`** (template: `pre-push-review`).

Builds one shareable page of everything the push would send (`git diff BASE`
→ working tree): metrics, a per-commit list, a hand-written summary + worked
example, and the full per-file diff. Published as a private artifact; the
link is the deliverable.

## Step 3 — Push

Ask-gated. Only after a clean scan and an approved review. Never force-push a
shared branch.

## Run it as a workflow

```bash
plt launch pre-push --input repo=punchlist base=origin/master
```

The `data/` private plane + the `punchlist-govern` write guard keep secrets
out of tracked paths by construction; step 1 verifies nothing slipped past.
