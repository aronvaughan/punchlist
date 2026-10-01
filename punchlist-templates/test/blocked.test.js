'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const spine = require('../lib/spine');
const blocked = require('../lib/blocked');
const FIX = path.join(__dirname, 'fixtures', 'spine');

function tmpProcess() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blocked-'));
  fs.cpSync(FIX, path.join(root, 'process'), { recursive: true });
  return path.join(root, 'process');
}
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  execFileSync('git', ['-C', dir, 'add', 'a.txt']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'init']);
  return dir;
}
// A run whose `scope` step is in_progress and current.
function startedRun() {
  const p = tmpProcess();
  spine.launchRun(p, { runId: 'TRK-7', cycle: 'build-and-ship', repoDir: tmpRepo(), owner: 'lead' });
  spine.stepStart(p, 'TRK-7', 'scope', { session: 's1' });
  return p;
}
// Moves a step to in_review with current_step released — the shape stepFinish leaves behind when
// only a human gate is missing.
function toReview(p, stepId) {
  const st = spine.readState(p, 'TRK-7');
  st.steps[stepId].status = 'in_review';
  if (st.current_step === stepId) st.current_step = null;
  spine.writeState(p, 'TRK-7', st);
}

test('stepBlock: an in_progress step becomes blocked and the question lands in the ledger', () => {
  const p = startedRun();
  const st = blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'which bench gets the seedlings?' });
  assert.strictEqual(st.steps.scope.status, 'blocked');
  assert.strictEqual(spine.readState(p, 'TRK-7').steps.scope.status, 'blocked');
  const q = spine.readEvents(p, 'TRK-7').filter((e) => e.kind === 'question');
  assert.strictEqual(q.length, 1);
  assert.strictEqual(q[0].step, 'scope');
  assert.strictEqual(q[0].text, 'which bench gets the seedlings?');
  assert.strictEqual(q[0].actor, 'agent');
  assert.strictEqual(q[0].by, undefined);
  assert.strictEqual(q[0].from, 'in_progress');
});

test('stepBlock: the blocked step renders as BLOCKED in the menu', () => {
  const p = startedRun();
  const st = blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'q?' });
  assert.strictEqual(spine.menuFor(st, spine.readEvents(p, 'TRK-7')).mode, 'BLOCKED');
});

test('stepBlock: a pending step is refused in the stepFinish message shape, and nothing is written', () => {
  const p = startedRun();
  assert.throws(() => blocked.stepBlock(p, 'TRK-7', 'build', { question: 'q?' }),
    /^Error: step build is pending; only in_progress or in_review can be blocked$/);
  assert.strictEqual(spine.readState(p, 'TRK-7').steps.build.status, 'pending');
  assert.strictEqual(spine.readEvents(p, 'TRK-7').some((e) => e.kind === 'question'), false);
});

test('stepBlock: an unknown step and an empty question are refused', () => {
  const p = startedRun();
  assert.throws(() => blocked.stepBlock(p, 'TRK-7', 'nope', { question: 'q?' }), /no step nope/);
  assert.throws(() => blocked.stepBlock(p, 'TRK-7', 'scope', { question: '  ' }), /needs a question/);
  assert.throws(() => blocked.stepBlock(p, 'TRK-7', 'scope', {}), /needs a question/);
});

test('stepAnswer: the step returns to in_progress and the answer lands in the ledger', () => {
  const p = startedRun();
  blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'which bench?' });
  const st = blocked.stepAnswer(p, 'TRK-7', 'scope', { answer: 'bench 3', by: 'human:lead' });
  assert.strictEqual(st.steps.scope.status, 'in_progress');
  assert.strictEqual(st.current_step, 'scope');
  assert.strictEqual(spine.readState(p, 'TRK-7').steps.scope.status, 'in_progress');
  const evs = spine.readEvents(p, 'TRK-7');
  const q = evs.find((e) => e.kind === 'question');
  const a = evs.find((e) => e.kind === 'answer');
  assert.strictEqual(a.step, 'scope');
  assert.strictEqual(a.text, 'bench 3');
  assert.strictEqual(a.question, q.id);
  assert.strictEqual(a.actor, 'human');
  assert.strictEqual(a.by, 'lead');                                   // the human: prefix is stripped once
});

test('stepAnswer: an in_review step goes back to in_review and releases the current_step it took', () => {
  const p = startedRun();
  toReview(p, 'scope');
  const b = blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'q?' });
  assert.strictEqual(b.current_step, 'scope');                        // held while blocked, so prime shows BLOCKED
  const st = blocked.stepAnswer(p, 'TRK-7', 'scope', { answer: 'a', by: 'lead' });
  assert.strictEqual(st.steps.scope.status, 'in_review');
  assert.strictEqual(st.current_step, null);
});

test('stepAnswer: a step that is not blocked is refused, and nothing is written', () => {
  const p = startedRun();
  assert.throws(() => blocked.stepAnswer(p, 'TRK-7', 'scope', { answer: 'a', by: 'lead' }),
    /^Error: step scope is in_progress; only blocked can be answered$/);
  assert.strictEqual(spine.readEvents(p, 'TRK-7').some((e) => e.kind === 'answer'), false);
});

test('stepAnswer: an empty answer is refused', () => {
  const p = startedRun();
  blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'q?' });
  assert.throws(() => blocked.stepAnswer(p, 'TRK-7', 'scope', { answer: '', by: 'lead' }), /needs an answer/);
  assert.strictEqual(spine.readState(p, 'TRK-7').steps.scope.status, 'blocked');
});

test('stepAnswer: a second block after an answer restores from the latest question', () => {
  const p = startedRun();
  blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'one?' });
  blocked.stepAnswer(p, 'TRK-7', 'scope', { answer: 'one', by: 'lead' });
  toReview(p, 'scope');
  blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'two?' });
  const st = blocked.stepAnswer(p, 'TRK-7', 'scope', { answer: 'two', by: 'lead' });
  assert.strictEqual(st.steps.scope.status, 'in_review');
});

test('actor is recorded from --by: a person is human, no person or bare agent is agent', () => {
  const p = startedRun();
  blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'q?', by: 'agent' });
  blocked.stepAnswer(p, 'TRK-7', 'scope', { answer: 'a', by: 'lead' });
  blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'q2?', by: 'lead' });
  blocked.stepAnswer(p, 'TRK-7', 'scope', { answer: 'b', by: 'human:lead' });
  const evs = spine.readEvents(p, 'TRK-7').filter((e) => e.kind === 'question' || e.kind === 'answer');
  assert.deepStrictEqual(evs.map((e) => [e.kind, e.actor, e.by]), [
    ['question', 'agent', undefined], ['answer', 'human', 'lead'],
    ['question', 'human', 'lead'], ['answer', 'human', 'lead']]);
});

// A run whose owner_window is w1: stepStart claims the run for the window that starts it.
function ownedRun() {
  const p = tmpProcess();
  spine.launchRun(p, { runId: 'TRK-7', cycle: 'build-and-ship', repoDir: tmpRepo(), owner: 'lead' });
  spine.stepStart(p, 'TRK-7', 'scope', { session: 's1', window: 'w1' });
  assert.strictEqual(spine.readState(p, 'TRK-7').owner_window, 'w1');
  return p;
}

test('window guard: a foreign window is refused for block and answer, and nothing is written', () => {
  const p = ownedRun();
  assert.throws(() => blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'q?', window: 'w2' }),
    /^Error: run TRK-7 is driven by window w1; hand off first \(or --take-over\)$/);
  assert.strictEqual(spine.readState(p, 'TRK-7').steps.scope.status, 'in_progress');
  blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'q?', window: 'w1' });
  const n = spine.readEvents(p, 'TRK-7').length;
  assert.throws(() => blocked.stepAnswer(p, 'TRK-7', 'scope', { answer: 'a', by: 'lead', window: 'w2' }), /driven by window w1/);
  assert.strictEqual(spine.readEvents(p, 'TRK-7').length, n);
  assert.strictEqual(spine.readState(p, 'TRK-7').steps.scope.status, 'blocked');
});

test('window guard: a caller with no window passes, as it does in spine', () => {
  const p = ownedRun();
  blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'q?', window: null });
  const st = blocked.stepAnswer(p, 'TRK-7', 'scope', { answer: 'a', by: 'lead', window: null });
  assert.strictEqual(st.steps.scope.status, 'in_progress');
});

test('repo guard: a window that does not hold the run\'s repo is refused', () => {
  const p = startedRun();
  spine.claimRepo(spine.readState(p, 'TRK-7').repo_dir, 'w1');
  assert.throws(() => blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'q?', window: 'w2' }), /is being driven by window w1/);
  blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'q?', window: 'w1' });
  assert.throws(() => blocked.stepAnswer(p, 'TRK-7', 'scope', { answer: 'a', by: 'lead', window: 'w2' }), /is being driven by window w1/);
});

// ---- CLI ---------------------------------------------------------------------

function cli(name, argv, p, extraEnv = {}) {
  const out = []; const err = [];
  const w = process.stdout.write; const e = process.stderr.write;
  process.stdout.write = (t) => { out.push(String(t)); return true; };
  process.stderr.write = (t) => { err.push(String(t)); return true; };
  let code;
  try { code = blocked.commands.find((c) => c.name === name).handler(argv, { cwd: p, env: { PLT_PROCESS_DIR: p, ...extraEnv } }); }
  finally { process.stdout.write = w; process.stderr.write = e; }
  return { code, out: out.join(''), err: err.join('') };
}

test('commands: block and answer are registered verbs', () => {
  assert.deepStrictEqual(blocked.commands.map((c) => c.name), ['block', 'answer']);
  const names = require('../lib/registry').discoverCommands(path.join(__dirname, '..', 'lib'));
  assert.ok(names.has('block') && names.has('answer'));
});

test('plt block <run> --question defaults to the current step; plt answer <run> --text finds the blocked step', () => {
  const p = startedRun();
  const b = cli('block', ['TRK-7', '--question', 'which bench?'], p);
  assert.strictEqual(b.code, 0, b.err);
  assert.strictEqual(JSON.parse(b.out).steps.scope.status, 'blocked');
  const a = cli('answer', ['TRK-7', '--text', 'bench 3', '--by', 'human:lead'], p);
  assert.strictEqual(a.code, 0, a.err);
  assert.strictEqual(JSON.parse(a.out).steps.scope.status, 'in_progress');
});

test('plt block with no question, or no run, prints usage and exits 2', () => {
  const p = startedRun();
  assert.strictEqual(cli('block', ['TRK-7'], p).code, 2);
  assert.strictEqual(cli('answer', ['--text', 'x'], p).code, 2);
});

test('plt block / answer on a refused step exits 1 with the refusal on stderr', () => {
  const p = startedRun();
  const r = cli('answer', ['TRK-7', 'scope', '--text', 'x', '--by', 'lead'], p);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /only blocked can be answered/);
});

test('plt block from a foreign PLT_WINDOW exits 1 with the window refusal', () => {
  const p = ownedRun();
  const r = cli('block', ['TRK-7', '--question', 'q?'], p, { PLT_WINDOW: 'w2' });
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /driven by window w1; hand off first/);
  assert.strictEqual(cli('block', ['TRK-7', '--question', 'q?'], p, { PLT_WINDOW: 'w1' }).code, 0);
});

// ---- plan 4 Task 7: an answer comes from a person; the spine's guards; what the question says ----

test('stepAnswer: an answer needs --by naming a person, and one on config.actors.humans when the list exists', () => {
  const p = startedRun();
  blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'which bench?' });
  const n = spine.readEvents(p, 'TRK-7').length;
  assert.throws(() => blocked.stepAnswer(p, 'TRK-7', 'scope', { answer: 'bench 3' }), /answer needs --by <person>/);
  assert.throws(() => blocked.stepAnswer(p, 'TRK-7', 'scope', { answer: 'bench 3', by: 'agent' }), /answer needs --by <person>/);
  fs.writeFileSync(path.join(p, 'config', 'zz-humans.yaml'), 'actors:\n  humans: [lead]\n');
  assert.throws(() => blocked.stepAnswer(p, 'TRK-7', 'scope', { answer: 'bench 3', by: 'human:intern' }), /not a human in config.actors.humans/);
  assert.strictEqual(spine.readEvents(p, 'TRK-7').length, n, 'a refused answer writes nothing');
  assert.strictEqual(blocked.stepAnswer(p, 'TRK-7', 'scope', { answer: 'bench 3', by: 'human:lead' }).steps.scope.status, 'in_progress');
});

test('--take-over: a foreign window may block and answer by moving the claim, as every spine writer allows', () => {
  const p = ownedRun();
  const st = blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'q?', window: 'w2', takeOver: true });
  assert.strictEqual(st.steps.scope.status, 'blocked');
  assert.strictEqual(spine.readState(p, 'TRK-7').owner_window, 'w2');
  assert.ok(spine.readEvents(p, 'TRK-7').some((e) => e.what === 'taken-over' && e.window === 'w2'));
  assert.strictEqual(cli('answer', ['TRK-7', '--text', 'a', '--by', 'lead', '--take-over'], p, { PLT_WINDOW: 'w3' }).code, 0);
});

test('prime and the run page print the question a blocked step is waiting on', () => {
  const p = startedRun();
  blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'which bench gets the seedlings?' });
  assert.match(spine.renderPrime(p, 'TRK-7'), /blocked on a question: which bench gets the seedlings\?/);
  const render = require('../lib/render');
  const cfg = spine.loadConfig(p);
  assert.ok(render.renderRun(p, 'TRK-7', cfg).includes('which bench gets the seedlings?'));
  assert.ok(render.renderIndex(p, cfg).includes('answer the question on scope: which bench gets the seedlings?'));
});

test('a blocked in_review step shows BLOCKED even while another step is current', () => {
  const p = startedRun();
  toReview(p, 'scope');
  const st = spine.readState(p, 'TRK-7');
  st.steps.build.status = 'ready';
  spine.writeState(p, 'TRK-7', st);
  spine.stepStart(p, 'TRK-7', 'build');
  blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'is the rename in scope?' });
  const after = spine.readState(p, 'TRK-7');
  assert.strictEqual(after.current_step, 'build');
  assert.strictEqual(spine.menuFor(after, spine.readEvents(p, 'TRK-7')).mode, 'BLOCKED');
  assert.match(spine.renderPrime(p, 'TRK-7'), /▶ TRK-7 · scope · blocked on a question: is the rename in scope\?/);
  const render = require('../lib/render');
  assert.match(render.renderIndex(p, spine.loadConfig(p)), /answer the question on scope/);
});

test('plt step block / plt step answer route to the same writers as plt block / plt answer', () => {
  const p = startedRun();
  const PLT = path.join(__dirname, '..', 'bin', 'plt');
  const env = { ...process.env, PLT_PROCESS_DIR: p };
  delete env.PLT_WINDOW;
  const b = require('child_process').spawnSync('node', [PLT, 'step', 'block', 'scope', '--run', 'TRK-7', '--question', 'which bench?'], { encoding: 'utf8', env });
  assert.strictEqual(b.status, 0, b.stderr);
  assert.strictEqual(spine.readState(p, 'TRK-7').steps.scope.status, 'blocked');
  const a = require('child_process').spawnSync('node', [PLT, 'step', 'answer', 'scope', '--run', 'TRK-7', '--text', 'bench 3', '--by', 'human:lead'], { encoding: 'utf8', env });
  assert.strictEqual(a.status, 0, a.stderr);
  assert.strictEqual(spine.readState(p, 'TRK-7').steps.scope.status, 'in_progress');
});

// ---- final review F-2: the BLOCKED menu prints an answer command that works ----

test('the BLOCKED menu prints plt answer with --by: the run owner when known, else <you>; the printed command succeeds', () => {
  const p = startedRun();   // owner: lead
  blocked.stepBlock(p, 'TRK-7', 'scope', { question: 'which bench?' });
  const answer = spine.menuFor(spine.readState(p, 'TRK-7'), spine.readEvents(p, 'TRK-7')).phrases.find((f) => f.id === 'answer');
  assert.strictEqual(answer.command, 'plt answer {run} --text {payload} --by human:lead');
  // Fill the placeholders the way the agent does, and run it.
  const argv = answer.command.replace('{run}', 'TRK-7').replace(/^plt answer /, '').split(' ').map((a) => (a === '{payload}' ? 'bench 3' : a));
  const r = cli('answer', argv, p);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(spine.readState(p, 'TRK-7').steps.scope.status, 'in_progress');
  // No owner on record: a literal <you> the human replaces.
  const st = spine.readState(p, 'TRK-7'); st.owner = null; st.steps.scope.status = 'blocked';
  assert.match(spine.menuFor(st, []).phrases.find((f) => f.id === 'answer').command, /--by human:<you>$/);
});
