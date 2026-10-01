'use strict';
// lib/rebase.js — the merge-conflict outcome and `plt card rebase <effort>/<n>`.
//
// Every fixture here is a throwaway git repo in a temp dir: a bare `origin` with `main`, one clone
// that plays the card's worktree, and a second clone that moves `main` underneath it. Nothing in
// this file touches the repository it lives in.
//
// The tests that matter are the REFUSALS. A rebase is destructive, so each guard gets a test that
// fails if the guard is deleted — proved by deleting each one in turn, not assumed.
//
// "Never pushes" is asserted on the OUTCOME, not on the injected runner. A spy over `exec` sees
// only what is handed to it: a direct `execFileSync('git', [..., 'push', '--force', ...])` inside
// lib/rebase.js sails past it, and did — every test passed while the origin really gained the ref.
// `refs()` snapshots every ref in the bare origin before and after; that check is true whatever
// code path a push would take. The spy assertions stay as a cheaper early signal.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const rebase = require('../lib/rebase');
const spine = require('../lib/spine');
const yaml = require('../lib/yaml');
const registry = require('../lib/registry');
const schemas = require('../lib/schemas');
const FIX = path.join(__dirname, 'fixtures', 'spine');

function git(dir, ...args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }); }

function identify(dir) {
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
}

// A bare origin holding `main` with one file, plus a "mover" clone that can push new main commits.
function originWithMain(content = 'one\n') {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-origin-'));
  git(origin, 'init', '-q', '--bare');
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-seed-'));
  git(seed, 'init', '-q', '-b', 'main');
  identify(seed);
  fs.writeFileSync(path.join(seed, 'a.txt'), content);
  git(seed, 'add', 'a.txt');
  git(seed, 'commit', '-qm', 'init');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  return { origin, seed };
}

// Move origin/main by rewriting a.txt from the mover clone.
function moveMain(origin, content) {
  const mover = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-mover-'));
  execFileSync('git', ['clone', '-q', origin, mover]);
  identify(mover);
  fs.writeFileSync(path.join(mover, 'a.txt'), content);
  git(mover, 'commit', '-qam', 'main moved');
  git(mover, 'push', '-q', 'origin', 'main');
  return mover;
}

// A launched card: process dir from the spine fixtures, a clone on the card's own branch with one
// commit, and inputs naming the effort and that branch.
function card({ branchContent = 'branch change\n', file = 'b.txt', branch = 'feat/TRK-10', effort = 'greenhouse',
  omitBranch = false, omitEffort = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-'));
  const p = path.join(root, 'process');
  fs.cpSync(FIX, p, { recursive: true });
  const { origin } = originWithMain();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-card-'));
  execFileSync('git', ['clone', '-q', origin, repo]);
  identify(repo);
  git(repo, 'checkout', '-q', '-b', branch);
  fs.writeFileSync(path.join(repo, file), branchContent);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'card work');
  spine.launchRun(p, { runId: 'TRK-10', cycle: 'build-and-ship', repoDir: repo, owner: 'greenhouse' });
  fs.mkdirSync(path.join(p, 'runs', 'TRK-10'), { recursive: true });
  const inputs = { card: 'TRK-10', effort, branch, repo_dir: repo, touches: [] };
  if (omitBranch) delete inputs.branch;     // exactly what lib/effort.js writes for a `cycle: spike` card
  if (omitEffort) delete inputs.effort;
  fs.writeFileSync(path.join(p, 'runs', 'TRK-10', 'inputs.yaml'), yaml.stringify(inputs));
  return { p, repo, origin, branch };
}

// Every ref in a repo, as a sorted `<refname> <sha>` list. Snapshotted around a rebase: this is
// what makes "never pushes" a claim about the world rather than about our own call discipline.
function refs(dir) {
  return git(dir, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter(Boolean).sort();
}

// A spy that records every git argv while still running the real command.
function spyExec() {
  const calls = [];
  const exec = (dir, args) => { calls.push(args.join(' ')); return rebase.defaultExec(dir, args); };
  exec.calls = calls;
  return exec;
}

const events = (p, id) => spine.readEvents(p, id);
const evOf = (p, id, name) => events(p, id).filter((e) => e.name === name);

// ---- target parsing --------------------------------------------------------

test('a target that is not <effort>/<card> is refused, not guessed at', () => {
  assert.deepStrictEqual(rebase.parseTarget('greenhouse/TRK-10'), { effort: 'greenhouse', card: 'TRK-10' });
  for (const bad of ['TRK-10', 'greenhouse/TRK-10/x', 'greenhouse/../etc', 'green house/TRK-10', 'greenhouse/a b', '', undefined]) {
    assert.throws(() => rebase.parseTarget(bad), /must be <effort>\/<card>/, `accepted ${JSON.stringify(bad)}`);
  }
});

// ---- the happy path --------------------------------------------------------

test('a clean card rebases onto origin/main, records the rebase, and never pushes', () => {
  const { p, repo, origin } = card();
  moveMain(origin, 'main moved\n');
  const before = git(repo, 'rev-parse', 'HEAD').trim();
  const exec = spyExec();

  const r = rebase.rebaseCard(p, 'greenhouse/TRK-10', { exec });

  assert.strictEqual(r.ok, true, r.message);
  assert.notStrictEqual(r.head, before, 'HEAD did not move: nothing was rebased');
  // origin/main is now an ancestor of the card's branch — that is what "rebased" means.
  git(repo, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD');
  assert.strictEqual(git(repo, 'branch', '--show-current').trim(), 'feat/TRK-10');
  assert.strictEqual(evOf(p, 'TRK-10', 'rebase').length, 1);
  assert.strictEqual(evOf(p, 'TRK-10', 'rebase')[0].result, 'rebased');
  assert.ok(!exec.calls.some((c) => /(^|\s)push(\s|$)/.test(c)), 'a push was issued: ' + exec.calls.join(' | '));
  assert.ok(!exec.calls.some((c) => c.includes('--force')), 'a --force was issued: ' + exec.calls.join(' | '));
});

// The claim, asserted where it is true: the remote's refs. This kills a push written with a bare
// execFileSync, which the exec spy above cannot see.
test('a clean rebase leaves every ref in the origin exactly as it was', () => {
  const { p, origin } = card();
  moveMain(origin, 'main moved\n');
  const before = refs(origin);
  const r = rebase.rebaseCard(p, 'greenhouse/TRK-10', {});
  assert.strictEqual(r.ok, true, r.message);
  assert.deepStrictEqual(refs(origin), before, 'the origin changed: something pushed');
});

test('a conflicted rebase leaves every ref in the origin exactly as it was', () => {
  const { p, repo, origin } = card({ file: 'a.txt', branchContent: 'branch edit\n' });
  moveMain(origin, 'main edit\n');
  const before = refs(origin);
  const r = rebase.rebaseCard(p, 'greenhouse/TRK-10', {});
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(refs(origin), before, 'the origin changed: something pushed');
  git(repo, 'rebase', '--abort');
});

test('a rebase moves the card branch and nothing else — local sibling refs are left alone', () => {
  const { p, repo, origin } = card();
  // A sibling branch pointing INTO the range being rebased. With rebase.updateRefs on (git's
  // default-ish since 2.38) git rewrites it too — and refs are shared by every worktree of the
  // repo, so another card's branch moves under it.
  git(repo, 'config', 'rebase.updateRefs', 'true');
  git(repo, 'branch', 'feat/SIBLING-9');
  const siblingBefore = git(repo, 'rev-parse', 'feat/SIBLING-9').trim();
  moveMain(origin, 'main moved\n');

  const r = rebase.rebaseCard(p, 'greenhouse/TRK-10', {});

  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(git(repo, 'rev-parse', 'feat/SIBLING-9').trim(), siblingBefore,
    "the rebase rewrote a branch this card does not own");
});

test('a successful rebase re-runs the merge step verification at the new pin', () => {
  const { p, repo, origin } = card();
  moveMain(origin, 'main moved\n');
  // A receipt taken BEFORE the rebase is pinned to a commit the rebase rewrites away.
  const oldPin = spine.computePin(repo);
  spine.appendEvent(p, 'TRK-10', { kind: 'gh', step: 'merge', name: 'merged', result: 'pass', actor: 'agent', pin: oldPin });

  const r = rebase.rebaseCard(p, 'greenhouse/TRK-10', {});

  assert.strictEqual(r.ok, true);
  assert.ok(r.verify, 'no verification was re-run after the rebase');
  assert.strictEqual(r.verify.ok, false, 'verification passed although every receipt was taken at the old pin');
  assert.ok(r.verify.missing.some((m) => m.reason && /older pin/.test(m.reason)),
    'the stale receipt was not reported as stale: ' + JSON.stringify(r.verify.missing));
});

// ---- the refusals ----------------------------------------------------------

test('a dirty worktree is refused and HEAD is left where it was', () => {
  const { p, repo, origin } = card();
  moveMain(origin, 'main moved\n');
  const before = git(repo, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(repo, 'b.txt'), 'uncommitted work\n');

  assert.throws(() => rebase.rebaseCard(p, 'greenhouse/TRK-10', {}), /is dirty/);
  assert.strictEqual(git(repo, 'rev-parse', 'HEAD').trim(), before, 'HEAD moved despite the refusal');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'uncommitted work\n');
  assert.strictEqual(evOf(p, 'TRK-10', 'rebase').length, 0, 'a refused rebase still wrote an attempt');
});

test('an untracked file counts as dirty — a rebase never runs over work git is not holding', () => {
  const { p, repo, origin } = card();
  moveMain(origin, 'main moved\n');
  fs.writeFileSync(path.join(repo, 'scratch.md'), 'notes\n');
  assert.throws(() => rebase.rebaseCard(p, 'greenhouse/TRK-10', {}), /is dirty/);
});

test('a rebase already in progress is refused, never restarted', () => {
  const { p, repo, origin } = card({ file: 'a.txt', branchContent: 'branch edit\n' });
  moveMain(origin, 'main edit\n');
  const first = rebase.rebaseCard(p, 'greenhouse/TRK-10', {});
  assert.strictEqual(first.ok, false, 'the fixture did not actually conflict');

  assert.throws(() => rebase.rebaseCard(p, 'greenhouse/TRK-10', {}), /already in progress/);
  assert.ok(rebase.rebaseInProgress(repo, rebase.defaultExec), 'the in-progress rebase was cleared');
});

test('a detached HEAD is refused', () => {
  const { p, repo, origin } = card();
  moveMain(origin, 'main moved\n');
  git(repo, 'checkout', '-q', '--detach');
  assert.throws(() => rebase.rebaseCard(p, 'greenhouse/TRK-10', {}), /detached HEAD/);
});

test("a branch that is not the card's own is refused", () => {
  const { p, repo, origin } = card();
  moveMain(origin, 'main moved\n');
  git(repo, 'checkout', '-q', '-b', 'feat/SOMEONE-ELSE');
  const before = git(repo, 'rev-parse', 'HEAD').trim();
  assert.throws(() => rebase.rebaseCard(p, 'greenhouse/TRK-10', {}), /refusing to rebase a branch this card does not own/);
  assert.strictEqual(git(repo, 'rev-parse', 'HEAD').trim(), before);
});

test("a card claimed for the wrong effort is refused — the run's own inputs are the authority", () => {
  const { p, repo, origin } = card();
  moveMain(origin, 'main moved\n');
  const before = git(repo, 'rev-parse', 'HEAD').trim();
  assert.throws(() => rebase.rebaseCard(p, 'otherhouse/TRK-10', {}), /belongs to effort greenhouse/);
  assert.strictEqual(git(repo, 'rev-parse', 'HEAD').trim(), before);
});

test('a card with no branch of its own (a spike card) is refused — an absent input must not pass', () => {
  const { p, repo, origin } = card({ omitBranch: true });
  moveMain(origin, 'main moved\n');
  // A spike card's repo_dir is the CANONICAL checkout, and the user may be on anything at all.
  git(repo, 'checkout', '-q', '-b', 'release/2.3');
  const before = git(repo, 'rev-parse', 'HEAD').trim();
  assert.throws(() => rebase.rebaseCard(p, 'greenhouse/TRK-10', {}), /has no branch of its own/);
  assert.strictEqual(git(repo, 'rev-parse', 'HEAD').trim(), before, 'a branchless card rebased the checkout anyway');
});

test('a run with no inputs.effort is refused — no effort owns it, so no target names it', () => {
  const { p, repo, origin } = card({ omitEffort: true });
  moveMain(origin, 'main moved\n');
  const before = git(repo, 'rev-parse', 'HEAD').trim();
  assert.throws(() => rebase.rebaseCard(p, 'anything/TRK-10', {}), /has no inputs\.effort/);
  assert.strictEqual(git(repo, 'rev-parse', 'HEAD').trim(), before);
});

test('a repo_dir that is a plain directory inside another repo is refused', () => {
  const { p, repo, origin } = card();
  moveMain(origin, 'main moved\n');
  // The shape that makes every `git -C` here silently drive the enclosing repo.
  const inner = path.join(repo, 'packages', 'not-a-repo');
  fs.mkdirSync(inner, { recursive: true });
  const st = spine.readState(p, 'TRK-10');
  st.repo_dir = inner;
  spine.writeState(p, 'TRK-10', st);
  const before = git(repo, 'rev-parse', 'HEAD').trim();
  assert.throws(() => rebase.rebaseCard(p, 'greenhouse/TRK-10', {}), /not the top of a git worktree/);
  assert.strictEqual(git(repo, 'rev-parse', 'HEAD').trim(), before);
});

test('a base ref that does not resolve is refused before git rebase is ever run', () => {
  const { p, repo, origin } = card();
  moveMain(origin, 'main moved\n');
  fs.writeFileSync(path.join(p, 'config', 'zz-base.yaml'), 'worktree:\n  base: origin/does-not-exist\n');
  const before = git(repo, 'rev-parse', 'HEAD').trim();

  assert.throws(() => rebase.rebaseCard(p, 'greenhouse/TRK-10', {}), /base ref origin\/does-not-exist does not resolve/);
  assert.strictEqual(git(repo, 'rev-parse', 'HEAD').trim(), before);
  // Refused up front, so nothing is recorded: an unresolvable base is a config bug, not an attempt.
  assert.strictEqual(evOf(p, 'TRK-10', 'rebase').length, 0, 'an attempt was recorded for a rebase that never ran');
});

test('a card with no run, and a run whose worktree is gone, are both refused', () => {
  const { p, repo } = card();
  assert.throws(() => rebase.rebaseCard(p, 'greenhouse/TRK-99', {}), /no run TRK-99/);
  fs.rmSync(repo, { recursive: true, force: true });
  assert.throws(() => rebase.rebaseCard(p, 'greenhouse/TRK-10', {}), /no worktree on disk/);
});

// ---- the conflict outcome --------------------------------------------------

test('a conflicted rebase is LEFT IN PROGRESS, records the outcome, and never pushes', () => {
  const { p, repo, origin } = card({ file: 'a.txt', branchContent: 'branch edit\n' });
  moveMain(origin, 'main edit\n');
  const exec = spyExec();

  const r = rebase.rebaseCard(p, 'greenhouse/TRK-10', { exec });

  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.paths, ['a.txt']);
  assert.strictEqual(r.next, 'plt card rebase greenhouse/TRK-10');
  assert.ok(rebase.rebaseInProgress(repo, rebase.defaultExec), 'the conflicted rebase was aborted — the evidence is gone');
  assert.ok(!exec.calls.some((c) => /rebase --abort|rebase --skip/.test(c)), 'the rebase was cleaned up behind the human: ' + exec.calls.join(' | '));
  assert.ok(!exec.calls.some((c) => /(^|\s)push(\s|$)/.test(c)), 'a push was issued: ' + exec.calls.join(' | '));
  assert.ok(/LEFT IN PROGRESS/.test(r.message), r.message);
});

test('the conflict record carries the card, the effort, the repo, the paths and the next command', () => {
  const { p, repo, origin } = card({ file: 'a.txt', branchContent: 'branch edit\n' });
  moveMain(origin, 'main edit\n');
  rebase.rebaseCard(p, 'greenhouse/TRK-10', {});

  const rec = evOf(p, 'TRK-10', 'merge-conflict');
  assert.strictEqual(rec.length, 1, 'no merge-conflict record was written');
  const e = rec[0];
  assert.strictEqual(e.card, 'TRK-10');
  assert.strictEqual(e.effort_slug, 'greenhouse');
  assert.strictEqual(e.repo, repo);
  assert.strictEqual(e.branch, 'feat/TRK-10');
  assert.deepStrictEqual(e.paths, ['a.txt']);
  assert.strictEqual(e.next, 'plt card rebase greenhouse/TRK-10');
  assert.strictEqual(e.step, 'merge');
  // The ledger discriminator: a RUN line carries `run` and never `effort` (schemas/event.schema.json).
  assert.strictEqual(e.run, 'TRK-10');
  assert.ok(!('effort' in e), 'the run line carries `effort` — it now reads as an effort-ledger line');
});

test('plt card conflict predicts the conflicting paths when nobody measured them', () => {
  const { p, origin } = card({ file: 'a.txt', branchContent: 'branch edit\n' });
  moveMain(origin, 'main edit\n');
  const rec = rebase.conflictRecord(p, 'greenhouse/TRK-10', { record: false });
  assert.deepStrictEqual(rec.paths, ['a.txt']);
  assert.strictEqual(rec.next, 'plt card rebase greenhouse/TRK-10');
});

test('every event this module writes validates against schemas/event.schema.json', () => {
  const { p, repo, origin } = card({ file: 'a.txt', branchContent: 'branch edit\n' });
  moveMain(origin, 'main edit\n');
  rebase.rebaseCard(p, 'greenhouse/TRK-10', {});          // conflict + merge-conflict record
  git(repo, 'rebase', '--abort');
  rebase.rebaseCard(p, 'greenhouse/TRK-10', {});          // second conflict -> escalation
  git(repo, 'rebase', '--abort');
  const mine = events(p, 'TRK-10').filter((e) => ['rebase', 'merge-conflict', 'rebase-hard-gate'].includes(e.name));
  assert.ok(mine.length >= 5, `only ${mine.length} events written`);
  for (const e of mine) {
    const r = schemas.validateObject('event', e);
    assert.ok(r.ok, `${e.name}: ${JSON.stringify(r.errors)}`);
  }
});

test('a rebase that never starts is an error, not a conflict — it claims nothing and counts nothing', () => {
  const { p, repo, origin } = card();
  moveMain(origin, 'main moved\n');
  // A pre-rebase hook that refuses: git exits non-zero with nothing unmerged and no rebase started.
  const hookDir = path.join(git(repo, 'rev-parse', '--absolute-git-dir').trim(), 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, 'pre-rebase'), '#!/bin/sh\necho "pre-rebase says no" >&2\nexit 1\n', { mode: 0o755 });

  assert.throws(() => rebase.rebaseCard(p, 'greenhouse/TRK-10', {}), /did not start/);
  assert.ok(!rebase.rebaseInProgress(repo, rebase.defaultExec), 'nothing was started, yet a rebase is in progress');
  const ev = evOf(p, 'TRK-10', 'rebase');
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].result, 'error', 'a rebase that never started was recorded as a conflict');
  assert.match(ev[0].error, /pre-rebase says no/, "git's own message was discarded");
  assert.strictEqual(evOf(p, 'TRK-10', 'merge-conflict').length, 0, 'a conflict record was written for a non-conflict');
  // Three of those must not reach the hard gate.
  for (let i = 0; i < 2; i++) assert.throws(() => rebase.rebaseCard(p, 'greenhouse/TRK-10', {}), /did not start/);
  assert.strictEqual(rebase.standingFailures(p, 'TRK-10'), 0, 'failures to start counted toward the hard gate');
});

test('an `error` attempt neither counts toward the hard gate nor clears it', () => {
  const { p, repo, origin } = card({ file: 'a.txt', branchContent: 'branch edit\n' });
  moveMain(origin, 'main edit\n');
  rebase.rebaseCard(p, 'greenhouse/TRK-10', {}); git(repo, 'rebase', '--abort');
  rebase.rebaseCard(p, 'greenhouse/TRK-10', {}); git(repo, 'rebase', '--abort');
  assert.strictEqual(rebase.standingFailures(p, 'TRK-10'), 2);

  // A rebase that never started, recorded by THIS module (writer marker and all). Only a
  // `rebased` result means the branch moved; an error changes nothing either way.
  const hookDir = path.join(git(repo, 'rev-parse', '--absolute-git-dir').trim(), 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, 'pre-rebase'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.throws(() => rebase.rebaseCard(p, 'greenhouse/TRK-10', { by: 'aron' }), /did not start/);
  assert.strictEqual(evOf(p, 'TRK-10', 'rebase').pop().result, 'error');

  assert.strictEqual(rebase.standingFailures(p, 'TRK-10'), 2, 'an error cleared a standing hard gate');
});

// ---- the hard gate ---------------------------------------------------------

test('two conflicted rebases raise a hard gate and refuse the third attempt without a person', () => {
  const { p, repo, origin } = card({ file: 'a.txt', branchContent: 'branch edit\n' });
  moveMain(origin, 'main edit\n');

  const first = rebase.rebaseCard(p, 'greenhouse/TRK-10', {});
  assert.strictEqual(first.hard_gate, false, 'one conflict must not be a gate');
  git(repo, 'rebase', '--abort');                      // the human looked, and handed it back

  const second = rebase.rebaseCard(p, 'greenhouse/TRK-10', {});
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.hard_gate, true, 'two conflicts did not raise the gate');
  assert.strictEqual(evOf(p, 'TRK-10', 'rebase-hard-gate').length, 1, 'the escalation was not recorded');
  git(repo, 'rebase', '--abort');

  assert.throws(() => rebase.rebaseCard(p, 'greenhouse/TRK-10', {}), /hard gate/,
    'a third rebase ran itself through the gate');
  // `agent` is not a person, and neither is a bare `--by` with no value.
  assert.throws(() => rebase.rebaseCard(p, 'greenhouse/TRK-10', { by: 'agent' }), /is not a person/,
    '--by agent passed a gate that says a person must');
  assert.throws(() => rebase.rebaseCard(p, 'greenhouse/TRK-10', { by: true }), /is not a person/);
  // A person may take the next attempt in their own name.
  const third = rebase.rebaseCard(p, 'greenhouse/TRK-10', { by: 'aron' });
  assert.strictEqual(third.ok, false);
  assert.strictEqual(evOf(p, 'TRK-10', 'rebase').pop().by, 'aron', "the person who took the attempt is not in the ledger");
  git(repo, 'rebase', '--abort');
});

test('--by is held to config.actors.humans where the project lists them', () => {
  const { p, repo, origin } = card({ file: 'a.txt', branchContent: 'branch edit\n' });
  fs.writeFileSync(path.join(p, 'config', 'zz-humans.yaml'), 'actors:\n  humans: [aron]\n');
  moveMain(origin, 'main edit\n');
  rebase.rebaseCard(p, 'greenhouse/TRK-10', {}); git(repo, 'rebase', '--abort');
  rebase.rebaseCard(p, 'greenhouse/TRK-10', {}); git(repo, 'rebase', '--abort');
  assert.throws(() => rebase.rebaseCard(p, 'greenhouse/TRK-10', { by: 'somebody' }), /not a human in config\.actors\.humans/);
  const ok = rebase.rebaseCard(p, 'greenhouse/TRK-10', { by: 'aron' });
  assert.strictEqual(ok.ok, false);
  git(repo, 'rebase', '--abort');
});

test('the agent cannot clear its own hard gate with a receipt it can write', () => {
  const { p, repo, origin } = card({ file: 'a.txt', branchContent: 'branch edit\n' });
  moveMain(origin, 'main edit\n');
  rebase.rebaseCard(p, 'greenhouse/TRK-10', {}); git(repo, 'rebase', '--abort');
  rebase.rebaseCard(p, 'greenhouse/TRK-10', {}); git(repo, 'rebase', '--abort');
  assert.strictEqual(rebase.standingFailures(p, 'TRK-10'), 2);

  // Exactly what `plt receipt --kind decision --name rebase --result rebased` puts in the ledger.
  // recordReceipt writes a fixed key set, so it cannot carry the writer marker.
  spine.appendEvent(p, 'TRK-10', { kind: 'decision', step: 'merge', name: 'rebase', result: 'rebased',
    actor: 'agent', pin: spine.computePin(repo) });

  assert.strictEqual(rebase.standingFailures(p, 'TRK-10'), 2, 'a forged receipt cleared the hard gate');
  assert.throws(() => rebase.rebaseCard(p, 'greenhouse/TRK-10', {}), /hard gate/);
});

test('a human who finishes the rebase by hand clears the count; aborting it does not', () => {
  const { p, repo, origin } = card({ file: 'a.txt', branchContent: 'branch edit\n' });
  moveMain(origin, 'main edit\n');
  rebase.rebaseCard(p, 'greenhouse/TRK-10', {});
  const head = () => git(repo, 'rev-parse', 'HEAD').trim();

  // Abort: HEAD returns to exactly where it was, so the conflict still stands.
  git(repo, 'rebase', '--abort');
  assert.strictEqual(rebase.standingFailures(p, 'TRK-10', head()), 1, 'aborting cleared a conflict that still stands');

  // Resolve by hand instead.
  rebase.rebaseCard(p, 'greenhouse/TRK-10', {});
  fs.writeFileSync(path.join(repo, 'a.txt'), 'resolved by hand\n');
  git(repo, 'add', 'a.txt');
  execFileSync('git', ['-C', repo, 'rebase', '--continue'], { env: { ...process.env, GIT_EDITOR: 'true' } });
  assert.strictEqual(rebase.standingFailures(p, 'TRK-10', head()), 0,
    'a conflict a human already resolved still blocks the next rebase');
});

test('a rebase that succeeds clears the standing failure count', () => {
  const { p, repo, origin } = card({ file: 'a.txt', branchContent: 'branch edit\n' });
  const mover = moveMain(origin, 'main edit\n');
  rebase.rebaseCard(p, 'greenhouse/TRK-10', {});
  assert.strictEqual(rebase.standingFailures(p, 'TRK-10'), 1);
  git(repo, 'rebase', '--abort');

  // Resolve the collision at the source: main and the branch now agree on a.txt.
  fs.writeFileSync(path.join(mover, 'a.txt'), 'branch edit\n');
  git(mover, 'commit', '-qam', 'main matches the branch');
  git(mover, 'push', '-q', 'origin', 'main');

  const ok = rebase.rebaseCard(p, 'greenhouse/TRK-10', {});
  assert.strictEqual(ok.ok, true, ok.message);
  assert.strictEqual(rebase.standingFailures(p, 'TRK-10'), 0, 'a success left the failure count standing');
});

// ---- CLI wiring ------------------------------------------------------------

test('the registry discovers `plt card` from lib/rebase.js alone', () => {
  const cmds = registry.discoverCommands(path.join(__dirname, '..', 'lib'));
  assert.ok(cmds.has('card'), 'plt card is not registered');
  assert.match(cmds.get('card').usage, /plt card rebase <effort>\/<n>/);
});

test('plt card with no subcommand prints the usage and exits 2', () => {
  const before = process.env.PLT_PROCESS_DIR;
  const errs = [];
  const w = process.stderr.write;
  process.stderr.write = (t) => { errs.push(String(t)); return true; };
  try {
    assert.strictEqual(rebase.cardHandler([], {}), 2);
  } finally { process.stderr.write = w; if (before === undefined) delete process.env.PLT_PROCESS_DIR; }
  assert.match(errs.join(''), /plt card rebase/);
});

test('--json before the target does not eat it', () => {
  const { p, origin } = card();
  moveMain(origin, 'main moved\n');
  const outs = [];
  const w = process.stdout.write;
  process.stdout.write = (t) => { outs.push(String(t)); return true; };
  let code;
  try { code = rebase.cardHandler(['rebase', '--json', 'greenhouse/TRK-10'], { env: { PLT_PROCESS_DIR: p } }); }
  finally { process.stdout.write = w; }
  assert.strictEqual(code, 0, outs.join(''));
  assert.strictEqual(JSON.parse(outs.join('')).card, 'TRK-10');
});

test('the CLI exits 1 on a conflict and 0 on a clean rebase', () => {
  const { p, repo, origin } = card({ file: 'a.txt', branchContent: 'branch edit\n' });
  moveMain(origin, 'main edit\n');
  const outs = [];
  const w = process.stdout.write;
  process.stdout.write = (t) => { outs.push(String(t)); return true; };
  let code;
  try { code = rebase.cardHandler(['rebase', 'greenhouse/TRK-10'], { cwd: p, env: { PLT_PROCESS_DIR: p } }); }
  finally { process.stdout.write = w; }
  assert.strictEqual(code, 1);
  assert.match(outs.join(''), /next: plt card rebase greenhouse\/TRK-10/);
  git(repo, 'rebase', '--abort');
});
