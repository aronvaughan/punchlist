import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAiReply } from '../src/templates.js';

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
