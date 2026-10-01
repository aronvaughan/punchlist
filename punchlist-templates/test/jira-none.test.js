'use strict';
// `jira.kind: none` — a project with no tracker must not be asked for tracker receipts.
// The failure each test names is the quiet one: a card that cannot finish a step without
// recording something untrue, which is how a receipt stops meaning evidence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const spine = require('../lib/spine');

const STEP = { id: 'scope', skills: 'x', jira: { on_start: 'In Progress', on_done: 'Done' } };
const TRACKED = { jira: { kind: 'jira', status: { in_progress: 'In Progress', done: 'Done' } }, skills: { scope: 'x' } };
const NONE = { jira: { kind: 'none', status: { in_progress: 'In Progress', done: 'Done' } }, skills: { scope: 'x' } };
const kinds = (reqs) => reqs.map((r) => r.kind);

test('a project with a tracker still gets its jira requirements', () => {
  // The guard must be narrow: this is the behaviour every tracked project depends on.
  const reqs = spine.compileRequirements(STEP, TRACKED);
  assert.deepEqual(reqs.filter((r) => r.kind === 'jira').map((r) => r.name), ['on_start:In Progress', 'on_done:Done']);
});

test('jira.kind none drops the requirement entirely, not just its name', () => {
  // Before this, punchlist — which declares `kind: none` — still had to record
  // `on_start:In Progress` on every card's scope step, naming a transition in a tracker it
  // does not have.
  const reqs = spine.compileRequirements(STEP, NONE);
  assert.equal(reqs.filter((r) => r.kind === 'jira').length, 0);
  assert.ok(!kinds(reqs).includes('jira'));
});

test('dropping jira leaves every other requirement untouched', () => {
  // A guard placed one line up would have taken the skill requirement with it.
  const reqs = spine.compileRequirements(STEP, NONE);
  assert.deepEqual(reqs, [{ kind: 'skill', name: 'x' }]);
});

test('a missing or partial jira config is treated as tracked, not as off', () => {
  // `none` is an explicit statement. Inferring "off" from an absent config would silently
  // disarm the receipt for a project that simply has not written its jira block yet.
  for (const cfg of [{ skills: { scope: 'x' } }, { jira: {}, skills: { scope: 'x' } }, { jira: { kind: 'jira' }, skills: { scope: 'x' } }]) {
    const reqs = spine.compileRequirements(STEP, cfg);
    assert.ok(kinds(reqs).includes('jira'), `absent/partial jira config must not disarm the receipt: ${JSON.stringify(cfg)}`);
  }
});

test('a step with no jira block is unaffected either way', () => {
  const plain = { id: 'build', skills: 'x' };
  assert.deepEqual(spine.compileRequirements(plain, NONE), spine.compileRequirements(plain, TRACKED));
});
