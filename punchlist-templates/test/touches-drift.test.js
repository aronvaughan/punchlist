'use strict';
// checkTouchesDrift — the guard that says "this card changed a file it never declared".
//
// It read `files` off the touches receipt and returned when that was empty. Nothing in the
// codebase has ever written that field: every touches receipt in every run of this project
// carries `files: null`, so the check has never fired on any card since it was written. T17
// spent three review rounds keeping a step id so this guard would keep being CALLED. It was
// being called, into a function that returned on its second line.
//
// So every test here asserts the guard actually FIRES. A test that only asserts "no crash"
// would have passed for the whole time it was dead.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const spine = require('../lib/spine');

const FIX = path.join(__dirname, 'fixtures', 'spine');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

// A real git repo: one commit on master, then a branch with NO commits yet. The run is launched
// HERE, so its pin is the base — then the work lands. Getting that order wrong (committing the
// work before launching) makes branchBase equal HEAD and every diff empty, which is a fixture
// that reports "no drift" no matter what the code does.
function repoAtBase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-drift-repo-'));
  git(dir, ['init', '-q', '-b', 'master']);
  git(dir, ['config', 'user.email', 't@t']); git(dir, ['config', 'user.name', 't']);
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'a.js'), 'a\n');
  fs.writeFileSync(path.join(dir, 'docs', 'b.md'), 'b\n');
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'base']);
  git(dir, ['checkout', '-qb', 'work']);
  return dir;
}

function commitChanges(dir, changed) {
  for (const f of changed) fs.writeFileSync(path.join(dir, f), 'changed\n');
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'work']);
}

// A launched run whose inputs declare `touches`, parked at pre-pr with scope done.
function runWith({ touches, changed, receiptFiles }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-drift-'));
  fs.cpSync(FIX, path.join(root, 'process'), { recursive: true });
  const p = path.join(root, 'process');
  const repo = repoAtBase();
  spine.launchRun(p, { runId: 'TRK-80', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  commitChanges(repo, changed);
  fs.writeFileSync(path.join(p, 'runs', 'TRK-80', 'inputs.yaml'),
    `card: TRK-80\neffort: e\nrepo_dir: ${repo}\ntouches:\n${(touches || []).map((t) => `  - ${t}`).join('\n')}\n`);
  const st = spine.readState(p, 'TRK-80');
  for (const id of ['scope', 'build', 'review', 'write-review']) st.steps[id].status = 'done';
  st.steps['pre-pr'].status = 'in_progress';
  st.steps['pre-pr'].receipts_required = [];
  st.current_step = 'pre-pr';
  spine.writeState(p, 'TRK-80', st);
  const pin = spine.computePin(repo);
  spine.appendEvent(p, 'TRK-80', { kind: 'touches', step: 'scope', name: 'declared', actor: 'agent', pin,
    ...(receiptFiles === undefined ? {} : { files: receiptFiles }) });
  return { p, repo, pin };
}

// stepFinish is the real path into settle, which is where checkTouchesDrift is called.
const finishPrePr = (p) => spine.stepFinish(p, 'TRK-80', 'pre-pr', { noExtrapolations: true });

const drifts = (p) => spine.readEvents(p, 'TRK-80')
  .filter((e) => e.kind === 'extrapolation' && e.missing && e.missing.key === 'touches-drift');

test('a file outside the declared list is reported — the guard fires at all', () => {
  // THE test. Before this commit it produced zero findings for every possible input.
  const { p, repo, pin } = runWith({ touches: ['lib/a.js'], changed: ['lib/a.js', 'docs/b.md'] });
  finishPrePr(p);
  const d = drifts(p);
  assert.equal(d.length, 1, 'docs/b.md is outside the declared touches and must be reported');
  assert.match(d[0].assumed, /docs\/b\.md/);
  assert.match(d[0].assumed, /outside declared lib\/a\.js/);
});

test('a card that stayed inside its declared list reports nothing', () => {
  // The other half: a guard that fires on everything is as useless as one that never fires.
  const { p, repo, pin } = runWith({ touches: ['lib/a.js', 'docs/b.md'], changed: ['lib/a.js', 'docs/b.md'] });
  finishPrePr(p);
  assert.deepEqual(drifts(p), []);
});

test('the receipt wins when it carries a list, so a caller can narrow the check', () => {
  const { p, repo, pin } = runWith({ touches: ['lib/a.js', 'docs/b.md'], changed: ['lib/a.js', 'docs/b.md'], receiptFiles: ['lib/a.js'] });
  finishPrePr(p);
  assert.equal(drifts(p).length, 1, 'the narrower receipt list is what is compared against');
});

test('inputs are the fallback, so runs launched before this commit are covered too', () => {
  // `files: null` is exactly what every existing receipt in this project carries.
  const { p, repo, pin } = runWith({ touches: ['lib/a.js'], changed: ['lib/a.js', 'docs/b.md'], receiptFiles: null });
  finishPrePr(p);
  assert.equal(drifts(p).length, 1, 'a null files field must fall back to inputs, not disable the check');
});

test('a card that declared nothing at all is not reported against an empty list', () => {
  // Declaring nothing means "not declared", not "declared: nothing" — reporting every changed
  // file would make the guard noise and get it ignored.
  const { p, repo, pin } = runWith({ touches: [], changed: ['lib/a.js', 'docs/b.md'] });
  finishPrePr(p);
  assert.deepEqual(drifts(p), []);
});

test('recording a touches receipt stamps the declared list onto it', () => {
  // The receipt is the evidence. A bare "declared touches" with no record of WHAT was declared
  // is why the drift check had nothing to read.
  const { p, repo } = runWith({ touches: ['lib/a.js'], changed: ['lib/a.js'] });
  const st = spine.readState(p, 'TRK-80');
  st.steps.scope.status = 'in_progress'; st.current_step = 'scope';
  spine.writeState(p, 'TRK-80', st);
  spine.recordReceipt(p, 'TRK-80', { step: 'scope', kind: 'touches', name: 'declared', pin: spine.computePin(repo), actor: 'agent' });
  const rec = spine.readEvents(p, 'TRK-80').filter((e) => e.kind === 'touches').pop();
  assert.deepEqual(rec.files, ['lib/a.js'], 'the receipt records what was declared, not just that something was');
});

// ---- containment is one-directional ----------------------------------------------------
const effort = require('../lib/effort');

test('a file inside a declared directory is covered', () => {
  assert.equal(effort.coversPath(['lib'], 'lib/a.js'), true);
  assert.equal(effort.coversPath(['lib/sub'], 'lib/sub/deep/a.js'), true);
  assert.equal(effort.coversPath(['lib/a.js'], 'lib/a.js'), true);
});

test('a file OUTSIDE the declaration is not covered, even when it is an ancestor of one', () => {
  // The bug this replaces: touchesOverlap is symmetric, because "do two declarations collide"
  // is a symmetric question. Used for containment it also answers true when the changed path
  // is an ANCESTOR of a declared one — so a change that escaped the declaration read as inside
  // it, and the drift guard under-reported the exact escape it exists to report.
  assert.equal(effort.coversPath(['lib/a.js'], 'lib'), false, 'the ancestor direction must NOT count as inside');
  assert.equal(effort.touchesOverlap(['lib/a.js'], ['lib']), true, 'and that is exactly what the symmetric one says');
  assert.equal(effort.coversPath(['lib'], 'docs/b.md'), false);
  assert.equal(effort.coversPath([], 'lib/a.js'), false);
});

test('containment is segment-wise, not string-prefix', () => {
  // `lib` must not cover `library/x.js`.
  assert.equal(effort.coversPath(['lib'], 'library/x.js'), false);
  assert.equal(effort.coversPath(['lib/a'], 'lib/ab.js'), false);
});

test('the GUARD itself refuses the ancestor direction — not just the predicate in isolation', () => {
  // The three tests above exercise coversPath directly, so they pass whichever predicate the
  // call site uses: they do not discriminate the fix at all, which I found by reverting it and
  // watching nothing fail. This one drives checkTouchesDrift through stepFinish.
  //
  // The shape: a declaration naming a path UNDER a file. `lib/a.js` is then an ancestor of the
  // declared `lib/a.js/x`, so the symmetric check calls the change "inside" a declaration it
  // plainly escaped, and reports nothing.
  const { p, repo, pin } = runWith({ touches: ['lib/a.js/x'], changed: ['lib/a.js'] });
  void repo; void pin;
  finishPrePr(p);
  const d = drifts(p);
  assert.equal(d.length, 1, 'lib/a.js is not inside lib/a.js/x and must be reported as drift');
  assert.match(d[0].assumed, /lib\/a\.js outside declared lib\/a\.js\/x/);
});
