'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const spine = require('../lib/spine');
const yaml = require('../lib/yaml');
const FIX = path.join(__dirname, 'fixtures', 'spine');
const GH_FIX = path.join(FIX, 'gh');
const NOTIFY_STUB = path.join(__dirname, 'fixtures', 'notify-stub.js');
const PLT = path.join(__dirname, '..', 'bin', 'plt');

function tmpProcess() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-'));
  fs.cpSync(FIX, path.join(root, 'process'), { recursive: true });
  return root;
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
function writeConfigOverlay(processDir, obj) {
  fs.writeFileSync(path.join(processDir, 'config', 'zz-watch-test.yaml'), yaml.stringify(obj));
}
function writeInputs(processDir, runId, inputs) {
  const dir = path.join(processDir, 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'inputs.yaml'), yaml.stringify(inputs));
}
function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function watchOnce(p, extraEnv = {}) {
  const logFile = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-log-')) + '/log.ndjson';
  const env = { ...process.env, PLT_PROCESS_DIR: p, WATCH_NOTIFY_LOG: logFile, ...extraEnv };
  const r = spawnSync(process.execPath, [PLT, 'watch', '--once'], { encoding: 'utf8', env });
  return { ...r, notified: readLog(logFile) };
}

test('watch --once: baselines silently on first sight, notifies only the run whose next command changed, skips a run with no inputs.window when the template needs one', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  const repoNoWindow = tmpRepo(); const repoWithWindow = tmpRepo(); const repoUnchanged = tmpRepo();

  // {text}/{next}/{label} come pre-quoted (lib/spine-cli.js#watchOnce) — the template writes them bare.
  writeConfigOverlay(p, { windows: { notify: `${process.execPath} ${NOTIFY_STUB} {run} {text} {next} {tab_id} {pane_id} {label}` } });

  spine.launchRun(p, { runId: 'TRK-30', cycle: 'build-and-ship', repoDir: repoNoWindow, owner: 'agent' });
  writeInputs(p, 'TRK-30', { card: 'TRK-30' });   // no window

  spine.launchRun(p, { runId: 'TRK-31', cycle: 'build-and-ship', repoDir: repoWithWindow, owner: 'agent' });
  writeInputs(p, 'TRK-31', { card: 'TRK-31', window: { tab_id: 'tab-31', pane_id: 'pane-31', label: 'TRK-31-Thing' } });

  spine.launchRun(p, { runId: 'TRK-32', cycle: 'build-and-ship', repoDir: repoUnchanged, owner: 'agent' });
  writeInputs(p, 'TRK-32', { card: 'TRK-32', window: { tab_id: 'tab-32', pane_id: 'pane-32', label: 'TRK-32-Thing' } });

  // First pass: every run is seen for the first time — baseline only, nothing notified.
  const first = watchOnce(p);
  assert.strictEqual(first.status, 0, first.stderr);
  assert.deepStrictEqual(first.notified, []);
  const watchJson = JSON.parse(fs.readFileSync(path.join(p, 'build', 'watch.json'), 'utf8'));
  assert.strictEqual(watchJson['TRK-30'], 'plt step start scope --run TRK-30');
  assert.strictEqual(watchJson['TRK-31'], 'plt step start scope --run TRK-31');

  // Advance TRK-30 and TRK-31's next command; leave TRK-32 alone.
  spine.stepStart(p, 'TRK-30', 'scope');
  spine.stepStart(p, 'TRK-31', 'scope');

  const second = watchOnce(p);
  assert.strictEqual(second.status, 0, second.stderr);

  // TRK-30 changed but has no inputs.window and the template references {pane_id} — skipped, logged, not fatal.
  assert.ok(!second.notified.some((n) => n.run === 'TRK-30'), JSON.stringify(second.notified));
  assert.match(second.stderr, /TRK-30.*no inputs\.window/);

  // TRK-31 changed and has a window — notified exactly once with the old->new text and the window vars.
  const n31 = second.notified.filter((n) => n.run === 'TRK-31');
  assert.strictEqual(n31.length, 1);
  assert.strictEqual(n31[0].text, 'TRK-31: plt step start scope --run TRK-31 → plt step finish scope --run TRK-31 --outcome <outcome>');
  assert.strictEqual(n31[0].next, 'plt step finish scope --run TRK-31 --outcome <outcome>');
  assert.strictEqual(n31[0].tab_id, 'tab-31');
  assert.strictEqual(n31[0].pane_id, 'pane-31');
  assert.strictEqual(n31[0].label, 'TRK-31-Thing');

  // TRK-32 never changed — silent both times.
  assert.ok(!second.notified.some((n) => n.run === 'TRK-32'));
});

test('watch --once: a run with a PR still collects facts via PLT_GH without disturbing notify behavior', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  writeConfigOverlay(p, { windows: { notify: '' } });   // no notify configured — nothing should ever fire
  spine.launchRun(p, { runId: 'TRK-40', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  writeInputs(p, 'TRK-40', { card: 'TRK-40', pr_number: 42 });

  const r = watchOnce(p, { PLT_GH: path.join(GH_FIX, 'stub.js'), PLT_GH_FIXTURE: path.join(GH_FIX, 'open-green-approved.json') });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(spine.readState(p, 'TRK-40').facts.headSha, 'aaaa1111');
  assert.deepStrictEqual(r.notified, []);
});

test("watch --once: {text}/{next} carrying a shell quote and a `<` still execute as one well-formed command line", () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  writeConfigOverlay(p, { windows: { notify: `${process.execPath} ${NOTIFY_STUB} {run} {text} {next} {tab_id} {pane_id} {label}` } });
  spine.launchRun(p, { runId: 'TRK-60', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  writeInputs(p, 'TRK-60', { card: 'TRK-60', window: { tab_id: 'tab-60', pane_id: 'pane-60', label: "don't <redirect> me" } });

  // Seed the baseline directly with a value carrying both a single quote and a `<` — a naive
  // `'{next}'` template (or an unquoted one) would either mis-parse the quote or have the shell
  // try to redirect stdin from a file named `redirect`. Real `nextCommand` strings already carry
  // `<outcome>`; this pins the apostrophe case too.
  fs.mkdirSync(path.join(p, 'build'), { recursive: true });
  fs.writeFileSync(path.join(p, 'build', 'watch.json'), JSON.stringify({ 'TRK-60': "it's <old>" }));

  const r = watchOnce(p);
  assert.strictEqual(r.status, 0, r.stderr);
  const n = r.notified.filter((x) => x.run === 'TRK-60');
  assert.strictEqual(n.length, 1, JSON.stringify(r.notified) + '\n' + r.stderr);
  assert.strictEqual(n[0].text, "TRK-60: it's <old> → plt step start scope --run TRK-60");
  assert.strictEqual(n[0].next, 'plt step start scope --run TRK-60');
  assert.strictEqual(n[0].label, "don't <redirect> me");
});

test('watch --once: no windows.notify configured means a changed run is never notified, even with a window', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-50', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  writeInputs(p, 'TRK-50', { card: 'TRK-50', window: { tab_id: 't', pane_id: 'p', label: 'l' } });
  watchOnce(p);
  spine.stepStart(p, 'TRK-50', 'scope');
  const second = watchOnce(p);
  assert.strictEqual(second.status, 0, second.stderr);
  assert.deepStrictEqual(second.notified, []);
});

test('watch --once: prunes closed and vanished runs from watch.json on every pass, and never baselines a closed run', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  for (const id of ['TRK-70', 'TRK-71', 'TRK-73']) spine.launchRun(p, { runId: id, cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  for (const id of ['TRK-71', 'TRK-73']) {
    const st = spine.readState(p, id); st.status = 'closed'; spine.writeState(p, id, st);
  }
  fs.mkdirSync(path.join(p, 'build'), { recursive: true });
  // TRK-71 closed since the last pass; TRK-72's run directory is gone; TRK-73 was never seen open.
  fs.writeFileSync(path.join(p, 'build', 'watch.json'), JSON.stringify({ 'TRK-71': 'nothing — run closed', 'TRK-72': 'plt step start scope --run TRK-72' }));
  const r = watchOnce(p);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(p, 'build', 'watch.json'), 'utf8'))), ['TRK-70']);
});
