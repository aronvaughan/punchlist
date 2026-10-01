'use strict';
// The command registry: `bin/plt` finds its verbs by scanning `lib/*.js` for a `commands`
// export, so adding a verb touches only the module that owns it. Before this, every new
// subcommand edited `bin/plt` and `lib/spine-cli.js` — two files every parallel task shared.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registry = require('../lib/registry');

const tmps = [];
function writeFixtureLib(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-registry-'));
  tmps.push(dir);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}
test.after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

test('discoverCommands finds every commands export and ignores modules without one', () => {
  const dir = writeFixtureLib({
    'a.js': `module.exports = { commands: [{ name: 'alpha', usage: 'plt alpha', handler: () => 0 }] };`,
    'b.js': `module.exports = { helper() {} };`,
  });
  const cmds = registry.discoverCommands(dir);
  assert.deepStrictEqual([...cmds.keys()], ['alpha']);
  assert.strictEqual(cmds.get('alpha').module, 'a.js');
});

test('a name collision throws, naming both modules', () => {
  const dir = writeFixtureLib({
    'a.js': `module.exports = { commands: [{ name: 'dup', usage: 'x', handler: () => 0 }] };`,
    'b.js': `module.exports = { commands: [{ name: 'dup', usage: 'y', handler: () => 0 }] };`,
  });
  assert.throws(() => registry.discoverCommands(dir), /duplicate command "dup" in a\.js and b\.js/);
});

test('dispatch routes argv[0] to the right handler with the rest of argv', () => {
  const dir = writeFixtureLib({
    'a.js': `module.exports = { commands: [{ name: 'alpha', usage: 'plt alpha', handler: (argv) => (argv[0] === 'ok' ? 0 : 1) }] };`,
  });
  assert.strictEqual(registry.dispatch(['alpha', 'ok'], { libDir: dir }), 0);
  assert.strictEqual(registry.dispatch(['alpha', 'nope'], { libDir: dir }), 1);
});

test('dispatch hands the handler a context carrying cwd and env', () => {
  const dir = writeFixtureLib({
    'a.js': `module.exports = { commands: [{ name: 'ctx', usage: 'plt ctx', handler: (argv, ctx) => (ctx.cwd === '/somewhere' && ctx.env.PLT_X === '1' ? 0 : 1) }] };`,
  });
  assert.strictEqual(registry.dispatch(['ctx'], { libDir: dir, cwd: '/somewhere', env: { PLT_X: '1' } }), 0);
});

test('an unknown verb exits 2 and never throws', () => {
  const dir = writeFixtureLib({ 'a.js': `module.exports = {};` });
  const err = [];
  assert.strictEqual(registry.dispatch(['ghost'], { libDir: dir, io: { error: (t) => err.push(t) } }), 2);
  assert.match(err.join(''), /plt: unknown command "ghost" — plt help/);
});

test('no verb, -h and --help print every usage line sorted by name, and exit 0', () => {
  const dir = writeFixtureLib({
    'z.js': `module.exports = { commands: [{ name: 'zulu', usage: 'plt zulu', handler: () => 0 }] };`,
    'a.js': `module.exports = { commands: [{ name: 'alpha', usage: 'plt alpha', handler: () => 0 }] };`,
  });
  for (const argv of [[], ['-h'], ['--help'], ['help']]) {
    const lines = [];
    assert.strictEqual(registry.dispatch(argv, { libDir: dir, io: { write: (t) => lines.push(t) } }), 0);
    assert.deepStrictEqual(lines.join('').trim().split('\n'), ['plt alpha', 'plt zulu']);
  }
});

test('extra commands passed in by bin/plt join the same map and collide the same way', () => {
  const dir = writeFixtureLib({
    'a.js': `module.exports = { commands: [{ name: 'alpha', usage: 'plt alpha', handler: () => 0 }] };`,
  });
  assert.strictEqual(registry.dispatch(['native'], {
    libDir: dir,
    commands: [{ name: 'native', usage: 'plt native', handler: () => 7 }],
  }), 7);
  assert.throws(() => registry.dispatch(['alpha'], {
    libDir: dir,
    commands: [{ name: 'alpha', usage: 'plt alpha', handler: () => 0 }],
  }), /duplicate command "alpha" in a\.js and <builtin>/);
});

// ---- the real lib/ directory -----------------------------------------------
// The point of the task: four modules already shipped a `commands` export and nothing bound
// them to the command line. Each verb below must resolve from the real lib/ scan.
test('every verb the lib modules ship resolves from the real lib directory', () => {
  const cmds = registry.discoverCommands(path.join(__dirname, '..', 'lib'));
  const expected = {
    fan: 'fan.js',
    fsck: 'fsck.js',
    schema: 'schemas.js',
    harvest: 'harvest.js',
    bump: 'harvest.js',
  };
  for (const [verb, mod] of Object.entries(expected)) {
    const c = cmds.get(verb);
    assert.ok(c, `plt ${verb} does not resolve — no module in lib/ claims it`);
    assert.strictEqual(c.module, mod);
    assert.strictEqual(typeof c.handler, 'function');
    assert.ok(c.usage && c.usage.includes('plt ' + verb), `plt ${verb} has no usage line`);
  }
});

test('the spine verbs still resolve after the migration off the bin/plt switch', () => {
  const cmds = registry.discoverCommands(path.join(__dirname, '..', 'lib'));
  for (const verb of ['run', 'step', 'receipt', 'gate', 'handoff', 'prime', 'menu', 'banners',
    'pin', 'effort', 'config', 'facts', 'watch', 'sync', 'mine', 'digest']) {
    const c = cmds.get(verb);
    assert.ok(c, `plt ${verb} no longer resolves`);
    assert.strictEqual(c.module, 'spine-cli.js');
    assert.strictEqual(typeof c.handler, 'function');
  }
});

test('bin/plt dispatches its own verbs and the lib verbs from one map, with no duplicates', () => {
  const plt = require('../bin/plt');
  const cmds = registry.discoverCommands(path.join(__dirname, '..', 'lib'));
  for (const c of plt.commands) {
    assert.ok(!cmds.has(c.name), `bin/plt re-declares "${c.name}", which lib/${cmds.get(c.name) && cmds.get(c.name).module} already owns`);
    assert.strictEqual(typeof c.handler, 'function');
  }
  for (const verb of ['index', 'list', 'show', 'render', 'launch', 'advance', 'runs']) {
    assert.ok(plt.commands.some((c) => c.name === verb), `plt ${verb} is no longer declared`);
  }
  // `validate` moved to lib/validate.js with the validator it runs.
  assert.strictEqual(cmds.get('validate') && cmds.get('validate').module, 'validate.js');
});

// bin/plt used to end with process.exit(code): on macOS a pipe on process.stdout is async, so an
// exit before it drained cut the output at the 64 KB pipe buffer and a piped `--json` was invalid.
test('bin/plt: a verb writing more than 64 KB to a pipe arrives whole', () => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-pipe-'));
  tmps.push(dir);
  const plan = path.join(dir, 'big-plan.md');
  const blocks = [];
  for (let n = 1; n <= 1500; n++) blocks.push(`### Task ${n}: ${'a long task title '.repeat(4)}${n}\n\n**Files:**\n- Modify: \`lib/f${n}.js\`\n`);
  fs.writeFileSync(plan, blocks.join('\n'));
  const plt = path.join(__dirname, '..', 'bin', 'plt');
  const r = spawnSync('/bin/sh', ['-c', `"${process.execPath}" "${plt}" fan "${plan}" --ledger /nonexistent --json | cat`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.length > 64 * 1024, `only ${r.stdout.length} bytes — the test needs more than a pipe buffer`);
  const plan2 = JSON.parse(r.stdout);
  assert.strictEqual(plan2.wave.length, 1500);
});
