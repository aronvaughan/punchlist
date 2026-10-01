'use strict';
const test = require('node:test');
const assert = require('node:assert');
const deps = require('../lib/deps');

// A stand-in machine: `onPath` is the set of binaries `command -v` resolves.
function machine(onPath) {
  const set = new Set(onPath);
  return (cmd, args) => {
    if (cmd === 'sh') {
      const bin = args[1].replace(/^command -v /, '');
      return set.has(bin) ? { code: 0, stdout: `/usr/bin/${bin}\n`, stderr: '', timedOut: false } : { code: 1, stdout: '', stderr: '', timedOut: false };
    }
    return { code: 0, stdout: `${cmd} 1.0.0\n`, stderr: '', timedOut: false };
  };
}
function io() { const out = []; return { out, io: { write: (t) => out.push(t) } }; }

test('doctorCheck skips when config.deps is empty', () => {
  const r = deps.doctorCheck({ config: {}, projectDir: '/p', exec: machine([]) });
  assert.strictEqual(r.state, 'skip');
});

test('doctorCheck passes when every declared tool resolves, however it got there', () => {
  const r = deps.doctorCheck({ config: { deps: ['gitnexus', 'herdr'] }, projectDir: '/p', exec: machine(['gitnexus', 'herdr']) });
  assert.strictEqual(r.state, 'pass');
  assert.match(r.detail, /gitnexus \/usr\/bin\/gitnexus \(gitnexus 1\.0\.0\)/);
});

test('doctorCheck fails on a missing tool and points at the installer', () => {
  const r = deps.doctorCheck({ config: { deps: ['gitnexus', 'herdr'] }, projectDir: '/p', exec: machine(['gitnexus']) });
  assert.strictEqual(r.state, 'fail');
  assert.strictEqual(r.detail, 'missing: herdr');
  assert.strictEqual(r.fix, 'plt deps install --project /p');
});

test('doctorCheck fails on an id the manifest does not know', () => {
  const r = deps.doctorCheck({ config: { deps: ['nope'] }, projectDir: '/p', exec: machine([]) });
  assert.strictEqual(r.state, 'fail');
  assert.match(r.detail, /unknown tools: nope/);
});

test('recipeFor takes the first recipe whose prerequisite resolves on this platform', () => {
  assert.strictEqual(deps.recipeFor('herdr', { platform: 'darwin', exec: machine(['brew', 'curl']) }).run, 'brew install herdr');
  assert.strictEqual(deps.recipeFor('herdr', { platform: 'linux', exec: machine(['curl']) }).run, 'curl -fsSL https://herdr.dev/install.sh | sh');
  assert.strictEqual(deps.recipeFor('herdr', { platform: 'linux', exec: machine([]) }), null);
  assert.strictEqual(deps.recipeFor('gitnexus', { platform: 'darwin', exec: machine([]) }), null);
});

test('install runs only for missing tools, and re-checks PATH instead of trusting the exit code', () => {
  const onPath = ['gitnexus', 'brew'];
  const ran = [];
  const { out, io: w } = io();
  const code = deps.depsHandler(['install'], {
    io: w, platform: 'darwin', config: { deps: ['gitnexus', 'herdr'] }, exec: machine(onPath),
    run: (cmd) => { ran.push(cmd); return 0; }, // exits 0 but puts nothing on PATH
  });
  assert.deepStrictEqual(ran, ['brew install herdr']);
  assert.strictEqual(code, 1);
  assert.match(out.join(''), /herdr {2}installer exited 0 and herdr is not on PATH/);
});

test('install --dry-run names the command and runs nothing', () => {
  const { out, io: w } = io();
  const code = deps.depsHandler(['install', '--dry-run', 'herdr'], {
    io: w, platform: 'darwin', config: {}, exec: machine(['brew']), run: () => { throw new Error('ran'); },
  });
  assert.strictEqual(code, 0);
  assert.match(out.join(''), /would run: brew install herdr/);
});

test('an unknown id on the command line exits 2', () => {
  const { io: w } = io();
  assert.strictEqual(deps.depsHandler(['install', 'nope'], { io: w, config: {}, exec: machine([]) }), 2);
});
