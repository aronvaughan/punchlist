'use strict';
// spine — run state, receipts, pins, gates and prime for the process spine.
// All functions take an explicit processDir; nothing reads process.cwd() except findProcessDir.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const yaml = require('./yaml');
const locking = require('./locking');
const repoWindow = require('./repo-window');
const { parseWorkflow } = require('../bin/plt');   // parser is the single source of the grammar

// `claimed` is gone (plan 4 D-026): no code wrote it. The launch `time` event is still named `claimed`.
const STATE_ENUM = ['pending', 'ready', 'in_progress', 'in_review', 'blocked', 'done', 'skipped'];

function findProcessDir(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'process', 'config'))) return path.join(dir, 'process');
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// Maps deep-merge; lists and scalars REPLACE (appending is how client words leak into public lists).
function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

function readYaml(file) { return fs.existsSync(file) ? yaml.parse(fs.readFileSync(file, 'utf8')) : null; }

function runDir(processDir, runId) { return path.join(processDir, 'runs', runId); }

// Org files (config/*.yaml, excluding defaults.yaml and estimation.yaml) merge in
// alphabetical filename order — the last file to sort wins on any key it sets.
function loadConfig(processDir, runId) {
  const cfgDir = path.join(processDir, 'config');
  let cfg = readYaml(path.join(cfgDir, 'defaults.yaml')) || {};
  const orgs = fs.readdirSync(cfgDir)
    .filter((f) => f.endsWith('.yaml') && f !== 'defaults.yaml' && f !== 'estimation.yaml')
    .sort();
  for (const f of orgs) cfg = deepMerge(cfg, readYaml(path.join(cfgDir, f)) || {});
  const est = readYaml(path.join(cfgDir, 'estimation.yaml'));
  if (est) cfg = deepMerge(cfg, { estimation: est });
  if (runId) {
    const inputs = readYaml(path.join(runDir(processDir, runId), 'inputs.yaml'));
    if (inputs && isPlainObject(inputs.vars)) cfg = deepMerge(cfg, inputs.vars);
  }
  return cfg;
}

// Every launched run under `<processDir>/runs`, sorted. A directory without a state.yaml is not a
// run (a half-made worktree, a stray note), so it never appears.
function runIds(processDir) {
  const dir = path.join(processDir, 'runs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'state.yaml'))).sort();
}

// readState remembers a hash of the text it parsed, on a hidden symbol property that neither
// yaml.stringify nor JSON.stringify sees. writeState compares it with the file under the lock.
const READ_HASH = Symbol('state.yaml hash at read');
function textHash(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function rememberHash(state, text) {
  Object.defineProperty(state, READ_HASH, { value: textHash(text), enumerable: false, writable: true, configurable: true });
}

function readState(processDir, runId) {
  const file = path.join(runDir(processDir, runId), 'state.yaml');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const state = yaml.parse(text);
  if (state && typeof state === 'object') rememberHash(state, text);
  return state;
}

// A run's declared inputs (card, effort, branch, ...) — {} when inputs.yaml is absent (not yet written).
function readInputs(processDir, runId) { return readYaml(path.join(runDir(processDir, runId), 'inputs.yaml')) || {}; }

// Written under the run's lock, to a temp file that is then renamed: the lock keeps two writers
// from interleaving, and the rename is atomic, so a concurrent reader sees either the old state or
// the new one, never a half-written file.
//
// A state object that came from readState is a read-modify-write. If the file changed after that
// read, another writer's update would be lost, so the write is refused instead (D-022). An object
// with no remembered read (a fresh launch, a hand-built state) writes as before. After a write the
// object remembers the text it wrote, so its owner can write it again.
function writeState(processDir, runId, state) {
  const dir = runDir(processDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.yaml');
  const text = yaml.stringify(state);
  locking.withLock(dir, () => {
    const seen = state && state[READ_HASH];
    if (seen) {
      const now = fs.existsSync(file) ? textHash(fs.readFileSync(file, 'utf8')) : null;
      if (now !== seen) throw new Error(`state.yaml for ${runId} changed since it was read — re-read and retry`);
    }
    locking.writeFileAtomic(file, text);
  });
  if (state && typeof state === 'object') rememberHash(state, text);
}

// A trailing line that fails to parse is a truncated write (crash mid-append) and is dropped;
// a malformed line anywhere else is corruption and must not be silently swallowed.
function readEvents(processDir, runId) {
  const file = path.join(runDir(processDir, runId), 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      out.push(JSON.parse(lines[i]));
    } catch (err) {
      if (i === lines.length - 1) continue;
      throw new Error(`corrupt event ledger at ${file}: unparsable line ${i + 1}`);
    }
  }
  return out;
}

// The ledger's kind vocabulary, read from schemas/event.schema.json so there is ONE list rather
// than a copy here that drifts from the schema the fsck validates against. Lazy + cached: schemas
// pulls in ajv, and a plain readState must not pay for it.
let cachedEventKinds = null;
function eventKinds() {
  if (!cachedEventKinds) cachedEventKinds = require('./schemas').loadSchemas().event.properties.kind.enum;
  return cachedEventKinds;
}

function appendEvent(processDir, runId, event) {
  // Three live events reached a real ledger with no `kind` at all, because the guard lived in
  // recordReceipt and every other writer went straight past it. It belongs HERE: appendEvent is the
  // one call every writer goes through, so a kindless or misspelt event cannot be written from any
  // call site. An event with no kind is invisible to every reader that filters by kind — it is a
  // receipt that silently does nothing.
  if (!event || !event.kind) throw new Error('an event needs a kind: ' + JSON.stringify(event));
  if (!eventKinds().includes(event.kind)) {
    throw new Error(`event kind ${event.kind} is not one of: ${eventKinds().join(', ')}`);
  }
  const dir = runDir(processDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  // The lock spans the read as well as the write: the new id is computed from the ledger's length,
  // so two writers that both read before either appends would both take the same id.
  return locking.withLock(dir, () => {
    const n = readEvents(processDir, runId).length + 1;
    const full = { id: 'e' + String(n).padStart(6, '0'), ts: new Date().toISOString(), run: runId, ...event };
    // A truncated trailing line (crash mid-append) is dropped rather than preserved: rewrite the
    // ledger to only its last-known-good lines before appending the new, complete event.
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1];
      let lastLineOk = lastLine === undefined;
      if (!lastLineOk) {
        try { JSON.parse(lastLine); lastLineOk = true; } catch (err) { lastLineOk = false; }
      }
      if (!lastLineOk) locking.writeFileAtomic(file, lines.slice(0, -1).map((l) => l + '\n').join(''));
    }
    fs.appendFileSync(file, JSON.stringify(full) + '\n');
    return full;
  });
}

// Rewrites the ledger under the run's lock. `edit(lines)` gets the ledger's raw lines as they are
// once the lock is held and returns the lines to keep; it throws to abandon the rewrite. The one
// writer that may drop lines is `plt fsck --fix`, and only the lines it proved are debris.
function rewriteEvents(processDir, runId, edit) {
  const dir = runDir(processDir, runId);
  const file = path.join(dir, 'events.jsonl');
  return locking.withLock(dir, () => {
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    const keep = edit(lines);
    locking.writeFileAtomic(file, keep.map((l) => l + '\n').join(''));
    return keep;
  });
}

function git(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
}

// ---- pin rule (spec §4) ----
function computePin(repoDir) {
  const status = git(repoDir, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean);
  const head = git(repoDir, ['rev-parse', 'HEAD']).trim();
  if (status.length === 0) {
    const tree = git(repoDir, ['rev-parse', 'HEAD^{tree}']).trim();
    return { kind: 'sha', value: head, tree };
  }
  const refused = status
    .filter((l) => l.startsWith('??') || l[1] !== ' ')          // untracked, or worktree differs from index
    .map((l) => l.slice(3).trim());
  if (refused.length) return { refused };
  return { kind: 'tree', value: git(repoDir, ['write-tree']).trim(), base_sha: head };
}

// ---- requirements are DERIVED from the step's keys ----
function resolveRef(v, config) {
  if (typeof v !== 'string') return v;
  if (!/^\{\{.*\}\}$/.test(v)) return v;
  const m = v.match(/^\{\{\s*config\.([\w.]+)\s*\}\}$/);
  if (!m) throw new Error(`only {{config.*}} references are supported: ${v}`);
  const r = m[1].split('.').reduce((o, k) => (o == null ? undefined : o[k]), config);
  if (r === undefined) throw new Error(`unresolved config reference {{config.${m[1]}}}`);
  return r;
}

// ANY gate.mode `{{config.*}}` ref defaults IN CODE when the key is missing, so a config key is an
// override, never a requirement: a project that upgrades the packs without adding the key must not
// crash `plt run launch|recompile`/`plt step start` (that live crash is exactly what this defaulting
// lookup fixes). There is deliberately NO whitelist of known keys — a whitelist has to be hand-synced
// in two files, and the first pack author to add an adversarial gate with a new key gets the original
// outage back.
//
// Which default applies is derived from the gate's OWN declaration, not from a list: the pack says
// which policy knob governs the gate (`{{config.review.panel_mode}}`, `{{config.review.writing_mode}}`),
// and the ruling is that a WRITING/prose review surfaces its findings and never blocks, while a
// panel/adversarial review holds the step until the reviewer passes. So a mode ref naming a
// writing/prose knob falls back to `banner`; every other mode ref falls back to `hard` — the safe
// default, which holds the step rather than silently letting a fail through. The rule is open, not a
// closed list: a knob a pack author invents tomorrow needs no code change either way. resolveRef
// itself is untouched and keeps throwing for every other unresolved {{config.*}} reference.
const GATE_MODE_FALLBACK = 'hard';
const WRITING_MODE_KEY = /(^|[._])(writing|prose)_mode$/;
function gateModeFallback(key) { return WRITING_MODE_KEY.test(key) ? 'banner' : GATE_MODE_FALLBACK; }
function resolveModeRef(v, config) {
  if (typeof v !== 'string') return v;
  const m = v.match(/^\{\{\s*config\.([\w.]+)\s*\}\}$/);
  if (!m) return resolveRef(v, config);
  try { return resolveRef(v, config); } catch (e) { return gateModeFallback(m[1]); }
}

function compileRequirements(step, config) {
  const out = [];
  const list = (v) => { const r = resolveRef(v, config); return Array.isArray(r) ? r : r ? [r] : []; };
  for (const n of list(step.skills)) out.push({ kind: 'skill', name: n });
  for (const n of list(step.tools)) out.push({ kind: 'tool', name: n });
  if (step.artifact) out.push({ kind: 'artifact', name: step.artifact });
  if (step.touches) out.push({ kind: 'touches', name: step.touches });
  // `files: [name, ...]` — a receipt the step's own tool records directly (`plt receipt --kind
  // file --name <name> --ref <path>`), for a step whose real work is a CLI command rather than a
  // skill/tool/agent the requirements vocabulary already names (e.g. `plt digest collect` writing
  // process/digests/<date>.json). Declared as `files` rather than `tools` so the compiled
  // requirement matches the receipt kind actually recorded.
  for (const n of list(step.files)) out.push({ kind: 'file', name: n });
  // An adversarial gate's `mode` (hard|banner, or a `{{config.review.*_mode}}` ref) travels with each
  // of its agent requirements: a `banner` agent's receipt never blocks — its fail verdict is shown
  // by prime as a warning, not held as a missing receipt. `hard` (the default) is the old behaviour
  // and is written as no `mode` key at all, so existing states and tests read unchanged.
  const adversarial = step.gate && step.gate.kind === 'adversarial';
  const gateMode = adversarial ? (resolveModeRef(step.gate.mode, config) || 'hard') : 'hard';
  if (!['hard', 'banner'].includes(gateMode)) throw new Error(`step ${step.id}: gate.mode ${gateMode} must be hard|banner`);
  const gateAgents = new Set(adversarial ? list(step.gate.agents) : []);
  const agents = new Set([...list(step.agents), ...gateAgents]);
  for (const n of agents) out.push(gateMode === 'banner' && gateAgents.has(n) ? { kind: 'agent', name: n, mode: 'banner' } : { kind: 'agent', name: n });
  if (step.gate && step.gate.kind === 'human') out.push({ kind: 'gate', name: step.gate.signal });
  if (step.gate && step.gate.kind === 'external') for (const c of list(step.gate.checks)) out.push({ kind: 'gh', name: c });
  if (step.verify && step.verify.gh) for (const v of list(step.verify.gh)) out.push({ kind: 'gh', name: v });
  if (step.jira) for (const k of ['on_start', 'on_done']) if (step.jira[k]) out.push({ kind: 'jira', name: `${k}:${resolveRef(step.jira[k], config)}` });
  // `overlap: effort` means "this run's inputs.effort"; a literal slug names an effort directly.
  // Resolved at gateCheck time (from readInputs), because compileRequirements has no run inputs.
  if (step.overlap) out.push({ kind: 'overlap', name: step.overlap === 'effort' ? '{{inputs.effort}}' : step.overlap });
  // `effort: dropped` — the run's card must be listed under `dropped:` in its effort file.
  // Evaluated live at gateCheck (the file is config the agent edits), never from a receipt.
  if (step.effort) out.push({ kind: 'effort', name: step.effort });
  return out;
}

// The fact collector's own path (lib/facts.js recordFacts) passes `[FACTS_COLLECTOR]: true`. A symbol,
// not a field: no CLI flag or JSON can set it, and it is never written to the ledger.
const FACTS_COLLECTOR = Symbol('facts collector');

function recordReceipt(processDir, runId, r) {
  if (!r.kind || !r.name) throw new Error('receipt needs --kind and --name');
  if (r.kind === 'gate') throw new Error('gate events are written only by gateApprove');
  // A verdict is two words, and both are load-bearing: gateCheck counts only `pass`, bannerFails
  // shows only `fail`. A live ledger carries one `verdict: approve` — a receipt that satisfies
  // nothing and warns nobody. Refuse it at the boundary rather than store a word no reader knows.
  if (r.verdict !== undefined && r.verdict !== null && !['pass', 'fail'].includes(r.verdict)) {
    throw new Error(`verdict ${r.verdict} must be pass or fail`);
  }
  if (!r.pin || r.pin.refused) throw new Error('receipt needs a pin: ' + JSON.stringify(r.pin));
  const st = readState(processDir, runId);
  assertRepo(processDir, runId, st, r);
  assertWindow(processDir, runId, st, r);
  // D-027: a receipt for a step that is not being worked (not started, or already done) is evidence
  // the spine did not collect. It is recorded and still counts — never refused — but it says so, and
  // renderers count it apart. A caller that knows better (the landing back-fill) passes it explicitly.
  // The fact collector (`plt facts`, on its own code path — not any receipt that says actor `facts`) records a gh fact on whichever step requires it,
  // often one not yet started (`merge` waits on pr-loop): that is the spine collecting evidence,
  // so it is expected, not out of band (D-027 as amended).
  const step = st && st.steps && r.step ? st.steps[r.step] : null;
  const collected = r[FACTS_COLLECTOR] === true && r.kind === 'gh' && step
    && (step.receipts_required || []).some((q) => q.kind === 'gh' && ghNameMatches(q.name, r.name));
  const outOfBand = r.out_of_band === true || (!collected && (!step || !WORKING.includes(step.status)));
  return appendEvent(processDir, runId, { kind: r.kind, step: r.step, name: r.name, pin: r.pin,
    session: r.session || null, actor: r.actor || 'agent', model: r.model, verdict: r.verdict, ref: r.ref, result: r.result, files: r.files,
    ...(outOfBand ? { out_of_band: true } : {}) });
}
const WORKING = ['in_progress', 'in_review'];

// ---- owner window (one window drives a run at a time) ----
//
// The caller's window is `PLT_WINDOW` — the env a seeded window exports (config `windows.open`
// renders `PLT_WINDOW={pane_id}`) — else null. `stepStart` claims it as `state.owner_window`;
// `writeHandoff` and `closeRun` release it. A call from a different window is refused until the
// driver hands off — or the caller passes `--take-over`, which is logged as a `taken-over` time
// event and moves the claim. A null caller window never claims and is never blocked, so a run
// driven from a plain shell works exactly as before.
//
// It must NOT fall back to the run's own `inputs.window.tab_id`: that is what the run RECORDS, not
// who is calling, so every caller on the run resolved to the same value and `assertWindow` could
// never see two windows — the guard was inert and the collision it exists to stop happened anyway.
function callerWindow(processDir, runId, opts = {}) {
  if (opts.window !== undefined) return opts.window === null ? null : String(opts.window);
  return process.env.PLT_WINDOW || null;
}

// Refuses the call when another window drives `st`; with `takeOver` moves the claim (state is
// written) and records the event. Returns the caller's window for the caller to claim.
function assertWindow(processDir, runId, st, opts = {}) {
  const mine = callerWindow(processDir, runId, opts);
  const owner = st && st.owner_window ? String(st.owner_window) : null;
  if (!owner || !mine || owner === mine) return mine;
  if (!opts.takeOver) throw new Error(`run ${runId} is driven by window ${owner}; hand off first (or --take-over)`);
  st.owner_window = mine;
  writeState(processDir, runId, st);
  appendEvent(processDir, runId, { kind: 'time', what: 'taken-over', step: st.current_step || null, from: owner, window: mine, actor: 'agent', pin: st.pin || null });
  return mine;
}

// ---- repo window (one window drives a repo checkout at a time) ----
//
// `owner_window` guards a RUN; this guards the checkout the run works in. A repo claimed with
// `plt repo claim` refuses any other window until it is released or re-claimed with `--take-over`.
// A caller with no window (the watch timer, a poll, a plain shell) passes, as it passes the run
// guard: the guard separates interactive windows, and a background job is not one. A run with no
// `repo_dir` (a spike) has no checkout to guard. It runs before `assertWindow`, so a refused call
// never half-applies a run take-over.
function assertRepo(processDir, runId, st, opts = {}) {
  if (!st || !st.repo_dir) return;
  const mine = callerWindow(processDir, runId, opts);
  if (!mine) return;
  repoWindow.assertRepoWindow(st.repo_dir, mine);
}

// A receipt's pin counts against the current pin when the values match, or (spec §4 tree/sha
// equivalence) when the receipt was recorded against the staged tree that HEAD's sha now snapshots.
function pinMatches(evPin, pin) {
  if (!evPin) return false;
  if (evPin.value === pin.value) return true;
  return Boolean(pin.tree) && evPin.value === pin.tree;
}

// gh fact names are spelled with a hyphen (`checks-green`) in the shipped packs, `run poll` and the
// validator's verify.gh list. Older receipts and private overlays may still carry `checks_green`, so
// names are normalised to compare and an existing receipt keeps counting under either spelling
// (fsck reports the mismatch as W_GH_NAME_SPELLING). Never used to store or rewrite a name: a step's
// requirement and a receipt each keep their own spelling.
function normalizeGhName(s) { return String(s == null ? '' : s).replace(/_/g, '-'); }

function ghNameMatches(a, b) { return normalizeGhName(a) === normalizeGhName(b); }

function satisfies(req, ev, pin, events) {
  if (ev.kind !== req.kind) return false;
  if (req.kind === 'gh' ? !ghNameMatches(ev.name, req.name) : ev.name !== req.name) return false;
  if (!pinMatches(ev.pin, pin)) return false;
  if (req.kind === 'agent') return ev.verdict === 'pass';
  if (req.kind === 'gate') {
    if (ev.result !== 'approve' || ev.actor !== 'human' || typeof ev.by !== 'string' || ev.by.length === 0) return false;
    // A later revoke that names this approval cancels it; the log keeps both.
    return !(events || []).some((r) => r.kind === 'gate' && r.result === 'revoke' && r.step === ev.step && r.revokes === ev.id);
  }
  if (req.kind === 'gh') return ev.result === 'pass';
  return true;
}

// The banner-mode reviewers of a step whose LATEST verdict at the current pin is `fail` — a
// warning prime prints as `⚠ banner: <agent> failed`, never a missing receipt. Latest per agent:
// an earlier fail that a later pass overturned is not a warning (events are chronological).
function bannerFails(step, events, pin) {
  const out = [];
  for (const req of (step.receipts_required || []).filter((r) => r.kind === 'agent' && r.mode === 'banner')) {
    const mine = events.filter((e) => e.kind === 'agent' && e.name === req.name && (!pin || pinMatches(e.pin, pin)));
    const last = mine[mine.length - 1];
    if (last && last.verdict === 'fail') out.push(req.name);
  }
  return out;
}

// `cards: external` in a cycle's frontmatter means the run tracks work we do not own (someone else's
// pull request). Our board has no card for it, so jira requirements compiled from the formula are not
// checked. Anything else — receipts, gates, gh facts — is unchanged.
function externalCards(processDir, state) {
  if (!state || !state.cycle) return false;
  try { return loadFormula(processDir, state.cycle).cards === 'external'; } catch (e) { return false; }
}

function gateCheck(processDir, runId, stepId, repoDir) {
  const state = readState(processDir, runId);
  if (!state || !state.steps[stepId]) throw new Error(`no step ${stepId} in run ${runId}`);
  const pin = computePin(repoDir || state.repo_dir);
  if (pin.refused) return { ok: false, pin, missing: pin.refused.map((f) => ({ kind: 'pin', name: f, reason: 'stage or ignore; a gate never pins what it cannot hash' })), banner: [] };
  if (!('receipts_required' in state.steps[stepId])) {
    return { ok: false, pin, missing: [{ kind: 'requirements', name: stepId, reason: 'no requirements compiled — launch the run with plt' }], banner: [] };
  }
  const events = readEvents(processDir, runId).filter((e) => e.step === stepId);
  const missing = [];
  // A banner requirement never blocks `ok` (see bannerFails), but a reviewer that never ran must
  // not be invisible to `plt gate check` — collected here from the same latest-receipt-at-pin
  // lookup the hard path uses, reported alongside (never inside) `missing`.
  const banner = [];
  for (const req of state.steps[stepId].receipts_required || []) {
    if (req.kind === 'overlap' || req.kind === 'effort') continue;   // no receipt event — checked live below
    // A cycle whose frontmatter says `cards: external` runs on someone else's work (an inbound PR
    // review): there is no ticket of ours to transition, so a formula's jira step does not apply.
    if (req.kind === 'jira' && externalCards(processDir, state)) continue;
    if (req.kind === 'agent' && req.mode === 'banner') {
      const mine = events.filter((e) => e.kind === 'agent' && e.name === req.name && pinMatches(e.pin, pin));
      const last = mine[mine.length - 1];
      banner.push({ kind: req.kind, name: req.name, state: last ? (last.verdict === 'pass' ? 'pass' : 'fail') : 'unseen' });
      continue;                                                      // a banner reviewer never blocks (see bannerFails)
    }
    // A loop step re-opened by `repeat_until` asks the human again: an approval given before the
    // re-open was for the last round (the last reply), not this one. Only THIS step's re-open counts
    // (`events` is already this step's; the test is explicit so a later refactor cannot widen it).
    const cut = events.map((e, i) => (e.what === 'repeated' && e.step === stepId ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const pool = req.kind === 'gate' ? events.slice(cut + 1) : events;
    if (!pool.some((e) => satisfies(req, e, pin, events))) {
      const stale = events.some((e) => e.kind === req.kind && (req.kind === 'gh' ? ghNameMatches(e.name, req.name) : e.name === req.name) && !pinMatches(e.pin, pin));
      missing.push({ ...req, reason: stale ? 'receipt exists at an older pin — re-run' : 'no receipt' });
    }
  }
  // `overlap` is declared in the formula but evaluated live against in-flight sibling runs and
  // (at open-pr/merge only) against origin/main freshness — not from a receipt event. Its `name`
  // is either the literal effort slug the step declared, or the placeholder meaning "this run's
  // own inputs.effort" — resolved here, since compileRequirements has no run inputs to read.
  const overlapReq = (state.steps[stepId].receipts_required || []).find((r) => r.kind === 'overlap');
  if (overlapReq) {
    const effort = require('./effort');   // lazy require: effort.js requires spine at its top
    const effortSlug = overlapReq.name === '{{inputs.effort}}' ? readInputs(processDir, runId).effort : overlapReq.name;
    // Pass the LIVE pin just computed above — overlapCheck falls back to state.pin only when none is given.
    const oc = effort.overlapCheck(processDir, runId, { repoDir: repoDir || state.repo_dir, pin, effortSlug });
    for (const s of oc.shared) {
      missing.push({ kind: 'overlap', name: s.run, reason: `${s.files.length} file(s) also changed by ${s.run}: ${s.files.slice(0, 3).join(', ')}${s.files.length > 3 ? ' …' : ''}` });
    }
    if (['open-pr', 'merge'].includes(stepId) && !oc.baseFresh) {
      const head = pin.kind === 'tree' ? pin.base_sha : pin.value;
      missing.push({ kind: 'base', name: 'origin/main', reason: `branch base ${String(head).slice(0, 8)} is behind origin/main ${String(oc.mainSha).slice(0, 8)} — rebase, then re-pin` });
    }
  }
  // `effort: dropped` reads the effort file named by this run's inputs and looks for the card under
  // `dropped:` — as a bare id or `{ id, reason, replaced_by }`. The planner reads the same list.
  for (const req of (state.steps[stepId].receipts_required || []).filter((r) => r.kind === 'effort')) {
    const effort = require('./effort');
    const slug = readInputs(processDir, runId).effort;
    if (!slug) { missing.push({ ...req, reason: 'run has no inputs.effort to check' }); continue; }
    let listed;
    try { listed = effort.droppedIds(processDir, slug).includes(runId); } catch (e) { missing.push({ ...req, reason: e.message }); continue; }
    if (!listed) missing.push({ ...req, reason: `${runId} is not listed under \`${req.name}:\` in efforts/${slug}.yaml` });
  }
  return { ok: missing.length === 0, pin, missing, banner };
}

function gateApprove(processDir, runId, stepId, { by, repoDir, window, takeOver } = {}) {
  const state = readState(processDir, runId);
  if (!state || !state.steps[stepId]) throw new Error(`no step ${stepId} in run ${runId}`);
  if (typeof by !== 'string' || by.length === 0) throw new Error('gateApprove needs --by');
  assertHuman(processDir, runId, by);
  assertWindow(processDir, runId, state, { window, takeOver });
  const pin = computePin(repoDir || state.repo_dir);
  if (pin.refused) throw new Error('stage or ignore; a gate never pins what it cannot hash: ' + pin.refused.join(', '));
  // A done step is re-approvable only when the tree moved on after the approval (the gate check
  // at the current pin fails on a stale receipt). Approving twice at the same pin is refused.
  if (state.steps[stepId].status === 'done') {
    if (gateCheck(processDir, runId, stepId, repoDir || state.repo_dir).ok) {
      throw new Error(`step ${stepId} is already done and approved at this pin`);
    }
    // A moved tree is a follow-on change (a CI fix, a review fix). The formula may demand that it
    // gets its own page before the owner re-approves: `reapprove: { artifact: <name> }` on the step.
    // The requirement is read from the formula here, not compiled into receipts_required, because it
    // applies only to the second and later approvals — the first one has the step's own artifact.
    const reapprove = state.cycle && (runFormula(processDir, state).steps.find((s) => s.id === stepId) || {}).reapprove;
    if (reapprove && reapprove.artifact) {
      const has = readEvents(processDir, runId).some((e) => e.kind === 'artifact' && e.name === reapprove.artifact && pinMatches(e.pin, pin));
      if (!has) {
        throw new Error(`step ${stepId} was approved at an older pin; a follow-on change needs its own page — publish the ${reapprove.artifact} artifact for this tree before re-approving`);
      }
    }
  }
  const req = (state.steps[stepId].receipts_required || []).find((r) => r.kind === 'gate');
  if (!req) throw new Error(`step ${stepId} has no human gate`);
  const wasDone = state.steps[stepId].status === 'done';
  const ev = appendEvent(processDir, runId, { kind: 'gate', step: stepId, name: req.name, result: 'approve', by: personOf(by) || by, pin, actor: 'human' });
  // A re-approval means a follow-on change is about to be pushed. Steps named in `reapprove.rearm`
  // (the owner's "ask for reviews" step) come back to ready so their banner shows again: a push
  // after approval dismisses the reviewers' approvals, and someone has to ask for them again.
  if (wasDone && state.cycle) {
    const def = runFormula(processDir, state).steps.find((s) => s.id === stepId) || {};
    const rearm = (def.reapprove && def.reapprove.rearm) || [];
    if (rearm.length) {
      const st = readState(processDir, runId);
      const rearmed = [];
      for (const id of rearm) if (st.steps[id] && st.steps[id].status === 'done') { st.steps[id].status = 'ready'; st.steps[id].outcome = null; st.steps[id].finished = null; rearmed.push(id); }
      if (rearmed.length) { writeState(processDir, runId, st); appendEvent(processDir, runId, { kind: 'time', what: 'rearmed', step: stepId, rearmed, actor: 'agent', pin }); }
    }
  }
  // A step parked in_review (its ONLY missing requirement was this human gate) settles to done
  // the moment the gate is satisfied — there is otherwise no other path from in_review to done.
  // Only real launched runs carry `cycle` (ad-hoc states built directly in tests do not); skip
  // settling for those rather than fail trying to load a formula that was never launched.
  // A manual owner step (`reply`, `announce`) is never started by an agent, so it settles straight
  // from ready when the owner's gate is its only requirement.
  const after = readState(processDir, runId);
  if (after.cycle && ['in_review', 'ready', 'in_progress'].includes(after.steps[stepId].status)) {
    const g = gateCheck(processDir, runId, stepId, repoDir || after.repo_dir);
    if (g.ok) {
      const wf = runFormula(processDir, after);
      after.steps[stepId].outcome = after.steps[stepId].outcome || repeatOutcome(wf.steps.find((s) => s.id === stepId));
      settle(processDir, runId, stepId, wf, after, g.pin);
    }
  }
  return ev;
}

// `config.actors.humans` is the list of people who may pass a human gate. An agent shell can type any
// name, so the engine refuses one that is not on the list (with or without a `human:` prefix). A
// config with no list keeps the old behaviour — the tests' ad-hoc process dirs have none.
// `actor` is the ROLE that wrote an event (agent|human|facts|hook) and `by` is the PERSON. Gate
// events have always written them that way; closeRun and discardRun put the raw `--by` value in
// `actor`, so one live ledger carries `actor: alice` and another `actor: human:alice` for the
// same person and the same act. One form wins: the role in `actor`, the bare name in `by`, because
// that is the split every reader already relies on and the only one an enum can describe. The
// `human:` prefix stays CLI sugar and is stripped once, here, at the boundary.
function personOf(by) {
  if (typeof by !== 'string') return null;
  const name = by.replace(/^human:/, '').trim();
  return !name || name === 'agent' ? null : name;
}
function actorFields(by) {
  const person = personOf(by);
  return person ? { actor: 'human', by: person } : { actor: 'agent' };
}

function assertHuman(processDir, runId, by) {
  let humans = null;
  try { const cfg = loadConfig(processDir, runId); humans = cfg && cfg.actors && Array.isArray(cfg.actors.humans) ? cfg.actors.humans : null; } catch (e) { humans = null; }
  if (!humans || humans.length === 0) return;
  const name = String(by).replace(/^human:/, '');
  if (!humans.includes(name)) throw new Error(`--by ${by} is not a human in config.actors.humans (${humans.join(', ')}); a human gate is passed by a person`);
}

// Cancels an earlier approval by event id. Append-only: the approval stays in the log, the revoke
// points at it, and gateCheck no longer counts it. Used when an approval was written by mistake —
// a probe, a wrong --by — so the record stays honest instead of being edited.
function gateRevoke(processDir, runId, stepId, { by, eventId, reason }) {
  const state = readState(processDir, runId);
  if (!state || !state.steps[stepId]) throw new Error(`no step ${stepId} in run ${runId}`);
  if (typeof by !== 'string' || by.length === 0) throw new Error('gateRevoke needs --by');
  if (!eventId) throw new Error('gateRevoke needs --event <id of the approval to revoke>');
  assertHuman(processDir, runId, by);
  const target = readEvents(processDir, runId).find((e) => e.id === eventId);
  if (!target || target.kind !== 'gate' || target.result !== 'approve' || target.step !== stepId) {
    throw new Error(`${eventId} is not an approval on step ${stepId}`);
  }
  const ev = appendEvent(processDir, runId, { kind: 'gate', step: stepId, name: target.name, result: 'revoke', revokes: eventId, by: personOf(by) || by, reason: reason || null, pin: target.pin, actor: 'human' });
  // If the revoked approval was the one that settled the step, it must not stay done on a lie.
  const st = readState(processDir, runId);
  if (st.steps[stepId].status === 'done' && !gateCheck(processDir, runId, stepId, st.repo_dir).ok) {
    st.steps[stepId].status = 'in_review'; st.steps[stepId].finished = null;
    writeState(processDir, runId, st);
  }
  return ev;
}

// ---- formulas (cycles), runs, steps, handoff and prime ----

function packsDir() { return path.resolve(__dirname, '..', 'workflows', 'packs'); }

// The formula as written: the cycle file, and — for an overlay (`extends: <pack>/<name>`) — the
// pack formula it extends, merged by step id. Steps keep their parser line (`__line`), and `origin`
// says which file each step's line is in, so a validation error can name the file a person edits.
function formulaSource(processDir, cycleName) {
  const file = path.join(processDir, 'cycles', `${cycleName}.md`);
  const own = parseWorkflow(fs.readFileSync(file, 'utf8'));
  const origin = new Map((own.steps || []).map((s) => [s.id, file]));
  if (!own.fm || !own.fm.extends) return { file, own, base: null, baseFile: null, steps: own.steps || [], origin };
  const [pack, name] = String(own.fm.extends).split('/');
  const baseFile = path.join(packsDir(), pack, `${name}.md`);
  const base = parseWorkflow(fs.readFileSync(baseFile, 'utf8'));
  const byId = new Map((base.steps || []).map((s) => [s.id, { ...s }]));
  for (const s of base.steps || []) if (!origin.has(s.id)) origin.set(s.id, baseFile);
  for (const s of own.steps || []) byId.set(s.id, { ...(byId.get(s.id) || {}), ...s });
  return { file, own, base, baseFile, steps: [...byId.values()], origin };
}

function loadFormula(processDir, cycleName) {
  const { file, own, base, steps } = formulaSource(processDir, cycleName);
  if (own.errors.length) throw new Error(`${file}: ${own.errors.map((e) => `${e.line}: ${e.msg}`).join('; ')}`);
  const version = base ? `${base.fm.version || 1}+${own.fm.version || 1}` : own.fm.version || 1;
  // `cards` travels with the formula (an overlay may set it, else the base's): `external` means the run
  // tracks work we do not own, so jira requirements never apply. Anything else stays step-level.
  return { name: cycleName, version, cards: own.fm.cards || (base && base.fm.cards), steps: steps.map(({ __line, __indent, ...s }) => s) };
}

// Template names a formula may name as an `artifact`: the ones plt resolves, plus the process
// directory's own `templates/` (a project template such as an effort index lives there).
function formulaTemplates(processDir) {
  const plt = require('../bin/plt');
  const names = plt.templateNames();
  const dir = path.join(processDir, 'templates');
  if (fs.existsSync(dir)) {
    for (const f of plt.walk(dir, [])) {
      const { fm } = plt.parseFrontmatter(fs.readFileSync(f, 'utf8'));
      if (fm && fm.kind === 'template' && fm.name) names.add(fm.name);
    }
  }
  return names;
}

// validateFormula(processDir, cycleName) -> [{file, line, msg}] — the validator run on what launches:
// an overlay merged with its base, not the overlay file alone (an overlay that only overrides
// `notes` has no `steps` of its own to pass). The config and on-disk checks use this process dir.
// `file` is shown relative to the project (`process/cycles/x.md`) or to the templates repo.
function validateFormula(processDir, cycleName) {
  const { validateWorkflow, buildOpts } = require('./validate');
  const src = formulaSource(processDir, cycleName);
  const union = (a, b) => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];
  const parsed = !src.base ? src.own : { ...src.own, steps: src.steps,
    fm: { ...src.base.fm, ...src.own.fm, inputs: union(src.base.fm.inputs, src.own.fm.inputs), actors: union(src.base.fm.actors, src.own.fm.actors) } };
  const errors = validateWorkflow(parsed, src.file, formulaTemplates(processDir), buildOpts(processDir));
  const show = (f) => {
    const project = path.dirname(processDir);
    return f.startsWith(project + path.sep) ? path.relative(project, f) : path.relative(path.resolve(__dirname, '..'), f);
  };
  const out = errors.map((e) => {
    const m = /^step `([^`]+)`/.exec(e.msg);
    return { file: show((m && src.origin.get(m[1])) || src.file), line: e.line, msg: e.msg };
  });
  if (src.base) for (const e of src.base.errors) out.push({ file: show(src.baseFile), line: e.line, msg: e.msg });
  return out;
}

// D-025: a formula that fails validation does not launch. Throws one line per error, before any write.
function assertFormulaValid(processDir, cycleNames) {
  const errors = cycleNames.flatMap((c) => validateFormula(processDir, c));
  if (errors.length) throw new Error(errors.map((e) => `formula ${e.file}:${e.line}: ${e.msg}`).join('\n'));
}

function recompileRun(processDir, runId) {
  const st = readState(processDir, runId);
  if (!st || !st.steps) throw new Error(`run ${runId} is not launched`);
  assertFormulaValid(processDir, [st.cycle, st.exit].filter(Boolean));
  const config = loadConfig(processDir, runId);
  const wf = runFormula(processDir, st);
  for (const s of wf.steps) {
    let step = st.steps[s.id];
    if (!step) {
      // A step added to the formula after launch: pending, or ready when everything it needs is done.
      const needsDone = (s.needs || []).every((n) => st.steps[n] && st.steps[n].status === 'done');
      const initial = !s.needs && !s.when && !s.else_of;
      step = st.steps[s.id] = { status: (!s.arm_on && (initial || (s.needs && needsDone && !s.when))) ? 'ready' : 'pending', outcome: null, started: null, finished: null };
    }
    if (step.status === 'done') continue;
    step.receipts_required = compileRequirements(s, config);
  }
  writeState(processDir, runId, st);
  appendEvent(processDir, runId, { kind: 'time', what: 'recompiled', step: null, actor: 'agent', pin: st.pin || null });
  return st;
}

// The formula a run is on right now: its cycle's steps, with the exit formula's steps laid over
// them by id once `plt run discard` has moved the run onto an exit (`state.exit`). Every reader of
// step definitions after launch goes through here, so an exit step named like a cycle step
// (`close-out`) resolves to the exit's definition.
function runFormula(processDir, st) {
  const cycle = loadFormula(processDir, st.cycle);
  if (!st.exit) return cycle;
  const exit = loadFormula(processDir, st.exit);
  const byId = new Map(cycle.steps.map((s) => [s.id, s]));
  for (const s of exit.steps) byId.set(s.id, s);
  return { ...cycle, steps: [...byId.values()], exit: exit.name };
}

// Move a run onto the `discard` exit. The owner's decision IS the human gate: this records it in
// their name (`run-discarded` on the exit's `drop` step), retires every unfinished step of the cycle
// as `discarded`, and appends the exit's steps so the agent walks `record` and `close-out` with
// receipts like any other step. Refused on a closed run, without a reason, or on an unpinnable
// tree (stage or stash first — a gate never pins what it cannot hash).
function discardRun(processDir, runId, { by, reason, replacedBy } = {}) {
  const st = readState(processDir, runId);
  if (!st || !st.steps) throw new Error(`run ${runId} is not launched`);
  if (st.status === 'closed') throw new Error(`run ${runId} is closed`);
  if (st.exit) throw new Error(`run ${runId} is already on the ${st.exit} exit`);
  if (typeof by !== 'string' || by.length === 0) throw new Error('discardRun needs --by');
  if (typeof reason !== 'string' || reason.trim().length === 0) throw new Error('discardRun needs --reason: why the card is dropped');
  assertHuman(processDir, runId, by);
  const pin = computePin(st.repo_dir);
  if (pin.refused) throw new Error('stage or ignore; a gate never pins what it cannot hash: ' + pin.refused.join(', '));
  const config = loadConfig(processDir, runId);
  const exit = loadFormula(processDir, 'discard');
  const retired = [];
  for (const [id, step] of Object.entries(st.steps)) {
    if (step.status === 'done') continue;
    step.status = 'skipped'; step.outcome = 'discarded'; retired.push(id);
  }
  st.current_step = null;
  st.exit = 'discard';
  const initial = new Set(exit.steps.filter((s) => !s.needs && !s.when && !s.else_of).map((s) => s.id));
  for (const s of exit.steps) {
    st.steps[s.id] = { status: initial.has(s.id) ? 'ready' : 'pending', outcome: null,
      receipts_required: compileRequirements(s, config), started: null, finished: null };
  }
  writeState(processDir, runId, st);
  appendEvent(processDir, runId, { kind: 'time', what: 'discarded', step: null, ...actorFields(by), pin, reason, replaced_by: replacedBy || null, retired });
  const gateStep = exit.steps.find((s) => s.gate && s.gate.kind === 'human');
  if (gateStep) {
    appendEvent(processDir, runId, { kind: 'gate', step: gateStep.id, name: gateStep.gate.signal, result: 'approve', by: personOf(by) || by, pin, actor: 'human', reason, replaced_by: replacedBy || null });
    const after = readState(processDir, runId);
    after.steps[gateStep.id].outcome = 'discarded';
    settle(processDir, runId, gateStep.id, runFormula(processDir, after), after, pin);
  }
  return readState(processDir, runId);
}

// Close a run whose close-out is done: retire every step still ready/pending (standing steps such
// as `reply` never finish on their own) and mark the run closed so renderers stop offering it work.
function closeRun(processDir, runId, { by = 'agent', warn = (m) => process.stderr.write(m + '\n') } = {}) {
  let st = readState(processDir, runId);
  if (!st || !st.steps) throw new Error(`run ${runId} is not launched`);
  if (st.status === 'closed') return st;
  const co = st.steps['close-out'];
  if (!co || co.status !== 'done') throw new Error(`run ${runId}: close-out is not done; finish it before closing the run`);
  if (st.current_step) throw new Error(`run ${runId}: step ${st.current_step} is still in progress`);

  // Final facts snapshot: a run closed without ever capturing its terminal PR state left the run
  // page showing "not collected yet" forever (T1 concern). Best-effort, before marking closed: if
  // the run names a PR and state.facts is missing or older than the newest gh receipt, take one
  // facts.prFacts snapshot and record it — same mechanism `plt facts` uses live. Lazy-required
  // (facts.js requires spine at its top, like effort.js) and never allowed to fail the close. A run
  // with no PR or no pr_repo has nothing to snapshot and skips silently; a gh failure (no `gh`,
  // GitHub unreachable, a 404) is a warning through `warn` that names the command to retry with.
  try {
    const factsMod = require('./facts');
    const prNumber = factsMod.findPrNumber(processDir, runId);
    if (prNumber != null) {
      const ghEvents = readEvents(processDir, runId).filter((e) => e.kind === 'gh');
      const newestGh = ghEvents.reduce((m, e) => (!m || e.ts > m ? e.ts : m), null);
      const stale = !st.facts || (newestGh && (!st.facts.at || st.facts.at < newestGh));
      if (stale) {
        // The per-run resolution (inputs.repo, then the pr URL, then the config default) — the
        // config default alone would snapshot a different repo's PR of the same number.
        const repo = factsMod.findPrRepo(processDir, runId, loadConfig(processDir, runId));
        if (repo) {
          const f = factsMod.prFacts(factsMod.defaultGh, repo, prNumber);
          factsMod.recordFacts(processDir, runId, f);
        }
      }
    }
  } catch (e) {
    // gh's own stderr says why (`HTTP 404`, `not logged in`); the error message is the command line.
    const why = [e.stderr, e.message].map((t) => String(t || '').split('\n').map((l) => l.trim()).find(Boolean)).find(Boolean);
    warn(`plt run close: ${runId}: final facts snapshot skipped — ${why}; run \`plt facts --run ${runId}\` once gh answers`);
  }
  // Re-read whatever happened above: recordFacts may have written state (the fresh state.facts, or
  // a partial write before a throw), and writing the copy read before it would be refused as stale.
  st = readState(processDir, runId);

  const retired = [];
  for (const [id, step] of Object.entries(st.steps)) {
    if (step.status === 'ready' || step.status === 'pending') { step.status = 'skipped'; step.outcome = 'retired'; retired.push(id); }
  }
  st.status = 'closed';
  // Clearing the claim here is correct even from a caller with no window of its own: the run is
  // closed, so the claim guards nothing — no step can be started, finished or receipted against it
  // again. This is a teardown, not a release to another driver (that is `writeHandoff`'s job, and
  // there an anonymous caller must NOT clear someone else's claim).
  st.owner_window = null;
  st.closed = new Date().toISOString();
  // What the closed run means to the planner: `done` satisfies an `after:` dependency; `discarded` never does.
  st.closed_as = st.exit === 'discard' ? 'discarded' : 'done';
  writeState(processDir, runId, st);
  appendEvent(processDir, runId, { kind: 'time', what: 'closed', step: null, ...actorFields(by), pin: st.pin || null, retired, closed_as: st.closed_as });
  return st;
}

function launchRun(processDir, { runId, cycle, repoDir, owner, estimate }) {
  const existing = readState(processDir, runId);
  if (existing && existing.estimate && estimate !== undefined && existing.estimate.value !== estimate) {
    throw new Error(`estimate for ${runId} is ${existing.estimate.value} and is never re-pointed`);
  }
  if (existing && existing.steps) {
    throw new Error(`run ${runId} is already launched (a reset is a later --reset)`);
  }
  if (estimate !== undefined && !Number.isFinite(estimate)) throw new Error('estimate must be a number');
  assertFormulaValid(processDir, [cycle]);
  const config = loadConfig(processDir, runId);
  const wf = loadFormula(processDir, cycle);
  const pin = computePin(repoDir);
  const initial = new Set(wf.steps.filter((s) => !s.needs && !s.when && !s.else_of).map((s) => s.id));
  const steps = {};
  for (const s of wf.steps) {
    steps[s.id] = { status: initial.has(s.id) ? 'ready' : 'pending', outcome: null,
      receipts_required: compileRequirements(s, config), started: null, finished: null };
  }
  const state = {
    // `status` is written at launch, not only at close: a run with no status is not an open run,
    // it is a run whose state file cannot be read by anything that keys off open vs closed.
    run: runId, cycle, status: 'open', formula_version: wf.version, repo_dir: repoDir, owner: owner || null,
    created: (existing && existing.created) || new Date().toISOString(),
    estimate: existing && existing.estimate ? existing.estimate
      : estimate !== undefined ? { unit: (config.estimation && config.estimation.unit) || 'ideal_days', value: estimate } : null,
    pin: pin.refused ? null : pin, current_step: null, steps,
  };
  writeState(processDir, runId, state);
  appendEvent(processDir, runId, { kind: 'time', what: 'claimed', step: null, actor: 'agent', pin: state.pin });
  return state;
}

// Undo a step that was started in error. A step can be started by mistake — an agent spawned into
// a run tab reads the prime and acts on it — and until now the only ways back were to leave it
// `in_progress` forever or to hand-edit the ledger, which the stop rules forbid for good reason.
//
// It refuses a step that recorded ANY receipt: this returns a step that never produced evidence to
// where it was, it does not erase work. The step goes back to `ready` or `pending` by the same rule
// launch and recompile use, so an unstarted step is armed exactly as if it had never run, and the
// reason is appended as an event — the ledger records that a person corrected it, not that it never
// happened.
function stepUnstart(processDir, runId, stepId, { reason, by, window, takeOver } = {}) {
  let st = readState(processDir, runId);
  let step = st.steps[stepId];
  if (!step) throw new Error(`no step ${stepId}`);
  // A step still named as `current_step` while its own status has moved on is the same corruption,
  // half-applied — an earlier unstart that released the status and not the claim, or a crash between
  // the two writes. Repairing that is the same operation, so it is allowed rather than left stuck:
  // `start` refuses a pending step, so there would otherwise be no way back.
  const stranded = st.current_step === stepId && step.status !== 'in_progress';
  if (step.status !== 'in_progress' && !stranded) {
    throw new Error(`step ${stepId} is ${step.status}; only in_progress can be unstarted`);
  }
  if (!reason) throw new Error('unstart needs --reason: the ledger records why, not just that');
  const receipts = readEvents(processDir, runId).filter((e) => e.step === stepId && e.kind !== 'time');
  if (receipts.length) throw new Error(`step ${stepId} has ${receipts.length} receipt(s); finish or discard it, do not unstart it`);
  // The guards every step writer takes: a window that does not drive the run (or hold its repo) is
  // refused, or moves the claim with --take-over, which is logged as a `taken-over` event.
  assertRepo(processDir, runId, st, { window, takeOver });
  assertWindow(processDir, runId, st, { window, takeOver });
  st = readState(processDir, runId);   // a take-over wrote state
  step = st.steps[stepId];
  const wf = runFormula(processDir, st);
  const def = (wf.steps || []).find((x) => x.id === stepId) || {};
  // Re-arm by launch's own rule (see launchRun), so an unstarted step is armed exactly as it would
  // have been had it never run — not by a second, subtly different rule that drifts from it.
  const needsDone = (def.needs || []).every((n) => st.steps[n] && st.steps[n].status === 'done');
  const initial = !def.needs && !def.when && !def.else_of;
  step.status = (!def.arm_on && (initial || (def.needs && needsDone && !def.when))) ? 'ready' : 'pending';
  step.started = null; step.outcome = null; step.finished = null;
  // stepStart also sets `current_step` and claims `owner_window`. Undoing the status alone left the
  // prime still saying "finish this step" and the run still claimed by the window that started it
  // by mistake — the step read pending while everything around it read in flight.
  const claimedHere = st.current_step === stepId;
  if (claimedHere) { delete st.current_step; delete st.owner_window; }
  writeState(processDir, runId, st);
  appendEvent(processDir, runId, { kind: 'time', what: 'unstarted', step: stepId, reason, actor: by || 'human',
    released: claimedHere || undefined });
  return st;
}

function stepStart(processDir, runId, stepId, { session, window, takeOver } = {}) {
  let st = readState(processDir, runId);
  const step = st.steps[stepId];
  if (!step) throw new Error(`no step ${stepId}`);
  if (step.status !== 'ready') throw new Error(`step ${stepId} is ${step.status}, not ready`);
  assertRepo(processDir, runId, st, { window, takeOver });
  const mine = assertWindow(processDir, runId, st, { window, takeOver });
  st = readState(processDir, runId);   // a take-over wrote state
  // The requirements are recompiled from the formula + config as they are NOW, not as they were at
  // launch: a reviewer added to config.review.*, a gate flipped to banner, lands on the next start.
  if (st.cycle) {
    const def = runFormula(processDir, st).steps.find((x) => x.id === stepId);
    if (def) st.steps[stepId].receipts_required = compileRequirements(def, loadConfig(processDir, runId));
  }
  st.steps[stepId].status = 'in_progress'; st.steps[stepId].started = new Date().toISOString(); st.current_step = stepId;
  if (mine) st.owner_window = mine;
  writeState(processDir, runId, st);
  appendEvent(processDir, runId, { kind: 'time', what: 'started', step: stepId, session: session || null, window: mine, actor: 'agent', pin: computePin(st.repo_dir) });
  return st;
}

// Marks a step done, propagates readiness to its dependents, clears current_step if it was the
// active one, and writes the `finished` time event. Shared by stepFinish (the non-human-gated
// path) and gateApprove (the in_review -> done path, once the gate itself is satisfied).
// pre-pr drift: the `touches` receipt declared at scope (files/prefixes) vs. what actually changed
// by the time pre-pr settles. Every actual file outside every declared prefix is one non-blocking
// `extrapolation` event — flagging scope creep the run page surfaces under "Extrapolations", not a
// gate. No `touches` receipt recorded → nothing to compare against → no drift events. The diff
// runs from the branch base (effort.branchBase: merge-base with origin/main, else the LAUNCH pin's
// commit, else HEAD) — never from the settling pin, whose base_sha is the current HEAD and would
// hide every commit the branch made since scope.
function checkTouchesDrift(processDir, runId, st, pin) {
  const events = readEvents(processDir, runId);
  const declared = [...events].reverse().find((e) => e.kind === 'touches' && e.name === 'declared' && e.step === 'scope');
  if (!declared || !Array.isArray(declared.files) || declared.files.length === 0) return;
  const effort = require('./effort');   // lazy require: effort.js requires spine at its top
  const actual = effort.diffPaths(st.repo_dir, effort.branchBase(st.repo_dir, st.pin));
  for (const f of actual) {
    if (effort.touchesOverlap([f], declared.files)) continue;
    appendEvent(processDir, runId, { kind: 'extrapolation', step: 'pre-pr',
      missing: { scope: 'card', key: 'touches-drift' },
      assumed: `${f} outside declared ${declared.files.join(', ')}`,
      confidence: 'high', actor: 'agent', pin });
  }
}

// `repeat_until: <outcome>` makes a step a loop: settling it with any other outcome re-opens it
// (back to ready, dependents untouched) instead of marking it done. The `reply` step is one approval
// per reply this way; `pr-loop` goes round until `approved`. A standing loop that never reaches its
// outcome is retired by `plt run close`.
function repeatOutcome(def) {
  if (!def || !def.repeat_until) return 'done';
  return (Array.isArray(def.outcomes) && def.outcomes.find((o) => o !== def.repeat_until)) || 'done';
}

function settle(processDir, runId, stepId, wf, st, pin) {
  const step = st.steps[stepId];
  const def = wf.steps.find((s) => s.id === stepId);
  if (def && def.repeat_until && step.outcome !== def.repeat_until) {
    // An `arm_on` loop (a follow-up that waits on the author) goes back to pending: nothing is waiting
    // until the poll sees the fact again and re-arms it. Any other loop is ready for its next round.
    step.status = def.arm_on ? 'pending' : 'ready'; step.started = null; step.finished = null;
    if (st.current_step === stepId) st.current_step = null;
    writeState(processDir, runId, st);
    appendEvent(processDir, runId, { kind: 'time', what: 'repeated', step: stepId, outcome: step.outcome, until: def.repeat_until, actor: 'agent', pin });
    return st;
  }
  if (stepId === 'pre-pr') checkTouchesDrift(processDir, runId, st, pin);
  step.status = 'done';
  step.finished = new Date().toISOString();
  for (const s of wf.steps) {
    if (!st.steps[s.id] || st.steps[s.id].status !== 'pending') continue;
    // A step the formula gained after this run launched has no entry in state yet (until
    // `plt run recompile`); treat it as not done rather than crashing the finish.
    const done = (id) => Boolean(st.steps[id] && st.steps[id].status === 'done');
    const needsDone = (s.needs || []).every(done);
    const whenOk = !s.when || (done(s.when.step) && st.steps[s.when.step].outcome === s.when.outcome);
    if (!s.arm_on && needsDone && whenOk && (s.needs || s.when)) st.steps[s.id].status = 'ready';
  }
  if (st.current_step === stepId) st.current_step = null;
  writeState(processDir, runId, st);
  appendEvent(processDir, runId, { kind: 'time', what: 'finished', step: stepId, actor: 'agent', pin });
  return st;
}

function stepFinish(processDir, runId, stepId, { outcome, extrapolations = [], noExtrapolations = false, window, takeOver } = {}) {
  let st = readState(processDir, runId);
  const step = st.steps[stepId];
  if (!step) throw new Error(`no step ${stepId}`);
  if (step.status !== 'in_progress' && step.status !== 'in_review') {
    throw new Error(`step ${stepId} is ${step.status}; only in_progress or in_review can be finished`);
  }
  assertRepo(processDir, runId, st, { window, takeOver });
  assertWindow(processDir, runId, st, { window, takeOver });
  st = readState(processDir, runId);   // a take-over wrote state
  const wf = runFormula(processDir, st);
  const def = wf.steps.find((s) => s.id === stepId);
  if (Array.isArray(def.outcomes) && !def.outcomes.includes(outcome)) throw new Error(`outcome ${outcome} is not one of ${def.outcomes.join('|')}`);
  // A claimed disposition is checked where it can be: the worktree is gone, or the finish is refused.
  if (outcome === 'worktree_removed' && st.repo_dir && fs.existsSync(st.repo_dir)) {
    throw new Error(`outcome worktree_removed claimed but ${st.repo_dir} still exists — remove the worktree first, or finish with worktree_kept`);
  }
  const g = gateCheck(processDir, runId, stepId, st.repo_dir);
  const humanPending = g.missing.length === 1 && g.missing[0].kind === 'gate';
  // `skipped` is a declared outcome that means "this step's work did not happen" (the PR merged before we
  // posted, the fix was not needed). It carries no receipts by definition, so the verify list does not apply.
  const skipped = outcome === 'skipped' && Array.isArray(def.outcomes) && def.outcomes.includes('skipped');
  if (!skipped && !g.ok && !humanPending) throw new Error('missing receipts: ' + g.missing.map((m) => `${m.kind}:${m.name} (${m.reason})`).join(', '));
  for (const x of extrapolations) appendEvent(processDir, runId, { kind: 'extrapolation', step: stepId, ...x, actor: 'agent', pin: g.pin });
  const has = readEvents(processDir, runId).some((e) => e.kind === 'extrapolation' && e.step === stepId);
  if (!has && !noExtrapolations) throw new Error('finish needs at least one extrapolation event or --no-extrapolations');
  if (!has) appendEvent(processDir, runId, { kind: 'extrapolation', step: stepId, missing: { scope: 'none', key: 'none', where: stepId }, actor: 'agent', pin: g.pin });
  const cur = st.steps[stepId];
  cur.outcome = outcome || 'done';
  if (humanPending) {
    cur.status = 'in_review';
    cur.finished = null;
    if (st.current_step === stepId) st.current_step = null;
    writeState(processDir, runId, st);
    return st;
  }
  return settle(processDir, runId, stepId, wf, st, g.pin);
}

function writeHandoff(processDir, runId, { goal, next, verified = [], questions = [], window, takeOver } = {}) {
  const st = readState(processDir, runId);
  // A handoff releases the window claim: whoever picks the run up next drives it. Routed through
  // the same assertWindow guard every other window-sensitive call uses (recordReceipt, stepStart,
  // stepFinish, gateApprove) — a call from a window other than the owner is refused (or moves the
  // claim first with --take-over), so a window can no longer release a claim that is not its own.
  if (st.owner_window) {
    const mine = assertWindow(processDir, runId, st, { window, takeOver });
    // A caller that cannot identify itself (no PLT_WINDOW, no --window) may still WRITE the handoff,
    // but it must not release a claim it cannot prove is its own: assertWindow returns early for a
    // null caller, so clearing here used to let a plain-shell `plt handoff` free window A's run.
    if (mine) { st.owner_window = null; writeState(processDir, runId, st); }
  }
  const pin = st.pin ? `${st.pin.kind} ${st.pin.value}${st.pin.base_sha ? ' on ' + st.pin.base_sha : ''}` : 'none';
  const md = ['---', `run: ${runId}`, `step: ${st.current_step || 'none'}`, `written: ${new Date().toISOString()}`, '---',
    '# Handoff', '', `Goal: ${goal}`, '', `Next: \`${next}\``, '',
    'Verified:', ...(verified.length ? verified.map((v) => `- ${v}`) : ['- none yet']), '',
    'Questions:', ...(questions.length ? questions.map((q) => `- ${q}`) : ['- none']), '', `Pinned: ${pin}`, ''].join('\n');
  fs.writeFileSync(path.join(runDir(processDir, runId), 'HANDOFF.md'), md);
  return md;
}

// A loop step (`repeat_until`) with an owner gate, between rounds: its last event is the
// `repeated` that re-opened it, and nothing has re-armed it since (a poll that armed it is the next
// reply arriving). There is nothing to approve, so no surface offers the approval or `go`. It
// is ready (a plain loop) or pending (an `arm_on` loop, waiting for the poll). One predicate for
// nextCommand, the menu and the board, so the three cannot disagree.
function betweenRounds(state, events, stepId) {
  const s = state && state.steps && state.steps[stepId];
  if (!s || !['ready', 'pending'].includes(s.status)) return false;
  if (!(s.receipts_required || []).some((r) => r.kind === 'gate')) return false;
  let last = null;
  for (const e of events || []) {
    if (e.step === stepId) last = e;
    else if (e.what === 'polled' && Array.isArray(e.armed) && e.armed.includes(stepId)) last = e;
  }
  return Boolean(last && last.what === 'repeated');
}
function waitingSteps(state, events) {
  return Object.keys((state && state.steps) || {}).filter((id) => betweenRounds(state, events, id));
}

// The one command that moves the run. `wf` (the run's formula, from runFormula) tells manual
// steps apart: a `manual: true` step is never proposed as `plt step start` — the agent does not
// start it. One with a human gate is proposed as the owner's gate command; one with a `banner`
// as "tell the agent: <the banner's first line>". A ready agent step wins over a ready manual
// one. Without `wf` (an ad-hoc state) nothing is known to be manual.
function nextCommand(st, wf, events = []) {
  if (st.status === 'closed') return 'nothing — run closed';
  const cur = st.current_step;
  if (cur) {
    const step = st.steps[cur];
    if (step.status === 'in_review') return `plt gate approve ${st.run} ${cur} --by human:<you>`;
    return `plt step finish ${cur} --run ${st.run} --outcome <outcome>`;
  }
  const defs = new Map(((wf && wf.steps) || []).map((s) => [s.id, s]));
  // The parser keeps every scalar as a string, so `manual: false` arrives as the truthy `"false"`.
  // Read the word, not the truthiness — `plt validate` accepts only `true`/`false` here.
  const isManual = (id) => {
    const v = defs.get(id) && defs.get(id).manual;
    return v === true || v === 'true';
  };
  const waits = waitingSteps(st, events);
  const ready = Object.entries(st.steps).filter(([id, s]) => s.status === 'ready' && !waits.includes(id)).map(([id]) => id);
  const agentReady = ready.find((id) => !isManual(id));
  if (agentReady) return `plt step start ${agentReady} --run ${st.run}`;
  if (ready.length) {
    const id = ready[0]; const def = defs.get(id);
    if (def.gate && def.gate.kind === 'human') return `plt gate approve ${st.run} ${id} --by human:<you>`;
    if (def.banner) return `tell the agent: ${String(def.banner).split(/\\n|\n/)[0].trim()}`;
    return `plt gate approve ${st.run} ${id} --by human:<you>`;
  }
  const review = Object.entries(st.steps).find(([, s]) => s.status === 'in_review');
  if (review) return `plt gate approve ${st.run} ${review[0]} --by human:<you>`;
  if (waits.length) {
    const id = waits[0]; const def = defs.get(id) || {};
    return `nothing for you — waiting on ${def.waiting || `the next ${id}`}${def.arm_on ? ` (plt run poll re-arms ${id})` : ''}`;
  }
  return 'nothing — run complete';
}

// Derived facts for a review we posted on someone else's PR. Raw `gh pr view` fields cannot say
// "the author answered us" or "the branch moved under our review", so poll computes them from the
// review + comment lists and adds them to `facts`; formulas then arm steps on them like any other
// gh fact (`arm_on: { gh: authorRepliedSinceOurReview, equals: true }`). Pure: the CLI fetches, tests pass in.
//   ours          — the login whose review is "ours" (the run's owner login on GitHub)
//   reviews       — gh `reviews` (author.login, state, submittedAt, commit)
//   comments      — gh `comments` (issue comments: author.login, createdAt)
//   reviewComments— review-thread comments from the REST API (user.login, created_at, pull_request_review_id, in_reply_to_id)
//   headRefOid    — current head
//
// Our approval is a FACT, not a status or a step: GitHub can take it away without us (a repo with
// dismiss-stale-reviews dismisses it on the author's next push), so it is derived on every poll
// and never written as a run state. Only verdict reviews count — APPROVED / CHANGES_REQUESTED /
// DISMISSED; a COMMENTED review (every inline reply we post is one) is not a verdict and neither
// grants nor withdraws an approval. `reviewDecision` is not used: it is empty on a repo that
// requires no reviewers, and it says nothing about WHOSE approval stands.
//   ourApprovalStanding  — our latest verdict review is APPROVED (whatever head it was given on)
//   ourApprovalSha       — the commit that approval was submitted on (null when not standing)
//   ourApprovalOnHead    — that commit is the current head
//   ourApprovalDismissed — our latest verdict review is DISMISSED (under dismiss-stale-reviews:
//                          our approval was dismissed by a push; a manual dismissal reads the same)
function reviewFacts({ ours, prAuthor, reviews = [], comments = [], reviewComments = [], headRefOid,
  reviewRequests = [], threadsUnresolved = null }) {
  const mine = reviews.filter((r) => r && r.author && r.author.login === ours && r.submittedAt);
  if (!mine.length) {
    return { ourReviewPosted: false, authorRepliedSinceOurReview: false, headMovedSinceOurReview: false,
      reReviewRequested: false, authorHandedBack: false,
      ourApprovalStanding: false, ourApprovalSha: null, ourApprovalOnHead: false, ourApprovalDismissed: false };
  }
  const latest = (a, b) => (a.submittedAt > b.submittedAt ? a : b);
  const last = mine.reduce(latest);
  const since = last.submittedAt;
  const notUs = (login) => login && login !== ours && !/\[bot\]$|^github-actions$|^dependabot/.test(login);
  const laterIssue = comments.some((c) => c && c.author && notUs(c.author.login) && c.createdAt > since);
  const laterThread = reviewComments.some((c) => c && c.user && notUs(c.user.login) && c.created_at > since);
  const laterReview = reviews.some((r) => r && r.author && notUs(r.author.login) && r.submittedAt > since && r.author.login === prAuthor);
  const sha = (r) => (r && r.commit ? String(r.commit.oid || r.commit) : null);
  const ourCommit = sha(last);
  const verdicts = mine.filter((r) => ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state));
  const lastVerdict = verdicts.length ? verdicts.reduce(latest) : null;
  const standing = Boolean(lastVerdict && lastVerdict.state === 'APPROVED');
  const approvalSha = standing ? sha(lastVerdict) : null;
  // HANDED BACK, not merely touched. `authorRepliedSinceOurReview` goes true on the author's first
  // keystroke, which is why a board armed on it says "needs you" while the author is still working —
  // one reply out of seven threads and three more commits coming. The signal we actually wait for is
  // the author saying they are done, in one of the only two ways GitHub lets them:
  //   - re-requesting our review (GitHub drops a reviewer from reviewRequests when they submit, so
  //     our login being back in the list AFTER our review is an explicit second ask), or
  //   - answering every thread we opened and leaving none unresolved.
  // `threadsUnresolved` is null when the collector could not read it; null is not zero, so a fact we
  // could not read never counts as "all answered".
  const reRequested = reviewRequests.some((r) => (r && (r.login || r.name)) === ours);
  const allAnswered = threadsUnresolved === 0 && (laterIssue || laterThread || laterReview);
  return {
    ourReviewPosted: true,
    ourReviewSubmittedAt: since,
    reReviewRequested: reRequested,
    authorHandedBack: Boolean(reRequested || allAnswered),
    authorRepliedSinceOurReview: laterIssue || laterThread || laterReview,
    headMovedSinceOurReview: Boolean(ourCommit && headRefOid && String(ourCommit) !== String(headRefOid)),
    ourApprovalStanding: standing,
    ourApprovalSha: approvalSha,
    ourApprovalOnHead: Boolean(standing && approvalSha && headRefOid && approvalSha === String(headRefOid)),
    ourApprovalDismissed: Boolean(lastVerdict && lastVerdict.state === 'DISMISSED'),
  };
}

// The fact names a step may arm or land on. This is the contract between the collector
// (`lib/spine-cli.js#run poll`, which builds the poll object) and the formula grammar: `plt
// validate` refuses an `arm_on.gh` / `land_on.gh` outside this list, because a name that is not
// here reads `undefined` on every poll, never equals anything, and leaves the step pending
// forever with no message. Scalars only — `checks` is carried in the snapshot as a tally object
// for renderers, and `checksGreen` is its armable form.
const POLL_FACTS = [
  'mergeStateStatus', 'reviewDecision', 'state', 'headRefOid', 'prClosed',
  'isDraft', 'checksGreen', 'threadsUnresolved',
  'ourReviewPosted', 'ourReviewSubmittedAt', 'authorRepliedSinceOurReview', 'headMovedSinceOurReview',
  'reReviewRequested', 'authorHandedBack',
  'ourApprovalStanding', 'ourApprovalSha', 'ourApprovalOnHead', 'ourApprovalDismissed',
];

// Steps with `arm_on: { gh: <field>, equals: <value> }` are armed by a live fact about the PR, not
// by their `needs` alone: `resync` becomes ready when GitHub says the branch is DIRTY (a conflict),
// and goes back to pending when it is not. `facts` is what `gh pr view --json` returned; the CLI
// fetches it, tests pass it in. Steps in progress are never touched. Returns the ids that changed,
// plus `landed` when a `land_on` step settled (see landRun).
//
// The poll also keeps `state.poll = { at, facts }`: the last facts it saw, rewritten only when a
// fact changed (so `at` reads "since when"). Renderers read a run's live facts from there — the
// approval standing on a PR we reviewed, the head, the merge state — instead of calling gh; it is
// a snapshot of GitHub's truth at the last poll, not a status the spine owns (`plt facts` keeps its
// own `state.facts` for the receipts it records; the two do not overwrite each other).
function pollRun(processDir, runId, facts, actions = {}) {
  const st = readState(processDir, runId);
  if (!st || !st.cycle || st.status === 'closed') return { armed: [], disarmed: [] };
  const wf = runFormula(processDir, st);
  const armed = [], disarmed = [];
  let snapshotChanged = false;
  if (facts && JSON.stringify(facts) !== JSON.stringify(st.poll && st.poll.facts)) {
    st.poll = { at: new Date().toISOString(), facts };
    snapshotChanged = true;
  }
  for (const s of wf.steps) {
    if (!s.arm_on || !st.steps[s.id]) continue;
    const step = st.steps[s.id];
    const needsDone = (s.needs || []).every((n) => st.steps[n] && st.steps[n].status === 'done');
    const hit = needsDone && facts && String(facts[s.arm_on.gh]) === String(s.arm_on.equals);
    if (hit && ['pending', 'done', 'skipped'].includes(step.status)) {
      step.status = 'ready'; step.outcome = null; step.finished = null; armed.push(s.id);
    } else if (!hit && step.status === 'ready') {
      step.status = 'pending'; disarmed.push(s.id);
    }
  }
  if (armed.length || disarmed.length || snapshotChanged) writeState(processDir, runId, st);
  if (armed.length || disarmed.length) {
    appendEvent(processDir, runId, { kind: 'time', what: 'polled', step: null, armed, disarmed, facts: facts || null, actor: 'agent', pin: st.pin || null });
  }
  const landed = landRun(processDir, runId, wf, facts, actions);
  return { armed, disarmed, ...(landed ? { landed } : {}) };
}

// The landing sequence. A step with `land_on: { gh: <field>, equals: <value> }` (the formula's
// `merge`: `land_on: { gh: state, equals: MERGED }`) is settled by the poll itself the moment the
// fact holds — GitHub has merged, so every `gh` check the step (and its unfinished ancestors, e.g.
// a pr-loop still waiting on `review_approved`) declares is true by construction. The poll records
// those receipts with the PR as ref, runs the step's jira `on_done` through `actions.jira(card,
// status)` (the CLI wires config.jira.script; tests pass a stub), finishes each step, and leaves the
// dependents ready. No prompt in between: a merged PR that waits for a human to say "finish the
// merge step" stalls the landing for no reason. Anything the poll cannot satisfy — a skill, artifact or
// human-gate receipt that is missing, a refused pin, a jira failure — stops the landing at that
// step and is returned as `blocked`; the agent picks it up from `plt prime`. Returns null when no
// landing step fires.
function landRun(processDir, runId, wf, facts, actions = {}) {
  const def = wf.steps.find((s) => s.land_on);
  if (!def || !facts || String(facts[def.land_on.gh]) !== String(def.land_on.equals)) return null;
  let st = readState(processDir, runId);
  if (!st.steps[def.id] || ['done', 'skipped'].includes(st.steps[def.id].status)) return null;
  // Formula order, restricted to the landing step's unfinished `needs` ancestors plus itself.
  const chain = new Set();
  const walk = (id) => { const d = wf.steps.find((s) => s.id === id); if (!d) return; for (const n of d.needs || []) walk(n); chain.add(id); };
  walk(def.id);
  const todo = wf.steps.filter((s) => chain.has(s.id) && st.steps[s.id] && !['done', 'skipped'].includes(st.steps[s.id].status));
  const events = readEvents(processDir, runId);
  const prEv = events.filter((e) => e.ref && /https?:\/\/\S+\/pull\/\d+/.test(String(e.ref))).pop();
  const prUrl = prEv ? String(prEv.ref).match(/https?:\/\/\S+?\/pull\/\d+/)[0] : null;
  const card = readInputs(processDir, runId).card || runId;
  const finished = [];
  const stop = (id, reason, missing) => {
    appendEvent(processDir, runId, { kind: 'time', what: 'landing-blocked', step: id, reason, missing: missing || null, finished, facts, actor: 'agent', pin: st.pin || null });
    return { finished, blocked: { step: id, reason, missing: missing || null } };
  };
  for (const s of todo) {
    st = readState(processDir, runId);
    const step = st.steps[s.id];
    if (step.status === 'blocked') return stop(s.id, 'step is blocked on a question');
    if (step.status === 'pending') {
      if (!(s.needs || []).every((n) => st.steps[n] && st.steps[n].status === 'done')) return stop(s.id, 'needs not done');
      step.status = 'ready'; writeState(processDir, runId, st);
    }
    if (st.steps[s.id].status === 'ready') {
      if (st.current_step && st.current_step !== s.id) return stop(s.id, `step ${st.current_step} is in progress`);
      stepStart(processDir, runId, s.id);
    }
    const g = gateCheck(processDir, runId, s.id, st.repo_dir);
    if (g.pin && g.pin.refused) return stop(s.id, 'pin refused — stage or ignore the worktree changes', g.missing);
    for (const m of g.missing) {
      if (m.kind === 'gh') {
        // GitHub said MERGED; this fact was not collected. The receipt says it was back-filled (D-027).
        recordReceipt(processDir, runId, { step: s.id, kind: 'gh', name: m.name, result: 'pass', ref: prUrl, pin: g.pin, actor: 'agent', out_of_band: true });
      } else if (m.kind === 'jira' && /^on_done:/.test(m.name)) {
        const status = m.name.slice('on_done:'.length);
        try { if (actions.jira) actions.jira(card, status); else throw new Error('no jira action wired'); }
        catch (e) { return stop(s.id, `jira transition to ${status} failed: ${e.message}`, [m]); }
        recordReceipt(processDir, runId, { step: s.id, kind: 'jira', name: m.name, result: 'pass', ref: card, pin: g.pin, actor: 'agent' });
      } else {
        return stop(s.id, `cannot satisfy ${m.kind}:${m.name} from a poll`, g.missing);
      }
    }
    const outcome = (s.land_on && s.land_on.outcome) || s.repeat_until || (Array.isArray(s.outcomes) && !s.outcomes.includes('done') ? s.outcomes[0] : 'done');
    try { stepFinish(processDir, runId, s.id, { outcome, noExtrapolations: true }); }
    catch (e) { return stop(s.id, e.message); }
    finished.push(s.id);
  }
  const after = readState(processDir, runId);
  const ready = Object.entries(after.steps).filter(([, x]) => x.status === 'ready').map(([id]) => id);
  appendEvent(processDir, runId, { kind: 'time', what: 'landed', step: def.id, finished, ready, facts, actor: 'agent', pin: after.pin || null });
  return { finished, ready };
}

// Standing owner steps that carry a `banner` — a manual action outside the tool (ask for reviews in
// Slack) that does not block the agent's steps but must happen. Rendered until the owner passes the
// step's gate; `{run}`, `{card}`, `{pr_url}`, `{card_url}` are filled from the run.
function renderBanners(processDir, runId) {
  const st = readState(processDir, runId);
  if (!st || !st.cycle || st.status === 'closed') return [];
  const wf = runFormula(processDir, st);
  const events = readEvents(processDir, runId);
  const inputs = readYaml(path.join(runDir(processDir, runId), 'inputs.yaml')) || {};
  // Any receipt whose ref is the PR URL (the ship skill's, a gh receipt's) names the PR.
  const prEv = events.filter((e) => e.ref && /https?:\/\/\S+\/pull\/\d+/.test(String(e.ref))).pop();
  const prUrl = prEv ? String(prEv.ref).match(/https?:\/\/\S+?\/pull\/\d+/)[0] : (inputs.pr_url || '(PR not opened yet)');
  const vars = { run: runId, card: inputs.card || runId, pr_url: prUrl, card_url: inputs.card_url || '' };
  const out = [];
  for (const s of wf.steps) {
    const step = st.steps[s.id];
    if (!s.banner || !step || !['ready', 'in_progress', 'in_review'].includes(step.status)) continue;
    // The formula parser keeps a quoted string's `\n` as two characters; make them line breaks.
    out.push(String(s.banner).replace(/\\n/g, '\n').replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`)));
  }
  return out;
}

// ---- the prompt menu — "what do I say now?" ----
//
// menuFor derives a mode from the current step's status + gate kind (or, with
// no current step, from what's ready/done), then looks up which of the twelve
// fixed phrase ids apply in that mode. renderMenu turns that into a ≤3-line
// prompt; parseMenuPhrase turns free text back into {id, payload}. Word TEXT
// is overlay-configurable (config.menu.words); ids and commands never are.
const DEFAULT_MENU_WORDS = { where: 'where are we', next: "what's next", go: 'go', approve: 'approve', block: 'block',
  answer: 'answer', drop: 'drop', change: 'change', dismiss: 'dismiss', park: 'park', capture: 'capture', handoff: 'handoff' };
const MENU_PAYLOAD_IDS = new Set(['block', 'answer', 'drop', 'change', 'dismiss', 'park']);
const MENU_BY_MODE = {
  WAIT: ['approve', 'block', 'drop', 'handoff', 'where'], GATE: ['approve', 'block', 'drop', 'change', 'where'],
  'PANEL-FAIL': ['dismiss', 'go', 'block', 'where'], WAITING: ['where', 'next', 'capture'], BLOCKED: ['answer', 'park', 'where'], EXTERNAL: ['where', 'next', 'block'],
  START: ['go', 'where', 'next'], RESUME: ['go', 'where', 'handoff'], NEXT: ['go', 'next', 'capture', 'where'], CLOSED: ['capture', 'where'],
};
// `block` and `answer` run the blocked-state writers (lib/blocked.js). `dismiss` and `park` have no
// writer yet: those two commands are the documented fallback until they do.
const MENU_COMMANDS = {
  where: 'plt prime {run}', next: 'plt prime {run} --next', go: 'run the Next line of HANDOFF.md verbatim',
  approve: 'plt gate approve {run} {step} --by human:{me}', block: 'plt step block {step} --run {run} --question {payload}',
  answer: 'plt answer {run} --text {payload} --by human:{me}', drop: 'edit the text under review; re-run writing-adversary; re-render',
  change: 'edit the text under review; re-run writing-adversary; re-render', dismiss: 'plt dismiss {run} {step} --at {payload}',
  park: 'plt park {run} --reason {payload}', capture: 'invoke kb-code-knowledge-capture', handoff: 'plt handoff {run} --goal … --next …',
};
const MENU_PAYLOAD_HINT = { block: '<why>', answer: '<text>', drop: '<tag>', change: '<tag>', dismiss: '<file:line why>', park: '<why>' };

// The step a run is blocked on, if any. It wins over current_step: an in_review step can be
// blocked while another step is in progress, and the question is what a person must see first.
function blockedStep(state) {
  const hit = Object.entries(state.steps || {}).find(([, s]) => s.status === 'blocked');
  return hit ? hit[0] : null;
}
// The question a blocked step waits on: the latest `question` event for it (lib/blocked.js writes it).
function openQuestion(events, stepId) {
  const q = (events || []).filter((e) => e.kind === 'question' && e.step === stepId).pop();
  return q ? q.text : null;
}

function menuFor(state, events) {
  const cur = state.current_step ? state.steps[state.current_step] : null;
  let mode;
  if (blockedStep(state)) {
    mode = 'BLOCKED';
  } else if (!cur) {
    const waits = waitingSteps(state, events);
    const vals = Object.entries(state.steps).filter(([id]) => !waits.includes(id)).map(([, s]) => s.status);
    mode = vals.some((v) => v === 'in_review') ? 'GATE'
      : vals.some((v) => v === 'ready') ? (vals.some((v) => v === 'done') ? 'NEXT' : 'START')
      : waits.length ? 'WAITING'
      : vals.length > 0 && vals.every((v) => v === 'done') ? 'CLOSED' : 'START';
  } else {
    const gate = (cur.receipts_required || []).find((r) => r.kind === 'gate');
    const external = (cur.receipts_required || []).some((r) => r.kind === 'gh');
    // PANEL-FAIL only on the LATEST verdict per agent: an earlier fail that a later pass
    // overturned must not keep the step stuck in PANEL-FAIL forever (events are append-only
    // and chronological, so the last event per agent name wins).
    // A banner-mode reviewer's fail is a warning prime prints, never PANEL-FAIL: the step is not held.
    const bannerAgents = new Set((cur.receipts_required || []).filter((r) => r.kind === 'agent' && r.mode === 'banner').map((r) => r.name));
    const latestByAgent = new Map();
    for (const e of events || []) if (e.step === state.current_step && e.kind === 'agent' && !bannerAgents.has(e.name)) latestByAgent.set(e.name, e);
    const failed = [...latestByAgent.values()].some((e) => e.verdict === 'fail');
    mode = cur.status === 'blocked' ? 'BLOCKED'
      : cur.status === 'in_review' ? (gate ? 'GATE' : external ? 'EXTERNAL' : 'WAIT')
      : cur.status === 'in_progress' ? (failed ? 'PANEL-FAIL' : 'RESUME')
      : cur.status === 'ready' ? 'START' : 'NEXT';
  }
  if (state.status === 'closed') mode = 'CLOSED';
  // `{me}` is the person a human-only command runs as (an answer, an approval): the run's owner when
  // the state names one, else a literal <you> the human replaces. `answer` without --by is refused.
  const me = state.owner || '<you>';
  return { mode, phrases: MENU_BY_MODE[mode].map((id) => ({ id, payload: MENU_PAYLOAD_IDS.has(id), command: MENU_COMMANDS[id].replace('{me}', me) })) };
}

function menuStateSentence(state, mode, events) {
  if (mode === 'BLOCKED' && blockedStep(state)) {
    const id = blockedStep(state); const q = openQuestion(events, id);
    return `▶ ${state.run} · ${id} · blocked on a question${q ? `: ${q}` : ''}`;
  }
  if (mode === 'WAITING') {
    const id = waitingSteps(state, events)[0];
    return `▶ ${state.run} · ${id} · waiting on the next ${id} — nothing to approve yet`;
  }
  const step = state.current_step || Object.entries(state.steps).find(([, s]) => s.status === 'ready' || s.status === 'in_review')?.[0] || '—';
  const gate = state.current_step && (state.steps[state.current_step].receipts_required || []).find((r) => r.kind === 'gate');
  const words = { GATE: `waiting on you (${gate ? gate.name : 'gate'})`, WAIT: 'waiting on you', 'PANEL-FAIL': 'panel failed — findings open',
    BLOCKED: 'blocked on a question', EXTERNAL: 'waiting on GitHub', START: 'ready to start', RESUME: 'in progress', NEXT: 'next step ready', CLOSED: 'run complete' };
  return `▶ ${state.run} · ${step} · ${words[mode]}`;
}

function renderMenu(state, events, words = DEFAULT_MENU_WORDS) {
  const m = menuFor(state, events);
  const say = m.phrases.map((p) => (p.payload ? `${words[p.id]}: ${MENU_PAYLOAD_HINT[p.id]}` : words[p.id])).join(' · ');
  return `${menuStateSentence(state, m.mode, events)}\nSay: ${say}`;
}

// Bare phrases match exactly (after trim/lower/collapse-whitespace); payload phrases match
// `^<word>:\s*(.+)$`. One phrase per message, start of message only.
function parseMenuPhrase(text, words = DEFAULT_MENU_WORDS) {
  const t = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[‘’]/g, "'");
  for (const [id, word] of Object.entries(words)) {
    const w = word.toLowerCase();
    if (MENU_PAYLOAD_IDS.has(id)) {
      const m = t.match(new RegExp('^' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*(.+)$'));
      if (m) return { id, payload: m[1].trim() };
    } else if (t === w) {
      return { id, payload: null };
    }
  }
  return null;
}

function renderPrime(processDir, runId, { menu = true } = {}) {
  const st = readState(processDir, runId);
  const events = readEvents(processDir, runId);
  const launchPin = st.pin ? `launched at ${st.pin.kind}:${st.pin.value.slice(0, 10)}` : 'unpinned';
  const L = [];
  L.push(`▶ ${st.run} · ${st.cycle} v${st.formula_version}${st.exit ? ` · exit ${st.exit}` : ''} · owner ${st.owner || '?'} · ${launchPin}`);
  let wf = null;
  if (st.cycle) { try { wf = runFormula(processDir, st); } catch (e) { wf = null; } }
  L.push(`NEXT: ${nextCommand(st, wf, events)}`);
  for (const b of renderBanners(processDir, runId)) {
    L.push('');
    L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    L.push(...b.split('\n'));
    L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }
  L.push('');
  L.push('Steps:');
  const active = new Set(['in_progress', 'in_review', 'ready']);
  for (const [id, s] of Object.entries(st.steps)) {
    const reqs = s.receipts_required || [];
    const mark = s.status === 'done' ? '✓' : s.status === 'in_progress' ? '▶' : s.status === 'in_review' ? '⏸' : s.status === 'ready' ? '○' : '·';
    let seen, missing = [], bannerFailed = [], bannerUnseen = [], pinRefused = false;
    if (active.has(s.status)) {
      let g;
      try { g = gateCheck(processDir, runId, id, st.repo_dir); } catch (err) { g = null; }
      if (!g || (g.pin && g.pin.refused)) { pinRefused = true; seen = 0; }
      else {
        missing = g.missing;
        // A banner reviewer is never "missing", but it is not "seen" until it has recorded a verdict at this pin.
        const stepEvents = events.filter((e) => e.step === id);
        bannerUnseen = reqs.filter((r) => r.kind === 'agent' && r.mode === 'banner' && !stepEvents.some((e) => e.kind === 'agent' && e.name === r.name && pinMatches(e.pin, g.pin))).map((r) => r.name);
        seen = reqs.length - missing.length - bannerUnseen.length;
        bannerFailed = bannerFails(s, stepEvents, g.pin);
      }
    } else {
      // pending/done: count from events only — no gateCheck, no MISSING breakdown.
      seen = reqs.filter((r) => events.some((e) => e.step === id && e.kind === r.kind && e.name === r.name)).length;
    }
    const missingTag = active.has(s.status) && !pinRefused && missing.length ? ` MISSING ${missing.length}` : '';
    L.push(`  ${mark} ${id.padEnd(13)} ${s.status.padEnd(12)} receipts ${seen}/${reqs.length}${missingTag}`);
    if (active.has(s.status)) {
      if (pinRefused) {
        L.push('      pin refused: stage or ignore');
      } else {
        for (const r of reqs) {
          if (r.kind === 'agent' && r.mode === 'banner') { L.push(`      ${bannerFailed.includes(r.name) ? '⚠' : bannerUnseen.includes(r.name) ? '○' : '✓'} ${r.kind} ${r.name} (banner)`); continue; }
          const isMissing = missing.some((m) => m.kind === r.kind && m.name === r.name);
          L.push(`      ${isMissing ? 'MISSING' : '✓'} ${r.kind} ${r.name}`);
        }
        for (const a of bannerFailed) L.push(`      ⚠ banner: ${a} failed`);
      }
    }
  }
  const oob = events.filter((e) => e.out_of_band === true).length;
  if (oob) L.push(`  ⚠ ${oob} receipt${oob === 1 ? '' : 's'} recorded out of band — evidence the spine did not collect (\`out_of_band: true\` in the ledger)`);
  const hand = path.join(runDir(processDir, runId), 'HANDOFF.md');
  if (fs.existsSync(hand)) { L.push(''); L.push(...fs.readFileSync(hand, 'utf8').split('\n').filter((l) => !l.startsWith('---') && !/^(run|step|written):/.test(l))); }
  const inputs = path.join(runDir(processDir, runId), 'inputs.yaml');
  if (fs.existsSync(inputs)) { L.push('Inputs:'); L.push(...fs.readFileSync(inputs, 'utf8').split('\n').slice(0, 15).map((l) => '  ' + l)); }
  L.push('');
  L.push(`Stop rules: finish with \`plt step finish\`; block with \`plt step block <step> --run ${st.run} --question <text>\`; never edit process/runs/** by hand.`);
  if (menu !== false) {
    const config = loadConfig(processDir, runId);
    L.push('');
    L.push(renderMenu(st, events, (config.menu && config.menu.words) || DEFAULT_MENU_WORDS));
  }
  return L.slice(0, 90).join('\n');
}

// ---- sync: "what moved since the last session" ----
//
// process/build/sync.json holds { at, runs: { <id>: <nextCommand string> } } — the snapshot the
// last `syncSince` wrote. Kept separate from watch.json (lib/spine-cli.js): watch notifies windows
// on a timer, sync reports to a human at session start, and the two must never consume or reset
// each other's baseline. A run whose nextCommand differs from what's recorded is "moved"; a run
// seen for the first time (new since the last sync, or the very first call ever) is seeded
// silently — nothing has "moved" relative to a baseline that did not exist yet, the same rule
// `plt watch`'s first pass uses.
function syncFile(processDir) { return path.join(processDir, 'build', 'sync.json'); }
function readSyncState(processDir) {
  try { return JSON.parse(fs.readFileSync(syncFile(processDir), 'utf8')); } catch (e) { return null; }
}
function writeSyncState(processDir, st) {
  fs.mkdirSync(path.dirname(syncFile(processDir)), { recursive: true });
  fs.writeFileSync(syncFile(processDir), JSON.stringify(st, null, 2) + '\n');
}

function syncSince(processDir, { since } = {}) {
  const prior = readSyncState(processDir);
  const runsDir = path.join(processDir, 'runs');
  const ids = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).sort() : [];
  const runsNext = {};
  const moved = [];
  let unchanged = 0;
  for (const id of ids) {
    const st = readState(processDir, id);
    if (!st) continue;
    let wf = null;
    if (st.cycle) { try { wf = runFormula(processDir, st); } catch (e) { wf = null; } }
    const next = nextCommand(st, wf, readEvents(processDir, id));
    runsNext[id] = next;
    const had = Boolean(prior && prior.runs && Object.prototype.hasOwnProperty.call(prior.runs, id));
    if (!had) continue;   // new since the last sync (or the first sync ever) — seeded silently
    if (prior.runs[id] !== next) moved.push({ run: id, from: prior.runs[id], to: next });
    else unchanged++;
  }
  const seeded = !prior;
  const sinceIso = since || (prior && prior.at) || null;
  writeSyncState(processDir, { at: new Date().toISOString(), runs: runsNext });
  return { seeded, since: sinceIso, moved, unchanged, total: Object.keys(runsNext).length };
}

// ---- mine: aggregate re-prompts, extrapolations, gate re-approvals and writing-adversary fail
// rates into suggestions for a human to act on — deterministic, no model. See README "Sync and mine".
// An extrapolation's `assumed` is usually a plain string, but some receipts have shipped it as
// `{ value: "..." }` — never stringify the object itself (`[object Object]` helps no one).
function assumedText(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof v.value === 'string') return v.value;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function mine(processDir, { effort, since } = {}) {
  const reprompts = new Map();        // name -> { count, runs: Set }
  const extrapolations = new Map();   // missing.key -> { count, runs: Set, lastAssumed, lastTs }
  const reapprovals = new Map();      // step -> { count, runs: Set, cycles: Set }
  const writing = new Map();          // step -> { fail, total, runs: Set }

  for (const id of runIds(processDir)) {
    const inputs = readInputs(processDir, id);
    if (effort && inputs.effort !== effort) continue;
    // The run's cycle: a `formula:` target names the cycle the step belongs to, and the row cannot
    // be harvested without it.
    let runCycle = null;
    try { runCycle = (readState(processDir, id) || {}).cycle || null; } catch (e) { runCycle = null; }
    let cfg;
    try { cfg = loadConfig(processDir, id); } catch (e) { cfg = {}; }
    const writingAgents = new Set((cfg.review && cfg.review.writing_agents) || []);
    const events = readEvents(processDir, id).filter((e) => !since || e.ts >= since);

    for (const e of events) {
      if (e.kind === 'reprompt' && e.name) {
        const g = reprompts.get(e.name) || { count: 0, runs: new Set() };
        g.count++; g.runs.add(id);
        reprompts.set(e.name, g);
      }
      if (e.kind === 'extrapolation') {
        const key = e.missing && e.missing.key;
        if (!key || key === 'none') continue;   // the "nothing to flag" placeholder is noise
        const g = extrapolations.get(key) || { count: 0, runs: new Set(), lastAssumed: null, lastTs: null };
        g.count++; g.runs.add(id);
        // `>=` (not `>`): two events recorded within the same millisecond still keep the LATER one
        // read — events arrive here in chronological/append order, so a tie's later event is the
        // one actually most recent.
        if (!g.lastTs || e.ts >= g.lastTs) { g.lastTs = e.ts; g.lastAssumed = assumedText(e.assumed); }
        extrapolations.set(key, g);
      }
    }

    // Gate re-approvals: more than one `approve` gate receipt on the same step within this run.
    const approvalsByStep = new Map();
    for (const e of events) {
      if (e.kind !== 'gate' || e.result !== 'approve') continue;
      approvalsByStep.set(e.step, (approvalsByStep.get(e.step) || 0) + 1);
    }
    for (const [step, count] of approvalsByStep) {
      if (count <= 1) continue;
      const g = reapprovals.get(step) || { count: 0, runs: new Set(), cycles: new Set() };
      g.count += count - 1; g.runs.add(id);
      if (runCycle) g.cycles.add(runCycle);
      reapprovals.set(step, g);
    }

    // Writing-adversary fail rate per step: every `agent` receipt whose name is one of THIS run's
    // config.review.writing_agents (a run's own config layering, not a global default).
    for (const e of events) {
      if (e.kind !== 'agent' || !writingAgents.has(e.name)) continue;
      const g = writing.get(e.step) || { fail: 0, total: 0, runs: new Set() };
      g.total++; g.runs.add(id);
      if (e.verdict === 'fail') g.fail++;
      writing.set(e.step, g);
    }
  }

  // count desc, then id asc.
  const byCountThenId = (a, b) => (b.count - a.count) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const repromptRows = [...reprompts.entries()].map(([name, g]) => ({
    id: name, count: g.count, runs: [...g.runs].sort(),
    target: name.startsWith('menu:') ? 'config value: config.menu.words' : `skill: writing-style — the phrasing behind "${name}"`,
  })).sort(byCountThenId);
  const extrapolationRows = [...extrapolations.entries()].map(([key, g]) => ({
    id: key, count: g.count, runs: [...g.runs].sort(), assumed: g.lastAssumed,
    target: `template section: scope/touches declaration for "${key}"`,
  })).sort(byCountThenId);
  const reapprovalRows = [...reapprovals.entries()].map(([step, g]) => ({
    id: step, count: g.count, runs: [...g.runs].sort(),
    // Only when every run that re-approved this step ran the same cycle: a `formula:` target names
    // one cycle, and guessing which of two is the one to edit is how a harvest edits the wrong file.
    cycle: g.cycles.size === 1 ? [...g.cycles][0] : null,
    target: `formula key: reapprove.rearm on step "${step}"`,
  })).sort(byCountThenId);
  const writingRows = [...writing.entries()].map(([step, g]) => ({
    id: step, count: g.fail, total: g.total, rate: g.total ? Math.round((g.fail / g.total) * 100) : 0,
    runs: [...g.runs].sort(),
    target: `config value: config.review.writing_mode for step "${step}"`,
  })).sort(byCountThenId);

  return { reprompts: repromptRows, extrapolations: extrapolationRows, reapprovals: reapprovalRows, writing: writingRows };
}

const mdEscape = (v) => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\n/g, ' ');

// ---- renderMine: ONE table, because `plt harvest` reads one table ----------------------------
//
// This used to be four sectioned tables keyed `name` / `key` / `step`, with no ids at all. The
// reader (harvest.readSuggestions) has always parsed `| id | signal | count | runs | target |
// detail |`, and `plt harvest <id>` addresses a row by a STABLE id — so the reader cannot invent
// one the writer never emitted, and the suggestion -> diff pipeline could not run end to end even
// though both halves existed and were tested. The writer moves.
//
// Nothing the four tables carried is lost. The section is folded into `signal` as
// `<family>:<key>`, so a row still says which signal it came from and is still keyed by its own
// name/key/step; the per-section extras (an extrapolation's most recent assumed text, a writing
// gate's fails/total and rate) move into `detail`.
//
// `target` is the machine form harvest parses (`config:<dotted.path>`, `formula:<cycle>:<step>:<key>`,
// `template:<pack>/<name>:<slot>`) instead of the prose the old tables printed. A row plt cannot
// act on mechanically prints `(none)`: it is still a row a person reads and acts on by hand, and a
// half-target that parses to nothing would only be a target that lies.
//
// `detail` is descriptive, never `proposed: ...`. harvest writes exactly the value a row names
// after `proposed: `, so a generated proposal would be plt inventing a change — the human edits the
// row first. That refusal is the design, not a gap.
const SIGNAL_SECTIONS = ['reprompt', 'extrapolation', 'reapproval', 'writing'];

function mineRows(m) {
  const rows = [];
  for (const r of m.reprompts || []) {
    rows.push({
      signal: `reprompt:${r.id}`, count: r.count, runs: r.runs,
      // A menu near-miss is a wording the menu should accept: config.menu.words is the one key that
      // fixes it mechanically. Any other re-prompt family is a skill's phrasing — a human edit.
      target: String(r.id).startsWith('menu:') ? 'config:menu.words' : '(none)',
      detail: String(r.id).startsWith('menu:')
        ? `the menu did not accept "${String(r.id).slice('menu:'.length)}"`
        : `the phrasing behind "${r.id}" (skill: writing-style)`,
    });
  }
  for (const r of m.extrapolations || []) {
    rows.push({
      signal: `extrapolation:${r.id}`, count: r.count, runs: r.runs,
      // Which template slot should have carried the key is a judgement, not a lookup.
      target: '(none)',
      detail: `most recent assumed: ${r.assumed || '(none)'} — scope/touches declaration for "${r.id}"`,
    });
  }
  for (const r of m.reapprovals || []) {
    rows.push({
      signal: `reapproval:${r.id}`, count: r.count, runs: r.runs,
      target: r.cycle ? `formula:${r.cycle}:${r.id}:reapprove.rearm` : '(none)',
      detail: `${r.count} re-approval${r.count === 1 ? '' : 's'} on step "${r.id}"`,
    });
  }
  for (const r of m.writing || []) {
    rows.push({
      signal: `writing:${r.id}`, count: r.count, runs: r.runs,
      target: 'config:review.writing_mode',
      detail: `${r.count}/${r.total} writing-adversary receipts failed (${r.rate}%) on step "${r.id}"`,
    });
  }
  // Ids are positional over a deterministic order — section order, then each section's own
  // count-desc/id-asc sort — so the same mine result always renders the same ids. They are stable
  // for a file, not across mines: a row's identity is its `signal`, and a human reads both.
  return rows.map((r, i) => ({ id: `S-${String(i + 1).padStart(3, '0')}`, ...r }));
}

function renderMine(m) {
  const rows = mineRows(m);
  const L = ['# Suggestions', '',
    '_Generated by `plt mine` — deterministic, no model. `plt mine` never edits formulas or config;',
    'acting on a row is a human decision. To act on one: replace its `detail` cell with',
    '`proposed: <the value to write>`, then run `plt harvest <id>`. A row whose target is `(none)`',
    'is for a person to act on by hand._', '',
    `_Signals: ${SIGNAL_SECTIONS.join(', ')}._`, ''];
  L.push('| id | signal | count | runs | target | detail |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    L.push(`| ${[r.id, r.signal, r.count, (r.runs || []).join(', '), r.target, r.detail].map(mdEscape).join(' | ')} |`);
  }
  if (!rows.length) L.push('', '_Nothing to suggest._');
  L.push('');
  return L.join('\n');
}

module.exports = { externalCards, reviewFacts,
  STATE_ENUM, POLL_FACTS, findProcessDir, deepMerge, loadConfig, runDir,
  readState, writeState, readInputs, readEvents, appendEvent, rewriteEvents, git,
  runIds, repoOwner: repoWindow.repoOwner, claimRepo: repoWindow.claimRepo, computePin, resolveRef, compileRequirements, recordReceipt, gateCheck, gateApprove, gateRevoke, normalizeGhName, callerWindow,
  loadFormula, runFormula, launchRun, recompileRun, betweenRounds, FACTS_COLLECTOR, validateFormula, formulaTemplates, assertHuman, assertRepo, assertWindow, personOf, actorFields, blockedStep, openQuestion, discardRun, closeRun, pollRun, stepStart, stepUnstart, stepFinish, writeHandoff, nextCommand, renderPrime, renderBanners,
  DEFAULT_MENU_WORDS, menuFor, renderMenu, parseMenuPhrase,
  syncSince, mine, mineRows, renderMine, assumedText,
};
