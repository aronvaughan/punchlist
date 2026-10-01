'use strict';
// `plt run recompile` refreshes the card's own inputs, not only its compiled requirements.
//
// The failure this prevents, from T1: the effort file's `touches` were widened while the card was
// running, the change never reached `runs/<card>/inputs.yaml` because that is a launch-time
// snapshot, and the adversary then reported a change as out-of-scope against a list that had been
// corrected an hour earlier. The card was judged against stale inputs, which is worse than having
// no inputs recorded at all — a wrong list reads as authoritative.
//
// It matters more now than when it was written: checkTouchesDrift reads `readInputs().touches`,
// so a stale snapshot means the drift guard measures against a superseded declaration.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const spine = require('../lib/spine');

const { execFileSync } = require('node:child_process');
const FIX = path.join(__dirname, 'fixtures', 'spine');

// A real repo: launchRun computes a pin, which shells out to git. A path that is not a repo makes
// every test in this file fail for a reason that has nothing to do with what it is testing.
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-recompile-repo-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'master');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'a.js'), 'a\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  return dir;
}

function project({ touches = ['lib/a.js'], title = 'first title', cards } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-recompile-'));
  fs.cpSync(FIX, path.join(root, 'process'), { recursive: true });
  const p = path.join(root, 'process');
  fs.mkdirSync(path.join(p, 'efforts'), { recursive: true });
  const body = cards !== undefined ? cards
    : `  - { id: TRK-40, title: ${title}, cycle: build-and-ship, touches: [${touches.join(', ')}] }\n`;
  fs.writeFileSync(path.join(p, 'efforts', 'e.yaml'), `slug: e\ntitle: t\ncards:\n${body}`);
  const wt = repo();
  spine.launchRun(p, { runId: 'TRK-40', cycle: 'build-and-ship', repoDir: wt, owner: 'lead', estimate: 0.5 });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-40', 'inputs.yaml'),
    ['title: first title', 'card: TRK-40', 'effort: e', 'branch: feat/TRK-40',
     `repo_dir: ${wt}`, 'touches:', '  - lib/a.js', 'merge: auto',
     'window:', '  pane_id: "7"', ''].join('\n'));
  return p;
}
const inputs = (p) => spine.readInputs(p, 'TRK-40');

test('a widened touches list reaches the running card — the T1 story', () => {
  const p = project({ touches: ['lib/a.js', 'lib/b.js', 'test/b.test.js'] });
  assert.deepEqual(inputs(p).touches, ['lib/a.js'], 'the snapshot starts stale, as it does in life');
  spine.recompileRun(p, 'TRK-40');
  assert.deepEqual(inputs(p).touches, ['lib/a.js', 'lib/b.js', 'test/b.test.js']);
});

test('a retitled card gets its new title', () => {
  const p = project({ title: 'a better title' });
  spine.recompileRun(p, 'TRK-40');
  assert.equal(inputs(p).title, 'a better title');
});

test('facts about disk are NOT rewritten — branch, repo_dir and window survive', () => {
  // These describe what exists on disk, not what the effort file wishes were true. Recomputing
  // `branch` from config templates would rename a worktree that is checked out and being worked in.
  const p = project({ touches: ['lib/z.js'] });
  spine.recompileRun(p, 'TRK-40');
  const i = inputs(p);
  assert.equal(i.branch, 'feat/TRK-40');
  assert.match(i.repo_dir, /plt-recompile-repo-/, 'the worktree path on disk is untouched');
  assert.deepEqual(i.window, { pane_id: '7' });
  assert.equal(i.merge, 'auto');
  assert.equal(i.card, 'TRK-40');
  assert.equal(i.effort, 'e');
});

test('a card no longer in the effort keeps its inputs — an empty touches DISABLES the drift guard', () => {
  // The dangerous version of this feature. `checkTouchesDrift` returns early on an empty declared
  // list, so blanking `touches` because the card was dropped from the effort would silently switch
  // the guard off for a card that is still running. Leave the last known declaration standing.
  const p = project({ cards: '  - { id: SOMEONE-ELSE, title: other, cycle: build-and-ship, touches: [lib/x.js] }\n' });
  spine.recompileRun(p, 'TRK-40');
  assert.deepEqual(inputs(p).touches, ['lib/a.js'], 'the last declaration stands rather than being emptied');
  assert.equal(inputs(p).title, 'first title');
});

test('a missing or unreadable effort file does not fail the recompile, and changes no inputs', () => {
  // recompile's first job is the requirements; a card whose effort file was moved or is mid-edit
  // must still be able to refresh those.
  const p = project();
  fs.writeFileSync(path.join(p, 'efforts', 'e.yaml'), 'cards: [unclosed\n');
  const before = inputs(p);
  assert.doesNotThrow(() => spine.recompileRun(p, 'TRK-40'));
  assert.deepEqual(inputs(p), before);
  fs.rmSync(path.join(p, 'efforts', 'e.yaml'));
  assert.doesNotThrow(() => spine.recompileRun(p, 'TRK-40'));
  assert.deepEqual(inputs(p), before);
});

test('a run with no inputs.yaml at all is left alone rather than invented', () => {
  const p = project();
  fs.rmSync(path.join(p, 'runs', 'TRK-40', 'inputs.yaml'));
  assert.doesNotThrow(() => spine.recompileRun(p, 'TRK-40'));
  assert.equal(fs.existsSync(path.join(p, 'runs', 'TRK-40', 'inputs.yaml')), false);
});

test('recompile still does its original job — requirements are refreshed too', () => {
  const p = project();
  const st = spine.recompileRun(p, 'TRK-40');
  assert.ok(Array.isArray(st.steps.scope.receipts_required), 'requirements are still compiled');
});

test('the refresh is recorded, so a reader can tell inputs moved under a running card', () => {
  const p = project({ touches: ['lib/a.js', 'lib/new.js'] });
  spine.recompileRun(p, 'TRK-40');
  const ev = spine.readEvents(p, 'TRK-40').filter((e) => e.what === 'recompiled');
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].inputs_changed, ['touches'], 'it names WHICH inputs moved, not merely that recompile ran');
});
