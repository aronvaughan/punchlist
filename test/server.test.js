// server.test.js — realSpawn's security guard (dispatch Increment 3). The
// happy path spawns a real detached process (a side effect we don't want in
// tests); here we assert it REFUSES anything that isn't an absolute path to an
// existing file, returning null so the dispatcher no-ops rather than shell-
// injecting or wedging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realSpawn } from '../src/server.js';

test('realSpawn refuses a non-absolute cmd', () => {
  assert.equal(realSpawn('claude-queue-sweep.sh', 'claude'), null);
});

test('realSpawn refuses an absolute path that does not exist', () => {
  assert.equal(realSpawn('/nope/not/a/real/script.sh', 'claude'), null);
});

test('realSpawn refuses empty/undefined cmd', () => {
  assert.equal(realSpawn('', 'claude'), null);
  assert.equal(realSpawn(undefined, 'claude'), null);
});
