// dispatch-emit.test.js — Increment 2: buildApp emits 'task.changed' on the
// mutations that can produce a claimable state (create, reassign, vet) and via
// postEvent (finish→review). The bus is injected so we can subscribe a spy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { open } from '../src/db.js';
import { buildApp } from '../src/api.js';

const TOK_ARON = 'a'.repeat(32), TOK_CLAUDE = 'c'.repeat(32), TOK_EMAIL = 'e'.repeat(32);

function makeApp() {
  const { db, migrate } = open(':memory:'); migrate();
  const bus = new EventEmitter();
  const seen = [];
  bus.on('task.changed', e => seen.push(e));
  const app = buildApp({
    db, tokens: { alex: TOK_ARON, claude: TOK_CLAUDE, email: TOK_EMAIL },
    untrusted: new Set(['email']), bus, today: () => '2026-03-10',
  });
  const call = async (method, path, { body, token = TOK_ARON } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await app.fetch(new Request(`http://x${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }));
    let json = null; try { json = await res.json(); } catch { /* non-json */ }
    return { status: res.status, json };
  };
  return { call, seen };
}

test('create emits task.changed (assignee + active status)', async () => {
  const { call, seen } = makeApp();
  const r = await call('POST', '/api/v1/tasks', { body: { title: 'do a thing', assignee: 'claude' } });
  assert.equal(r.status, 201);
  const ev = seen.find(e => e.id === r.json.id);
  assert.ok(ev, 'emitted for the created task');
  assert.equal(ev.assignee, 'claude');
  assert.equal(ev.status, 'active');
});

test('reassign (PATCH) emits task.changed with the new assignee', async () => {
  const { call, seen } = makeApp();
  const c = await call('POST', '/api/v1/tasks', { body: { title: 't', assignee: 'alex' } });
  seen.length = 0;
  const r = await call('PATCH', `/api/v1/tasks/${c.json.id}`, { body: { assignee: 'claude' } });
  assert.equal(r.status, 200);
  const ev = seen.find(e => e.id === c.json.id);
  assert.ok(ev); assert.equal(ev.assignee, 'claude');
});

test('vet emits task.changed', async () => {
  const { call, seen } = makeApp();
  const c = await call('POST', '/api/v1/tasks', { body: { title: 'from email', assignee: 'claude' }, token: TOK_EMAIL });
  seen.length = 0;
  const r = await call('POST', `/api/v1/tasks/${c.json.id}/vet`);
  assert.equal(r.status, 200);
  assert.ok(seen.find(e => e.id === c.json.id), 'vetting emitted task.changed');
});

test('a postEvent transition (finish→review) emits task.changed', async () => {
  const { call, seen } = makeApp();
  const c = await call('POST', '/api/v1/tasks', { body: { title: 'work', assignee: 'claude' } });
  await call('POST', `/api/v1/tasks/${c.json.id}/claim`, { token: TOK_CLAUDE });
  seen.length = 0;
  const r = await call('POST', `/api/v1/tasks/${c.json.id}/finish`, { token: TOK_CLAUDE, body: { report: 'done, see X' } });
  assert.equal(r.status, 200);
  const ev = seen.find(e => e.id === c.json.id);
  assert.ok(ev, 'finish emitted task.changed'); assert.equal(ev.status, 'review');
});
