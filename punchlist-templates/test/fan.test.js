const test = require('node:test'); const { after } = require('node:test'); const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const fan = require('../lib/fan');
const PLAN = path.join(__dirname, 'fixtures', 'plans', 'five-tasks.md');
// Every scratch file this suite writes goes under one directory, removed when the run
// ends. Each run used to leave its plans and ledgers loose in os.tmpdir() under
// pid-stamped names, so the pid never repeated and nothing was ever overwritten or
// cleaned: a few hundred stale fan-*.md files accumulate in a developer's temp directory,
// and a CI image that keeps its temp between jobs grows them without bound.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fan-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
// A throwaway plan with exactly the task/file shape a test needs. Written rather than
// added to the shared fixture, so a contention test cannot change what other tests read.
const EMPTY = path.join(TMP, 'empty-ledger.md');
fs.writeFileSync(EMPTY, '');
function tmpPlan(tasks) {
  const body = tasks.map(([n, files]) =>
    [`### Task ${n}: t${n}`, '', '**Files:**', ...files.map((f) => `- ${f}`), ''].join('\n')).join('\n');
  const f = path.join(TMP, `plan-${tasks.map((t) => t[0]).join('_')}.md`);
  fs.writeFileSync(f, body);
  return f;
}
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
  assert.strictEqual(c.usage, 'plt fan <plan-file> [--ledger <path>] [--json] [--unblock 4,7]');
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
  const dir = fs.mkdtempSync(path.join(TMP, 'named-ledger-'));
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

// ---- contention is a held DECISION, not a verdict (ADR-1 D7) ----------------
// The default is unchanged on purpose — every test above still passes byte for byte,
// because a contended task is still held. What changed is that the hold now carries
// what a human needs to overturn it, and can be overturned.

test('D7: a contended task is held AND says which task and which path', () => {
  const p = fan.planWaveTasks(PLAN, LEDGER);
  const t4 = p.excluded.find((e) => e.n === 4);
  // The old behaviour, intact: still held, same sentence.
  assert.match(t4.why, /shares lib\/resolver\.js with Task 3/);
  // The new part: structured, because the index renders these fields and a human
  // decides from them. A formatted string is not a decision surface.
  assert.deepStrictEqual(t4.contended,
    { with: 3, path: 'lib/resolver.js', all: [{ with: 3, path: 'lib/resolver.js' }], unblocked: false });
});

test('D7: a task held only by a dependency carries NO contended record', () => {
  // A dependency has no unblock. Attaching a contended record here would put an
  // "accept the risk" action in front of work whose inputs do not exist yet.
  const p = fan.planWaveTasks(PLAN, path.join(TMP, 'no-such-ledger.md'));
  const t2 = p.excluded.find((e) => e.n === 2);
  assert.match(t2.why, /after Task 1/);
  assert.strictEqual(t2.contended, undefined);
});

test('D7: unblock moves a contended task into the wave, and the wave says why', () => {
  const p = fan.planWaveTasks(PLAN, LEDGER, { unblocked: [4] });
  assert.ok(p.wave.some((t) => t.n === 4), 'T4 now runs in parallel with T3');
  const t4 = p.wave.find((t) => t.n === 4);
  assert.deepStrictEqual(t4.contended,
    { with: 3, path: 'lib/resolver.js', all: [{ with: 3, path: 'lib/resolver.js' }], unblocked: true },
    'the board must be able to say why two cards are touching one file');
  assert.ok(!p.excluded.some((e) => e.n === 4));
});

test('D7: unblock clears CONTENTION ONLY — a dependency still holds the task', () => {
  // The case most easily got wrong, and the most damaging: an unblock that also
  // satisfied `after` would dispatch a card whose inputs do not exist yet.
  const empty = path.join(TMP, 'own-empty-ledger.md');
  fs.writeFileSync(empty, '');
  const p = fan.planWaveTasks(PLAN, empty, { unblocked: [2, 4] });
  const t2 = p.excluded.find((e) => e.n === 2);
  assert.ok(t2, 'T2 is still held');
  assert.match(t2.why, /after Task 1/);
  assert.ok(!p.wave.some((t) => t.n === 2), 'an unblock cannot satisfy a dependency');
  // Without this, the test passes on master — where the third argument is ignored
  // entirely — so it could not tell "unblock honoured for contention, dependency still
  // holds" from "unblock ignored". That is the whole case it is named for.
  const t4 = p.excluded.find((e) => e.n === 4) || p.wave.find((t) => t.n === 4);
  assert.equal(t4.contended.unblocked, true, 'the unblock WAS honoured where it applies');
  fs.rmSync(empty, { force: true });
});

test('D7: unblocking a task that is not contended changes nothing', () => {
  const before = fan.planWaveTasks(PLAN, LEDGER);
  const after = fan.planWaveTasks(PLAN, LEDGER, { unblocked: [3, 99] });
  assert.deepStrictEqual(after.wave.map((t) => t.n), before.wave.map((t) => t.n));
  assert.deepStrictEqual(after.excluded.map((e) => e.n), before.excluded.map((e) => e.n));
});

test('D7: unblocked ids are read as numbers, so a string from JSON or a CLI flag works', () => {
  const p = fan.planWaveTasks(PLAN, LEDGER, { unblocked: ['4'] });
  assert.ok(p.wave.some((t) => t.n === 4), 'a --unblock 4 flag arrives as a string');
});

// ---- from the first adversarial review of this card ------------------------

test('regression: a string id list is split on commas, never iterated by character', () => {
  // Array.from('12') is ['1','2']. With tasks 1, 2 and 12 all sharing a file, an
  // `--unblock 12` flag dispatched task 2 with no human decision behind it, while task
  // 12 — the one actually cleared — stayed held.
  const plan = tmpPlan([[1, ['x.js']], [2, ['x.js']], [12, ['x.js']]]);
  const p = fan.planWaveTasks(plan, EMPTY, { unblocked: '12' });
  assert.deepStrictEqual(p.wave.map((t) => t.n), [1, 12]);
  assert.ok(p.excluded.some((e) => e.n === 2), 'T2 was never cleared and must stay held');
  assert.deepStrictEqual(Array.from(fan.clearedIds('2, 3')), [2, 3], 'commas and spaces');
});

test('regression: an unblock records EVERY overlap it clears, not just the first', () => {
  // The consent recorded has to match the risk taken: T3 collides with both T1 and T2,
  // and an unblock clears both, so presenting one was consent for the wrong thing.
  const plan = tmpPlan([[1, ['x.js']], [2, ['y.js']], [3, ['y.js', 'x.js']]]);
  const p = fan.planWaveTasks(plan, EMPTY, { unblocked: [3] });
  const c = p.wave.find((t) => t.n === 3).contended;
  assert.deepStrictEqual(c.all, [{ with: 1, path: 'x.js' }, { with: 2, path: 'y.js' }]);
  // `all` and a `count` beside it are two fields that must agree, and a reader who trusts
  // the wrong one gets a number that does not match the list printed next to it. One
  // field, so there is nothing to disagree.
  assert.ok(!('count' in c), 'the overlap tally is read off `all`, never stored twice');
  assert.equal(c.with, 1, 'with/path stay the LOWEST overlap so existing readers keep working');
  // Held, un-unblocked, the reason names both.
  const held = fan.planWaveTasks(plan, EMPTY).excluded.find((e) => e.n === 3);
  assert.match(held.why, /Task 1/);
  assert.match(held.why, /Task 2/);
});

test('regression: an unreadable unblock is refused by name, never guessed at or dropped', () => {
  const plan = tmpPlan([[1, ['x.js']], [2, ['x.js']]]);
  // Dispatching work nobody approved is the cost of guessing, so guessing is refused.
  for (const bad of [4, { a: 1 }, true]) {
    assert.throws(() => fan.planWaveTasks(plan, EMPTY, { unblocked: bad }), /must be a list of task numbers/);
  }
  // And a bad id inside a good list is refused rather than silently skipped — dropping
  // it would hold a task while the human believes they cleared it.
  for (const bad of [['x'], '4,fiive', [0], [-1], [2.5], ['']]) {
    assert.throws(() => fan.planWaveTasks(plan, EMPTY, { unblocked: bad }), /is not a task number/);
  }
  // null and undefined are "nothing cleared", not an error: a JSON field left null is
  // the ordinary shape, not a mistake.
  for (const empty of [null, undefined]) {
    assert.equal(fan.planWaveTasks(plan, EMPTY, { unblocked: empty }).wave.length, 1);
  }
});

test('plt fan --unblock exists, so overturning a hold is one action', () => {
  // The brief asked for "a human can overturn it in one action". Before this, nothing
  // could pass `unblocked` at all: the option had no caller.
  const plan = tmpPlan([[1, ['x.js']], [2, ['x.js']]]);
  const out = [];
  const w = process.stdout.write; process.stdout.write = (c) => { out.push(c); return true; };
  try { fan.fanHandler([plan, '--ledger', EMPTY, '--unblock', '2', '--json']); } finally { process.stdout.write = w; }
  const plan2 = JSON.parse(out.join(''));
  assert.deepStrictEqual(plan2.wave.map((t) => t.n), [1, 2]);
  assert.equal(plan2.wave.find((t) => t.n === 2).contended.unblocked, true);
  assert.ok(fan.commands[0].usage.includes('--unblock'), 'and it is in the usage line');
});

test('plt fan --unblock with the value forgotten is refused, not read as "nothing cleared"', () => {
  // `--unblock` typed last takes the next argument, and there is not one. Reading that as
  // an empty clear ran an ordinary wave — exit 0, no message — under a command the
  // operator wrote to lift a hold. The hold stands while they believe they lifted it,
  // which is the exact failure the unblock mechanism exists to prevent.
  const plan = tmpPlan([[1, ['x.js']], [2, ['x.js']]]);
  const errs = []; const out = [];
  const we = process.stderr.write; const wo = process.stdout.write;
  process.stderr.write = (m) => { errs.push(String(m)); return true; };
  process.stdout.write = (m) => { out.push(String(m)); return true; };
  let code;
  try { code = fan.fanHandler([plan, '--ledger', EMPTY, '--unblock']); }
  finally { process.stderr.write = we; process.stdout.write = wo; }
  assert.strictEqual(code, 2, 'a forgotten value is an operator typo, not a wave');
  assert.match(errs.join(''), /--unblock needs task numbers/);
  assert.strictEqual(out.join(''), '', 'and no wave is printed at all');
});

test('plt fan: a repeated --unblock is refused rather than last-wins', () => {
  // `--unblock 2 --unblock 7` kept only the 7. Last-wins is the conventional shell
  // reading, but the thing dropped here is a human decision: task 2 stayed held on a
  // contended file while the operator had written, in the same command, that it could
  // run. Holding a task while the human believes they cleared it is the failure this
  // whole flag exists to prevent, so the ambiguity is named instead of resolved.
  const plan = tmpPlan([[1, ['x.js']], [2, ['x.js']], [7, ['x.js']]]);
  const errs = []; const out = [];
  const we = process.stderr.write; const wo = process.stdout.write;
  process.stderr.write = (m) => { errs.push(String(m)); return true; };
  process.stdout.write = (m) => { out.push(String(m)); return true; };
  let code;
  try { code = fan.fanHandler([plan, '--ledger', EMPTY, '--unblock', '2', '--unblock', '7', '--json']); }
  finally { process.stderr.write = we; process.stdout.write = wo; }
  assert.strictEqual(code, 2);
  assert.match(errs.join(''), /--unblock given twice/);
  assert.match(errs.join(''), /--unblock 4,7/, 'and says how to clear both');
  assert.strictEqual(out.join(''), '', 'no wave is printed on a refused command');
});

test('regression: only a plain decimal integer is a task number — Number() read far more', () => {
  // The comment over clearedIds has always claimed that an id this code cannot read is
  // refused rather than guessed at. `Number()` did not honour that claim: Number([true])
  // is 1, Number('1e2') is 100, Number('0x4') is 4, Number([[4]]) is 4. None is a
  // plausible keystroke and none can dispatch a contended task in today's plans, so this
  // is the code matching its own stated contract rather than a reachable defect — but a
  // stated contract that the code does not keep is the thing reviewers stop trusting.
  const plan = tmpPlan([[1, ['x.js']], [2, ['x.js']]]);
  for (const bad of [[true], ['1e2'], ['0x4'], [[4]], [' 4 ', '+5'], ['4.0'], [null], [undefined]]) {
    assert.throws(() => fan.planWaveTasks(plan, EMPTY, { unblocked: bad }),
      /is not a task number/, `${JSON.stringify(bad)} must be refused by name`);
  }
  // What a flag or a JSON field really produces still works, spaces and all.
  assert.deepStrictEqual(Array.from(fan.clearedIds(' 4 , 12 ')), [4, 12]);
  assert.deepStrictEqual(Array.from(fan.clearedIds([4, 12])), [4, 12]);
});

// A flag that takes a value and is typed last reads the argument after it, which is not
// there. `--unblock` used to answer that with a normal wave; so did `--ledger`, and
// `--ledger` is the worse of the two, because the wave it prints is not merely unchanged —
// it is computed against a different completion record and looks entirely ordinary.
function runFan(args) {
  const out = []; const errs = [];
  const wo = process.stdout.write; const we = process.stderr.write;
  process.stdout.write = (m) => { out.push(String(m)); return true; };
  process.stderr.write = (m) => { errs.push(String(m)); return true; };
  let code;
  try { code = fan.fanHandler(args); }
  finally { process.stdout.write = wo; process.stderr.write = we; }
  return { code, out: out.join(''), err: errs.join('') };
}

test('plt fan --ledger with the path forgotten is refused, not swapped for the default', () => {
  // The consequential one. With no value, `ledger` fell through to the basename
  // convention, so `plt fan plan.md --ledger` computed the whole wave against a
  // DIFFERENT completion record than the operator named — every task read as incomplete
  // when that guessed path does not exist — and exited 0 with an ordinary-looking wave.
  // Unlike a missed unblock, nothing about the output says a decision went missing.
  const plan = tmpPlan([[1, ['x.js']], [2, ['x.js']]]);
  const r = runFan([plan, '--ledger']);
  assert.strictEqual(r.code, 2, 'a forgotten path is an operator typo, not a default');
  assert.match(r.err, /--ledger needs a path/);
  assert.strictEqual(r.out, '', 'and no wave is printed against a ledger nobody named');
});

test('plt fan: a repeated --ledger is refused rather than last-wins', () => {
  // Same shape as the repeated --unblock: the first path is dropped without a word, and
  // a wave read against the wrong completion record is the failure this flag exists to
  // prevent — G-13 was exactly that, a landed plan reporting every finished task as open.
  const plan = tmpPlan([[1, ['x.js']], [2, ['x.js']]]);
  const r = runFan([plan, '--ledger', EMPTY, '--ledger', EMPTY, '--json']);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /--ledger given twice/);
  assert.strictEqual(r.out, '', 'no wave is printed on a refused command');
});

test('plt fan: a named ledger is still read exactly as before', () => {
  // The guard must refuse the typo and nothing else.
  const plan = tmpPlan([[1, ['x.js']], [2, ['x.js']]]);
  const r = runFan([plan, '--ledger', EMPTY, '--json']);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(JSON.parse(r.out).wave.map((t) => t.n), [1]);
});

test('plt fan: a second positional argument is refused, and the message names it', () => {
  // `plt fan` takes one plan path and that is the whole contract, so a second positional
  // is a mistyped flag or a shell-splitting accident — the exact accident that made this
  // test's author misread a guard as broken: zsh does not split an UNQUOTED PARAMETER
  // EXPANSION, so a variable holding `--ledger x --ledger y` arrived as ONE argument.
  // (Typed words zsh splits normally — it is expansion where it differs from sh.) It was collected into `rest` and dropped in silence, so the command
  // printed a perfectly ordinary wave at exit 0 while an argument the operator typed was
  // never read. That is the same failure as the four flag cases and the same cost: a wave
  // computed against something other than what was meant, with nothing on screen to say so.
  const plan = tmpPlan([[1, ['x.js']], [2, ['x.js']]]);
  const r = runFan([plan, '--ledger', EMPTY, 'stray-second-plan.md']);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /unexpected argument/);
  assert.match(r.err, /stray-second-plan\.md/, 'the message names the argument it could not place');
  assert.strictEqual(r.out, '', 'and prints no wave at all');

  // The shell-splitting shape specifically: one argument holding what was meant as three.
  const split = runFan([plan, '--ledger x --ledger y']);
  assert.strictEqual(split.code, 2, 'a run-together flag string is an argument, not a flag');
  assert.match(split.err, /unexpected argument/);

  // The message must name the argument that was NOT understood. With an unknown flag
  // typed before the plan, the leftovers are ['--verbose', plan] and naming the second
  // one points the operator at the only argument they got right.
  const early = runFan(['--verbose', plan, '--ledger', EMPTY]);
  assert.strictEqual(early.code, 2);
  assert.match(early.err, /--verbose/, 'the unknown flag is named, not the plan path');
  assert.ok(!early.err.includes('plan-1_2.md'), 'and the plan path is not blamed for it');

  // And the contract itself is untouched: one plan path, flags in any position.
  assert.strictEqual(runFan([plan, '--ledger', EMPTY, '--json']).code, 0);
  assert.strictEqual(runFan(['--json', '--ledger', EMPTY, plan]).code, 0, 'flags may precede the plan');
});

// ---- from the adversarial review of this card ------------------------------
// The guard for a missing flag value was in the PARSER, keyed on "is there a next
// argument". Everything below is a way past that question into the same wrong wave, which
// is why the check now lives where the value is consumed instead.

test('HIGH: --ledger "" is refused — an unset shell variable must not pick the ledger', () => {
  // `--ledger "$LEDGER"` with LEDGER unset hands over an empty string. That IS a next
  // argument, so the parser guard passed it, and `ledger || defaultLedger(planPath)` then
  // read '' as "not given" and computed the whole wave against the basename-convention
  // ledger. Exit 0, an ordinary wave, nothing on stderr — and in --json mode not even the
  // NO LEDGER line, because the guessed path happened to exist. That is the defect this
  // card's --ledger commit describes, reached by the second reader of the same state.
  const plan = tmpPlan([[1, ['x.js']], [2, ['x.js']]]);
  for (const blank of ['', '   ']) {
    const r = runFan([plan, '--ledger', blank, '--json']);
    assert.strictEqual(r.code, 2, `--ledger ${JSON.stringify(blank)} must be refused`);
    assert.match(r.err, /--ledger needs a path/);
    assert.strictEqual(r.out, '', 'no wave against a ledger the operator never named');
  }
});

test('a flag typed where a value belongs is not eaten as the value', () => {
  // The missing-value guard only ever caught the flag typed LAST. `--ledger --json` ate
  // the --json as a path: a text wave at exit 0, the operator's --json silently dropped.
  const plan = tmpPlan([[1, ['x.js']], [2, ['x.js']]]);
  const r = runFan([plan, '--ledger', '--json']);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /--ledger needs a path/);
  assert.strictEqual(r.out, '', '--json must not be consumed as the ledger path');

  const u = runFan([plan, '--ledger', EMPTY, '--unblock', '--json']);
  assert.strictEqual(u.code, 2, 'same shape for --unblock');
  assert.match(u.err, /--unblock needs task numbers/);
});

test('when a flag swallows a flag, the message names the FLAG, not the value beside it', () => {
  // `plt fan plan.md --ledger --unblock 2` refused with `unexpected argument "2"` —
  // blaming the one token the operator typed correctly, which is exactly what the stray
  // branch's own comment says it exists to avoid. The leading-dash rule got this right
  // for a bare unknown flag and still got it wrong when a flag ate another flag.
  const plan = tmpPlan([[1, ['x.js']], [2, ['x.js']]]);
  const r = runFan([plan, '--ledger', '--unblock', '2']);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /--ledger needs a path/, 'the flag missing its value is named');
  assert.ok(!/unexpected argument/.test(r.err), 'and the 2 is not blamed for it');
});

test('the usage line in an argument error is the one the registry publishes', () => {
  // A drift net, not a discriminating test: these are two copies of one string today, so
  // this passes either way. It fails the moment someone edits one and not the other.
  const plan = tmpPlan([[1, ['x.js']], [2, ['x.js']]]);
  const r = runFan([plan, 'stray.md']);
  assert.ok(r.err.includes(fan.commands[0].usage),
    'the error must quote commands[0].usage verbatim, never a second copy of it');
});
