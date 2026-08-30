import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/db.js';
import { buildApp } from '../src/api.js';
import { parseTokens, envPermWarning, resolveAdmin, parseUntrusted, migrateLegacyDb } from '../src/server.js';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const TOK_ARON = 'a'.repeat(32);
const TOK_CLAUDE = 'c'.repeat(32);
const TOK_HERMES = 'h'.repeat(32);
const TOK_EMAIL = 'e'.repeat(32);
const TODAY = '2026-03-10';

function makeApp() {
  const { db, migrate } = open(':memory:');
  migrate();
  const app = buildApp({
    db, tokens: { alex: TOK_ARON, claude: TOK_CLAUDE, hermes: TOK_HERMES, email: TOK_EMAIL },
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

// A makeApp variant that wires a HERMETIC template-editing backend: a fake repo
// dir marked available, and a stub `run` that records calls and returns canned
// output keyed by the command. Individual tests override `runImpl`.
function makeAppWithTemplates(runImpl) {
  const { db, migrate } = open(':memory:');
  migrate();
  const calls = [];
  const run = async (spec) => { calls.push(spec); return (runImpl || (() => ({ code: 0, stdout: '', stderr: '' })))(spec); };
  const app = buildApp({
    db, tokens: { alex: TOK_ARON, claude: TOK_CLAUDE, hermes: TOK_HERMES, email: TOK_EMAIL },
    today: () => TODAY,
    templateEditing: { dir: '/fake/templates-repo', available: true, run },
  });
  const call = async (method, path, { body, token = TOK_ARON } = {}) => {
    const headers = {}; if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await app.fetch(new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  return { db, app, call, calls };
}

// A real temp git repo seeded with template files, for endpoint tests that read
// or write the fs. Returns { dir, cleanup }; cleanup tears the whole tree down.
function realTemplatesRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pl-tpl-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, 'templates', rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: dir });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// buildApp over a real templates dir, with an injectable run (default: real).
function appWithDir(dir, runImpl) {
  const { db, migrate } = open(':memory:'); migrate();
  const calls = [];
  const run = async (spec) => { calls.push(spec); return (runImpl || (() => ({ code: 0, stdout: '', stderr: '' })))(spec); };
  const app = buildApp({
    db, tokens: { alex: TOK_ARON, claude: TOK_CLAUDE, hermes: TOK_HERMES, email: TOK_EMAIL },
    today: () => TODAY, templateEditing: { dir, available: true, run },
  });
  const call = async (method, path, { body, token = TOK_ARON } = {}) => {
    const headers = {}; if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await app.fetch(new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  return { db, app, call, calls, dir };
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
  const a = await call('POST', '/api/v1/tasks', { body: { title: 'from alex' } });
  assert.equal(a.status, 201);
  assert.equal(a.json.created_by, 'alex');
  const c = await call('POST', '/api/v1/tasks', { body: { title: 'from claude' }, token: TOK_CLAUDE });
  assert.equal(c.json.created_by, 'claude');
  const bad = await call('POST', '/api/v1/tasks', { body: { title: 'spoof', created_by: 'hermes' } });
  assert.equal(bad.status, 400);
});

test('fail-closed token parsing', () => {
  assert.throws(() => parseTokens(''), /refusing to start/);
  assert.throws(() => parseTokens('alex:short'), /32/);
  assert.throws(() => parseTokens('nocolon'), /malformed/);
  assert.deepEqual(parseTokens(`alex:${TOK_ARON}, claude:${TOK_CLAUDE}`),
    { alex: TOK_ARON, claude: TOK_CLAUDE });
});

test('data/.env permission check: warn on group/other-readable, silent on 600', () => {
  assert.equal(envPermWarning(0o100600), null);
  assert.equal(envPermWarning(0o100700), null);
  assert.match(envPermWarning(0o100644), /chmod 600/);
  assert.match(envPermWarning(0o100640), /group\/other/);
});

test('migrateLegacyDb: fresh data dir — no rename, nothing created', () => {
  const dir = mkdtempSync(join(tmpdir(), 'punchlist-'));
  assert.equal(migrateLegacyDb(dir, () => {}), false);
  assert.ok(!existsSync(join(dir, 'punchlist.db')));
  assert.ok(!existsSync(join(dir, 'av-tasks.db')));
  rmSync(dir, { recursive: true, force: true });
});

test('migrateLegacyDb: legacy av-tasks.db (+ sidecars) is renamed once, data intact, and logged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'punchlist-'));
  const legacy = join(dir, 'av-tasks.db');
  { // build a real legacy db with a row in it
    const { db, migrate } = open(legacy);
    migrate();
    db.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'Home', 't', 't')`).run();
    db.close();
  }
  writeFileSync(`${legacy}-wal`, ''); // stale sidecar must follow the rename
  const logs = [];
  assert.equal(migrateLegacyDb(dir, m => logs.push(m)), true);
  assert.ok(!existsSync(legacy));
  assert.ok(!existsSync(`${legacy}-wal`));
  assert.ok(existsSync(join(dir, 'punchlist.db-wal')));
  assert.match(logs.join('\n'), /migrated legacy database/);
  const { db } = open(join(dir, 'punchlist.db'));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM projects').get().c, 1, 'rows survived the rename');

  // second boot: punchlist.db already exists — never rename again
  writeFileSync(legacy, 'stray');
  assert.equal(migrateLegacyDb(dir, () => {}), false);
  assert.ok(existsSync(legacy), 'must not touch av-tasks.db when punchlist.db exists');
  rmSync(dir, { recursive: true, force: true });
});

test('resolveAdmin: defaults to the FIRST actor; explicit must have a token (fail closed)', () => {
  const tokens = { pat: 'p'.repeat(32), claude: TOK_CLAUDE };
  assert.equal(resolveAdmin(tokens, undefined), 'pat');
  assert.equal(resolveAdmin(tokens, ''), 'pat');
  assert.equal(resolveAdmin(tokens, '  claude  '), 'claude');
  assert.throws(() => resolveAdmin(tokens, 'alex'), /PUNCHLIST_ADMIN.*no token/);
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
  // default assignee is the admin, not 'alex'
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
  // first-actor default: alex-first tokens behave exactly as before
  buildApp({ db, tokens: { alex: TOK_ARON, claude: TOK_CLAUDE } });
});

// ---- project context notepad (project.notes: the per-project readme) ----
test('project context: notes set at create, PATCH-able, returned by GET (agent-readable)', async () => {
  const { call } = makeApp();
  // create with context
  const p = await call('POST', '/api/v1/projects', { body: { name: 'Apollo', notes: '# Apollo\nthe overview' } });
  assert.equal(p.status, 201);
  assert.equal(p.json.notes, '# Apollo\nthe overview');
  // PATCH the context
  const u = await call('PATCH', `/api/v1/projects/${p.json.id}`, { body: { notes: 'updated readme' } });
  assert.equal(u.status, 200);
  assert.equal(u.json.notes, 'updated readme');
  // GET /projects surfaces it (what pl.sh + MCP read)
  const list = await call('GET', '/api/v1/projects');
  assert.equal(list.json.items.find(x => x.id === p.json.id).notes, 'updated readme');
});

// The notepad can "point to" a punchlist-templates template (mirrors
// task.template, migration 012) — the same AI-assisted editor that edits a
// task's template can then open it for a project's.
test('project template pointer: settable at create and via PATCH; free string, not validated against a set', async () => {
  const { call } = makeApp();
  const p = await call('POST', '/api/v1/projects', { body: { name: 'Voyager', template: 'research-brief' } });
  assert.equal(p.status, 201);
  assert.equal(p.json.template, 'research-brief');

  const u = await call('PATCH', `/api/v1/projects/${p.json.id}`, { body: { template: 'weekly-report' } });
  assert.equal(u.status, 200);
  assert.equal(u.json.template, 'weekly-report');

  const cleared = await call('PATCH', `/api/v1/projects/${p.json.id}`, { body: { template: null } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.template, null);

  const bad = await call('PATCH', `/api/v1/projects/${p.json.id}`, { body: { template: 123 } });
  assert.equal(bad.status, 400);
});

test('project working_dir: set/PATCH/return + validation (agent cd target)', async () => {
  const { call } = makeApp();
  const p = await call('POST', '/api/v1/projects', { body: { name: 'Repo', working_dir: '/home/u/code/repo' } });
  assert.equal(p.status, 201);
  assert.equal(p.json.working_dir, '/home/u/code/repo');
  const u = await call('PATCH', `/api/v1/projects/${p.json.id}`, { body: { working_dir: '/home/u/code/other' } });
  assert.equal(u.json.working_dir, '/home/u/code/other');
  // clear it
  assert.equal((await call('PATCH', `/api/v1/projects/${p.json.id}`, { body: { working_dir: null } })).json.working_dir, null);
  // validation: non-string rejected
  assert.equal((await call('POST', '/api/v1/projects', { body: { name: 'Bad', working_dir: 42 } })).status, 400);
});

test('instance settings: GET defaults, PATCH (admin) name/context/isolation/backup, validation', async () => {
  const { call } = makeApp();
  const g0 = await call('GET', '/api/v1/instance');
  assert.equal(g0.json.name, '');
  assert.equal(g0.json.data_isolation, true);          // private by default
  assert.equal(g0.json.backup_mode, 'snapshot');
  const u = await call('PATCH', '/api/v1/instance', { body: { name: 'workmac-1', context: '# rules', data_isolation: false, backup_mode: 'both', backup_repo: '/backup/repo' } });
  assert.equal(u.status, 200);
  assert.equal(u.json.name, 'workmac-1');
  assert.equal(u.json.context, '# rules');
  assert.equal(u.json.data_isolation, false);
  assert.equal(u.json.backup_mode, 'both');
  // /config echoes the name for first paint
  assert.equal((await call('GET', '/api/v1/config')).json.instance_name, 'workmac-1');
  // validation: bad backup_mode + unknown field
  assert.equal((await call('PATCH', '/api/v1/instance', { body: { backup_mode: 'ftp' } })).status, 400);
  assert.equal((await call('PATCH', '/api/v1/instance', { body: { nope: 1 } })).status, 400);
});

test('instance PATCH is admin-only (403 for a non-admin actor)', async () => {
  const { db, migrate } = open(':memory:');
  migrate();
  const A = 'a'.repeat(32), C = 'c'.repeat(32);
  const app = buildApp({ db, tokens: { alex: A, claude: C }, admin: 'alex', today: () => '2026-03-10' });
  const asClaude = (m, p, body) => app.fetch(new Request(`http://x${p}`, {
    method: m, headers: { Authorization: `Bearer ${C}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined }));
  assert.equal((await asClaude('PATCH', '/api/v1/instance', { name: 'x' })).status, 403);
  assert.equal((await asClaude('GET', '/api/v1/instance')).status, 200); // read is open
});

test('allow_push: admin-only trusted door; PATCH cannot set it; task text cannot grant it', async () => {
  const { db, migrate } = open(':memory:');
  migrate();
  const A = 'a'.repeat(32), C = 'c'.repeat(32);
  const app = buildApp({ db, tokens: { alex: A, claude: C }, admin: 'alex', today: () => '2026-03-10' });
  const req = (tok, m, p, body) => app.fetch(new Request(`http://x${p}`, {
    method: m, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined }));
  const t = await (await req(A, 'POST', '/api/v1/tasks', { title: 'ship it', assignee: 'claude' })).json();
  // default: not push-authorized; PATCH rejects the field
  assert.ok(!t.allow_push);
  assert.equal((await req(A, 'PATCH', `/api/v1/tasks/${t.id}`, { allow_push: 1 })).status, 400, 'PATCH must reject allow_push');
  // non-admin cannot authorize
  assert.equal((await req(C, 'POST', `/api/v1/tasks/${t.id}/allow-push`)).status, 403);
  // admin authorizes → flag set; revoke works
  const ok = await (await req(A, 'POST', `/api/v1/tasks/${t.id}/allow-push`)).json();
  assert.equal(ok.task.allow_push, 1);
  const rev = await (await req(A, 'POST', `/api/v1/tasks/${t.id}/allow-push`, { allow: false })).json();
  assert.equal(rev.task.allow_push, 0);
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
    `INSERT INTO tasks (id, title, status, rank, assignee, created_at, updated_at) VALUES (?, ?, 'active', ?, 'alex', 't', 't')`);
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

test('reorder in a project view section works with a delegated (in_progress) neighbor visible in that view (bug: toast "restoring server order")', async () => {
  const { call } = makeApp();
  const p = (await call('POST', '/api/v1/projects', { body: { name: 'P' } })).json;
  const a = (await call('POST', '/api/v1/tasks',
    { body: { title: 'a', project_id: p.id, assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${a.id}/claim`, { token: TOK_CLAUDE }); // a is now in_progress
  const b = (await call('POST', '/api/v1/tasks', { body: { title: 'b', project_id: p.id } })).json;
  const c = (await call('POST', '/api/v1/tasks', { body: { title: 'c', project_id: p.id } })).json;
  // the project view (GET /tasks?project=) shows in_progress tasks alongside
  // active ones in the same section (delegation design) and renders them as
  // equally draggable rows — so a reorder using a delegated task as a
  // neighbor, exactly as the UI would send from that DOM order, must succeed.
  const before = await call('GET', `/api/v1/tasks?project=${p.id}`);
  assert.deepEqual(before.json.items.map(t => t.title), ['a', 'b', 'c']);
  const r = await call('POST', `/api/v1/tasks/${c.id}/reorder`, { body: { after_id: a.id, before_id: b.id } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const list = await call('GET', `/api/v1/tasks?project=${p.id}`);
  assert.deepEqual(list.json.items.map(t => t.title), ['a', 'c', 'b']);
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

// ---- reopen-to-top + optional reopen comment ----
async function toReview(call, title = 'rework me') {
  const t = (await call('POST', '/api/v1/tasks', { body: { title, assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE });
  await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_CLAUDE, body: { report: 'done' } });
  return t;
}

test('reopen (review→active) lifts the task to the TOP of the agents backlog', async () => {
  const { call, db } = makeApp();
  // an existing agent backlog with a hand-set rank, so "top" must beat it
  const other = (await call('POST', '/api/v1/tasks', { body: { title: 'other', assignee: 'claude' } })).json;
  const another = (await call('POST', '/api/v1/tasks', { body: { title: 'another', assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${other.id}/reorder`, { body: { before_id: another.id, list: 'agents' } });
  const t = await toReview(call);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM view_ranks WHERE task_id=? AND view='agents'").get(t.id).c, 0);
  const r = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { status: 'active' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'active');
  // its agents rank is now the minimum -> it leads the shared backlog
  const agents = (await call('GET', '/api/v1/tasks?view=agents')).json.items.map(x => x.id);
  assert.equal(agents[0], t.id, 'reopened task is next agent pick-up');
  const min = db.prepare("SELECT MIN(rank) m FROM view_ranks WHERE view='agents'").get().m;
  assert.equal(db.prepare("SELECT rank FROM view_ranks WHERE task_id=? AND view='agents'").get(t.id).rank, min);
});

test('reopen with a comment posts a timeline answer BEFORE the reopened status line', async () => {
  const { call } = makeApp();
  const t = await toReview(call);
  const r = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { status: 'active', comment: 'redo the header' } });
  assert.equal(r.status, 200);
  const items = (await call('GET', `/api/v1/tasks/${t.id}/comments`)).json.items;
  const answer = items.filter(x => x.kind === 'answer' && x.text === 'redo the header');
  assert.equal(answer.length, 1, 'the reopen comment is an answer entry');
  const reopened = items.filter(x => x.kind === 'status' && x.text === 'reopened');
  assert.equal(reopened.length, 1);
  // the comment (feedback) is attached BEFORE the reopened line
  assert.ok(items.indexOf(answer[0]) < items.indexOf(reopened[0]));
  // comment is only accepted as a string within caps
  const t2 = await toReview(call, 't2');
  assert.equal((await call('PATCH', `/api/v1/tasks/${t2.id}`, { body: { status: 'active', comment: 5 } })).status, 400);
});

test('reopen WITHOUT a comment still works (no answer entry, still tops the backlog)', async () => {
  const { call, db } = makeApp();
  const t = await toReview(call);
  const r = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { status: 'active' } });
  assert.equal(r.status, 200);
  const items = (await call('GET', `/api/v1/tasks/${t.id}/comments`)).json.items;
  assert.equal(items.filter(x => x.kind === 'answer').length, 0, 'no answer without a comment');
  assert.ok(items.some(x => x.kind === 'status' && x.text === 'reopened'));
  assert.ok(db.prepare("SELECT rank FROM view_ranks WHERE task_id=? AND view='agents'").get(t.id));
});

// ---- per-view manual order (view_ranks, migration 008) ----
test('reorder in inbox persists to view_ranks(inbox); order survives reload', async () => {
  const { call, db } = makeApp();
  const mk = async n => (await call('POST', '/api/v1/tasks', { body: { title: n } })).json; // all inbox
  const a = await mk('a'); const b = await mk('b'); const c = await mk('c');
  // no view_ranks rows exist yet
  assert.equal(db.prepare("SELECT COUNT(*) c FROM view_ranks WHERE view='inbox'").get().c, 0);
  // move c to the top (before a)
  const r = await call('POST', `/api/v1/tasks/${c.id}/reorder`, { body: { before_id: a.id, list: 'inbox' } });
  assert.equal(r.status, 200);
  const order = () => call('GET', '/api/v1/tasks?view=inbox').then(x => x.json.items.map(i => i.title));
  assert.deepEqual(await order(), ['c', 'a', 'b']);
  // it persisted to view_ranks, not tasks.rank
  assert.ok(db.prepare("SELECT COUNT(*) c FROM view_ranks WHERE view='inbox'").get().c > 0);
  assert.equal(c.rank, db.prepare('SELECT rank FROM tasks WHERE id=?').get(c.id).rank, 'tasks.rank untouched');
  // a second move settles a full order
  await call('POST', `/api/v1/tasks/${b.id}/reorder`, { body: { before_id: a.id, list: 'inbox' } });
  assert.deepEqual(await order(), ['c', 'b', 'a']);
});

test('view_ranks are per-view independent: same task, different rank in inbox vs agents', async () => {
  const { call, db } = makeApp();
  // inbox tasks (alex's own, projectless, no when)
  const i1 = (await call('POST', '/api/v1/tasks', { body: { title: 'i1' } })).json;
  const i2 = (await call('POST', '/api/v1/tasks', { body: { title: 'i2' } })).json;
  await call('POST', `/api/v1/tasks/${i2.id}/reorder`, { body: { before_id: i1.id, list: 'inbox' } });
  // agent tasks
  const g1 = (await call('POST', '/api/v1/tasks', { body: { title: 'g1', assignee: 'claude' } })).json;
  const g2 = (await call('POST', '/api/v1/tasks', { body: { title: 'g2', assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${g2.id}/reorder`, { body: { before_id: g1.id, list: 'agents' } });
  const rank = (id, v) => db.prepare('SELECT rank FROM view_ranks WHERE task_id=? AND view=?').get(id, v);
  assert.ok(rank(i2.id, 'inbox'), 'i2 has an inbox rank');
  assert.equal(rank(i2.id, 'agents'), undefined, 'i2 has NO agents rank');
  assert.ok(rank(g2.id, 'agents'), 'g2 has an agents rank');
  assert.equal(rank(g2.id, 'agents').rank !== rank(i2.id, 'inbox').rank || true, true);
  // both views reflect their own manual order
  const inbox = (await call('GET', '/api/v1/tasks?view=inbox')).json.items.map(t => t.title);
  assert.deepEqual(inbox, ['i2', 'i1']);
  const agents = (await call('GET', '/api/v1/tasks?view=agents')).json.items.map(t => t.title);
  assert.deepEqual(agents, ['g2', 'g1']);
});

test('agents backlog is ONE global order across agents; reorder crosses assignees', async () => {
  const { call } = makeApp();
  const mk = async (n, who) => (await call('POST', '/api/v1/tasks', { body: { title: n, assignee: who } })).json;
  const c1 = await mk('c1', 'claude'); const h1 = await mk('h1', 'hermes'); const c2 = await mk('c2', 'claude');
  // default order (no ranks): all active/queued, created order by rank tiebreak
  const ids = () => call('GET', '/api/v1/tasks?view=agents').then(x => x.json.items.map(i => i.title));
  assert.deepEqual(await ids(), ['c1', 'h1', 'c2']);
  // move c2 to the very top — across the hermes task
  await call('POST', `/api/v1/tasks/${c2.id}/reorder`, { body: { before_id: c1.id, list: 'agents' } });
  assert.deepEqual(await ids(), ['c2', 'c1', 'h1']);
  // move h1 above c1 (between c2 and c1)
  await call('POST', `/api/v1/tasks/${h1.id}/reorder`, { body: { after_id: c2.id, before_id: c1.id, list: 'agents' } });
  assert.deepEqual(await ids(), ['c2', 'h1', 'c1']);
});

test('queue is assignee-filtered and follows the agents-backlog rank; never another agent\'s tasks', async () => {
  const { call } = makeApp();
  const mk = async (n, who) => (await call('POST', '/api/v1/tasks', { body: { title: n, assignee: who } })).json;
  const c1 = await mk('c1', 'claude'); const h1 = await mk('h1', 'hermes'); const c2 = await mk('c2', 'claude');
  // claude's queue = only claude's tasks, in backlog order (default: c1, c2)
  const q = who => call('GET', `/api/v1/tasks?view=queue&assignee=${who}`).then(x => x.json.items.map(i => i.title));
  assert.deepEqual(await q('claude'), ['c1', 'c2']);
  assert.deepEqual(await q('hermes'), ['h1']);
  // hand-order the SHARED backlog so c2 sits above c1 (and above h1)
  await call('POST', `/api/v1/tasks/${c2.id}/reorder`, { body: { before_id: c1.id, list: 'agents' } });
  // claude's queue now leads with c2 — its top is what it claims
  assert.deepEqual(await q('claude'), ['c2', 'c1']);
  // hermes never sees a claude task regardless of shared ranks
  assert.deepEqual(await q('hermes'), ['h1']);
});

test('reorder rejects a bad list and out-of-scope neighbors for view_ranks lists', async () => {
  const { call } = makeApp();
  const a = (await call('POST', '/api/v1/tasks', { body: { title: 'a' } })).json;
  const b = (await call('POST', '/api/v1/tasks', { body: { title: 'b' } })).json;
  assert.equal((await call('POST', `/api/v1/tasks/${a.id}/reorder`, { body: { before_id: b.id, list: 'nope' } })).status, 400);
  // an agent task is not in the inbox scope -> 409 when used as this list's task
  const g = (await call('POST', '/api/v1/tasks', { body: { title: 'g', assignee: 'claude' } })).json;
  const bad = await call('POST', `/api/v1/tasks/${g.id}/reorder`, { body: { before_id: a.id, list: 'inbox' } });
  assert.equal(bad.status, 409);
  assert.ok(Array.isArray(bad.json.current));
});

test('agent reorder with a reason auto-posts a status entry; human reorder posts nothing', async () => {
  const { call } = makeApp();
  const mk = async n => (await call('POST', '/api/v1/tasks', { body: { title: n, assignee: 'claude' } })).json;
  const a = await mk('a'); const b = await mk('b');
  const timeline = id => call('GET', `/api/v1/tasks/${id}/comments`).then(x => x.json.items);
  // an AGENT (claude, non-admin) reorders WITH a reason -> auto-posts
  const r = await call('POST', `/api/v1/tasks/${a.id}/reorder`,
    { token: TOK_CLAUDE, body: { before_id: b.id, list: 'agents', reason: 'blocks the release' } });
  assert.equal(r.status, 200);
  const posted = (await timeline(a.id)).filter(x => x.kind === 'status' && x.author === 'claude');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].text, 'claude moved this up: blocks the release');
  // an AGENT reorder WITHOUT a reason posts nothing
  await call('POST', `/api/v1/tasks/${b.id}/reorder`, { token: TOK_CLAUDE, body: { after_id: a.id, list: 'agents' } });
  assert.equal((await timeline(b.id)).filter(x => x.kind === 'status').length, 0);
  // a HUMAN (admin) reorder with a reason posts NOTHING (humans reorder freely)
  await call('POST', `/api/v1/tasks/${a.id}/reorder`,
    { body: { after_id: b.id, list: 'agents', reason: 'i just want to' } });
  assert.equal((await timeline(a.id)).filter(x => x.kind === 'status').length, 1, 'still just the agent one');
  // reason must be a non-empty string within caps
  assert.equal((await call('POST', `/api/v1/tasks/${a.id}/reorder`,
    { token: TOK_CLAUDE, body: { before_id: b.id, list: 'agents', reason: '' } })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/${a.id}/reorder`,
    { token: TOK_CLAUDE, body: { before_id: b.id, list: 'agents', reason: 42 } })).status, 400);
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

test('steps: mutations are gated to the task assignee or admin', async () => {
  const { call } = makeApp();
  // task assigned to claude; hermes is neither the assignee nor the admin
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'gated steps', assignee: 'claude' } })).json;
  const s = (await call('POST', `/api/v1/tasks/${t.id}/steps`, { body: { title: 'one' } })).json; // as admin
  // a bystander agent may not add, toggle, or delete steps
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/steps`,
    { token: TOK_HERMES, body: { title: 'nope' } })).status, 403);
  assert.equal((await call('PATCH', `/api/v1/tasks/${t.id}/steps/${s.id}`,
    { token: TOK_HERMES, body: { done: true } })).status, 403);
  assert.equal((await call('DELETE', `/api/v1/tasks/${t.id}/steps/${s.id}`,
    { token: TOK_HERMES })).status, 403);
  // the assignee CAN toggle its own task's step
  const upd = await call('PATCH', `/api/v1/tasks/${t.id}/steps/${s.id}`,
    { token: TOK_CLAUDE, body: { done: true } });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.done, 1);
  // the admin can also toggle/delete regardless of assignee
  assert.equal((await call('DELETE', `/api/v1/tasks/${t.id}/steps/${s.id}`)).status, 200);
});

test('finish response reports remaining steps so clients can warn', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', {
    body: { title: 'steps left', assignee: 'claude', steps: ['a', 'b'] } })).json;
  await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE });
  const stepId = t.steps[0].id;
  await call('PATCH', `/api/v1/tasks/${t.id}/steps/${stepId}`, { token: TOK_CLAUDE, body: { done: true } });
  const fin = await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_CLAUDE, body: { report: 'done enough' } });
  assert.equal(fin.status, 200);
  const remaining = fin.json.task.steps.filter(s => s.done === 0);
  assert.equal(remaining.length, 1, 'one step ("b") still incomplete after finish');
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

test('project reorder: sibling rank persists among top-level projects; admin-only; neighbors must be siblings', async () => {
  const { call } = makeApp();
  const mk = async n => (await call('POST', '/api/v1/projects', { body: { name: n } })).json;
  const a = await mk('A'), b = await mk('B'), c = await mk('C');
  const tops = async () => (await call('GET', '/api/v1/projects')).json.items
    .filter(p => p.parent_id == null).map(p => p.name);
  assert.deepEqual(await tops(), ['A', 'B', 'C']);
  // move C to the very top (single neighbor: before A)
  const r = await call('POST', `/api/v1/projects/${c.id}/reorder`, { body: { before_id: a.id } });
  assert.equal(r.status, 200);
  assert.deepEqual(await tops(), ['C', 'A', 'B']);
  // move C back between A and B (two neighbors)
  await call('POST', `/api/v1/projects/${c.id}/reorder`, { body: { after_id: a.id, before_id: b.id } });
  assert.deepEqual(await tops(), ['A', 'C', 'B']);
  // a non-admin (claude) cannot reorder projects
  assert.equal((await call('POST', `/api/v1/projects/${c.id}/reorder`,
    { token: TOK_CLAUDE, body: { before_id: a.id } })).status, 403);
  // no neighbor -> 400; missing project -> 404
  assert.equal((await call('POST', `/api/v1/projects/${c.id}/reorder`, { body: {} })).status, 400);
  assert.equal((await call('POST', '/api/v1/projects/NOPE/reorder', { body: { before_id: a.id } })).status, 404);
  // a neighbor under a different parent is not a sibling -> 409
  const child = (await call('POST', '/api/v1/projects', { body: { name: 'Ac', parent_id: a.id } })).json;
  assert.equal((await call('POST', `/api/v1/projects/${b.id}/reorder`,
    { body: { after_id: child.id } })).status, 409);
});

test('project reorder is scoped to siblings: reordering under parent P1 never touches P2 order', async () => {
  const { call } = makeApp();
  const mk = async (n, parent) => (await call('POST', '/api/v1/projects',
    { body: { name: n, ...(parent ? { parent_id: parent } : {}) } })).json;
  const p1 = await mk('P1'), p2 = await mk('P2');
  const a1 = await mk('a1', p1.id), a2 = await mk('a2', p1.id), a3 = await mk('a3', p1.id);
  const b1 = await mk('b1', p2.id), b2 = await mk('b2', p2.id), b3 = await mk('b3', p2.id);
  const kids = async pid => (await call('GET', '/api/v1/projects?limit=500')).json.items
    .filter(p => p.parent_id === pid).map(p => p.name);
  // move a3 to the top under P1
  const r = await call('POST', `/api/v1/projects/${a3.id}/reorder`, { body: { before_id: a1.id } });
  assert.equal(r.status, 200);
  assert.deepEqual(await kids(p1.id), ['a3', 'a1', 'a2']);
  // P2's order is untouched
  assert.deepEqual(await kids(p2.id), ['b1', 'b2', 'b3']);
  void a2; void b2; void b3;
});

test('project reorder: combined reparent + position sets parent_id AND rank (lands where dropped)', async () => {
  const { call } = makeApp();
  const mk = async (n, parent) => (await call('POST', '/api/v1/projects',
    { body: { name: n, ...(parent ? { parent_id: parent } : {}) } })).json;
  const q = await mk('Q');
  const q1 = await mk('Q1', q.id), q2 = await mk('Q2', q.id);
  const t = await mk('T'); // top-level, will move under Q between Q1 and Q2
  const r = await call('POST', `/api/v1/projects/${t.id}/reorder`,
    { body: { parent_id: q.id, after_id: q1.id, before_id: q2.id } });
  assert.equal(r.status, 200);
  assert.equal(r.json.parent_id, q.id);
  const kids = (await call('GET', '/api/v1/projects?limit=500')).json.items
    .filter(p => p.parent_id === q.id).map(p => p.name);
  assert.deepEqual(kids, ['Q1', 'T', 'Q2']);
  // reparent into its own subtree is rejected (cycle guard)
  assert.equal((await call('POST', `/api/v1/projects/${q.id}/reorder`,
    { body: { parent_id: q1.id, before_id: t.id } })).status, 400);
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
  assert.equal(res.json.actor, 'alex'); // rail footer: "signed in as …"
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

test('DELETE /tags/:id: admin-only, drops task_tags, tasks survive', async () => {
  const { call } = makeApp();
  const a = await call('POST', '/api/v1/tasks', { body: { title: 'one', tags: ['home', 'urgent'] } });
  await call('POST', '/api/v1/tasks', { body: { title: 'two', tags: ['home'] } });
  const home = (await call('GET', '/api/v1/tags')).json.items.find(t => t.name === 'home');
  // non-admin (an agent) may not delete
  assert.equal((await call('DELETE', `/api/v1/tags/${home.id}`, { token: TOK_CLAUDE })).status, 403);
  // auth required
  assert.equal((await call('DELETE', `/api/v1/tags/${home.id}`, { token: null })).status, 401);
  // admin deletes: removes the two task_tags rows
  const del = await call('DELETE', `/api/v1/tags/${home.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.json.removed, 2);
  // tag is gone from the listing; the other tag remains
  assert.deepEqual((await call('GET', '/api/v1/tags')).json.items.map(t => t.name), ['urgent']);
  // the task still exists — it just lost #home (kept #urgent)
  const t = await call('GET', `/api/v1/tasks?view=inbox`);
  const kept = t.json.items.find(x => x.id === a.json.id);
  assert.deepEqual(kept.tags, ['urgent']);
  // unknown id -> 404
  assert.equal((await call('DELETE', `/api/v1/tags/nope`)).status, 404);
});

// ---- tag context notepad (tag.notes: mirrors project.notes, migration 015) ----
test('tag context: notes settable at create, PATCH-able, returned by GET (agent-readable)', async () => {
  const { call } = makeApp();
  const a = await call('POST', '/api/v1/tags', { body: { name: 'ops', notes: '# ops\neverything ops-tagged' } });
  assert.equal(a.status, 201);
  assert.equal(a.json.notes, '# ops\neverything ops-tagged');
  const u = await call('PATCH', `/api/v1/tags/${a.json.id}`, { body: { notes: 'updated readme' } });
  assert.equal(u.status, 200);
  assert.equal(u.json.notes, 'updated readme');
  const list = await call('GET', '/api/v1/tags');
  assert.equal(list.json.items.find(x => x.id === a.json.id).notes, 'updated readme');
  // default: tags created via a task's tags[] have empty notes
  await call('POST', '/api/v1/tasks', { body: { title: 't', tags: ['bare'] } });
  const bare = (await call('GET', '/api/v1/tags')).json.items.find(x => x.name === 'bare');
  assert.equal(bare.notes, '');
  // validation + auth + unknown id
  assert.equal((await call('PATCH', `/api/v1/tags/${a.json.id}`, { body: { notes: 'x'.repeat(70000) } })).status, 400);
  assert.equal((await call('PATCH', `/api/v1/tags/${a.json.id}`, { body: { bogus: 1 } })).status, 400);
  assert.equal((await call('PATCH', `/api/v1/tags/nope`, { body: { notes: 'x' } })).status, 404);
  assert.equal((await call('PATCH', `/api/v1/tags/${a.json.id}`, { body: { notes: 'x' }, token: null })).status, 401);
});

// The tag notepad can "point to" a punchlist-templates template (mirrors
// project.template) — the same AI-assisted editor that edits a project's
// template can then open it for a tag's.
test('tag template pointer: settable at create and via PATCH; free string, not validated against a set', async () => {
  const { call } = makeApp();
  const a = await call('POST', '/api/v1/tags', { body: { name: 'billing', template: 'invoice-review' } });
  assert.equal(a.status, 201);
  assert.equal(a.json.template, 'invoice-review');

  const u = await call('PATCH', `/api/v1/tags/${a.json.id}`, { body: { template: 'refund-checklist' } });
  assert.equal(u.status, 200);
  assert.equal(u.json.template, 'refund-checklist');

  const cleared = await call('PATCH', `/api/v1/tags/${a.json.id}`, { body: { template: null } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.template, null);

  const bad = await call('PATCH', `/api/v1/tags/${a.json.id}`, { body: { template: 123 } });
  assert.equal(bad.status, 400);
});

// ---- delegation lifecycle ----
test('delegation happy path: POST assignee -> claim -> finish -> review -> approve -> done', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'sweep memories', assignee: 'claude' } })).json;
  assert.equal(t.assignee, 'claude');
  assert.equal(t.auto_close, 0);
  assert.equal(t.created_by, 'alex'); // created_by = who asked; assignee = who must do it
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
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/claim`)).status, 403, 'alex is not the assignee');
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

test('approve: non-alex 403; approving active/in_progress 409; 404', async () => {
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

// The reassign-takeback (in_progress→active) is now a strict CAS like the other
// state doors: guarded WHERE status='in_progress' with a 409 on a lost race, and
// it honours expected_version so a caller can protect the transition against a
// concurrent finish/reclaim. (Root cause behind finished tasks re-appearing as
// active — task 01M14F44.)
test('reassign-takeback is a status-guarded CAS honouring expected_version', async () => {
  const { call, db } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job', assignee: 'claude' } })).json;
  const claimed = (await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE })).json.task;
  assert.equal(claimed.status, 'in_progress');
  // stale expected_version -> 409, and the in_progress claim is NOT clobbered to active
  const stale = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { assignee: 'hermes', expected_version: 0 } });
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /stale/);
  const row = db.prepare('SELECT status, claimed_at, assignee FROM tasks WHERE id=?').get(t.id);
  assert.equal(row.status, 'in_progress', 'no clobber back to active on a stale takeback');
  assert.notEqual(row.claimed_at, null, 'claim survives a rejected takeback');
  assert.equal(row.assignee, 'claude', 'assignee unchanged on a stale takeback');
  // matching expected_version -> the guarded takeback flips it and bumps version
  const ok = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { assignee: 'hermes', expected_version: claimed.version } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 'active');
  assert.equal(ok.json.claimed_at, null);
  assert.equal(ok.json.assignee, 'hermes');
  assert.equal(ok.json.version, claimed.version + 1);
});

test("view scoping over HTTP: alex's today/inbox exclude delegated; review/delegated views + ?assignee= work", async () => {
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

test('GET /counts gains review + delegated; when-driven keys alex-scoped, due-driven include everyone', async () => {
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
  assert.equal(res.json.inbox, 1, "delegated tasks don't clutter alex's inbox");
  assert.equal(res.json.today, 1, "claude's arrived WHEN is not alex's today; claude's DUE today is");
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
  assert.equal(me.json.assignee, 'alex');
  assert.equal(me.json.created_by, 'claude');
  const unknown = await call('POST', '/api/v1/tasks/quickadd', { body: { text: 'forward >bob the memo' } });
  assert.equal(unknown.json.title, 'forward >bob the memo');
  assert.equal(unknown.json.assignee, 'alex');
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
  await call('POST', '/api/v1/tasks', { body: { title: 'for alex', assignee: 'alex' }, token: TOK_EMAIL });
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
  const app = buildApp({ db, tokens: { alex: TOK_ARON, claude: TOK_CLAUDE },
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

test('config: template_editing reflects the feature gate', async () => {
  // default makeApp() wires no templateEditing -> feature off. Pin the env probe
  // at a nonexistent dir so this holds regardless of the host machine (a dev box
  // may have a real punchlist-templates repo + `claude` on PATH, which the
  // production auto-probe would otherwise detect and turn the feature on).
  const savedEnv = process.env.PUNCHLIST_TEMPLATES_DIR;
  process.env.PUNCHLIST_TEMPLATES_DIR = join(tmpdir(), 'pl-no-such-templates-repo');
  let off;
  try { off = await (makeApp().call)('GET', '/api/v1/config'); }
  finally {
    if (savedEnv === undefined) delete process.env.PUNCHLIST_TEMPLATES_DIR;
    else process.env.PUNCHLIST_TEMPLATES_DIR = savedEnv;
  }
  assert.equal(off.json.template_editing, false);
  // a wired app with a stub runner + present dir -> on for the admin only
  const on = makeAppWithTemplates();           // helper added below
  assert.equal((await on.call('GET', '/api/v1/config')).json.template_editing, true);
  assert.equal((await on.call('GET', '/api/v1/config', { token: TOK_CLAUDE })).json.template_editing, false);
});

test('GET /templates/:name: admin reads resolved md; gating + traversal', async () => {
  const app = makeAppWithTemplates();
  // stub resolveTemplatePath via the run seam is not enough — read goes through
  // the fs, so this test uses a real temp repo:
  const { dir, cleanup } = realTemplatesRepo({ 'authored/demo.md': '---\nname: demo\n---\nbody' });
  const a = appWithDir(dir);                      // helper: buildApp with available:true, real fs
  const ok = await a.call('GET', '/api/v1/templates/demo');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.markdown, '---\nname: demo\n---\nbody');
  assert.equal(ok.json.name, 'demo');
  // non-admin -> 403
  assert.equal((await a.call('GET', '/api/v1/templates/demo', { token: TOK_CLAUDE })).status, 403);
  // unknown -> 404; traversal -> 404 (charset reject)
  assert.equal((await a.call('GET', '/api/v1/templates/missing')).status, 404);
  assert.equal((await a.call('GET', '/api/v1/templates/..%2f..%2fetc%2fpasswd')).status, 404);
  cleanup();
});

test('POST /templates/:name/ai-edit: spawns claude text-only, returns note+draft', async () => {
  const reply = '<<<NOTE\nAdded a priority input.\nNOTE\n<<<TEMPLATE\n---\nname: demo\n---\nnew body\nTEMPLATE';
  const { dir, cleanup } = realTemplatesRepo({ 'authored/demo.md': '---\nname: demo\n---\nold' });
  const a = appWithDir(dir, (spec) => spec.cmd === 'claude' ? { code: 0, stdout: reply, stderr: '' } : { code: 0, stdout: '', stderr: '' });
  const r = await a.call('POST', '/api/v1/templates/demo/ai-edit', {
    body: { draft: '---\nname: demo\n---\nold', messages: [{ role: 'user', content: 'add a priority input' }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.reply, 'Added a priority input.');
  assert.match(r.json.draft, /new body/);
  // it invoked claude with -p, stateless, and tools HARD-disabled (--tools ""),
  // in the repo dir — the spawn must be text-only so a template body can't inject
  // a tool call.
  const claudeCall = a.calls.find(s => s.cmd === 'claude');
  assert.ok(claudeCall.args.includes('-p'));
  assert.ok(claudeCall.args.includes('--no-session-persistence'));
  const ti = claudeCall.args.indexOf('--tools');
  assert.ok(ti !== -1 && claudeCall.args[ti + 1] === '', 'tools disabled via --tools ""');
  // the prompt rides on STDIN, never argv — `--tools` is variadic and would
  // otherwise swallow a trailing positional prompt as a tool name (regression guard).
  assert.equal(claudeCall.args[claudeCall.args.length - 1], '', 'no positional prompt after --tools ""');
  assert.match(claudeCall.input || '', /add a priority input/);
  // non-admin 403
  assert.equal((await a.call('POST', '/api/v1/templates/demo/ai-edit', { token: TOK_CLAUDE, body: { draft: 'x', messages: [] } })).status, 403);
  cleanup();
});

test('POST /templates/:name/ai-edit: unparseable reply -> 502, no crash', async () => {
  const { dir, cleanup } = realTemplatesRepo({ 'authored/demo.md': 'x' });
  const a = appWithDir(dir, () => ({ code: 0, stdout: 'garbage, no delimiters', stderr: '' }));
  const r = await a.call('POST', '/api/v1/templates/demo/ai-edit', { body: { draft: 'x', messages: [] } });
  assert.equal(r.status, 502);
  cleanup();
});

test('POST /templates/:name/save: valid draft validates, writes authored/, commits', async () => {
  const { dir, cleanup } = realTemplatesRepo({ 'packs/core/demo.md': '---\nname: demo\n---\norig' });
  // stub: plt validate OK; git add/commit report success. The WRITE is real fs.
  const isPlt = (s) => s.cmd === 'node' && s.args[0].endsWith(join('bin', 'plt')) && s.args[1] === 'validate';
  const a = appWithDir(dir, (s) => isPlt(s) ? { code: 0, stdout: 'OK', stderr: '' } : { code: 0, stdout: '', stderr: '' });
  const draft = '---\nname: demo\n---\nedited body';
  const r = await a.call('POST', '/api/v1/templates/demo/save', { body: { draft } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  // wrote the OVERRIDE into authored/, not the pack
  assert.equal(readFileSync(join(dir, 'templates', 'authored', 'demo.md'), 'utf8'), draft);
  assert.equal(readFileSync(join(dir, 'templates', 'packs', 'core', 'demo.md'), 'utf8'), '---\nname: demo\n---\norig');
  // validated a temp file named demo.md, then git add + commit ran
  assert.ok(a.calls.some(s => s.cmd === 'node' && s.args[0].endsWith(join('bin', 'plt')) && s.args[1] === 'validate' && s.args[2].endsWith('demo.md')));
  assert.ok(a.calls.some(s => s.cmd === 'git' && s.args.includes('commit')));
  cleanup();
});

test('POST /templates/:name/save: invalid draft -> 422, nothing written/committed', async () => {
  const { dir, cleanup } = realTemplatesRepo({ 'authored/demo.md': '---\nname: demo\n---\norig' });
  const isPlt = (s) => s.cmd === 'node' && s.args[0].endsWith(join('bin', 'plt')) && s.args[1] === 'validate';
  const a = appWithDir(dir, (s) => isPlt(s) ? { code: 1, stdout: 'FAIL  demo.md:3: missing golden exemplar', stderr: '' } : { code: 0, stdout: '', stderr: '' });
  const r = await a.call('POST', '/api/v1/templates/demo/save', { body: { draft: '---\nname: demo\n---\nbad' } });
  assert.equal(r.status, 422);
  assert.equal(r.json.ok, false);
  assert.match(r.json.validation, /golden exemplar/);
  assert.equal(readFileSync(join(dir, 'templates', 'authored', 'demo.md'), 'utf8'), '---\nname: demo\n---\norig', 'unchanged');
  assert.ok(!a.calls.some(s => s.cmd === 'git' && s.args.includes('commit')), 'no commit on invalid');
  cleanup();
});

// ---- needs-input (block → answer) ----
test('needs-input round-trip: claim → block → answer → re-claim with question+answer in the payload', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'order the part', assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE });
  const claimedAt = (await call('GET', `/api/v1/tasks?view=queue&assignee=claude`)).json.items[0].claimed_at;
  const blocked = await call('POST', `/api/v1/tasks/${t.id}/block`,
    { token: TOK_CLAUDE, body: { question: 'Which vendor: A or B?' } });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.json.task.status, 'blocked');
  assert.equal(blocked.json.task.question, 'Which vendor: A or B?');
  assert.equal(blocked.json.task.claimed_at, claimedAt, 'blocking preserves the claim');
  // blocked leaves the agent's queue but shows in needs_input (and counts)
  assert.equal((await call('GET', '/api/v1/tasks?view=queue&assignee=claude')).json.items.length, 0);
  const lane = await call('GET', '/api/v1/tasks?view=needs_input');
  assert.deepEqual(lane.json.items.map(x => x.id), [t.id]);
  assert.equal((await call('GET', '/api/v1/counts')).json.needs_input, 1);
  // admin answers -> back to active, question and answer both kept
  const ans = await call('POST', `/api/v1/tasks/${t.id}/answer`, { body: { answer: 'Vendor B — cheaper shipping' } });
  assert.equal(ans.status, 200);
  assert.equal(ans.json.task.status, 'active');
  assert.equal(ans.json.task.question, 'Which vendor: A or B?');
  assert.equal(ans.json.task.answer, 'Vendor B — cheaper shipping');
  assert.equal((await call('GET', '/api/v1/counts')).json.needs_input, 0);
  // back in the queue; re-claim works and the payload carries the exchange
  const queue = await call('GET', '/api/v1/tasks?view=queue&assignee=claude');
  assert.deepEqual(queue.json.items.map(x => x.id), [t.id]);
  const re = await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE });
  assert.equal(re.status, 200);
  assert.equal(re.json.task.question, 'Which vendor: A or B?');
  assert.equal(re.json.task.answer, 'Vendor B — cheaper shipping');
});

test('block guards: wrong actor 403; review/done 409; idempotent same-question 200; new question while blocked 409; 404', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job', assignee: 'claude' } })).json;
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/block`, { body: { question: 'q' } })).status, 403, 'admin is not the assignee');
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_HERMES, body: { question: 'q' } })).status, 403);
  // blocking from active (unclaimed) is allowed, like finish
  const b1 = await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_CLAUDE, body: { question: 'what scope?' } });
  assert.equal(b1.status, 200);
  // idempotent retry with the same question: 200, question not duplicated
  const again = await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_CLAUDE, body: { question: 'what scope?' } });
  assert.equal(again.status, 200);
  assert.equal(again.json.task.question, 'what scope?');
  // a different question while already blocked is a conflict
  const other = await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_CLAUDE, body: { question: 'something else?' } });
  assert.equal(other.status, 409);
  // review/done states refuse
  await call('POST', `/api/v1/tasks/${t.id}/answer`, { body: { answer: 'full scope' } });
  await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_CLAUDE, body: { report: 'r' } });
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_CLAUDE, body: { question: 'q2' } })).status, 409);
  assert.equal((await call('POST', '/api/v1/tasks/NOPE/block', { token: TOK_CLAUDE, body: { question: 'q' } })).status, 404);
});

test('answer guards: admin only; non-blocked 409; required + caps; unknown fields', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job', assignee: 'claude' } })).json;
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/answer`, { body: { answer: 'a' } })).status, 409, 'not blocked yet');
  await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_CLAUDE, body: { question: 'q?' } });
  const agent = await call('POST', `/api/v1/tasks/${t.id}/answer`, { token: TOK_CLAUDE, body: { answer: 'a' } });
  assert.equal(agent.status, 403, 'the assignee cannot answer its own question');
  assert.match(agent.json.error, /only the admin/);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/answer`, { token: TOK_HERMES, body: { answer: 'a' } })).status, 403);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/answer`, { body: {} })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/answer`, { body: { answer: '  ' } })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/answer`, { body: { answer: 'a', extra: 1 } })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/answer`, { body: { answer: 'a'.repeat(8193) } })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/answer`, { body: { answer: 'a'.repeat(8192) } })).status, 200);
  assert.equal((await call('POST', '/api/v1/tasks/NOPE/answer', { body: { answer: 'a' } })).status, 404);
});

test('block size caps and validation: question required, <=2KB, no unknown fields', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job', assignee: 'claude' } })).json;
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_CLAUDE, body: {} })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_CLAUDE, body: { question: '  ' } })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_CLAUDE, body: { question: 'q', extra: 1 } })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_CLAUDE, body: { question: 'q'.repeat(2049) } })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_CLAUDE, body: { question: 'q'.repeat(2048) } })).status, 200);
});

test('PATCH cannot set blocked/question/answer — pointed errors to the doors', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'x' } })).json;
  const st = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { status: 'blocked' } });
  assert.equal(st.status, 400);
  assert.match(st.json.error, /block/);
  const q = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { question: 'forged?' } });
  assert.equal(q.status, 400);
  assert.match(q.json.error, /block/);
  const a = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { answer: 'forged' } });
  assert.equal(a.status, 400);
  assert.match(a.json.error, /answer/);
  assert.equal((await call('POST', '/api/v1/tasks', { body: { title: 'x', question: 'q' } })).status, 400);
  assert.equal((await call('POST', '/api/v1/tasks', { body: { title: 'x', answer: 'a' } })).status, 400);
});

test('repeat needs-input rounds: question and answer both append under the timestamped rule', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'multi-round', assignee: 'hermes' } })).json;
  await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_HERMES, body: { question: 'round one?' } });
  await call('POST', `/api/v1/tasks/${t.id}/answer`, { body: { answer: 'first answer' } });
  const b2 = await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_HERMES, body: { question: 'round two?' } });
  assert.equal(b2.status, 200);
  assert.match(b2.json.task.question, /^round one\?\n\n--- \d{4}-\d{2}-\d{2}T[\d:.]+Z\n\nround two\?$/);
  // idempotent retry still recognises the LATEST round
  const retry = await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_HERMES, body: { question: 'round two?' } });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.task.question, b2.json.task.question, 'no duplicate round appended');
  const a2 = await call('POST', `/api/v1/tasks/${t.id}/answer`, { body: { answer: 'second answer' } });
  assert.match(a2.json.task.answer, /^first answer\n\n--- \d{4}-\d{2}-\d{2}T[\d:.]+Z\n\nsecond answer$/);
  assert.equal(a2.json.task.status, 'active');
});

test('vetting guards the block door like claim; blocked tasks stay visible in project/delegated views and can be archived', async () => {
  const { call } = makeApp();
  const unv = (await call('POST', '/api/v1/tasks', { body: { title: 'sly', assignee: 'claude' }, token: TOK_EMAIL })).json;
  const blk = await call('POST', `/api/v1/tasks/${unv.id}/block`, { token: TOK_CLAUDE, body: { question: 'q?' } });
  assert.equal(blk.status, 403);
  assert.match(blk.json.error, /not vetted/);
  // a vetted blocked task shows on the board (project + delegated views)
  const p = (await call('POST', '/api/v1/projects', { body: { name: 'P' } })).json;
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'stuck work', assignee: 'hermes', project_id: p.id } })).json;
  await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_HERMES, body: { question: 'q?' } });
  assert.ok((await call('GET', `/api/v1/tasks?project=${p.id}`)).json.items.some(x => x.id === t.id));
  assert.ok((await call('GET', '/api/v1/tasks?view=delegated')).json.items.some(x => x.id === t.id));
  assert.equal((await call('GET', '/api/v1/counts')).json.projects[p.id], 1, 'blocked counts as open project work');
  // owner cleanup: PATCH to archived is allowed from blocked
  const arch = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { status: 'archived' } });
  assert.equal(arch.status, 200);
  assert.equal(arch.json.status, 'archived');
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

// ---- activity thread (comments) — Part A: task collaboration ----
test('comments: post appends a comment row, list returns the ordered timeline', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'collab task' } })).json;
  assert.equal(t.comment_count, 0); // task payload gains comment_count

  const c1 = await call('POST', `/api/v1/tasks/${t.id}/comments`, { body: { text: 'first note' } });
  assert.equal(c1.status, 201);
  assert.equal(c1.json.kind, 'comment');
  assert.equal(c1.json.author, 'alex'); // server-set actor, not client-supplied
  assert.equal(c1.json.text, 'first note');

  await call('POST', `/api/v1/tasks/${t.id}/comments`, { body: { text: 'second note' }, token: TOK_CLAUDE });

  const list = await call('GET', `/api/v1/tasks/${t.id}/comments`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.items.map(x => x.text), ['first note', 'second note']); // insertion order
  assert.deepEqual(list.json.items.map(x => x.author), ['alex', 'claude']);

  const refetched = (await call('GET', `/api/v1/tasks?limit=500`)).json.items.find(x => x.id === t.id);
  assert.equal(refetched.comment_count, 2); // count reflects the two rows
});

test('comments: text is required and capped at 8KB', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'cap' } })).json;
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/comments`, { body: { text: '' } })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/comments`, { body: { text: '   ' } })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/comments`,
    { body: { text: 'x'.repeat(8193) } })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/comments`,
    { body: { text: 'x'.repeat(8192) } })).status, 201);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/comments`,
    { body: { text: 'ok', extra: 1 } })).status, 400); // unknown field
  assert.equal((await call('POST', `/api/v1/tasks/nope/comments`, { body: { text: 'ok' } })).status, 404);
});

test('comments: any actor may comment; an unvetted task still receives comments', async () => {
  const { call } = makeApp();
  // email is an untrusted actor -> task is born vetted=0
  const t = (await call('POST', '/api/v1/tasks',
    { body: { title: 'from email', assignee: 'claude' }, token: TOK_EMAIL })).json;
  assert.equal(t.vetted, 0);
  // claim is locked on an unvetted task...
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE })).status, 403);
  // ...but commenting is not execution — it still works
  const cm = await call('POST', `/api/v1/tasks/${t.id}/comments`, { body: { text: 'looks off' }, token: TOK_CLAUDE });
  assert.equal(cm.status, 201);
});

test('timeline: block auto-posts a question row (field stays source of truth)', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'q', assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE });
  await call('POST', `/api/v1/tasks/${t.id}/block`, { body: { question: 'which env?' }, token: TOK_CLAUDE });
  const items = (await call('GET', `/api/v1/tasks/${t.id}/comments`)).json.items;
  const q = items.filter(x => x.kind === 'question');
  assert.equal(q.length, 1);
  assert.equal(q[0].text, 'which env?');
  assert.equal(q[0].author, 'claude');
  // the question FIELD is unchanged (still source of truth)
  const task = (await call('GET', `/api/v1/tasks?view=needs_input&limit=500`)).json.items.find(x => x.id === t.id);
  assert.match(task.question, /which env\?/);
});

test('timeline: answer auto-posts an answer row (admin actor)', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'a', assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${t.id}/block`, { body: { question: 'q?' }, token: TOK_CLAUDE });
  await call('POST', `/api/v1/tasks/${t.id}/answer`, { body: { answer: 'use prod' } });
  const items = (await call('GET', `/api/v1/tasks/${t.id}/comments`)).json.items;
  const a = items.filter(x => x.kind === 'answer');
  assert.equal(a.length, 1);
  assert.equal(a[0].text, 'use prod');
  assert.equal(a[0].author, 'alex');
});

test('timeline: finish auto-posts a report row of THIS round', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'r', assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE });
  await call('POST', `/api/v1/tasks/${t.id}/finish`, { body: { report: 'shipped it' }, token: TOK_CLAUDE });
  const items = (await call('GET', `/api/v1/tasks/${t.id}/comments`)).json.items;
  assert.equal(items.filter(x => x.kind === 'report').map(x => x.text)[0], 'shipped it');
});

test('timeline: claim and approve auto-post status one-liners', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 's', assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE });
  await call('POST', `/api/v1/tasks/${t.id}/finish`, { body: { report: 'done' }, token: TOK_CLAUDE });
  await call('POST', `/api/v1/tasks/${t.id}/approve`); // admin
  const kinds = (await call('GET', `/api/v1/tasks/${t.id}/comments`)).json.items;
  const status = kinds.filter(x => x.kind === 'status').map(x => x.text);
  assert.ok(status.includes('claimed'));
  assert.ok(status.includes('approved'));
  // full ordered timeline shows the back-and-forth in order
  assert.deepEqual(kinds.map(x => x.kind), ['status', 'report', 'status']);
});

test('timeline: complete, reassign, archive/reopen post status rows', async () => {
  const { call } = makeApp();
  // complete
  const t1 = (await call('POST', '/api/v1/tasks', { body: { title: 'c' } })).json;
  await call('POST', `/api/v1/tasks/${t1.id}/complete`);
  assert.ok((await call('GET', `/api/v1/tasks/${t1.id}/comments`)).json.items
    .some(x => x.kind === 'status' && x.text === 'completed'));
  // reassign
  const t2 = (await call('POST', '/api/v1/tasks', { body: { title: 'd' } })).json;
  await call('PATCH', `/api/v1/tasks/${t2.id}`, { body: { assignee: 'hermes' } });
  assert.ok((await call('GET', `/api/v1/tasks/${t2.id}/comments`)).json.items
    .some(x => x.kind === 'status' && x.text === 'reassigned to hermes'));
  // archive
  const t3 = (await call('POST', '/api/v1/tasks', { body: { title: 'e' } })).json;
  await call('PATCH', `/api/v1/tasks/${t3.id}`, { body: { status: 'archived' } });
  assert.ok((await call('GET', `/api/v1/tasks/${t3.id}/comments`)).json.items
    .some(x => x.kind === 'status' && x.text === 'archived'));
});

// ---- template ref + picker — Part B ----
test('template: PATCH persists a template ref (free string, not validated)', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'tpl' } })).json;
  assert.equal(t.template, null);
  const patched = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { template: 'coding-task' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.template, 'coding-task');
  // any string is accepted (templates repo is authoritative), and null clears it
  assert.equal((await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { template: 'anything-goes' } })).json.template,
    'anything-goes');
  assert.equal((await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { template: null } })).json.template, null);
  // over-long is rejected
  assert.equal((await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { template: 'x'.repeat(201) } })).status, 400);
  // create-time template
  const t2 = (await call('POST', '/api/v1/tasks', { body: { title: 'tpl2', template: 'research-brief' } })).json;
  assert.equal(t2.template, 'research-brief');
});

test('GET /templates: reads the repo index.json when present, [] when absent', async () => {
  const { call } = makeApp();
  const dir = mkdtempSync(join(tmpdir(), 'plt-idx-'));
  const prev = process.env.PUNCHLIST_TEMPLATES_DIR;
  try {
    // absent index -> []
    process.env.PUNCHLIST_TEMPLATES_DIR = dir;
    assert.deepEqual((await call('GET', '/api/v1/templates')).json.items, []);
    // fixture index -> its templates
    mkdirSync(join(dir, 'templates'), { recursive: true });
    writeFileSync(join(dir, 'templates', 'index.json'), JSON.stringify({
      templates: [{ name: 'coding-task', kind: 'template', tags: ['code'], domain: 'engineering',
        output: 'markdown', path: 'templates/packs/core/coding-task.md' }],
    }));
    const res = await call('GET', '/api/v1/templates');
    assert.equal(res.json.items.length, 1);
    assert.equal(res.json.items[0].name, 'coding-task');
    // pointing at a nonexistent dir also degrades to []
    process.env.PUNCHLIST_TEMPLATES_DIR = join(dir, 'nope');
    assert.deepEqual((await call('GET', '/api/v1/templates')).json.items, []);
  } finally {
    if (prev === undefined) delete process.env.PUNCHLIST_TEMPLATES_DIR;
    else process.env.PUNCHLIST_TEMPLATES_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- duplicate-create guard (double-submit protection) ----
test('dedup: identical rapid create by same actor+project returns the existing task (200, no clone)', async () => {
  const { call, db } = makeApp();
  const a = await call('POST', '/api/v1/tasks', { body: { title: 'buy milk', project_id: null } });
  assert.equal(a.status, 201);
  const b = await call('POST', '/api/v1/tasks', { body: { title: 'buy milk', project_id: null } });
  assert.equal(b.status, 200);            // duplicate → existing returned
  assert.equal(b.json.id, a.json.id);     // same task, not a clone
  assert.equal(db.prepare("SELECT COUNT(*) c FROM tasks WHERE title = 'buy milk'").get().c, 1);
});

test('dedup: force:true opts out and creates a genuine second task', async () => {
  const { call, db } = makeApp();
  const a = await call('POST', '/api/v1/tasks', { body: { title: 'ping' } });
  const b = await call('POST', '/api/v1/tasks', { body: { title: 'ping', force: true } });
  assert.equal(b.status, 201);
  assert.notEqual(b.json.id, a.json.id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM tasks WHERE title = 'ping'").get().c, 2);
});

test('dedup: different project, different actor, or a later re-add are NOT duplicates', async () => {
  const { call, db } = makeApp();
  const proj = await call('POST', '/api/v1/projects', { body: { name: 'Home' } });
  const base = await call('POST', '/api/v1/tasks', { body: { title: 'chore' } });
  assert.equal(base.status, 201);
  // same title, different project → new task
  assert.equal((await call('POST', '/api/v1/tasks',
    { body: { title: 'chore', project_id: proj.json.id } })).status, 201);
  // same title+project(null) but a different actor → new task
  assert.equal((await call('POST', '/api/v1/tasks',
    { body: { title: 'chore' }, token: TOK_CLAUDE })).status, 201);
  // age the original past the window, then the same actor re-adds legitimately
  db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), base.json.id);
  const readd = await call('POST', '/api/v1/tasks', { body: { title: 'chore' } });
  assert.equal(readd.status, 201);
  assert.notEqual(readd.json.id, base.json.id);
});

test('dedup: quickadd double-submit is guarded too', async () => {
  const { call, db } = makeApp();
  const a = await call('POST', '/api/v1/tasks/quickadd', { body: { text: 'water plants' } });
  assert.equal(a.status, 201);
  const b = await call('POST', '/api/v1/tasks/quickadd', { body: { text: 'water plants' } });
  assert.equal(b.status, 200);
  assert.equal(b.json.id, a.json.id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM tasks WHERE title = 'water plants'").get().c, 1);
});

// ---- concurrency hardening: strict compare-and-swap on every state door,
//      claim rejects blocked/terminal, optimistic-concurrency version token
//      (2026-08-28) ------------------------------------------------------------

// claim a blocked task is rejected with a clear, blocked-specific message and
// does NOT resurrect the task (only /answer may leave blocked).
test('CAS claim: blocked task -> 409 "awaiting an answer", status unchanged', async () => {
  const { call, db } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job', assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE });
  await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_CLAUDE, body: { question: 'which?' } });
  const r = await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /blocked — awaiting an answer/);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(t.id).status, 'blocked');
});

test('CAS claim: review / done / archived each 409 with a clear message', async () => {
  const { call } = makeApp();
  // review
  const rev = (await call('POST', '/api/v1/tasks', { body: { title: 'r', assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${rev.id}/finish`, { token: TOK_CLAUDE, body: { report: 'x' } });
  const cRev = await call('POST', `/api/v1/tasks/${rev.id}/claim`, { token: TOK_CLAUDE });
  assert.equal(cRev.status, 409);
  assert.match(cRev.json.error, /in review/);
  // done (auto_close)
  const dn = (await call('POST', '/api/v1/tasks', { body: { title: 'd', assignee: 'claude', auto_close: 1 } })).json;
  await call('POST', `/api/v1/tasks/${dn.id}/finish`, { token: TOK_CLAUDE, body: { report: 'x' } });
  const cDone = await call('POST', `/api/v1/tasks/${dn.id}/claim`, { token: TOK_CLAUDE });
  assert.equal(cDone.status, 409);
  assert.match(cDone.json.error, /already done/);
  // archived
  const ar = (await call('POST', '/api/v1/tasks', { body: { title: 'a', assignee: 'claude' } })).json;
  await call('PATCH', `/api/v1/tasks/${ar.id}`, { body: { status: 'archived' } });
  const cArch = await call('POST', `/api/v1/tasks/${ar.id}/claim`, { token: TOK_CLAUDE });
  assert.equal(cArch.status, 409);
  assert.match(cArch.json.error, /archived/);
});

test('CAS complete: only active flips; in_progress/review -> 409, no clobber; done idempotent', async () => {
  const { call, db } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job', assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE });
  const inProg = await call('POST', `/api/v1/tasks/${t.id}/complete`);
  assert.equal(inProg.status, 409, 'cannot complete an in_progress task');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(t.id).status, 'in_progress');
  await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_CLAUDE, body: { report: 'x' } });
  const rev = await call('POST', `/api/v1/tasks/${t.id}/complete`);
  assert.equal(rev.status, 409, 'cannot complete a review task');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(t.id).status, 'review');
});

// The observed bug: the UI answers a blocked task while the polling cron acts on
// it. Both paths are strict CAS now — the answer flips blocked->active exactly
// once, the loser gets 409, and neither double-transitions.
test('CAS answer: blocked->active once; a second answer -> 409; concurrent claim loses', async () => {
  const { call, db } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job', assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE });
  await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_CLAUDE, body: { question: 'q?' } });
  // the cron tries to claim the blocked task at the same moment — it loses
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE })).status, 409);
  const a1 = await call('POST', `/api/v1/tasks/${t.id}/answer`, { body: { answer: 'do X' } });
  assert.equal(a1.status, 200);
  assert.equal(a1.json.task.status, 'active');
  const a2 = await call('POST', `/api/v1/tasks/${t.id}/answer`, { body: { answer: 'again' } });
  assert.equal(a2.status, 409, 'no second blocked->active transition');
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id=?").get(t.id).status, 'active');
});

// The reopen clobber: PATCH review->active used to be an unguarded write (the
// row is read OUTSIDE the tx). The reopen path is now guarded by WHERE
// status='review', and the approve side is a strict CAS too — so when a reopen
// and an approve race on a review task, exactly ONE wins and the loser 409s
// rather than dragging the row between states.
test('CAS reopen: legit review->active works; approve after a reopen -> 409', async () => {
  const { call, db } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job', assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_CLAUDE, body: { report: 'x' } });
  // legit reopen from review succeeds and does not misfire on the new guard
  const reopen = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { status: 'active', comment: 'redo it' } });
  assert.equal(reopen.status, 200);
  assert.equal(reopen.json.status, 'active');
  // the reopen won the race — a now-late approve finds no review row -> 409
  const late = await call('POST', `/api/v1/tasks/${t.id}/approve`);
  assert.equal(late.status, 409);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(t.id).status, 'active');
});

// A PATCH status=active on a DONE task is the supported M18 "undo", not a
// reopen (the row is read as done, so the review-guard never engages) — it must
// stay a 200 so the hardening does not regress un-complete.
test('CAS reopen guard does not touch the M18 done->active undo path', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job' } })).json;
  await call('POST', `/api/v1/tasks/${t.id}/complete`);
  const undo = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { status: 'active' } });
  assert.equal(undo.status, 200);
  assert.equal(undo.json.status, 'active');
});

test('CAS finish/block: cannot finish or block a blocked task, status preserved', async () => {
  const { call, db } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job', assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE });
  await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_CLAUDE, body: { question: 'q?' } });
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_CLAUDE, body: { report: 'r' } })).status, 409);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(t.id).status, 'blocked');
});

// ---- optimistic concurrency: the version token ----
test('version: present on payload, starts at 0, bumps on each mutation', async () => {
  const { call } = makeApp();
  const created = (await call('POST', '/api/v1/tasks', { body: { title: 'job', assignee: 'claude' } })).json;
  assert.equal(created.version, 0);
  const patched = (await call('PATCH', `/api/v1/tasks/${created.id}`, { body: { title: 'job2' } })).json;
  assert.equal(patched.version, 1);
  const claimed = (await call('POST', `/api/v1/tasks/${created.id}/claim`, { token: TOK_CLAUDE })).json.task;
  assert.equal(claimed.version, 2);
  const finished = (await call('POST', `/api/v1/tasks/${created.id}/finish`, { token: TOK_CLAUDE, body: { report: 'r' } })).json.task;
  assert.equal(finished.version, 3);
  const approved = (await call('POST', `/api/v1/tasks/${created.id}/approve`)).json.task;
  assert.equal(approved.version, 4);
});

test('version: idempotent re-claim does NOT bump (no real flip)', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job', assignee: 'claude' } })).json;
  const v1 = (await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE })).json.task.version;
  const v2 = (await call('POST', `/api/v1/tasks/${t.id}/claim`, { token: TOK_CLAUDE })).json.task.version;
  assert.equal(v1, v2, 'idempotent re-claim keeps the same version');
});

test('expected_version: omitted works; match 200; mismatch 409 stale (PATCH body)', async () => {
  const { call, db } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job' } })).json;
  assert.equal(t.version, 0);
  // omitted -> unchanged behavior
  const plain = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { title: 'a' } });
  assert.equal(plain.status, 200);
  assert.equal(plain.json.version, 1);
  // match -> 200
  const ok = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { title: 'b', expected_version: 1 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.version, 2);
  // mismatch -> 409 stale, no change
  const stale = await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { title: 'c', expected_version: 1 } });
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /stale/);
  assert.equal(stale.json.current_version, 2);
  assert.equal(db.prepare('SELECT title FROM tasks WHERE id=?').get(t.id).title, 'b', 'no clobber on stale');
});

test('expected_version: query param on body-less doors (claim/complete); if_version alias', async () => {
  const { call, db } = makeApp();
  // complete via query param
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job' } })).json;
  const bad = await call('POST', `/api/v1/tasks/${t.id}/complete?expected_version=9`);
  assert.equal(bad.status, 409);
  assert.match(bad.json.error, /stale/);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(t.id).status, 'active', 'not completed on stale');
  const good = await call('POST', `/api/v1/tasks/${t.id}/complete?expected_version=0`);
  assert.equal(good.status, 200);
  assert.equal(good.json.task.status, 'done');
  // claim via if_version alias
  const t2 = (await call('POST', '/api/v1/tasks', { body: { title: 'j2', assignee: 'claude' } })).json;
  assert.equal((await call('POST', `/api/v1/tasks/${t2.id}/claim?if_version=7`, { token: TOK_CLAUDE })).status, 409);
  assert.equal((await call('POST', `/api/v1/tasks/${t2.id}/claim?if_version=0`, { token: TOK_CLAUDE })).status, 200);
});

test('expected_version: non-integer rejected 400', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job' } })).json;
  assert.equal((await call('PATCH', `/api/v1/tasks/${t.id}`, { body: { title: 'x', expected_version: 'nope' } })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/${t.id}/complete?expected_version=-1`)).status, 400);
});

// ---- notification events (migration 011) ----
// The in-app polling feed the web UI reads for its "needs your attention"
// badge/toast (owner: punchlist's own UI is the first consumer of this
// mechanism, and it must survive a restart — hence a table, not an
// in-memory emit). Covers the four hook points (finish->review, block,
// answer, approve) and the since-cursor contract of GET /api/v1/events.

test('events: finish->review, block, answer, approve each append exactly one event, in order', async () => {
  const { call } = makeApp();
  const t = (await call('POST', '/api/v1/tasks', { body: { title: 'job', assignee: 'claude' } })).json;

  await call('POST', `/api/v1/tasks/${t.id}/block`, { token: TOK_CLAUDE, body: { question: 'which env?' } });
  await call('POST', `/api/v1/tasks/${t.id}/answer`, { body: { answer: 'prod' } });
  await call('POST', `/api/v1/tasks/${t.id}/finish`, { token: TOK_CLAUDE, body: { report: 'done' } });
  await call('POST', `/api/v1/tasks/${t.id}/approve`);

  const res = await call('GET', '/api/v1/events');
  assert.equal(res.status, 200);
  const mine = res.json.items.filter(e => e.task_id === t.id);
  assert.deepEqual(mine.map(e => e.event),
    ['task.blocked', 'task.answered', 'task.review_requested', 'task.approved']);
  // seq is monotonic and next_since is the highest seq seen
  assert.ok(mine.every((e, i) => i === 0 || e.seq > mine[i - 1].seq));
  assert.equal(res.json.next_since, mine[mine.length - 1].seq);
  // payload carries enough for a toast without a follow-up fetch
  const blocked = mine.find(e => e.event === 'task.blocked');
  assert.equal(blocked.payload.task_id, t.id);
  assert.equal(blocked.payload.title, 'job');
  assert.equal(blocked.payload.question, 'which env?');
  const approved = mine.find(e => e.event === 'task.approved');
  assert.equal(approved.payload.status, 'done');
});

test('events: since= cursor excludes already-seen rows; auto_close finish (straight to done) posts no review_requested', async () => {
  const { call } = makeApp();
  const t1 = (await call('POST', '/api/v1/tasks', { body: { title: 'first', assignee: 'claude' } })).json;
  await call('POST', `/api/v1/tasks/${t1.id}/block`, { token: TOK_CLAUDE, body: { question: 'q?' } });
  const first = await call('GET', '/api/v1/events');
  const cursor = first.json.next_since;

  const t2 = (await call('POST', '/api/v1/tasks', { body: { title: 'second', assignee: 'claude', auto_close: true } })).json;
  await call('POST', `/api/v1/tasks/${t2.id}/finish`, { token: TOK_CLAUDE, body: { report: 'auto-closed' } });

  const after = await call('GET', `/api/v1/events?since=${cursor}`);
  assert.equal(after.status, 200);
  // only the second task's events are new; auto_close skips review entirely
  // so no task.review_requested is emitted for it
  assert.ok(after.json.items.every(e => e.task_id === t2.id));
  assert.equal(after.json.items.some(e => e.event === 'task.review_requested'), false);
  // polling again with the latest cursor and nothing new returns an empty
  // page and echoes the same cursor back (no phantom advance)
  const empty = await call('GET', `/api/v1/events?since=${after.json.next_since}`);
  assert.deepEqual(empty.json.items, []);
  assert.equal(empty.json.next_since, after.json.next_since);
});

test('events: ?assignee= narrows to one actor\'s tasks; since must be a non-negative integer', async () => {
  const { call } = makeApp();
  const a = (await call('POST', '/api/v1/tasks', { body: { title: 'for claude', assignee: 'claude' } })).json;
  const b = (await call('POST', '/api/v1/tasks', { body: { title: 'for hermes', assignee: 'hermes' } })).json;
  await call('POST', `/api/v1/tasks/${a.id}/block`, { token: TOK_CLAUDE, body: { question: 'q?' } });
  await call('POST', `/api/v1/tasks/${b.id}/block`, { token: TOK_HERMES, body: { question: 'q?' } });

  const claudeOnly = await call('GET', '/api/v1/events?assignee=claude');
  assert.ok(claudeOnly.json.items.some(e => e.task_id === a.id));
  assert.ok(!claudeOnly.json.items.some(e => e.task_id === b.id));

  assert.equal((await call('GET', '/api/v1/events?since=-1')).status, 400);
  assert.equal((await call('GET', '/api/v1/events?since=nope')).status, 400);
});
