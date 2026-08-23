import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDue, spawn } from '../src/recur.js';
import { open, ulid } from '../src/db.js';

// nextDue(rule, oldDueISO, completedISO, todayISO) -> ISO date
// due anchor: first schedule tick STRICTLY AFTER max(oldDue, today).
// completion anchor: tick relative to completion DATE, strictly after it.
const CASES = [
  // --- due anchor: daily ---
  ['due daily on-time', { freq: 'daily', anchor: 'due' }, '2026-03-01', '2026-03-01', '2026-03-01', '2026-03-02'],
  ['due daily late catches up to future', { freq: 'daily', anchor: 'due' }, '2026-03-01', '2026-03-05', '2026-03-05', '2026-03-06'],
  ['due daily across US DST spring-forward', { freq: 'daily', anchor: 'due' }, '2026-03-07', '2026-03-07', '2026-03-07', '2026-03-08'],
  ['due daily across US DST fall-back', { freq: 'daily', anchor: 'due' }, '2026-10-31', '2026-10-31', '2026-10-31', '2026-11-01'],
  // --- due anchor: every N days (ticks from oldDue origin) ---
  ['due every3 on-time', { freq: 'every', n: 3, anchor: 'due' }, '2026-03-01', '2026-03-01', '2026-03-01', '2026-03-04'],
  ['due every3 late keeps grid', { freq: 'every', n: 3, anchor: 'due' }, '2026-03-01', '2026-03-05', '2026-03-05', '2026-03-07'],
  ['due every3 very late keeps grid', { freq: 'every', n: 3, anchor: 'due' }, '2026-03-01', '2026-04-01', '2026-04-01', '2026-04-03'],
  ['due every7 same-day completion never respawns today', { freq: 'every', n: 7, anchor: 'due' }, '2026-03-01', '2026-03-08', '2026-03-08', '2026-03-15'],
  // --- due anchor: weekly(days) ---
  ['due weekly mon+thu from mon', { freq: 'weekly', days: ['mon', 'thu'], anchor: 'due' }, '2026-03-02', '2026-03-02', '2026-03-02', '2026-03-05'],
  ['due weekly mon+thu late (fri)', { freq: 'weekly', days: ['mon', 'thu'], anchor: 'due' }, '2026-03-02', '2026-03-06', '2026-03-06', '2026-03-09'],
  ['due weekly mon very late', { freq: 'weekly', days: ['mon'], anchor: 'due' }, '2026-03-02', '2026-03-24', '2026-03-24', '2026-03-30'],
  ['due weekly sun wraps week', { freq: 'weekly', days: ['sun'], anchor: 'due' }, '2026-03-08', '2026-03-08', '2026-03-08', '2026-03-15'],
  // --- due anchor: monthly(dom) with clamping, non-sticky ---
  ['due monthly-31 jan->feb clamps to 28', { freq: 'monthly', dom: 31, anchor: 'due' }, '2026-01-31', '2026-01-31', '2026-01-31', '2026-02-28'],
  ['due monthly-31 feb->mar returns to 31 (non-sticky)', { freq: 'monthly', dom: 31, anchor: 'due' }, '2026-02-28', '2026-02-28', '2026-02-28', '2026-03-31'],
  ['due monthly-31 late mid-march', { freq: 'monthly', dom: 31, anchor: 'due' }, '2026-01-31', '2026-03-15', '2026-03-15', '2026-03-31'],
  ['due monthly-15 very late', { freq: 'monthly', dom: 15, anchor: 'due' }, '2026-05-15', '2026-08-20', '2026-08-20', '2026-09-15'],
  ['due monthly-31 leap feb', { freq: 'monthly', dom: 31, anchor: 'due' }, '2028-01-31', '2028-01-31', '2028-01-31', '2028-02-29'],
  // --- completion anchor ---
  ['comp daily on-time', { freq: 'daily', anchor: 'completion' }, '2026-03-05', '2026-03-05', '2026-03-05', '2026-03-06'],
  ['comp daily late slides with completion', { freq: 'daily', anchor: 'completion' }, '2026-03-01', '2026-03-10', '2026-03-10', '2026-03-11'],
  ['comp every10', { freq: 'every', n: 10, anchor: 'completion' }, '2026-03-05', '2026-03-05', '2026-03-05', '2026-03-15'],
  ['comp every3 year rollover', { freq: 'every', n: 3, anchor: 'completion' }, '2026-12-30', '2026-12-30', '2026-12-30', '2027-01-02'],
  ['comp daily across DST', { freq: 'every', n: 1, anchor: 'completion' }, '2026-03-08', '2026-03-08', '2026-03-08', '2026-03-09'],
  ['comp weekly mon+fri from wed', { freq: 'weekly', days: ['mon', 'fri'], anchor: 'completion' }, '2026-03-04', '2026-03-04', '2026-03-04', '2026-03-06'],
  ['comp weekly mon completed mon is strictly-after', { freq: 'weekly', days: ['mon'], anchor: 'completion' }, '2026-03-02', '2026-03-02', '2026-03-02', '2026-03-09'],
  ['comp monthly-31 completed feb-10 clamps within feb', { freq: 'monthly', dom: 31, anchor: 'completion' }, '2026-02-10', '2026-02-10', '2026-02-10', '2026-02-28'],
  ['comp monthly-31 completed jan-31 strictly-after', { freq: 'monthly', dom: 31, anchor: 'completion' }, '2026-01-31', '2026-01-31', '2026-01-31', '2026-02-28'],
  ['comp monthly-1 mid-month', { freq: 'monthly', dom: 1, anchor: 'completion' }, '2026-03-15', '2026-03-15', '2026-03-15', '2026-04-01'],
];

for (const [name, rule, oldDue, completed, today, expected] of CASES) {
  test(`nextDue: ${name}`, () => {
    assert.equal(nextDue(rule, oldDue, completed, today), expected);
  });
}

test('nextDue rejects null oldDue for due anchor', () => {
  assert.throws(() => nextDue({ freq: 'daily', anchor: 'due' }, null, '2026-03-01', '2026-03-01'), /due/);
});
test('nextDue rejects bad rules', () => {
  assert.throws(() => nextDue({ freq: 'yearly', anchor: 'due' }, '2026-03-01', '2026-03-01', '2026-03-01'));
  assert.throws(() => nextDue({ freq: 'weekly', days: [], anchor: 'due' }, '2026-03-01', '2026-03-01', '2026-03-01'));
  assert.throws(() => nextDue({ freq: 'every', n: 0, anchor: 'completion' }, '2026-03-01', '2026-03-01', '2026-03-01'));
  assert.throws(() => nextDue({ freq: 'monthly', dom: 32, anchor: 'due' }, '2026-03-01', '2026-03-01', '2026-03-01'));
});

test('spawn copies project/tags/steps(unchecked), sets when=nextDue, spawned_from, end-of-section rank', () => {
  const { db, migrate } = open(':memory:');
  migrate();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id,name,rank,created_at,updated_at) VALUES ('p1','Home',1,?,?)`).run(now, now);
  db.prepare(`INSERT INTO tags (id,name) VALUES ('g1','chore')`).run();
  db.prepare(`INSERT INTO tasks (id,title,notes,project_id,status,when_type,when_date,due_date,rank,recur,created_by,created_at,updated_at)
              VALUES ('t1','water plants','note',  'p1','done','date','2026-03-01','2026-03-01',1,'{"freq":"daily","anchor":"due"}','aron',?,?)`).run(now, now);
  db.prepare(`INSERT INTO task_tags (task_id,tag_id) VALUES ('t1','g1')`).run();
  db.prepare(`INSERT INTO steps (id,task_id,title,done,rank) VALUES ('s1','t1','fill can',1,1)`).run();
  // an existing upcoming task in the same project, to test end-of-section rank
  db.prepare(`INSERT INTO tasks (id,title,project_id,status,when_type,when_date,rank,created_at,updated_at)
              VALUES ('t2','later','p1','active','date','2026-03-10',5,?,?)`).run(now, now);

  const old = db.prepare(`SELECT * FROM tasks WHERE id='t1'`).get();
  const newId = spawn(db, old, '2026-03-02', '2026-03-01');
  const spawned = db.prepare('SELECT * FROM tasks WHERE id = ?').get(newId);
  assert.equal(spawned.status, 'active');
  assert.equal(spawned.when_type, 'date');
  assert.equal(spawned.when_date, '2026-03-02');
  assert.equal(spawned.due_date, '2026-03-02');
  assert.equal(spawned.project_id, 'p1');
  assert.equal(spawned.recur, old.recur);
  assert.equal(spawned.spawned_from, 't1');
  assert.equal(spawned.created_by, 'aron');
  assert.equal(spawned.completed_at, null);
  assert.equal(spawned.today_rank, null);
  assert.ok(spawned.rank > 5, 'rank appended after existing upcoming task');
  const steps = db.prepare('SELECT * FROM steps WHERE task_id = ?').all(newId);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].title, 'fill can');
  assert.equal(steps[0].done, 0, 'steps copied unchecked');
  const tags = db.prepare('SELECT tag_id FROM task_tags WHERE task_id = ?').all(newId);
  assert.deepEqual(tags.map(t => t.tag_id), ['g1']);
});
