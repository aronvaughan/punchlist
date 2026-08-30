// govern.test.js — the data-governance guard (skills/shared/govern.sh). The
// structural rule: gitignored/data paths accept anything (exit 0); a tracked
// (publishable) path with a real secret is blocked (exit 3); a mere code
// reference to the var name is not (exit 0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOVERN = join(REPO, 'skills/shared/govern.sh');

function classify(path, content) {
  return spawnSync('bash', [GOVERN, 'classify', path, '--stdin'],
    { input: content, encoding: 'utf8', cwd: REPO }).status;
}

test('private path (under data/, gitignored) accepts any content', () => {
  assert.equal(classify('data/skills/anything.md', 'PUNCHLIST_TOKEN=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'), 0);
});

test('publishable path + a REAL token value is BLOCKED (exit 3)', () => {
  assert.equal(classify('skills/shared/new.md', 'PUNCHLIST_TOKEN=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'), 3);
});

test('publishable path + a code REFERENCE to the var is allowed (exit 0)', () => {
  assert.equal(classify('skills/shared/new.md', 'PUNCHLIST_TOKEN=$(read_env_token "$f")'), 0);
  assert.equal(classify('skills/shared/new.md', 'put PUNCHLIST_TOKEN=... in your env'), 0);
});

test('publishable path, clean generic content is allowed (exit 0)', () => {
  assert.equal(classify('skills/shared/new.md', '# A generic reusable skill\nno secrets here'), 0);
});

test('audit runs read-only and exits 0', () => {
  const r = spawnSync('bash', [GOVERN, 'audit', REPO], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /audit: scanned \d+ tracked/);
});
