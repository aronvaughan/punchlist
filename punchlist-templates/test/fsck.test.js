'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const spine = require('../lib/spine');
const FIX = path.join(__dirname, 'fixtures', 'spine');

// fsck consumes the schema module through a lazy, OPTIONAL require, so it has to be correct both
// with the module and without it. These tests drive that seam directly: the hook below answers
// fsck's own `require('./schemas')` — and nothing else — with whichever stand-in the test asked
// for, so the suite pins fsck's own behaviour rather than the schema module's content.
const Module = require('module');
const FSCK = require.resolve('../lib/fsck');
let stub = { absent: true };
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './schemas' && parent && parent.filename === FSCK) {
    if (stub.absent) { const e = new Error("Cannot find module './schemas'"); e.code = 'MODULE_NOT_FOUND'; throw e; }
    return stub.mod;
  }
  return realLoad.apply(this, arguments);
};
function loadFsck(s) { stub = s; delete require.cache[FSCK]; return require(FSCK); }

// The default for every test below: no schema module on disk, so no `E_*_SCHEMA` finding can fire.
const fsck = loadFsck({ absent: true });

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsck-repo-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  execFileSync('git', ['-C', dir, 'add', 'a.txt']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'init']);
  return dir;
}

function eventsPath(p, run) { return path.join(p, 'runs', run, 'events.jsonl'); }
function eventLines(p, run) { return fs.readFileSync(eventsPath(p, run), 'utf8').split('\n').filter(Boolean); }

// One run (TRK-10) on the greenhouse build-and-ship cycle, launched against a real one-commit repo,
// with three good events: the launch `claimed` time event and two receipts the `build` step requires.
function fixtureProcess(o = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsck-'));
  const p = path.join(root, 'process');
  fs.cpSync(FIX, p, { recursive: true });
  const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-10', cycle: 'build-and-ship', repoDir: repo, owner: 'greenhouse' });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-10', 'inputs.yaml'), 'card: TRK-10\neffort: greenhouse\n');
  const st = spine.readState(p, 'TRK-10');
  const req = (step, kind) => st.steps[step].receipts_required.find((r) => r.kind === kind);
  spine.appendEvent(p, 'TRK-10', { kind: 'skill', step: 'build', name: req('build', 'skill').name, pin: st.pin, actor: 'agent' });
  spine.appendEvent(p, 'TRK-10', { kind: 'tool', step: 'build', name: req('build', 'tool').name, pin: st.pin, actor: 'agent' });
  if (o.requirementName && !st.steps['open-pr'].receipts_required.some((r) => r.kind === 'gh' && r.name === o.requirementName)) {
    st.steps['open-pr'].receipts_required.push({ kind: 'gh', name: o.requirementName });
    spine.writeState(p, 'TRK-10', st);
  }
  if (o.ghReceiptName) {
    spine.appendEvent(p, 'TRK-10', { kind: 'gh', step: 'open-pr', name: o.ghReceiptName, result: 'pass', pin: st.pin, actor: 'agent' });
  }
  if (o.closed) {
    const s2 = spine.readState(p, 'TRK-10');
    s2.status = 'closed';
    delete s2.facts;
    spine.writeState(p, 'TRK-10', s2);
  }
  return p;
}

// Rewrite the id of the `n`th event (1-based) in place, byte for byte.
function rewriteEventId(p, run, n, id) {
  const lines = eventLines(p, run);
  const ev = JSON.parse(lines[n - 1]);
  ev.id = id;
  lines[n - 1] = JSON.stringify(ev);
  fs.writeFileSync(eventsPath(p, run), lines.map((l) => l + '\n').join(''));
}

test('a clean run is ok with no findings, and formats as `<run>: ok`', () => {
  const p = fixtureProcess();
  const r = fsck.fsckRun(p, 'TRK-10');
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.run, 'TRK-10');
  assert.strictEqual(fsck.formatFsck(r), 'TRK-10: ok');
});

test('a torn last line is E_EVENT_TRUNCATED and --fix drops it', () => {
  const p = fixtureProcess();                      // one run TRK-10, three good events
  fs.appendFileSync(eventsPath(p, 'TRK-10'), '{"id":"e000004","kind":"sk');
  const before = fsck.fsckRun(p, 'TRK-10');
  assert.strictEqual(before.ok, false);
  assert.ok(before.findings.some((f) => f.code === 'E_EVENT_TRUNCATED' && f.fixable));
  const after = fsck.fsckRun(p, 'TRK-10', { fix: true });
  assert.deepStrictEqual(after.fixed, ['E_EVENT_TRUNCATED']);
  assert.strictEqual(fsck.fsckRun(p, 'TRK-10').findings.filter((f) => f.severity === 'error').length, 0);
});

test('a dry run is the default: findings without --fix change nothing on disk', () => {
  const p = fixtureProcess();
  fs.appendFileSync(eventsPath(p, 'TRK-10'), '{"id":"e000004","kind":"sk');
  const raw = fs.readFileSync(eventsPath(p, 'TRK-10'), 'utf8');
  const r = fsck.fsckRun(p, 'TRK-10');
  assert.deepStrictEqual(r.fixed, []);
  assert.strictEqual(fs.readFileSync(eventsPath(p, 'TRK-10'), 'utf8'), raw);
});

test('an unparsable line that is not the last is E_EVENT_PARSE and is not fixable', () => {
  const p = fixtureProcess();
  const lines = eventLines(p, 'TRK-10');
  lines.splice(1, 0, '{"id":"e00000');
  fs.writeFileSync(eventsPath(p, 'TRK-10'), lines.map((l) => l + '\n').join(''));
  const r = fsck.fsckRun(p, 'TRK-10', { fix: true });
  assert.ok(r.findings.some((f) => f.code === 'E_EVENT_PARSE' && f.fixable === false));
  assert.deepStrictEqual(r.fixed, []);
});

test('a gap in the event ids is E_EVENT_IDS and is not fixable', () => {
  const p = fixtureProcess();
  rewriteEventId(p, 'TRK-10', 2, 'e000005');
  const r = fsck.fsckRun(p, 'TRK-10', { fix: true });
  assert.ok(r.findings.some((f) => f.code === 'E_EVENT_IDS' && f.fixable === false));
  assert.deepStrictEqual(r.fixed, []);
});

test('a byte-identical repeat of the previous line is E_EVENT_IDS and --fix drops it', () => {
  const p = fixtureProcess();
  const lines = eventLines(p, 'TRK-10');
  fs.appendFileSync(eventsPath(p, 'TRK-10'), lines[lines.length - 1] + '\n');
  const before = fsck.fsckRun(p, 'TRK-10');
  assert.ok(before.findings.some((f) => f.code === 'E_EVENT_IDS' && f.fixable === true));
  const r = fsck.fsckRun(p, 'TRK-10', { fix: true });
  assert.deepStrictEqual(r.fixed, ['E_EVENT_IDS']);
  assert.strictEqual(fsck.fsckRun(p, 'TRK-10').findings.filter((f) => f.severity === 'error').length, 0);
});

test('a step in state the formula does not define is E_UNKNOWN_STEP', () => {
  const p = fixtureProcess();
  const st = spine.readState(p, 'TRK-10'); st.steps.invented = { status: 'pending' };
  spine.writeState(p, 'TRK-10', st);
  assert.ok(fsck.fsckRun(p, 'TRK-10').findings.some((f) => f.code === 'E_UNKNOWN_STEP' && /invented/.test(f.detail)));
});

test('a formula step absent from state is E_MISSING_STEP and --fix adds it as pending', () => {
  const p = fixtureProcess();
  const st = spine.readState(p, 'TRK-10'); delete st.steps.merge;
  spine.writeState(p, 'TRK-10', st);
  const r = fsck.fsckRun(p, 'TRK-10', { fix: true });
  assert.ok(r.findings.some((f) => f.code === 'E_MISSING_STEP' && f.fixable));
  assert.deepStrictEqual(r.fixed, ['E_MISSING_STEP']);
  const after = spine.readState(p, 'TRK-10');
  assert.strictEqual(after.steps.merge.status, 'pending');
  assert.ok(Array.isArray(after.steps.merge.receipts_required));
});

test('a step missing its requirements is fixable by recompiling', () => {
  const p = fixtureProcess();
  const st = spine.readState(p, 'TRK-10'); delete st.steps.build.receipts_required;
  spine.writeState(p, 'TRK-10', st);
  const r = fsck.fsckRun(p, 'TRK-10', { fix: true });
  assert.deepStrictEqual(r.fixed, ['E_NO_REQUIREMENTS']);
  assert.ok(Array.isArray(spine.readState(p, 'TRK-10').steps.build.receipts_required));
});

test('a skipped step with no requirements is not E_NO_REQUIREMENTS', () => {
  const p = fixtureProcess();
  const st = spine.readState(p, 'TRK-10');
  delete st.steps.merge.receipts_required;
  st.steps.merge.status = 'skipped';
  spine.writeState(p, 'TRK-10', st);
  assert.ok(!fsck.fsckRun(p, 'TRK-10').findings.some((f) => f.code === 'E_NO_REQUIREMENTS'));
});

test('requirements that drift from a fresh compile warn, stay ok, and --fix recompiles them', () => {
  const p = fixtureProcess();
  const st = spine.readState(p, 'TRK-10');
  st.steps.build.receipts_required = [{ kind: 'skill', name: 'stale-skill' }];
  spine.writeState(p, 'TRK-10', st);
  const before = fsck.fsckRun(p, 'TRK-10');
  assert.ok(before.findings.some((f) => f.code === 'E_REQUIREMENTS_DRIFT' && f.severity === 'warn' && f.fixable));
  assert.strictEqual(before.ok, true);
  const r = fsck.fsckRun(p, 'TRK-10', { fix: true });
  assert.ok(r.fixed.includes('E_REQUIREMENTS_DRIFT'));
  assert.ok(!spine.readState(p, 'TRK-10').steps.build.receipts_required.some((x) => x.name === 'stale-skill'));
});

test('a done step whose requirements drifted is left alone', () => {
  const p = fixtureProcess();
  const st = spine.readState(p, 'TRK-10');
  st.steps.build.status = 'done';
  st.steps.build.receipts_required = [{ kind: 'skill', name: 'as-it-was-when-done' }];
  spine.writeState(p, 'TRK-10', st);
  assert.ok(!fsck.fsckRun(p, 'TRK-10').findings.some((f) => f.code === 'E_REQUIREMENTS_DRIFT'));
});

test('a receipt pinned to a sha the repo cannot resolve is E_PIN_UNRESOLVED and is not fixable', () => {
  const p = fixtureProcess();
  const gone = '0123456789abcdef0123456789abcdef01234567';
  const st = spine.readState(p, 'TRK-10');
  spine.appendEvent(p, 'TRK-10', { kind: 'skill', step: 'build', name: st.steps.build.receipts_required[0].name,
    pin: { kind: 'sha', value: gone }, actor: 'agent' });
  const r = fsck.fsckRun(p, 'TRK-10', { fix: true });
  assert.ok(r.findings.some((f) => f.code === 'E_PIN_UNRESOLVED' && f.fixable === false && f.detail.includes(gone)));
  assert.deepStrictEqual(r.fixed, []);
});

test('an event naming a step state does not have is E_RECEIPT_ORPHAN', () => {
  const p = fixtureProcess();
  const st = spine.readState(p, 'TRK-10');
  spine.appendEvent(p, 'TRK-10', { kind: 'skill', step: 'ghost-step', name: 'x', pin: st.pin, actor: 'agent' });
  const r = fsck.fsckRun(p, 'TRK-10');
  assert.ok(r.findings.some((f) => f.code === 'E_RECEIPT_ORPHAN' && /ghost-step/.test(f.detail)));
  assert.strictEqual(r.ok, false);
});

test('a receipt matching no requirement of its step is W_RECEIPT_UNUSED and stays ok', () => {
  const p = fixtureProcess();
  const st = spine.readState(p, 'TRK-10');
  spine.appendEvent(p, 'TRK-10', { kind: 'skill', step: 'build', name: 'nobody-asked-for-this', pin: st.pin, actor: 'agent' });
  const r = fsck.fsckRun(p, 'TRK-10');
  assert.ok(r.findings.some((f) => f.code === 'W_RECEIPT_UNUSED' && f.severity === 'warn' && /nobody-asked-for-this/.test(f.detail)));
  assert.strictEqual(r.ok, true);
});

test('a closed run with no facts snapshot warns but stays ok', () => {
  const p = fixtureProcess({ closed: true });
  const r = fsck.fsckRun(p, 'TRK-10');
  assert.ok(r.findings.some((f) => f.code === 'W_NO_FACTS_SNAPSHOT' && f.severity === 'warn'));
  assert.strictEqual(r.ok, true);
});

test('checks_green against a checks-green requirement warns on the spelling', () => {
  const p = fixtureProcess({ ghReceiptName: 'checks_green', requirementName: 'checks-green' });
  assert.ok(fsck.fsckRun(p, 'TRK-10').findings.some((f) => f.code === 'W_GH_NAME_SPELLING'));
});

test('without lib/schemas.js on disk, fsckRun still runs and reports no E_*_SCHEMA findings', () => {
  const p = fixtureProcess();
  assert.deepStrictEqual(fsck.fsckRun(p, 'TRK-10').findings.filter((f) => /_SCHEMA$/.test(f.code)), []);
});

test('with a schema module present, each of the three files is validated and reports its own code', () => {
  const kinds = [];
  const withSchemas = loadFsck({ mod: { validateObject: (kind) => { kinds.push(kind); return { ok: false, errors: [{ path: '/kind', message: 'must be one of the allowed values' }] }; } } });
  try {
    const p = fixtureProcess();
    const codes = withSchemas.fsckRun(p, 'TRK-10').findings.filter((f) => /_SCHEMA$/.test(f.code)).map((f) => f.code);
    assert.ok(codes.includes('E_EVENT_SCHEMA'), codes.join(','));
    assert.ok(codes.includes('E_STATE_SCHEMA'), codes.join(','));
    assert.ok(codes.includes('E_INPUTS_SCHEMA'), codes.join(','));
    assert.deepStrictEqual([...new Set(kinds)].sort(), ['event', 'inputs', 'state']);
  } finally { loadFsck({ absent: true }); }
});

test('a schema module that throws is not evidence against the file: the check passes through', () => {
  const broken = loadFsck({ mod: { validateObject: () => { throw new Error('the validator could not be built'); } } });
  try {
    const p = fixtureProcess();
    assert.deepStrictEqual(broken.fsckRun(p, 'TRK-10').findings, []);
  } finally { loadFsck({ absent: true }); }
});

test('spine.runIds, which fsckAll walks, names every directory under runs/ holding a state.yaml, sorted', () => {
  const p = fixtureProcess();
  fs.mkdirSync(path.join(p, 'runs', 'TRK-02'), { recursive: true });
  fs.copyFileSync(path.join(p, 'runs', 'TRK-10', 'state.yaml'), path.join(p, 'runs', 'TRK-02', 'state.yaml'));
  fs.mkdirSync(path.join(p, 'runs', 'not-a-run'), { recursive: true });
  assert.deepStrictEqual(spine.runIds(p), ['TRK-02', 'TRK-10']);
});

test('fsckAll checks every run and is not ok when any run is not ok', () => {
  const p = fixtureProcess();
  fs.appendFileSync(eventsPath(p, 'TRK-10'), '{"id":"e000004","kind":"sk');
  const r = fsck.fsckAll(p);
  assert.strictEqual(r.runs.length, 1);
  assert.strictEqual(r.ok, false);
  assert.match(fsck.formatFsck(r), /E_EVENT_TRUNCATED error:/);
});

test('formatFsck counts errors and warnings and prints one line per finding', () => {
  const p = fixtureProcess({ closed: true });
  const st = spine.readState(p, 'TRK-10');
  spine.appendEvent(p, 'TRK-10', { kind: 'skill', step: 'ghost-step', name: 'x', pin: st.pin, actor: 'agent' });
  const text = fsck.formatFsck(fsck.fsckRun(p, 'TRK-10'));
  assert.match(text.split('\n')[0], /^TRK-10: 1 error\(s\), 1 warning\(s\)$/);
  assert.match(text, /^ {2}E_RECEIPT_ORPHAN error: /m);
  assert.match(text, /^ {2}W_NO_FACTS_SNAPSHOT warn: /m);
});

test('the commands export declares fsck with its usage and handler', () => {
  const c = fsck.commands.find((x) => x.name === 'fsck');
  assert.strictEqual(c.usage, 'plt fsck [<run>] [--all] [--fix] [--project <dir>] [--json]');
  assert.strictEqual(typeof c.handler, 'function');
});

test('the CLI handler exits 0 on a clean run and 1 on a broken one, and --json prints the result', async () => {
  const p = fixtureProcess();
  const root = path.dirname(p);
  const chunks = [];
  const write = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(s); return true; };
  let clean, broken;
  try {
    clean = await fsck.fsckHandler(['TRK-10', '--project', root, '--json']);
    fs.appendFileSync(eventsPath(p, 'TRK-10'), '{"id":"e000004","kind":"sk');
    broken = await fsck.fsckHandler(['--all', '--project', root]);
  } finally { process.stdout.write = write; }
  assert.strictEqual(clean, 0);
  assert.strictEqual(broken, 1);
  assert.strictEqual(JSON.parse(chunks[0]).ok, true);
  assert.match(chunks[1], /E_EVENT_TRUNCATED/);
});

// ---- legacy events and the missing state status (the real schema module) ----

function appendRaw(p, run, ev) {
  const n = eventLines(p, run).length + 1;
  fs.appendFileSync(eventsPath(p, run), JSON.stringify({ id: 'e' + String(n).padStart(6, '0'), run, ...ev }) + '\n');
}

test('a schema-failing event written before the writer fix is W_EVENT_LEGACY (a warning); after it, E_EVENT_SCHEMA', () => {
  const real = loadFsck({ mod: require('../lib/schemas') });
  try {
    const p = fixtureProcess();
    appendRaw(p, 'TRK-10', { ts: '2026-09-17T20:11:57.618Z', kind: 'time', what: 'closed', step: null, actor: 'someone', pin: null });
    let r = real.fsckRun(p, 'TRK-10');
    const legacy = r.findings.filter((f) => f.code === 'W_EVENT_LEGACY');
    assert.strictEqual(legacy.length, 1);
    assert.strictEqual(legacy[0].severity, 'warn');
    assert.ok(!r.findings.some((f) => f.code === 'E_EVENT_SCHEMA'));
    assert.strictEqual(r.ok, true, JSON.stringify(r.findings));
    appendRaw(p, 'TRK-10', { ts: '2026-09-25T09:00:00.000Z', kind: 'time', what: 'closed', step: null, actor: 'someone', pin: null });
    r = real.fsckRun(p, 'TRK-10');
    assert.strictEqual(r.findings.filter((f) => f.code === 'E_EVENT_SCHEMA').length, 1);
    assert.strictEqual(r.ok, false);
    // --fix never rewrites either event: the ledger is append-only.
    const before = fs.readFileSync(eventsPath(p, 'TRK-10'), 'utf8');
    real.fsckRun(p, 'TRK-10', { fix: true });
    assert.strictEqual(fs.readFileSync(eventsPath(p, 'TRK-10'), 'utf8'), before);
  } finally { loadFsck({ absent: true }); }
});

test('a state with no status (launched before launchRun wrote one) is repaired by --fix: open, or closed with a closed stamp', () => {
  const real = loadFsck({ mod: require('../lib/schemas') });
  try {
    for (const [stamp, want] of [[null, 'open'], ['2026-09-20T10:00:00.000Z', 'closed']]) {
      const p = fixtureProcess();
      const file = path.join(p, 'runs', 'TRK-10', 'state.yaml');
      const st = require('yaml').parse(fs.readFileSync(file, 'utf8'));
      delete st.status;
      if (stamp) { st.closed = stamp; st.facts = { at: stamp }; }
      fs.writeFileSync(file, require('yaml').stringify(st));
      const r = real.fsckRun(p, 'TRK-10');
      const f = r.findings.find((x) => x.code === 'E_STATE_SCHEMA');
      assert.ok(f && f.fixable, JSON.stringify(r.findings));
      assert.match(f.detail, new RegExp(`status: ${want} with: plt fsck TRK-10 --fix`));
      const fixed = real.fsckRun(p, 'TRK-10', { fix: true });
      assert.ok(fixed.fixed.includes('E_STATE_SCHEMA'), JSON.stringify(fixed.fixed));
      assert.strictEqual(spine.readState(p, 'TRK-10').status, want);
      assert.ok(!real.fsckRun(p, 'TRK-10').findings.some((x) => x.code === 'E_STATE_SCHEMA'));
      assert.ok(spine.readEvents(p, 'TRK-10').some((e) => e.what === 'fsck-fixed' && e.fixed.includes('E_STATE_SCHEMA')));
    }
  } finally { loadFsck({ absent: true }); }
});

test('any other state schema fault is not repaired by --fix', () => {
  const real = loadFsck({ mod: require('../lib/schemas') });
  try {
    const p = fixtureProcess();
    const file = path.join(p, 'runs', 'TRK-10', 'state.yaml');
    const st = require('yaml').parse(fs.readFileSync(file, 'utf8'));
    st.status = 'half-open';
    fs.writeFileSync(file, require('yaml').stringify(st));
    const f = real.fsckRun(p, 'TRK-10').findings.find((x) => x.code === 'E_STATE_SCHEMA');
    assert.strictEqual(f.fixable, false);
    real.fsckRun(p, 'TRK-10', { fix: true });
    assert.strictEqual(spine.readState(p, 'TRK-10').status, 'half-open');
  } finally { loadFsck({ absent: true }); }
});
