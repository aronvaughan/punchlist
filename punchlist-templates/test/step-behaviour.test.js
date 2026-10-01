'use strict';
// Step behaviour is DECLARED, not inferred from the id. Every test here names the guard that
// used to disappear silently, because that is the failure mode: nothing errors, nothing warns,
// a safety check simply stops running and the card ships.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const spine = require('../lib/spine');

const d = (def, id, flag) => spine.stepDeclares(def, id, flag);

test('the name rules still answer when a step declares nothing — no shipped pack changes', () => {
  // The fallback is the whole reason this change is safe to land. Altering when a
  // base-freshness check fires on somebody else's project, as a side effect of a refactor,
  // is not this card's call.
  assert.equal(d(null, 'merge', 'lands'), true);
  assert.equal(d(null, 'open-pr', 'lands'), true);
  assert.equal(d({ id: 'merge' }, 'merge', 'lands'), true);
  assert.equal(d(null, 'commit', 'lands'), false);
  assert.equal(d(null, 'pre-pr', 'checks_drift'), true);
  assert.equal(d(null, 'pre-commit', 'checks_drift'), false);
});

test('an honestly named landing step keeps the base-freshness check by declaring it', () => {
  // T17's first high: a landing step named `commit` got no "branch base is behind
  // origin/main" signal, because gateCheck asked its NAME. The card kept the id `merge` — a
  // pull request in a cycle that opens none — to keep the check.
  assert.equal(d({ id: 'commit', lands: true }, 'commit', 'lands'), true);
  assert.equal(d({ id: 'land', lands: 'true' }, 'land', 'lands'), true);
});

test('an honestly named pre-commit step keeps the touches-drift check by declaring it', () => {
  // T17's second high, found a round later: renaming `pre-pr` to `pre-commit` switched
  // checkTouchesDrift off for every card on the cycle, with nothing to say it had gone.
  assert.equal(d({ id: 'pre-commit', checks_drift: true }, 'pre-commit', 'checks_drift'), true);
});

test('an explicit false turns a name-matched check OFF — declaring beats naming both ways', () => {
  // Otherwise the property is only ever additive, and a step called `merge` on a cycle that
  // does not land could never say so.
  assert.equal(d({ id: 'merge', lands: false }, 'merge', 'lands'), false);
  assert.equal(d({ id: 'pre-pr', checks_drift: false }, 'pre-pr', 'checks_drift'), false);
});

test("the string 'false' is false, not truthy — the `manual: false` trap, one field over", () => {
  // This parser makes every scalar a string. A flag that read 'false' as true would hand back
  // exactly the class of silent wrongness this change exists to remove, on the very field
  // added to remove it.
  assert.equal(d({ id: 'merge', lands: 'false' }, 'merge', 'lands'), false);
  assert.equal(d({ id: 'x', checks_drift: 'false' }, 'x', 'checks_drift'), false);
});

test('anything that is not a boolean is an error naming the step, never a quiet default', () => {
  // `lands: yes` and `lands: 1` are what a person actually types. Defaulting either way hides
  // the typo; the error says which step and which key.
  for (const v of ['yes', 'no', 1, 0, 'TRUE', [], {}, 'on']) {
    assert.throws(() => d({ id: 'commit', lands: v }, 'commit', 'lands'), /step commit: lands must be true or false/,
      `lands: ${JSON.stringify(v)} must be refused by name`);
  }
});

test('an absent or null declaration falls back rather than throwing', () => {
  // A step that simply does not mention the key is the common case and must stay silent.
  assert.equal(d({ id: 'merge' }, 'merge', 'lands'), true);
  assert.equal(d({ id: 'merge', lands: null }, 'merge', 'lands'), true);
  assert.equal(d({ id: 'commit', lands: undefined }, 'commit', 'lands'), false);
});

test('the fallback table is the only place a name rule lives', () => {
  // If a fourth check is added by copying an `includes(stepId)` into a new call site, this
  // assertion does not catch it — but it does keep the two that exist in one readable place,
  // which is where the next reader will look.
  assert.deepEqual(Object.keys(spine.NAME_FALLBACK).sort(), ['checks_drift', 'lands']);
});

// ---- the validator catches a mistyped flag before a live run does ----------------------
// Through validateFile, the path `plt validate` actually takes: a real pack on disk, parsed by
// the real parser, so the test cannot pass against a shape the parser never produces.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateFile } = require('../lib/validate');

function packWith(line) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-flag-'));
  const f = path.join(dir, 'w.md');
  fs.writeFileSync(f, [
    '---', 'name: w', 'kind: workflow', 'version: 1',
    'description: "d"', 'domain: engineering', 'tags: [t]', 'actors: [agent]', '---', '',
    '# W', '', 'steps:',
    '  - id: commit', '    assignee: agent', '    title: "t"',
    ...(line ? ['    ' + line] : []), '',
  ].join('\n'));
  return f;
}
const flagErrors = (line) => ((validateFile(packWith(line), {}) || {}).errors || []).filter((e) => /lands|checks_drift/.test(e.msg));

test('validate accepts a boolean flag, in either spelling this parser produces', () => {
  for (const v of ['true', 'false']) {
    assert.deepEqual(flagErrors(`lands: ${v}`), [], `lands: ${v} must validate`);
    assert.deepEqual(flagErrors(`checks_drift: ${v}`), [], `checks_drift: ${v} must validate`);
  }
});

test('validate refuses a mistyped flag, naming the step and the key', () => {
  // `lands: yes` is what a person types. Without this it validates clean, then throws at gate
  // time on a live run, far from the pack that is wrong.
  for (const v of ['yes', '1', 'on']) {
    const errs = flagErrors(`lands: ${v}`);
    assert.equal(errs.length, 1, `lands: ${v} must be refused`);
    assert.match(errs[0].msg, /step `commit`: `lands` must be true or false/);
  }
  assert.equal(flagErrors('checks_drift: maybe').length, 1);
});

test('validate stays silent when the keys are absent', () => {
  assert.deepEqual(flagErrors(null), []);
});
