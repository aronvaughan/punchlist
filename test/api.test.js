import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/db.js';
import { buildApp } from '../src/api.js';
import { parseTokens } from '../src/server.js';

const TOK_ARON = 'a'.repeat(32);
const TOK_CLAUDE = 'c'.repeat(32);
const TODAY = '2026-03-10';

function makeApp() {
  const { db, migrate } = open(':memory:');
  migrate();
  const app = buildApp({ db, tokens: { aron: TOK_ARON, claude: TOK_CLAUDE }, today: () => TODAY });
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
  assert.deepEqual(h.json, { ok: true });
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
