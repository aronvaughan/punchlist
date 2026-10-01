'use strict';
// The integration wiring inside lib/spine.js: the lock and the atomic rename on every state and
// event write, the repo-window guard on the three calls that drive a repo, and fsck enumerating
// runs through spine.runIds. Each module is tested on its own elsewhere; these tests exercise the
// wiring end to end through spine's own exports.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const spine = require('../lib/spine');
const fsck = require('../lib/fsck');
const facts = require('../lib/facts');
const FIX = path.join(__dirname, 'fixtures', 'spine');
const SPINE = path.join(__dirname, '..', 'lib', 'spine.js');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-repo-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  // No .gitignore: the claim and its lock live in the git dir, so a claimed repo still pins clean.
  execFileSync('git', ['-C', dir, 'add', 'a.txt']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'init']);
  return dir;
}

// One greenhouse run, TRK-10, on build-and-ship against a real one-commit repo.
function fixtureProcess() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-'));
  const p = path.join(root, 'process');
  fs.cpSync(FIX, p, { recursive: true });
  const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-10', cycle: 'build-and-ship', repoDir: repo, owner: 'greenhouse' });
  return { p, repo };
}

// A lock another process holds right now: a fresh timestamp, so it is never stale.
function holdLock(p, runId) {
  const lock = path.join(spine.runDir(p, runId), '.plt.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, host: 'elsewhere', at: Date.now() }));
  return lock;
}

function withWindow(w, fn) {
  const before = process.env.PLT_WINDOW;
  if (w === null) delete process.env.PLT_WINDOW; else process.env.PLT_WINDOW = w;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.PLT_WINDOW; else process.env.PLT_WINDOW = before;
  }
}

// ---- the lock and the atomic rename ----------------------------------------

test('100 sequential appendEvent calls produce e000001..e000100 with no gap', () => {
  const { p } = fixtureProcess();
  for (let i = 0; i < 100; i++) spine.appendEvent(p, 'TRK-10', { kind: 'time', name: 'tick' });
  const ids = spine.readEvents(p, 'TRK-10').map((e) => e.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.strictEqual(ids[ids.length - 1], 'e' + String(ids.length).padStart(6, '0'));
  ids.forEach((id, i) => assert.strictEqual(id, 'e' + String(i + 1).padStart(6, '0')));
});

test('two child processes appending concurrently lose no event', async () => {
  const { p } = fixtureProcess();
  fs.rmSync(path.join(spine.runDir(p, 'TRK-10'), 'events.jsonl'));   // start the ledger empty
  const script = `const s = require(${JSON.stringify(SPINE)});
    for (let i = 0; i < 50; i++) s.appendEvent(process.argv[1], 'TRK-10', { kind: 'time', name: 'tick-' + process.argv[2] });`;
  const child = (tag) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', script, p, tag], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`child ${tag} exited ${code}: ${err}`))));
  });
  await Promise.all([child('a'), child('b')]);   // both run at once
  const ids = spine.readEvents(p, 'TRK-10').map((e) => e.id);
  assert.strictEqual(ids.length, 100);
  assert.strictEqual(new Set(ids).size, 100);
  assert.strictEqual(ids[99], 'e000100');
});

test('writeState refuses to write while another plt holds the run lock, and leaves no temp file', () => {
  const { p } = fixtureProcess();
  const lock = holdLock(p, 'TRK-10');
  const st = spine.readState(p, 'TRK-10');
  st.owner = 'someone-else';
  assert.throws(() => spine.writeState(p, 'TRK-10', st), /another plt is writing/);
  fs.unlinkSync(lock);
  assert.strictEqual(spine.readState(p, 'TRK-10').owner, 'greenhouse');
  assert.deepStrictEqual(fs.readdirSync(spine.runDir(p, 'TRK-10')).filter((f) => f.endsWith('.tmp')), []);
});

// Both children read the state, wait until both have read, then write a different field. The lock
// orders the writes; the second sees a changed file and is refused instead of erasing the first.
test('two processes doing a concurrent read-modify-write: one succeeds, one is refused, nothing is lost', async () => {
  const { p } = fixtureProcess();
  const gate = path.join(path.dirname(p), 'gate');
  fs.mkdirSync(gate);
  const script = `const fs = require('fs'); const path = require('path');
    const s = require(${JSON.stringify(SPINE)});
    const [p, tag, gate] = process.argv.slice(1);
    const st = s.readState(p, 'TRK-10');
    fs.writeFileSync(path.join(gate, tag), '');
    while (fs.readdirSync(gate).length < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    st['written_by_' + tag] = true;
    try { s.writeState(p, 'TRK-10', st); process.exit(0); }
    catch (e) { process.stderr.write(e.message); process.exit(/changed since it was read/.test(e.message) ? 3 : 1); }`;
  const child = (tag) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', script, p, tag, gate], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', reject);
    c.on('close', (code) => resolve({ tag, code, err }));
  });
  const results = await Promise.all([child('a'), child('b')]);
  const codes = results.map((r) => r.code).sort();
  assert.deepStrictEqual(codes, [0, 3], JSON.stringify(results));
  const winner = results.find((r) => r.code === 0).tag;
  const loser = results.find((r) => r.code === 3);
  assert.match(loser.err, /state\.yaml for TRK-10 changed since it was read — re-read and retry/);
  const after = spine.readState(p, 'TRK-10');
  assert.strictEqual(after['written_by_' + winner], true);
  assert.strictEqual(after['written_by_' + loser.tag], undefined);
});

test('writeState refuses a state read before another write, and accepts it once re-read', () => {
  const { p } = fixtureProcess();
  const stale = spine.readState(p, 'TRK-10');
  const fresh = spine.readState(p, 'TRK-10');
  fresh.owner = 'first-writer';
  spine.writeState(p, 'TRK-10', fresh);
  stale.owner = 'second-writer';
  assert.throws(() => spine.writeState(p, 'TRK-10', stale), /state\.yaml for TRK-10 changed since it was read — re-read and retry/);
  assert.strictEqual(spine.readState(p, 'TRK-10').owner, 'first-writer');
  fresh.owner = 'first-writer-again';                  // the object that wrote may write again
  spine.writeState(p, 'TRK-10', fresh);
  const reread = spine.readState(p, 'TRK-10');
  reread.owner = 'second-writer';
  spine.writeState(p, 'TRK-10', reread);
  assert.strictEqual(spine.readState(p, 'TRK-10').owner, 'second-writer');
});

test('a state object with no remembered read writes as before, and the hash never reaches the file', () => {
  const { p } = fixtureProcess();
  const built = JSON.parse(JSON.stringify(spine.readState(p, 'TRK-10')));
  built.owner = 'hand-built';
  spine.writeState(p, 'TRK-10', built);
  const text = fs.readFileSync(path.join(spine.runDir(p, 'TRK-10'), 'state.yaml'), 'utf8');
  assert.match(text, /owner: hand-built/);
  assert.doesNotMatch(text, /hash/);
  assert.deepStrictEqual(Object.keys(spine.readState(p, 'TRK-10')), Object.keys(built));
});

test('appendEvent still drops a torn trailing line before appending', () => {
  const { p } = fixtureProcess();
  fs.appendFileSync(path.join(spine.runDir(p, 'TRK-10'), 'events.jsonl'), '{"id":"e000002","kind":"ti');
  const ev = spine.appendEvent(p, 'TRK-10', { kind: 'time', name: 'after-crash' });
  assert.strictEqual(ev.id, 'e000002');
  assert.deepStrictEqual(spine.readEvents(p, 'TRK-10').map((e) => e.id), ['e000001', 'e000002']);
});

test('the lock file is gone after every write', () => {
  const { p } = fixtureProcess();
  spine.appendEvent(p, 'TRK-10', { kind: 'time', name: 'tick' });
  spine.writeState(p, 'TRK-10', spine.readState(p, 'TRK-10'));
  assert.strictEqual(fs.existsSync(path.join(spine.runDir(p, 'TRK-10'), '.plt.lock')), false);
});

// ---- the repo-window guard -------------------------------------------------

function pinOf(p) { return spine.readState(p, 'TRK-10').pin; }

test('spine re-exports repoOwner and claimRepo', () => {
  const repo = tmpRepo();
  assert.deepStrictEqual(spine.claimRepo(repo, 'w1'), { claimed: true, heldBy: null });
  assert.strictEqual(spine.repoOwner(repo).window, 'w1');
});

test('a second window cannot record a receipt against a repo the first claimed', () => {
  const { p, repo } = fixtureProcess();
  spine.claimRepo(repo, 'w1');
  withWindow('w2', () => {
    assert.throws(() => spine.recordReceipt(p, 'TRK-10', { kind: 'skill', name: 'x', step: 'build', pin: pinOf(p) }),
      /is being driven by window w1/);
  });
});

test('the window that claimed the repo records receipts as before', () => {
  const { p, repo } = fixtureProcess();
  spine.claimRepo(repo, 'w1');
  withWindow('w1', () => {
    assert.doesNotThrow(() => spine.recordReceipt(p, 'TRK-10', { kind: 'skill', name: 'x', step: 'build', pin: pinOf(p) }));
  });
});

test('a caller with no PLT_WINDOW passes the guard on a claimed repo, as it passes the run guard', () => {
  const { p, repo } = fixtureProcess();
  spine.claimRepo(repo, 'w1');
  withWindow(null, () => {
    assert.doesNotThrow(() => spine.recordReceipt(p, 'TRK-10', { kind: 'skill', name: 'x', step: 'build', pin: pinOf(p) }));
  });
});

test('pollRun lands a run whose repo w1 claimed, with PLT_WINDOW unset', () => {
  const { p, repo } = fixtureProcess();
  const st = spine.readState(p, 'TRK-10');
  for (const id of ['scope', 'build', 'review', 'write-review', 'pre-pr', 'approve', 'open-pr', 'pr-loop']) st.steps[id].status = 'done';
  spine.writeState(p, 'TRK-10', st);
  spine.appendEvent(p, 'TRK-10', { kind: 'gh', step: 'open-pr', name: 'pr:create', result: 'pass', ref: 'https://github.com/o/r/pull/7', pin: spine.computePin(repo), actor: 'agent' });
  spine.claimRepo(repo, 'w1');
  const landed = withWindow(null, () => spine.pollRun(p, 'TRK-10', { state: 'MERGED' }, { jira: () => {} }).landed);
  assert.deepStrictEqual(landed.finished, ['merge']);
  assert.strictEqual(spine.readState(p, 'TRK-10').steps.merge.status, 'done');
});

test('recordFacts records its gh receipts on a repo w1 claimed, with PLT_WINDOW unset', () => {
  const { p, repo } = fixtureProcess();
  spine.claimRepo(repo, 'w1');
  const fixture = JSON.parse(fs.readFileSync(path.join(FIX, 'gh', 'open-green-approved.json'), 'utf8'));
  const gh = (args) => JSON.stringify(args[0] === 'pr' ? fixture.view : fixture.threads);
  const r = withWindow(null, () => facts.recordFacts(p, 'TRK-10', facts.prFacts(gh, 'example-org/greenhouse', 42)));
  assert.deepStrictEqual(r.recorded.sort(), ['approved_on_head', 'checks-green', 'checks-green', 'threads_resolved']);
  assert.strictEqual(spine.readEvents(p, 'TRK-10').filter((e) => e.kind === 'gh').length, 4);
});

test('stepStart and stepFinish refuse a second window on a claimed repo', () => {
  const { p, repo } = fixtureProcess();
  const first = Object.entries(spine.readState(p, 'TRK-10').steps).find(([, s]) => s.status === 'ready')[0];
  withWindow('w1', () => spine.stepStart(p, 'TRK-10', first));
  spine.claimRepo(repo, 'w1');
  // A second window that has already taken over the RUN still cannot drive the REPO.
  withWindow('w2', () => {
    assert.throws(() => spine.stepFinish(p, 'TRK-10', first, { outcome: 'ready', noExtrapolations: true, takeOver: true }),
      /is being driven by window w1/);
  });
  const { p: p2, repo: repo2 } = fixtureProcess();
  spine.claimRepo(repo2, 'w1');
  withWindow('w2', () => {
    assert.throws(() => spine.stepStart(p2, 'TRK-10', first), /is being driven by window w1/);
  });
  assert.strictEqual(spine.readState(p2, 'TRK-10').steps[first].status, 'ready');
});

test('a run with no repo_dir is unaffected', () => {
  const { p, repo } = fixtureProcess();
  spine.claimRepo(repo, 'w1');
  const st = spine.readState(p, 'TRK-10');
  st.repo_dir = null;
  spine.writeState(p, 'TRK-10', st);
  withWindow('w2', () => {
    assert.doesNotThrow(() => spine.recordReceipt(p, 'TRK-10', { kind: 'skill', name: 'x', step: 'build', pin: pinOf(p) }));
  });
});

// ---- fsck through spine ----------------------------------------------------

test('fsck.fsckAll enumerates runs via spine.runIds, not a local scan', () => {
  const { p } = fixtureProcess();
  fs.mkdirSync(path.join(p, 'runs', 'TRK-02'), { recursive: true });
  fs.copyFileSync(path.join(p, 'runs', 'TRK-10', 'state.yaml'), path.join(p, 'runs', 'TRK-02', 'state.yaml'));
  fs.mkdirSync(path.join(p, 'runs', 'not-a-run'), { recursive: true });
  assert.deepStrictEqual(fsck.fsckAll(p).runs.map((r) => r.run), spine.runIds(p));
  assert.deepStrictEqual(spine.runIds(p), ['TRK-02', 'TRK-10']);
  assert.strictEqual(fsck.listRunIds, undefined);
});

test('fsck --fix rewrites the ledger under the run lock', () => {
  const { p } = fixtureProcess();
  const file = path.join(spine.runDir(p, 'TRK-10'), 'events.jsonl');
  const last = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).pop();
  fs.appendFileSync(file, last + '\n');                // a retried append: droppable
  const raw = fs.readFileSync(file, 'utf8');
  const lock = holdLock(p, 'TRK-10');
  assert.throws(() => fsck.fsckRun(p, 'TRK-10', { fix: true }), /another plt is writing/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), raw);
  fs.unlinkSync(lock);
  assert.deepStrictEqual(fsck.fsckRun(p, 'TRK-10', { fix: true }).fixed, ['E_EVENT_IDS']);
});

test('fsck --fix on a CLOSED run adds a missing step retired, not pending', () => {
  const { p } = fixtureProcess();
  const st = spine.readState(p, 'TRK-10');
  delete st.steps.merge;
  st.status = 'closed';
  spine.writeState(p, 'TRK-10', st);
  const r = fsck.fsckRun(p, 'TRK-10', { fix: true });
  assert.deepStrictEqual(r.fixed, ['E_MISSING_STEP']);
  const after = spine.readState(p, 'TRK-10');
  assert.strictEqual(after.steps.merge.status, 'skipped');
  assert.strictEqual(after.steps.merge.outcome, 'retired');
  assert.ok(Array.isArray(after.steps.merge.receipts_required));
});

test('fsck on a closed run says the missing step will be added retired', () => {
  const { p } = fixtureProcess();
  const st = spine.readState(p, 'TRK-10');
  delete st.steps.merge;
  st.status = 'closed';
  spine.writeState(p, 'TRK-10', st);
  const f = fsck.fsckRun(p, 'TRK-10').findings.find((x) => x.code === 'E_MISSING_STEP');
  assert.match(f.detail, /as skipped \(retired\)/);
});
