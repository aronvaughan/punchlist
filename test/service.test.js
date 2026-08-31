// service.test.js — the cross-platform service unit rendering used by
// `punchlist install-service`. Pure functions, so we can assert both platforms
// without touching the real system.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceSpec, systemdUnit, launchdPlist, silverbulletSpec, silverbulletWrapper } from '../src/service.js';

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

// ---- silverbulletSpec: the optional, second KB service ----

const sbBase = { repo: '/home/u/app', spaceDir: '/home/u/app/data/kb', home: '/home/u' };
const SECRET_PASSWORD = 'hunter2-super-secret';

test('silverbulletSpec(linux) -> systemd unit at punchlist-silverbullet.service, wrapper-based ExecStart, no secret literal', () => {
  const s = silverbulletSpec('linux', sbBase);
  assert.equal(s.kind, 'systemd');
  assert.equal(s.path, '/home/u/.config/systemd/user/punchlist-silverbullet.service');
  assert.equal(s.host, '127.0.0.1'); // loopback only, never the tailnet IP
  assert.equal(s.port, 3001);
  // ExecStart references the wrapper script, not the raw silverbullet cmd or a password
  assert.match(s.contents, new RegExp(`ExecStart=${s.wrapperPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.ok(!s.contents.includes('--hostname')); // no raw CLI invocation in the unit — only the wrapper
  assert.ok(!s.contents.includes(SECRET_PASSWORD));
  assert.ok(!s.wrapperContents.includes(SECRET_PASSWORD));
  assert.deepEqual(s.reload[0], ['systemctl', ['--user', 'daemon-reload']]);
  assert.deepEqual(s.start[0], ['systemctl', ['--user', 'enable', '--now', 'punchlist-silverbullet.service']]);
  assert.deepEqual(s.status, ['systemctl', ['--user', 'status', 'punchlist-silverbullet.service']]);
  // envFile default location
  assert.equal(s.envFile, '/home/u/.config/punchlist/silverbullet.env');
});

test('silverbulletSpec(darwin) -> LaunchAgent plist, label, log path, ProgramArguments -> wrapper, well-formed XML, no secret literal', () => {
  const s = silverbulletSpec('darwin', { ...sbBase, home: '/Users/u' });
  assert.equal(s.kind, 'launchd');
  assert.equal(s.label, 'com.punchlist.silverbullet');
  assert.equal(s.path, '/Users/u/Library/LaunchAgents/com.punchlist.silverbullet.plist');
  assert.equal(s.logPath, '/Users/u/Library/Logs/punchlist-silverbullet.log');
  assert.match(s.contents, /<key>Label<\/key><string>com\.punchlist\.silverbullet<\/string>/);
  assert.match(s.contents, new RegExp(`<array>\\s*<string>${s.wrapperPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>\\s*</array>`));
  assert.match(s.contents, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(s.contents, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(s.contents, /<key>StandardOutPath<\/key><string>\/Users\/u\/Library\/Logs\/punchlist-silverbullet\.log<\/string>/);
  assert.ok(!s.contents.includes(SECRET_PASSWORD));
  assert.ok(!s.wrapperContents.includes(SECRET_PASSWORD));
  // well-formed XML: doctype + single root <plist> with matching close tag
  assert.match(s.contents, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(s.contents, /<plist version="1\.0">[\s\S]*<\/plist>\s*$/);
  const opens = (s.contents.match(/<dict>/g) || []).length;
  const closes = (s.contents.match(/<\/dict>/g) || []).length;
  assert.equal(opens, closes);
  assert.deepEqual(s.reload[0], ['launchctl', ['unload', s.path]]);
  assert.deepEqual(s.start[0], ['launchctl', ['load', '-w', s.path]]);
});

test('silverbulletSpec binds loopback only, serves spaceDir, honors overrides', () => {
  const s = silverbulletSpec('linux', {
    ...sbBase,
    port: 4000,
    host: '127.0.0.1',
    cmd: '/opt/silverbullet/bin/sb',
    envFile: '/home/u/.config/punchlist/custom.env',
  });
  assert.equal(s.port, 4000);
  assert.equal(s.host, '127.0.0.1');
  assert.equal(s.envFile, '/home/u/.config/punchlist/custom.env');
  assert.match(s.wrapperContents, /\/opt\/silverbullet\/bin\/sb/);
  assert.match(s.wrapperContents, /127\.0\.0\.1/);
  assert.match(s.wrapperContents, /4000/);
  assert.match(s.wrapperContents, /\/home\/u\/app\/data\/kb/);
});

test('silverbulletWrapper: sources envFile, execs cmd with host/port/spaceDir, no secret literal', () => {
  const w = silverbulletWrapper({
    cmd: 'silverbullet',
    spaceDir: '/home/u/app/data/kb',
    host: '127.0.0.1',
    port: 3001,
    envFile: '/home/u/.config/punchlist/silverbullet.env',
  });
  assert.match(w, /^#!/); // shebang
  assert.match(w, /\.\s+"\/home\/u\/\.config\/punchlist\/silverbullet\.env"/); // sources the env file
  assert.match(w, /set -a/); // exported vars from the sourced file reach the child process
  assert.match(w, /exec "silverbullet" --hostname "127\.0\.0\.1" --port "3001" "\/home\/u\/app\/data\/kb"/);
  assert.ok(!w.includes(SECRET_PASSWORD));
  assert.doesNotMatch(w, /SB_USER=/); // the wrapper never hardcodes the credential itself
});
