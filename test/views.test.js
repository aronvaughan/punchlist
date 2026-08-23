import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskWhere, encodeCursor, escapeLike } from '../src/views.js';
import { open } from '../src/db.js';

const TODAY = '2026-03-10';

function seed() {
  const { db, migrate } = open(':memory:');
  migrate();
  const now = '2026-03-10T08:00:00.000Z';
  db.prepare(`INSERT INTO projects (id,name,rank,created_at,updated_at) VALUES ('p1','Home',1,?,?)`).run(now, now);
  db.prepare(`INSERT INTO tags (id,name) VALUES ('g1','urgent')`).run();
  const ins = db.prepare(
    `INSERT INTO tasks (id,title,notes,project_id,status,when_type,when_date,due_date,rank,today_rank,completed_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  //        id      title            notes      proj  status    wtype     wdate         due           rank today_rank completed
  ins.run('inb1', 'triage me',       '',        null, 'active', null,     null,         null,         1,   null, null, now, now);
  ins.run('inb2', 'note about 100%', 'a_b c',   null, 'active', null,     null,         null,         2,   null, null, now, now);
  ins.run('tod1', 'arrived when',    '',        'p1', 'active', 'date',   '2026-03-10', null,         1,   null, null, now, now);
  ins.run('tod2', 'manual first',    '',        null, 'active', 'date',   '2026-03-08', null,         2,   5,    null, now, now);
  ins.run('tod3', 'due today only',  '',        'p1', 'active', null,     null,         '2026-03-10', 3,   null, null, now, now);
  ins.run('smd1', 'someday but due', '',        'p1', 'active', 'someday', null,        '2026-03-09', 4,   null, null, now, now);
  ins.run('smd2', 'someday parked',  '',        'p1', 'active', 'someday', null,        null,         5,   null, null, now, now);
  ins.run('up1',  'future when',     '',        'p1', 'active', 'date',   '2026-03-15', null,         1,   null, null, now, now);
  ins.run('ovr1', 'was due yesterday','',       null, 'active', null,     null,         '2026-03-09', 6,   null, null, now, now);
  ins.run('done1','finished due today','',      null, 'done',   null,     null,         '2026-03-10', 7,   null, '2026-03-09T10:00:00.000Z', now, now);
  ins.run('done2','finished later',  '',        null, 'done',   null,     null,         null,         8,   null, '2026-03-10T10:00:00.000Z', now, now);
  db.prepare(`INSERT INTO task_tags (task_id,tag_id) VALUES ('tod1','g1')`).run();
  return db;
}

function run(db, view, params = {}) {
  const { sql, args } = taskWhere(view, { today: TODAY, limit: 100, ...params });
  return db.prepare(sql).all(...args);
}

test('today: actives with arrived when OR due<=today; done EXCLUDED from both disjuncts (C1)', () => {
  const ids = run(seed(), 'today').map(r => r.id);
  assert.deepEqual(new Set(ids), new Set(['tod1', 'tod2', 'tod3', 'smd1', 'ovr1']));
  assert.ok(!ids.includes('done1'), 'done task with due today must not appear');
});

test('today: someday task with arrived due appears (C13 deadline-chip case)', () => {
  const ids = run(seed(), 'today').map(r => r.id);
  assert.ok(ids.includes('smd1'));
  assert.ok(!ids.includes('smd2'), 'parked someday without due stays out');
});

test('today sort: manually placed (today_rank) first, arrivals append after (I11)', () => {
  const ids = run(seed(), 'today').map(r => r.id);
  assert.equal(ids[0], 'tod2', 'today_rank=5 beats all null-today_rank arrivals');
});

test('overdue: strictly before today, active only (C6)', () => {
  const ids = run(seed(), 'overdue').map(r => r.id);
  assert.deepEqual(new Set(ids), new Set(['smd1', 'ovr1']));
  assert.ok(!ids.includes('tod3'), 'due TODAY is not overdue');
});

test('inbox is derived: active AND no project AND no when (C5)', () => {
  const ids = run(seed(), 'inbox').map(r => r.id);
  assert.deepEqual(new Set(ids), new Set(['inb1', 'inb2', 'ovr1']));
});

test('upcoming: future when_date only', () => {
  const ids = run(seed(), 'upcoming').map(r => r.id);
  assert.deepEqual(ids, ['up1']);
});

test('logbook: done by completed_at desc', () => {
  const ids = run(seed(), 'logbook').map(r => r.id);
  assert.deepEqual(ids, ['done2', 'done1']);
});

test('project filter groups by section order TODAY→UPCOMING→ANYTIME→SOMEDAY; someday-with-due stays SOMEDAY (C13)', () => {
  const ids = run(seed(), null, { project: 'p1' }).map(r => r.id);
  assert.deepEqual(ids, ['tod1', 'up1', 'tod3', 'smd1', 'smd2']);
});

test('tag filter', () => {
  const ids = run(seed(), null, { tag: 'URGENT' }).map(r => r.id); // NOCASE
  assert.deepEqual(ids, ['tod1']);
});

test('search: LIKE special chars are escaped, quotes are safe (args-only)', () => {
  const db = seed();
  assert.equal(run(db, null, { q: '100%' }).map(r => r.id)[0], 'inb2');
  assert.equal(run(db, null, { q: 'a_b' }).length, 1, '_ must not act as wildcard');
  assert.equal(run(db, null, { q: 'aXb' }).length, 0);
  assert.equal(run(db, null, { q: `"quote' -- drop` }).length, 0); // no crash, no injection
  assert.equal(escapeLike('50%_\\'), '50\\%\\_\\\\');
});

test('pagination: keyset cursor walks the whole view without dupes or gaps', () => {
  const db = seed();
  const seen = [];
  let cursor;
  for (let i = 0; i < 10; i++) {
    const { sql, args, keys } = taskWhere('today', { today: TODAY, limit: 2, cursor });
    const rows = db.prepare(sql).all(...args);
    if (rows.length === 0) break;
    seen.push(...rows.map(r => r.id));
    cursor = encodeCursor(rows[rows.length - 1], keys);
  }
  assert.deepEqual(new Set(seen), new Set(['tod1', 'tod2', 'tod3', 'smd1', 'ovr1']));
  assert.equal(seen.length, 5, 'no duplicates across pages');
});

test('unknown view throws', () => {
  assert.throws(() => taskWhere('everything', { today: TODAY }));
});
