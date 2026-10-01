'use strict';
// The writer for the `blocked` step state. `blocked` means "a human must answer this": the agent
// stops, the question goes into the run's ledger, and the step waits until someone answers.
//
// stepBlock  — in_progress|in_review → blocked, appends a `question` event.
// stepAnswer — blocked → the status the step held before the block, appends an `answer` event.
//
// Both write only through spine's readState / writeState / appendEvent, so the stale-write guard
// and the run lock apply unchanged. The status to return to is carried on the question event
// (`from`), not on the state, so the state shape does not change.
//
// The step takes current_step only when nothing holds it. Blocking an in_review step while another
// step is in_progress leaves that step current; the menu, prime and the board still show BLOCKED,
// because a blocked step wins over current_step there (spine.blockedStep).
const spine = require('./spine');

const BLOCKABLE = ['in_progress', 'in_review'];

// The guards every spine writer applies, from spine itself: the repo guard first, then the run's
// window guard. A caller with no window passes both; `takeOver` moves the claim and logs it.
function assertCaller(processDir, runId, st, window, takeOver) {
  spine.assertRepo(processDir, runId, st, { window, takeOver });
  spine.assertWindow(processDir, runId, st, { window, takeOver });
}

function nonEmpty(v) { return typeof v === 'string' && v.trim().length > 0; }

function readRun(processDir, runId) {
  const st = spine.readState(processDir, runId);
  if (!st) throw new Error(`no run ${runId} under ${processDir}/runs`);
  return st;
}

// stepBlock(processDir, runId, stepId, {question, by, window, takeOver}) -> state
function stepBlock(processDir, runId, stepId, { question, by, window, takeOver } = {}) {
  let st = readRun(processDir, runId);
  const step = st.steps[stepId];
  if (!step) throw new Error(`no step ${stepId}`);
  if (!BLOCKABLE.includes(step.status)) {
    throw new Error(`step ${stepId} is ${step.status}; only in_progress or in_review can be blocked`);
  }
  if (!nonEmpty(question)) throw new Error('block needs a question');
  assertCaller(processDir, runId, st, window, takeOver);
  st = readRun(processDir, runId);   // a take-over wrote state
  // An in_review step has released current_step (stepFinish does that). The blocked step takes it
  // while it waits, so prime and the menu render BLOCKED; the answer gives it back.
  const takeCurrent = st.current_step == null;
  // Event first, then state. If the state write is refused, the question event is left alone and is
  // inert (stepAnswer reads only the latest question of a blocked step). The other order could
  // leave a blocked step with no question, and stepAnswer could not answer it.
  spine.appendEvent(processDir, runId, { kind: 'question', step: stepId, text: question.trim(), from: step.status,
    took_current: takeCurrent, ...spine.actorFields(by) });
  st.steps[stepId].status = 'blocked';
  if (takeCurrent) st.current_step = stepId;
  spine.writeState(processDir, runId, st);
  return st;
}

// stepAnswer(processDir, runId, stepId, {answer, by, window, takeOver}) -> state
// An answer comes from a person: `by` must name one, and one on config.actors.humans when the
// config has that list (spine's assertHuman, the rule every human gate uses).
function stepAnswer(processDir, runId, stepId, { answer, by, window, takeOver } = {}) {
  let st = readRun(processDir, runId);
  const step = st.steps[stepId];
  if (!step) throw new Error(`no step ${stepId}`);
  if (step.status !== 'blocked') throw new Error(`step ${stepId} is ${step.status}; only blocked can be answered`);
  if (!nonEmpty(answer)) throw new Error('answer needs an answer');
  if (!spine.personOf(by)) throw new Error('answer needs --by <person>; a question is answered by a person');
  spine.assertHuman(processDir, runId, by);
  assertCaller(processDir, runId, st, window, takeOver);
  st = readRun(processDir, runId);   // a take-over wrote state
  const q = spine.readEvents(processDir, runId).filter((e) => e.kind === 'question' && e.step === stepId).pop();
  if (!q || !BLOCKABLE.includes(q.from)) {
    throw new Error(`step ${stepId} is blocked but the ledger holds no question for it — the status to return to is unknown`);
  }
  spine.appendEvent(processDir, runId, { kind: 'answer', step: stepId, text: answer.trim(), question: q.id, ...spine.actorFields(by) });
  st.steps[stepId].status = q.from;
  if (q.took_current && st.current_step === stepId) st.current_step = null;
  spine.writeState(processDir, runId, st);
  return st;
}

// ---- CLI -------------------------------------------------------------------------

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; o[k] = v; }
    else o._.push(argv[i]);
  }
  return o;
}

// The caller's window comes from the handler's env, not process.env, so a test can set it.
function windowFor(ctx) {
  const env = (ctx && ctx.env) || process.env;
  return env.PLT_WINDOW || null;
}

function processDirFor(ctx) {
  const env = (ctx && ctx.env) || process.env;
  const p = env.PLT_PROCESS_DIR || spine.findProcessDir((ctx && ctx.cwd) || process.cwd());
  if (!p) throw new Error('no process/config directory found (set PLT_PROCESS_DIR)');
  return p;
}

const str = (v) => (typeof v === 'string' ? v : undefined);

const BLOCK_USAGE = 'plt block <run> [<step>] --question <text> [--by who] [--take-over]';
const ANSWER_USAGE = 'plt answer <run> [<step>] --text <text> --by <person> [--take-over]';

// The run is positional or --run; the step is positional, --step, or found from the state:
// block takes current_step, answer takes the one blocked step.
function target(o) { return { run: str(o.run) || o._[0], step: str(o.step) || o._[1] }; }

function blockHandler(argv, ctx) {
  const o = parse(argv); const { run, step } = target(o);
  if (!run || !str(o.question)) { process.stderr.write(`usage: ${BLOCK_USAGE}\n`); return 2; }
  try {
    const p = processDirFor(ctx);
    const id = step || readRun(p, run).current_step;
    if (!id) throw new Error(`run ${run} has no current step — name the step to block`);
    process.stdout.write(JSON.stringify(stepBlock(p, run, id, { question: o.question, by: str(o.by), window: windowFor(ctx), takeOver: o['take-over'] === true }), null, 2) + '\n');
    return 0;
  } catch (e) { process.stderr.write(`plt block: ${e.message}\n`); return 1; }
}

function answerHandler(argv, ctx) {
  const o = parse(argv); const { run, step } = target(o);
  const text = str(o.text) || str(o.answer);
  if (!run || !text) { process.stderr.write(`usage: ${ANSWER_USAGE}\n`); return 2; }
  try {
    const p = processDirFor(ctx);
    let id = step;
    if (!id) {
      const waiting = Object.entries(readRun(p, run).steps).filter(([, s]) => s.status === 'blocked').map(([k]) => k);
      if (waiting.length !== 1) throw new Error(`run ${run} has ${waiting.length} blocked steps${waiting.length ? ` (${waiting.join(', ')})` : ''} — name the step to answer`);
      id = waiting[0];
    }
    process.stdout.write(JSON.stringify(stepAnswer(p, run, id, { answer: text, by: str(o.by), window: windowFor(ctx), takeOver: o['take-over'] === true }), null, 2) + '\n');
    return 0;
  } catch (e) { process.stderr.write(`plt answer: ${e.message}\n`); return 1; }
}

const commands = [
  { name: 'block', usage: BLOCK_USAGE, handler: blockHandler },
  { name: 'answer', usage: ANSWER_USAGE, handler: answerHandler },
];

module.exports = { stepBlock, stepAnswer, blockHandler, answerHandler, commands };
