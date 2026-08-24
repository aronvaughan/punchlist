import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskWhere, taskCount, encodeCursor, escapeLike } from '../src/views.js';
import { open } from '../src/db.js';

const TODAY = '2026-03-10';

function seed() {
  const { db, migrate } = open(':memory:');
  migrate();
  const now = '2026-03-10T08:00:00.000Z';
  db.prepare(`INSERT INTO projects (id,name,rank,created_at,updated_at) VALUES ('p1','Home',1,?,?)`).run(now, now);
  db.prepare(`INSERT INTO tags (id,name) VALUES ('g1','urgent')`).run();
  const ins = db.prepare(
    `INSERT INTO tasks (id,title,notes,project_id,status,when_type,when_date,due_date,rank,today_rank,assignee,completed_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  //        id      title            notes      proj  status    wtype     wdate         due           rank today_rank assignee  completed
  ins.run('inb1', 'triage me',       '',        null, 'active', null,     null,         null,         1,   null, 'aron',   null, now, now);
  ins.run('inb2', 'note about 100%', 'a_b c',   null, 'active', null,     null,         null,         2,   null, 'aron',   null, now, now);
  ins.run('tod1', 'arrived when',    '',        'p1', 'active', 'date',   '2026-03-10', null,         1,   null, 'aron',   null, now, now);
  ins.run('tod2', 'manual first',    '',        null, 'active', 'date',   '2026-03-08', null,         2,   5,    'aron',   null, now, now);
  ins.run('tod3', 'due today only',  '',        'p1', 'active', null,     null,         '2026-03-10', 3,   null, 'aron',   null, now, now);
  ins.run('smd1', 'someday but due', '',        'p1', 'active', 'someday', null,        '2026-03-09', 4,   null, 'aron',   null, now, now);
  ins.run('smd2', 'someday parked',  '',        'p1', 'active', 'someday', null,        null,         5,   null, 'aron',   null, now, now);
  ins.run('up1',  'future when',     '',        'p1', 'active', 'date',   '2026-03-15', null,         1,   null, 'aron',   null, now, now);
  ins.run('ovr1', 'was due yesterday','',       null, 'active', null,     null,         '2026-03-09', 6,   null, 'aron',   null, now, now);
  ins.run('done1','finished due today','',      null, 'done',   null,     null,         '2026-03-10', 7,   null, 'aron',   '2026-03-09T10:00:00.000Z', now, now);
  ins.run('done2','finished later',  '',        null, 'done',   null,     null,         null,         8,   null, 'aron',   '2026-03-10T10:00:00.000Z', now, now);
  // delegated (assignee != aron) — must stay OUT of aron's lanes
  ins.run('del1', 'agent due today', '',        null, 'active', 'date',   '2026-03-10', '2026-03-12', 9,   null, 'claude', null, now, now);
  ins.run('del2', 'agent working',   '',        'p1', 'in_progress', null, null,        null,         9,   null, 'claude', null, now, '2026-03-10T09:00:00.000Z');
  ins.run('del3', 'awaiting review', '',        null, 'review', null,     null,         null,         10,  null, 'hermes', null, now, '2026-03-10T11:00:00.000Z');
  ins.run('del4', 'agent archived',  '',        null, 'archived', null,   null,         null,         11,  null, 'claude', null, now, now);
  ins.run('del5', 'agent queued',    '',        null, 'active', null,     null,         null,         12,  null, 'claude', null, now, now);
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
  // project views show ALL open tasks — the delegated in_progress one included
  assert.deepEqual(ids, ['tod1', 'up1', 'tod3', 'del2', 'smd1', 'smd2']);
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

// ---- delegation ----
test("aron's lanes exclude delegated work: today/inbox/upcoming/due_soon are assignee='aron'", () => {
  const db = seed();
  assert.ok(!run(db, 'today').map(r => r.id).includes('del1'), 'delegated arrived-when stays out of Today');
  assert.ok(!run(db, 'inbox').map(r => r.id).includes('del5'), 'delegated projectless task stays out of Inbox');
  assert.ok(!run(db, 'due_soon', { soon: '2026-03-20' }).map(r => r.id).includes('del1'));
  // overdue stays UNSCOPED (agent contract C6): a delegated overdue would show
  db.prepare(`UPDATE tasks SET due_date='2026-03-01' WHERE id='del5'`).run();
  assert.ok(run(db, 'overdue').map(r => r.id).includes('del5'));
});

test('review view: status=review only, freshest finish first', () => {
  const db = seed();
  db.prepare(`UPDATE tasks SET status='review', assignee='claude', updated_at='2026-03-10T12:00:00.000Z' WHERE id='del5'`).run();
  const ids = run(db, 'review').map(r => r.id);
  assert.deepEqual(ids, ['del5', 'del3']);
});

test('delegated view: open work off aron\'s plate, grouped by agent then in_progress→review→active', () => {
  const ids = run(seed(), 'delegated').map(r => r.id);
  assert.deepEqual(ids, ['del2', 'del1', 'del5', 'del3']); // claude (working, queued...), then hermes
  assert.ok(!ids.includes('del4'), 'archived delegated task is not in flight');
  assert.ok(!ids.includes('tod1'), "aron's own tasks are not delegated");
});

test('?assignee= filter composes with views', () => {
  const db = seed();
  assert.deepEqual(new Set(run(db, null, { assignee: 'claude' }).map(r => r.id)),
    new Set(['del1', 'del2', 'del5']));
  assert.deepEqual(run(db, null, { assignee: 'claude', project: 'p1' }).map(r => r.id), ['del2']);
  assert.deepEqual(run(db, 'delegated', { assignee: 'hermes' }).map(r => r.id), ['del3']);
  assert.deepEqual(run(db, 'logbook', { assignee: 'hermes' }), []);
});

test('taskCount covers review and delegated', () => {
  const db = seed();
  const c = view => {
    const { sql, args } = taskCount(view, { today: TODAY, soon: '2026-04-09' });
    return db.prepare(sql).get(...args).c;
  };
  assert.equal(c('review'), 1);
  assert.equal(c('delegated'), 4);
  assert.equal(c('today'), 5, 'aron-scoped: del1 not counted');
  assert.equal(c('inbox'), 3, 'aron-scoped: del5 not counted'); // inb1 inb2 ovr1
});
