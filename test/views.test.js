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
  ins.run('inb1', 'triage me',       '',        null, 'active', null,     null,         null,         1,   null, 'alex',   null, now, now);
  ins.run('inb2', 'note about 100%', 'a_b c',   null, 'active', null,     null,         null,         2,   null, 'alex',   null, now, now);
  ins.run('tod1', 'arrived when',    '',        'p1', 'active', 'date',   '2026-03-10', null,         1,   null, 'alex',   null, now, now);
  ins.run('tod2', 'manual first',    '',        null, 'active', 'date',   '2026-03-08', null,         2,   5,    'alex',   null, now, now);
  ins.run('tod3', 'due today only',  '',        'p1', 'active', null,     null,         '2026-03-10', 3,   null, 'alex',   null, now, now);
  ins.run('smd1', 'someday but due', '',        'p1', 'active', 'someday', null,        '2026-03-09', 4,   null, 'alex',   null, now, now);
  ins.run('smd2', 'someday parked',  '',        'p1', 'active', 'someday', null,        null,         5,   null, 'alex',   null, now, now);
  ins.run('up1',  'future when',     '',        'p1', 'active', 'date',   '2026-03-15', null,         1,   null, 'alex',   null, now, now);
  ins.run('ovr1', 'was due yesterday','',       null, 'active', null,     null,         '2026-03-09', 6,   null, 'alex',   null, now, now);
  ins.run('done1','finished due today','',      null, 'done',   null,     null,         '2026-03-10', 7,   null, 'alex',   '2026-03-09T10:00:00.000Z', now, now);
  ins.run('done2','finished later',  '',        null, 'done',   null,     null,         null,         8,   null, 'alex',   '2026-03-10T10:00:00.000Z', now, now);
  // delegated (assignee != alex) — must stay OUT of alex's lanes
  ins.run('del1', 'agent when today','',        null, 'active', 'date',   '2026-03-10', '2026-03-12', 9,   null, 'claude', null, now, now);
  ins.run('del2', 'agent working',   '',        'p1', 'in_progress', null, null,        null,         9,   null, 'claude', null, now, '2026-03-10T09:00:00.000Z');
  ins.run('del3', 'awaiting review', '',        null, 'review', null,     null,         null,         10,  null, 'hermes', null, now, '2026-03-10T11:00:00.000Z');
  ins.run('del4', 'agent archived',  '',        null, 'archived', null,   null,         null,         11,  null, 'claude', null, now, now);
  ins.run('del5', 'agent queued',    '',        null, 'active', null,     null,         null,         12,  null, 'claude', null, now, now);
  ins.run('del6', 'agent due today', '',        null, 'active', null,     null,         '2026-03-10', 13,  null, 'claude', null, now, now);
  db.prepare(`INSERT INTO task_tags (task_id,tag_id) VALUES ('tod1','g1')`).run();
  return db;
}

function run(db, view, params = {}) {
  const { sql, args } = taskWhere(view, { today: TODAY, admin: 'alex', limit: 100, ...params });
  return db.prepare(sql).all(...args);
}

test('today: actives with arrived when OR due<=today; done EXCLUDED from both disjuncts (C1)', () => {
  const ids = run(seed(), 'today').map(r => r.id);
  assert.deepEqual(new Set(ids), new Set(['tod1', 'tod2', 'tod3', 'smd1', 'ovr1', 'del6']));
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

test('anytime: someday/no-when admin work off the daily plan, pure-inbox NOT duplicated', () => {
  const db = seed();
  const now = '2026-03-10T08:00:00.000Z';
  // the orphan (C-bug): active, admin, someday, no project, no due — vanished
  // from every lane before this view existed. MUST show in anytime.
  db.prepare(`INSERT INTO tasks (id,title,notes,project_id,status,when_type,when_date,due_date,rank,today_rank,assignee,completed_at,created_at,updated_at)
    VALUES ('orph','someday orphan','',NULL,'active','someday',NULL,NULL,20,NULL,'alex',NULL,?,?)`).run(now, now);
  const ids = run(db, 'anytime').map(r => r.id);
  assert.ok(ids.includes('orph'), 'the someday/no-project orphan MUST appear');
  assert.ok(ids.includes('smd1'), 'someday WITH a project appears');
  assert.ok(ids.includes('smd2'), 'parked someday appears');
  assert.ok(ids.includes('tod3'), 'no-when task that HAS a project appears');
  assert.ok(!ids.includes('up1'), 'a future scheduled (when-date) task does NOT appear');
  assert.ok(!ids.includes('inb1'), 'pure-inbox (no project, no when) is NOT duplicated');
  assert.ok(!ids.includes('inb2'), 'pure-inbox (no project, no when) is NOT duplicated');
  assert.ok(!ids.includes('ovr1'), 'pure-inbox with only a due date stays in Inbox, not anytime');
  assert.ok(!ids.includes('del5'), 'delegated (assignee != admin) stays out');
  assert.deepEqual(new Set(ids), new Set(['orph', 'smd1', 'smd2', 'tod3']));
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
    const { sql, args, keys } = taskWhere('today', { today: TODAY, admin: 'alex', limit: 2, cursor });
    const rows = db.prepare(sql).all(...args);
    if (rows.length === 0) break;
    seen.push(...rows.map(r => r.id));
    cursor = encodeCursor(rows[rows.length - 1], keys);
  }
  assert.deepEqual(new Set(seen), new Set(['tod1', 'tod2', 'tod3', 'smd1', 'ovr1', 'del6']));
  assert.equal(seen.length, 6, 'no duplicates across pages');
});

test('unknown view throws', () => {
  assert.throws(() => taskWhere('everything', { today: TODAY }));
});

// ---- delegation ----
test('due-dates override assignee scoping; when-dates do not (2026-08-24 amendment)', () => {
  const db = seed();
  const today = run(db, 'today').map(r => r.id);
  assert.ok(today.includes('del6'), 'delegated task DUE today appears in Today');
  assert.ok(!today.includes('del1'), 'delegated arrived-WHEN (future due) stays out of Today');
  assert.ok(run(db, 'due_soon', { soon: '2026-03-20' }).map(r => r.id).includes('del1'),
    'delegated future due appears in due_soon (unscoped)');
  // overdue stays UNSCOPED (agent contract C6): a delegated overdue shows
  db.prepare(`UPDATE tasks SET due_date='2026-03-01' WHERE id='del5'`).run();
  assert.ok(run(db, 'overdue').map(r => r.id).includes('del5'));
});

test("alex's when-driven lanes exclude delegated work: inbox/upcoming are assignee='alex'", () => {
  const db = seed();
  assert.ok(!run(db, 'inbox').map(r => r.id).includes('del5'), 'delegated projectless task stays out of Inbox');
  db.prepare(`UPDATE tasks SET when_date='2026-03-18' WHERE id='del1'`).run();
  assert.ok(!run(db, 'upcoming').map(r => r.id).includes('del1'), 'delegated future when stays out of Upcoming');
});

test('review view: status=review only, freshest finish first', () => {
  const db = seed();
  db.prepare(`UPDATE tasks SET status='review', assignee='claude', updated_at='2026-03-10T12:00:00.000Z' WHERE id='del5'`).run();
  const ids = run(db, 'review').map(r => r.id);
  assert.deepEqual(ids, ['del5', 'del3']);
});

test('delegated view: open work off alex\'s plate, grouped by agent then in_progress→review→active', () => {
  const ids = run(seed(), 'delegated').map(r => r.id);
  assert.deepEqual(ids, ['del2', 'del1', 'del5', 'del6', 'del3']); // claude (working, queued...), then hermes
  assert.ok(!ids.includes('del4'), 'archived delegated task is not in flight');
  assert.ok(!ids.includes('tod1'), "alex's own tasks are not delegated");
});

test('?assignee= filter composes with views', () => {
  const db = seed();
  assert.deepEqual(new Set(run(db, null, { assignee: 'claude' }).map(r => r.id)),
    new Set(['del1', 'del2', 'del5', 'del6']));
  assert.deepEqual(run(db, null, { assignee: 'claude', project: 'p1' }).map(r => r.id), ['del2']);
  assert.deepEqual(run(db, 'delegated', { assignee: 'hermes' }).map(r => r.id), ['del3']);
  assert.deepEqual(run(db, 'logbook', { assignee: 'hermes' }), []);
});

test('admin is a parameter, not a literal: lanes follow whoever :admin names', () => {
  const db = seed();
  // as admin=claude, the alex rows become "delegated" and claude's lanes are his
  const inbox = run(db, 'inbox', { admin: 'claude' }).map(r => r.id);
  assert.ok(inbox.includes('del5'), "claude's projectless no-when task is HIS inbox");
  assert.ok(!inbox.includes('inb1'), "alex's tasks stay out of claude's inbox");
  const delegated = run(db, 'delegated', { admin: 'claude' }).map(r => r.id);
  assert.ok(delegated.includes('tod1') && !delegated.includes('del5'));
  // no 'alex' literal survives in the generated SQL — admin travels as an arg
  const { sql, args } = taskWhere('delegated', { today: TODAY, admin: 'pat' });
  assert.ok(!sql.includes('alex') && args.includes('pat'));
  const c = taskCount('inbox', { today: TODAY, admin: 'claude' });
  assert.equal(db.prepare(c.sql).get(...c.args).c, 2); // del5, del6
});

// ---- needs-input ----
test('needs_input view: blocked only, oldest wait first; queue and admin lanes exclude blocked', () => {
  const db = seed();
  db.prepare(`UPDATE tasks SET status='blocked', question='which key?', updated_at='2026-03-10T11:00:00.000Z' WHERE id='del5'`).run();
  db.prepare(`UPDATE tasks SET status='blocked', question='what budget?', updated_at='2026-03-10T09:00:00.000Z' WHERE id='del6'`).run();
  assert.deepEqual(run(db, 'needs_input').map(r => r.id), ['del6', 'del5'], 'longest-waiting question first');
  // queue is status-scoped: a blocked task leaves the agent's queue
  assert.deepEqual(run(db, 'queue', { assignee: 'claude' }).map(r => r.id), ['del2', 'del1']);
  // blocked stays OFF the admin's day even when due (it is waiting on the admin in ITS lane)
  assert.ok(!run(db, 'today').map(r => r.id).includes('del6'));
});

test('delegated/project views include blocked; Agents ordering is in_progress → blocked → review → queued', () => {
  const db = seed();
  db.prepare(`UPDATE tasks SET status='blocked', question='q?' WHERE id='del5'`).run();
  const ids = run(db, 'delegated').map(r => r.id);
  assert.deepEqual(ids, ['del2', 'del5', 'del1', 'del6', 'del3'],
    'claude: working, blocked, queued; then hermes review');
  db.prepare(`UPDATE tasks SET status='blocked', question='q?' WHERE id='del2'`).run();
  assert.ok(run(db, null, { project: 'p1' }).map(r => r.id).includes('del2'),
    'project view keeps blocked tasks on the board');
});

test('taskCount covers needs_input', () => {
  const db = seed();
  const c = () => {
    const { sql, args } = taskCount('needs_input', { today: TODAY, admin: 'alex' });
    return db.prepare(sql).get(...args).c;
  };
  assert.equal(c(), 0);
  db.prepare(`UPDATE tasks SET status='blocked', question='q?' WHERE id IN ('del5','del6')`).run();
  assert.equal(c(), 2);
});

// ---- agent security (layer 1) ----
test('queue view: active+in_progress, vetted only — the server-side agent-queue contract', () => {
  const db = seed();
  db.prepare(`UPDATE tasks SET vetted=0 WHERE id='del5'`).run();
  const ids = run(db, 'queue', { assignee: 'claude' }).map(r => r.id);
  assert.deepEqual(ids, ['del2', 'del1', 'del6'], 'in_progress first; unvetted del5 excluded');
  // review/archived rows are never queue material either
  assert.deepEqual(run(db, 'queue', { assignee: 'hermes' }), []);
  // the same rows still show in delegated (visibility is not filtered)
  assert.ok(run(db, 'delegated').map(r => r.id).includes('del5'));
});

test('unvetted view: open agent-assigned vetted=0 rows; taskCount agrees', () => {
  const db = seed();
  db.prepare(`UPDATE tasks SET vetted=0 WHERE id IN ('del5', 'inb1')`).run(); // inb1 is alex's
  const ids = run(db, 'unvetted').map(r => r.id);
  assert.deepEqual(ids, ['del5'], "only agent-assigned quarantine counts; alex's own row does not");
  const { sql, args } = taskCount('unvetted', { today: TODAY, admin: 'alex' });
  assert.equal(db.prepare(sql).get(...args).c, 1);
});

// ---- shared agent backlog + Human lane (view_ranks, migration 008) ----
test('agents view: same open set as delegated, but ONE global order by view_ranks(agents)', () => {
  const db = seed();
  // default (no view_ranks): global order by AGENT_STATUS (in_progress→blocked→
  // review→queued) then rank, across ALL agents (not grouped by assignee)
  assert.deepEqual(run(db, 'agents').map(r => r.id), ['del2', 'del3', 'del1', 'del5', 'del6']);
  // give del6 (a claude queued task) a low agents rank -> it jumps to the top
  db.prepare("INSERT INTO view_ranks (task_id, view, rank) VALUES ('del6','agents',1)").run();
  assert.equal(run(db, 'agents').map(r => r.id)[0], 'del6', 'hand-ranked task leads the global backlog');
  // archived del4 is still excluded (not open)
  assert.ok(!run(db, 'agents').map(r => r.id).includes('del4'));
});

test('queue follows view_ranks(agents) nulls-last, still assignee-scoped & vetted-only', () => {
  const db = seed();
  // baseline claude queue: in_progress first, then queued by rank
  assert.deepEqual(run(db, 'queue', { assignee: 'claude' }).map(r => r.id), ['del2', 'del1', 'del5', 'del6']);
  // hand-rank del6 to the top of the shared backlog -> claude claims it first
  db.prepare("INSERT INTO view_ranks (task_id, view, rank) VALUES ('del6','agents',1)").run();
  assert.deepEqual(run(db, 'queue', { assignee: 'claude' }).map(r => r.id), ['del6', 'del2', 'del1', 'del5']);
  // hermes still only ever sees its own tasks
  assert.deepEqual(run(db, 'queue', { assignee: 'hermes' }), []);
});

test('human view: blocked-only, view_ranks(human) first then oldest-wait', () => {
  const db = seed();
  db.prepare(`UPDATE tasks SET status='blocked', updated_at='2026-03-10T11:00:00.000Z' WHERE id='del5'`).run();
  db.prepare(`UPDATE tasks SET status='blocked', updated_at='2026-03-10T09:00:00.000Z' WHERE id='del6'`).run();
  // no ranks: oldest wait first (same as needs_input)
  assert.deepEqual(run(db, 'human').map(r => r.id), ['del6', 'del5']);
  // hand-order del5 to the top
  db.prepare("INSERT INTO view_ranks (task_id, view, rank) VALUES ('del5','human',1)").run();
  assert.deepEqual(run(db, 'human').map(r => r.id), ['del5', 'del6']);
});

test('taskCount covers review and delegated', () => {
  const db = seed();
  const c = view => {
    const { sql, args } = taskCount(view, { today: TODAY, soon: '2026-04-09', admin: 'alex' });
    return db.prepare(sql).get(...args).c;
  };
  assert.equal(c('review'), 1);
  assert.equal(c('delegated'), 5);
  assert.equal(c('today'), 6, 'when-scoped to alex but due-driven del6 counts; when-only del1 does not');
  assert.equal(c('due_soon'), 1, 'delegated future due (del1) counts');
  assert.equal(c('inbox'), 3, 'alex-scoped: del5 not counted'); // inb1 inb2 ovr1
});
