'use strict';
// timers — install/report the OS timer that runs `plt watch --once` on a schedule, so a project
// gets facts -> render -> notify without a human (or a cron someone forgets) driving it. macOS
// gets a launchd user agent (StartInterval); Linux gets a systemd user service+timer pair
// (OnUnitActiveSec). Both writers are pure string/XML builders over {projectDir, cfg, home} so a
// second install is byte-identical — no timestamps, no host-specific ordering.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const PLT_BIN = path.resolve(__dirname, '..', 'bin', 'plt');

// exec(cmd, args) -> stdout string, throws on non-zero exit. Injectable so tests never shell out
// to a real launchd/systemd — the default just wraps execFileSync.
function defaultExec(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

// The node the timer runs: `node` as the user's PATH resolves it at install time, NOT
// process.execPath. execPath is the realpath of the running binary — under Homebrew that is a
// versioned Cellar path (…/Cellar/node/<version>/bin/node) that the next `brew upgrade node`
// deletes, and the timer then fails every run with nothing to say why. The PATH entry
// (/opt/homebrew/bin/node, a symlink the package manager keeps current) survives the upgrade.
// execPath is the fallback only when PATH has no node at all.
function resolveNode(env = process.env) {
  const r = spawnSync('/bin/sh', ['-c', 'command -v node'], { env, encoding: 'utf8' });
  const found = r.status === 0 ? String(r.stdout || '').trim().split('\n')[0] : '';
  return path.isAbsolute(found) ? found : process.execPath;
}

function defaultUid() {
  return typeof process.getuid === 'function' ? process.getuid() : 0;
}

// "10m" -> 600, "90s" -> 90, "1h" -> 3600. A bare number is taken as seconds already.
function everySeconds(every) {
  const s = String(every == null ? '' : every).trim();
  const m = s.match(/^(\d+)\s*(s|m|h)?$/);
  if (!m) throw new Error(`timers.watch.every: cannot parse "${s}" (want e.g. "90s", "10m", "1h")`);
  const n = Number(m[1]);
  const unit = m[2] || 's';
  return n * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1);
}

function labelFor(projectDir, cfg) {
  const t = (cfg && cfg.timers) || {};
  return t.label || `plt.watch.${path.basename(projectDir)}`;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function plistString(v) { return `<string>${xmlEscape(v)}</string>`; }
function plistDict(pairs) {
  return ['<dict>', ...pairs.flatMap(([k, v]) => [`<key>${xmlEscape(k)}</key>`, v]), '</dict>'].join('\n');
}

// The launchd plist: ProgramArguments runs `node <plt> watch --once`; StartInterval is seconds
// between runs (launchd's periodic form — no calendar alignment needed for a poll loop);
// EnvironmentVariables carries PLT_PROCESS_DIR (so the timer needs no cwd assumptions) and PATH
// (so `gh`/`git` on the invoking user's PATH are still found from launchd's minimal environment).
// RunAtLoad fires one `watch --once` the moment the agent loads (login, `launchctl load`, or a
// reboot) instead of waiting up to a full `every` for the first run. StartInterval itself is the
// catch-up: launchd fires the missed interval(s) once on wake from sleep rather than dropping
// them, so a laptop asleep across several intervals still gets exactly one pass on wake, not one
// per missed interval. PATH is read from THIS process's environment at install time and baked into
// the plist — launchd's own environment has no shell rc files to source, so a PATH change (nvm,
// homebrew, a new gh/git) needs a re-install (`plt integration install timers`) to take effect.
function launchdPlist({ label, projectDir, node, seconds, logPath }) {
  const args = ['<array>', plistString(node), plistString(PLT_BIN), plistString('watch'), plistString('--once'), '</array>'].join('\n');
  const env = plistDict([
    ['PLT_PROCESS_DIR', plistString(path.join(projectDir, 'process'))],
    ['PATH', plistString(process.env.PATH || '')],
  ]);
  const body = plistDict([
    ['Label', plistString(label)],
    ['ProgramArguments', args],
    ['WorkingDirectory', plistString(projectDir)],
    ['RunAtLoad', '<true/>'],
    ['StartInterval', `<integer>${seconds}</integer>`],
    ['EnvironmentVariables', env],
    ['StandardOutPath', plistString(logPath)],
    ['StandardErrorPath', plistString(logPath)],
  ]);
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n${body}\n</plist>\n`;
}

function systemdService({ label, projectDir, node, logPath }) {
  return [
    '[Unit]',
    `Description=plt watch --once (${label})`,
    '',
    '[Service]',
    'Type=oneshot',
    `WorkingDirectory=${projectDir}`,
    `Environment=PLT_PROCESS_DIR=${path.join(projectDir, 'process')}`,
    `ExecStart=${node} ${PLT_BIN} watch --once`,
    `StandardOutput=append:${logPath}`,
    `StandardError=append:${logPath}`,
    '',
  ].join('\n');
}
// OnUnitActiveSec re-arms the timer relative to the last time its service *activated* — every
// `systemctl --user start`/daemon-reload of the timer itself re-arms it fresh, and it fires again
// each time the service goes active while the timer stays running (a sleeping laptop's user
// session pauses the timer with it and resumes counting on wake, no missed-run replay). Persistent
// (which replays a run missed while the timer unit itself was down) applies only to OnCalendar
// timers per systemd.timer(5) — inert here, so it is left off rather than kept as false comfort.
// OnBootSec gets a first fire soon after boot/login instead of waiting a full `every`.
function systemdTimer({ label, seconds }) {
  return [
    '[Unit]',
    `Description=Timer for ${label}`,
    '',
    '[Timer]',
    'OnBootSec=1min',
    `OnUnitActiveSec=${seconds}`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

// installTimers(projectDir, cfg, {platform, home, node, env, load, exec, uid}) -> {kind, path, loaded, kickstarted}.
// Idempotent: writing the same inputs twice produces byte-identical files. `--load` is the only
// thing that talks to the OS, and it now PROVES the first run at install time rather than just
// registering the unit and hoping the schedule fires — a job that silently never ran (the live
// incident this fixes: `runs = 0` for six days while status still said "(loaded)") is caught here,
// not discovered later. `loaded`/`kickstarted` stay false when `load` is false (nothing was told
// to the OS); with `load: true` they flip to true once the corresponding step below has run
// without throwing.
//
// Darwin: `launchctl bootout` (ignore failure — nothing to tear down on a first install) then
// `bootstrap` (register) then `kickstart -p` (force an immediate run), all against the modern
// `gui/$UID/<label>` domain target — `load`/`unload` are the deprecated form and don't prove
// anything ran.
// Linux: `daemon-reload` (pick up the just-written unit files) then `enable --now` on the timer
// (arms the schedule) then a single `start` on the service itself (proves first run immediately,
// same intent as kickstart).
function installTimers(projectDir, cfg, { platform = process.platform, home = require('os').homedir(), node = null, env = process.env, load = false, exec = defaultExec, uid = defaultUid() } = {}) {
  projectDir = path.resolve(projectDir);
  node = node || resolveNode(env);
  const label = labelFor(projectDir, cfg);
  const seconds = everySeconds(cfg && cfg.timers && cfg.timers.watch && cfg.timers.watch.every);
  const logPath = path.join(projectDir, 'process', 'build', 'watch.log');

  if (platform === 'darwin') {
    const dir = path.join(home, 'Library', 'LaunchAgents');
    const file = path.join(dir, `${label}.plist`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, launchdPlist({ label, projectDir, node, seconds, logPath }));
    let loaded = false;
    let kickstarted = false;
    if (load) {
      const target = `gui/${uid}/${label}`;
      try { exec('launchctl', ['bootout', target]); } catch (e) { /* nothing registered yet — expected on a first install */ }
      exec('launchctl', ['bootstrap', `gui/${uid}`, file]);
      loaded = true;
      exec('launchctl', ['kickstart', '-p', target]);
      kickstarted = true;
    }
    return { kind: 'launchd', path: file, loaded, kickstarted };
  }

  const dir = path.join(home, '.config', 'systemd', 'user');
  fs.mkdirSync(dir, { recursive: true });
  const servicePath = path.join(dir, `${label}.service`);
  const timerPath = path.join(dir, `${label}.timer`);
  fs.writeFileSync(servicePath, systemdService({ label, projectDir, node, logPath }));
  fs.writeFileSync(timerPath, systemdTimer({ label, seconds }));
  let loaded = false;
  let kickstarted = false;
  if (load) {
    exec('systemctl', ['--user', 'daemon-reload']);
    exec('systemctl', ['--user', 'enable', '--now', `${label}.timer`]);
    loaded = true;
    exec('systemctl', ['--user', 'start', `${label}.service`]);
    kickstarted = true;
  }
  return { kind: 'systemd', path: timerPath, loaded, kickstarted };
}

// timerStatus(projectDir, cfg, {platform, home, exec, uid, stat}) ->
//   {installed, path, loaded, runs, lastExit, lastRun, ok, reason}.
// `ok` is false with a `reason` in three cases: 'not installed' (no unit file at all),
// 'installed but never run' (the OS knows the unit but `runs === 0` — the exact six-day-silent
// incident this replaces), and 'last run exited <n>' (a non-zero last-exit code). A fourth,
// non-erroring case — the unit file exists but the OS has no live record of it (never
// bootstrapped/enabled, or the query itself failed) — reads as `loaded: false, reason: 'not
// loaded'`, never as a thrown exception. `runs`/`lastExit`/`lastRun` are `null` whenever there is
// no live record to read them from. On macOS `lastRun` is the mtime of the job's log (`stat` is
// injectable so a test needs no real file).
function timerStatus(projectDir, cfg, { platform = process.platform, home = require('os').homedir(), exec = defaultExec, uid = defaultUid(), stat = fs.statSync } = {}) {
  projectDir = path.resolve(projectDir);
  const label = labelFor(projectDir, cfg);
  const notInstalled = { installed: false, path: null, loaded: false, runs: null, lastExit: null, lastRun: null, ok: false, reason: 'not installed' };

  if (platform === 'darwin') {
    const file = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    if (!fs.existsSync(file)) return notInstalled;
    let out = null;
    try { out = exec('launchctl', ['print', `gui/${uid}/${label}`]); } catch (e) { out = null; }
    if (out == null) return { installed: true, path: file, loaded: false, runs: null, lastExit: null, lastRun: null, ok: false, reason: 'not loaded' };
    const runsM = out.match(/\bruns\s*=\s*(\d+)/);
    const exitM = out.match(/last exit code\s*=\s*(-?\d+)/);
    const runs = runsM ? Number(runsM[1]) : 0;
    const lastExit = exitM ? Number(exitM[1]) : null;
    if (runs === 0) return { installed: true, path: file, loaded: true, runs, lastExit, lastRun: null, ok: false, reason: 'installed but never run' };
    // launchd keeps no last-run time, so the job's log says when it last ran: every `watch --once`
    // writes to it, and launchd names it (`stdout path`). Null only when there is no log to read.
    const logM = out.match(/^\s*stdout path\s*=\s*(.+)$/m);
    const logFile = logM ? logM[1].trim() : path.join(projectDir, 'process', 'build', 'watch.log');
    let lastRun = null;
    try { lastRun = stat(logFile).mtime.toISOString(); } catch (e) { lastRun = null; }
    if (lastExit !== null && lastExit !== 0) return { installed: true, path: file, loaded: true, runs, lastExit, lastRun, ok: false, reason: `last run exited ${lastExit}` };
    return { installed: true, path: file, loaded: true, runs, lastExit, lastRun, ok: true, reason: null };
  }

  const timerPath = path.join(home, '.config', 'systemd', 'user', `${label}.timer`);
  if (!fs.existsSync(timerPath)) return notInstalled;
  let timerOut = null;
  let serviceOut = null;
  try { timerOut = exec('systemctl', ['--user', 'show', `${label}.timer`, '--property=LastTriggerUSec']); } catch (e) { timerOut = null; }
  try { serviceOut = exec('systemctl', ['--user', 'show', `${label}.service`, '--property=ExecMainStatus']); } catch (e) { serviceOut = null; }
  if (timerOut == null && serviceOut == null) return { installed: true, path: timerPath, loaded: false, runs: null, lastExit: null, lastRun: null, ok: false, reason: 'not loaded' };
  const triggerM = (timerOut || '').match(/LastTriggerUSec=(.*)/);
  const trigger = triggerM ? triggerM[1].trim() : '';
  const lastRun = trigger && trigger !== 'n/a' && trigger !== '0' ? trigger : null;
  const runs = lastRun ? 1 : 0;
  const statusM = (serviceOut || '').match(/ExecMainStatus=(-?\d+)/);
  const lastExit = statusM ? Number(statusM[1]) : null;
  if (runs === 0) return { installed: true, path: timerPath, loaded: true, runs, lastExit, lastRun, ok: false, reason: 'installed but never run' };
  if (lastExit !== null && lastExit !== 0) return { installed: true, path: timerPath, loaded: true, runs, lastExit, lastRun, ok: false, reason: `last run exited ${lastExit}` };
  return { installed: true, path: timerPath, loaded: true, runs, lastExit, lastRun, ok: true, reason: null };
}

module.exports = { installTimers, timerStatus, everySeconds, labelFor, resolveNode };
