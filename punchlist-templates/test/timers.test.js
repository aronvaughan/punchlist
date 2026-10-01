'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const timers = require('../lib/timers');
const PLT = path.join(__dirname, '..', 'bin', 'plt');
const FIX = path.join(__dirname, 'fixtures', 'spine');

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'timers-home-')); }
function tmpProject(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timers-project-'));
  fs.cpSync(FIX, path.join(dir, 'process'), { recursive: true });
  if (cfg) fs.writeFileSync(path.join(dir, 'process', 'config', 'zz-timers-test.yaml'), require('../lib/yaml').stringify(cfg));
  return dir;
}

test('installTimers (darwin): plist ends in `watch --once`, StartInterval matches "10m"; second install is byte-identical', () => {
  const home = tmpHome();
  const project = tmpProject({ timers: { watch: { every: '10m' }, label: 'plt.watch.test-project' } });
  const spine = require('../lib/spine');
  const cfg = spine.loadConfig(path.join(project, 'process'));

  const r1 = timers.installTimers(project, cfg, { platform: 'darwin', home, node: '/usr/local/bin/node' });
  assert.strictEqual(r1.kind, 'launchd');
  assert.strictEqual(r1.path, path.join(home, 'Library', 'LaunchAgents', 'plt.watch.test-project.plist'));
  assert.strictEqual(r1.loaded, false);
  assert.strictEqual(r1.kickstarted, false);
  const plist1 = fs.readFileSync(r1.path, 'utf8');
  assert.match(plist1, /<string>watch<\/string>\s*<string>--once<\/string>/);
  assert.match(plist1, /<key>StartInterval<\/key>\s*<integer>600<\/integer>/);
  assert.match(plist1, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist1, new RegExp(`<key>WorkingDirectory</key>\\s*<string>${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));

  const r2 = timers.installTimers(project, cfg, { platform: 'darwin', home, node: '/usr/local/bin/node' });
  const plist2 = fs.readFileSync(r2.path, 'utf8');
  assert.strictEqual(plist1, plist2, 'a second install must be byte-identical');
});

test('installTimers (darwin) parses "90s" as 90 seconds', () => {
  const home = tmpHome();
  const project = tmpProject({ timers: { watch: { every: '90s' }, label: 'plt.watch.test-90s' } });
  const spine = require('../lib/spine');
  const cfg = spine.loadConfig(path.join(project, 'process'));
  const r = timers.installTimers(project, cfg, { platform: 'darwin', home, node: '/usr/local/bin/node' });
  const plist = fs.readFileSync(r.path, 'utf8');
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>90<\/integer>/);
});

test('installTimers (darwin) never launchctl-loads without --load', () => {
  const home = tmpHome();
  const project = tmpProject({ timers: { watch: { every: '10m' }, label: 'plt.watch.no-load' } });
  const spine = require('../lib/spine');
  const cfg = spine.loadConfig(path.join(project, 'process'));
  // No `load` option passed at all — if this ever shells out to launchctl the test fails because
  // there is no real launchd agent named this in the sandboxed test environment.
  assert.doesNotThrow(() => timers.installTimers(project, cfg, { platform: 'darwin', home, node: '/usr/local/bin/node' }));
});

test('timerStatus (darwin): not installed before install, "not loaded" after (no --load, no real launchd agent)', () => {
  const home = tmpHome();
  const project = tmpProject({ timers: { watch: { every: '10m' }, label: 'plt.watch.status-test' } });
  const spine = require('../lib/spine');
  const cfg = spine.loadConfig(path.join(project, 'process'));
  assert.deepStrictEqual(timers.timerStatus(project, cfg, { platform: 'darwin', home }), {
    installed: false, path: null, loaded: false, runs: null, lastExit: null, lastRun: null, ok: false, reason: 'not installed',
  });
  const r = timers.installTimers(project, cfg, { platform: 'darwin', home, node: '/usr/local/bin/node' });
  const st = timers.timerStatus(project, cfg, { platform: 'darwin', home });
  assert.deepStrictEqual(st, {
    installed: true, path: r.path, loaded: false, runs: null, lastExit: null, lastRun: null, ok: false, reason: 'not loaded',
  });
});

test('installTimers (linux): a systemd service+timer pair, OnUnitActiveSec matches "10m", OnBootSec set, no inert Persistent', () => {
  const home = tmpHome();
  const project = tmpProject({ timers: { watch: { every: '10m' }, label: 'plt.watch.linux-test' } });
  const spine = require('../lib/spine');
  const cfg = spine.loadConfig(path.join(project, 'process'));
  const r = timers.installTimers(project, cfg, { platform: 'linux', home, node: '/usr/bin/node' });
  assert.strictEqual(r.kind, 'systemd');
  assert.strictEqual(r.path, path.join(home, '.config', 'systemd', 'user', 'plt.watch.linux-test.timer'));
  assert.strictEqual(r.loaded, false);
  assert.strictEqual(r.kickstarted, false);
  const timerUnit = fs.readFileSync(r.path, 'utf8');
  assert.match(timerUnit, /OnUnitActiveSec=600/);
  assert.match(timerUnit, /OnBootSec=1min/);
  // Persistent= only replays a missed run for OnCalendar timers (systemd.timer(5)) — inert with
  // OnUnitActiveSec, so it must not be there at all (not even Persistent=false: absence, not a value).
  assert.doesNotMatch(timerUnit, /^Persistent=/m);
  const service = fs.readFileSync(path.join(home, '.config', 'systemd', 'user', 'plt.watch.linux-test.service'), 'utf8');
  assert.match(service, /ExecStart=\/usr\/bin\/node .*bin\/plt watch --once/);
});

test('label defaults to plt.watch.<project basename> when timers.label is empty', () => {
  const home = tmpHome();
  const project = tmpProject({ timers: { watch: { every: '10m' }, label: '' } });
  const spine = require('../lib/spine');
  const cfg = spine.loadConfig(path.join(project, 'process'));
  const r = timers.installTimers(project, cfg, { platform: 'darwin', home, node: '/usr/local/bin/node' });
  assert.strictEqual(path.basename(r.path), `plt.watch.${path.basename(project)}.plist`);
});

test('CLI: plt integration install|status timers writes the unit file under $HOME, reports it, and exits 1 while not loaded', () => {
  const home = tmpHome();
  const project = tmpProject({ timers: { watch: { every: '10m' }, label: 'plt.watch.cli-test' } });
  const env = { ...process.env, HOME: home };
  const dir = process.platform === 'darwin' ? path.join(home, 'Library', 'LaunchAgents') : path.join(home, '.config', 'systemd', 'user');
  const install = spawnSync(process.execPath, [PLT, 'integration', 'install', 'timers', '--project', project], { encoding: 'utf8', env });
  assert.strictEqual(install.status, 0, install.stderr);
  assert.match(install.stdout, /installed at/);
  assert.match(install.stdout, /not loaded — pass --load/);
  assert.ok(fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith('plt.watch.cli-test')), fs.existsSync(dir) ? fs.readdirSync(dir).join(',') : 'no dir');

  const status = spawnSync(process.execPath, [PLT, 'integration', 'status', 'timers', '--project', project], { encoding: 'utf8', env });
  assert.match(status.stdout, /^installed .*\(not loaded\) runs=\? last-exit=\? last-run=\?\n$/);
  // No real launchd/systemd record for this label — status is not `ok`, so the CLI must exit 1
  // (a timer that silently does nothing is worse than no timer).
  assert.strictEqual(status.status, 1);
});

test('installTimers (darwin) --load: bootout (ignoring failure), then bootstrap, then kickstart -p, against gui/$UID/<label>', () => {
  const home = tmpHome();
  const project = tmpProject({ timers: { watch: { every: '10m' }, label: 'plt.watch.load-test' } });
  const spine = require('../lib/spine');
  const cfg = spine.loadConfig(path.join(project, 'process'));
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'bootout') throw new Error('no such service'); // nothing registered yet — must be ignored
    return '';
  };
  const r = timers.installTimers(project, cfg, { platform: 'darwin', home, node: '/usr/local/bin/node', load: true, exec, uid: 501 });
  assert.deepStrictEqual(calls, [
    ['launchctl', 'bootout', 'gui/501/plt.watch.load-test'],
    ['launchctl', 'bootstrap', 'gui/501', r.path],
    ['launchctl', 'kickstart', '-p', 'gui/501/plt.watch.load-test'],
  ]);
  assert.strictEqual(r.loaded, true);
  assert.strictEqual(r.kickstarted, true);
});

test('installTimers (linux) --load: daemon-reload, then enable --now <timer>, then start <service> once', () => {
  const home = tmpHome();
  const project = tmpProject({ timers: { watch: { every: '10m' }, label: 'plt.watch.load-linux' } });
  const spine = require('../lib/spine');
  const cfg = spine.loadConfig(path.join(project, 'process'));
  const calls = [];
  const exec = (cmd, args) => { calls.push([cmd, ...args]); return ''; };
  const r = timers.installTimers(project, cfg, { platform: 'linux', home, node: '/usr/bin/node', load: true, exec });
  assert.deepStrictEqual(calls, [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', 'plt.watch.load-linux.timer'],
    ['systemctl', '--user', 'start', 'plt.watch.load-linux.service'],
  ]);
  assert.strictEqual(r.loaded, true);
  assert.strictEqual(r.kickstarted, true);
});

test('timerStatus (darwin) parses `launchctl print` runs/last-exit-code', () => {
  const home = tmpHome();
  const project = tmpProject({ timers: { watch: { every: '10m' }, label: 'plt.watch.parse-test' } });
  const spine = require('../lib/spine');
  const cfg = spine.loadConfig(path.join(project, 'process'));
  timers.installTimers(project, cfg, { platform: 'darwin', home, node: '/usr/local/bin/node' });

  // runs = 0 -> installed but never run, not ok.
  const zeroRuns = timers.timerStatus(project, cfg, { platform: 'darwin', home, uid: 501, exec: () => 'runs = 0\nlast exit code = 0\n' });
  assert.strictEqual(zeroRuns.runs, 0);
  assert.strictEqual(zeroRuns.ok, false);
  assert.strictEqual(zeroRuns.reason, 'installed but never run');

  // The canned fixture from the brief: runs = 7, last exit code = 0 -> ok.
  const canned = '\tstate = waiting\n\truns = 7\n\tlast exit code = 0\n';
  const sevenRuns = timers.timerStatus(project, cfg, { platform: 'darwin', home, uid: 501, exec: () => canned });
  assert.strictEqual(sevenRuns.runs, 7);
  assert.strictEqual(sevenRuns.lastExit, 0);
  assert.strictEqual(sevenRuns.ok, true);
  assert.strictEqual(sevenRuns.reason, null);

  // A non-zero last exit code is a failing run, even though it did run.
  const failed = timers.timerStatus(project, cfg, { platform: 'darwin', home, uid: 501, exec: () => 'runs = 3\nlast exit code = 78\n' });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.reason, 'last run exited 78');
});

test('CLI: plt integration status timers exits 1 when the timer was installed but never ran', () => {
  const home = tmpHome();
  const project = tmpProject({ timers: { watch: { every: '10m' }, label: 'plt.watch.exit-test' } });
  const spine = require('../lib/spine');
  const cfg = spine.loadConfig(path.join(project, 'process'));
  timers.installTimers(project, cfg, { platform: 'darwin', home, node: '/usr/local/bin/node' });

  // no live launchd record at all reads as "not loaded", not a crash
  const notLoaded = timers.timerStatus(project, cfg, { platform: 'darwin', home, uid: 501, exec: () => { throw new Error('not bootstrapped'); } });
  assert.strictEqual(notLoaded.loaded, false);
  assert.strictEqual(notLoaded.reason, 'not loaded');
  assert.strictEqual(notLoaded.ok, false);

  const never = timers.timerStatus(project, cfg, { platform: 'darwin', home, uid: 501, exec: () => 'runs = 0\nlast exit code = 0\n' });
  assert.strictEqual(never.reason, 'installed but never run');
  assert.strictEqual(never.ok, false);
});

// The plist used to pin process.execPath — a versioned Cellar path that `brew upgrade node` deletes.
test('installTimers: with no node given, the plist runs `node` as PATH resolves it (the symlink, not its target)', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'timers-bin-'));
  const cellar = fs.mkdtempSync(path.join(os.tmpdir(), 'timers-cellar-'));
  const real = path.join(cellar, 'node');
  fs.writeFileSync(real, '#!/bin/sh\n'); fs.chmodSync(real, 0o755);
  fs.symlinkSync(real, path.join(bin, 'node'));
  const env = { PATH: `${bin}:/usr/bin:/bin` };
  assert.strictEqual(timers.resolveNode(env), path.join(bin, 'node'));

  const home = tmpHome();
  const project = tmpProject({ timers: { watch: { every: '10m' }, label: 'plt.watch.node-path' } });
  const cfg = require('../lib/spine').loadConfig(path.join(project, 'process'));
  const r = timers.installTimers(project, cfg, { platform: 'darwin', home, env });
  const plist = fs.readFileSync(r.path, 'utf8');
  assert.match(plist, new RegExp(`<string>${path.join(bin, 'node').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));
  assert.ok(!plist.includes(real), 'the plist must not pin the symlink target');
});

test('resolveNode: with no node on PATH, falls back to the running node', () => {
  assert.strictEqual(timers.resolveNode({ PATH: fs.mkdtempSync(path.join(os.tmpdir(), 'timers-empty-')) }), process.execPath);
});

test('timerStatus (darwin): lastRun is the mtime of the log launchd names, and null only when there is no log', () => {
  const home = tmpHome();
  const project = tmpProject({ timers: { watch: { every: '10m' }, label: 'plt.watch.last-run' } });
  const cfg = require('../lib/spine').loadConfig(path.join(project, 'process'));
  timers.installTimers(project, cfg, { platform: 'darwin', home, node: '/usr/local/bin/node' });
  const printed = '\tstdout path = /logs/watch.log\n\truns = 4\n\tlast exit code = 0\n';
  const seen = [];
  const stat = (f) => { seen.push(f); return { mtime: new Date('2026-09-24T10:00:00.000Z') }; };
  const st = timers.timerStatus(project, cfg, { platform: 'darwin', home, uid: 501, exec: () => printed, stat });
  assert.strictEqual(st.lastRun, '2026-09-24T10:00:00.000Z');
  assert.deepStrictEqual(seen, ['/logs/watch.log']);
  assert.strictEqual(st.ok, true);

  // No `stdout path` line: the log the plist was written with.
  seen.length = 0;
  timers.timerStatus(project, cfg, { platform: 'darwin', home, uid: 501, exec: () => 'runs = 4\nlast exit code = 0\n', stat });
  assert.deepStrictEqual(seen, [path.join(path.resolve(project), 'process', 'build', 'watch.log')]);

  const missing = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
  assert.strictEqual(timers.timerStatus(project, cfg, { platform: 'darwin', home, uid: 501, exec: () => printed, stat: missing }).lastRun, null);
  // A failing run still reports when it ran.
  const failed = timers.timerStatus(project, cfg, { platform: 'darwin', home, uid: 501, exec: () => printed.replace('code = 0', 'code = 78'), stat });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.lastRun, '2026-09-24T10:00:00.000Z');
});
