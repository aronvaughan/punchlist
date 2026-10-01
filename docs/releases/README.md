# Releases

One file per public release, named by its tag (`v0.2.0.md`). The file is the tagged commit's
message on the public repo. Write it for a public reader: what changed and why, with no internal
references. Without `--message`, `scripts/publish.sh <version>` refuses to run without the note.
The script scans the note like the tree.

## One release, one commit

Commit the release note, then run `scripts/publish.sh <version>`. The script publishes the tree at
`master` as one commit on public/master and tags it.

## One release, several bundles

A release can also go out as a series of commits, one per feature bundle. Each bundle is a
snapshot: the private tree at one commit on `master`, less the private paths, pushed as its own
public commit. Publish the bundles oldest
first, one run each. Each run builds on the public/master that the run before it left:

```
scripts/publish.sh v1.1.0 --at <sha1> --message <bundle-1-message> --no-tag
scripts/publish.sh v1.1.0 --at <sha2> --message <bundle-2-message> --no-tag
scripts/publish.sh v1.1.0 --at <sha3>
```

- `--at <sha>` picks the commit. It must be a first-parent commit of `origin/master`: a state
  `master` was in, not a commit from a merged branch.
- `--message <file>` is that bundle's commit message. Keep it outside the repo or commit it, because
  the script refuses a dirty worktree. It is scanned like the release note. Without `--message`, the
  message is `docs/releases/<version>.md`, read from the tree at the `--at` commit.
- `--no-tag` pushes the commit without a tag. Give it to every bundle but the last.
- `--dry-run` builds and checks the commit on a local `publish/<date>` branch and pushes nothing.

A run refuses when public/master is not what the script expects. It must be one of these:

- an ancestor of `<sha>`;
- the tree that the script publishes for a first-parent commit at or before `<sha>`. The bundle
  before is such a tree. So is a public/master that private merges later (see the next section).

So a commit made on public that private has not merged, or a bundle run out of order, stops the
series. The refusal names the commands that reconcile it. The script compares trees, not
histories, so the check still holds after someone rewrites public's history.

## Edits made on public

Sometimes someone commits to public directly. Take the edit into private with a merge on
`master` that keeps public's version of each path public changed:

```
git merge -s ours --no-commit public/master     # add --allow-unrelated-histories after a rewrite
git checkout public/master -- <each path public changed>
git commit
git push origin master
```

A bundle cut after that merge has the edit in its own tree. A bundle cut before it carries the
edit. The script finds the merges after `<sha>` that bring public history in, directly or through
a merged branch. Each path such a merge set to public's version goes out as the merge has it. So
the bundle does not revert the edit on public, and the next bundle builds on it as usual. Nothing
is recorded; the merge is the record.

A merge brings public history in when the merge base of its merged parent and public/master is
new to its first parent. That rule also matches a subtree add of a commit from public's history,
or a merge of a branch that started from public. Such a merge carries only the paths it set to
public's version, often none. A tree check before the push catches a wrong or missing carried path.

The script finds public's private base. That is the first-parent commit whose tree, plus the paths
the merges set to public's version, is public's tree less its private-plane paths. A bundle cut
before public's private base would roll public back, so the script refuses it. It refuses too when private took public's edit
with a cherry-pick instead of a merge, because nothing then shows which paths are public's.

The script refuses when a private commit between `<sha>` and the merge also changes a carried
path. Cut the bundle at or after that commit. It also refuses an edit that public made to a
private-plane path, because every bundle drops that path.

Before the push, the tree check compares the bundle with the tree at `<sha>` and with
public/master. Each path must be as one of the two has it. Where public edited a path that private
left alone up to `<sha>`, the bundle must keep public's version.

## What stays private

Every snapshot leaves out the private-plane paths (`PRIVATE_ALLOW` in
`scripts/denylist-patterns.sh`): the CI workflows, this project's own process spine under
`punchlist-templates/process/`, the internal plans under `punchlist-templates/docs/plans/`, and
every dated document in `docs/` and `punchlist-templates/docs/` (`<date>-*.md`: designs, plans,
PRDs and ADRs). The undated docs stay public: `docs/macos-setup.md`, `docs/screenshots/` and
`docs/releases/`. The one exception is
`punchlist-templates/process/config/defaults.yaml`, the generic process-spine defaults, which is
published.
