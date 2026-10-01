'use strict';
// An EFFORT run: the `kind: effort` formula launched and driven the way a card run is.
//
// The gap this closes, stated plainly because it cost a day. T2 shipped the effort cycle as a
// FORMULA and T1 shipped the effort ledger — `appendEffortEvent`, `gateEpoch`,
// `decisionsThisEpoch` — but nothing could launch that formula, because there was no effort-level
// STATE. On 2026-09-30 nine cards were closed with `--landed`: their work was built, reviewed,
// fixed and approved while their run ledgers sat at `scope: ready`, because nothing drove the
// steps. A cycle nothing executes is a document.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const er = require('../lib/effort-run');
const ee = require('../lib/effort-events');

const FIX = path.join(__dirname, 'fixtures', 'spine');
const CORE = path.resolve(__dirname, '..', 'workflows', 'packs', 'core');

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-effrun-'));
  fs.cpSync(FIX, path.join(root, 'process'), { recursive: true });
  const p = path.join(root, 'process');
  // The REAL shipped effort pack, as a project cycle — a fixture copy would let the two drift and
  // this test would then pass against a cycle nobody ships.
  fs.mkdirSync(path.join(p, 'cycles'), { recursive: true });
  fs.copyFileSync(path.join(CORE, 'effort.md'), path.join(p, 'cycles', 'effort.md'));
  fs.mkdirSync(path.join(p, 'efforts'), { recursive: true });
  fs.writeFileSync(path.join(p, 'efforts', 'e.yaml'),
    'slug: e\ntitle: t\ncards:\n  - { id: TRK-1, title: one, touches: [lib/a.js] }\n');
  return p;
}

// Records whatever a step's compiled requirements name, so a walk test closes a gate the way a
// real run does. Before the rewrite nothing recorded receipts and nothing checked them, so every
// one of these walks sailed past `plan`'s effort-plan artifact and `roll-up`'s adversarial agent.
// The helper exists so that stays visible: a test that wants the gates satisfied says so.
function satisfy(p, slug, stepId) {
  const st = er.readEffortState(p, slug);
  for (const r of st.steps[stepId].receipts_required || []) {
    er.recordEffortReceipt(p, slug, stepId, { kind: r.kind, name: r.name, by: 'brain' });
  }
}

// start -> satisfy -> finish, the ordinary path.
function step(p, slug, id, outcome, by = 'brain') {
  er.startStep(p, slug, id, { by });
  satisfy(p, slug, id);
  return er.finishStep(p, slug, id, { outcome, by });
}

test('an effort launches its formula, and only the entry step is ready', () => {
  const st = er.launchEffort(project(), 'e', { cycle: 'effort', owner: 'aron' });
  assert.equal(st.effort, 'e');
  assert.equal(st.cycle, 'effort');
  assert.equal(st.status, 'open');
  assert.equal(st.steps.open.status, 'ready', '`open` needs nothing, so it is the entry');
  for (const id of ['plan', 'dispatch', 'steward', 'roll-up', 'review', 'next-wave', 'close']) {
    assert.equal(st.steps[id].status, 'pending', `${id} waits on what it needs`);
  }
  assert.equal(st.steps.park.status, 'pending', 'an else_of is never an entry step');
});

test('the state lives beside the effort ledger, not in runs/', () => {
  // `process/runs/<id>` is a CARD's directory. An effort is not a card, and putting its state
  // there would make `plt runs` and every card-shaped reader see a run that has no branch, no
  // worktree and no pin.
  const p = project();
  er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
  assert.ok(fs.existsSync(path.join(p, 'efforts', 'e', 'state.yaml')));
  assert.equal(fs.existsSync(path.join(p, 'runs', 'e')), false, 'an effort is not a run directory');
});

test('launching writes NO epoch event — epoch 0 means zero gates closed', () => {
  // I wrote the opposite first, and the test agreed with me rather than with the contract.
  // `gateEpoch` is the COUNT of closed gates (effort-events.js:271), so an epoch event at launch
  // claims a gate closed when none has: every first-wave decision would record epoch 1, and the
  // first real gate would roll up an empty list of decisions to review. A test that encodes the
  // author's misunderstanding passes and proves nothing.
  //
  // What tells a launched effort from an unlaunched one is the STATE, not the ledger.
  const p = project();
  assert.equal(er.readEffortState(p, 'e'), null, 'unlaunched: no state');
  er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
  assert.ok(er.readEffortState(p, 'e'), 'launched: state exists — this is the distinction');
  assert.equal(ee.gateEpoch(p, 'e'), 0, 'and zero gates have closed');
  assert.deepEqual(ee.readEffortEvents(p, 'e').filter((e) => e.kind === 'epoch'), []);
});

test('an effort cannot be launched twice — a reset is not an accident', () => {
  const p = project();
  er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
  assert.throws(() => er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' }), /already launched/);
  assert.deepEqual(ee.readEffortEvents(p, 'e'), [], 'and the second attempt writes nothing — launch appends no event at all');
});

test('a formula that is not kind: effort is refused by name', () => {
  // Launching `build-and-ship` as an effort would compile a card's steps into effort state and
  // fail much later, somewhere that does not name the cause.
  const p = project();
  fs.copyFileSync(path.join(CORE, 'build-and-ship.md'), path.join(p, 'cycles', 'build-and-ship.md'));
  assert.throws(() => er.launchEffort(p, 'e', { cycle: 'build-and-ship', owner: 'aron' }),
    /kind: effort/);
});

test('steps advance the way a card run does — start, finish, and the next step readies', () => {
  const p = project();
  er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
  er.startStep(p, 'e', 'open', { by: 'brain' });
  assert.equal(er.readEffortState(p, 'e').steps.open.status, 'in_progress');
  satisfy(p, 'e', 'open');
  const st = er.finishStep(p, 'e', 'open', { outcome: 'opened', by: 'brain' });
  assert.equal(st.steps.open.status, 'done');
  assert.equal(st.steps.open.outcome, 'opened');
  assert.equal(st.steps.plan.status, 'ready', 'plan needs open, which is now done');
  assert.equal(st.steps.dispatch.status, 'pending', 'dispatch waits on plan');
});

test('an outcome the step does not declare is refused', () => {
  const p = project();
  er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
  er.startStep(p, 'e', 'open', { by: 'brain' });
  assert.throws(() => er.finishStep(p, 'e', 'open', { outcome: 'finished', by: 'brain' }), /outcome/);
});

test('a `when` that does not match leaves the step pending, and its else_of readies', () => {
  // `park` is review's else_of: an effort the owner parks leaves the loop rather than sitting in
  // steward with nobody stewarding it.
  const p = project();
  er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
  for (const [id, outcome] of [['open', 'opened'], ['plan', 'planned'], ['dispatch', 'dispatched'],
                               ['steward', 'wave_done'], ['roll-up', 'ready']]) {
    er.startStep(p, 'e', id, { by: 'brain' });
    satisfy(p, 'e', id);
    er.finishStep(p, 'e', id, { outcome, by: 'brain' });
  }
  er.startStep(p, 'e', 'review', { by: 'aron' });
  satisfy(p, 'e', 'review');
  const st = er.finishStep(p, 'e', 'review', { outcome: 'park', by: 'aron' });
  assert.equal(st.steps['next-wave'].status, 'pending', 'next-wave needed outcome continue');
  assert.equal(st.steps.park.status, 'ready', 'the else_of takes over');
});

test('closing the human gate increments the epoch — the authority boundary actually moves', () => {
  // D3: the brain may decide anything spine-gate would not deny, and its authority resets at each
  // human gate. If closing `review` does not increment, a wrong autonomous call travels forever.
  const p = project();
  er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
  for (const [id, outcome] of [['open', 'opened'], ['plan', 'planned'], ['dispatch', 'dispatched'],
                               ['steward', 'wave_done'], ['roll-up', 'ready']]) {
    er.startStep(p, 'e', id, { by: 'brain' });
    satisfy(p, 'e', id);
    er.finishStep(p, 'e', id, { outcome, by: 'brain' });
  }
  ee.appendEffortEvent(p, 'e', { kind: 'decision', who: 'brain', ask: 'a1', answer: 'yes', basis: 'reversible' });
  assert.equal(ee.decisionsThisEpoch(p, 'e').length, 1);
  assert.equal(ee.gateEpoch(p, 'e'), 0);

  er.startStep(p, 'e', 'review', { by: 'aron' });
  satisfy(p, 'e', 'review');
  er.finishStep(p, 'e', 'review', { outcome: 'continue', by: 'aron' });

  assert.equal(ee.gateEpoch(p, 'e'), 1, 'the gate closed, so the epoch moved');
  assert.deepEqual(ee.decisionsThisEpoch(p, 'e'), [], 'and last epoch’s decisions no longer count as unreviewed');
  const ep = ee.readEffortEvents(p, 'e').filter((x) => x.kind === 'epoch').pop();
  // The event names the epoch it CLOSED, not the one it opened. `appendEffortEvent` stamps
  // gate_epoch inside the lock at write time, and at that moment the epoch is still 0 — the very
  // line being written is what makes it 1. So an epoch event carrying 0 means "epoch 0 was
  // closed", and gateEpoch, which counts closures, then answers 1. I asserted the opposite first;
  // the ledger's design is the contract and the test was wrong.
  assert.equal(ep.gate_epoch, 0);
  assert.equal(ep.closed_by, 'aron');
  assert.equal((ep.decisions || []).length, 1, 'the epoch event carries what it closed over');
});

test('only a human closes the human gate', () => {
  // The gate exists to bound the brain. A brain that can close it bounds itself.
  const p = project();
  er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
  for (const [id, outcome] of [['open', 'opened'], ['plan', 'planned'], ['dispatch', 'dispatched'],
                               ['steward', 'wave_done'], ['roll-up', 'ready']]) {
    er.startStep(p, 'e', id, { by: 'brain' });
    satisfy(p, 'e', id);
    er.finishStep(p, 'e', id, { outcome, by: 'brain' });
  }
  er.startStep(p, 'e', 'review', { by: 'aron' });
  satisfy(p, 'e', 'review');
  assert.throws(() => er.finishStep(p, 'e', 'review', { outcome: 'continue', by: 'brain' }), /not a person|human|owner/i);
  assert.equal(ee.gateEpoch(p, 'e'), 0, 'and the epoch did not move');
});

test('a repeat_until step re-opens until its terminal outcome', () => {
  const p = project();
  er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
  for (const [id, outcome] of [['open', 'opened'], ['plan', 'planned'], ['dispatch', 'dispatched']]) {
    er.startStep(p, 'e', id, { by: 'brain' });
    satisfy(p, 'e', id);
    er.finishStep(p, 'e', id, { outcome, by: 'brain' });
  }
  er.startStep(p, 'e', 'steward', { by: 'brain' });
  let st = er.finishStep(p, 'e', 'steward', { outcome: 'needs_human', by: 'brain' });
  assert.equal(st.steps.steward.status, 'ready', 'not the terminal outcome, so it comes back');
  assert.equal(st.steps['roll-up'].status, 'pending');
  er.startStep(p, 'e', 'steward', { by: 'brain' });
  st = er.finishStep(p, 'e', 'steward', { outcome: 'wave_done', by: 'brain' });
  assert.equal(st.steps.steward.status, 'done');
  assert.equal(st.steps['roll-up'].status, 'ready');
});

test('nextCommand names the step to run, so a brain is never guessing', () => {
  const p = project();
  er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
  assert.match(er.nextCommand(p, 'e'), /plt effort step start open/);
  er.startStep(p, 'e', 'open', { by: 'brain' });
  assert.match(er.nextCommand(p, 'e'), /plt effort step finish open/);
});

// ========================================================================================
// The five highs an adversarial review found in the first version of this file, each with the
// test that was missing. The pattern across all five: a guard that was present, reported
// nothing, and was therefore trusted.
// ========================================================================================

// HIGH 2 — the authority boundary. The original guard was `by === 'brain'`, one string compare,
// and the test that "proved" it passed because it tested that one string. Every value below closed
// a human gate and moved the epoch. This is the test that had to exist.
test('a human gate refuses EVERY non-person --by, not just the string brain', () => {
  const bypasses = [null, undefined, '', 'brain', 'agent', 'fan', 'gate', 'Brain', 'BRAIN',
    'steward', 'adversary', 42, true, {}, [], 'human:', 'human:agent'];
  for (const by of bypasses) {
    const p = project();
    er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
    for (const [id, outcome] of [['open', 'opened'], ['plan', 'planned'], ['dispatch', 'dispatched'],
      ['steward', 'wave_done'], ['roll-up', 'ready']]) step(p, 'e', id, outcome);
    er.startStep(p, 'e', 'review', { by: 'aron' });
    satisfy(p, 'e', 'review');
    assert.throws(
      () => er.finishStep(p, 'e', 'review', { outcome: 'continue', by }),
      /not a person/,
      `--by ${JSON.stringify(by)} closed a human gate`,
    );
    // and the boundary did NOT move
    assert.equal(ee.gateEpoch(p, 'e'), 0, `--by ${JSON.stringify(by)} moved the epoch`);
  }
});

test('a human gate refuses a person the project does not list', () => {
  const p = project();
  fs.writeFileSync(path.join(p, 'config', 'punchlist.yaml'),
    'actors:\n  humans: [aron]\n', { flag: 'w' });
  er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
  for (const [id, outcome] of [['open', 'opened'], ['plan', 'planned'], ['dispatch', 'dispatched'],
    ['steward', 'wave_done'], ['roll-up', 'ready']]) step(p, 'e', id, outcome);
  er.startStep(p, 'e', 'review', { by: 'aron' });
  satisfy(p, 'e', 'review');
  assert.throws(() => er.finishStep(p, 'e', 'review', { outcome: 'continue', by: 'santa' }),
    /not a human in config/);
  assert.equal(ee.gateEpoch(p, 'e'), 0);
  // the real person still passes it
  assert.doesNotThrow(() => er.finishStep(p, 'e', 'review', { outcome: 'continue', by: 'aron' }));
});

// HIGH 4 — receipts. `roll-up`'s artifact and adversarial agent and `review`'s gate signal were
// compiled into state at launch and never read, so both gates were decorative. The first real
// effort run walked past both.
test('a hard gate refuses to close with a receipt missing', () => {
  const p = project();
  er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
  step(p, 'e', 'open', 'opened');
  // plan requires the effort-plan artifact; record nothing
  er.startStep(p, 'e', 'plan', { by: 'brain' });
  assert.throws(() => er.finishStep(p, 'e', 'plan', { outcome: 'planned', by: 'brain' }),
    /missing receipts: artifact:effort-plan/);
  assert.equal(er.readEffortState(p, 'e').steps.plan.status, 'in_progress', 'the step did not close');
  // record it and the same call succeeds
  er.recordEffortReceipt(p, 'e', 'plan', { kind: 'artifact', name: 'effort-plan' });
  assert.equal(er.finishStep(p, 'e', 'plan', { outcome: 'planned', by: 'brain' }).steps.plan.status, 'done');
});

test('--force closes a gate with the miss ON THE RECORD, not forgotten', () => {
  const p = project();
  er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
  step(p, 'e', 'open', 'opened');
  er.startStep(p, 'e', 'plan', { by: 'brain' });
  er.finishStep(p, 'e', 'plan', { outcome: 'planned', by: 'brain', force: true });
  const blocked = ee.readEffortEvents(p, 'e').filter((x) => x.kind === 'blocked' && x.step === 'plan');
  assert.equal(blocked.length, 1, 'the miss is a ledger line');
  assert.deepEqual(blocked[0].missing, ['artifact:effort-plan']);
});

// HIGH 5 — a corrupt state.yaml used to read as "not launched", so nextCommand said `plt effort
// start` and launchEffort then OVERWROTE it, losing every step while the ledger kept its epochs.
test('a corrupt state.yaml is an error, never an unlaunched effort', () => {
  const p = project();
  er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
  step(p, 'e', 'open', 'opened');
  const f = er.stateFile(p, 'e');
  for (const junk of ['{{{not yaml', 'just a string', '[1,2,3]', 'effort: e\ncycle: effort\n']) {
    fs.writeFileSync(f, junk);
    assert.throws(() => er.readEffortState(p, 'e'), /will not parse|not a mapping|no steps/,
      `${JSON.stringify(junk)} read as an unlaunched effort`);
    assert.throws(() => er.nextCommand(p, 'e'), /will not parse|not a mapping|no steps/);
  }
  // and an ABSENT file still means not launched
  fs.rmSync(f);
  assert.equal(er.readEffortState(p, 'e'), null);
  assert.match(er.nextCommand(p, 'e'), /plt effort start/);
});

// MEDIUM — two stale writers both used to succeed, the second silently erasing the first.
test('a stale write is refused rather than clobbering', () => {
  const p = project();
  er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
  const a = er.readEffortState(p, 'e');
  const b = er.readEffortState(p, 'e');
  a.steps.open.status = 'in_progress';
  er.writeEffortState(p, 'e', a);
  b.steps.open.status = 'skipped';
  assert.throws(() => er.writeEffortState(p, 'e', b), /changed since it was read/);
  assert.equal(er.readEffortState(p, 'e').steps.open.status, 'in_progress', 'the first write stands');
});

// MEDIUM — status never became 'closed', so nextCommand's closed branch was dead code and a
// FINISHED effort printed the same sentence as the dead end. The live run demonstrated it.
test('a terminal step closes the effort, and a stuck run says STUCK', () => {
  const p = project();
  er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
  step(p, 'e', 'open', 'opened');
  // plan -> nothing_to_do reaches stand-down, which is terminal
  er.startStep(p, 'e', 'plan', { by: 'brain' });
  satisfy(p, 'e', 'plan');
  er.finishStep(p, 'e', 'plan', { outcome: 'nothing_to_do', by: 'brain' });
  assert.equal(er.readEffortState(p, 'e').steps['stand-down'].status, 'ready', 'the dead end is gone');
  const st = step(p, 'e', 'stand-down', 'stood_down');
  assert.equal(st.status, 'closed');
  // closed_at_step is derived, not stored — the schema-drift guard refused the duplicate field.
  assert.match(er.nextCommand(p, 'e'), /closed at stand-down/);
  assert.match(er.nextCommand(p, 'e'), /is closed at stand-down \(stood_down\)/);
  assert.doesNotMatch(er.nextCommand(p, 'e'), /no ready step|STUCK/);
});

// MEDIUM — `def` undefined when the formula drops a step a live run still holds.
test('a step state holds but the cycle no longer defines names the drift', () => {
  const p = project();
  er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
  const st = er.readEffortState(p, 'e');
  st.steps['ghost-step'] = { status: 'in_progress', outcome: null, receipts_required: [], started: null, finished: null };
  st.current_step = 'ghost-step';
  er.writeEffortState(p, 'e', st);
  assert.throws(() => er.finishStep(p, 'e', 'ghost-step', { outcome: 'x', by: 'brain' }),
    /in state but not in cycle effort.*the cycle changed under this run/s);
});

// LOW — the repeat round no longer forges a `wave` line claiming a dispatch that never happened.
test('a repeat round does not write a wave event', () => {
  const p = project();
  er.launchEffort(p, 'e', { cycle: 'effort', owner: 'aron' });
  for (const [id, outcome] of [['open', 'opened'], ['plan', 'planned'], ['dispatch', 'dispatched']]) step(p, 'e', id, outcome);
  for (let i = 0; i < 3; i += 1) step(p, 'e', 'steward', 'needs_human');
  const waves = ee.readEffortEvents(p, 'e').filter((x) => x.kind === 'wave' && !x.cards?.length);
  assert.equal(waves.length, 0, 'no empty wave line was forged');
  assert.equal(er.readEffortState(p, 'e').steps.steward.rounds, 3, 'the rounds are counted honestly');
});
