'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures', 'spine');
const PKG = require('../package.json');

// doctor consumes the schema and fsck modules through a lazy, OPTIONAL require, so it has to be
// correct both with them and without them. The hook below answers doctor's own `require('./schemas')`
// and `require('./fsck')` — and nothing else — with whichever stand-in the test asked for. That keeps
// these tests pinned to doctor's own behaviour and independent of what those two modules currently
// say about live files.
const Module = require('module');
const DOCTOR = require.resolve('../lib/doctor');
let stubs = {};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename === DOCTOR && Object.prototype.hasOwnProperty.call(stubs, request)) {
    const s = stubs[request];
    if (s === null) { const e = new Error(`Cannot find module '${request}'`); e.code = 'MODULE_NOT_FOUND'; throw e; }
    return s;
  }
  return realLoad.apply(this, arguments);
};
function loadDoctor(s) { stubs = s || {}; delete require.cache[DOCTOR]; return require(DOCTOR); }

// Both modules present and happy, unless a test says otherwise.
const OK_SCHEMAS = { validateFile: () => ({ ok: true, errors: [] }) };
const OK_FSCK = { fsckAll: () => ({ ok: true, runs: [] }) };
function doctorWith(extra) { return loadDoctor(Object.assign({ './schemas': OK_SCHEMAS, './fsck': OK_FSCK }, extra || {})); }

// ---- fixture ---------------------------------------------------------------

const CYCLE = (name, body) => `---
name: ${name}
kind: workflow
version: 1
description: "A probe cycle for the doctor tests."
domain: engineering
tags: [spine]
inputs: [card]
actors: [agent]
---

# ${name}

steps:
${body}
`;

const PLAIN_STEP = `  - id: only
    assignee: agent
    title: "Probe {card}"
    outcomes: [done]`;

function tmpProject(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  const p = path.join(dir, 'process');
  fs.cpSync(FIX, p, { recursive: true });
  fs.mkdirSync(path.join(p, 'runs'), { recursive: true });
  const deny = path.join(dir, 'terms.txt');
  fs.writeFileSync(deny, 'one\n');
  fs.chmodSync(deny, 0o600);
  const tracker = path.join(dir, 'tracker.py');
  fs.writeFileSync(tracker, '#\n');
  fs.writeFileSync(path.join(p, 'config', 'zz-doctor.yaml'), `denylist_file: ${deny}\njira: { kind: none, script: ${tracker} }\ndeps: [gitnexus]\n`);
  if (opts.dropPanelMode) {
    const f = path.join(p, 'config', 'defaults.yaml');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^\s*panel_mode: hard\n/m, ''));
  }
  if (opts.cycle) fs.writeFileSync(path.join(p, 'cycles', `${opts.cycle.name}.md`), CYCLE(opts.cycle.name, opts.cycle.body));
  return { dir, processDir: p, deny, tracker };
}

// `plt` on PATH at this checkout's version, and `gh auth status` happy.
function fakeExec(over = {}) {
  return (cmd, args) => {
    const line = [cmd, ...(args || [])].join(' ');
    if (over[line]) return over[line];
    if (cmd === 'sh') return { code: 0, stdout: '/Users/x/.local/bin/plt\n', stderr: '', timedOut: false };
    if (cmd === 'plt') return { code: 0, stdout: PKG.version + '\n', stderr: '', timedOut: false };
    if (cmd === 'gh') return { code: 0, stdout: 'Logged in\n', stderr: '', timedOut: false };
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  };
}

const OK_TIMER = { installed: true, loaded: true, runs: 4, lastExit: 0, ok: true, reason: null };
function opts(over = {}) {
  return Object.assign({
    exec: fakeExec(),
    env: {},
    home: os.homedir(),
    deps: { timerStatus: () => OK_TIMER, statusClaude: () => ({ version: '1', files: [], settings: { ok: true, missing: [] }, permissions: { ok: true, missing: [], violations: [] }, ok: true }) },
  }, over);
}
const byId = (r, id) => r.checks.find((c) => c.id === id);

// Every check runDoctor is expected to report, in order. runDoctor is `CHECKS.map(...)` with a
// per-check catch, so asserting `checks.length === CHECKS.length` asserts nothing at all; the
// roster below is what catches a registration dropped, duplicated or renamed by accident.
const CHECK_IDS = [
  'plt-resolvable', 'process-dir', 'config-layering', 'formulas-validate', 'schemas',
  'state-fields-declared', 'hooks-installed', 'timers-running', 'denylist-file', 'gh',
  'deps', 'tracker', 'runs-consistent',
];

// README.md documents the roster in prose, and prose does not run. It said 'twelve checks' and
// listed twelve while doctor carried thirteen — drift created by the commit that added the
// thirteenth, caught by a person reading it. On a card about a guard that looked present and
// reported nothing, a documented roster nothing verifies is the same shape, so it is verified here.
const NUMBER_WORDS = { 10: 'ten', 11: 'eleven', 12: 'twelve', 13: 'thirteen', 14: 'fourteen', 15: 'fifteen', 16: 'sixteen' };

test('README lists exactly the checks doctor registers, and counts them correctly', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const m = /It runs ([a-z]+) checks:([\s\S]*?)\. Each check/.exec(readme);
  assert.ok(m, 'README must carry an "It runs <n> checks: …" roster for plt doctor');
  const listed = [...m[2].matchAll(/`([a-z][a-z-]*)`/g)].map((x) => x[1]);
  assert.deepStrictEqual(listed, CHECK_IDS, 'README roster and doctor registration disagree');
  const word = NUMBER_WORDS[CHECK_IDS.length];
  assert.ok(word, `add ${CHECK_IDS.length} to NUMBER_WORDS in this test`);
  assert.strictEqual(m[1], word, `README says "${m[1]} checks" for ${CHECK_IDS.length}`);
});
// ---- (a) complete fixture --------------------------------------------------

test('doctor: a complete project passes every registered check', () => {
  const doctor = doctorWith();
  const { dir } = tmpProject();
  const r = doctor.runDoctor(dir, opts());
  const bad = r.checks.filter((c) => c.state !== 'pass').map((c) => `${c.id}: ${c.state} — ${c.detail}`);
  assert.deepStrictEqual(bad, []);
  assert.deepStrictEqual(r.checks.map((c) => c.id), CHECK_IDS);
  assert.strictEqual(r.ok, true);
});

test('deps: a declared tool that does not resolve fails, and the fix is the installer', () => {
  const doctor = doctorWith();
  const { dir } = tmpProject();
  const miss = { code: 1, stdout: '', stderr: '', timedOut: false };
  const r = doctor.runDoctor(dir, opts({ exec: fakeExec({ 'sh -c command -v gitnexus': miss }) }));
  const c = byId(r, 'deps');
  assert.strictEqual(c.state, 'fail');
  assert.strictEqual(c.detail, 'missing: gitnexus');
  assert.strictEqual(c.fix, `plt deps install --project ${dir}`);
});

// ---- (b) formulas-validate -------------------------------------------------

test('formulas-validate: an unresolved {{config.*}} reference fails, naming the cycle file and the key', () => {
  const doctor = doctorWith();
  const { dir } = tmpProject({
    dropPanelMode: true,
    cycle: { name: 'probe-skills', body: `  - id: only
    assignee: agent
    title: "Probe {card}"
    skills: "{{config.review.panel_mode}}"
    outcomes: [done]` },
  });
  const c = byId(doctor.runDoctor(dir, opts()), 'formulas-validate');
  assert.strictEqual(c.state, 'fail');
  assert.match(c.detail, /cycles\/.*\.md/);
  assert.match(c.detail, /review\.panel_mode/);
});

test('formulas-validate: the same missing key under gate.mode does NOT fail — it falls back in code', () => {
  const doctor = doctorWith();
  const { dir } = tmpProject({
    dropPanelMode: true,
    cycle: { name: 'probe-gate', body: `  - id: only
    assignee: agent
    title: "Probe {card}"
    outcomes: [done]
    gate: { kind: adversarial, agents: [writing-adversary], mode: "{{config.review.panel_mode}}" }` },
  });
  const c = byId(doctor.runDoctor(dir, opts()), 'formulas-validate');
  assert.strictEqual(c.state, 'pass', c.detail);
});

// ---- (c) timers ------------------------------------------------------------

test('timers-running: installed and loaded but runs = 0 is a fail, not a pass', () => {
  const doctor = doctorWith();
  const { dir } = tmpProject();
  const r = doctor.runDoctor(dir, opts({
    deps: Object.assign({}, opts().deps, { timerStatus: () => ({ installed: true, loaded: true, runs: 0, ok: false, reason: 'installed but never run' }) }),
  }));
  const c = byId(r, 'timers-running');
  assert.strictEqual(c.state, 'fail');
  assert.match(c.detail, /installed but never run/);
  assert.match(doctor.formatDoctor(r), /plt integration install timers/);
});

// A timer that ran once and then stopped still has runs > 0 and last exit 0. Only the time of
// its last run gives it away. The fixture config sets no timers.watch.every, so the interval is 10m.
const NOW = Date.parse('2026-09-30T12:00:00Z');
function timerAt(lastRun) {
  return opts({ now: () => NOW, deps: Object.assign({}, opts().deps, { timerStatus: () => Object.assign({}, OK_TIMER, { lastRun }) }) });
}

test('timers-running: a last run older than three intervals is a fail, naming how long ago', () => {
  const doctor = doctorWith();
  const { dir } = tmpProject();
  const c = byId(doctor.runDoctor(dir, timerAt('2026-09-30T10:00:00Z')), 'timers-running');
  assert.strictEqual(c.state, 'fail');
  assert.match(c.detail, /last ran 2h ago, expected every 10m/);
  assert.match(c.fix, /plt integration install timers/);
});

test('timers-running: one missed tick is not a fault', () => {
  const doctor = doctorWith();
  const { dir } = tmpProject();
  const c = byId(doctor.runDoctor(dir, timerAt('2026-09-30T11:45:00Z')), 'timers-running');
  assert.strictEqual(c.state, 'pass');
  assert.match(c.detail, /last ran 15m ago/);
});

test('timers-running: the systemd time form is read, and an unreadable time never fails', () => {
  const doctor = doctorWith();
  const { dir } = tmpProject();
  // Built from local fields, because the systemd form carries a zone abbreviation that is read as local time.
  const d = new Date(NOW - 5 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const sd = `Wed ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} CDT`;
  assert.strictEqual(byId(doctor.runDoctor(dir, timerAt(sd)), 'timers-running').state, 'fail');
  const c = byId(doctor.runDoctor(dir, timerAt('whenever')), 'timers-running');
  assert.strictEqual(c.state, 'pass');
  assert.match(c.detail, /last run time unknown/);
});

// ---- (d) denylist ----------------------------------------------------------

test('denylist-file: a missing path fails, and the wrong mode is reported exactly', () => {
  const doctor = doctorWith();
  const a = tmpProject();
  fs.unlinkSync(a.deny);
  const c1 = byId(doctor.runDoctor(a.dir, opts()), 'denylist-file');
  assert.strictEqual(c1.state, 'fail');
  assert.match(c1.detail, /no such file/);

  const b = tmpProject();
  fs.chmodSync(b.deny, 0o644);
  const c2 = byId(doctor.runDoctor(b.dir, opts()), 'denylist-file');
  assert.strictEqual(c2.state, 'fail');
  assert.strictEqual(c2.detail, 'mode is 644, want 600');
});

test('denylist-file: ~ and $HOME in the configured path are expanded', () => {
  const doctor = doctorWith();
  const { dir, processDir, deny } = tmpProject();
  fs.writeFileSync(path.join(processDir, 'config', 'zz-doctor.yaml'), `denylist_file: "~/${path.relative(dir, deny)}"\njira: { kind: none }\n`);
  const c = byId(doctor.runDoctor(dir, opts({ home: dir })), 'denylist-file');
  assert.strictEqual(c.state, 'pass', c.detail);
});

// ---- (e) the optional modules ---------------------------------------------

test('schemas and runs-consistent skip when their modules are not on disk, and ok stays true', () => {
  const doctor = doctorWith({ './schemas': null, './fsck': null });
  const { dir } = tmpProject();
  const r = doctor.runDoctor(dir, opts());
  assert.strictEqual(byId(r, 'schemas').state, 'skip');
  assert.match(byId(r, 'schemas').detail, /not shipped yet/);
  assert.strictEqual(byId(r, 'runs-consistent').state, 'skip');
  assert.match(byId(r, 'runs-consistent').detail, /not shipped yet/);
  assert.strictEqual(r.ok, true);
});

test('schemas: a rejected run file is its own check, and says which file and how many were read', () => {
  const doctor = doctorWith({ './schemas': { validateFile: (kind, f) => f.endsWith('state.yaml') ? { ok: false, errors: [{ path: '/status', message: 'must be one of …' }] } : { ok: true, errors: [] } } });
  const { dir, processDir } = tmpProject();
  const run = path.join(processDir, 'runs', 'TRK-01');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'state.yaml'), 'run: TRK-01\n');
  fs.writeFileSync(path.join(run, 'inputs.yaml'), 'card: TRK-01\n');
  fs.writeFileSync(path.join(run, 'events.jsonl'), '{"id":"e000001"}\n');
  const r = doctor.runDoctor(dir, opts());
  const c = byId(r, 'schemas');
  assert.strictEqual(c.state, 'fail');
  assert.match(c.detail, /state\.yaml/);
  assert.match(c.detail, /\/status/);
  // The schema verdict is its own check; nothing else is dragged down with it.
  assert.strictEqual(byId(r, 'runs-consistent').state, 'pass');
  assert.strictEqual(byId(r, 'config-layering').state, 'pass');
});

test('schemas: legacy events (warnings from validateFile) pass, and the detail counts them', () => {
  const doctor = doctorWith({ './schemas': { validateFile: (kind) => (kind === 'event' ? { ok: true, errors: [], warnings: [{ path: 'line 1 /actor', message: 'x' }] } : { ok: true, errors: [] }) } });
  const { dir, processDir } = tmpProject();
  const run = path.join(processDir, 'runs', 'TRK-01');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'state.yaml'), 'run: TRK-01\n');
  fs.writeFileSync(path.join(run, 'events.jsonl'), '{"id":"e000001"}\n');
  const c = byId(doctor.runDoctor(dir, opts()), 'schemas');
  assert.strictEqual(c.state, 'pass');
  assert.match(c.detail, /1 W_EVENT_LEGACY/);
});

test('runs-consistent: a run whose only findings are warnings (W_*) passes', () => {
  const doctor = doctorWith({ './fsck': { fsckAll: () => ({ ok: true, runs: [{ run: 'TRK-01', ok: true, findings: [{ code: 'W_EVENT_LEGACY', severity: 'warn' }] }] }) } });
  const { dir } = tmpProject();
  assert.strictEqual(byId(doctor.runDoctor(dir, opts()), 'runs-consistent').state, 'pass');
});

// ---- (f) format ------------------------------------------------------------

test('formatDoctor: an all-pass result has no fix list; a failing one numbers the pasteable commands', () => {
  const doctor = doctorWith();
  const { dir } = tmpProject();
  const pass = doctor.formatDoctor(doctor.runDoctor(dir, opts()));
  assert.ok(!pass.includes('Fix, in order:'), pass);
  assert.match(pass, /^✓ plt-resolvable {2}/m);

  fs.unlinkSync(path.join(dir, 'terms.txt'));
  const fail = doctor.formatDoctor(doctor.runDoctor(dir, opts()));
  assert.match(fail, /^✗ denylist-file {2}.* — .*no such file/m);
  assert.match(fail, /\nFix, in order:\n\s*1\. install -m 600 \/dev\/null /);
});

test('formatDoctor: a skipped check is marked skipped, never failed', () => {
  const doctor = doctorWith({ './schemas': null, './fsck': null });
  const { dir } = tmpProject();
  const out = doctor.formatDoctor(doctor.runDoctor(dir, opts()));
  assert.match(out, /^· schemas {2}.*\(skipped: .*not shipped yet\)$/m);
});

// ---- (g) CLI ---------------------------------------------------------------

test('cli doctor: exit 0 when every check passes, 1 when any fails', () => {
  const doctor = doctorWith();
  const { dir } = tmpProject();
  let out = '';
  const io = { write: (t) => { out += t; } };
  assert.strictEqual(doctor.cli(['doctor', '--project', dir], Object.assign(opts(), { io })), 0);
  assert.match(out, /✓ process-dir/);

  fs.unlinkSync(path.join(dir, 'terms.txt'));
  assert.strictEqual(doctor.cli(['doctor', '--project', dir], Object.assign(opts(), { io })), 1);
});

test('cli doctor --json prints the result object', () => {
  const doctor = doctorWith();
  const { dir } = tmpProject();
  let out = '';
  doctor.cli(['doctor', '--project', dir, '--json'], Object.assign(opts(), { io: { write: (t) => { out += t; } } }));
  const parsed = JSON.parse(out);
  assert.deepStrictEqual(parsed.checks.map((c) => c.id), CHECK_IDS);
  assert.strictEqual(parsed.ok, true);
});

test('doctor ships a commands export the registry can discover', () => {
  const doctor = doctorWith();
  assert.strictEqual(doctor.commands.length, 1);
  assert.strictEqual(doctor.commands[0].name, 'doctor');
  assert.match(doctor.commands[0].usage, /^plt doctor /);
  assert.strictEqual(typeof doctor.commands[0].handler, 'function');
});

// ---- never throws, never cries wolf ---------------------------------------

test('a check that throws becomes a fail carrying the message — runDoctor never throws', () => {
  const doctor = doctorWith();
  const { dir } = tmpProject();
  const r = doctor.runDoctor(dir, opts({
    deps: Object.assign({}, opts().deps, { statusClaude: () => { throw new Error('boom from statusClaude'); } }),
  }));
  const c = byId(r, 'hooks-installed');
  assert.strictEqual(c.state, 'fail');
  assert.strictEqual(c.detail, 'boom from statusClaude');
  assert.strictEqual(r.ok, false);
});

test('gh: a shell-out that times out is a skip, never a fail', () => {
  const doctor = doctorWith();
  const { dir } = tmpProject();
  const r = doctor.runDoctor(dir, opts({ exec: fakeExec({ 'gh auth status': { code: null, stdout: '', stderr: '', timedOut: true } }) }));
  const c = byId(r, 'gh');
  assert.strictEqual(c.state, 'skip');
  assert.match(c.detail, /5s/);
  assert.strictEqual(r.ok, true);
});

test('gh: an unauthenticated gh fails — the case the shell-out exists to catch', () => {
  const doctor = doctorWith();
  const { dir } = tmpProject();
  const r = doctor.runDoctor(dir, opts({ exec: fakeExec({ 'gh auth status': { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.\n', timedOut: false } }) }));
  const c = byId(r, 'gh');
  assert.strictEqual(c.state, 'fail');
  assert.match(c.detail, /not logged into/);
  assert.strictEqual(c.fix, 'gh auth login');
});

test('plt-resolvable: a version that disagrees with package.json fails and says both', () => {
  const doctor = doctorWith();
  const { dir } = tmpProject();
  const r = doctor.runDoctor(dir, opts({ exec: fakeExec({ 'plt --version': { code: 0, stdout: '0.0.9\n', stderr: '', timedOut: false } }) }));
  const c = byId(r, 'plt-resolvable');
  assert.strictEqual(c.state, 'fail');
  assert.match(c.detail, /0\.0\.9/);
  assert.match(c.detail, new RegExp(PKG.version.replace(/\./g, '\\.')));
});

test('process-dir: a project with no process/ fails with a mkdir -p fix naming that project', () => {
  const doctor = doctorWith();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-bare-'));
  const r = doctor.runDoctor(dir, opts());
  const c = byId(r, 'process-dir');
  assert.strictEqual(c.state, 'fail');
  assert.ok(c.fix.startsWith('mkdir -p ' + path.join(dir, 'process') + '/config'), c.fix);
  // Every downstream check still reports rather than exploding.
  assert.deepStrictEqual(r.checks.map((c) => c.id), CHECK_IDS);
});

test('config-layering: a config file that does not parse names the file', () => {
  const doctor = doctorWith();
  const { dir, processDir } = tmpProject();
  fs.writeFileSync(path.join(processDir, 'config', 'zz-broken.yaml'), 'a: [1,\n  b: : :\n');
  const c = byId(doctor.runDoctor(dir, opts()), 'config-layering');
  assert.strictEqual(c.state, 'fail');
  assert.match(c.detail, /zz-broken\.yaml/);
});

test('tracker: absent config.jira skips; a named script that is missing fails', () => {
  const doctor = doctorWith();
  const { dir, processDir, deny } = tmpProject();
  const cfgFile = path.join(processDir, 'config', 'zz-doctor.yaml');

  fs.writeFileSync(cfgFile, `denylist_file: ${deny}\njira: { kind: none, script: ${path.join(dir, 'nope.py')} }\n`);
  const bad = byId(doctor.runDoctor(dir, opts()), 'tracker');
  assert.strictEqual(bad.state, 'fail');
  assert.match(bad.detail, /nope\.py/);

  // The fixture's own config sets no `jira` key at all once this file stops naming one.
  fs.writeFileSync(cfgFile, `denylist_file: ${deny}\n`);
  fs.writeFileSync(path.join(processDir, 'config', 'sprout.yaml'),
    fs.readFileSync(path.join(processDir, 'config', 'sprout.yaml'), 'utf8').replace(/^jira:.*\n/m, ''));
  fs.writeFileSync(path.join(processDir, 'config', 'defaults.yaml'),
    fs.readFileSync(path.join(processDir, 'config', 'defaults.yaml'), 'utf8').replace(/^jira:\n  kind: none\n/m, ''));
  const skipped = byId(doctor.runDoctor(dir, opts()), 'tracker');
  assert.strictEqual(skipped.state, 'skip');
  assert.match(skipped.detail, /config\.jira/);
});

test('a relative path in config resolves against the project, not the cwd the command was typed in', () => {
  const doctor = doctorWith();
  const { dir, processDir, deny } = tmpProject();
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tools', 'tracker.py'), '#\n');
  fs.writeFileSync(path.join(processDir, 'config', 'zz-doctor.yaml'), `denylist_file: ${deny}\njira: { kind: none, script: tools/tracker.py }\n`);
  const c = byId(doctor.runDoctor(dir, opts()), 'tracker');
  assert.strictEqual(c.state, 'pass', c.detail);
  assert.strictEqual(c.detail, path.join(dir, 'tools', 'tracker.py'));
});

// The `schemas` check names a schema kind per run file. It once named `events` (the file's plural
// name) where the schema kind is `event`; validateFile threw `unknown schema kind`, the check
// counted the throw as a rejected file, and so every ledger reported broken while not one was ever
// validated — a check that fails loudly for the wrong reason is worse than one that is absent.
// Assert against the real exported KINDS, never a copy, so a renamed kind breaks this test first.
test('doctor: every schema kind the `schemas` check names is a real schema kind', () => {
  const schemas = require('../lib/schemas');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'doctor.js'), 'utf8');
  const line = src.split('\n').find((l) => l.includes("'state.yaml'") && l.includes("'events.jsonl'"));
  assert.ok(line, 'could not find the schemas check\'s kind/file list in lib/doctor.js');
  const named = [...line.matchAll(/\['([a-z]+)',\s*'[^']+'\]/g)].map((m) => m[1]);
  assert.deepStrictEqual(named, ['state', 'inputs', 'event']);
  for (const kind of named) {
    assert.ok(schemas.KINDS.includes(kind), `doctor names schema kind "${kind}", which is not in schemas.KINDS (${schemas.KINDS.join(', ')})`);
  }
});
