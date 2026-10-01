'use strict';
// effort-run.js — launching and driving a `kind: effort` formula.
//
// WHY THIS EXISTS, because the gap cost a day. T2 shipped the effort cycle as a FORMULA and T1
// shipped the effort ledger (appendEffortEvent, gateEpoch, decisionsThisEpoch). Neither could run
// it: there was no effort-level STATE, so nothing could claim a step, settle it, or know what was
// next. On 2026-09-30 nine cards were closed with `--landed` because their work was built,
// reviewed, fixed and approved while their run ledgers sat at `scope: ready` — nothing drove the
// steps. A cycle nothing executes is a document.
//
// WHAT IT IS NOT. This is not a second spine. Step readiness comes from `spine.entryStepIds` and
// `spine.readyAfter`, the same functions `launchRun` and `settle` use, because this effort found
// four copies of one rule drifting in a single day and readiness is the last place to want a
// fifth. What differs is genuinely different:
//
//   state   `process/efforts/<slug>/state.yaml`, beside the ledger — NOT `process/runs/<id>`,
//           which is a card's directory. An effort has no branch, no worktree and no pin, so a
//           card-shaped reader must never find it there.
//   events  the effort ledger via appendEffortEvent, which stamps `effort` and `gate_epoch` and
//           refuses a caller-supplied envelope.
//   pin     none. An effort is above the cards; the cards carry the trees.
const fs = require('fs');
const path = require('path');
const yaml = require('./yaml');
const locking = require('./locking');
const spine = require('./spine');
const ee = require('./effort-events');

// The bytes state.yaml held when it was read, for the write-time compare. Non-enumerable so it
// never reaches yaml.stringify.
const READ_TEXT = Symbol('effort state.yaml text at read');

function stateFile(processDir, slug) { return path.join(ee.effortDir(processDir, slug), 'state.yaml'); }

// `null` means NOT LAUNCHED, and nothing else. A parse failure used to return null too, which made
// a corrupt state.yaml indistinguishable from an effort nobody started — `nextCommand` said
// `plt effort start`, and `launchEffort` then overwrote it, losing every step while the ledger kept
// its epochs. A file that exists and cannot be read is a different fact and throws.
function readEffortState(processDir, slug) {
  const f = stateFile(processDir, slug);
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) { return null; }   // absent: not launched
  let st;
  try { st = yaml.parse(text); } catch (e) {
    throw new Error(`effort ${slug}: ${f} will not parse (${e.message.split('\n')[0]}) — fix or move it; it is not an unlaunched effort`);
  }
  if (st === null || typeof st !== 'object' || Array.isArray(st)) {
    throw new Error(`effort ${slug}: ${f} is not a mapping — fix or move it; it is not an unlaunched effort`);
  }
  if (!st.steps || typeof st.steps !== 'object') {
    throw new Error(`effort ${slug}: ${f} has no steps — a half-written launch, not an unlaunched effort`);
  }
  Object.defineProperty(st, READ_TEXT, { value: text, enumerable: false });
  return st;
}

// Read-hash compare, the way spine.writeState does it. Two stale writers both succeeded before
// this: each read, each wrote, and the second silently erased the first. `spine.readState` has
// carried this guard for a long time and my reimplementation did not, which is the whole argument
// for not reimplementing it.
function writeEffortState(processDir, slug, st, { expect = true } = {}) {
  const f = stateFile(processDir, slug);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (expect && Object.hasOwn(st, READ_TEXT) === false && st[READ_TEXT] === undefined) {
    // a state built from scratch (launch) has nothing to compare against
  }
  const was = st[READ_TEXT];
  if (expect && was !== undefined) {
    let now = null;
    try { now = fs.readFileSync(f, 'utf8'); } catch (e) { now = null; }
    if (now !== null && now !== was) {
      throw new Error(`effort ${slug}: ${f} changed since it was read — re-read and retry`);
    }
  }
  locking.writeFileAtomic(f, yaml.stringify(st));
  return st;
}

function formulaOf(processDir, st) {
  const wf = spine.loadFormula(processDir, st.cycle);
  return wf;
}

function launchEffort(processDir, slug, { cycle = 'effort', owner = null } = {}) {
  const existing = readEffortState(processDir, slug);
  if (existing && existing.steps) throw new Error(`effort ${slug} is already launched (a reset is deliberate, not a retry)`);
  const wf = spine.loadFormula(processDir, cycle);
  // Refused by name rather than discovered later: launching `build-and-ship` as an effort would
  // compile a card's steps into effort state and fail somewhere that does not name the cause.
  if (wf.kind !== 'effort') {
    throw new Error(`cycle ${cycle} is kind: ${wf.kind || 'workflow'} — an effort run needs a formula declared kind: effort`);
  }
  const config = spine.loadConfig(processDir);
  const entry = spine.entryStepIds(wf);
  const steps = {};
  for (const s of wf.steps) {
    steps[s.id] = { status: entry.has(s.id) ? 'ready' : 'pending', outcome: null,
      receipts_required: spine.compileRequirements(s, config), started: null, finished: null };
  }
  const st = writeEffortState(processDir, slug, {
    effort: slug, cycle, status: 'open', formula_version: wf.version,
    owner, created: new Date().toISOString(), current_step: null, steps,
  });
  // NO epoch event here, and this is worth stating because I got it wrong first. `gateEpoch` is
  // the COUNT OF CLOSED GATES (effort-events.js:271), so writing one at launch claims a gate
  // closed when none has — every decision in the first wave would then record epoch 1 and the
  // first real gate would roll up an empty list. Epoch 0 is the honest starting value: zero gates
  // closed. What distinguishes a launched effort from an unlaunched one is the STATE FILE, which
  // is what `readEffortState` answers; the ledger does not have to carry it too.
  return st;
}

// ---- receipts on an effort step ------------------------------------------------------------
// A card run checks these through spine.gateCheck before it lets a step finish. This file did
// not check them at all: `roll-up`'s `effort-review` artifact, its adversarial agent and
// `review`'s `effort-reviewed` signal were compiled into state at launch and then never read.
// The gates existed as data and enforced nothing, which is why the first real effort run walked
// past both of them. It also made the hard-vs-banner argument moot — neither mode was enforced.
//
// WHERE THESE LIVE, and the gap that decided it. A card run records a receipt as a ledger event,
// which is the better home: append-only, ordered, independently auditable. The effort ledger
// cannot hold one — `EFFORT_KINDS` (effort-events.js:196) is
// `[ask, decision, escalation, blocked, wave, epoch, pane]` and refuses `artifact`, `agent` and
// `gate` outright. So `compileRequirements` has been writing artifact and agent requirements into
// effort state that the effort ledger is structurally incapable of recording as satisfied: the
// gate was not merely unchecked, it was UNENFORCEABLE, and no amount of checking in this file
// would have changed that.
//
// Widening EFFORT_KINDS is the right fix and is NOT this card's to make — lib/effort-events.js is
// not in T29's touches, and quietly editing it is the undeclared-file mistake this card was
// already caught making once. So receipts live on the step in state.yaml for now: weaker than an
// append-only line, strong enough to make the gate hold, and a single move when the ledger learns
// the vocabulary. Carded separately.
function recordEffortReceipt(processDir, slug, stepId, { kind, name, by = 'brain', url = null }) {
  if (!RECEIPT_KINDS.has(kind)) throw new Error(`receipt kind ${kind} is not one of ${[...RECEIPT_KINDS].join('|')}`);
  const st = readEffortState(processDir, slug);
  if (!st) throw new Error(`effort ${slug} is not launched`);
  const step = st.steps[stepId];
  if (!step) throw new Error(`no step ${stepId} in effort ${slug}`);
  step.receipts = step.receipts || [];
  if (!step.receipts.some((r) => r.kind === kind && r.name === name)) {
    step.receipts.push({ kind, name, by, url, at: new Date().toISOString() });
  }
  writeEffortState(processDir, slug, st);
  return step.receipts;
}

const RECEIPT_KINDS = new Set(['artifact', 'agent', 'gate', 'skill', 'tool']);

// The actor names this system uses for MACHINES. `spine.personOf` is not enough on its own here,
// and finding that out is the whole lesson of this card: `personOf('brain')` returns `'brain'`,
// because it only nulls `''` and the literal `'agent'`. So a guard built on `personOf` alone still
// lets `by: 'brain'` close a human gate — the exact bug it was meant to replace, one layer down.
// A human gate needs a name that is a person AND is not one of these.
const MACHINE_ACTORS = new Set(['brain', 'fan', 'gate', 'agent', 'steward', 'adversary']);

// `mode` decides whether a miss stops the step or is merely reported, the same two words a card
// gate uses: `hard` refuses, `banner` records and continues. An empty agent list makes the two
// identical, which is a property of the config rather than of this function.
function checkEffortReceipts(processDir, slug, stepId, step, def) {
  const need = Array.isArray(step.receipts_required) ? step.receipts_required : [];
  if (!need.length) return { ok: true, missing: [], mode: 'hard' };
  const have = Array.isArray(step.receipts) ? step.receipts : [];
  const missing = need.filter((r) => !have.some((h) => h.kind === r.kind && h.name === r.name));
  const mode = (def && def.gate && def.gate.mode) || 'hard';
  return { ok: missing.length === 0, missing, mode };
}

function startStep(processDir, slug, stepId, { by = 'brain' } = {}) {
  const st = readEffortState(processDir, slug);
  if (!st || !st.steps) throw new Error(`effort ${slug} is not launched`);
  const step = st.steps[stepId];
  if (!step) throw new Error(`no step ${stepId} in effort ${slug}`);
  if (step.status !== 'ready') throw new Error(`step ${stepId} is ${step.status}; only a ready step can be started`);
  if (st.current_step && st.current_step !== stepId) throw new Error(`effort ${slug}: step ${st.current_step} is already in progress`);
  step.status = 'in_progress';
  step.started = new Date().toISOString();
  st.current_step = stepId;
  writeEffortState(processDir, slug, st);
  ee.appendEffortEvent(processDir, slug, { kind: 'pane', who: by === 'brain' ? 'brain' : 'gate', card: null, state: 'working', step: stepId });
  return st;
}

function finishStep(processDir, slug, stepId, { outcome, by = 'brain', force = false } = {}) {
  const st = readEffortState(processDir, slug);
  if (!st || !st.steps) throw new Error(`effort ${slug} is not launched`);
  const wf = formulaOf(processDir, st);
  const def = wf.steps.find((s) => s.id === stepId);
  const step = st.steps[stepId];
  if (!step) throw new Error(`no step ${stepId} in effort ${slug}`);
  // A step in state that the CURRENT formula no longer defines used to reach `def.outcomes` and
  // throw a TypeError naming nothing. The formula moved under a live run; say so.
  if (!def) {
    throw new Error(`effort ${slug}: step ${stepId} is in state but not in cycle ${st.cycle} (launched at formula_version ${st.formula_version || 'unknown'}, now ${wf.version || 'unknown'}) — the cycle changed under this run`);
  }
  if (step.status !== 'in_progress') throw new Error(`step ${stepId} is ${step.status}; only an in_progress step can be finished`);
  if (Array.isArray(def.outcomes) && def.outcomes.length && !def.outcomes.includes(outcome)) {
    throw new Error(`outcome ${JSON.stringify(outcome)} is not one of ${def.outcomes.join('|')} for step ${stepId}`);
  }

  // ---- the authority boundary ----------------------------------------------------------------
  // This was `by === 'brain'`, a compare against one string, and it let `by: null`, `''`,
  // `'agent'`, `'fan'`, `'Brain'` and `42` all close a human gate and move the epoch. spine has
  // carried `personOf` and `assertHuman` for exactly this, and card gates use both; this path
  // used neither. `personOf` answers "is this a person at all", `assertHuman` answers "is this
  // person one of ours" against config.actors.humans.
  const isHuman = def.gate && def.gate.kind === 'human';
  if (isHuman) {
    const person = spine.personOf(by);
    if (!person || MACHINE_ACTORS.has(person.toLowerCase())) {
      throw new Error(`step ${stepId} is a human gate (assignee ${def.assignee || 'owner'}) — ${JSON.stringify(by)} is not a person; a brain cannot close its own authority boundary, so pass --by <person>`);
    }
    // And the person must be one of OURS when the project says who its people are. Without this,
    // `--by santa` passes a gate that exists to record who took responsibility.
    spine.assertHuman(processDir, null, person);
  }

  // ---- receipts -------------------------------------------------------------------------------
  const g = checkEffortReceipts(processDir, slug, stepId, step, def);
  if (!g.ok && g.mode === 'hard' && !force) {
    throw new Error(`step ${stepId}: missing receipts: ${g.missing.map((m) => `${m.kind}:${m.name}`).join(', ')} — record them, or pass --force to close the step with the miss on the record`);
  }

  step.outcome = outcome;
  st.current_step = null;

  // A repeat_until step that did not reach its terminal outcome comes back ready for another
  // round; nothing downstream of it moves. It appends a `round` event and NOT a `wave` — a wave
  // is what `fan` writes when cards are actually dispatched, and faking one here put a row of
  // `{n: null, cards: []}` lines in the ledger for every loop, polluting the record a roll-up
  // reads. A repeat that declares no human step can also spin forever, so the round is counted
  // and reported rather than left silent.
  if (def.repeat_until && outcome !== def.repeat_until) {
    // The round is counted in STATE, not appended to the ledger. `round` is not an allowed effort
    // kind, and the old code borrowed `wave` for it — which wrote `{n: null, cards: [], deferred: []}`
    // once per loop into the record a roll-up reads, claiming a dispatch that never happened. A
    // false line is worse than a missing one, so this counts honestly where it can and the ledger
    // gap is carded with the receipt gap: both want EFFORT_KINDS widened, and both are in a file
    // this card may not touch.
    step.rounds = (step.rounds || 0) + 1;
    step.status = 'ready';
    step.started = null;
    step.finished = null;
    if (!g.ok) recordMiss(processDir, slug, stepId, g);
    writeEffortState(processDir, slug, st);
    return st;
  }

  step.status = 'done';
  step.finished = new Date().toISOString();
  for (const id of spine.readyAfter(wf, st.steps)) st.steps[id].status = 'ready';
  if (!g.ok) recordMiss(processDir, slug, stepId, g);

  // ---- the epoch, and the ORDER it is written in ----------------------------------------------
  // This used to write state first and append the epoch after, with a comment calling that the
  // safe ordering. It is the opposite: any throw in the append — a corrupt ledger line, a lock
  // timeout — left the gate closed in state, the epoch un-incremented, the step refused on retry
  // ("review is done") and nothing anywhere detecting it. That is the authority boundary lost
  // silently, which is the one failure this whole file exists to prevent.
  //
  // The ledger is the record and state is derived from it, so the ledger line goes FIRST. If the
  // state write then fails, the epoch stands and the step reads as still in_progress: a retry
  // finds its own epoch event already there and skips the append instead of double-counting.
  if (isHuman) {
    if (!epochClosedFor(processDir, slug, stepId, step.finished)) {
      // THE LOCK GAP, stated rather than hidden. effort-events.js:77-80 says a value derived from
      // the ledger's own contents must be computed in a BUILDER under the lock, and it is right:
      // a `decision` appended between this read and the append is stamped with this epoch and yet
      // absent from the list, so the roll-up loses it.
      //
      // The builder form is UNREACHABLE through this wrapper. `appendEffortEvent`
      // (effort-events.js:223) tests `!event.kind` before it resolves anything, and a function has
      // no `.kind`, so every builder throws "an effort event needs a kind: undefined" before it
      // runs. The file documents the contract and its own effort wrapper forbids it.
      //
      // Calling `appendTo` directly would reach the builder and skip the effort stamping that
      // exists so one writer owns the envelope — trading a narrow race for a broken invariant. So
      // this reads outside the lock, the window is one append wide, and the fix belongs in
      // effort-events.js. Carded.
      const events = ee.readEffortEvents(processDir, slug);
      const closed = events.filter((e) => e.kind === 'epoch').length;
      ee.appendEffortEvent(processDir, slug, {
        // `who` is the envelope's actor vocabulary (fan | brain | gate), not a name — the ledger
        // refuses a person here. The person who actually closed it is `closed_by`, which is the
        // field a roll-up reads to say whose authority moved the boundary.
        kind: 'epoch', who: 'gate', step: stepId, outcome,
        closed_by: spine.personOf(by), closed,
        decisions: events.filter((e) => e.kind === 'decision' && (e.gate_epoch || 0) === closed).map((e) => e.id),
      });
    }
  }

  // A terminal step ends the effort. Nothing used to set this, so `status` stayed `open` for the
  // life of the run, `nextCommand`'s closed branch was dead code, and a FINISHED effort printed
  // the same "no ready step" line as the dead end I had just fixed — indistinguishable. Terminal
  // means no step anywhere in the formula depends on this one.
  const terminal = !wf.steps.some((x) => (x.needs || []).includes(stepId) || x.else_of === stepId);
  if (terminal) {
    // Only `status` and `closed` are stored. `closed_at_step` and `closed_outcome` were caught by
    // the schema-drift guard (T25) as fields written into state and named in no schema — and it was
    // right twice over: schemas/state.schema.json is not in this card's touches, and both fields
    // were redundant, since `steps[id].finished` and `steps[id].outcome` already hold them. Derive,
    // do not duplicate.
    st.status = 'closed';
    st.closed = step.finished;
  }
  writeEffortState(processDir, slug, st);
  return st;
}

// A miss that `banner` mode allowed through, or that `--force` overrode, is recorded rather than
// forgotten: the roll-up should be able to say the gate did not hold.
function recordMiss(processDir, slug, stepId, g) {
  ee.appendEffortEvent(processDir, slug, {
    kind: 'blocked', who: 'brain', step: stepId, why: 'missing receipts', mode: g.mode,
    missing: g.missing.map((m) => `${m.kind}:${m.name}`),
  });
}

// Did this step already append its epoch line? Used to make the append idempotent across a crash
// between the ledger write and the state write.
function epochClosedFor(processDir, slug, stepId, finished) {
  return ee.readEffortEvents(processDir, slug).some((e) => e.kind === 'epoch' && e.step === stepId);
}

function nextCommand(processDir, slug) {
  const st = readEffortState(processDir, slug);
  if (!st || !st.steps) return `plt effort start ${slug}`;
  if (st.status === 'closed') {
    // The closing step is the one that finished at `closed` — derived, not stored.
    const at = Object.entries(st.steps).find(([, x]) => x.finished && x.finished === st.closed);
    return at ? `effort ${slug} is closed at ${at[0]} (${at[1].outcome})` : `effort ${slug} is closed`;
  }
  if (st.current_step) return `plt effort step finish ${st.current_step} --effort ${slug} --outcome <outcome>`;
  const ready = Object.entries(st.steps).filter(([, s]) => s.status === 'ready').map(([id]) => id);
  // A run with no ready step and no closed status is STUCK, and saying so is the whole point: the
  // old message was the same sentence for a finished effort and for a dead end, which is how the
  // first real run sat in `plan -> nothing_to_do` looking like it had merely ended.
  if (!ready.length) {
    const pending = Object.entries(st.steps).filter(([, s]) => s.status === 'pending').map(([id]) => id);
    return `effort ${slug} is STUCK: no ready step and the run is not closed. Done: `
      + Object.entries(st.steps).filter(([, s]) => s.status === 'done').map(([id]) => id).join(', ')
      + `. Unreachable from here: ${pending.join(', ')}. This is a hole in cycle ${st.cycle}, not a state to wait in.`;
  }
  return `plt effort step start ${ready[0]} --effort ${slug}`;
}

module.exports = {
  launchEffort, readEffortState, writeEffortState, startStep, finishStep, nextCommand, stateFile,
  // exported because bin/plt and the tests drive them; `humanStepId` was exported and called from
  // nowhere at all, including this file, so it is gone rather than left as decoration.
  recordEffortReceipt, checkEffortReceipts,
};
