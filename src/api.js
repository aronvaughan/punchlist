// api.js — buildApp({db, tokens, today?}) -> Hono app.
// The API is the ONLY write path to the database (invariant).
// tokens: {actorName: token}; server sets created_by from the token, always.
import { Hono } from 'hono';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from './db.js';
import { taskWhere, taskCount, encodeCursor, decodeCursor } from './views.js';
import { between, renormalize } from './rank.js';
import { nextDue, spawn } from './recur.js';
import { parse as quickParse } from './quickadd.js';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT_DIR, 'public');
const VERSION = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')).version;
// data: in img-src/connect-src: Web Awesome's system icon library ships its
// SVGs as data: URIs and wa-icon fetch()es them at runtime — same-origin-only
// otherwise, no remote hosts allowed.
const CSP = "default-src 'self'; script-src 'self'; connect-src 'self' data:; img-src 'self' data:; object-src 'none'; base-uri 'none'";
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.woff2': 'font/woff2',
};

const CAPS = { title: 500, notes: 65536, steps: 100, tags: 20 };
const MAX_BODY_BYTES = 262144; // 256KB — enforced BEFORE JSON.parse (413)
const TASK_FIELDS = new Set(['title', 'notes', 'project_id', 'status', 'when_type', 'when_date',
  'due_date', 'due_time', 'recur', 'tags', 'steps', 'assignee', 'auto_close']);
// The admin (human) actor — approves reviews, owns the Today/Inbox lanes
// (delegation design). Resolved per app: buildApp's `admin` option, defaulting
// to the first actor in `tokens` (server.js passes AV_TASKS_ADMIN through).

class ApiError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = s => /^\d{2}:\d{2}$/.test(s);

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* noop */ } throw e; }
}

function validateTaskBody(body, { partial }) {
  // report is owned by POST /tasks/:id/finish — never client-writable here
  if ('report' in body) throw new ApiError(400, 'report is set by POST /api/v1/tasks/:id/finish');
  for (const k of Object.keys(body)) {
    if (!TASK_FIELDS.has(k)) throw new ApiError(400, `unknown field: ${k}`);
  }
  if (!partial && (typeof body.title !== 'string' || body.title.trim() === '')) {
    throw new ApiError(400, 'title is required');
  }
  if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > CAPS.title)) {
    throw new ApiError(400, `title must be a string of at most ${CAPS.title} chars`);
  }
  if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > CAPS.notes)) {
    throw new ApiError(400, `notes must be a string of at most ${CAPS.notes} chars`);
  }
  if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.length > CAPS.tags ||
      body.tags.some(t => typeof t !== 'string' || !t.trim()))) {
    throw new ApiError(400, `tags must be at most ${CAPS.tags} non-empty strings`);
  }
  if (body.steps !== undefined && (!Array.isArray(body.steps) || body.steps.length > CAPS.steps ||
      body.steps.some(s => typeof s !== 'string' || !s.trim() || s.length > CAPS.title))) {
    throw new ApiError(400, `steps must be at most ${CAPS.steps} non-empty titles`);
  }
  if (body.when_type !== undefined && ![null, 'date', 'someday'].includes(body.when_type)) {
    throw new ApiError(400, 'when_type must be date|someday|null');
  }
  for (const f of ['when_date', 'due_date']) {
    if (body[f] !== undefined && body[f] !== null && !isDate(body[f])) {
      throw new ApiError(400, `${f} must be YYYY-MM-DD`);
    }
  }
  if (body.due_time !== undefined && body.due_time !== null && !isTime(body.due_time)) {
    throw new ApiError(400, 'due_time must be HH:MM');
  }
  if (body.status !== undefined) {
    if (body.status === 'done') throw new ApiError(400, "use POST /api/v1/tasks/:id/complete");
    if (body.status === 'in_progress' || body.status === 'review') {
      throw new ApiError(400, 'use POST /api/v1/tasks/:id/claim and /finish');
    }
    if (!['active', 'archived'].includes(body.status)) throw new ApiError(400, 'status must be active|archived');
  }
  if (body.assignee !== undefined &&
      (typeof body.assignee !== 'string' || !body.assignee.trim() || body.assignee.length > 100)) {
    throw new ApiError(400, 'assignee must be a non-empty string (<=100 chars)');
  }
  if (body.auto_close !== undefined && ![0, 1, true, false].includes(body.auto_close)) {
    throw new ApiError(400, 'auto_close must be boolean');
  }
  if (body.recur !== undefined && body.recur !== null) {
    try { nextDue(body.recur, '2000-01-01', '2000-01-01', '2000-01-01'); }
    catch (e) { throw new ApiError(400, `invalid recur: ${e.message}`); }
  }
}

// section key must mirror views.js SECTION
function sectionOf(task, today) {
  if (task.when_type === 'date') return task.when_date <= today ? 0 : 1;
  if (task.when_type == null) return 2;
  return 3;
}

export function buildApp({ db, tokens, admin, untrusted, today: todayFn }) {
  const today = todayFn || (() => new Date().toLocaleDateString('en-CA'));
  const HUMAN = admin || Object.keys(tokens)[0];
  if (!tokens[HUMAN]) throw new Error(`admin actor "${HUMAN}" has no token in tokens`);
  // agent-security layer 1: tasks created by an untrusted actor are born
  // vetted=0 — quarantined from agent queues and the claim/finish doors
  // until the admin vets them (AV_TASKS_UNTRUSTED_ACTORS, default "email")
  const UNTRUSTED = new Set(untrusted ?? ['email']);
  const byToken = new Map(Object.entries(tokens).map(([name, tok]) => [tok, name]));
  const app = new Hono();

  const getTask = id => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  const getProject = id => db.prepare('SELECT * FROM projects WHERE id = ?').get(id);

  function attach(task) {
    const tags = db.prepare(
      `SELECT g.name FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id = ? ORDER BY g.name`
    ).all(task.id).map(r => r.name);
    const steps = db.prepare(
      'SELECT id, title, done, rank FROM steps WHERE task_id = ? ORDER BY rank, id').all(task.id);
    const { recur, ...rest } = task;
    for (const k of Object.keys(rest)) if (k.startsWith('__k')) delete rest[k];
    return { ...rest, recur: recur ? JSON.parse(recur) : null, tags, steps };
  }

  function setTags(taskId, names) {
    db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(taskId);
    for (const name of names) {
      let tag = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(name.trim());
      if (!tag) { tag = { id: ulid() }; db.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(tag.id, name.trim()); }
      db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, tag.id);
    }
  }

  function endOfSectionRank(projectId, section, todayISO) {
    const cases = ['when_type = \'date\' AND when_date <= ?', 'when_type = \'date\' AND when_date > ?',
      'when_type IS NULL AND ? IS NOT NULL', 'when_type = \'someday\' AND ? IS NOT NULL'];
    const { m } = db.prepare(
      `SELECT MAX(rank) m FROM tasks WHERE status='active' AND project_id IS ? AND ${cases[section]}`
    ).get(projectId, todayISO);
    return (m ?? 0) + 1024;
  }

  function createTask(fields, actor) {
    validateTaskBody(fields, { partial: false });
    const t = today();
    const body = { notes: '', project_id: null, when_type: null, when_date: null,
      due_date: null, due_time: null, recur: null, tags: [], steps: [],
      assignee: HUMAN, auto_close: 0, ...fields };
    if (body.status === 'archived') throw new ApiError(400, 'cannot create archived tasks');
    if (body.when_type === 'date' && !body.when_date) throw new ApiError(400, 'when_type=date requires when_date');
    if (body.when_type !== 'date' && body.when_date) throw new ApiError(400, 'when_date requires when_type=date');
    if (body.project_id && !getProject(body.project_id)) throw new ApiError(400, 'project not found');
    if (body.recur && !body.due_date) body.due_date = t; // review C4
    const id = ulid();
    const now = new Date().toISOString();
    return tx(db, () => {
      const section = sectionOf(body, t);
      const rank = endOfSectionRank(body.project_id, section, t);
      db.prepare(
        `INSERT INTO tasks (id, title, notes, project_id, status, when_type, when_date, due_date,
                            due_time, rank, today_rank, recur, spawned_from, created_by, completed_at,
                            created_at, updated_at, assignee, auto_close, vetted)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL, ?, ?, ?, ?, ?)`
      ).run(id, body.title.trim(), body.notes, body.project_id, body.when_type, body.when_date,
            body.due_date, body.due_time, rank, body.recur ? JSON.stringify(body.recur) : null,
            actor, now, now, body.assignee.trim(), body.auto_close ? 1 : 0,
            UNTRUSTED.has(actor) ? 0 : 1);
      setTags(id, body.tags);
      const insStep = db.prepare('INSERT INTO steps (id, task_id, title, done, rank) VALUES (?, ?, ?, 0, ?)');
      body.steps.forEach((s, i) => insStep.run(ulid(), id, s.trim(), (i + 1) * 1024));
      return attach(getTask(id));
    });
  }

  // ---- middleware ----
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.message, ...err.extra }, err.status);
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  app.use('/api/v1/*', async (c, next) => {
    if (c.req.path === '/api/v1/health') return next();
    const m = /^Bearer (.+)$/.exec(c.req.header('Authorization') || '');
    const actor = m && byToken.get(m[1]);
    if (!actor) return c.json({ error: 'unauthorized' }, 401);
    c.set('actor', actor);
    return next();
  });

  async function readJson(c) {
    // byte cap before parsing: oversized payloads never reach JSON.parse
    const declared = Number(c.req.header('Content-Length'));
    if (declared > MAX_BODY_BYTES) throw new ApiError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
    let body;
    try {
      const text = await c.req.text();
      if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
        throw new ApiError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
      }
      body = JSON.parse(text);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(400, 'invalid JSON body');
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError(400, 'body must be a JSON object');
    }
    if ('created_by' in body) throw new ApiError(400, 'created_by is set by the server');
    return body;
  }

  app.get('/api/v1/health', c => c.json({ ok: true, version: VERSION }));

  // ---- tasks ----
  // due_soon window: ?window= days ahead (integer 1..365, default 30)
  function soonFrom(t, windowRaw) {
    const w = windowRaw === undefined ? 30 : Number(windowRaw);
    if (!Number.isInteger(w) || w < 1 || w > 365) {
      throw new ApiError(400, 'window must be an integer between 1 and 365');
    }
    return new Date(Date.parse(`${t}T00:00:00Z`) + w * 86400000).toISOString().slice(0, 10);
  }

  app.get('/api/v1/tasks', c => {
    const { view, project, tag, q, assignee, limit, cursor, window: windowRaw } = c.req.query();
    if (view !== undefined && !['inbox', 'today', 'upcoming', 'overdue', 'due_soon', 'logbook',
      'review', 'delegated', 'queue', 'unvetted'].includes(view)) {
      throw new ApiError(400, `unknown view: ${view}`);
    }
    const lim = Math.min(Math.max(1, Number(limit) || 100), 500);
    const t = today();
    const soon = view === 'due_soon' ? soonFrom(t, windowRaw) : undefined;
    let res;
    try {
      res = taskWhere(view ?? null, { today: t, soon, admin: HUMAN, project, tag, q, assignee, limit: lim + 1, cursor });
    } catch (e) { throw new ApiError(400, e.message); }
    const rows = db.prepare(res.sql).all(...res.args);
    const page = rows.slice(0, lim);
    const out = { items: page.map(attach) };
    if (rows.length > lim) out.next_cursor = encodeCursor(page[page.length - 1], res.keys);
    return c.json(out);
  });

  app.post('/api/v1/tasks', async c => c.json(createTask(await readJson(c), c.get('actor')), 201));

  app.post('/api/v1/tasks/quickadd', async c => {
    const body = await readJson(c);
    if (typeof body.text !== 'string' || !body.text.trim()) throw new ApiError(400, 'text is required');
    for (const k of Object.keys(body)) if (k !== 'text') throw new ApiError(400, `unknown field: ${k}`);
    const projects = db.prepare('SELECT id, name FROM projects WHERE archived = 0').all();
    let fields;
    try { fields = quickParse(body.text, { projects, today: today() }); } catch (e) { throw new ApiError(400, e.message); }
    if (!fields.title) throw new ApiError(400, 'quickadd text has no title');
    return c.json(createTask(fields, c.get('actor')), 201);
  });

  app.patch('/api/v1/tasks/:id', async c => {
    const task = getTask(c.req.param('id'));
    if (!task) throw new ApiError(404, 'task not found');
    const body = await readJson(c);
    validateTaskBody(body, { partial: true });
    if (body.steps !== undefined) throw new ApiError(400, 'use the /steps endpoints');
    if (body.project_id !== undefined && body.project_id !== null && !getProject(body.project_id)) {
      throw new ApiError(400, 'project not found');
    }
    const merged = { ...task, ...body };
    merged.auto_close = body.auto_close === undefined ? task.auto_close : (body.auto_close ? 1 : 0);
    if (body.assignee !== undefined) merged.assignee = body.assignee.trim();
    // reassigning a claimed task takes the work back: reset to active, clear claim
    if (body.assignee !== undefined && merged.assignee !== task.assignee && task.status === 'in_progress') {
      merged.status = 'active';
      merged.claimed_at = null;
    }
    if (body.when_type === 'someday' || body.when_type === null) merged.when_date = null;
    if (body.when_date !== undefined && body.when_date !== null && body.when_type === undefined) {
      merged.when_type = 'date';
    }
    if ((merged.when_type === 'date') !== (merged.when_date != null)) {
      throw new ApiError(400, 'when_type=date requires when_date (and vice versa)');
    }
    const recurVal = body.recur === undefined
      ? task.recur
      : (body.recur === null ? null : JSON.stringify(body.recur));
    if (recurVal && !merged.due_date) throw new ApiError(400, 'recurrence requires a due date');
    const now = new Date().toISOString();
    const t = today();
    // manual Today order must not outlive Today membership: a task scheduled
    // out of the view would otherwise re-enter at its stale today_rank instead
    // of appending after manually-placed items (I11).
    // …and only aron's own tasks hold a manual Today position. A delegated
    // task can legitimately sit in Today when its DUE date arrives (due
    // overrides assignee scoping — 2026-08-24 amendment), but delegating
    // still clears today_rank ON PURPOSE: its slot in the human's manual
    // order shouldn't survive delegation; due-driven appearances sort after
    // manually-ranked items.
    const inToday = merged.assignee === HUMAN &&
                    ((merged.when_type === 'date' && merged.when_date != null && merged.when_date <= t) ||
                     (merged.due_date != null && merged.due_date <= t));
    const todayRank = inToday ? task.today_rank : null;
    return tx(db, () => {
      // rank is scoped to (project, section): a task moved to a new scope must
      // append there, not carry a rank minted in its old scope (collisions,
      // id-tiebreak ordering). Same placement rule as createTask.
      const rank = (merged.project_id !== task.project_id || sectionOf(merged, t) !== sectionOf(task, t))
        ? endOfSectionRank(merged.project_id, sectionOf(merged, t), t)
        : task.rank;
      db.prepare(
        `UPDATE tasks SET title=?, notes=?, project_id=?, status=?, when_type=?, when_date=?,
                due_date=?, due_time=?, recur=?, today_rank=?, rank=?, assignee=?, auto_close=?,
                claimed_at=?,
                completed_at = CASE WHEN ? = 'active' THEN NULL ELSE completed_at END,
                updated_at=? WHERE id=?`
      ).run(merged.title, merged.notes, merged.project_id, merged.status, merged.when_type,
            merged.when_date, merged.due_date, merged.due_time, recurVal, todayRank, rank,
            merged.assignee, merged.auto_close, merged.claimed_at,
            merged.status, now, task.id);
      if (body.tags !== undefined) setTags(task.id, body.tags);
      return c.json(attach(getTask(task.id)));
    });
  });

  // Guarded FINAL transition to done — the only place a recurrence spawns
  // (delegation design: spawn on complete, approve or auto-close finish; never
  // on entering review). Runs inside the caller's tx; only the call that
  // actually flips the row (changes===1) spawns (review O4).
  function toDone(task, fromStatuses, { report = null } = {}) {
    const now = new Date().toISOString();
    const t = today();
    const { changes } = db.prepare(
      `UPDATE tasks SET status='done', report=COALESCE(?, report), completed_at=?, updated_at=?
       WHERE id=? AND status IN (${fromStatuses.map(() => '?').join(', ')})`
    ).run(report, now, now, task.id, ...fromStatuses);
    let spawned_id;
    if (changes === 1 && task.recur) {
      const next = nextDue(JSON.parse(task.recur), task.due_date, t, t);
      spawned_id = spawn(db, task, next, t);
    }
    return spawned_id;
  }

  const doneResponse = (c, id, spawned_id) => {
    const out = { task: attach(getTask(id)) };
    if (spawned_id) out.spawned_id = spawned_id;
    return c.json(out);
  };

  app.post('/api/v1/tasks/:id/complete', c => {
    const id = c.req.param('id');
    return tx(db, () => {
      const task = getTask(id);
      if (!task) throw new ApiError(404, 'task not found');
      return doneResponse(c, id, toDone(task, ['active']));
    });
  });

  // ---- delegation lifecycle (claim → finish → approve) ----
  app.post('/api/v1/tasks/:id/claim', c => {
    const id = c.req.param('id');
    return tx(db, () => {
      const task = getTask(id);
      if (!task) throw new ApiError(404, 'task not found');
      // agent-security layer 1: the gate is the DOOR, not just queue
      // filtering — an unvetted task cannot be worked even by id
      if (!task.vetted) throw new ApiError(403, 'task not vetted for agent execution');
      if (c.get('actor') !== task.assignee) throw new ApiError(403, 'only the assignee can claim');
      const now = new Date().toISOString();
      // guarded: active -> in_progress; re-claiming your own in_progress task
      // is an idempotent 200 (changes=0, claimed_at kept)
      const { changes } = db.prepare(
        `UPDATE tasks SET status='in_progress', claimed_at=?, updated_at=? WHERE id=? AND status='active'`
      ).run(now, now, id);
      if (changes === 0 && task.status !== 'in_progress') {
        throw new ApiError(409, `cannot claim a ${task.status} task`);
      }
      return c.json({ task: attach(getTask(id)) });
    });
  });

  app.post('/api/v1/tasks/:id/finish', async c => {
    const id = c.req.param('id');
    const body = await readJson(c);
    for (const k of Object.keys(body)) if (k !== 'report') throw new ApiError(400, `unknown field: ${k}`);
    if (typeof body.report !== 'string' || !body.report.trim() || body.report.length > CAPS.notes) {
      throw new ApiError(400, `report is required (<=${CAPS.notes} chars)`);
    }
    return tx(db, () => {
      const task = getTask(id);
      if (!task) throw new ApiError(404, 'task not found');
      if (!task.vetted) throw new ApiError(403, 'task not vetted for agent execution');
      if (c.get('actor') !== task.assignee) throw new ApiError(403, 'only the assignee can finish');
      if (task.status !== 'active' && task.status !== 'in_progress') {
        throw new ApiError(409, `cannot finish a ${task.status} task`);
      }
      const now = new Date().toISOString();
      // repeat finishes (after a reopen) append under a timestamped rule
      const report = task.report
        ? `${task.report}\n\n--- ${now}\n\n${body.report.trim()}`
        : body.report.trim();
      if (task.auto_close) {
        // straight to done — the final transition, so recurrence spawns here
        return doneResponse(c, id, toDone(task, ['active', 'in_progress'], { report }));
      }
      db.prepare(
        `UPDATE tasks SET status='review', report=?, updated_at=? WHERE id=? AND status IN ('active', 'in_progress')`
      ).run(report, now, id);
      return c.json({ task: attach(getTask(id)) });
    });
  });

  app.post('/api/v1/tasks/:id/approve', c => {
    const id = c.req.param('id');
    return tx(db, () => {
      const task = getTask(id);
      if (!task) throw new ApiError(404, 'task not found');
      if (c.get('actor') !== HUMAN) throw new ApiError(403, `only the admin (${HUMAN}) can approve`);
      if (task.status === 'done') return c.json({ task: attach(task) }); // idempotent
      if (task.status !== 'review') throw new ApiError(409, `cannot approve a ${task.status} task`);
      return doneResponse(c, id, toDone(task, ['review']));
    });
  });

  // agent-security layer 1: the ONLY way a task becomes vetted (PATCH rejects
  // the field). Admin-only door; idempotent — re-vetting a vetted task = 200.
  app.post('/api/v1/tasks/:id/vet', c => {
    const id = c.req.param('id');
    const task = getTask(id);
    if (!task) throw new ApiError(404, 'task not found');
    if (c.get('actor') !== HUMAN) throw new ApiError(403, `only the admin (${HUMAN}) can vet`);
    if (!task.vetted) {
      db.prepare('UPDATE tasks SET vetted = 1, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), id);
    }
    return c.json({ task: attach(getTask(id)) });
  });

  app.post('/api/v1/tasks/:id/reorder', async c => {
    const task = getTask(c.req.param('id'));
    if (!task) throw new ApiError(404, 'task not found');
    const body = await readJson(c);
    for (const k of Object.keys(body)) {
      if (!['before_id', 'after_id', 'list'].includes(k)) throw new ApiError(400, `unknown field: ${k}`);
    }
    const list = body.list ?? 'project';
    if (!['project', 'today'].includes(list)) throw new ApiError(400, "list must be 'project' or 'today'");
    if (!body.before_id && !body.after_id) throw new ApiError(400, 'before_id or after_id required');
    const t = today();
    const col = list === 'today' ? 'today_rank' : 'rank';

    // Manual Today ordering is for aron's own rows only: delegated tasks may
    // APPEAR in Today (due-driven — 2026-08-24 amendment) but never hold a
    // today_rank, so they can't be dragged or used as reorder neighbors.
    const inTodayView = x => x.status === 'active' && x.assignee === HUMAN &&
      ((x.when_type === 'date' && x.when_date <= t) || (x.due_date != null && x.due_date <= t));
    const inScope = list === 'today'
      ? inTodayView
      : x => x.status === 'active' && x.project_id === task.project_id &&
             sectionOf(x, t) === sectionOf(task, t);

    const scopeRows = () => {
      const res = list === 'today'
        ? taskWhere('today', { today: t, admin: HUMAN, limit: 500 })
        : taskWhere(null, { today: t, admin: HUMAN, project: task.project_id ?? undefined, limit: 500 });
      let rows = db.prepare(res.sql).all(...res.args);
      if (list === 'project' && task.project_id == null) rows = rows.filter(r => r.project_id === null);
      return rows;
    };
    const currentList = () =>
      scopeRows().filter(r => inScope(r) || r.id === task.id).map(r => ({ id: r.id, title: r.title }));

    if (!inScope(task)) throw new ApiError(409, 'task is not in that list', { current: currentList() });
    const neighbors = {};
    for (const key of ['after_id', 'before_id']) {
      if (!body[key]) continue;
      const n = getTask(body[key]);
      if (!n || !inScope(n)) throw new ApiError(409, `${key} is no longer in this list`, { current: currentList() });
      neighbors[key] = n;
    }

    return tx(db, () => {
      const scope = list === 'today'
        ? { table: 'tasks', column: 'today_rank',
            where: `status='active' AND assignee=? AND ((when_type='date' AND when_date<=?) OR due_date<=?)`,
            args: [HUMAN, t, t] }
        : { table: 'tasks', column: 'rank',
            where: `status='active' AND project_id IS ? AND
                    (CASE WHEN when_type='date' AND when_date<=? THEN 0
                          WHEN when_type='date' THEN 1
                          WHEN when_type IS NULL THEN 2 ELSE 3 END) = ?`,
            args: [task.project_id, t, sectionOf(task, t)] };
      // Renormalize preserving the VISIBLE order: today ranks materialize from
      // the today view order (arrivals after manually-placed items — I11);
      // project sections renormalize by rank.
      const renorm = () => {
        if (list === 'today') {
          const res = taskWhere('today', { today: t, admin: HUMAN, limit: 500 });
          // skip delegated rows: they show in Today (due-driven) but must not
          // be stamped into the human's manual order (2026-08-24 amendment)
          const rows = db.prepare(res.sql).all(...res.args).filter(r => r.assignee === HUMAN);
          const upd = db.prepare('UPDATE tasks SET today_rank = ? WHERE id = ?');
          rows.forEach((r, i) => upd.run((i + 1) * 1024, r.id));
        } else {
          renormalize(db, scope);
        }
      };
      // A single-neighbor reorder means "directly adjacent to that neighbor".
      // Derive the missing bound from the row next to it in the visible order:
      // with only one bound, between() returns neighbor±SPACING, which is
      // exactly the adjacent row's own rank whenever ranks are evenly spaced
      // (the state createTask and renormalize produce) — a silent collision.
      const implicit = {};
      if (!neighbors.after_id !== !neighbors.before_id) {
        const rows = scopeRows().filter(r => inScope(r) && r.id !== task.id);
        const given = neighbors.after_id ? 'after_id' : 'before_id';
        const idx = rows.findIndex(r => r.id === neighbors[given].id);
        const adj = given === 'after_id' ? rows[idx + 1] : rows[idx - 1];
        if (adj) implicit[given === 'after_id' ? 'before_id' : 'after_id'] = adj;
      }
      const bound = key => neighbors[key] ?? implicit[key];
      const rankOf = key => bound(key) ? getTask(bound(key).id)[col] : null;
      let val = between(rankOf('after_id'), rankOf('before_id'));
      const anyNull = ['after_id', 'before_id'].some(k => bound(k) && rankOf(k) === null);
      if (val === null || anyNull) {
        renorm(); // same tx as the write (design M10)
        val = between(rankOf('after_id'), rankOf('before_id'));
        if (val === null) throw new ApiError(409, 'neighbors are not adjacent in that order', { current: currentList() });
      }
      db.prepare(`UPDATE tasks SET ${col} = ?, updated_at = ? WHERE id = ?`)
        .run(val, new Date().toISOString(), task.id);
      return c.json({ task: attach(getTask(task.id)) });
    });
  });

  // ---- steps ----
  app.post('/api/v1/tasks/:id/steps', async c => {
    const task = getTask(c.req.param('id'));
    if (!task) throw new ApiError(404, 'task not found');
    const body = await readJson(c);
    for (const k of Object.keys(body)) if (k !== 'title') throw new ApiError(400, `unknown field: ${k}`);
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > CAPS.title) {
      throw new ApiError(400, 'title required (<=500 chars)');
    }
    const count = db.prepare('SELECT COUNT(*) c FROM steps WHERE task_id = ?').get(task.id).c;
    if (count >= CAPS.steps) throw new ApiError(400, `at most ${CAPS.steps} steps per task`);
    const { m } = db.prepare('SELECT MAX(rank) m FROM steps WHERE task_id = ?').get(task.id);
    const id = ulid();
    db.prepare('INSERT INTO steps (id, task_id, title, done, rank) VALUES (?, ?, ?, 0, ?)')
      .run(id, task.id, body.title.trim(), (m ?? 0) + 1024);
    return c.json(db.prepare('SELECT * FROM steps WHERE id = ?').get(id), 201);
  });

  app.patch('/api/v1/tasks/:id/steps/:sid', async c => {
    const step = db.prepare('SELECT * FROM steps WHERE id = ? AND task_id = ?')
      .get(c.req.param('sid'), c.req.param('id'));
    if (!step) throw new ApiError(404, 'step not found');
    const body = await readJson(c);
    for (const k of Object.keys(body)) {
      if (!['title', 'done', 'rank'].includes(k)) throw new ApiError(400, `unknown field: ${k}`);
    }
    if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > CAPS.title)) {
      throw new ApiError(400, 'title must be a non-empty string (<=500 chars)');
    }
    if (body.done !== undefined && ![0, 1, true, false].includes(body.done)) {
      throw new ApiError(400, 'done must be boolean');
    }
    if (body.rank !== undefined && !Number.isFinite(body.rank)) throw new ApiError(400, 'rank must be a number');
    const merged = { ...step, ...body, done: body.done === undefined ? step.done : (body.done ? 1 : 0) };
    db.prepare('UPDATE steps SET title = ?, done = ?, rank = ? WHERE id = ?')
      .run(merged.title, merged.done, merged.rank, step.id);
    return c.json(db.prepare('SELECT * FROM steps WHERE id = ?').get(step.id));
  });

  app.delete('/api/v1/tasks/:id/steps/:sid', c => {
    const { changes } = db.prepare('DELETE FROM steps WHERE id = ? AND task_id = ?')
      .run(c.req.param('sid'), c.req.param('id'));
    if (changes === 0) throw new ApiError(404, 'step not found');
    return c.json({ ok: true });
  });

  // ---- counts (nav badges): one call, view WHEREs from views.js ----
  app.get('/api/v1/counts', c => {
    const t = today();
    const soon = soonFrom(t, c.req.query('window'));
    const count = view => {
      const { sql, args } = taskCount(view, { today: t, soon, admin: HUMAN });
      return db.prepare(sql).get(...args).c;
    };
    const projects = {};
    // open = still on the board: project rows must match the project view,
    // which shows delegated in_progress/review work too
    for (const row of db.prepare(
      `SELECT project_id, COUNT(*) c FROM tasks
       WHERE status IN ('active', 'in_progress', 'review') AND project_id IS NOT NULL
       GROUP BY project_id`).all()) {
      projects[row.project_id] = row.c;
    }
    return c.json({
      inbox: count('inbox'), today: count('today'), upcoming: count('upcoming'),
      due_soon: count('due_soon'), review: count('review'), delegated: count('delegated'),
      unvetted: count('unvetted'), // quarantined agent work awaiting the admin's vet
      projects,
      actor: c.get('actor'), // who this token belongs to (rail footer)
    });
  });

  // ---- tags ----
  app.get('/api/v1/tags', c => {
    // nav listing: every tag with its open-task count (open = the statuses the
    // tag-filtered list view shows, delegated in-flight work included).
    // Small bounded set in practice — no pagination (unlike /tasks, /projects).
    const items = db.prepare(
      `SELECT g.id, g.name, COUNT(t.id) AS count
       FROM tags g
       LEFT JOIN task_tags tt ON tt.tag_id = g.id
       LEFT JOIN tasks t ON t.id = tt.task_id AND t.status IN ('active', 'in_progress', 'review')
       GROUP BY g.id
       ORDER BY g.name COLLATE NOCASE, g.id`
    ).all();
    return c.json({ items });
  });

  app.post('/api/v1/tags', async c => {
    const body = await readJson(c);
    for (const k of Object.keys(body)) if (k !== 'name') throw new ApiError(400, `unknown field: ${k}`);
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > CAPS.title) {
      throw new ApiError(400, 'name required (<=500 chars)');
    }
    const name = body.name.trim().replace(/^#/, '');
    if (!name) throw new ApiError(400, 'name required (<=500 chars)');
    if (db.prepare('SELECT 1 FROM tags WHERE name = ? COLLATE NOCASE').get(name)) {
      throw new ApiError(409, 'tag already exists');
    }
    const id = ulid();
    db.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(id, name);
    return c.json({ id, name, count: 0 }, 201);
  });

  // ---- projects ----
  const PROJECT_FIELDS = new Set(['name', 'notes', 'parent_id', 'domain', 'archived']);

  app.get('/api/v1/projects', c => {
    // same list-endpoint contract as /tasks: ?limit= (default 100, max 500)
    // + keyset ?cursor=; response {items, next_cursor?} (review O5)
    const { limit, cursor } = c.req.query();
    const lim = Math.min(Math.max(1, Number(limit) || 100), 500);
    const args = [];
    let where = '';
    if (cursor) {
      let vals;
      try { vals = decodeCursor(cursor, 1); } catch (e) { throw new ApiError(400, e.message); }
      where = 'WHERE (COALESCE(rank, 9.0e18), id) > (?, ?)';
      args.push(...vals);
    }
    const rows = db.prepare(
      `SELECT *, COALESCE(rank, 9.0e18) AS __k0 FROM projects ${where}
       ORDER BY __k0, id LIMIT ?`).all(...args, lim + 1);
    const page = rows.slice(0, lim);
    const out = { items: page.map(({ __k0, ...p }) => p) };
    if (rows.length > lim) out.next_cursor = encodeCursor(page[page.length - 1], ['__k0']);
    return c.json(out);
  });

  app.post('/api/v1/projects', async c => {
    const body = await readJson(c);
    for (const k of Object.keys(body)) if (!PROJECT_FIELDS.has(k)) throw new ApiError(400, `unknown field: ${k}`);
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > CAPS.title) {
      throw new ApiError(400, 'name required (<=500 chars)');
    }
    if (body.parent_id != null && !getProject(body.parent_id)) throw new ApiError(400, 'parent project not found');
    if (db.prepare('SELECT 1 FROM projects WHERE name = ?').get(body.name.trim())) {
      throw new ApiError(409, 'project name already exists');
    }
    const id = ulid();
    const now = new Date().toISOString();
    const { m } = db.prepare('SELECT MAX(rank) m FROM projects').get();
    db.prepare(
      `INSERT INTO projects (id, name, notes, parent_id, domain, rank, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(id, body.name.trim(), body.notes ?? '', body.parent_id ?? null, body.domain ?? null,
          (m ?? 0) + 1024, now, now);
    return c.json(getProject(id), 201);
  });

  app.patch('/api/v1/projects/:id', async c => {
    const project = getProject(c.req.param('id'));
    if (!project) throw new ApiError(404, 'project not found');
    const body = await readJson(c);
    for (const k of Object.keys(body)) if (!PROJECT_FIELDS.has(k)) throw new ApiError(400, `unknown field: ${k}`);
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
      throw new ApiError(400, 'name must be non-empty');
    }
    if (body.name !== undefined &&
        db.prepare('SELECT 1 FROM projects WHERE name = ? AND id <> ?').get(body.name.trim(), project.id)) {
      throw new ApiError(409, 'project name already exists');
    }
    if (body.parent_id !== undefined && body.parent_id !== null) {
      // cycle check: walk ancestors of the proposed parent (review I12)
      let cur = body.parent_id, hops = 0;
      while (cur != null) {
        if (cur === project.id) throw new ApiError(400, 'parent_id would create a cycle');
        const p = getProject(cur);
        if (!p) throw new ApiError(400, 'parent project not found');
        cur = p.parent_id;
        if (++hops > 100) throw new ApiError(400, 'project tree too deep');
      }
    }
    const merged = { ...project, ...body, archived: body.archived === undefined ? project.archived : (body.archived ? 1 : 0) };
    db.prepare(
      `UPDATE projects SET name=?, notes=?, parent_id=?, domain=?, archived=?, updated_at=? WHERE id=?`
    ).run(merged.name.trim(), merged.notes, merged.parent_id, merged.domain, merged.archived,
          new Date().toISOString(), project.id);
    return c.json(getProject(project.id));
  });

  // ---- static UI (CSP on every static response — review O1) ----
  app.get('*', c => {
    let p = normalize(c.req.path).replace(/^([/\\.])+/, '');
    if (p === '') p = 'index.html';
    const file = join(PUBLIC_DIR, p);
    if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || !statSync(file).isFile()) {
      return c.json({ error: 'not found' }, 404);
    }
    // no-cache (revalidate, not no-store): without it browsers heuristically
    // cache app modules/styles and serve a stale UI after upgrades. Vendored
    // assets are immutable-ish and large — let them cache for a day.
    const cache = p.startsWith('vendor/') ? 'public, max-age=86400' : 'no-cache';
    return c.body(readFileSync(file), 200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': cache,
    });
  });

  return app;
}
