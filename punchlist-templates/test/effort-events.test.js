'use strict';
// effort-events — the effort ledger's WRITE DISCIPLINE, which is the whole
// requirement. Each test names the failure it prevents rather than the function
// it calls: a ledger that loses a line loses a decision, and a decision log with
// a hole in it is worse than none, because it reads as complete.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const ev = require('../lib/effort-events');

function tmpProcessDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plt-effort-'));
}

test('ids are dense and ordered: e000001, e000002, …', () => {
  const p = tmpProcessDir();
  for (let i = 0; i < 5; i++) ev.appendEffortEvent(p, 'e1', { kind: 'wave', who: 'fan', n: i });
  const got = ev.readEffortEvents(p, 'e1').map((e) => e.id);
  assert.deepEqual(got, ['e000001', 'e000002', 'e000003', 'e000004', 'e000005']);
});

test('every line carries the effort, and a run key is refused', () => {
  const p = tmpProcessDir();
  const one = ev.appendEffortEvent(p, 'e1', { kind: 'decision', who: 'brain' });
  assert.equal(one.effort, 'e1');
  assert.equal(one.run, undefined);
  assert.throws(() => ev.appendEffortEvent(p, 'e1', { kind: 'decision', who: 'brain', run: 'T1' }),
    /carries `effort`, never `run`/);
});

test('a kindless or misspelt event cannot be written from any call site', () => {
  const p = tmpProcessDir();
  assert.throws(() => ev.appendEffortEvent(p, 'e1', {}), /needs a kind/);
  assert.throws(() => ev.appendEffortEvent(p, 'e1', { kind: 'recepit', who: 'brain' }), /is not one of/);
  // `who` is the authority, not the role — a typo there makes the decision log
  // lie about who decided, so it is refused rather than stored.
  assert.throws(() => ev.appendEffortEvent(p, 'e1', { kind: 'decision', who: 'branin' }), /needs who .*got "branin"/);
});

test('a torn trailing line is dropped, not parsed, and the next append succeeds', () => {
  const p = tmpProcessDir();
  ev.appendEffortEvent(p, 'e1', { kind: 'wave', who: 'fan', n: 1 });
  const file = path.join(ev.effortDir(p, 'e1'), 'events.jsonl');
  fs.appendFileSync(file, '{"id":"e000002","kind":"deci');   // crash mid-append

  const after = ev.appendEffortEvent(p, 'e1', { kind: 'decision', who: 'brain' });
  const all = ev.readEffortEvents(p, 'e1');
  assert.equal(all.length, 2, 'the torn line is gone, not counted');
  assert.equal(after.kind, 'decision');
  assert.ok(all.every((e) => typeof e.id === 'string'));
});

test('a corrupt line that is NOT last stops the read rather than guessing', () => {
  const p = tmpProcessDir();
  ev.appendEffortEvent(p, 'e1', { kind: 'wave', who: 'fan', n: 1 });
  const file = path.join(ev.effortDir(p, 'e1'), 'events.jsonl');

  // Written directly, because the ledger REPAIRS its way out of this state if you
  // try to reach it by appending: a bad last line is torn, so the next append drops
  // it. Only a bad line with a good line after it is corruption, and the only way
  // to get one is to put it there.
  const good = fs.readFileSync(file, 'utf8').trim();
  fs.writeFileSync(file, `${good}\nnot json\n${good.replace('e000001', 'e000003')}\n`);

  assert.throws(() => ev.readEffortEvents(p, 'e1'), /corrupt event ledger/);
  assert.throws(() => ev.readEffortEvents(p, 'e1'), /unparsable line 2/,
    'the error names the line, so it can be looked at');
});

test('a lost update becomes a refusal, and the refusal names the effort', () => {
  const p = tmpProcessDir();
  ev.appendEffortEvent(p, 'e1', { kind: 'wave', who: 'fan', n: 1 });
  const seen = ev.readEffortEvents(p, 'e1');
  ev.appendEffortEvent(p, 'e1', { kind: 'blocked', who: 'brain', card: 'T3' });   // another writer
  assert.throws(() => ev.appendEffortEvent(p, 'e1', { kind: 'decision', who: 'brain' }, { expect: seen }),
    /changed since it was read/);
  // …and the ledger is intact: the refusal wrote nothing.
  assert.equal(ev.readEffortEvents(p, 'e1').length, 2);
});

test('two concurrent writers of 50 events each produce e000001..e000100, no gap, no repeat', async () => {
  const p = tmpProcessDir();
  const child = path.join(os.tmpdir(), `plt-writer-${process.pid}.js`);
  fs.writeFileSync(child, `
    const ev = require(${JSON.stringify(path.resolve(__dirname, '../lib/effort-events'))});
    for (let i = 0; i < 50; i++) ev.appendEffortEvent(process.argv[2], 'e1', { kind: 'wave', who: 'fan', n: i });
  `);
  await Promise.all([0, 1].map((i) => new Promise((res, rej) => {
    const c = fork(child, [p], { stdio: 'ignore' });
    c.on('exit', (code) => (code === 0 ? res() : rej(new Error('writer ' + i + ' exited ' + code))));
  })));
  const ids = ev.readEffortEvents(p, 'e1').map((e) => e.id);
  assert.equal(ids.length, 100);
  assert.equal(new Set(ids).size, 100, 'no id is reused');
  assert.deepEqual(ids, ids.slice().sort(), 'ids are written in order');
  assert.equal(ids[0], 'e000001');
  assert.equal(ids[99], 'e000100');
  fs.rmSync(child, { force: true });
});

test('gateEpoch counts closed gates; decisionsThisEpoch is what the next gate must review', () => {
  const p = tmpProcessDir();
  assert.equal(ev.gateEpoch(p, 'e1'), 0);

  ev.appendEffortEvent(p, 'e1', { kind: 'decision', who: 'brain', answer: 'a' });
  ev.appendEffortEvent(p, 'e1', { kind: 'decision', who: 'fan', answer: 'held' });
  assert.equal(ev.decisionsThisEpoch(p, 'e1').length, 1, 'only the brain\'s own calls');

  ev.appendEffortEvent(p, 'e1', { kind: 'epoch', who: 'gate' });
  assert.equal(ev.gateEpoch(p, 'e1'), 1);
  assert.equal(ev.decisionsThisEpoch(p, 'e1').length, 0,
    'a closed gate resets what the next one has to review');

  ev.appendEffortEvent(p, 'e1', { kind: 'decision', who: 'brain', answer: 'b' });
  const now = ev.decisionsThisEpoch(p, 'e1');
  assert.equal(now.length, 1);
  assert.equal(now[0].answer, 'b');
});

test('every written kind validates against the shipped schema', () => {
  const p = tmpProcessDir();
  for (const kind of ev.EFFORT_KINDS) ev.appendEffortEvent(p, 'e1', { kind, who: 'brain' });
  const { loadSchemas } = require('../lib/schemas');
  const Ajv = require('ajv/dist/2020');
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(loadSchemas().event);
  for (const e of ev.readEffortEvents(p, 'e1')) {
    assert.ok(validate(e), `${e.kind} failed the schema: ${JSON.stringify(validate.errors)}`);
  }
  // …and the schema still refuses a line claiming to be both ledgers at once.
  assert.equal(validate({ id: 'e000001', ts: new Date().toISOString(), kind: 'wave', who: 'fan', gate_epoch: 0, run: 'T1', effort: 'e1' }), false);
});

// ---- regressions found by code-adversary on the first review of this file ----
// Regressions from the code-adversary reviews of this file, in the order they were
// found. Five of the first six fail against the pre-review code, verified by running
// them on it; the batching one passes there, because the old code ignored `expect`
// entirely — it guards the re-point instead, and fails if that line is deleted. The
// later ones came from later rounds. Rather than claim a count here — this header has
// overclaimed three times now, which is its own lesson — each test that needs it says in
// its own body which commit it fails against. A header that has to be maintained
// alongside the tests it describes will drift from them.

test('regression: a decision is stamped with the CURRENT epoch, so it cannot escape its gate', () => {
  const p = tmpProcessDir();
  ev.appendEffortEvent(p, 'e1', { kind: 'epoch', who: 'gate' });
  assert.equal(ev.gateEpoch(p, 'e1'), 1);

  // No gate_epoch passed — it used to default to 0 at read time and vanish from
  // the review, which is the brain's own call escaping the gate that catches it.
  const d = ev.appendEffortEvent(p, 'e1', { kind: 'decision', who: 'brain', answer: 'x' });
  assert.equal(d.gate_epoch, 1, 'the writer stamps it');
  assert.equal(ev.decisionsThisEpoch(p, 'e1').length, 1);

  // A caller that believes a different epoch has read stale state; correcting it
  // silently would hide that, so it is refused.
  assert.throws(() => ev.appendEffortEvent(p, 'e1', { kind: 'decision', who: 'brain', gate_epoch: 0 }),
    /disagrees with the ledger/);
  assert.throws(() => ev.appendEffortEvent(p, 'e1', { kind: 'decision', who: 'brain', gate_epoch: '1' }),
    /disagrees with the ledger/, 'a string epoch is not the integer 1');
});

test('regression: `expect` without a remembered hash is refused, not silently unprotected', () => {
  const p = tmpProcessDir();
  ev.appendEffortEvent(p, 'e1', { kind: 'wave', who: 'fan' });
  assert.throws(() => ev.appendEffortEvent(p, 'e1', { kind: 'decision', who: 'brain' }, { expect: [] }),
    /was not read from this ledger/);
});

test('regression: one read can carry several appends — the writer re-points its own hash', () => {
  const p = tmpProcessDir();
  const seen = ev.readEffortEvents(p, 'e1');
  ev.appendEffortEvent(p, 'e1', { kind: 'wave', who: 'fan' }, { expect: seen });
  ev.appendEffortEvent(p, 'e1', { kind: 'decision', who: 'brain' }, { expect: seen });
  assert.equal(ev.readEffortEvents(p, 'e1').length, 2, 'a batching caller is not refused for its own writes');
});

test('regression: who is required — an omission was accepted where a typo was refused', () => {
  const p = tmpProcessDir();
  assert.throws(() => ev.appendEffortEvent(p, 'e1', { kind: 'decision' }), /needs who/);
  assert.throws(() => ev.appendEffortEvent(p, 'e1', { kind: 'decision', who: null }), /needs who/);
});

test('regression: a slug cannot name another directory', () => {
  const p = tmpProcessDir();
  for (const bad of ['../runs/R1', '', 'a/b', '.', '..']) {
    assert.throws(() => ev.appendEffortEvent(p, bad, { kind: 'wave', who: 'fan' }), /must be letters/, `slug ${JSON.stringify(bad)}`);
  }
  assert.ok(!fs.existsSync(path.join(p, 'runs')), 'nothing was written outside efforts/');
});

test('regression: the schema requires who and gate_epoch on an effort line, and refuses them on a run line', () => {
  const { loadSchemas } = require('../lib/schemas');
  const Ajv = require('ajv/dist/2020');
  const validate = new Ajv({ strict: false }).compile(loadSchemas().event);
  const base = { id: 'e000001', ts: new Date().toISOString() };
  assert.equal(validate({ ...base, kind: 'decision', effort: 'e1', who: 'brain', gate_epoch: 0 }), true);
  assert.equal(validate({ ...base, kind: 'decision', effort: 'e1', who: 'brain' }), false, 'no gate_epoch');
  assert.equal(validate({ ...base, kind: 'decision', effort: 'e1', gate_epoch: 0 }), false, 'no who');
  assert.equal(validate({ ...base, kind: 'skill', effort: 'e1', who: 'brain', gate_epoch: 0 }), false, 'a run kind on an effort line');
  assert.equal(validate({ ...base, kind: 'skill', run: 'R1', who: 'brain' }), false, 'who on a run line');
});

test('regression: the envelope belongs to the ledger, not the caller', () => {
  const p = tmpProcessDir();
  ev.appendEffortEvent(p, 'e1', { kind: 'wave', who: 'fan' });
  // Replaying a previously-read event into another ledger used to produce a
  // duplicate id and a line labelled with someone else's effort.
  const replay = { ...ev.readEffortEvents(p, 'e1')[0] };
  assert.throws(() => ev.appendEffortEvent(p, 'e1', replay), /set by the ledger/);
  assert.throws(() => ev.appendEffortEvent(p, 'e1', { kind: 'wave', who: 'fan', effort: 'OTHER' }), /effort is set by the ledger/);
  assert.throws(() => ev.appendEffortEvent(p, 'e1', { kind: 'wave', who: 'fan', ts: 'whenever' }), /ts is set by the ledger/);
  assert.equal(ev.readEffortEvents(p, 'e1').length, 1, 'nothing was written');
});

test('regression: reading cannot escape efforts/ either', () => {
  const p = tmpProcessDir();
  assert.throws(() => ev.readEffortEvents(p, '../runs/R1'), /must be letters/);
  assert.throws(() => ev.gateEpoch(p, 'a/b'), /must be letters/);
  assert.throws(() => ev.decisionsThisEpoch(p, '..'), /must be letters/);
});

test('regression: an own `id` key erases the envelope even when its value is undefined', () => {
  const p = tmpProcessDir();
  ev.appendEffortEvent(p, 'e1', { kind: 'wave', who: 'fan' });
  // The strip-and-replay idiom. A value check passed this; the spread then wrote a
  // line with no id, skipped the next number, and broke the ledger's own schema.
  // `effort` and `gate_epoch` must be stripped too, or an EARLIER guard refuses this
  // and the test proves nothing about the one it is named after. That is what happened:
  // this test passed against the very commit it was written to catch.
  const read = ev.readEffortEvents(p, 'e1')[0];
  const replay = { ...read, id: undefined, ts: undefined };
  delete replay.effort; delete replay.gate_epoch;
  assert.throws(() => ev.appendEffortEvent(p, 'e1', replay), /^Error: id is set by the ledger/);

  const ids = ev.readEffortEvents(p, 'e1').map((e) => e.id);
  assert.deepEqual(ids, ['e000001'], 'nothing was written');
  const next = ev.appendEffortEvent(p, 'e1', { kind: 'wave', who: 'fan' });
  assert.equal(next.id, 'e000002', 'ids stay dense');
});

test('regression: appendTo says what it needs rather than dying on a property read', () => {
  const p = tmpProcessDir();
  assert.throws(() => ev.appendTo(path.join(p, 'x'), null), /needs an event object/);
});

test('the ledger validates the BYTES, not the object that produced them', () => {
  // Fails against f9db593. Three rounds guarded the input; an own toJSON and a getter
  // that answers differently on a second read make the input and the bytes two
  // different things, so a guard on the input was guarding the wrong one.
  const p = tmpProcessDir();

  const viaToJSON = { kind: 'wave', who: 'fan',
    toJSON() { return { id: 'e9', ts: 'whenever', kind: 'wave', who: 'fan', effort: 'e1', gate_epoch: 0 }; } };
  assert.throws(() => ev.appendEffortEvent(p, 'e1', viaToJSON), /id and ts are set by the ledger/);

  let reads = 0;
  const liesOnSecondRead = { kind: 'wave', who: 'fan', get run() { return reads++ ? 'R1' : undefined; } };
  assert.throws(() => ev.appendEffortEvent(p, 'e1', liesOnSecondRead), /never `run`/);

  let kindReads = 0;
  const kindLies = { who: 'fan', get kind() { return kindReads++ ? 'bogus' : 'wave'; } };
  assert.throws(() => ev.appendEffortEvent(p, 'e1', kindLies), /is not one of/);

  let whoReads = 0;
  const whoLies = { kind: 'wave', get who() { return whoReads++ ? 'nobody' : 'fan'; } };
  assert.throws(() => ev.appendEffortEvent(p, 'e1', whoLies), /needs who/);

  assert.deepEqual(ev.readEffortEvents(p, 'e1'), [], 'not one of them reached disk');
});

test('an event that cannot serialize to a JSON object is refused before the write', () => {
  const p = tmpProcessDir();
  const dir = ev.effortDir(p, 'e1');
  assert.throws(() => ev.appendTo(dir, { kind: 'wave', toJSON() { return 'a string'; } }),
    /must serialize to a JSON object/);
  assert.throws(() => ev.appendTo(dir, { kind: 'wave', toJSON() { return [1, 2]; } }),
    /must serialize to a JSON object/);
  // A cycle throws at stringify; the message names the cause rather than leaking a
  // raw TypeError from inside the writer.
  const cyclic = { kind: 'wave' }; cyclic.self = cyclic;
  assert.throws(() => ev.appendTo(dir, cyclic), /does not serialize to JSON/);
});
