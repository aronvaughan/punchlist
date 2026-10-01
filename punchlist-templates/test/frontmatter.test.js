'use strict';
// Frontmatter parser edge cases — review fix round 1 on Task 11 (the `menu:` nested block map
// exposed gaps the existing corpus never exercised). See bin/plt's parseFrontmatter.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const plt = require(path.join(__dirname, '..', 'bin', 'plt'));

test('parseFrontmatter: nested block map to two levels (menu: words/commands/by_mode)', () => {
  const { fm, errors } = plt.parseFrontmatter([
    '---',
    'name: x',
    'menu:',
    '  words: { where: "where are we", go: "go" }',
    '  commands:',
    '    where: "plt prime {run}"',
    '    go:    "run the Next line of HANDOFF.md verbatim"',
    '  by_mode:',
    '    WAIT: [approve, block, where]',
    '    START: [go, where]',
    '---',
    'body',
  ].join('\n'));
  assert.strictEqual(errors.length, 0);
  assert.deepStrictEqual(fm.menu.words, { where: 'where are we', go: 'go' });
  assert.deepStrictEqual(fm.menu.commands, { where: 'plt prime {run}', go: 'run the Next line of HANDOFF.md verbatim' });
  assert.deepStrictEqual(fm.menu.by_mode, { WAIT: ['approve', 'block', 'where'], START: ['go', 'where'] });
});

test('parseFrontmatter: an inline map may wrap onto a continuation line before its closing brace', () => {
  const { fm, errors } = plt.parseFrontmatter([
    '---',
    'name: x',
    'words: { a: "one", b: "two",',
    '         c: "three" }',
    'next: y',
    '---',
    'body',
  ].join('\n'));
  assert.strictEqual(errors.length, 0);
  assert.deepStrictEqual(fm.words, { a: 'one', b: 'two', c: 'three' });
  assert.strictEqual(fm.next, 'y');
});

test('parseFrontmatter: an inline map that never closes is reported, not swallowed to the end of frontmatter', () => {
  const { fm, errors } = plt.parseFrontmatter([
    '---',
    'name: x',
    'broken: { a: 1',
    'after: kept',
    '---',
    'body',
  ].join('\n'));
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].line, 3);
  assert.match(errors[0].msg, /unterminated inline map/);
  // The regression this guards: `after: kept` must not be swallowed into `broken`'s value.
  assert.strictEqual(fm.after, 'kept');
  assert.ok(!('broken' in fm) || fm.broken !== undefined);
});

test('parseScalar / parseFrontmatter: a quoted value containing " #" is kept verbatim, not treated as a trailing comment', () => {
  assert.strictEqual(plt.parseScalar('"abc # def"'), 'abc # def');
  const { fm, errors } = plt.parseFrontmatter([
    '---',
    'name: x',
    'label: "abc # def"',
    '---',
    'body',
  ].join('\n'));
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(fm.label, 'abc # def');
});

test('parseFrontmatter: a plain `key: value` at a `- name:` list item\'s own indent is an ERROR (not folded into the item) — current, documented behavior', () => {
  const { fm, errors } = plt.parseFrontmatter([
    '---',
    'name: x',
    'inputs:',
    '  - name: foo',
    '  bar: baz',
    '---',
    'body',
  ].join('\n'));
  assert.strictEqual(fm.inputs.length, 1);
  assert.strictEqual(fm.inputs[0].name, 'foo');
  assert.ok(!('bar' in fm.inputs[0]));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].msg, /unparseable frontmatter line: bar: baz/);
});
