'use strict';
// repo-window — the repo-window guard (D-025-ish, Task 9). Two windows sharing one
// checkout have twice destroyed each other's uncommitted work here: a sweeping
// `git add` swept a fixer's hunks into an unrelated commit, and a dirty
// `templates/index.json` was left mid-task by another window. `owner_window`
// (spine.js) protects a RUN; this protects the REPO. A repo is "claimed" by
// writing `.plt-owner.json` under locking.withLock, so two windows racing to
// claim never interleave a write. Both the owner file and the lock live in the
// checkout's own git dir (`git rev-parse --git-dir`: `.git` for the main
// checkout, `.git/worktrees/<name>` for a linked one), where git never lists
// them. In the tree, every repo without matching .gitignore lines would have
// its pin refused once claimed (spine.computePin refuses untracked files).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const locking = require('./locking');

// The directory that holds the claim and its lock: the per-worktree git dir,
// absolute. A directory that is not a git checkout has no git dir and no pin
// to protect, so the claim falls back to the directory itself.
function claimDir(repoDir) {
  try {
    const gitDir = execFileSync('git', ['-C', repoDir, 'rev-parse', '--git-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.resolve(repoDir, gitDir);
  } catch (e) {
    return repoDir;
  }
}

function ownerPath(repoDir) {
  return path.join(claimDir(repoDir), '.plt-owner.json');
}

// repoOwner(repoDir) -> { window, at } — { window: null, at: null } when the
// repo has never been claimed, or the owner file is missing/unreadable.
function repoOwner(repoDir) {
  try {
    const data = JSON.parse(fs.readFileSync(ownerPath(repoDir), 'utf8'));
    return { window: data.window || null, at: data.at || null };
  } catch (e) {
    return { window: null, at: null };
  }
}

// claimRepo(repoDir, window, { takeOver }) -> { claimed, heldBy }. Writes the
// owner file when the repo is unclaimed, already ours, or takeOver is set;
// otherwise refuses and names the current holder. heldBy is whoever held the
// repo immediately before this call (null the first time).
function claimRepo(repoDir, window, { takeOver = false } = {}) {
  return locking.withLock(claimDir(repoDir), () => {
    const current = repoOwner(repoDir);
    if (current.window && current.window !== window && !takeOver) {
      return { claimed: false, heldBy: current.window };
    }
    locking.writeFileAtomic(
      ownerPath(repoDir),
      JSON.stringify({ window, at: new Date().toISOString() }, null, 2) + '\n',
    );
    return { claimed: true, heldBy: current.window };
  });
}

// releaseRepo(repoDir, window, { takeOver }) -> { released, heldBy }. Removes
// the owner file when the repo is unclaimed, owned by `window`, or takeOver
// is set; otherwise refuses and names the current holder.
function releaseRepo(repoDir, window, { takeOver = false } = {}) {
  return locking.withLock(claimDir(repoDir), () => {
    const current = repoOwner(repoDir);
    if (current.window && current.window !== window && !takeOver) {
      return { released: false, heldBy: current.window };
    }
    try { fs.unlinkSync(ownerPath(repoDir)); } catch (e) { /* already gone */ }
    return { released: true, heldBy: current.window };
  });
}

// assertRepoWindow(repoDir, window) — throws when repoDir is claimed by a
// window other than `window`, naming the repo, the holder, and the fix: run
// your own worktree (or pass --take-over). A null/matching owner passes
// silently, and callers with no repo_dir (a spike) never call this at all.
function assertRepoWindow(repoDir, window) {
  const owner = repoOwner(repoDir);
  if (owner.window && owner.window !== window) {
    throw new Error(
      `repo ${repoDir} is being driven by window ${owner.window}; `
      + `use your own worktree (scripts/plt-worktree.sh ${window}) or pass --take-over`,
    );
  }
}

function parseRepoArgs(argv) {
  let repo = process.cwd();
  let takeOver = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') repo = path.resolve(argv[++i]);
    else if (argv[i] === '--take-over') takeOver = true;
  }
  return { repo, takeOver };
}

// plt repo claim|status|release [--repo <dir>] [--take-over] — window comes
// from PLT_WINDOW. claim/release write under the lock; status only reads.
function repoHandler(argv) {
  const sub = argv[0];
  const { repo, takeOver } = parseRepoArgs(argv.slice(1));
  const window = process.env.PLT_WINDOW;

  if (sub === 'status') {
    const owner = repoOwner(repo);
    process.stdout.write(owner.window
      ? `${repo} is claimed by window ${owner.window} (since ${owner.at})\n`
      : `${repo} is unclaimed\n`);
    return 0;
  }

  if (sub === 'claim') {
    if (!window) {
      process.stderr.write('plt repo claim: PLT_WINDOW is not set; export it first (scripts/plt-worktree.sh <name> prints the line)\n');
      return 2;
    }
    const r = claimRepo(repo, window, { takeOver });
    if (!r.claimed) {
      process.stderr.write(`plt repo claim: ${repo} is held by window ${r.heldBy}; pass --take-over to reclaim\n`);
      return 1;
    }
    process.stdout.write(`${repo} claimed by window ${window}${r.heldBy ? ` (was ${r.heldBy})` : ''}\n`);
    return 0;
  }

  if (sub === 'release') {
    if (!window) {
      process.stderr.write('plt repo release: PLT_WINDOW is not set\n');
      return 2;
    }
    const r = releaseRepo(repo, window, { takeOver });
    if (!r.released) {
      process.stderr.write(`plt repo release: ${repo} is held by window ${r.heldBy}, not ${window}; pass --take-over to force\n`);
      return 1;
    }
    process.stdout.write(`${repo} released\n`);
    return 0;
  }

  process.stderr.write('usage: plt repo claim|status|release [--repo <dir>] [--take-over]\n');
  return 2;
}

const commands = [{ name: 'repo', usage: 'plt repo claim|status|release [--repo <dir>] [--take-over]', handler: repoHandler }];

module.exports = { claimDir, repoOwner, claimRepo, releaseRepo, assertRepoWindow, repoHandler, commands };
