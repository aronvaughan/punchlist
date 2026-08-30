// service.test.js — the cross-platform service unit rendering used by
// `punchlist install-service`. Pure functions, so we can assert both platforms
// without touching the real system.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceSpec, systemdUnit, launchdPlist } from '../src/service.js';

const base = { repo: '/home/u/app', dataDir: '/home/u/app/data', node: '/usr/bin/node', home: '/home/u' };

test('linux -> systemd user unit at the right path with correct ExecStart/Env', () => {
  const s = serviceSpec('linux', base);
  assert.equal(s.kind, 'systemd');
  assert.equal(s.path, '/home/u/.config/systemd/user/punchlist.service');
  assert.match(s.contents, /ExecStart=\/usr\/bin\/node \/home\/u\/app\/src\/server\.js/);
  assert.match(s.contents, /Environment=PUNCHLIST_DATA=\/home\/u\/app\/data/);
  assert.match(s.contents, /WorkingDirectory=\/home\/u\/app/);
  assert.match(s.contents, /Restart=on-failure/);
  assert.match(s.contents, /WantedBy=default\.target/);
  assert.deepEqual(s.reload[0], ['systemctl', ['--user', 'daemon-reload']]);
  assert.deepEqual(s.start[0], ['systemctl', ['--user', 'enable', '--now', 'punchlist.service']]);
});

test('darwin -> launchd LaunchAgent plist with the expected keys', () => {
  const s = serviceSpec('darwin', { ...base, home: '/Users/u' });
  assert.equal(s.kind, 'launchd');
  assert.equal(s.path, '/Users/u/Library/LaunchAgents/com.punchlist.plist');
  assert.equal(s.logPath, '/Users/u/Library/Logs/punchlist.log');
  assert.match(s.contents, /<key>Label<\/key><string>com\.punchlist<\/string>/);
  assert.match(s.contents, /<string>\/usr\/bin\/node<\/string>\s*<string>\/home\/u\/app\/src\/server\.js<\/string>/);
  assert.match(s.contents, /<key>PUNCHLIST_DATA<\/key><string>\/home\/u\/app\/data<\/string>/);
  assert.match(s.contents, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(s.contents, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(s.contents, /<key>StandardOutPath<\/key><string>\/Users\/u\/Library\/Logs\/punchlist\.log<\/string>/);
  // unload-then-load makes re-install idempotent
  assert.deepEqual(s.reload[0], ['launchctl', ['unload', s.path]]);
  assert.deepEqual(s.start[0], ['launchctl', ['load', '-w', s.path]]);
});

test('unknown/other platform falls back to the systemd (Linux) unit', () => {
  assert.equal(serviceSpec('freebsd', base).kind, 'systemd');
});

test('plist XML-escapes &, <, > in interpolated paths', () => {
  const s = serviceSpec('darwin', { repo: '/a & <b>', dataDir: '/a & <b>/data', node: '/usr/bin/node', home: '/Users/u' });
  assert.match(s.contents, /\/a &amp; &lt;b&gt;/);
  assert.ok(!s.contents.includes('/a & <b><'), 'raw ampersand/angle brackets must not leak into XML');
});

test('systemdUnit / launchdPlist are usable directly (both carry the data dir)', () => {
  assert.match(systemdUnit({ node: 'N', serverJs: 'S', repo: 'R', dataDir: 'D' }), /Environment=PUNCHLIST_DATA=D/);
  assert.match(launchdPlist({ node: 'N', serverJs: 'S', repo: 'R', dataDir: 'D', logPath: 'L' }),
    /<key>PUNCHLIST_DATA<\/key><string>D<\/string>/);
});
