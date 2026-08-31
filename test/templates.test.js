import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAiReply, makeRunner, resolveTemplatePath, templateScope, readTemplate } from '../src/templates.js';

test('template scope: instance plane wins over global authored/packs; scope is derived from location', () => {
  const base = mkdtempSync(join(tmpdir(), 'tpl-'));
  const repo = join(base, 'repo'); const inst = join(base, 'data-templates');
  mkdirSync(join(repo, 'templates', 'authored'), { recursive: true });
  mkdirSync(join(repo, 'templates', 'packs', 'core'), { recursive: true });
  mkdirSync(inst, { recursive: true });
  writeFileSync(join(repo, 'templates', 'packs', 'core', 'coding.md'), 'PACK');
  writeFileSync(join(repo, 'templates', 'authored', 'coding.md'), 'AUTHORED');
  writeFileSync(join(inst, 'coding.md'), 'INSTANCE');
  writeFileSync(join(inst, 'private-only.md'), 'PRIVATE');

  // instance wins over authored wins over packs
  assert.equal(readTemplate(repo, 'coding', { instanceDir: inst }), 'INSTANCE');
  assert.equal(templateScope(repo, 'coding', { instanceDir: inst }), 'instance');
  // without the instance plane, authored wins over packs
  assert.equal(readTemplate(repo, 'coding'), 'AUTHORED');
  assert.equal(templateScope(repo, 'coding'), 'global');
  // an instance-only template resolves + scopes instance
  assert.equal(readTemplate(repo, 'private-only', { instanceDir: inst }), 'PRIVATE');
  assert.equal(templateScope(repo, 'private-only', { instanceDir: inst }), 'instance');
  // missing everywhere → null; bad names rejected; no escape via ../
  assert.equal(resolveTemplatePath(repo, 'nope', { instanceDir: inst }), null);
  assert.equal(templateScope(repo, 'nope', { instanceDir: inst }), null);
  assert.equal(resolveTemplatePath(repo, '../evil', { instanceDir: inst }), null);
  rmSync(base, { recursive: true, force: true });
});

test('parseAiReply: splits NOTE and TEMPLATE blocks', () => {
  const raw = [
    'preamble the parser must ignore',
    '<<<NOTE', 'Added a priority input.', 'NOTE',
    '<<<TEMPLATE', '---', 'name: coding-task', '---', '## Purpose', 'body', 'TEMPLATE',
  ].join('\n');
  const { note, draft } = parseAiReply(raw);
  assert.equal(note, 'Added a priority input.');
  assert.equal(draft, '---\nname: coding-task\n---\n## Purpose\nbody');
});

test('parseAiReply: missing TEMPLATE block throws', () => {
  assert.throws(() => parseAiReply('<<<NOTE\nhi\nNOTE'), /no template block/i);
});

test('parseAiReply: missing NOTE tolerated (empty note)', () => {
  const { note, draft } = parseAiReply('<<<TEMPLATE\n---\nname: x\n---\nbody\nTEMPLATE');
  assert.equal(note, '');
  assert.equal(draft, '---\nname: x\n---\nbody');
});

// A child killed by the timeout must NOT be reported as code 0 — otherwise a
// slow (or maxBuffer-overflowing) `plt validate` would be treated as "passed"
// and an unvalidated template would be written + committed (validation-gate
// bypass). SIGTERM/null-code must map non-zero.
test('makeRunner: a timed-out spawn reports a non-zero code', async () => {
  const run = makeRunner();
  const r = await run({ cmd: process.execPath, args: ['-e', 'setTimeout(()=>{}, 5000)'], timeoutMs: 200 });
  assert.notEqual(r.code, 0, 'timeout must not look like success');
});

// Writing the prompt to a child that exits before draining stdin breaks the pipe
// (EPIPE); makeRunner must swallow that stream error and still resolve, never
// throw an unhandled error that would crash the server.
test('makeRunner: stdin EPIPE on an early-exiting child does not throw', async () => {
  const run = makeRunner();
  const r = await run({ cmd: process.execPath, args: ['-e', 'process.exit(0)'], input: 'x'.repeat(200000) });
  assert.equal(r.code, 0);
});
