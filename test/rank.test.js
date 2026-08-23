import { test } from 'node:test';
import assert from 'node:assert/strict';
import { between, renormalize } from '../src/rank.js';
import { open } from '../src/db.js';

test('between: open list (both null) yields a finite rank', () => {
  const r = between(null, null);
  assert.ok(Number.isFinite(r));
});
test('between: before first', () => {
  const r = between(null, 10);
  assert.ok(Number.isFinite(r) && r < 10);
});
test('between: after last', () => {
  const r = between(10, null);
  assert.ok(Number.isFinite(r) && r > 10);
});
test('between: strictly between neighbors', () => {
  const r = between(1, 2);
  assert.ok(r > 1 && r < 2);
});
test('between: returns null when the gap is exhausted (caller renormalizes)', () => {
  const a = 1;
  const b = a + Number.EPSILON / 4; // no representable midpoint strictly between
  assert.equal(between(a, a), null);
  assert.equal(between(2, 1), null);
  assert.equal(between(a, b), null);
});
test('between: repeated halving eventually demands renormalize', () => {
  let lo = 1, hi = 2, r;
  for (let i = 0; i < 200; i++) {
    r = between(lo, hi);
    if (r === null) break;
    hi = r;
  }
  assert.equal(r, null, 'gap must exhaust within finite splits');
});

test('renormalize: rewrites ranks evenly, preserving order, in caller tx scope', () => {
  const { db, migrate } = open(':memory:');
  migrate();
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO tasks (id,title,status,rank,created_at,updated_at) VALUES (?,?,'active',?,?,?)`);
  ins.run('a', 'a', 1.0000001, now, now);
  ins.run('b', 'b', 1.0000002, now, now);
  ins.run('c', 'c', null, now, now); // null rank sorts last
  renormalize(db, { table: 'tasks', column: 'rank', where: 'status = ?', args: ['active'] });
  const rows = db.prepare('SELECT id, rank FROM tasks ORDER BY rank').all();
  assert.deepEqual(rows.map(r => r.id), ['a', 'b', 'c']);
  assert.deepEqual(rows.map(r => r.rank), [1024, 2048, 3072]);
});

test('renormalize: scoped where only touches matching rows', () => {
  const { db, migrate } = open(':memory:');
  migrate();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id,name,rank,created_at,updated_at) VALUES ('p1','P',1,?,?)`).run(now, now);
  const ins = db.prepare(`INSERT INTO tasks (id,title,status,project_id,rank,created_at,updated_at) VALUES (?,?,'active',?,?,?,?)`);
  ins.run('in1', 'x', 'p1', 7, now, now);
  ins.run('out1', 'y', null, 7, now, now);
  renormalize(db, { table: 'tasks', column: 'rank', where: 'project_id = ?', args: ['p1'] });
  assert.equal(db.prepare(`SELECT rank FROM tasks WHERE id='in1'`).get().rank, 1024);
  assert.equal(db.prepare(`SELECT rank FROM tasks WHERE id='out1'`).get().rank, 7);
});
