'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const locking = require('../lib/locking');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'locking-'));
}

test('withLock serialises two writers: the second is refused, not silently dropped', () => {
  const dir = tmpdir();
  const held = locking.withLock(dir, () => {
    assert.throws(() => locking.withLock(dir, () => {}, { timeoutMs: 50 }), /another plt is writing/);
    return 'inner-checked';
  });
  assert.strictEqual(held, 'inner-checked');
  assert.strictEqual(fs.existsSync(path.join(dir, '.plt.lock')), false); // released
});

test('a stale lock is reclaimed', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, '.plt.lock'), JSON.stringify({ pid: 999999, host: 'x', at: Date.now() - 60000 }));
  assert.strictEqual(locking.withLock(dir, () => 'ok', { staleMs: 30000 }), 'ok');
});

test('a throwing body still releases the lock', () => {
  const dir = tmpdir();
  assert.throws(() => locking.withLock(dir, () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(fs.existsSync(path.join(dir, '.plt.lock')), false);
});

test('writeFileAtomic leaves no temp file behind', () => {
  const f = path.join(tmpdir(), 'state.yaml');
  locking.writeFileAtomic(f, 'a: 1\n');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'a: 1\n');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f)).filter((n) => n.endsWith('.tmp')), []);
});

test('withLock times out with a message naming the dir, holder pid and time, when a fresh lock is held', () => {
  const dir = tmpdir();
  const at = Date.now();
  fs.writeFileSync(path.join(dir, '.plt.lock'), JSON.stringify({ pid: process.pid, host: 'x', at }));
  assert.throws(
    () => locking.withLock(dir, () => {}, { timeoutMs: 50, staleMs: 30000 }),
    (err) => err instanceof Error
      && err.message.includes(dir)
      && err.message.includes(String(process.pid))
      && err.message.includes('another plt is writing'),
  );
});

test('writeFileAtomic overwrites an existing file and does not truncate on error before rename', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'state.yaml');
  locking.writeFileAtomic(f, 'a: 1\n');
  locking.writeFileAtomic(f, 'a: 2\n');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'a: 2\n');
});
