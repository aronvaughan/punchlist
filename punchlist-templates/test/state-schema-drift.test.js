'use strict';
// A field written into state.yaml must be a field schemas/state.schema.json names.
//
// This is the regression suite for a defect that already shipped: `landed_out_of_band`, written by
// spine.closeRun, was not in the state schema, so a live run's own state file would not validate
// against its own schema. A person caught it by eye an hour later (fixed in 8c2a092). The doctor
// check `state-fields-declared` exists so the next one is caught by a command instead.
//
// The tests below are written to FIRE, not to pass: each one first builds a lib/ + schema pair that
// really is drifted, asserts the scan reports it, then removes the drift and asserts the same scan
// goes quiet. A check that cannot be made to fail is not evidence of anything.
//
// The "form by form" block below is the other half of that discipline. Round-one review found the
// NOT COVERED comment in lib/doctor.js overstated — six forms went silently green that it did not
// list. Those tests ARE that comment now: every line of it has a case here, in both directions, so
// widening the scanner fails the matching "stays missed" case and forces the comment to be rewritten
// with it. This card exists because a guard looked present and reported nothing; a guard that
// misdescribes its own holes is the same failure one level up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const doctor = require('../lib/doctor');
const REPO = path.resolve(__dirname, '..');
const REAL_LIB = path.join(REPO, 'lib');
const REAL_SCHEMA = path.join(REPO, 'schemas', 'state.schema.json');

function tmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `plt-drift-${name}-`));
  fs.mkdirSync(path.join(dir, 'lib'));
  return dir;
}
// Writes a schema carrying exactly `props` as its top-level properties.
function writeSchema(dir, props) {
  const file = path.join(dir, 'state.schema.json');
  fs.writeFileSync(file, JSON.stringify({ type: 'object', additionalProperties: false, properties: Object.fromEntries(props.map((p) => [p, {}])) }, null, 2));
  return file;
}
function scan(dir, schemaFile) {
  return doctor.scanStateFieldWrites({ libDir: path.join(dir, 'lib'), schemaFile });
}
function fields(list) { return list.map((x) => x.field).sort(); }

// One fixture file, one scan. The schema names nothing, so everything the scan finds lands in
// `undeclared` and this is the whole answer to "does the scanner see this form?".
function caught(code) {
  const dir = tmp('form');
  fs.writeFileSync(path.join(dir, 'lib', 'x.js'), code);
  return fields(scan(dir, writeSchema(dir, [])).undeclared);
}

// ---- the scan, on a fixture built to drift ---------------------------------

test('a field assigned onto state that the schema does not name is reported — and stops being reported once the schema names it', () => {
  const dir = tmp('basic');
  fs.writeFileSync(path.join(dir, 'lib', 'spine.js'), [
    'function closeRun(st) {',
    "  st.status = 'closed';",
    "  st.landed_out_of_band = { sha: 'abc' };",
    '}',
  ].join('\n'));

  const thin = writeSchema(dir, ['status']);
  const drifted = scan(dir, thin);
  assert.deepStrictEqual(fields(drifted.undeclared), ['landed_out_of_band'], 'the undeclared field must be named');
  assert.deepStrictEqual(drifted.undeclared[0].where, ['spine.js:3'], 'and located, file and line');

  const full = writeSchema(dir, ['status', 'landed_out_of_band']);
  const clean = scan(dir, full);
  assert.deepStrictEqual(clean.undeclared, [], 'declaring the field must silence the scan');
  assert.deepStrictEqual(fields(clean.writes), ['landed_out_of_band', 'status'], 'both writes are still seen');
});

// ---- what the scanner sees, form by form -----------------------------------

test('COVERED: a local assigned from readState, declared — not just `st` and `state`', () => {
  assert.deepStrictEqual(caught('const st2 = spine.readState(processDir, runId);\nst2.harvested_at = now;'), ['harvested_at']);
});

test('COVERED: a local assigned from readState without a declarator', () => {
  assert.deepStrictEqual(caught('let cur;\ncur = readState(p, id);\ncur.resumed_from = 1;'), ['resumed_from']);
});

// The regression for the escapeRe defect round one found: the replacement string had been corrupted
// with a pasted section header, so every character escapeRe exists to escape produced garbage and
// the alternative it built could never match. An identifier carrying `$` is the cheapest proof the
// escape is real. Before the fix both assertions returned [] — a silent miss, in the one function
// whose entire value is not missing things.
test('COVERED: a state local whose name needs regex-escaping is still followed', () => {
  assert.deepStrictEqual(caught('const a$b = readState(p, id);\na$b.new_field = 1;'), ['new_field']);
  assert.deepStrictEqual(caught('const a$b = readState(p, id);\na$b.other += 1;'), ['other']);
});

test('COVERED: every compound assignment, not only a plain `=`', () => {
  assert.deepStrictEqual(caught('st.hit_count += 1;'), ['hit_count']);
  assert.deepStrictEqual(caught('st.total -= 1;'), ['total']);
  assert.deepStrictEqual(caught('st.maybe ??= v;'), ['maybe']);
  assert.deepStrictEqual(caught('st.flagged ||= true;'), ['flagged']);
  assert.deepStrictEqual(caught('st.gated &&= ok;'), ['gated']);
  assert.deepStrictEqual(caught('st.n **= 2;'), ['n']);
  assert.deepStrictEqual(caught('st.bits >>>= 1;'), ['bits']);
  assert.deepStrictEqual(caught('st.bits <<= 1;'), ['bits']);
});

test('COVERED: a comparison is not a write — ==, ===, !==, >= and <= stay quiet', () => {
  for (const op of ['==', '===', '!==', '>=', '<=']) {
    assert.deepStrictEqual(caught(`if (st.zz ${op} x) {}`), [], `${op} was read as an assignment`);
  }
});

test('NOT COVERED: the six forms that go silently green, pinned so the comment cannot drift from the code', () => {
  // 1. the object literal launchRun writes — its keys are never assigned, and shorthand keys
  //    (`cycle,`) carry no field name to match at all.
  assert.deepStrictEqual(caught('const state = { run: id, cycle, mystery_literal: 1 };'), []);
  // 2. computed
  assert.deepStrictEqual(caught('st[k] = 1;'), []);
  // 3. Object.assign
  assert.deepStrictEqual(caught('Object.assign(st, { mystery_assign: 1 });'), []);
  // 4. spread
  assert.deepStrictEqual(caught('const m = { ...st, mystery_spread: 1 };'), []);
  // 5. state reached under any other name — a parameter, a loop variable, a destructuring target.
  //    This is the sharp one: rename the variable and the check goes quiet with no signal that it did.
  assert.deepStrictEqual(caught('function landRun(run) { run.resumed_from = 1; }'), []);
  assert.deepStrictEqual(caught('for (const s of states) s.mystery_loop = 1;'), []);
  assert.deepStrictEqual(caught('({ a: st.mystery_destructure } = o);'), []);
  assert.deepStrictEqual(caught('[st.mystery_arr] = arr;'), []);
  // 6. anything outside lib/*.js — the scan reads only *.js under libDir.
  const dir = tmp('outside');
  fs.writeFileSync(path.join(dir, 'lib', 'notjs.txt'), 'st.mystery_outside = 1;');
  assert.deepStrictEqual(fields(scan(dir, writeSchema(dir, [])).undeclared), []);
});

test('a field named only in a comment is counted as a write — the false positive is real and is in the safe direction', () => {
  assert.deepStrictEqual(caught('// the poll keeps state.not_a_real_field = { at }\n'), ['not_a_real_field']);
});

// Cosmetic, and recorded rather than fixed: a comment mention can be the FIRST location printed, so
// the file:line in a failure may point at prose instead of at the write. The fix command names the
// schema and stays right either way. Removing this would mean a comment/string stripper, and a
// hand-rolled one was tried and swallowed real code, which is the worse trade.
test('a comment mention can lead the locations, ahead of the real write', () => {
  const dir = tmp('order');
  fs.writeFileSync(path.join(dir, 'lib', 'spine.js'), '// state.poll = { at, facts }\nst.poll = { at };\n');
  const s = scan(dir, writeSchema(dir, []));
  assert.deepStrictEqual(s.undeclared[0].where, ['spine.js:1', 'spine.js:2']);
});

// ---- the scan, on this repo ------------------------------------------------

test('this repo is clean: every field lib/ assigns onto a state is in schemas/state.schema.json', () => {
  const s = doctor.scanStateFieldWrites();
  assert.deepStrictEqual(s.undeclared, [], `undeclared: ${fields(s.undeclared).join(', ')}`);
  assert.ok(s.writes.length >= 9, `expected the real writers to be found, got ${s.writes.length}`);
  assert.ok(fields(s.writes).includes('landed_out_of_band'), 'the field this whole check exists for must be among them');
});

// The defect exactly as it shipped: this repo's real lib/, and this repo's real schema with
// `landed_out_of_band` deleted from it. If the check cannot fail here it is worth nothing.
test('the real defect, reconstructed: the real lib/ against a schema missing landed_out_of_band', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-drift-real-'));
  const schema = JSON.parse(fs.readFileSync(REAL_SCHEMA, 'utf8'));
  assert.ok(schema.properties.landed_out_of_band, 'precondition: the shipped schema names the field');
  delete schema.properties.landed_out_of_band;
  const file = path.join(dir, 'state.schema.json');
  fs.writeFileSync(file, JSON.stringify(schema, null, 2));

  const drifted = doctor.scanStateFieldWrites({ libDir: REAL_LIB, schemaFile: file });
  assert.deepStrictEqual(fields(drifted.undeclared), ['landed_out_of_band'], 'the shipped defect must be reported');
  assert.ok(drifted.undeclared[0].where.some((w) => w.startsWith('spine.js:')), `must point at the writer, got ${drifted.undeclared[0].where.join(', ')}`);

  const back = doctor.scanStateFieldWrites({ libDir: REAL_LIB, schemaFile: REAL_SCHEMA });
  assert.deepStrictEqual(back.undeclared, [], 'and must go quiet against the shipped schema');
});

// ---- the check as doctor runs it -------------------------------------------

test('doctor carries the check, and it passes on this repo', () => {
  const check = doctor.CHECKS.find((c) => c.id === 'state-fields-declared');
  assert.ok(check, 'doctor must carry state-fields-declared');
  const r = check.run({ projectDir: REPO });
  assert.strictEqual(r.state, 'pass', `${r.detail}`);
});

// The check reads this repo's own source, so it cannot be driven to `fail` through ctx. Assert the
// message a person would read off the same scan the check reports: the field, the file and the line.
test('the failure a person would read names the field and where it is written', () => {
  const dir = tmp('report');
  fs.writeFileSync(path.join(dir, 'lib', 'spine.js'), 'st.brand_new_field = 1;\n');
  const s = scan(dir, writeSchema(dir, ['status']));
  assert.strictEqual(s.undeclared.length, 1);
  assert.strictEqual(s.undeclared[0].field, 'brand_new_field');
  assert.deepStrictEqual(s.undeclared[0].where, ['spine.js:1']);
  assert.ok(s.declared.includes('status'), 'the schema side of the comparison is read too');
});
