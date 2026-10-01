'use strict';
// fsck — per-run integrity over the four things a run is made of: its event ledger, its state, the
// formula the state claims to follow, and the receipts pinned into the ledger. It reports; it only
// writes under `--fix`, and only what it can prove is wrong.
//
// The rule for `--fix` is narrow on purpose: repair what is provably wrong, never discard what
// cannot be reconstructed, and name every change. A torn trailing line is a crash mid-append and is
// droppable; a gap in the ids is a hole this tool cannot fill, so it is reported and left alone.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const spine = require('./spine');

// The kinds `compileRequirements` can emit. An event of any other kind (`time`, `extrapolation`,
// `reprompt`, …) is a log line, not a receipt, and is never matched against requirements.
const RECEIPT_KINDS = new Set(['skill', 'tool', 'artifact', 'touches', 'file', 'agent', 'gate', 'gh', 'jira', 'overlap', 'effort']);

// ---- optional schemas ------------------------------------------------------
//
// The schema module lands in its own task. Until it is on disk, `require` throws and every
// validation passes through: an fsck run completes and no `E_*_SCHEMA` finding can fire early. The
// require is lazy (inside the call, cached once) so loading fsck never depends on it.
const PASS = { ok: true, errors: [] };
let schemasLoaded = false;
let schemasMod = null;
function schemas() {
  if (!schemasLoaded) {
    schemasLoaded = true;
    try { schemasMod = require('./schemas'); } catch (e) { schemasMod = null; }
  }
  return schemasMod && typeof schemasMod.validateObject === 'function' ? schemasMod : null;
}
function validateObject(kind, obj) {
  const m = schemas();
  if (!m) return PASS;
  try {
    const r = m.validateObject(kind, obj);
    return r && typeof r.ok === 'boolean' ? r : PASS;
  } catch (e) {
    return PASS;   // a validator that cannot run is not evidence that the file is wrong
  }
}

function eventsFile(processDir, runId) { return path.join(spine.runDir(processDir, runId), 'events.jsonl'); }
function eventId(n) { return 'e' + String(n).padStart(6, '0'); }
function fixCmd(runId) { return `plt fsck ${runId} --fix`; }
function finding(code, severity, detail, fixable) { return { code, severity, detail, fixable }; }
function sameReq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ---- the event ledger ------------------------------------------------------
//
// Read as raw lines, not through spine.readEvents: readEvents throws on a corrupt line, and a
// checker that crashes on the file it exists to check reports nothing.
function readLedger(processDir, runId) {
  const file = eventsFile(processDir, runId);
  if (!fs.existsSync(file)) return { file, lines: [], events: [], badIdx: [] };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const events = [];
  const badIdx = [];
  for (let i = 0; i < lines.length; i++) {
    try { events.push({ i, ev: JSON.parse(lines[i]) }); } catch (e) { badIdx.push(i); }
  }
  return { file, lines, events, badIdx };
}

function checkLedger(ledger, runId, findings) {
  const { file, lines, events, badIdx } = ledger;
  const drop = new Set();
  let idsRepairable = false;

  for (const i of badIdx) {
    if (i === lines.length - 1) {
      findings.push(finding('E_EVENT_TRUNCATED', 'error',
        `${file}: the last line (line ${i + 1}) does not parse as JSON — a write torn by a crash. Drop it with: ${fixCmd(runId)}`, true));
      drop.add(i);
    } else {
      findings.push(finding('E_EVENT_PARSE', 'error',
        `${file}: line ${i + 1} does not parse as JSON. The ledger is append-only; repair the line by hand, then re-run: plt fsck ${runId}`, false));
    }
  }

  // A byte-identical repeat of the line before it is a retried append — the only id fault this tool
  // can prove and undo. Every other break in the sequence is a hole it must not invent a value for.
  const dupIdx = new Set();
  for (const { i } of events) {
    if (i > 0 && lines[i] === lines[i - 1] && !drop.has(i)) dupIdx.add(i);
  }
  const kept = events.filter((e) => !drop.has(e.i) && !dupIdx.has(e.i));
  let sequenceOk = true;
  for (let n = 0; n < kept.length; n++) {
    const want = eventId(n + 1);
    if (kept[n].ev.id !== want) {
      sequenceOk = false;
      findings.push(finding('E_EVENT_IDS', 'error',
        `${file}: line ${kept[n].i + 1} has id ${JSON.stringify(kept[n].ev.id)} where the sequence expects ${want}. ` +
        'An id gap or repeat is a hole fsck cannot fill; read the run and repair it by hand.', false));
      break;
    }
  }
  if (dupIdx.size) {
    const ids = [...dupIdx].map((i) => { try { return JSON.parse(lines[i]).id; } catch (e) { return '?'; } });
    if (sequenceOk) {
      idsRepairable = true;
      findings.push(finding('E_EVENT_IDS', 'error',
        `${file}: ${dupIdx.size} line(s) repeat the line before them byte for byte (${ids.join(', ')}) — a retried append. Drop them with: ${fixCmd(runId)}`, true));
    } else {
      findings.push(finding('E_EVENT_IDS', 'error',
        `${file}: ${dupIdx.size} line(s) repeat the line before them byte for byte (${ids.join(', ')}), and the ids break elsewhere too. ` +
        'Repair the sequence by hand first.', false));
    }
  }

  return { drop, dupIdx, idsRepairable, sequenceOk, events: kept.map((e) => e.ev) };
}

// ---- pins ------------------------------------------------------------------
//
// Only a commit pin is checked, and only when the run's repo is on this machine: a pin fsck cannot
// look up is not a pin fsck can call wrong.
function unresolvedShas(repoDir, events) {
  const out = [];
  if (!repoDir || !fs.existsSync(path.join(repoDir, '.git'))) return out;
  const seen = new Map();
  for (const ev of events) {
    const pin = ev.pin;
    if (!pin || typeof pin.value !== 'string') continue;
    if (pin.kind !== 'sha' && pin.kind !== 'commit') continue;
    if (!seen.has(pin.value)) seen.set(pin.value, []);
    seen.get(pin.value).push(ev.id);
  }
  for (const [sha, ids] of seen) {
    let ok = true;
    try { execFileSync('git', ['-C', repoDir, 'cat-file', '-e', sha], { stdio: 'ignore' }); } catch (e) { ok = false; }
    if (!ok) out.push({ sha, ids });
  }
  return out;
}

// ---- one run ---------------------------------------------------------------
function fsckRun(processDir, runId, { fix = false } = {}) {
  const st = spine.readState(processDir, runId);
  if (!st) throw new Error(`no run ${runId} under ${path.join(processDir, 'runs')}`);
  const findings = [];
  const fixed = [];

  const ledger = readLedger(processDir, runId);
  const led = checkLedger(ledger, runId, findings);

  // Schemas. Each of these self-skips until the schema module ships.
  // The ledger is append-only and never rewritten, so an event written before the writers were
  // fixed that fails the schema is a warning (W_EVENT_LEGACY); one written after is an error.
  const m = schemas();
  for (const ev of led.events) {
    const r = validateObject('event', ev);
    if (!r.ok) {
      const legacy = Boolean(m && typeof m.isLegacyEvent === 'function' && m.isLegacyEvent(ev));
      const why = r.errors.map((e) => `${e.path || '/'} ${e.message}`).join('; ');
      findings.push(legacy
        ? finding('W_EVENT_LEGACY', 'warn',
          `${ledger.file}: event ${ev.id} (${ev.ts}) does not match schemas/event.schema.json — ${why}. ` +
          `It predates the writer fix (${m.EVENT_WRITER_FIX_TS}); the ledger is append-only, so it stays as written.`, false)
        : finding('E_EVENT_SCHEMA', 'error',
          `${ledger.file}: event ${ev.id} does not match schemas/event.schema.json — ${why}`, false));
    }
  }
  const stateFile = path.join(spine.runDir(processDir, runId), 'state.yaml');
  const stateSchema = validateObject('state', st);
  // A state with no top-level `status` was launched before launchRun wrote one. closeRun always
  // writes `status: closed`, so a missing status is an open run (or, with a `closed` stamp, a
  // closed one) — provable, so --fix writes it. Any other state schema fault is left alone.
  const statusRepair = !('status' in st)
    && stateSchema.errors.every((e) => /required property 'status'/.test(e.message))
    ? (st.closed ? 'closed' : 'open') : null;
  if (!stateSchema.ok) {
    findings.push(finding('E_STATE_SCHEMA', 'error',
      `${stateFile} does not match schemas/state.schema.json — ` +
      stateSchema.errors.map((e) => `${e.path || '/'} ${e.message}`).join('; ') +
      (statusRepair ? `. Write status: ${statusRepair} with: ${fixCmd(runId)}` : ''), Boolean(statusRepair)));
  }
  const inputsFile = path.join(spine.runDir(processDir, runId), 'inputs.yaml');
  if (fs.existsSync(inputsFile)) {
    const r = validateObject('inputs', spine.readInputs(processDir, runId));
    if (!r.ok) {
      findings.push(finding('E_INPUTS_SCHEMA', 'error',
        `${inputsFile} does not match schemas/inputs.schema.json — ` +
        r.errors.map((e) => `${e.path || '/'} ${e.message}`).join('; '), false));
    }
  }

  // State against the formula it says it is on.
  const wf = spine.runFormula(processDir, st);
  const config = spine.loadConfig(processDir, runId);
  const byId = new Map(wf.steps.map((s) => [s.id, s]));
  const steps = st.steps || {};
  const addSteps = [];
  const recompile = [];

  for (const id of Object.keys(steps)) {
    if (byId.has(id)) continue;
    findings.push(finding('E_UNKNOWN_STEP', 'error',
      `${stateFile}: state.steps names ${id}, which formula ${wf.name} does not define. ` +
      'Either the formula lost the step or the state carries a typo; neither is safe to rewrite from here.', false));
  }
  const closed = st.status === 'closed';
  for (const s of wf.steps) {
    if (!steps[s.id]) {
      addSteps.push(s);
      // On a closed run nothing will ever start the step, so it goes in as closeRun leaves every
      // unfinished step — skipped, outcome retired — not as pending work on a run that is over.
      findings.push(finding('E_MISSING_STEP', 'error',
        `${stateFile}: formula ${wf.name} defines step ${s.id}, which state.steps does not carry. ` +
        `Add it as ${closed ? 'skipped (retired), since the run is closed,' : 'pending'} with: ${fixCmd(runId)}`, true));
      continue;
    }
    const step = steps[s.id];
    let fresh = null;
    try { fresh = spine.compileRequirements(s, config); } catch (e) { fresh = null; }
    if (!('receipts_required' in step)) {
      if (step.status !== 'skipped') {
        findings.push(finding('E_NO_REQUIREMENTS', 'error',
          `${stateFile}: step ${s.id} is ${step.status} and carries no receipts_required, so nothing can satisfy it. ` +
          `Recompile it from formula ${wf.name} and the config with: ${fixCmd(runId)}`, fresh !== null));
        if (fresh) recompile.push({ id: s.id, fresh, code: 'E_NO_REQUIREMENTS' });
      }
      continue;
    }
    if (step.status !== 'done' && fresh && !sameReq(step.receipts_required, fresh)) {
      findings.push(finding('E_REQUIREMENTS_DRIFT', 'warn',
        `${stateFile}: step ${s.id} carries requirements the formula no longer compiles to. ` +
        `This is \`plt run recompile\` for one step: ${fixCmd(runId)}`, true));
      recompile.push({ id: s.id, fresh, code: 'E_REQUIREMENTS_DRIFT' });
    }
  }

  // Pins.
  for (const { sha, ids } of unresolvedShas(st.repo_dir, led.events)) {
    findings.push(finding('E_PIN_UNRESOLVED', 'error',
      `${ledger.file}: event(s) ${ids.join(', ')} pin commit ${sha}, which ${st.repo_dir} cannot resolve ` +
      '(a rebased or force-pushed branch, or a repo cloned again). Fetch the commit, or record the receipt again.', false));
  }

  // Receipts against the steps they name.
  for (const ev of led.events) {
    if (!ev.step || typeof ev.step !== 'string') continue;
    if (!steps[ev.step]) {
      findings.push(finding('E_RECEIPT_ORPHAN', 'error',
        `${ledger.file}: event ${ev.id} names step ${ev.step}, which state.steps does not carry. ` +
        'The receipt counts for nothing until the step is back.', false));
      continue;
    }
    if (!RECEIPT_KINDS.has(ev.kind)) continue;
    const required = steps[ev.step].receipts_required || [];
    if (required.some((r) => r.kind === ev.kind && r.name === ev.name)) continue;
    const spelled = ev.kind === 'gh'
      ? required.find((r) => r.kind === 'gh' && spine.normalizeGhName(r.name) === spine.normalizeGhName(ev.name))
      : null;
    if (spelled) {
      findings.push(finding('W_GH_NAME_SPELLING', 'warn',
        `${ledger.file}: event ${ev.id} records the gh check as ${ev.name}, and step ${ev.step} asks for ${spelled.name} — ` +
        'the same check under two spellings. It still counts; settle on one spelling in the formula.', false));
      continue;
    }
    findings.push(finding('W_RECEIPT_UNUSED', 'warn',
      `${ledger.file}: event ${ev.id} records ${ev.kind} ${ev.name} on step ${ev.step}, which asks for no such receipt. ` +
      'Work was recorded that nothing needed.', false));
  }

  if (st.status === 'closed' && !st.facts) {
    findings.push(finding('W_NO_FACTS_SNAPSHOT', 'warn',
      `${stateFile}: the run is closed and carries no facts snapshot, so its run page has no terminal PR state. ` +
      'A closed run cannot be snapshotted again; the next run gets one at close.', false));
  }

  if (fix) applyFixes(processDir, runId, { ledger, led, addSteps, recompile, statusRepair, config, findings, fixed });

  return { run: runId, ok: findings.every((f) => f.severity !== 'error'), findings, fixed };
}

// Applies only the repairs the checks above proved safe, in a fixed order, and records what changed
// both in the returned `fixed` list and as a `time` event on the run's own ledger.
function applyFixes(processDir, runId, { ledger, led, addSteps, recompile, statusRepair, config, findings, fixed }) {
  const drops = new Set([...led.drop, ...(led.idsRepairable ? led.dupIdx : [])]);
  if (drops.size) {
    // The rewrite runs under the run lock. The line numbers were proved against the ledger as it
    // was read; if another plt appended since, they no longer name the same lines, so give up.
    spine.rewriteEvents(processDir, runId, (lines) => {
      if (lines.length !== ledger.lines.length || lines.some((l, i) => l !== ledger.lines[i])) {
        throw new Error(`${ledger.file} changed while fsck was checking it; re-run: ${fixCmd(runId)}`);
      }
      return lines.filter((_, i) => !drops.has(i));
    });
    if (led.drop.size) fixed.push('E_EVENT_TRUNCATED');
    if (led.idsRepairable && led.dupIdx.size) fixed.push('E_EVENT_IDS');
  }

  if (addSteps.length || recompile.length || statusRepair) {
    // writeState takes the run lock and refuses if another writer landed since this read.
    const st = spine.readState(processDir, runId);
    if (statusRepair && !('status' in st)) { st.status = statusRepair; fixed.push('E_STATE_SCHEMA'); }
    const closed = st.status === 'closed';
    for (const s of addSteps) {
      st.steps[s.id] = { status: closed ? 'skipped' : 'pending', outcome: closed ? 'retired' : null,
        receipts_required: spine.compileRequirements(s, config), started: null, finished: null };
    }
    for (const r of recompile) st.steps[r.id].receipts_required = r.fresh;
    spine.writeState(processDir, runId, st);
    if (addSteps.length) fixed.push('E_MISSING_STEP');
    for (const code of ['E_NO_REQUIREMENTS', 'E_REQUIREMENTS_DRIFT']) {
      if (recompile.some((r) => r.code === code)) fixed.push(code);
    }
  }

  // The audit line goes on the ledger only when the ledger is sound: appending to a file whose ids
  // are already broken would write a second event under an id that is taken.
  const ledgerSound = !findings.some((f) => (f.code === 'E_EVENT_PARSE' || f.code === 'E_EVENT_IDS') && !f.fixable);
  if (fixed.length && ledgerSound) {
    spine.appendEvent(processDir, runId, { kind: 'time', what: 'fsck-fixed', step: null, actor: 'agent', pin: null, fixed: [...fixed] });
  }
}

function fsckAll(processDir, { fix = false } = {}) {
  const runs = spine.runIds(processDir).map((id) => fsckRun(processDir, id, { fix }));
  return { ok: runs.every((r) => r.ok), runs };
}

function formatRun(r) {
  const errors = r.findings.filter((f) => f.severity === 'error').length;
  const warnings = r.findings.length - errors;
  const head = r.findings.length === 0 ? `${r.run}: ok` : `${r.run}: ${errors} error(s), ${warnings} warning(s)`;
  return [head, ...r.findings.map((f) => `  ${f.code} ${f.severity}: ${f.detail}`)].join('\n');
}

function formatFsck(result) {
  if (result && Array.isArray(result.runs)) {
    return result.runs.length ? result.runs.map(formatRun).join('\n') : 'no runs under process/runs';
  }
  return formatRun(result);
}

// ---- CLI -------------------------------------------------------------------
const USAGE = 'plt fsck [<run>] [--all] [--fix] [--project <dir>] [--json]';

function parseArgs(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { const k = args[i].slice(2); const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true; o[k] = v; }
    else o._.push(args[i]);
  }
  return o;
}

function resolveProcessDir(project) {
  if (typeof project === 'string') {
    const dir = path.resolve(project);
    if (fs.existsSync(path.join(dir, 'process', 'config'))) return path.join(dir, 'process');
    if (fs.existsSync(path.join(dir, 'config'))) return dir;
    throw new Error(`no process/config directory under ${dir}`);
  }
  const p = process.env.PLT_PROCESS_DIR || spine.findProcessDir(process.cwd());
  if (!p) throw new Error(`no process/config directory found above ${process.cwd()} (set PLT_PROCESS_DIR, or pass --project <dir>)`);
  return p;
}

async function fsckHandler(args) {
  const o = parseArgs(args);
  const processDir = resolveProcessDir(o.project);
  const fix = !!o.fix;
  const runId = o._[0];
  if (!runId && !o.all) throw new Error(`usage: ${USAGE}`);
  const result = runId ? fsckRun(processDir, runId, { fix }) : fsckAll(processDir, { fix });
  process.stdout.write((o.json ? JSON.stringify(result, null, 2) : formatFsck(result)) + '\n');
  return result.ok ? 0 : 1;
}

const commands = [{ name: 'fsck', usage: USAGE, handler: fsckHandler }];

module.exports = { fsckRun, fsckAll, formatFsck, fsckHandler, commands };
