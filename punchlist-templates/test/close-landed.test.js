'use strict';
// `plt run close --landed` — the exit for a run whose work shipped outside its own cycle.
// Each test names the wrong record it prevents, because every one of these produces a
// plausible-looking closed run when it is wrong, and a run that lies about its own gates is
// worse than one that is still open.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const spine = require('../lib/spine');

// A run parked exactly where the three real ones were: the code is on master, the cycle still
// has PR steps that will never run, and close-out is pending behind them.
function parked() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-landed-'));
  fs.mkdirSync(path.join(p, 'config'), { recursive: true });
  fs.mkdirSync(path.join(p, 'runs', 'R'), { recursive: true });
  fs.writeFileSync(path.join(p, 'config', 'defaults.yaml'),
    'gates:\n  human_signals: [artifact-approved]\nmodels:\n  default_model: opus\n');
  fs.writeFileSync(path.join(p, 'runs', 'R', 'state.yaml'), [
    'run: R', 'cycle: build-and-ship', 'status: open', 'owner: aron', 'current_step: null',
    'pin:', '  kind: sha', '  value: abc123', 'steps:',
    '  scope:', '    status: done', '    outcome: ready',
    '  open-pr:', '    status: ready', '    outcome: null',
    '  merge:', '    status: pending', '    outcome: null',
    '  close-out:', '    status: pending', '    outcome: null', '',
  ].join('\n'));
  fs.writeFileSync(path.join(p, 'runs', 'R', 'events.jsonl'), '');
  return p;
}

test('without --landed the guard still holds, and it names the way out', () => {
  // The old message stopped at "finish close-out first", which on a PR cycle with no PR is
  // advice nobody can take — and the only two commands that did work both lied.
  const p = parked();
  assert.throws(() => spine.closeRun(p, 'R', { by: 'aron' }), (e) => {
    assert.match(e.message, /close-out is not done/);
    assert.match(e.message, /--landed <sha> --by <owner> --reason/, 'the error must name the honest exit');
    return true;
  });
});

test('--landed closes the run as done, so a dependent card unblocks', () => {
  // The whole reason this exists. `discard` is honest about the process and wrong about the
  // work: closed_as discarded never satisfies an `after:`, so three merged cards kept
  // blocking the cards built on top of them.
  const p = parked();
  const st = spine.closeRun(p, 'R', { by: 'aron', landed: 'deadbee', reason: 'merged by hand mid-session' });
  assert.equal(st.status, 'closed');
  assert.equal(st.closed_as, 'done');
});

test('a landed close is distinguishable from an earned one, in state AND in the ledger', () => {
  // The failure this prevents is the quiet one: a run that skipped every gate reading, a month
  // later, exactly like a run that passed them.
  const p = parked();
  const st = spine.closeRun(p, 'R', { by: 'aron', landed: 'deadbee', reason: 'fast-forwarded on a PR cycle' });
  assert.equal(st.landed_out_of_band.sha, 'deadbee');
  assert.equal(st.landed_out_of_band.by, 'aron');
  assert.match(st.landed_out_of_band.reason, /fast-forwarded/);
  assert.deepEqual(st.landed_out_of_band.retired.sort(), ['close-out', 'merge', 'open-pr']);

  const ev = fs.readFileSync(path.join(p, 'runs', 'R', 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const closed = ev.find((e) => e.what === 'closed');
  assert.ok(closed, 'the close is an event, not only a state field');
  assert.equal(closed.landed_out_of_band, true);
  assert.equal(closed.landed_sha, 'deadbee');
  assert.match(closed.reason, /fast-forwarded/);
  assert.equal(closed.closed_as, 'done');
});

test('every unrun step is retired, not left looking runnable', () => {
  const p = parked();
  const st = spine.closeRun(p, 'R', { by: 'aron', landed: 'deadbee', reason: 'r' });
  for (const id of ['open-pr', 'merge', 'close-out']) {
    assert.equal(st.steps[id].status, 'skipped', `${id} must not stay ready or pending`);
    assert.equal(st.steps[id].outcome, 'retired');
  }
  assert.equal(st.steps.scope.status, 'done', 'a step that really ran is untouched');
});

test('--landed refuses an agent, and refuses a blank reason', () => {
  // An unattributed landed close is indistinguishable from the real thing, which is the
  // record this whole exit exists to keep honest. Only a person vouches for it.
  assert.throws(() => spine.closeRun(parked(), 'R', { landed: 'abc', reason: 'r' }), /--by <owner>/);
  assert.throws(() => spine.closeRun(parked(), 'R', { by: 'agent', landed: 'abc', reason: 'r' }), /--by <owner>/);
  assert.throws(() => spine.closeRun(parked(), 'R', { by: 'aron', landed: 'abc' }), /--reason/);
  assert.throws(() => spine.closeRun(parked(), 'R', { by: 'aron', landed: 'abc', reason: '   ' }), /--reason/);
});

test('a step still in progress blocks a landed close too', () => {
  // --landed relaxes the close-out guard and nothing else; a claimed step is still someone's
  // work in flight.
  const p = parked();
  const f = path.join(p, 'runs', 'R', 'state.yaml');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('current_step: null', 'current_step: open-pr'));
  assert.throws(() => spine.closeRun(p, 'R', { by: 'aron', landed: 'abc', reason: 'r' }), /still in progress/);
});

test('a landed close writes a state the shipped schema accepts', () => {
  // The state schema forbids unknown top-level keys, and closeRun gained this one without it:
  // every landed run then failed `plt doctor`'s schemas check and fsck's E_STATE_SCHEMA.
  const schemas = require('../lib/schemas');
  const p = parked();
  spine.closeRun(p, 'R', { by: 'aron', landed: 'deadbee', reason: 'merged by hand mid-session' });
  const r = schemas.validateFile('state', path.join(p, 'runs', 'R', 'state.yaml'));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});
