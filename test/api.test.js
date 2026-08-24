import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/db.js';
import { buildApp } from '../src/api.js';
import { parseTokens, envPermWarning, resolveAdmin, parseUntrusted } from '../src/server.js';

const TOK_ARON = 'a'.repeat(32);
const TOK_CLAUDE = 'c'.repeat(32);
const TOK_HERMES = 'h'.repeat(32);
const TOK_EMAIL = 'e'.repeat(32);
const TODAY = '2026-03-10';

function makeApp() {
  const { db, migrate } = open(':memory:');
  migrate();
  const app = buildApp({
    db, tokens: { aron: TOK_ARON, claude: TOK_CLAUDE, hermes: TOK_HERMES, email: TOK_EMAIL },
    today: () => TODAY });
  const call = async (method, path, { body, token = TOK_ARON } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await app.fetch(new Request(`http://x${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }));
    let json = null;
    try { json = await res.json(); } catch { /* static */ }
    return { status: res.status, json, headers: res.headers };
  };
  return { db, app, call };
}

// ---- auth ----
test('auth: 401 without/with bad token; health is open', async () => {
  const { call } = makeApp();
  assert.equal((await call('GET', '/api/v1/tasks', { token: null })).status, 401);
  assert.equal((await call('GET', '/api/v1/tasks', { token: 'x'.repeat(32) })).status, 401);
  const h = await call('GET', '/api/v1/health', { token: null });
  assert.equal(h.status, 200);
  assert.equal(h.json.ok, true);
  assert.match(h.json.version, /^\d+\.\d+\.\d+$/); // rail footer reads this
});

test('per-token created_by is server-set; client-supplied created_by rejected', async () => {
  const { call } = makeApp();
  const a = await call('POST', '/api/v1/tasks', { body: { title: 'from aron' } });
  assert.equal(a.status, 201);
  assert.equal(a.json.created_by, 'aron');
  const c = await call('POST', '/api/v1/tasks', { body: { title: 'from claude' }, token: TOK_CLAUDE });
  assert.equal(c.json.created_by, 'claude');
  const bad = await call('POST', '/api/v1/tasks', { body: { title: 'spoof', created_by: 'hermes' } });
  assert.equal(bad.status, 400);
});

test('fail-closed token parsing', () => {
  assert.throws(() => parseTokens(''), /refusing to start/);
  assert.throws(() => parseTokens('aron:short'), /32/);
  assert.throws(() => parseTokens('nocolon'), /malformed/);
  assert.deepEqual(parseTokens(`aron:${TOK_ARON}, claude:${TOK_CLAUDE}`),
    { aron: TOK_ARON, claude: TOK_CLAUDE });
});

test('data/.env permission check: warn on group/other-readable, silent on 600', () => {
  assert.equal(envPermWarning(0o100600), null);
  assert.equal(envPermWarning(0o100700), null);
  assert.match(envPermWarning(0o100644), /chmod 600/);
  assert.match(envPermWarning(0o100640), /group\/other/);
});

test('resolveAdmin: defaults to the FIRST actor; explicit must have a token (fail closed)', () => {
  const tokens = { pat: 'p'.repeat(32), claude: TOK_CLAUDE };
  assert.equal(resolveAdmin(tokens, undefined), 'pat');
  assert.equal(resolveAdmin(tokens, ''), 'pat');
  assert.equal(resolveAdmin(tokens, '  claude  '), 'claude');
  assert.throws(() => resolveAdmin(tokens, 'aron'), /AV_TASKS_ADMIN.*no token/);
});

test('admin parameterization: approve gate, lanes, and default assignee follow the admin actor', async () => {
  const { db, migrate } = open(':memory:');
  migrate();
  const TOK_PAT = 'p'.repeat(32);
  // actor order deliberately puts the agent first: admin is EXPLICIT here
  const app = buildApp({
    db, tokens: { claude: TOK_CLAUDE, pat: TOK_PAT }, admin: 'pat', today: () => TODAY });
  const call = async (method, path, { body, token = TOK_PAT } = {}) => {
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await app.fetch(new Request(`http://x${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: res.status, json: await res.json() };
  };
  // default assignee is the admin, not 'aron'
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'mine' } })).json;
  assert.equal(t.assignee, 'pat');
  // pat's projectless no-when task is in PAT's inbox
  const inbox = (await call('GET', '/api/v1/tasks?view=inbox')).json.items.map(x => x.id);
  assert.ok(inbox.includes(t.id));
  // delegate to claude: leaves inbox, enters delegated; only pat can approve
  const d = (await call('POST', '/api/v1/tasks', { body: { title: 'for claude', assignee: 'claude' } })).json;
  assert.ok(!(await call('GET', '/api/v1/tasks?view=inbox')).json.items.some(x => x.id === d.id));
  assert.ok((await call('GET', '/api/v1/tasks?view=delegated')).json.items.some(x => x.id === d.id));
  await call('POST', `/api/v1/tasks/${d.id}/claim`, { token: TOK_CLAUDE });
  await call('POST', `/api/v1/tasks/${d.id}/finish`, { token: TOK_CLAUDE, body: { report: 'did it' } });
  const denied = await call('POST', `/api/v1/tasks/${d.id}/approve`, { token: TOK_CLAUDE });
  assert.equal(denied.status, 403);
  assert.match(denied.json.error, /admin \(pat\)/);
  assert.equal((await call('POST', `/api/v1/tasks/${d.id}/approve`)).status, 200);
  // counts run through taskCount(admin) without error
  const counts = (await call('GET', '/api/v1/counts')).json;
  assert.equal(counts.delegated, 0);
});

test('buildApp without an explicit admin falls back to the first token actor; unknown admin throws', () => {
  const { db, migrate } = open(':memory:');
  migrate();
  assert.throws(() => buildApp({ db, tokens: { claude: TOK_CLAUDE }, admin: 'ghost' }), /no token/);
  // first-actor default: aron-first tokens behave exactly as before
  buildApp({ db, tokens: { aron: TOK_ARON, claude: TOK_CLAUDE } });
});

// ---- tasks CRUD ----
test('POST /tasks: full create with tags/steps; defaults; validation', async () => {
  const { call } = makeApp();
  const p = await call('POST', '/api/v1/projects', { body: { name: 'Home' } });
  const r = await call('POST', '/api/v1/tasks', {
    body: { title: 'big task', notes: 'n', project_id: p.json.id, when_type: 'date', when_date: '2026-03-12',
            due_date: '2026-03-15', tags: ['a', 'b'], steps: ['one', 'two'] } });
  assert.equal(r.status, 201);
  assert.equal(r.json.status, 'active');
  assert.deepEqual(r.json.tags, ['a', 'b']);
  assert.deepEqual(r.json.steps.map(s => s.title), ['one', 'two']);
  assert.equal((await call('POST', '/api/v1/tasks', { body: { title: '' } })).status, 400);
  assert.equal((await call('POST', '/api/v1/tasks', { body: { title: 'x', nope: 1 } })).status, 400, 'unknown field');
  assert.equal((await call('POST', '/api/v1/tasks', { body: { title: 'x', project_id: 'ghost' } })).status, 400);
  assert.equal((await call('POST', '/api/v1/tasks', { body: { title: 'x', when_type: 'date' } })).status, 400);
  assert.equal((await call('POST', '/api/v1/tasks', { body: { title: 'x', due_date: 'tuesday' } })).status, 400);
});

test('size caps: title 500, notes 64KB, steps 100, tags 20', async () => {
  const { call } = makeApp();
  assert.equal((await call('POST', '/api/v1/tasks', { body: { title: 'x'.repeat(501) } })).status, 400);
  assert.equal((await call('POST', '/api/v1/tasks', { body: { title: 'x', notes: 'n'.repeat(65537) } })).status, 400);
  assert.equal((await call('POST', '/api/v1/tasks', { body: { title: 'x', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) } })).status, 400);
  assert.equal((await call('POST', '/api/v1/tasks', { body: { title: 'x', steps: Array.from({ length: 101 }, (_, i) => `s${i}`) } })).status, 400);
  assert.equal((await call('POST', '/api/v1/tasks', { body: { title: 'x'.repeat(500), notes: 'n'.repeat(65536) } })).status, 201);
});

test('request bodies over 256KB are rejected 413 before JSON parsing', async () => {
  const { call } = makeApp();
  const big = await call('POST', '/api/v1/tasks', { body: { title: 'x', notes: 'n'.repeat(262144) } });
  assert.equal(big.status, 413);
  assert.match(big.json.error, /exceeds/);
  // oversized garbage (not even JSON) is also a 413, not a 400 from the parser
  const { app } = makeApp();
  const res = await app.fetch(new Request('http://x/api/v1/tasks', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOK_ARON}`, 'Content-Type': 'application/json' },
    body: '{'.repeat(300000),
  }));
  assert.equal(res.status, 413);
});

test('recur on POST requires/defaults due (C4) and validates the rule', async () => {
  const { call } = makeApp();
  const r = await call('POST', '/api/v1/tasks', { body: { title: 'water', recur: { freq: 'daily', anchor: 'due' } } });
  assert.equal(r.status, 201);
  assert.equal(r.json.due_date, TODAY);
  assert.equal((await call('POST', '/api/v1/tasks', { body: { title: 'x', recur: { freq: 'hourly', anchor: 'due' } } })).status, 400);
});

test('GET /tasks: views work over HTTP, unknown view 400, project/tag/q filters', async () => {
  const { call } = makeApp();
  await call('POST', '/api/v1/tasks', { body: { title: 'inbox item' } });
  await call('POST', '/api/v1/tasks', { body: { title: 'today item', when_type: 'date', when_date: TODAY, tags: ['now'] } });
  const inbox = await call('GET', '/api/v1/tasks?view=inbox');
  assert.deepEqual(inbox.json.items.map(t => t.title), ['inbox item']);
  const today = await call('GET', '/api/v1/tasks?view=today');
  assert.deepEqual(today.json.items.map(t => t.title), ['today item']);
  const tagged = await call('GET', '/api/v1/tasks?tag=now');
  assert.equal(tagged.json.items.length, 1);
  const q = await call('GET', '/api/v1/tasks?q=inbox');
  assert.deepEqual(q.json.items.map(t => t.title), ['inbox item']);
  assert.equal((await call('GET', '/api/v1/tasks?view=bogus')).status, 400);
  assert.equal((await call('GET', '/api/v1/tasks?cursor=!!!')).status, 400);
});

test('pagination over HTTP: limit + next_cursor, no dupes', async () => {
  const { call } = makeApp();
  for (let i = 0; i < 5; i++) await call('POST', '/api/v1/tasks', { body: { title: `t${i}` } });
  const seen = [];
  let cursor, pages = 0;
  do {
    const url = `/api/v1/tasks?view=inbox&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
    const r = await call('GET', url);
    assert.equal(r.status, 200);
    seen.push(...r.json.items.map(t => t.title));
    cursor = r.json.next_cursor;
    pages++;
  } while (cursor && pages < 10);
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5);
  assert.equal(pages, 3);
});

test('pagination at the documented max limit=500 still emits next_cursor', async () => {
  const { call, db } = makeApp();
  const ins = db.prepare(
    `INSERT INTO tasks (id, title, status, rank, created_at, updated_at) VALUES (?, ?, 'active', ?, 't', 't')`);
  for (let i = 0; i < 501; i++) ins.run(String(i).padStart(26, '0'), `t${i}`, (i + 1) * 1024);
  const first = await call('GET', '/api/v1/tasks?view=inbox&limit=500');
  assert.equal(first.status, 200);
  assert.equal(first.json.items.length, 500);
  assert.ok(first.json.next_cursor, 'boundary page must expose the tail');
  const rest = await call('GET', `/api/v1/tasks?view=inbox&limit=500&cursor=${first.json.next_cursor}`);
  assert.equal(rest.json.items.length, 1);
  assert.equal(rest.json.next_cursor, undefined);
  const seen = new Set([...first.json.items, ...rest.json.items].map(t => t.id));
  assert.equal(seen.size, 501, 'no dupes, no gaps');
});

test('PATCH: sparse updates; unknown field 400; status done -> 400 use /complete', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'edit me' } })).json;
  const r = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { title: 'edited', when_type: 'someday' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.title, 'edited');
  assert.equal(r.json.when_type, 'someday');
  assert.equal((await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { bogus: 1 } })).status, 400);
  const done = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { status: 'done' } });
  assert.equal(done.status, 400);
  assert.match(done.json.error, /complete/);
  assert.equal((await call('PATCH', '/api/v1/tasks/ZZZ', { body: { title: 'x' } })).status, 404);
  // archive ends a recurring series (documented) — allowed via PATCH
  const rec = (await call('POST', '/api/v1/tasks', { body: { title: 'rec', recur: { freq: 'daily', anchor: 'due' } } })).json;
  assert.equal((await call('PATCH', `/api/v1/tasks/${rec.id}`, { body: { status: 'archived' } })).status, 200);
  // tags replace
  const tag = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { tags: ['x'] } });
  assert.deepEqual(tag.json.tags, ['x']);
});

// ---- complete + recurrence ----
test('complete: idempotent; recurring completed twice -> exactly ONE spawn', async () => {
  const { call, db } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', {
    body: { title: 'water plants', due_date: TODAY, recur: { freq: 'every', n: 3, anchor: 'due' }, steps: ['fill'] } })).json;
  const first = await call('POST', `/api/v1/tasks/${t.id}/complete`);
  assert.equal(first.status, 200);
  assert.equal(first.json.task.status, 'done');
  assert.ok(first.json.spawned_id, 'first completion spawns');
  const second = await call('POST', `/api/v1/tasks/${t.id}/complete`);
  assert.equal(second.status, 200, 'repeat completion is 200');
  assert.equal(second.json.spawned_id, undefined, 'no second spawn');
  const spawns = db.prepare('SELECT * FROM tasks WHERE spawned_from = ?').all(t.id);
  assert.equal(spawns.length, 1, 'exactly one spawn');
  assert.equal(spawns[0].when_date, '2026-03-13');
  assert.equal(spawns[0].due_date, '2026-03-13');
  const steps = db.prepare('SELECT done FROM steps WHERE task_id = ?').all(spawns[0].id);
  assert.deepEqual(steps.map(s => s.done), [0]);
  assert.equal((await call('POST', '/api/v1/tasks/NOPE/complete')).status, 404);
});

test('complete: non-recurring just goes done; undo via PATCH active does not retract spawn (M18)', async () => {
  const { call, db } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', {
    body: { title: 'rec', due_date: TODAY, recur: { freq: 'daily', anchor: 'due' } } })).json;
  await call('POST', `/api/v1/tasks/${t.id}/complete`);
  const undo = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { status: 'active' } });
  assert.equal(undo.status, 200);
  assert.equal(undo.json.completed_at, null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tasks WHERE spawned_from = ?').get(t.id).c, 1, 'spawn stays');
});

// ---- reorder ----
test('reorder by neighbors within a project section; renormalizes; stale neighbor -> 409 + current list', async () => {
  const { call } = makeApp();
  const p = (await call('POST', '/api/v1/projects', { body: { name: 'P' } })).json;
  const mk = async n => (await call('POST', '/api/v1/tasks', { body: { title: n, project_id: p.id } })).json;
  const a = await mk('a'), b = await mk('b'), c = await mk('c');
  // move c between a and b
  const r = await call('POST', `/api/v1/tasks/${c.id}/reorder`, { body: { after_id: a.id, before_id: b.id } });
  assert.equal(r.status, 200);
  const list = await call('GET', `/api/v1/tasks?project=${p.id}`);
  assert.deepEqual(list.json.items.map(t => t.title), ['a', 'c', 'b']);
  // neighbor moved out of scope (completed) -> 409 with current list
  await call('POST', `/api/v1/tasks/${a.id}/complete`);
  const stale = await call('POST', `/api/v1/tasks/${c.id}/reorder`, { body: { after_id: a.id } });
  assert.equal(stale.status, 409);
  assert.ok(Array.isArray(stale.json.current));
  assert.deepEqual(stale.json.current.map(t => t.title).sort(), ['b', 'c']);
  // neighbor in a DIFFERENT section -> 409
  const s = (await call('POST', '/api/v1/tasks', { body: { title: 'someday', project_id: p.id, when_type: 'someday' } })).json;
  assert.equal((await call('POST', `/api/v1/tasks/${c.id}/reorder`, { body: { after_id: s.id } })).status, 409);
  assert.equal((await call('POST', `/api/v1/tasks/${c.id}/reorder`, { body: {} })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/NOPE/reorder`, { body: { after_id: b.id } })).status, 404);
});

test('reorder with a single neighbor lands directly adjacent, not on the next row (evenly spaced ranks)', async () => {
  const { call } = makeApp();
  const p = (await call('POST', '/api/v1/projects', { body: { name: 'P' } })).json;
  const mk = async n => (await call('POST', '/api/v1/tasks', { body: { title: n, project_id: p.id } })).json;
  const a = await mk('a'); const b = await mk('b'); const c = await mk('c'); const d = await mk('d');
  // ranks are evenly spaced (1024/2048/3072/4096): after_id-only used to
  // compute a.rank + 1024 = b.rank, colliding with b and losing the position
  const r = await call('POST', `/api/v1/tasks/${d.id}/reorder`, { body: { after_id: a.id } });
  assert.equal(r.status, 200);
  let list = await call('GET', `/api/v1/tasks?project=${p.id}`);
  assert.deepEqual(list.json.items.map(t => t.title), ['a', 'd', 'b', 'c']);
  // symmetric before_id-only case
  assert.equal((await call('POST', `/api/v1/tasks/${a.id}/reorder`, { body: { before_id: c.id } })).status, 200);
  list = await call('GET', `/api/v1/tasks?project=${p.id}`);
  assert.deepEqual(list.json.items.map(t => t.title), ['d', 'b', 'a', 'c']);
  // single neighbor at the list ends still works (move to very end / very start)
  assert.equal((await call('POST', `/api/v1/tasks/${d.id}/reorder`, { body: { after_id: c.id } })).status, 200);
  assert.equal((await call('POST', `/api/v1/tasks/${b.id}/reorder`, { body: { before_id: a.id } })).status, 200);
  list = await call('GET', `/api/v1/tasks?project=${p.id}`);
  assert.deepEqual(list.json.items.map(t => t.title), ['b', 'a', 'c', 'd']);
});

test('reorder in Today sets today_rank, not rank (C3); manual placement holds', async () => {
  const { call } = makeApp();
  const mk = async (n, extra) => (await call('POST', '/api/v1/tasks', { body: { title: n, ...extra } })).json;
  const x = await mk('x', { when_type: 'date', when_date: TODAY });
  const y = await mk('y', { when_type: 'date', when_date: TODAY });
  const z = await mk('z', { due_date: TODAY });
  const r = await call('POST', `/api/v1/tasks/${z.id}/reorder`, { body: { before_id: x.id, list: 'today' } });
  assert.equal(r.status, 200);
  assert.notEqual(r.json.task.today_rank, null);
  assert.equal(r.json.task.rank, z.rank, 'project rank untouched');
  const t = await call('GET', '/api/v1/tasks?view=today');
  assert.deepEqual(t.json.items.map(i => i.title), ['z', 'x', 'y']);
});

test('PATCH re-ranks a task moved to a new project/section: lands at end of target section', async () => {
  const { call, db } = makeApp();
  const p = (await call('POST', '/api/v1/projects', { body: { name: 'P' } })).json;
  const rankOf = id => db.prepare('SELECT rank FROM tasks WHERE id = ?').get(id).rank;
  const a = (await call('POST', '/api/v1/tasks', { body: { title: 'a' } })).json; // inbox, rank 1024
  const b = (await call('POST', '/api/v1/tasks', { body: { title: 'b', project_id: p.id } })).json; // P ANYTIME, 1024
  const mv = await call('PATCH', `/api/v1/tasks/${a.id}`, { body: { project_id: p.id } });
  assert.equal(mv.status, 200);
  assert.ok(rankOf(a.id) > rankOf(b.id), 'moved task appends after existing section members');
  const list = await call('GET', `/api/v1/tasks?project=${p.id}`);
  assert.deepEqual(list.json.items.map(x => x.title), ['b', 'a']);
  // section change within the same project also re-ranks to end of new section
  const c = (await call('POST', '/api/v1/tasks', { body: { title: 'c', project_id: p.id, when_type: 'someday' } })).json;
  await call('PATCH', `/api/v1/tasks/${b.id}`, { body: { when_type: 'someday' } });
  assert.ok(rankOf(b.id) > rankOf(c.id), 'b appends after c in SOMEDAY');
  // a PATCH that does not change scope keeps the rank
  const before = rankOf(a.id);
  await call('PATCH', `/api/v1/tasks/${a.id}`, { body: { title: 'a2' } });
  assert.equal(rankOf(a.id), before);
});

test('PATCH clears today_rank when the task leaves Today; return appends after manual items (I11)', async () => {
  const { call, db } = makeApp();
  const mk = async n => (await call('POST', '/api/v1/tasks', { body: { title: n, when_type: 'date', when_date: TODAY } })).json;
  const a = await mk('a'); const b = await mk('b'); const c = await mk('c');
  // manual placement: c to the top -> everyone gets a today_rank via renorm/write
  await call('POST', `/api/v1/tasks/${c.id}/reorder`, { body: { before_id: a.id, list: 'today' } });
  assert.notEqual(db.prepare('SELECT today_rank FROM tasks WHERE id = ?').get(a.id).today_rank, null);
  // schedule a out of Today -> stale manual rank must not survive
  const r = await call('PATCH', `/api/v1/tasks/${a.id}`, { body: { when_date: '2026-03-20' } });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT today_rank FROM tasks WHERE id = ?').get(a.id).today_rank, null);
  // b keeps its manual rank (still in Today)
  assert.notEqual(db.prepare('SELECT today_rank FROM tasks WHERE id = ?').get(b.id).today_rank, null);
  // a PATCH that keeps the task in Today leaves today_rank alone
  await call('PATCH', `/api/v1/tasks/${b.id}`, { body: { title: 'b2' } });
  assert.notEqual(db.prepare('SELECT today_rank FROM tasks WHERE id = ?').get(b.id).today_rank, null);
});

// ---- steps ----
test('steps: create/patch/delete + validation and caps', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'with steps' } })).json;
  const s = await call('POST', `/api/v1/tasks/${t.id}/steps`, { body: { title: 'one' } });
  assert.equal(s.status, 201);
  const upd = await call('PATCH', `/api/v1/tasks/${t.id}/steps/${s.json.id}`, { body: { done: true, title: 'one!' } });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.done, 1);
  assert.equal((await call('PATCH', `/api/v1/tasks/${t.id}/steps/${s.json.id}`, { body: { nope: 1 } })).status, 400);
  assert.equal((await call('DELETE', `/api/v1/tasks/${t.id}/steps/${s.json.id}`)).status, 200);
  assert.equal((await call('DELETE', `/api/v1/tasks/${t.id}/steps/${s.json.id}`)).status, 404);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/steps`, { body: { title: '' } })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/NOPE/steps`, { body: { title: 'x' } })).status, 404);
});

// ---- quickadd ----
test('quickadd endpoint parses tokens; email-style literal goes through POST instead', async () => {
  const { call } = makeApp();
  const p = (await call('POST', '/api/v1/projects', { body: { name: 'Garden' } })).json;
  const r = await call('POST', '/api/v1/tasks/quickadd', { body: { text: 'trim hedge @garden #chore !tomorrow' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.title, 'trim hedge');
  assert.equal(r.json.project_id, p.id);
  assert.deepEqual(r.json.tags, ['chore']);
  assert.equal(r.json.due_date, '2026-03-11');
  assert.equal((await call('POST', '/api/v1/tasks/quickadd', { body: { text: '' } })).status, 400);
  assert.equal((await call('POST', '/api/v1/tasks/quickadd', { body: { text: 'x', other: 1 } })).status, 400);
  assert.equal((await call('POST', '/api/v1/tasks/quickadd', { body: { text: '#only-tokens' } })).status, 400);
  // Mail-to-Inbox contract: structured POST keeps tokens literal
  const mail = await call('POST', '/api/v1/tasks', { body: { title: 'Re: invoice #42 @acme !urgent' } });
  assert.equal(mail.json.title, 'Re: invoice #42 @acme !urgent');
});

// ---- projects ----
test('projects: create/list/patch, duplicate name 409, parent cycle 400', async () => {
  const { call } = makeApp();
  const a = (await call('POST', '/api/v1/projects', { body: { name: 'A', domain: 'agent-ops' } })).json;
  const b = (await call('POST', '/api/v1/projects', { body: { name: 'B', parent_id: a.id } })).json;
  assert.equal((await call('POST', '/api/v1/projects', { body: { name: 'A' } })).status, 409);
  assert.equal((await call('POST', '/api/v1/projects', { body: { name: 'C', parent_id: 'ghost' } })).status, 400);
  assert.equal((await call('POST', '/api/v1/projects', { body: { name: 'C', extra: 1 } })).status, 400);
  const list = await call('GET', '/api/v1/projects');
  assert.deepEqual(list.json.items.map(x => x.name), ['A', 'B']);
  // cycle: A under B (B is A's child) must fail
  const cyc = await call('PATCH', `/api/v1/projects/${a.id}`, { body: { parent_id: b.id } });
  assert.equal(cyc.status, 400);
  assert.match(cyc.json.error, /cycle/);
  // self-parent
  assert.equal((await call('PATCH', `/api/v1/projects/${a.id}`, { body: { parent_id: a.id } })).status, 400);
  // rename onto an existing name is a clean 409, not a raw SQLite 500
  const dup = await call('PATCH', `/api/v1/projects/${b.id}`, { body: { name: 'A' } });
  assert.equal(dup.status, 409);
  assert.match(dup.json.error, /already exists/);
  // renaming to its OWN name is fine (no self-conflict)
  assert.equal((await call('PATCH', `/api/v1/projects/${b.id}`, { body: { name: 'B' } })).status, 200);
  const upd = await call('PATCH', `/api/v1/projects/${b.id}`, { body: { archived: true, notes: 'done era' } });
  assert.equal(upd.json.archived, 1);
  assert.equal((await call('PATCH', '/api/v1/projects/NOPE', { body: { name: 'x' } })).status, 404);
});

test('projects list paginates: limit + keyset cursor, bad cursor 400', async () => {
  const { call } = makeApp();
  for (const n of ['A', 'B', 'C', 'D', 'E']) await call('POST', '/api/v1/projects', { body: { name: n } });
  const p1 = await call('GET', '/api/v1/projects?limit=2');
  assert.equal(p1.json.items.length, 2);
  assert.ok(p1.json.next_cursor);
  assert.ok(!('__k0' in p1.json.items[0]), 'internal sort key not leaked');
  const p2 = await call('GET', `/api/v1/projects?limit=2&cursor=${p1.json.next_cursor}`);
  const p3 = await call('GET', `/api/v1/projects?limit=2&cursor=${p2.json.next_cursor}`);
  const names = [...p1.json.items, ...p2.json.items, ...p3.json.items].map(p => p.name);
  assert.deepEqual(names, ['A', 'B', 'C', 'D', 'E']);
  assert.equal(p3.json.next_cursor, undefined);
  assert.equal((await call('GET', '/api/v1/projects?cursor=!!!')).status, 400);
});

// ---- due_soon + counts ----
test('view=due_soon: future dues inside the window, ordered by due_date; window validated', async () => {
  const { call } = makeApp(); // TODAY = 2026-03-10
  await call('POST', '/api/v1/tasks', { body: { title: 'due today', due_date: '2026-03-10' } });
  await call('POST', '/api/v1/tasks', { body: { title: 'overdue', due_date: '2026-03-01' } });
  await call('POST', '/api/v1/tasks', { body: { title: 'in 5', due_date: '2026-03-15' } });
  await call('POST', '/api/v1/tasks', { body: { title: 'in 30', due_date: '2026-04-09' } });
  await call('POST', '/api/v1/tasks', { body: { title: 'in 40', due_date: '2026-04-19' } });
  const d = await call('POST', '/api/v1/tasks', { body: { title: 'done soon', due_date: '2026-03-12' } });
  await call('POST', `/api/v1/tasks/${d.json.id}/complete`);

  const def = await call('GET', '/api/v1/tasks?view=due_soon');
  assert.deepEqual(def.json.items.map(x => x.title), ['in 5', 'in 30']); // default 30d, edge inclusive
  const wide = await call('GET', '/api/v1/tasks?view=due_soon&window=50');
  assert.deepEqual(wide.json.items.map(x => x.title), ['in 5', 'in 30', 'in 40']);
  const narrow = await call('GET', '/api/v1/tasks?view=due_soon&window=4');
  assert.deepEqual(narrow.json.items.map(x => x.title), []);
  for (const bad of ['0', '366', '1.5', 'x', '-2']) {
    assert.equal((await call('GET', `/api/v1/tasks?view=due_soon&window=${bad}`)).status, 400, bad);
  }
});

test('GET /counts: view counts + per-project open counts; zeroes included, auth required', async () => {
  const { call } = makeApp();
  const proj = await call('POST', '/api/v1/projects', { body: { name: 'P' } });
  await call('POST', '/api/v1/tasks', { body: { title: 'inboxed' } });
  await call('POST', '/api/v1/tasks', { body: { title: 'arrived', when_type: 'date', when_date: '2026-03-09', project_id: proj.json.id } });
  await call('POST', '/api/v1/tasks', { body: { title: 'later', when_type: 'date', when_date: '2026-03-20', project_id: proj.json.id } });
  await call('POST', '/api/v1/tasks', { body: { title: 'soon', due_date: '2026-03-15' } });
  const done = await call('POST', '/api/v1/tasks', { body: { title: 'gone', project_id: proj.json.id } });
  await call('POST', `/api/v1/tasks/${done.json.id}/complete`);

  const res = await call('GET', '/api/v1/counts');
  assert.equal(res.status, 200);
  const { inbox, today, upcoming, due_soon, projects } = res.json;
  assert.equal(inbox, 2);        // 'inboxed' + 'soon' (no project, no when)
  assert.equal(today, 1);        // 'arrived'
  assert.equal(upcoming, 1);     // 'later'
  assert.equal(due_soon, 1);     // 'soon'
  assert.deepEqual(projects, { [proj.json.id]: 2 }); // done task excluded
  assert.equal(res.json.actor, 'aron'); // rail footer: "signed in as …"
  assert.equal((await call('GET', '/api/v1/counts', { token: null })).status, 401);
  assert.equal((await call('GET', '/api/v1/counts?window=0')).status, 400);
});

// ---- tags ----
test('GET /tags lists every tag with open-task count; auth required', async () => {
  const { call } = makeApp();
  const a = await call('POST', '/api/v1/tasks', { body: { title: 'one', tags: ['home', 'urgent'] } });
  await call('POST', '/api/v1/tasks', { body: { title: 'two', tags: ['home'] } });
  const done = await call('POST', '/api/v1/tasks', { body: { title: 'three', tags: ['home'] } });
  await call('POST', `/api/v1/tasks/${done.json.id}/complete`);
  // archived tasks don't count either
  await call('PATCH', `/api/v1/tasks/${a.json.id}`, { body: { status: 'archived' } });
  const res = await call('GET', '/api/v1/tags');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.items.map(({ name, count }) => ({ name, count })),
    [{ name: 'home', count: 1 }, { name: 'urgent', count: 0 }]);
  for (const it of res.json.items) assert.equal(typeof it.id, 'string');
  assert.equal((await call('GET', '/api/v1/tags', { token: null })).status, 401);
});

test('POST /tags: creates (leading # stripped), NOCASE dup 409, validation, auth', async () => {
  const { call } = makeApp();
  const a = await call('POST', '/api/v1/tags', { body: { name: 'Errands' } });
  assert.equal(a.status, 201);
  assert.equal(a.json.name, 'Errands');
  assert.equal(a.json.count, 0);
  assert.equal(typeof a.json.id, 'string');
  const b = await call('POST', '/api/v1/tags', { body: { name: '#chores' } });
  assert.equal(b.json.name, 'chores');
  // case-insensitive duplicate -> 409 (also against tags created via tasks)
  assert.equal((await call('POST', '/api/v1/tags', { body: { name: 'errands' } })).status, 409);
  await call('POST', '/api/v1/tasks', { body: { title: 't', tags: ['home'] } });
  assert.equal((await call('POST', '/api/v1/tags', { body: { name: 'HOME' } })).status, 409);
  // validation + auth
  assert.equal((await call('POST', '/api/v1/tags', { body: { name: '  ' } })).status, 400);
  assert.equal((await call('POST', '/api/v1/tags', { body: { name: '#' } })).status, 400);
  assert.equal((await call('POST', '/api/v1/tags', { body: { nome: 'x' } })).status, 400);
  assert.equal((await call('POST', '/api/v1/tags', { body: { name: 'x' }, token: null })).status, 401);
  // new zero-count tag still listed by GET /tags
  const list = await call('GET', '/api/v1/tags');
  assert.deepEqual(list.json.items.map(t => t.name), ['chores', 'Errands', 'home']);
  assert.equal(list.json.items.find(t => t.name === 'Errands').count, 0);
});

// ---- delegation lifecycle ----
test('delegation happy path: POST assignee -> claim -> finish -> review -> approve -> done', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'sweep memories', assignee: 'claude' } })).json;
  assert.equal(t.assignee, 'claude');
  assert.equal(t.auto_close, 0);
  assert.equal(t.created_by, 'aron'); // created_by = who asked; assignee = who must do it
  const claimed = await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.json.task.status, 'in_progress');
  assert.ok(claimed.json.task.claimed_at);
  const fin = await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_CLAUDE, body: { report: 'swept 12 stale entries' } });
  assert.equal(fin.status, 200);
  assert.equal(fin.json.task.status, 'review');
  assert.equal(fin.json.task.report, 'swept 12 stale entries');
  assert.equal(fin.json.task.completed_at, null, 'review is not done');
  const ok = await call('POST', `/api/v1/tasks/${t.id}/approve`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.task.status, 'done');
  assert.ok(ok.json.task.completed_at);
  assert.equal(ok.json.task.report, 'swept 12 stale entries', 'report survives approval');
  // approve again: idempotent 200
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/approve`)).status, 200);
});

test('claim: wrong actor 403; double-claim idempotent; claiming review/done 409; 404', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job', assignee: 'claude' } })).json;
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/claim`)).status, 403, 'aron is not the assignee');
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_HERMES })).status, 403);
  const first = await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE });
  const again = await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE });
  assert.equal(again.status, 200, 'claiming your own in_progress task is a 200');
  assert.equal(again.json.task.claimed_at, first.json.task.claimed_at, 'claimed_at not re-stamped');
  await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_CLAUDE, body: { report: 'r' } });
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE })).status, 409);
  assert.equal((await call('POST', '/api/v1/tasks/NOPE/claim', { token: TOK_CLAUDE })).status, 404);
});

test('finish: wrong actor 403; report required 400; finishing review/done 409; works from active (unclaimed)', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job', assignee: 'hermes' } })).json;
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_CLAUDE, body: { report: 'r' } })).status, 403);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_HERMES, body: {} })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_HERMES, body: { report: '  ' } })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_HERMES, body: { report: 'r', extra: 1 } })).status, 400);
  // active -> review without an explicit claim is allowed
  const fin = await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_HERMES, body: { report: 'done it' } });
  assert.equal(fin.status, 200);
  assert.equal(fin.json.task.status, 'review');
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_HERMES, body: { report: 'again' } })).status, 409);
});

test('approve: non-aron 403; approving active/in_progress 409; 404', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job', assignee: 'claude' } })).json;
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/approve`, { token: TOK_CLAUDE })).status, 403);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/approve`)).status, 409, 'not in review yet');
  await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE });
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/approve`)).status, 409);
  await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_CLAUDE, body: { report: 'r' } });
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/approve`, { token: TOK_HERMES })).status, 403);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/approve`)).status, 200);
  assert.equal((await call('POST', '/api/v1/tasks/NOPE/approve')).status, 404);
});

test('recurrence spawns ONLY at the final done: not on review finish, once on approve; auto_close finish spawns directly', async () => {
  const { call, db } = makeApp();
  const spawnsOf = id => db.prepare('SELECT * FROM tasks WHERE spawned_from = ?').all(id);
  // review lane: finish must NOT spawn, approve must
  const r = (await call('POST', '/api/v1/tasks', {
    body: { title: 'weekly digest', assignee: 'claude', due_date: TODAY, recur: { freq: 'every', n: 7, anchor: 'due' } } })).json;
  const fin = await call('POST', `/api/v1/tasks/${r.id}/finish`, { token: TOK_CLAUDE, body: { report: 'sent' } });
  assert.equal(fin.json.spawned_id, undefined, 'entering review never spawns');
  assert.equal(spawnsOf(r.id).length, 0);
  const ok = await call('POST', `/api/v1/tasks/${r.id}/approve`);
  assert.ok(ok.json.spawned_id, 'approval is the final transition');
  assert.equal((await call('POST', `/api/v1/tasks/${r.id}/approve`)).json.spawned_id, undefined, 'repeat approve does not re-spawn');
  assert.equal(spawnsOf(r.id).length, 1);
  // spawn keeps the delegation shape, resets claim/report
  const next = spawnsOf(r.id)[0];
  assert.equal(next.assignee, 'claude');
  assert.equal(next.status, 'active');
  assert.equal(next.claimed_at, null);
  assert.equal(next.report, null);
  // auto_close lane: finish goes straight to done and spawns exactly once
  const a = (await call('POST', '/api/v1/tasks', {
    body: { title: 'daily sweep', assignee: 'hermes', auto_close: true, due_date: TODAY, recur: { freq: 'daily', anchor: 'due' } } })).json;
  assert.equal(a.auto_close, 1);
  const af = await call('POST', `/api/v1/tasks/${a.id}/finish`, { token: TOK_HERMES, body: { report: 'swept' } });
  assert.equal(af.json.task.status, 'done');
  assert.ok(af.json.task.completed_at);
  assert.ok(af.json.spawned_id);
  assert.equal(spawnsOf(a.id).length, 1);
  assert.equal(spawnsOf(a.id)[0].auto_close, 1, 'spawn keeps auto_close');
});

test('reopen from review keeps the report; the next finish appends under a timestamped rule', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'draft', assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_CLAUDE, body: { report: 'first pass' } });
  const reopened = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { status: 'active' } });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.json.status, 'active');
  assert.equal(reopened.json.report, 'first pass', 'reopen keeps the report');
  const fin2 = await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_CLAUDE, body: { report: 'second pass' } });
  assert.match(fin2.json.task.report, /^first pass\n\n--- \d{4}-\d{2}-\d{2}T[\d:.]+Z\n\nsecond pass$/);
});

test('PATCH rules: in_progress/review/done not settable; report not client-patchable; assignee validated', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'x' } })).json;
  for (const bad of ['in_progress', 'review']) {
    const r = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { status: bad } });
    assert.equal(r.status, 400, bad);
    assert.match(r.json.error, /claim|finish/);
  }
  const rep = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { report: 'forged' } });
  assert.equal(rep.status, 400);
  assert.match(rep.json.error, /finish/);
  assert.equal((await call('POST', '/api/v1/tasks', { body: { title: 'x', report: 'forged' } })).status, 400);
  assert.equal((await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { assignee: '' } })).status, 400);
  assert.equal((await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { assignee: 42 } })).status, 400);
  assert.equal((await call('POST', '/api/v1/tasks', { body: { title: 'x', auto_close: 'yes' } })).status, 400);
});

test('reassigning an in_progress task resets it to active and clears the claim', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job', assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE });
  const r = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { assignee: 'hermes' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.assignee, 'hermes');
  assert.equal(r.json.status, 'active');
  assert.equal(r.json.claimed_at, null);
  // a non-assignee PATCH (title tweak) does NOT reset a claim
  await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_HERMES });
  const keep = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { title: 'job 2' } });
  assert.equal(keep.json.status, 'in_progress');
  assert.notEqual(keep.json.claimed_at, null);
  // re-asserting the SAME assignee is a no-op reset-wise
  const same = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { assignee: 'hermes' } });
  assert.equal(same.json.status, 'in_progress');
});

test("view scoping over HTTP: aron's today/inbox exclude delegated; review/delegated views + ?assignee= work", async () => {
  const { call } = makeApp();
  await call('POST', '/api/v1/tasks', { body: { title: 'mine today', when_type: 'date', when_date: TODAY } });
  await call('POST', '/api/v1/tasks', { body: { title: 'delegated today', assignee: 'claude', when_type: 'date', when_date: TODAY } });
  await call('POST', '/api/v1/tasks', { body: { title: 'delegated due', assignee: 'claude', due_date: TODAY } });
  const inReview = (await call('POST', '/api/v1/tasks', { body: { title: 'delegated inbox', assignee: 'hermes' } })).json;
  await call('POST', `/api/v1/tasks/${inReview.id}/finish`, { token: TOK_HERMES, body: { report: 'r' } });
  const today = await call('GET', '/api/v1/tasks?view=today');
  // when-driven delegated work stays out; a delegated DUE-today task shows
  // (due overrides assignee scoping — 2026-08-24 amendment)
  assert.deepEqual(today.json.items.map(t => t.title), ['mine today', 'delegated due']);
  const inbox = await call('GET', '/api/v1/tasks?view=inbox');
  assert.deepEqual(inbox.json.items.map(t => t.title), []);
  const review = await call('GET', '/api/v1/tasks?view=review');
  assert.deepEqual(review.json.items.map(t => t.title), ['delegated inbox']);
  const delegated = await call('GET', '/api/v1/tasks?view=delegated');
  assert.deepEqual(new Set(delegated.json.items.map(t => t.title)),
    new Set(['delegated today', 'delegated due', 'delegated inbox']));
  const byAssignee = await call('GET', '/api/v1/tasks?assignee=claude');
  assert.deepEqual(new Set(byAssignee.json.items.map(t => t.title)),
    new Set(['delegated today', 'delegated due']));
});

test('GET /counts gains review + delegated; when-driven keys aron-scoped, due-driven include everyone', async () => {
  const { call } = makeApp();
  await call('POST', '/api/v1/tasks', { body: { title: 'mine' } });
  await call('POST', '/api/v1/tasks', { body: { title: 'queued', assignee: 'claude' } });
  const c1 = (await call('POST', '/api/v1/tasks', { body: { title: 'working', assignee: 'claude', when_type: 'date', when_date: TODAY } })).json;
  await call('POST', `/api/v1/tasks/${c1.id}/claim`, { token: TOK_CLAUDE });
  const h1 = (await call('POST', '/api/v1/tasks', { body: { title: 'checking', assignee: 'hermes' } })).json;
  await call('POST', `/api/v1/tasks/${h1.id}/finish`, { token: TOK_HERMES, body: { report: 'r' } });
  // due-driven delegated work counts in today/due_soon (2026-08-24 amendment)
  await call('POST', '/api/v1/tasks', { body: { title: 'agent deadline', assignee: 'claude', due_date: TODAY } });
  await call('POST', '/api/v1/tasks', { body: { title: 'agent soon', assignee: 'hermes', due_date: '2026-03-15' } });
  const res = await call('GET', '/api/v1/counts');
  assert.equal(res.json.inbox, 1, "delegated tasks don't clutter aron's inbox");
  assert.equal(res.json.today, 1, "claude's arrived WHEN is not aron's today; claude's DUE today is");
  assert.equal(res.json.due_soon, 1, 'delegated future due counts');
  assert.equal(res.json.review, 1);
  assert.equal(res.json.delegated, 5);
});

test('quickadd >assignee flows through to the created task', async () => {
  const { call } = makeApp();
  const r = await call('POST', '/api/v1/tasks/quickadd', { body: { text: 'sweep the queue >hermes #ops' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.title, 'sweep the queue');
  assert.equal(r.json.assignee, 'hermes');
  assert.deepEqual(r.json.tags, ['ops']);
  const me = await call('POST', '/api/v1/tasks/quickadd', { body: { text: 'call bank >me' }, token: TOK_CLAUDE });
  assert.equal(me.json.assignee, 'aron');
  assert.equal(me.json.created_by, 'claude');
  const unknown = await call('POST', '/api/v1/tasks/quickadd', { body: { text: 'forward >bob the memo' } });
  assert.equal(unknown.json.title, 'forward >bob the memo');
  assert.equal(unknown.json.assignee, 'aron');
});

// ---- agent security (layer 1): provenance vetting ----
test('creation vetting: trusted actors are born vetted=1, untrusted (email) vetted=0 — quickadd included', async () => {
  const { call } = makeApp();
  for (const token of [TOK_ARON, TOK_CLAUDE, TOK_HERMES]) {
    const r = await call('POST', '/api/v1/tasks', { body: { title: 'trusted', assignee: 'claude' }, token });
    assert.equal(r.json.vetted, 1);
  }
  const e = await call('POST', '/api/v1/tasks', { body: { title: 'from mail', assignee: 'claude' }, token: TOK_EMAIL });
  assert.equal(e.json.vetted, 0);
  assert.equal(e.json.created_by, 'email');
  const q = await call('POST', '/api/v1/tasks/quickadd', { body: { text: 'ingested >hermes' }, token: TOK_EMAIL });
  assert.equal(q.json.vetted, 0);
});

test('PATCH cannot set vetted (unknown field); vet door is the only way up', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'sly', assignee: 'claude' }, token: TOK_EMAIL })).json;
  const patch = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { vetted: 1 } });
  assert.equal(patch.status, 400);
  assert.match(patch.json.error, /unknown field: vetted/);
  const create = await call('POST', '/api/v1/tasks', { body: { title: 'x', vetted: 1 }, token: TOK_EMAIL });
  assert.equal(create.status, 400);
});

test('unvetted task: claim and finish are 403 (server-enforced door, not view filtering)', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'evil?', assignee: 'claude' }, token: TOK_EMAIL })).json;
  const claim = await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE });
  assert.equal(claim.status, 403);
  assert.match(claim.json.error, /not vetted for agent execution/);
  const finish = await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_CLAUDE, body: { report: 'did it' } });
  assert.equal(finish.status, 403);
  assert.match(finish.json.error, /not vetted for agent execution/);
  // the human doors stay open: an unvetted task is quarantined from AGENTS only
  const done = await call('POST', `/api/v1/tasks/${t.id}/complete`);
  assert.equal(done.status, 200);
});

test('vet door: admin only, idempotent; PATCH-preserving', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'check me', assignee: 'claude' }, token: TOK_EMAIL })).json;
  const agent = await call('POST', `/api/v1/tasks/${t.id}/vet`, { token: TOK_CLAUDE });
  assert.equal(agent.status, 403, 'an agent cannot vet its own work');
  assert.match(agent.json.error, /only the admin/);
  const vet = await call('POST', `/api/v1/tasks/${t.id}/vet`);
  assert.equal(vet.status, 200);
  assert.equal(vet.json.task.vetted, 1);
  const again = await call('POST', `/api/v1/tasks/${t.id}/vet`); // idempotent
  assert.equal(again.status, 200);
  assert.equal(again.json.task.vetted, 1);
  assert.equal((await call('POST', '/api/v1/tasks/nope/vet')).status, 404);
});

test('queue view: server-side exclusion of unvetted work; delegated/project views still show it', async () => {
  const { call } = makeApp();
  await call('POST', '/api/v1/tasks', { body: { title: 'safe work', assignee: 'claude' } });
  const claimed = (await call('POST', '/api/v1/tasks', { body: { title: 'claimed work', assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${claimed.id}/claim`, { token: TOK_CLAUDE });
  await call('POST', '/api/v1/tasks', { body: { title: 'suspect work', assignee: 'claude' }, token: TOK_EMAIL });
  const queue = await call('GET', '/api/v1/tasks?view=queue&assignee=claude');
  assert.deepEqual(queue.json.items.map(t => t.title), ['claimed work', 'safe work'],
    'in_progress first, unvetted excluded');
  // visibility is NOT filtered: the owner must see arrivals to vet them
  const delegated = await call('GET', '/api/v1/tasks?view=delegated');
  assert.ok(delegated.json.items.some(t => t.title === 'suspect work'));
  const open = await call('GET', '/api/v1/tasks?assignee=claude');
  assert.ok(open.json.items.some(t => t.title === 'suspect work'));
});

test('counts gains unvetted (assigned-to-agent AND vetted=0)', async () => {
  const { call } = makeApp();
  await call('POST', '/api/v1/tasks', { body: { title: 'a', assignee: 'claude' }, token: TOK_EMAIL });
  await call('POST', '/api/v1/tasks', { body: { title: 'b', assignee: 'hermes' }, token: TOK_EMAIL });
  await call('POST', '/api/v1/tasks', { body: { title: 'for aron', assignee: 'aron' }, token: TOK_EMAIL });
  await call('POST', '/api/v1/tasks', { body: { title: 'fine', assignee: 'claude' } });
  const c = await call('GET', '/api/v1/counts');
  assert.equal(c.json.unvetted, 2, 'only agent-assigned unvetted tasks count');
});

test('happy path: email creates -> admin vets -> agent claims and finishes into review', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks',
    { body: { title: 'summarize the newsletter', assignee: 'hermes' }, token: TOK_EMAIL })).json;
  // invisible to the agent's queue until vetted
  let queue = await call('GET', '/api/v1/tasks?view=queue&assignee=hermes');
  assert.equal(queue.json.items.length, 0);
  await call('POST', `/api/v1/tasks/${t.id}/vet`);
  queue = await call('GET', '/api/v1/tasks?view=queue&assignee=hermes');
  assert.deepEqual(queue.json.items.map(x => x.title), ['summarize the newsletter']);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_HERMES })).status, 200);
  const fin = await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_HERMES, body: { report: 'summary at ...' } });
  assert.equal(fin.status, 200);
  assert.equal(fin.json.task.status, 'review');
  assert.equal((await call('GET', '/api/v1/counts')).json.unvetted, 0);
});

test('untrusted set is configurable: buildApp untrusted option + parseUntrusted env parsing', async () => {
  const { db, migrate } = open(':memory:');
  migrate();
  const app = buildApp({ db, tokens: { aron: TOK_ARON, claude: TOK_CLAUDE },
    untrusted: ['claude'], today: () => TODAY });
  const post = async token => {
    const res = await app.fetch(new Request('http://x/api/v1/tasks', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't' }) }));
    return res.json();
  };
  assert.equal((await post(TOK_CLAUDE)).vetted, 0, 'listed actor is untrusted');
  assert.equal((await post(TOK_ARON)).vetted, 1, 'email default replaced by the explicit list');
  // env parsing: unset -> default "email"; explicit empty -> nobody untrusted
  assert.deepEqual(parseUntrusted(undefined), ['email']);
  assert.deepEqual(parseUntrusted('email, sms ,'), ['email', 'sms']);
  assert.deepEqual(parseUntrusted(''), []);
});

// ---- static / CSP ----
test('static UI: CSP header on static responses; traversal blocked; API 404 is JSON', async () => {
  const { app } = makeApp();
  const res = await app.fetch(new Request('http://x/'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Security-Policy'), /default-src 'self'/);
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  const trav = await app.fetch(new Request('http://x/..%2f..%2fpackage.json'));
  assert.equal(trav.status, 404);
  const missing = await app.fetch(new Request('http://x/nope.js'));
  assert.equal(missing.status, 404);
});
