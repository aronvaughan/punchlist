'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const lint = require('../lib/lint');
const PLT = path.join(__dirname, '..', 'bin', 'plt');

const rules = (hits) => hits.map((h) => h.rule);

test('lint prose: long-sentence — a sentence over 25 words is one hit at the line it starts on', () => {
  const short = 'This sentence is short. So is this one.';
  const long = 'This one sentence keeps going and going with far more words than anyone should ever have to read in a single breath before the full stop arrives.';
  assert.deepStrictEqual(lint.lintProse(short, { file: 'a.md' }), []);
  const hits = lint.lintProse(`Intro line.\n\n${long}\n`, { file: 'a.md' });
  assert.deepStrictEqual(hits.map((h) => [h.rule, h.line]), [['long-sentence', 3]]);
  assert.match(hits[0].text, /^This one sentence keeps going/);
});

test('lint prose: banned-word — config.writing.banned, whole word, case-insensitive; default is none', () => {
  const text = 'We leverage the Footgun here.\nA leveraged buyout is a different word.\n';
  assert.deepStrictEqual(lint.lintProse(text, { file: 'a.md' }), []);
  const hits = lint.lintProse(text, { file: 'a.md', config: { writing: { banned: ['leverage', 'footgun'] } } });
  assert.deepStrictEqual(hits.map((h) => [h.rule, h.line, h.text]), [['banned-word', 1, 'leverage'], ['banned-word', 1, 'Footgun']]);
});

test('lint prose: ticket-ref — config.writing.ticket_pattern, only in comments of code files and anywhere in test files', () => {
  const config = { writing: { ticket_pattern: '\\bTRK-\\d+\\b' } };
  const js = 'const key = "TRK-1"; // see TRK-12 for the why\n/* TRK-13 */\nfunction f() {}\n';
  const hits = lint.lintProse(js, { file: 'x.js', config });
  assert.deepStrictEqual(hits.map((h) => [h.rule, h.line, h.text]), [['ticket-ref', 1, 'TRK-12'], ['ticket-ref', 2, 'TRK-13']]);
  // A test file: the whole file counts (an internal ticket in an assertion string is the smell).
  const t = lint.lintProse(js, { file: 'x.test.js', config });
  assert.deepStrictEqual(t.map((h) => h.text), ['TRK-1', 'TRK-12', 'TRK-13']);
  // Prose never gets the rule; no pattern configured never fires.
  assert.deepStrictEqual(rules(lint.lintProse('See TRK-12.\n', { file: 'notes.md', config })), []);
  assert.deepStrictEqual(rules(lint.lintProse(js, { file: 'x.js' })), []);
  // A python comment.
  assert.deepStrictEqual(lint.lintProse('x = 1  # TRK-9\n', { file: 'a.py', config }).map((h) => h.text), ['TRK-9']);
});

test('lint prose: undefined-acronym — an ALL-CAPS token used before `ACRONYM (` or `(ACRONYM)` defines it; known_acronyms skip', () => {
  const ok = 'The Architecture Decision Record (ADR) is short. Every ADR has a status.\nAn SBOM (software bill of materials) ships too. The SBOM is signed.\n';
  assert.deepStrictEqual(lint.lintProse(ok, { file: 'a.md' }), []);
  const bad = 'Every ADR has a status.\nThe Architecture Decision Record (ADR) is short. The XML is fine.\n';
  const hits = lint.lintProse(bad, { file: 'a.md' });
  assert.deepStrictEqual(hits.map((h) => [h.rule, h.line, h.text]), [['undefined-acronym', 1, 'ADR'], ['undefined-acronym', 2, 'XML']]);
  assert.deepStrictEqual(lint.lintProse(bad, { file: 'a.md', config: { writing: { known_acronyms: ['ADR', 'XML'] } } }), []);
  // Fenced code in markdown is not prose.
  assert.deepStrictEqual(lint.lintProse('```\nRUN this\n```\n', { file: 'a.md' }), []);
});

test('lint prose: undefined-acronym — a default known_acronyms list ships (CLI, JSON, YAML, ...), merged with the project\'s', () => {
  const text = 'The CLI reads JSON and YAML. An HTTP call hits the API over HTTPS.\n';
  assert.deepStrictEqual(lint.lintProse(text, { file: 'a.md' }), []);
  // The project's own list still applies on top of the default.
  const withProject = lint.lintProse('The CLI talks to the FOO service.\n', { file: 'a.md', config: { writing: { known_acronyms: ['FOO'] } } });
  assert.deepStrictEqual(withProject, []);
});

test('lint prose: undefined-acronym — an ALL-CAPS token skips when it also appears elsewhere in the file in a non-caps form (emphasis, not an acronym)', () => {
  const text = 'This is computed PURELY from state. Read purely as an adverb here.\n';
  assert.deepStrictEqual(lint.lintProse(text, { file: 'a.md' }), []);
  // No lowercase/mixed-case occurrence elsewhere — still flagged.
  const onlyCaps = 'This is computed PURELY from state.\n';
  assert.deepStrictEqual(lint.lintProse(onlyCaps, { file: 'a.md' }).map((h) => h.text), ['PURELY']);
});

test('lint prose: format is `file:line: rule — text`', () => {
  const hits = lint.lintProse('Every ADR has a status.\n', { file: 'doc.md' });
  assert.deepStrictEqual(lint.format(hits), ['doc.md:1: undefined-acronym — ADR']);
});

test('cli: `plt lint prose <file|->` exits 1 on a hit, 0 when clean, 2 on usage; --json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-'));
  const clean = path.join(dir, 'clean.md'); fs.writeFileSync(clean, 'A short line.\n');
  const dirty = path.join(dir, 'dirty.md'); fs.writeFileSync(dirty, 'Every ADR has a status.\n');
  const env = { ...process.env, PLT_PROCESS_DIR: path.join(dir, 'no-process') };
  const run = (args, input) => spawnSync(process.execPath, [PLT, 'lint', ...args], { encoding: 'utf8', env, input });
  assert.strictEqual(run(['prose', clean]).status, 0);
  const r = run(['prose', dirty]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout.trim(), `${dirty}:1: undefined-acronym — ADR`);
  const j = run(['prose', dirty, '--json']);
  assert.strictEqual(j.status, 1);
  assert.deepStrictEqual(JSON.parse(j.stdout).map((h) => h.rule), ['undefined-acronym']);
  const s = run(['prose', '-'], 'Every ADR has a status.\n');
  assert.strictEqual(s.status, 1);
  assert.match(s.stdout, /^-:1: undefined-acronym — ADR/);
  const u = run(['prose']);
  assert.strictEqual(u.status, 2);
  assert.match(u.stderr, /usage: plt lint prose/);
});
