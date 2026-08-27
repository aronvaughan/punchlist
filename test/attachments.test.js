// attachments.test.js — image attachments: magic-byte validation, size cap,
// upload→list→get roundtrip, delete (file+row), retention PATCH, the retention
// reaper (on_done + expires_at), and delete authorization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/db.js';
import { buildApp } from '../src/api.js';
import { reap } from '../src/reap.js';
import { filePathFor } from '../src/media.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TOK_ARON = 'a'.repeat(32);
const TOK_CLAUDE = 'c'.repeat(32);
const TODAY = '2026-03-10';

// A real 1x1 PNG (valid signature + IHDR/IDAT/IEND).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
// JPEG SOI marker (FF D8 FF) + arbitrary payload + EOI — the sniff keys on the
// first three bytes; the stored bytes are verbatim, so a roundtrip is exact.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF-ish body'), Buffer.from([0xff, 0xd9])]);
const GIF = Buffer.from('GIF89a' + '\x01\x00\x01\x00' + 'junkjunkjunk');
const TXT = Buffer.from('hello, this is definitely not an image at all');

function makeApp({ maxUpload } = {}) {
  const { db, migrate } = open(':memory:');
  migrate();
  const mediaDir = mkdtempSync(join(tmpdir(), 'punchlist-media-'));
  const app = buildApp({
    db, tokens: { alex: TOK_ARON, claude: TOK_CLAUDE }, today: () => TODAY, mediaDir, maxUpload });

  const call = async (method, path, { body, token = TOK_ARON } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await app.fetch(new Request(`http://x${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };

  const upload = async (taskId, buf,
    { token = TOK_ARON, contentType = null, filename = 'pic.png', query = '' } = {}) => {
    const headers = { Authorization: `Bearer ${token}` };
    if (contentType) headers['Content-Type'] = contentType;
    if (filename !== null) headers['X-Filename'] = filename;
    const res = await app.fetch(new Request(`http://x/api/v1/tasks/${taskId}/attachments${query}`,
      { method: 'POST', headers, body: buf }));
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };

  const getBytes = async (id, token = TOK_ARON) => {
    const res = await app.fetch(new Request(`http://x/api/v1/attachments/${id}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} }));
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf, headers: res.headers };
  };

  const newTask = async (title = 'shot', token = TOK_ARON) =>
    (await call('POST', '/api/v1/tasks', { body: { title }, token })).json;

  return { db, app, call, upload, getBytes, newTask, mediaDir,
    cleanup: () => rmSync(mediaDir, { recursive: true, force: true }) };
}

// ---- magic-byte validation ----
test('upload: PNG and JPEG accepted; GIF and text rejected 415', async () => {
  const a = makeApp();
  const task = await a.newTask();
  assert.equal((await a.upload(task.id, PNG, { contentType: 'image/png' })).status, 201);
  assert.equal((await a.upload(task.id, JPEG, { contentType: 'image/jpeg', filename: 'p.jpg' })).status, 201);
  const gif = await a.upload(task.id, GIF, { contentType: 'image/gif', filename: 'x.gif' });
  assert.equal(gif.status, 415);
  assert.match(gif.json.error, /only JPEG and PNG/);
  assert.equal((await a.upload(task.id, TXT, { contentType: 'text/plain', filename: 'x.txt' })).status, 415);
  // sniff is authoritative: a text file RENAMED to .png with an image mime is
  // still rejected on its bytes
  assert.equal((await a.upload(task.id, TXT, { contentType: 'image/png', filename: 'evil.png' })).status, 415);
  a.cleanup();
});

test('upload: declared mime that disagrees with the sniffed bytes is 415', async () => {
  const a = makeApp();
  const task = await a.newTask();
  const r = await a.upload(task.id, PNG, { contentType: 'image/jpeg', filename: 'lie.jpg' });
  assert.equal(r.status, 415);
  assert.match(r.json.error, /does not match/);
  // no Content-Type at all is fine — the sniff decides
  assert.equal((await a.upload(task.id, PNG, { contentType: null })).status, 201);
  a.cleanup();
});

test('upload: empty body is 400; unknown task is 404', async () => {
  const a = makeApp();
  const task = await a.newTask();
  assert.equal((await a.upload(task.id, Buffer.alloc(0))).status, 400);
  assert.equal((await a.upload('NOSUCHTASK', PNG)).status, 404);
  a.cleanup();
});

// ---- size cap (separate from + larger than the JSON body cap) ----
test('upload: over the byte cap is rejected 413', async () => {
  const a = makeApp({ maxUpload: PNG.length - 1 });
  const task = await a.newTask();
  const r = await a.upload(task.id, PNG, { contentType: 'image/png' });
  assert.equal(r.status, 413);
  assert.match(r.json.error, /upload cap/);
  // a file at/under the cap still goes through
  const b = makeApp({ maxUpload: PNG.length });
  const t2 = await b.newTask();
  assert.equal((await b.upload(t2.id, PNG, { contentType: 'image/png' })).status, 201);
  a.cleanup(); b.cleanup();
});

// ---- roundtrip: upload → list → get bytes ----
test('roundtrip: upload, list metadata, stream bytes back exactly', async () => {
  const a = makeApp();
  const task = await a.newTask();
  const up = await a.upload(task.id, PNG, { contentType: 'image/png', filename: 'screenshot.png' });
  assert.equal(up.status, 201);
  assert.equal(up.json.mime, 'image/png');
  assert.equal(up.json.bytes, PNG.length);
  assert.equal(up.json.filename, 'screenshot.png');
  assert.equal(up.json.retention, 'keep');
  assert.equal(up.json.created_by, 'alex'); // server-set from the token

  const list = await a.call('GET', `/api/v1/tasks/${task.id}/attachments`);
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].id, up.json.id);

  // the task now carries a non-zero attachment_count (drives the row 📎 chip)
  const t = await a.call('GET', `/api/v1/tasks?view=inbox`);
  assert.equal(t.json.items.find(x => x.id === task.id).attachment_count, 1);

  const got = await a.getBytes(up.json.id);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('Content-Type'), 'image/png');
  assert.equal(got.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(got.headers.get('Content-Disposition'), /^inline; filename="screenshot\.png"$/);
  assert.ok(got.buf.equals(PNG), 'bytes returned match bytes uploaded');
  // the bytes really live on disk under <id>.<ext>
  assert.ok(existsSync(filePathFor(a.mediaDir, up.json.id, 'image/png')));
  a.cleanup();
});

test('get: unknown attachment 404; auth required', async () => {
  const a = makeApp();
  assert.equal((await a.getBytes('NOPE')).status, 404);
  assert.equal((await a.getBytes('NOPE', null)).status, 401);
  a.cleanup();
});

// ---- delete: removes file + row, uploader or admin only ----
test('delete: uploader removes file+row (bytes + list entry gone)', async () => {
  const a = makeApp();
  const task = await a.newTask();
  const up = await a.upload(task.id, PNG, { contentType: 'image/png', token: TOK_CLAUDE });
  const path = filePathFor(a.mediaDir, up.json.id, 'image/png');
  assert.ok(existsSync(path));

  // uploader (claude) can delete their own
  const del = await a.call('DELETE', `/api/v1/attachments/${up.json.id}`, { token: TOK_CLAUDE });
  assert.equal(del.status, 200);
  assert.ok(!existsSync(path), 'file unlinked');
  assert.equal((await a.getBytes(up.json.id)).status, 404);
  assert.equal((await a.call('GET', `/api/v1/tasks/${task.id}/attachments`)).json.items.length, 0);
  assert.equal((await a.call('DELETE', `/api/v1/attachments/NOPE`)).status, 404);
  a.cleanup();
});

test('delete: a non-uploader non-admin actor is 403; admin can delete', async () => {
  const { db, migrate } = open(':memory:');
  migrate();
  const mediaDir = mkdtempSync(join(tmpdir(), 'punchlist-media-'));
  const TOK_H = 'h'.repeat(32);
  const app = buildApp({ db, tokens: { alex: TOK_ARON, claude: TOK_CLAUDE, hermes: TOK_H },
    today: () => TODAY, mediaDir });
  const req = (method, path, { token, body } = {}) => {
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return app.fetch(new Request(`http://x${path}`, { method, headers,
      body: body === undefined ? undefined : JSON.stringify(body) }));
  };
  const task = await (await req('POST', '/api/v1/tasks', { token: TOK_ARON, body: { title: 't' } })).json();
  const up = await (await app.fetch(new Request(`http://x/api/v1/tasks/${task.id}/attachments`,
    { method: 'POST', headers: { Authorization: `Bearer ${TOK_CLAUDE}`, 'Content-Type': 'image/png' },
      body: PNG }))).json();
  // hermes: neither uploader nor admin → 403
  assert.equal((await req('DELETE', `/api/v1/attachments/${up.id}`, { token: TOK_H })).status, 403);
  // alex (admin) → 200 even though claude uploaded
  assert.equal((await req('DELETE', `/api/v1/attachments/${up.id}`, { token: TOK_ARON })).status, 200);
  rmSync(mediaDir, { recursive: true, force: true });
});

// ---- retention PATCH ----
test('patch: set retention rule; validation; auth', async () => {
  const a = makeApp();
  const task = await a.newTask();
  const up = await a.upload(task.id, PNG, { contentType: 'image/png', token: TOK_CLAUDE });

  const onDone = await a.call('PATCH', `/api/v1/attachments/${up.json.id}`,
    { body: { retention: 'on_done' }, token: TOK_CLAUDE });
  assert.equal(onDone.status, 200);
  assert.equal(onDone.json.retention, 'on_done');

  const exp = await a.call('PATCH', `/api/v1/attachments/${up.json.id}`,
    { body: { expires_at: '2026-12-31' } });
  assert.equal(exp.status, 200);
  assert.equal(exp.json.expires_at, '2026-12-31');
  assert.equal(exp.json.retention, 'on_done'); // unchanged fields persist

  // clear the expiry
  const clr = await a.call('PATCH', `/api/v1/attachments/${up.json.id}`, { body: { expires_at: null } });
  assert.equal(clr.json.expires_at, null);

  assert.equal((await a.call('PATCH', `/api/v1/attachments/${up.json.id}`,
    { body: { retention: 'bogus' } })).status, 400);
  assert.equal((await a.call('PATCH', `/api/v1/attachments/${up.json.id}`,
    { body: { expires_at: 'nope' } })).status, 400);
  assert.equal((await a.call('PATCH', `/api/v1/attachments/${up.json.id}`,
    { body: { nope: 1 } })).status, 400);
  assert.equal((await a.call('PATCH', `/api/v1/attachments/NOPE`, { body: { retention: 'keep' } })).status, 404);
  a.cleanup();
});

test('upload: retention + expires_at via query string', async () => {
  const a = makeApp();
  const task = await a.newTask();
  const up = await a.upload(task.id, PNG,
    { contentType: 'image/png', query: '?retention=on_done&expires_at=2026-06-01' });
  assert.equal(up.json.retention, 'on_done');
  assert.equal(up.json.expires_at, '2026-06-01');
  assert.equal((await a.upload(task.id, PNG, { query: '?retention=bogus' })).status, 400);
  assert.equal((await a.upload(task.id, PNG, { query: '?expires_at=nope' })).status, 400);
  a.cleanup();
});

// ---- the retention reaper (drive reap() directly, table-style) ----
test('reaper: deletes on_done when the task is done/archived, expired files, keeps the rest', async () => {
  const a = makeApp();
  // Set up four attachments on distinct tasks with distinct rules.
  const mk = async (title, uploadOpts) => {
    const t = await a.newTask(title);
    const up = await a.upload(t.id, PNG, { contentType: 'image/png', ...uploadOpts });
    return { task: t, id: up.json.id, path: filePathFor(a.mediaDir, up.json.id, 'image/png') };
  };
  const keep = await mk('keeper', {});
  const onDoneActive = await mk('on-done still active', { query: '?retention=on_done' });
  const onDoneClosed = await mk('on-done done', { query: '?retention=on_done' });
  const expiredPast = await mk('expired', { query: '?expires_at=2026-01-01' }); // < TODAY
  const expiresFuture = await mk('expires later', { query: '?expires_at=2099-01-01' }); // > TODAY

  // complete the on-done-closed task so its rule fires
  await a.call('POST', `/api/v1/tasks/${onDoneClosed.task.id}/complete`);

  for (const x of [keep, onDoneActive, onDoneClosed, expiredPast, expiresFuture]) {
    assert.ok(existsSync(x.path), `${x.id} present before reap`);
  }

  const logs = [];
  const res = reap({ db: a.db, mediaDir: a.mediaDir, today: TODAY, log: m => logs.push(m) });

  const deletedIds = new Set(res.deleted.map(d => d.id));
  assert.ok(deletedIds.has(onDoneClosed.id), 'on_done + done → reaped');
  assert.ok(deletedIds.has(expiredPast.id), 'expires_at in the past → reaped');
  assert.ok(!deletedIds.has(keep.id), 'keep survives');
  assert.ok(!deletedIds.has(onDoneActive.id), 'on_done but still active survives');
  assert.ok(!deletedIds.has(expiresFuture.id), 'future expiry survives');
  assert.equal(res.errors, 0);

  // files + rows for the reaped ones are gone; survivors intact
  assert.ok(!existsSync(onDoneClosed.path) && !existsSync(expiredPast.path));
  assert.ok(existsSync(keep.path) && existsSync(onDoneActive.path) && existsSync(expiresFuture.path));
  const rows = a.db.prepare('SELECT id FROM attachments').all().map(r => r.id);
  assert.deepEqual(new Set(rows), new Set([keep.id, onDoneActive.id, expiresFuture.id]));

  // idempotent: a second pass reaps nothing
  assert.equal(reap({ db: a.db, mediaDir: a.mediaDir, today: TODAY }).deleted.length, 0);
  a.cleanup();
});

test('reaper: archived task also fires on_done', async () => {
  const a = makeApp();
  const t = await a.newTask('archive me');
  const up = await a.upload(t.id, PNG, { contentType: 'image/png', query: '?retention=on_done' });
  await a.call('PATCH', `/api/v1/tasks/${t.id}`, { body: { status: 'archived' } });
  const res = reap({ db: a.db, mediaDir: a.mediaDir, today: TODAY });
  assert.equal(res.deleted.length, 1);
  assert.equal(res.deleted[0].id, up.json.id);
  a.cleanup();
});
