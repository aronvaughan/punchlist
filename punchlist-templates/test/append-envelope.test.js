'use strict';
// spine.appendEvent's envelope. It wrote `{ id, ts, run: runId, ...event }`, so a caller-supplied
// id, ts or run won BY SPREAD ORDER. Twenty-odd call sites pass literals today, which is exactly
// why nothing has tripped it and exactly why it will survive until something replays an event.
//
// This is the same defect the code-adversary found in the effort ledger on T1, where replaying a
// previously-read event produced a duplicate id under another ledger's name. It was fixed there
// and left here, in the writer every other writer goes through.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const spine = require('../lib/spine');

const FIX = path.join(__dirname, 'fixtures', 'spine');
function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-env-'));
  fs.cpSync(FIX, path.join(root, 'process'), { recursive: true });
  const p = path.join(root, 'process');
  fs.mkdirSync(path.join(p, 'runs', 'R'), { recursive: true });
  fs.writeFileSync(path.join(p, 'runs', 'R', 'events.jsonl'), '');
  return p;
}
const lines = (p, id) => fs.readFileSync(path.join(p, 'runs', id, 'events.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('a caller cannot choose the id — replaying a read event is refused, not renumbered', () => {
  // Renumbering would hide the replay. Refusing says which key the caller must drop.
  const p = run();
  assert.throws(() => spine.appendEvent(p, 'R', { kind: 'time', what: 'started', step: 'build', id: 'e000999' }),
    /id .*(ledger|caller)/i);
  assert.equal(lines(p, 'R').length, 0, 'and nothing is written');
});

test('a caller cannot choose the ts', () => {
  const p = run();
  assert.throws(() => spine.appendEvent(p, 'R', { kind: 'time', what: 'started', step: 'build', ts: '2020-01-01T00:00:00.000Z' }),
    /ts .*(ledger|caller)/i);
});

test('a caller cannot relabel which RUN an event belongs to', () => {
  // The worst of the three: the line lands in R's ledger carrying `run: "OTHER"`, so every reader
  // that groups by `run` attributes this run's work to a run that may not exist.
  const p = run();
  assert.throws(() => spine.appendEvent(p, 'R', { kind: 'time', what: 'started', step: 'build', run: 'OTHER' }),
    /run .*(ledger|caller)/i);
});

test('the strip-the-envelope-and-replay idiom is refused, not silently accepted', () => {
  // `{...read, id: undefined}` is what a person writes to replay an event. A value check passes it
  // and then spreads an own `id: undefined` over the stamped one — the line goes to disk with NO
  // id, the next append skips a number, and the ledger fails its own schema. Object.hasOwn is the
  // right test for a spread; T1 learned this the expensive way.
  const p = run();
  const first = spine.appendEvent(p, 'R', { kind: 'time', what: 'started', step: 'build' });
  // The whole read event back, with the id blanked the way a person would: still refused, and
  // named by the key they left behind.
  assert.throws(() => spine.appendEvent(p, 'R', { ...first, id: undefined }), /id .*(ledger|caller)/i);
  // `ts` on its own, with no id at all — otherwise this only ever re-tests the id branch, since
  // the keys are checked in order. That is the difference between covering a branch and standing
  // next to it.
  assert.throws(() => spine.appendEvent(p, 'R', { kind: 'time', what: 'x', step: 'build', ts: undefined }), /ts .*(ledger|caller)/i);
  assert.throws(() => spine.appendEvent(p, 'R', { kind: 'time', what: 'x', step: 'build', run: undefined }), /run .*(ledger|caller)/i);
  const all = lines(p, 'R');
  assert.equal(all.length, 1, 'only the legitimate event is on disk');
  assert.equal(all[0].id, 'e000001');
});

test('the ordinary path still stamps id, ts and run itself', () => {
  const p = run();
  const e = spine.appendEvent(p, 'R', { kind: 'time', what: 'started', step: 'build', actor: 'agent' });
  assert.equal(e.id, 'e000001');
  assert.equal(e.run, 'R');
  assert.match(e.ts, /^\d{4}-\d\d-\d\dT/);
  const e2 = spine.appendEvent(p, 'R', { kind: 'time', what: 'finished', step: 'build', actor: 'agent' });
  assert.equal(e2.id, 'e000002', 'ids still increment');
  assert.deepEqual(lines(p, 'R').map((l) => l.id), ['e000001', 'e000002']);
});

test('an event that cannot serialize is refused by name, not written half-way', () => {
  const p = run();
  const cyc = { kind: 'time', what: 'started', step: 'build' };
  cyc.self = cyc;
  assert.throws(() => spine.appendEvent(p, 'R', cyc), /serialize/i);
  assert.equal(lines(p, 'R').length, 0);
});

test('a torn last line is still repaired — the recovery survives the consolidation', () => {
  // Run ledgers had this and effort ledgers did not. Whatever the shared writer ends up being, a
  // crash mid-append must not make the next append fail or corrupt the file.
  const p = run();
  spine.appendEvent(p, 'R', { kind: 'time', what: 'started', step: 'build', actor: 'agent' });
  const f = path.join(p, 'runs', 'R', 'events.jsonl');
  fs.appendFileSync(f, '{"id":"e000002","kind":"ti');           // a crash mid-write
  const e = spine.appendEvent(p, 'R', { kind: 'time', what: 'finished', step: 'build', actor: 'agent' });
  const all = lines(p, 'R');
  assert.deepEqual(all.map((l) => l.id), ['e000001', 'e000002'], 'the torn line is dropped, not kept');
  assert.equal(e.what, 'finished');
});

test('`at` back-dates deliberately, and is validated — the seam is not a hole', () => {
  // The distinction the whole change turns on: a `ts` KEY arrives inside a caller's data and wins
  // by spread order, silently. An `at` OPTION is a separate argument that no spread can produce,
  // so choosing a timestamp stays possible and stays deliberate.
  const p = run();
  const e = spine.appendEvent(p, 'R', { kind: 'time', what: 'started', step: 'build' }, { at: '2020-01-02T03:04:05.000Z' });
  assert.equal(e.ts, '2020-01-02T03:04:05.000Z');
  assert.equal(lines(p, 'R')[0].ts, '2020-01-02T03:04:05.000Z');
  // and it is still refused as a key, in the same call
  assert.throws(() => spine.appendEvent(p, 'R', { kind: 'time', what: 'x', step: 'b', ts: '2020-01-01T00:00:00.000Z' }, { at: '2021-01-01T00:00:00.000Z' }),
    /ts is set by the ledger/);
});

test('a junk `at` is refused by name rather than silently becoming now or Invalid Date', () => {
  // `new Date('yesterday').toISOString()` throws RangeError, and `new Date(undefined)` is NaN —
  // both would surface far from the caller that typed it.
  const p = run();
  for (const bad of ['yesterday', '', 'not-a-date', 42, null, {}]) {
    assert.throws(() => spine.appendEvent(p, 'R', { kind: 'time', what: 'x', step: 'b' }, { at: bad }),
      /at must be an ISO timestamp string/, `at: ${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(lines(p, 'R').length, 0);
});
