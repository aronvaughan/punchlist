'use strict';
// The advancer's PURE decision function, table-driven.
// decide(wf, run, tasks) -> { run, actions } — no I/O anywhere.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const plt = require(path.join(__dirname, '..', 'bin', 'plt'));
const { decide, initialSteps } = plt;

function wf(steps) { return { name: 'wf', steps }; }
function running(steps) {
  return { run: 'wf-r1', workflow: 'wf', inputs: {}, started: 't', status: 'running', steps };
}
const spawned = (attempts = 1, task_id = 'T') => ({ task_id, status: 'spawned', outcome: null, attempts });
const doneStep = (outcome = 'done') => ({ task_id: 'T', status: 'done', outcome, attempts: 1 });
const spawns = (actions) => actions.filter((a) => a.type === 'spawn').map((a) => a.stepId);
const notifies = (actions) => actions.filter((a) => a.type === 'notify');

// -------------------------------------------------------------- launch shape

test('initialSteps: no-edge steps minus on_fail.then targets', () => {
  const steps = [
    { id: 'research', assignee: 'a' },
    { id: 'decide', assignee: 'a', needs: ['research'] },
    { id: 'order', assignee: 'a', when: { step: 'decide', outcome: 'approved' },
      on_fail: { retry: '2', then: 'escalate' } },
    { id: 'shelve', assignee: 'a', else_of: 'decide' },
    { id: 'escalate', assignee: 'a' },
  ];
  assert.deepStrictEqual(initialSteps(steps).map((s) => s.id), ['research']);
});

// ------------------------------------------------------------ decision table

test('sequence: a completes -> b spawns', () => {
  const w = wf([{ id: 'a', assignee: 'x' }, { id: 'b', assignee: 'x', needs: ['a'] }]);
  const { run, actions } = decide(w, running({ a: spawned() }), { a: { state: 'done' } });
  assert.deepStrictEqual(spawns(actions), ['b']);
  assert.strictEqual(run.steps.a.status, 'done');
  assert.strictEqual(run.steps.a.outcome, 'done');
  assert.strictEqual(run.steps.b.status, 'spawned');
  assert.strictEqual(run.status, 'running');
});

test('open task: nothing happens, run stays running', () => {
  const w = wf([{ id: 'a', assignee: 'x' }, { id: 'b', assignee: 'x', needs: ['a'] }]);
  const { run, actions } = decide(w, running({ a: spawned() }), { a: { state: 'open' } });
  assert.deepStrictEqual(actions, []);
  assert.strictEqual(run.status, 'running');
});

test('no task info this cycle: step is left alone', () => {
  const w = wf([{ id: 'a', assignee: 'x' }]);
  const { run, actions } = decide(w, running({ a: spawned() }), {});
  assert.deepStrictEqual(actions, []);
  assert.strictEqual(run.steps.a.status, 'spawned');
});

test('join: c waits for BOTH a and b', () => {
  const w = wf([
    { id: 'a', assignee: 'x' }, { id: 'b', assignee: 'x' },
    { id: 'c', assignee: 'x', needs: ['a', 'b'] },
  ]);
  const half = decide(w, running({ a: spawned(), b: spawned() }),
    { a: { state: 'done' }, b: { state: 'open' } });
  assert.deepStrictEqual(spawns(half.actions), []);
  const full = decide(w, half.run, { b: { state: 'done' } });
  assert.deepStrictEqual(spawns(full.actions), ['c']);
});

test('if/else: approved outcome takes the when branch only', () => {
  const w = wf([
    { id: 'decide', assignee: 'x', outcomes: ['approved', 'rejected'] },
    { id: 'order', assignee: 'x', when: { step: 'decide', outcome: 'approved' } },
    { id: 'shelve', assignee: 'x', else_of: 'decide' },
  ]);
  const { actions } = decide(w, running({ decide: spawned() }),
    { decide: { state: 'done', checkedOutcomes: ['approved'] } });
  assert.deepStrictEqual(spawns(actions), ['order']);
});

test('if/else: non-matching outcome takes the else branch', () => {
  const w = wf([
    { id: 'decide', assignee: 'x', outcomes: ['approved', 'rejected'] },
    { id: 'order', assignee: 'x', when: { step: 'decide', outcome: 'approved' } },
    { id: 'shelve', assignee: 'x', else_of: 'decide' },
  ]);
  const { run, actions } = decide(w, running({ decide: spawned() }),
    { decide: { state: 'done', checkedOutcomes: ['rejected'] } });
  assert.deepStrictEqual(spawns(actions), ['shelve']);
  assert.strictEqual(run.steps.decide.outcome, 'rejected');
});

test('branch not taken: run completes without spawning the untaken side', () => {
  const w = wf([
    { id: 'decide', assignee: 'x', outcomes: ['approved', 'rejected'] },
    { id: 'order', assignee: 'x', when: { step: 'decide', outcome: 'approved' } },
    { id: 'shelve', assignee: 'x', else_of: 'decide' },
  ]);
  const first = decide(w, running({ decide: spawned() }),
    { decide: { state: 'done', checkedOutcomes: ['rejected'] } });
  const second = decide(w, first.run, { shelve: { state: 'done' } });
  assert.deepStrictEqual(spawns(second.actions), []);
  assert.strictEqual(second.run.status, 'completed');
  assert.strictEqual(second.run.steps.order, undefined);
});

test('repeat_until: non-matching outcome respawns, matching outcome settles', () => {
  const w = wf([
    { id: 'poll', assignee: 'x', outcomes: ['arrived', 'waiting'], repeat_until: 'arrived' },
  ]);
  const again = decide(w, running({ poll: spawned(1) }),
    { poll: { state: 'done', checkedOutcomes: ['waiting'] } });
  assert.deepStrictEqual(again.actions, [{ type: 'spawn', stepId: 'poll', attempt: 2 }]);
  assert.strictEqual(again.run.steps.poll.status, 'spawned');
  assert.strictEqual(again.run.steps.poll.attempts, 2);
  const settled = decide(w, again.run, { poll: { state: 'done', checkedOutcomes: ['arrived'] } });
  assert.deepStrictEqual(spawns(settled.actions), []);
  assert.strictEqual(settled.run.steps.poll.status, 'done');
  assert.strictEqual(settled.run.steps.poll.outcome, 'arrived');
  assert.strictEqual(settled.run.status, 'completed');
});

test('on_fail retry chain: retry x2, then spawn the `then` step', () => {
  const w = wf([
    { id: 'order', assignee: 'x', on_fail: { retry: '2', then: 'escalate' } },
    { id: 'escalate', assignee: 'x' },
  ]);
  // attempt 1 archived -> retry (attempt 2)
  const r1 = decide(w, running({ order: spawned(1) }), { order: { state: 'gone' } });
  assert.deepStrictEqual(r1.actions, [{ type: 'spawn', stepId: 'order', attempt: 2 }]);
  // attempt 2 archived -> retry (attempt 3 — retries exhausted after this)
  const r2 = decide(w, r1.run, { order: { state: 'gone' } });
  assert.deepStrictEqual(r2.actions, [{ type: 'spawn', stepId: 'order', attempt: 3 }]);
  // attempt 3 archived -> hand over to escalate
  const r3 = decide(w, r2.run, { order: { state: 'gone' } });
  assert.deepStrictEqual(spawns(r3.actions), ['escalate']);
  assert.strictEqual(r3.run.steps.order.status, 'failed');
  assert.strictEqual(r3.run.status, 'running');
  // escalate done -> run completes despite the failed step
  const r4 = decide(w, r3.run, { escalate: { state: 'done' } });
  assert.strictEqual(r4.run.status, 'completed');
});

test('failure halt: archived task without on_fail halts the run, notifies once', () => {
  const w = wf([{ id: 'a', assignee: 'x' }, { id: 'b', assignee: 'x', needs: ['a'] }]);
  const r1 = decide(w, running({ a: spawned() }), { a: { state: 'gone' } });
  assert.strictEqual(r1.run.status, 'failed');
  assert.strictEqual(r1.run.steps.a.status, 'failed');
  assert.strictEqual(notifies(r1.actions).length, 1);
  assert.match(notifies(r1.actions)[0].title, /halted: step a failed/);
  assert.strictEqual(r1.run.failure_notified, true);
  assert.deepStrictEqual(spawns(r1.actions), []); // b never spawns
  // a second pass must not notify again
  const r2 = decide(w, r1.run, { a: { state: 'gone' } });
  assert.strictEqual(notifies(r2.actions).length, 0);
});

test('ambiguous outcome: zero or many boxes checked blocks advancement, notifies once', () => {
  const w = wf([
    { id: 'decide', assignee: 'x', outcomes: ['approved', 'rejected'] },
    { id: 'order', assignee: 'x', when: { step: 'decide', outcome: 'approved' } },
    { id: 'shelve', assignee: 'x', else_of: 'decide' },
  ]);
  for (const checked of [[], ['approved', 'rejected']]) {
    const r1 = decide(w, running({ decide: spawned() }),
      { decide: { state: 'done', checkedOutcomes: checked } });
    assert.deepStrictEqual(spawns(r1.actions), [], `no spawn for checked=${checked}`);
    assert.strictEqual(r1.run.steps.decide.status, 'spawned'); // retried next cycle
    const notes = notifies(r1.actions);
    assert.strictEqual(notes.length, 1);
    assert.match(notes[0].title, /ambiguous outcome — check exactly one/);
    // second pass with the same ambiguity: no duplicate notification
    const r2 = decide(w, r1.run, { decide: { state: 'done', checkedOutcomes: checked } });
    assert.strictEqual(notifies(r2.actions).length, 0);
    // ...and once fixed, advancement resumes
    const r3 = decide(w, r2.run, { decide: { state: 'done', checkedOutcomes: ['approved'] } });
    assert.deepStrictEqual(spawns(r3.actions), ['order']);
  }
});

test('step without outcomes records outcome `done`', () => {
  const w = wf([{ id: 'a', assignee: 'x' }]);
  const { run } = decide(w, running({ a: spawned() }), { a: { state: 'done', checkedOutcomes: [] } });
  assert.strictEqual(run.steps.a.outcome, 'done');
  assert.strictEqual(run.status, 'completed');
});

test('when + needs must BOTH hold before spawning', () => {
  const w = wf([
    { id: 'decide', assignee: 'x', outcomes: ['go'] },
    { id: 'prep', assignee: 'x' },
    { id: 'act', assignee: 'x', needs: ['prep'], when: { step: 'decide', outcome: 'go' } },
  ]);
  const r1 = decide(w, running({ decide: spawned(), prep: spawned(1, 'p') }),
    { decide: { state: 'done', checkedOutcomes: ['go'] }, prep: { state: 'open' } });
  assert.deepStrictEqual(spawns(r1.actions), []);
  const r2 = decide(w, r1.run, { prep: { state: 'done' } });
  assert.deepStrictEqual(spawns(r2.actions), ['act']);
});

test('decide never mutates its run-state input', () => {
  const w = wf([{ id: 'a', assignee: 'x' }]);
  const input = running({ a: spawned() });
  const frozen = JSON.stringify(input);
  decide(w, input, { a: { state: 'done' } });
  assert.strictEqual(JSON.stringify(input), frozen);
});
