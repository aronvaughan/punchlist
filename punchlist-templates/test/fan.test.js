const test = require('node:test'); const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const fan = require('../lib/fan');
const PLAN = path.join(__dirname, 'fixtures', 'plans', 'five-tasks.md');
const LEDGER = path.join(__dirname, 'fixtures', 'plans', 'five-tasks-progress.md');

test('parsePlanTasks: files come from the Files block, after from a Consumes: bullet only', () => {
  const tasks = fan.parsePlanTasks(PLAN);
  assert.deepStrictEqual(tasks.map((t) => t.n), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepStrictEqual(tasks[0].files, ['lib/sampler.js', 'test/sampler.test.js']);
  assert.deepStrictEqual(tasks[1].after, [1]);
  assert.deepStrictEqual(tasks[4].files, []);
});

test('R1: a "Task N" mention outside a Consumes: bullet creates no after edge', () => {
  const t6 = fan.parsePlanTasks(PLAN).find((t) => t.n === 6);
  assert.deepStrictEqual(t6.after, []);
});

test('R2: a Consumes:-shaped line past the Interfaces boundary is never read', () => {
  const t7 = fan.parsePlanTasks(PLAN).find((t) => t.n === 7);
  assert.deepStrictEqual(t7.after, []);
});

test('planWaveTasks: complete tasks drop out, dependents wait, file-sharers lose to the lower number', () => {
  const p = fan.planWaveTasks(PLAN, LEDGER);
  assert.deepStrictEqual(p.done, [1]);
  assert.deepStrictEqual(p.wave.map((t) => t.n), [2, 3, 6, 7]);
  const why = Object.fromEntries(p.excluded.map((e) => [e.n, e.why]));
  assert.match(why[4], /shares lib\/resolver\.js with Task 3/);
  assert.strictEqual(why[5], 'no declared files');
  assert.ok(!(1 in why));
});

test('formatWave prints the wave then one reason per excluded task', () => {
  const out = fan.formatWave(fan.planWaveTasks(PLAN, LEDGER));
  assert.match(out.split('\n')[0], /^wave: T2 T3 T6 T7$/);
  assert.match(out, /^excluded: T4 — shares lib\/resolver\.js with Task 3$/m);
  assert.match(out, /^excluded: T5 — no declared files$/m);
});

// R2 pins Task 7's `after` to [] (see the test above), so with no ledger Task 7 is
// dispatchable: nothing blocks it and it shares no file. Task 2 alone waits on Task 1.
test('a missing ledger means nothing is complete', () => {
  const p = fan.planWaveTasks(PLAN, path.join(__dirname, 'fixtures', 'plans', 'no-such-ledger.md'));
  assert.deepStrictEqual(p.done, []);
  assert.deepStrictEqual(p.wave.map((t) => t.n), [1, 3, 6, 7]);
});

test('an empty wave prints wave: (none)', () => {
  assert.match(fan.formatWave({ wave: [], excluded: [], done: [] }).split('\n')[0], /^wave: \(none\)$/);
});

test('ships a commands export for the registry to discover', () => {
  const c = fan.commands.find((x) => x.name === 'fan');
  assert.strictEqual(c.usage, 'plt fan <plan-file> [--ledger <path>] [--json]');
  assert.strictEqual(typeof c.handler, 'function');
});

test('a ### Task heading inside a fenced code block is an example, not a task of the plan', () => {
  const tasks = fan.parsePlanTasks(path.join(__dirname, 'fixtures', 'plans', 'fenced-tasks.md'));
  assert.deepStrictEqual(tasks.map((t) => t.n), [1, 2, 3]);
  assert.deepStrictEqual(tasks.find((t) => t.n === 1).files, ['lib/sampler.js']);
});

test('a task number declared twice is an error naming both lines, never merged', () => {
  const dup = path.join(__dirname, 'fixtures', 'plans', 'duplicate-tasks.md');
  assert.throws(() => fan.parsePlanTasks(dup), /declares Task 1 twice, at lines 1 and 11/);
  const errs = []; const orig = process.stderr.write;
  process.stderr.write = (m) => { errs.push(String(m)); return true; };
  let code;
  try { code = fan.fanHandler([dup]); } finally { process.stderr.write = orig; }
  assert.strictEqual(code, 2);
  assert.match(errs.join(''), /plt fan: .*duplicate-tasks\.md declares Task 1 twice, at lines 1 and 11/);
});

test('a ledger completion line counts with or without a leading dash', () => {
  const done = fan.readLedgerDone(path.join(__dirname, 'fixtures', 'plans', 'mixed-dash-progress.md'));
  assert.deepStrictEqual(done, [1, 3]);
});

test('a plan names its own ledger, and a missing one is said out loud rather than read as empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fan-'));
  const plan = path.join(dir, 'a-very-long-plan-name.md');
  const realLedger = path.join(dir, 'elsewhere', 'progress.md');
  fs.mkdirSync(path.dirname(realLedger), { recursive: true });
  fs.writeFileSync(realLedger, 'Task 0: complete — abc123\n');
  fs.writeFileSync(plan, [
    '# Plan', '', `**Ledger:** ${realLedger}`, '', '## Tasks', '',
    '### Task 0: first', '', '**Files:**', '- Create: `lib/a.js`', '',
    '### Task 1: second', '', '**Files:**', '- Create: `lib/b.js`', '',
  ].join('\n'));

  // The plan's own Ledger line wins over the basename convention — plan 3's ledger directory did
  // not match its basename, which is how a landed plan read as untouched.
  const named = fan.planWaveTasks(plan, fan.defaultLedger(plan));
  assert.strictEqual(named.ledger.found, true);
  assert.deepStrictEqual(named.done, [0], 'the real ledger is read, so Task 0 is complete');
  assert.deepStrictEqual(named.wave.map((t) => t.n), [1]);
  assert.ok(!fan.formatWave(named).includes('NO LEDGER'));

  // With no Ledger line the basename default applies, and when that file is absent the wave says so
  // instead of quietly treating every task as incomplete.
  const bare = path.join(dir, 'no-ledger-line.md');
  fs.writeFileSync(bare, fs.readFileSync(plan, 'utf8').replace(/^\*\*Ledger:\*\*.*$/m, ''));
  const guessed = fan.planWaveTasks(bare, fan.defaultLedger(bare));
  assert.strictEqual(guessed.ledger.found, false);
  assert.deepStrictEqual(guessed.done, []);
  const text = fan.formatWave(guessed);
  assert.match(text, /NO LEDGER at .*progress\.md/);
  assert.match(text, /This wave is not to be trusted/);
  assert.ok(text.indexOf('NO LEDGER') < text.indexOf('wave:'), 'the warning comes before the wave');
});
