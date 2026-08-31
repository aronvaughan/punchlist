// api.js — buildApp({db, tokens, today?}) -> Hono app.
// The API is the ONLY write path to the database (invariant).
// tokens: {actorName: token}; server sets created_by from the token, always.
import { Hono } from 'hono';
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync, rmSync, realpathSync, mkdtempSync } from 'node:fs';
import { join, normalize, extname, dirname, isAbsolute, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { makeRunner, parseAiReply, resolveTemplatePath, readTemplate, buildEditPrompt } from './templates.js';
import { ulid } from './db.js';
import { sniffMime, normalizeMime, normalizeDocMime, docMimeForExt, isDocMime, isUtf8Text,
  filePathFor, sanitizeFilename } from './media.js';
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
// blob: in img-src: attachment thumbnails are fetched WITH the bearer token
// (an <img src> can't send Authorization), then shown via URL.createObjectURL.
const CSP = "default-src 'self'; script-src 'self'; connect-src 'self' data:; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'";
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.woff2': 'font/woff2',
};

const CAPS = { title: 500, notes: 65536, steps: 100, tags: 20, question: 2048, answer: 8192,
  comment: 8192, template: 200 };
const MAX_BODY_BYTES = 262144; // 256KB — enforced BEFORE JSON.parse (413)
const TASK_FIELDS = new Set(['title', 'notes', 'project_id', 'status', 'when_type', 'when_date',
  'due_date', 'due_time', 'recur', 'tags', 'steps', 'assignee', 'auto_close', 'template']);
// The admin (human) actor — approves reviews, owns the Today/Inbox lanes
// (delegation design). Resolved per app: buildApp's `admin` option, defaulting
// to the first actor in `tokens` (server.js passes PUNCHLIST_ADMIN through).

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

// ---- optimistic concurrency (migration 009) ----
// A mutating door / PATCH may carry an OPTIONAL expected_version (alias
// if_version) — in the JSON body for body-parsing doors, or as a query param
// for the body-less ones (claim/complete/approve). When supplied and it does
// not match the row's current `version`, the write is refused as stale (409)
// rather than clobbering a change the caller never saw. When omitted, behaviour
// is unchanged (last-write-wins) — so existing callers keep working. The value
// is deleted from `body` so it never trips an unknown-field check downstream.
function takeExpectedVersion(c, body) {
  let raw;
  if (body && (body.expected_version !== undefined || body.if_version !== undefined)) {
    raw = body.expected_version ?? body.if_version;
    delete body.expected_version;
    delete body.if_version;
  } else {
    raw = c.req.query('expected_version') ?? c.req.query('if_version');
  }
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new ApiError(400, 'expected_version must be a non-negative integer');
  }
  return n;
}

// Guard a read task row against the caller's expected_version (no-op when null).
function checkVersion(task, want) {
  if (want !== null && task.version !== want) {
    throw new ApiError(409, 'task changed since you last read it (stale)',
      { current_version: task.version });
  }
}

function validateTaskBody(body, { partial }) {
  // report is owned by POST /tasks/:id/finish — never client-writable here
  if ('report' in body) throw new ApiError(400, 'report is set by POST /api/v1/tasks/:id/finish');
  // question/answer are owned by the block/answer doors — same rule as report
  if ('question' in body) throw new ApiError(400, 'question is set by POST /api/v1/tasks/:id/block');
  if ('answer' in body) throw new ApiError(400, 'answer is set by POST /api/v1/tasks/:id/answer');
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
    if (body.status === 'blocked') {
      throw new ApiError(400, 'use POST /api/v1/tasks/:id/block (and /answer to unblock)');
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
  // template: a free string (a template NAME) or null — deliberately NOT
  // validated against a known set; the templates repo is authoritative and
  // public users may not have it (migration 007).
  if (body.template !== undefined && body.template !== null &&
      (typeof body.template !== 'string' || body.template.length > CAPS.template)) {
    throw new ApiError(400, `template must be a string of at most ${CAPS.template} chars, or null`);
  }
  if (body.recur !== undefined && body.recur !== null) {
    try { nextDue(body.recur, '2000-01-01', '2000-01-01', '2000-01-01'); }
    catch (e) { throw new ApiError(400, `invalid recur: ${e.message}`); }
  }
}

// ---- local-document link roots (migration 010) ----
// Parse PUNCHLIST_DOC_ROOTS (colon-separated absolute dirs) into a list of
// canonical realpaths. Non-absolute or non-existent entries are dropped (a root
// that isn't there can't contain anything); a caller may also pass an array.
export function resolveDocRoots(raw) {
  const parts = Array.isArray(raw) ? raw : String(raw || '').split(':');
  const roots = [];
  for (const p of parts.map(s => s.trim()).filter(Boolean)) {
    if (!isAbsolute(p)) continue;
    try {
      const real = realpathSync(p);
      if (statSync(real).isDirectory() && !roots.includes(real)) roots.push(real);
    } catch { /* missing root — skip */ }
  }
  return roots;
}

// True when `real` (already a realpath) is one of the roots or lives beneath it.
// The `+ sep` guard stops /srv/docs-secret from matching a /srv/docs root.
export function pathInsideRoots(real, roots) {
  return roots.some(root => real === root || real.startsWith(root + sep));
}

// ---- AI-assisted template editing (feature gate) ----
// Resolve the template-editing config. Accepts an explicit object (tests) or
// falls back to env + a one-time `claude --version` probe (production). Returns
// { dir, available, run }. `available` is the boot-time gate; routes re-check
// dir existence per request so a repo that disappears degrades to 404.
export function templateEditingAvailable(dir) {
  // The feature needs: a git working tree (to commit into), the repo's own bin/plt
  // (to validate before writing — there is no global `plt`), and the `claude` binary
  // (to do the editing). Missing any one → the feature stays dark, not half-broken.
  return Boolean(dir && existsSync(join(dir, '.git')) &&
    existsSync(join(dir, 'bin', 'plt')) && hasClaudeBinary());
}

export function resolveTemplateEditing(cfg) {
  if (cfg) {
    const run = cfg.run || makeRunner();
    const dir = cfg.dir;
    const available = cfg.available !== undefined ? cfg.available : templateEditingAvailable(dir);
    return { dir, available, run };
  }
  const dir = process.env.PUNCHLIST_TEMPLATES_DIR ||
    join(homedir(), 'code', 'punchlist-templates');
  return { dir, available: templateEditingAvailable(dir), run: makeRunner() };
}

let _hasClaude = null;
function hasClaudeBinary() {
  if (_hasClaude !== null) return _hasClaude;
  try { execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 5000 }); _hasClaude = true; }
  catch { _hasClaude = false; }
  return _hasClaude;
}

// section key must mirror views.js SECTION
function sectionOf(task, today) {
  if (task.when_type === 'date') return task.when_date <= today ? 0 : 1;
  if (task.when_type == null) return 2;
  return 3;
}

export function buildApp({ db, tokens, admin, untrusted, today: todayFn, mediaDir, maxUpload,
    maxDoc, docRoots, templateEditing }) {
  const today = todayFn || (() => new Date().toLocaleDateString('en-CA'));
  // attachments: bytes live as their own files in the media dir; the task
  // references the row. Cap is separate from (and far larger than) the JSON
  // body cap — the upload route does NOT go through readJson.
  const MEDIA_DIR = mediaDir || process.env.PUNCHLIST_MEDIA_DIR || join(ROOT_DIR, 'data', 'media');
  const MAX_UPLOAD = maxUpload || Number(process.env.PUNCHLIST_MAX_UPLOAD_BYTES) || 10485760;
  // Document (.md/.txt) uploads have their own, smaller cap — a text doc has no
  // business being 10MB, and keeping it separate documents the intent.
  const MAX_DOC = maxDoc || Number(process.env.PUNCHLIST_MAX_DOC_BYTES) || 2097152;
  // Local-document LINK roots: colon-separated absolute dirs a linked file must
  // resolve inside. Unset/empty → linking is DISABLED (the link route 403s and
  // the config probe reports it off), keeping public instances self-contained.
  // Each root is canonicalized (realpath) once at boot so symlink containment
  // checks compare real path against real path.
  const DOC_ROOTS = resolveDocRoots(docRoots ?? process.env.PUNCHLIST_DOC_ROOTS);
  const HUMAN = admin || Object.keys(tokens)[0];
  if (!tokens[HUMAN]) throw new Error(`admin actor "${HUMAN}" has no token in tokens`);
  // AI-assisted template editing (admin-only, feature-gated). Available only
  // when a templates repo dir is configured AND the `claude` binary is present.
  // Tests inject { dir, available, run } directly; production computes them.
  const TPL = resolveTemplateEditing(templateEditing);
  // agent-security layer 1: tasks created by an untrusted actor are born
  // vetted=0 — quarantined from agent queues and the claim/finish doors
  // until the admin vets them (PUNCHLIST_UNTRUSTED_ACTORS, default "email")
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
    const attachment_count = db.prepare(
      'SELECT COUNT(*) c FROM attachments WHERE task_id = ?').get(task.id).c;
    const comment_count = db.prepare(
      'SELECT COUNT(*) c FROM comments WHERE task_id = ?').get(task.id).c;
    const { recur, ...rest } = task;
    for (const k of Object.keys(rest)) if (k.startsWith('__k')) delete rest[k];
    return { ...rest, recur: recur ? JSON.parse(recur) : null, tags, steps,
      attachment_count, comment_count };
  }

  // ---- activity thread (the collaboration primitive) ----
  // Append one row to a task's timeline. Called both by the /comments door
  // (kind='comment') and, inside the existing lifecycle doors, to project each
  // transition into the readable timeline (question/answer/report/status). This
  // is the ONE write path for the thread; callers run it inside their own tx so
  // the projection lands atomically with the transition it describes.
  function postComment(taskId, author, kind, text) {
    db.prepare(
      'INSERT INTO comments (id, task_id, author, kind, text, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(ulid(), taskId, author, kind, text, new Date().toISOString());
  }

  // ---- notification event log (migration 011) ----
  // The persisted "needs a human" / status-update feed the web UI polls
  // (GET /api/v1/events?since=). Written at the same transitions a future
  // outbound webhook door would use (finish->review, block, answer,
  // approve) — kept as a separate append-only log from `comments` so a
  // slow/absent UI poller can never lose an event to comment-thread noise,
  // and so a later external-delivery worker has a queue to drain without
  // touching the human-readable timeline.
  function postEvent(task, event, extra = {}) {
    const payload = JSON.stringify({
      task_id: task.id, title: task.title, status: task.status,
      assignee: task.assignee, project_id: task.project_id, ...extra,
    });
    db.prepare(
      'INSERT INTO task_events (id, task_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(ulid(), task.id, event, payload, new Date().toISOString());
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

  // ---- per-view manual order (view_ranks, migration 008) ----
  // The drag-reorderable list views (inbox / agents / human) keep their manual
  // order in view_ranks, independent of tasks.rank / today_rank. Each list maps
  // to the taskWhere view that renders it, so "visible order" and "in scope"
  // come from the one source of view semantics.
  const VIEW_RANK_LISTS = { inbox: 'inbox', agents: 'agents', human: 'human' };
  const upsertViewRank = db.prepare(
    `INSERT INTO view_ranks (task_id, view, rank) VALUES (?, ?, ?)
     ON CONFLICT(task_id, view) DO UPDATE SET rank = excluded.rank`);

  // Move a task to the TOP of a view_ranks order (min existing rank − a gap).
  // Used by reopen-to-top; renders the task the next agent pick-up.
  function viewRankToTop(taskId, view) {
    const { m } = db.prepare('SELECT MIN(rank) m FROM view_ranks WHERE view = ?').get(view);
    upsertViewRank.run(taskId, view, (m ?? 0) - 1024);
  }

  // Reorder within a view_ranks list. Mirrors the project/today reorder shape
  // (neighbor ids, single-neighbor adjacency, renormalize-in-tx on gap
  // exhaustion) but writes view_ranks rather than a tasks column.
  function viewRankReorder(c, task, body, view, afterWrite) {
    const t = today();
    const fetchRows = () => {
      const res = taskWhere(view, { today: t, admin: HUMAN, limit: 500 });
      return db.prepare(res.sql).all(...res.args);
    };
    let rows = fetchRows();
    const inScope = id => rows.some(r => r.id === id);
    const currentList = () => rows.map(r => ({ id: r.id, title: r.title }));
    if (!inScope(task.id)) throw new ApiError(409, 'task is not in that list', { current: currentList() });
    const neighbors = {};
    for (const key of ['after_id', 'before_id']) {
      if (!body[key]) continue;
      if (!inScope(body[key])) throw new ApiError(409, `${key} is no longer in this list`, { current: currentList() });
      neighbors[key] = body[key];
    }
    return tx(db, () => {
      const rankOf = id => {
        const r = db.prepare('SELECT rank FROM view_ranks WHERE task_id = ? AND view = ?').get(id, view);
        return r ? r.rank : null;
      };
      // materialize the current visible order into view_ranks (same tx as the
      // write) — the first drag in a view has no ranks yet, and a later drag can
      // exhaust the float gap between two neighbors.
      const renorm = () => {
        fetchRows().forEach((r, i) => upsertViewRank.run(r.id, view, (i + 1) * 1024));
      };
      // single-neighbor "directly adjacent" — derive the missing bound from the
      // row next to the given neighbor in the visible order (evenly-spaced ranks
      // would otherwise collide, same fix as the project/today path).
      const implicit = {};
      if (!neighbors.after_id !== !neighbors.before_id) {
        const given = neighbors.after_id ? 'after_id' : 'before_id';
        const idx = rows.findIndex(r => r.id === neighbors[given]);
        const adj = given === 'after_id' ? rows[idx + 1] : rows[idx - 1];
        if (adj) implicit[given === 'after_id' ? 'before_id' : 'after_id'] = adj.id;
      }
      const bound = key => neighbors[key] ?? implicit[key];
      const boundRank = key => (bound(key) ? rankOf(bound(key)) : null);
      let val = between(boundRank('after_id'), boundRank('before_id'));
      const anyNull = ['after_id', 'before_id'].some(k => bound(k) && rankOf(bound(k)) === null);
      if (val === null || anyNull) {
        renorm();
        val = between(boundRank('after_id'), boundRank('before_id'));
        if (val === null) throw new ApiError(409, 'neighbors are not adjacent in that order', { current: currentList() });
      }
      upsertViewRank.run(task.id, view, val);
      afterWrite?.(); // agent-reorder discipline: auto-post the reason, if any
      return c.json({ task: attach(getTask(task.id)) });
    });
  }

  // double-submit guard: an accidental re-POST of the SAME actor's identical
  // title + project within this window is treated as a duplicate — the existing
  // task is returned (route answers 200, not a second 201) instead of a clone.
  // `force: true` in the body opts out (a deliberate re-add). Returns
  // { task, duplicate }.
  const DEDUP_WINDOW_MS = 5000;
  function createTask(fields, actor) {
    const force = fields.force === true;
    if ('force' in fields) { fields = { ...fields }; delete fields.force; }
    validateTaskBody(fields, { partial: false });
    const t = today();
    const body = { notes: '', project_id: null, when_type: null, when_date: null,
      due_date: null, due_time: null, recur: null, tags: [], steps: [],
      assignee: HUMAN, auto_close: 0, template: null, ...fields };
    if (body.status === 'archived') throw new ApiError(400, 'cannot create archived tasks');
    if (body.when_type === 'date' && !body.when_date) throw new ApiError(400, 'when_type=date requires when_date');
    if (body.when_type !== 'date' && body.when_date) throw new ApiError(400, 'when_date requires when_type=date');
    if (body.project_id && !getProject(body.project_id)) throw new ApiError(400, 'project not found');
    if (body.recur && !body.due_date) body.due_date = t; // review C4
    // dedup check (unless forced): same actor, identical trimmed title + project,
    // created within the window. Newest match wins.
    if (!force) {
      const since = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
      const dup = db.prepare(
        `SELECT * FROM tasks
          WHERE created_by = ? AND title = ? AND project_id IS ? AND created_at >= ?
          ORDER BY created_at DESC, id DESC LIMIT 1`
      ).get(actor, body.title.trim(), body.project_id ?? null, since);
      if (dup) return { task: attach(dup), duplicate: true };
    }
    const id = ulid();
    const now = new Date().toISOString();
    return tx(db, () => {
      const section = sectionOf(body, t);
      const rank = endOfSectionRank(body.project_id, section, t);
      db.prepare(
        `INSERT INTO tasks (id, title, notes, project_id, status, when_type, when_date, due_date,
                            due_time, rank, today_rank, recur, spawned_from, created_by, completed_at,
                            created_at, updated_at, assignee, auto_close, vetted, template)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)`
      ).run(id, body.title.trim(), body.notes, body.project_id, body.when_type, body.when_date,
            body.due_date, body.due_time, rank, body.recur ? JSON.stringify(body.recur) : null,
            actor, now, now, body.assignee.trim(), body.auto_close ? 1 : 0,
            UNTRUSTED.has(actor) ? 0 : 1, body.template ?? null);
      setTags(id, body.tags);
      const insStep = db.prepare('INSERT INTO steps (id, task_id, title, done, rank) VALUES (?, ?, ?, 0, ?)');
      body.steps.forEach((s, i) => insStep.run(ulid(), id, s.trim(), (i + 1) * 1024));
      return { task: attach(getTask(id)), duplicate: false };
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

  // `build` = newest mtime across the served front-end files. It changes on every
  // deploy (any edit to a public asset), so an open tab can poll /health, compare
  // build, and offer a reload when a new version has shipped.
  const buildStamp = () => {
    let m = 0;
    for (const f of ['index.html', 'app.js', 'views.js', 'detail.js', 'inline.js', 'suggest.js', 'dates.js', 'md.js', 'icons.js', 'tokens.css', 'theme-boot.js']) {
      try { m = Math.max(m, Math.round(statSync(join(PUBLIC_DIR, f)).mtimeMs)); } catch { /* missing file: skip */ }
    }
    return m;
  };
  app.get('/api/v1/health', c => c.json({ ok: true, version: VERSION, build: buildStamp() }));

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
    if (view !== undefined && !['inbox', 'today', 'upcoming', 'anytime', 'overdue', 'due_soon', 'logbook',
      'review', 'delegated', 'agents', 'queue', 'unvetted', 'needs_input', 'human'].includes(view)) {
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

  app.post('/api/v1/tasks', async c => {
    const { task, duplicate } = createTask(await readJson(c), c.get('actor'));
    return c.json(task, duplicate ? 200 : 201);
  });

  app.post('/api/v1/tasks/quickadd', async c => {
    const body = await readJson(c);
    if (typeof body.text !== 'string' || !body.text.trim()) throw new ApiError(400, 'text is required');
    for (const k of Object.keys(body)) if (k !== 'text') throw new ApiError(400, `unknown field: ${k}`);
    const projects = db.prepare('SELECT id, name FROM projects WHERE archived = 0').all();
    let fields;
    try { fields = quickParse(body.text, { projects, today: today(), admin: HUMAN }); } catch (e) { throw new ApiError(400, e.message); }
    if (!fields.title) throw new ApiError(400, 'quickadd text has no title');
    const { task, duplicate } = createTask(fields, c.get('actor'));
    return c.json(task, duplicate ? 200 : 201);
  });

  app.patch('/api/v1/tasks/:id', async c => {
    const task = getTask(c.req.param('id'));
    if (!task) throw new ApiError(404, 'task not found');
    const body = await readJson(c);
    // optional reopen comment: reopening review→active may carry a {comment}
    // (feedback-for-rework). It is NOT a task field — pull it out before
    // validation and post it to the timeline (kind=answer) before the flip.
    const comment = body.comment;
    delete body.comment;
    const want = takeExpectedVersion(c, body);
    if (comment !== undefined &&
        (typeof comment !== 'string' || comment.length > CAPS.answer)) {
      throw new ApiError(400, `comment must be a string of at most ${CAPS.answer} chars`);
    }
    validateTaskBody(body, { partial: true });
    if (body.steps !== undefined) throw new ApiError(400, 'use the /steps endpoints');
    if (body.project_id !== undefined && body.project_id !== null && !getProject(body.project_id)) {
      throw new ApiError(400, 'project not found');
    }
    const merged = { ...task, ...body };
    merged.auto_close = body.auto_close === undefined ? task.auto_close : (body.auto_close ? 1 : 0);
    if (body.assignee !== undefined) merged.assignee = body.assignee.trim();
    // reassigning a claimed task takes the work back: reset to active, clear claim
    const isReassignTakeback =
      body.assignee !== undefined && merged.assignee !== task.assignee && task.status === 'in_progress';
    if (isReassignTakeback) {
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
    // …and only the admin's own tasks hold a manual Today position. A delegated
    // task can legitimately sit in Today when its DUE date arrives (due
    // overrides assignee scoping — 2026-08-24 amendment), but delegating
    // still clears today_rank ON PURPOSE: its slot in the human's manual
    // order shouldn't survive delegation; due-driven appearances sort after
    // manually-ranked items.
    const inToday = merged.assignee === HUMAN &&
                    ((merged.when_type === 'date' && merged.when_date != null && merged.when_date <= t) ||
                     (merged.due_date != null && merged.due_date <= t));
    const todayRank = inToday ? task.today_rank : null;
    const actor = c.get('actor');
    // reopen: review → active (the human hands finished work back for rework)
    const isReopen = task.status === 'review' && merged.status === 'active';
    return tx(db, () => {
      // optimistic-concurrency check against the row as it stands NOW (fresh
      // read inside the tx — the outside read used to compute `merged` predates
      // BEGIN IMMEDIATE). No-op unless the caller supplied expected_version.
      checkVersion(getTask(task.id), want);
      // the optional reopen comment posts BEFORE the status flip so the reason
      // is attached ahead of the "reopened" line (kind=answer — it is
      // feedback-for-rework the agent reads on re-claim)
      if (isReopen && typeof comment === 'string' && comment.trim()) {
        postComment(task.id, actor, 'answer', comment.trim());
      }
      // rank is scoped to (project, section): a task moved to a new scope must
      // append there, not carry a rank minted in its old scope (collisions,
      // id-tiebreak ordering). Same placement rule as createTask.
      const rank = (merged.project_id !== task.project_id || sectionOf(merged, t) !== sectionOf(task, t))
        ? endOfSectionRank(merged.project_id, sectionOf(merged, t), t)
        : task.rank;
      // reopen (review→active) and reassign-takeback (in_progress→active) are
      // real state transitions — guard each write as a strict CAS so a concurrent
      // approve/reclaim/finish that already left the source state is a clean 409,
      // never a clobber of a committed change back to active. The takeback path is
      // only entered when the OUTSIDE read saw in_progress, so this guard catches a
      // finish/complete that raced in after that read but before BEGIN IMMEDIATE.
      const guard = isReopen ? " AND status='review'"
                  : isReassignTakeback ? " AND status='in_progress'"
                  : '';
      const { changes } = db.prepare(
        `UPDATE tasks SET title=?, notes=?, project_id=?, status=?, when_type=?, when_date=?,
                due_date=?, due_time=?, recur=?, today_rank=?, rank=?, assignee=?, auto_close=?,
                template=?, claimed_at=?, version=version+1,
                completed_at = CASE WHEN ? = 'active' THEN NULL ELSE completed_at END,
                updated_at=? WHERE id=?${guard}`
      ).run(merged.title, merged.notes, merged.project_id, merged.status, merged.when_type,
            merged.when_date, merged.due_date, merged.due_time, recurVal, todayRank, rank,
            merged.assignee, merged.auto_close, merged.template, merged.claimed_at,
            merged.status, now, task.id);
      if (isReopen && changes !== 1) {
        throw new ApiError(409, 'task is no longer in review — it was already approved, reopened, or reclaimed');
      }
      if (isReassignTakeback && changes !== 1) {
        throw new ApiError(409, 'task is no longer in progress — it was finished, reclaimed, or reassigned concurrently');
      }
      if (body.tags !== undefined) setTags(task.id, body.tags);
      // project state-changing PATCHes into the timeline (status kind, terse
      // one-liner). Reassign, archive/unarchive, and reopen (review→active) are
      // the transitions that happen through PATCH rather than a door.
      if (body.assignee !== undefined && merged.assignee !== task.assignee) {
        postComment(task.id, actor, 'status', `reassigned to ${merged.assignee}`);
      }
      if (merged.status !== task.status) {
        if (merged.status === 'archived') postComment(task.id, actor, 'status', 'archived');
        else if (merged.status === 'active' && task.status === 'archived') {
          postComment(task.id, actor, 'status', 'unarchived');
        } else if (isReopen) {
          postComment(task.id, actor, 'status', 'reopened');
        }
      }
      // reopen-to-top: a reopened task is in-flight — put it at the TOP of the
      // shared agents backlog so it's the next agent pick-up (the human can
      // drag it down). Applies to the review→active reopen regardless of
      // assignee (harmless for a human-assigned task — it isn't in that view).
      if (isReopen) viewRankToTop(task.id, 'agents');
      return c.json(attach(getTask(task.id)));
    });
  });

  // admin-only HARD delete: removes the task and everything hanging off it —
  // steps, task_tags, comments, attachments (rows via CASCADE, bytes off disk),
  // view_ranks — irreversibly. Deliberately distinct from archive, which is a
  // reversible status flip that keeps the task. 200 on success.
  app.delete('/api/v1/tasks/:id', c => {
    if (c.get('actor') !== HUMAN) throw new ApiError(403, `only the admin (${HUMAN}) can delete tasks`);
    const task = getTask(c.req.param('id'));
    if (!task) throw new ApiError(404, 'task not found');
    // capture attachment blob paths BEFORE their rows cascade away, so we can
    // unlink the files only after the DB transaction has committed
    const atts = db.prepare('SELECT id, mime FROM attachments WHERE task_id = ?').all(task.id);
    tx(db, () => {
      // task_tags has no ON DELETE CASCADE — clear it explicitly. steps,
      // comments, attachments and view_ranks cascade on the tasks delete.
      // Null any spawned_from back-reference (FK is NO ACTION) so a recurrence
      // child never blocks the delete.
      db.prepare('UPDATE tasks SET spawned_from = NULL WHERE spawned_from = ?').run(task.id);
      db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(task.id);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    });
    for (const a of atts) rmSync(filePathFor(MEDIA_DIR, a.id, a.mime), { force: true });
    return c.json({ ok: true });
  });

  // Guarded FINAL transition to done — the only place a recurrence spawns
  // (delegation design: spawn on complete, approve or auto-close finish; never
  // on entering review). Runs inside the caller's tx; only the call that
  // actually flips the row (changes===1) spawns (review O4).
  function toDone(task, fromStatuses, { report = null } = {}) {
    const now = new Date().toISOString();
    const t = today();
    const { changes } = db.prepare(
      `UPDATE tasks SET status='done', report=COALESCE(?, report), completed_at=?, updated_at=?,
              version=version+1
       WHERE id=? AND status IN (${fromStatuses.map(() => '?').join(', ')})`
    ).run(report, now, now, task.id, ...fromStatuses);
    let spawned_id;
    if (changes === 1 && task.recur) {
      const next = nextDue(JSON.parse(task.recur), task.due_date, t, t);
      spawned_id = spawn(db, task, next, t);
    }
    return { changes, spawned_id };
  }

  const doneResponse = (c, id, spawned_id) => {
    const out = { task: attach(getTask(id)) };
    if (spawned_id) out.spawned_id = spawned_id;
    return c.json(out);
  };

  app.post('/api/v1/tasks/:id/complete', c => {
    const id = c.req.param('id');
    const want = takeExpectedVersion(c, null); // body-less door: query param only
    return tx(db, () => {
      const task = getTask(id);
      if (!task) throw new ApiError(404, 'task not found');
      checkVersion(task, want);
      if (task.status === 'done') return doneResponse(c, id); // idempotent re-complete
      // strict CAS: only an active task flips to done. A concurrent claim/block/
      // archive (or an already-finished task) leaves changes=0 -> 409, never a
      // silent no-op success on a row we did not actually transition.
      const { changes, spawned_id } = toDone(task, ['active']);
      if (changes !== 1) throw new ApiError(409, `cannot complete a ${task.status} task`);
      postComment(id, c.get('actor'), 'status', 'completed');
      return doneResponse(c, id, spawned_id);
    });
  });

  // Repeat rounds of report/question/answer append under one timestamped
  // rule; lastRound recovers the most recent segment (idempotency checks).
  const ROUND_SEP = /\n\n--- \d{4}-\d{2}-\d{2}T[\d:.]+Z\n\n/;
  const appendRound = (existing, next, now) =>
    existing ? `${existing}\n\n--- ${now}\n\n${next}` : next;
  const lastRound = s => (s == null ? null : s.split(ROUND_SEP).pop());

  // ---- delegation lifecycle (claim → finish → approve) ----
  // explicit, actionable 409 messages when a claim loses the race for a task
  // that is no longer active. blocked is called out specially — only /answer
  // may leave blocked, so a claim must never resurrect it.
  const CLAIM_REJECT = {
    blocked: 'task is blocked — awaiting an answer (only /answer can unblock it)',
    review: 'task is in review — it has already been finished',
    done: 'task is already done',
    archived: 'task is archived',
  };
  app.post('/api/v1/tasks/:id/claim', c => {
    const id = c.req.param('id');
    const want = takeExpectedVersion(c, null); // body-less door: query param only
    return tx(db, () => {
      const task = getTask(id);
      if (!task) throw new ApiError(404, 'task not found');
      // agent-security layer 1: the gate is the DOOR, not just queue
      // filtering — an unvetted task cannot be worked even by id
      if (!task.vetted) throw new ApiError(403, 'task not vetted for agent execution');
      if (c.get('actor') !== task.assignee) throw new ApiError(403, 'only the assignee can claim');
      checkVersion(task, want);
      const now = new Date().toISOString();
      // strict CAS: active -> in_progress; re-claiming your own in_progress task
      // is an idempotent 200 (changes=0, claimed_at kept). version bumps only on
      // the real flip.
      const { changes } = db.prepare(
        `UPDATE tasks SET status='in_progress', claimed_at=?, updated_at=?, version=version+1
         WHERE id=? AND status='active'`
      ).run(now, now, id);
      if (changes === 0 && task.status !== 'in_progress') {
        throw new ApiError(409, CLAIM_REJECT[task.status] || `cannot claim a ${task.status} task`);
      }
      // only a real active→in_progress flip posts to the timeline; an
      // idempotent re-claim (changes=0) does not repeat the line
      if (changes === 1) postComment(id, c.get('actor'), 'status', 'claimed');
      return c.json({ task: attach(getTask(id)) });
    });
  });

  app.post('/api/v1/tasks/:id/finish', async c => {
    const id = c.req.param('id');
    const body = await readJson(c);
    const want = takeExpectedVersion(c, body);
    for (const k of Object.keys(body)) if (k !== 'report') throw new ApiError(400, `unknown field: ${k}`);
    if (typeof body.report !== 'string' || !body.report.trim() || body.report.length > CAPS.notes) {
      throw new ApiError(400, `report is required (<=${CAPS.notes} chars)`);
    }
    return tx(db, () => {
      const task = getTask(id);
      if (!task) throw new ApiError(404, 'task not found');
      if (!task.vetted) throw new ApiError(403, 'task not vetted for agent execution');
      if (c.get('actor') !== task.assignee) throw new ApiError(403, 'only the assignee can finish');
      checkVersion(task, want);
      if (task.status !== 'active' && task.status !== 'in_progress') {
        throw new ApiError(409, `cannot finish a ${task.status} task`);
      }
      const now = new Date().toISOString();
      // repeat finishes (after a reopen) append under a timestamped rule
      const report = appendRound(task.report, body.report.trim(), now);
      // project THIS round's report into the timeline (the field keeps its
      // timestamped-concat; the row is the readable projection of this finish)
      postComment(id, c.get('actor'), 'report', body.report.trim());
      if (task.auto_close) {
        // straight to done — the final transition, so recurrence spawns here
        const { changes, spawned_id } = toDone(task, ['active', 'in_progress'], { report });
        if (changes !== 1) throw new ApiError(409, `cannot finish a ${task.status} task`);
        return doneResponse(c, id, spawned_id);
      }
      // strict CAS: active|in_progress -> review; a concurrent claim/block that
      // moved the row out from under us leaves changes=0 -> 409, never a clobber.
      const { changes } = db.prepare(
        `UPDATE tasks SET status='review', report=?, updated_at=?, version=version+1
         WHERE id=? AND status IN ('active', 'in_progress')`
      ).run(report, now, id);
      if (changes !== 1) throw new ApiError(409, `cannot finish a ${task.status} task`);
      // needs-a-human event: this round just left agent hands and landed in
      // the review queue — the transition the owner asked to be notified of.
      postEvent({ ...task, status: 'review' }, 'task.review_requested', { report: body.report.trim() });
      return c.json({ task: attach(getTask(id)) });
    });
  });

  app.post('/api/v1/tasks/:id/approve', c => {
    const id = c.req.param('id');
    const want = takeExpectedVersion(c, null); // body-less door: query param only
    return tx(db, () => {
      const task = getTask(id);
      if (!task) throw new ApiError(404, 'task not found');
      if (c.get('actor') !== HUMAN) throw new ApiError(403, `only the admin (${HUMAN}) can approve`);
      checkVersion(task, want);
      if (task.status === 'done') return c.json({ task: attach(task) }); // idempotent
      if (task.status !== 'review') throw new ApiError(409, `cannot approve a ${task.status} task`);
      // strict CAS: review -> done (guarded inside toDone); a concurrent reopen
      // that flipped review->active leaves changes=0 -> 409.
      const { changes, spawned_id } = toDone(task, ['review']);
      if (changes !== 1) throw new ApiError(409, `cannot approve a ${task.status} task`);
      postComment(id, c.get('actor'), 'status', 'approved');
      postEvent({ ...task, status: 'done' }, 'task.approved');
      return doneResponse(c, id, spawned_id);
    });
  });

  // ---- needs-input (block → answer → back to active) ----
  // An agent that gets stuck asks ONE concrete question instead of guessing
  // or finishing-with-a-question. The task leaves the agent's queue until the
  // admin answers; the answer travels with the task when it is re-claimed.
  app.post('/api/v1/tasks/:id/block', async c => {
    const id = c.req.param('id');
    const body = await readJson(c);
    const want = takeExpectedVersion(c, body);
    for (const k of Object.keys(body)) if (k !== 'question') throw new ApiError(400, `unknown field: ${k}`);
    if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > CAPS.question) {
      throw new ApiError(400, `question is required (<=${CAPS.question} chars)`);
    }
    return tx(db, () => {
      const task = getTask(id);
      if (!task) throw new ApiError(404, 'task not found');
      // same gate as claim/finish: unvetted work cannot be touched by agents
      if (!task.vetted) throw new ApiError(403, 'task not vetted for agent execution');
      if (c.get('actor') !== task.assignee) throw new ApiError(403, 'only the assignee can block');
      checkVersion(task, want);
      const q = body.question.trim();
      if (task.status === 'blocked') {
        // idempotent re-block: the same question again is a 200 no-op
        if (lastRound(task.question) === q) return c.json({ task: attach(task) });
        throw new ApiError(409, 'task is already blocked on a different question — wait for the answer');
      }
      if (task.status !== 'active' && task.status !== 'in_progress') {
        throw new ApiError(409, `cannot block a ${task.status} task`);
      }
      const now = new Date().toISOString();
      // repeat rounds (block → answer → block again) append like report does;
      // claimed_at is preserved — blocking pauses the claim, not the work.
      // strict CAS: a concurrent claim/finish/complete leaves changes=0 -> 409.
      const { changes } = db.prepare(
        `UPDATE tasks SET status='blocked', question=?, updated_at=?, version=version+1
                  WHERE id=? AND status IN ('active', 'in_progress')`)
        .run(appendRound(task.question, q, now), now, id);
      if (changes !== 1) throw new ApiError(409, `cannot block a ${task.status} task`);
      // project this round's question into the timeline (field stays truth)
      postComment(id, c.get('actor'), 'question', q);
      // needs-a-human event: an agent is stuck and waiting on the admin.
      postEvent({ ...task, status: 'blocked' }, 'task.blocked', { question: q });
      return c.json({ task: attach(getTask(id)) });
    });
  });

  app.post('/api/v1/tasks/:id/answer', async c => {
    const id = c.req.param('id');
    const body = await readJson(c);
    const want = takeExpectedVersion(c, body);
    for (const k of Object.keys(body)) if (k !== 'answer') throw new ApiError(400, `unknown field: ${k}`);
    if (typeof body.answer !== 'string' || !body.answer.trim() || body.answer.length > CAPS.answer) {
      throw new ApiError(400, `answer is required (<=${CAPS.answer} chars)`);
    }
    return tx(db, () => {
      const task = getTask(id);
      if (!task) throw new ApiError(404, 'task not found');
      if (c.get('actor') !== HUMAN) throw new ApiError(403, `only the admin (${HUMAN}) can answer`);
      checkVersion(task, want);
      if (task.status !== 'blocked') throw new ApiError(409, `cannot answer a ${task.status} task`);
      const now = new Date().toISOString();
      // blocked → active; question kept alongside the answer so a re-claim
      // sees the full exchange. Repeat rounds append (same rule as report).
      // strict CAS: only a still-blocked row flips — this is the exact race the
      // hardening targets (UI answer vs. the polling cron), so a lost race is a
      // clean 409, never a double transition.
      const { changes } = db.prepare(
        `UPDATE tasks SET status='active', answer=?, updated_at=?, version=version+1
                  WHERE id=? AND status='blocked'`)
        .run(appendRound(task.answer, body.answer.trim(), now), now, id);
      if (changes !== 1) throw new ApiError(409, `cannot answer a ${task.status} task`);
      // project this round's answer into the timeline (field stays truth)
      postComment(id, c.get('actor'), 'answer', body.answer.trim());
      // status update event: the assignee (often an agent) can be notified
      // its blocker is cleared without polling the task itself.
      postEvent({ ...task, status: 'active' }, 'task.answered', { answer: body.answer.trim() });
      return c.json({ task: attach(getTask(id)) });
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
      db.prepare('UPDATE tasks SET vetted = 1, updated_at = ?, version = version + 1 WHERE id = ?')
        .run(new Date().toISOString(), id);
    }
    return c.json({ task: attach(getTask(id)) });
  });

  // per-task push authorization (migration 016). The ONLY way allow_push is set
  // (PATCH rejects the field). Admin-only, like vet — task text can never grant
  // it. Body {allow:false} revokes; default grants. Idempotent.
  app.post('/api/v1/tasks/:id/allow-push', async c => {
    const id = c.req.param('id');
    const task = getTask(id);
    if (!task) throw new ApiError(404, 'task not found');
    if (c.get('actor') !== HUMAN) throw new ApiError(403, `only the admin (${HUMAN}) can authorize push`);
    const body = await readJson(c).catch(() => ({}));
    const val = body.allow === false ? 0 : 1;
    db.prepare('UPDATE tasks SET allow_push = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .run(val, new Date().toISOString(), id);
    return c.json({ task: attach(getTask(id)) });
  });

  // Revise a task's summary/report IN PLACE — e.g. run a review report through
  // the writing skill without churning state. The report is otherwise owned by
  // /finish (PATCH still rejects it); this is the one edit door. Assignee or
  // admin; only where a report is meaningful (in_progress/review/done). Bumps
  // version so an open editor re-reads.
  app.post('/api/v1/tasks/:id/report', async c => {
    const id = c.req.param('id');
    const task = getTask(id);
    if (!task) throw new ApiError(404, 'task not found');
    const actor = c.get('actor');
    if (actor !== task.assignee && actor !== HUMAN) throw new ApiError(403, 'only the assignee or admin can edit the report');
    if (!['in_progress', 'review', 'done'].includes(task.status)) throw new ApiError(400, `cannot set a report on a ${task.status} task`);
    const body = await readJson(c);
    if (typeof body.report !== 'string' || !body.report.trim()) throw new ApiError(400, 'report required (non-empty string)');
    if (body.report.length > CAPS.notes) throw new ApiError(400, 'report too long');
    db.prepare('UPDATE tasks SET report = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .run(body.report, new Date().toISOString(), id);
    return c.json({ task: attach(getTask(id)) });
  });

  // ---- activity thread (comments) ----
  // Model: a task is a GitHub-style issue with a typed, append-only, attributed
  // timeline. Async and poll-refreshed like everything else — no live chat.
  // POST here writes the ONE client-authored kind ('comment'); the lifecycle
  // doors auto-post the other kinds. Any authenticated actor may comment (an
  // unvetted task may still receive comments — commenting is not execution, and
  // agents still can't claim/finish/block it).
  app.post('/api/v1/tasks/:id/comments', async c => {
    const id = c.req.param('id');
    const task = getTask(id);
    if (!task) throw new ApiError(404, 'task not found');
    const body = await readJson(c);
    for (const k of Object.keys(body)) if (k !== 'text') throw new ApiError(400, `unknown field: ${k}`);
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > CAPS.comment) {
      throw new ApiError(400, `text is required (<=${CAPS.comment} chars)`);
    }
    return tx(db, () => {
      postComment(id, c.get('actor'), 'comment', body.text.trim());
      const row = db.prepare(
        'SELECT id, task_id, author, kind, text, created_at FROM comments WHERE task_id = ? ORDER BY rowid DESC LIMIT 1'
      ).get(id);
      return c.json(row, 201);
    });
  });

  app.get('/api/v1/tasks/:id/comments', c => {
    const id = c.req.param('id');
    const task = getTask(id);
    if (!task) throw new ApiError(404, 'task not found');
    const items = db.prepare(
      'SELECT id, task_id, author, kind, text, created_at FROM comments WHERE task_id = ? ORDER BY created_at, rowid'
    ).all(id);
    return c.json({ items });
  });

  // ---- notification events (migration 011) ----
  // GET /api/v1/events?since=<seq>&limit=<n> — the polling endpoint the web
  // UI reads for its "needs your attention" badge/toast. `since` is the
  // `seq` cursor of the last event the caller has already seen (0 or
  // omitted = from the beginning); the response's `next_since` is always the
  // highest seq returned (or the caller's own `since` when there is nothing
  // new), so a client can poll in a tight `since = next_since` loop without
  // ever re-fetching an event or losing one across a server restart (the log
  // is a table, not an in-memory buffer). Optional ?assignee= narrows to one
  // actor's tasks, same filter shape as GET /tasks.
  app.get('/api/v1/events', c => {
    const { since: sinceRaw, limit: limitRaw, assignee } = c.req.query();
    let since = 0;
    if (sinceRaw !== undefined) {
      since = Number(sinceRaw);
      if (!Number.isInteger(since) || since < 0) throw new ApiError(400, 'since must be a non-negative integer');
    }
    const lim = Math.min(Math.max(1, Number(limitRaw) || 100), 500);
    const wheres = ['e.seq > ?'];
    const args = [since];
    if (assignee) { wheres.push('t.assignee = ?'); args.push(assignee); }
    const rows = db.prepare(
      `SELECT e.seq, e.id, e.task_id, e.event, e.payload, e.created_at
         FROM task_events e JOIN tasks t ON t.id = e.task_id
        WHERE ${wheres.join(' AND ')}
        ORDER BY e.seq ASC LIMIT ?`
    ).all(...args, lim);
    const items = rows.map(r => ({ ...r, payload: JSON.parse(r.payload) }));
    const next_since = items.length ? items[items.length - 1].seq : since;
    return c.json({ items, next_since });
  });

  app.post('/api/v1/tasks/:id/reorder', async c => {
    const task = getTask(c.req.param('id'));
    if (!task) throw new ApiError(404, 'task not found');
    const body = await readJson(c);
    for (const k of Object.keys(body)) {
      if (!['before_id', 'after_id', 'list', 'reason'].includes(k)) throw new ApiError(400, `unknown field: ${k}`);
    }
    const list = body.list ?? 'project';
    if (!['project', 'today', ...Object.keys(VIEW_RANK_LISTS)].includes(list)) {
      throw new ApiError(400, "list must be 'project', 'today', 'inbox', 'agents' or 'human'");
    }
    if (!body.before_id && !body.after_id) throw new ApiError(400, 'before_id or after_id required');
    // agent-reorder discipline: an AGENT (non-admin actor) reprioritizing its
    // backlog must say WHY. A supplied {reason} auto-posts a status timeline
    // entry; human reorders post nothing. Reason is validated whenever given.
    if (body.reason !== undefined &&
        (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > CAPS.comment)) {
      throw new ApiError(400, `reason must be a non-empty string of at most ${CAPS.comment} chars`);
    }
    const actor = c.get('actor');
    const postReorderReason = () => {
      if (actor !== HUMAN && typeof body.reason === 'string' && body.reason.trim()) {
        postComment(task.id, actor, 'status', `${actor} moved this up: ${body.reason.trim()}`);
      }
    };
    // inbox / agents / human keep their manual order in view_ranks (separate
    // table, per-view independent) — dispatch before the tasks-column path.
    if (VIEW_RANK_LISTS[list]) return viewRankReorder(c, task, body, VIEW_RANK_LISTS[list], postReorderReason);
    const t = today();
    const col = list === 'today' ? 'today_rank' : 'rank';

    // Manual Today ordering is for the admin's own rows only: delegated tasks may
    // APPEAR in Today (due-driven — 2026-08-24 amendment) but never hold a
    // today_rank, so they can't be dragged or used as reorder neighbors.
    const inTodayView = x => x.status === 'active' && x.assignee === HUMAN &&
      ((x.when_type === 'date' && x.when_date <= t) || (x.due_date != null && x.due_date <= t));
    // Project sections mirror the _default view (views.js OPEN): in_progress/
    // blocked/review tasks are still shown (and dragged) alongside active ones
    // there, so the reorder scope must accept them as neighbors too — not just
    // 'active' — or any drag touching a delegated row's neighbor 409s and the
    // client reverts with "restoring server order" even though nothing is wrong.
    const OPEN_STATUSES = ['active', 'in_progress', 'blocked', 'review'];
    const inScope = list === 'today'
      ? inTodayView
      : x => OPEN_STATUSES.includes(x.status) && x.project_id === task.project_id &&
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
            where: `status IN ('active','in_progress','blocked','review') AND project_id IS ? AND
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
      db.prepare(`UPDATE tasks SET ${col} = ?, updated_at = ?, version = version + 1 WHERE id = ?`)
        .run(val, new Date().toISOString(), task.id);
      postReorderReason(); // agent-reorder discipline: auto-post the reason, if any
      return c.json({ task: attach(getTask(task.id)) });
    });
  });

  // ---- steps ----
  // Mutation gate mirrors claim/finish/block: only the task's assignee (the
  // one actually doing the work) or the admin (owner) may add/toggle/remove
  // steps. Anyone else authenticated gets a 403, same shape as elsewhere.
  const requireStepEditor = (c, task) => {
    if (c.get('actor') !== HUMAN && c.get('actor') !== task.assignee) {
      throw new ApiError(403, 'only the assignee or admin can edit steps');
    }
  };

  app.post('/api/v1/tasks/:id/steps', async c => {
    const task = getTask(c.req.param('id'));
    if (!task) throw new ApiError(404, 'task not found');
    requireStepEditor(c, task);
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
    const task = getTask(c.req.param('id'));
    if (!task) throw new ApiError(404, 'task not found');
    requireStepEditor(c, task);
    const step = db.prepare('SELECT * FROM steps WHERE id = ? AND task_id = ?')
      .get(c.req.param('sid'), task.id);
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
    const task = getTask(c.req.param('id'));
    if (!task) throw new ApiError(404, 'task not found');
    requireStepEditor(c, task);
    const { changes } = db.prepare('DELETE FROM steps WHERE id = ? AND task_id = ?')
      .run(c.req.param('sid'), task.id);
    if (changes === 0) throw new ApiError(404, 'step not found');
    return c.json({ ok: true });
  });

  // ---- attachments (image files jpg/png + document files md/txt + doc links) ----
  // Uploaded bytes (images and docs) live as their own real file in the media
  // dir named <id>.<ext>; a LINK stores no bytes and references a local file on
  // disk. The row here is the reference. For uploads the on-disk name is ALWAYS
  // derived from the id + validated mime — the client filename is display-only
  // (never a disk path).
  const getAttachment = id => db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
  const ATT_COLS = 'id, task_id, filename, mime, bytes, retention, expires_at, created_by, created_at, kind, path';

  // Content-Type for a stored/linked document mime (adds charset for text).
  const docContentType = mime => `${mime}; charset=utf-8`;

  // Raw-body upload (no multipart dep): the bytes are the whole body,
  // Content-Type declares the mime, X-Filename is the display name, and
  // ?retention= / ?expires_at= carry the retention rule. Deliberately NOT via
  // readJson: the caps (images MAX_UPLOAD default 10MB, docs MAX_DOC default
  // 2MB) are far larger than the 256KB JSON cap.
  //
  // Two file families:
  //   images (.jpg/.png) — the magic-byte sniff is authoritative; a declared
  //     image mime that disagrees, or an unrecognized type, is 415.
  //   docs (.md/.txt) — text has no signature, so the DECLARED text mime picks
  //     this path and the bytes are validated as real UTF-8 text (binary
  //     masquerading as .md is 415).
  app.post('/api/v1/tasks/:id/attachments', async c => {
    const task = getTask(c.req.param('id'));
    if (!task) throw new ApiError(404, 'task not found');
    const docMime = normalizeDocMime(c.req.header('Content-Type'));
    const cap = docMime ? MAX_DOC : MAX_UPLOAD;
    // size gate BEFORE reading the body when a length is declared
    const declared = Number(c.req.header('Content-Length'));
    if (Number.isFinite(declared) && declared > cap) {
      throw new ApiError(413, `file exceeds the ${cap}-byte upload cap`);
    }
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.length === 0) throw new ApiError(400, 'empty body — send the raw file bytes');
    if (buf.length > cap) throw new ApiError(413, `file exceeds the ${cap}-byte upload cap`);

    let mime;
    if (docMime) {
      // text path: the declared type is authoritative; validate it is real text
      if (!isUtf8Text(buf)) {
        throw new ApiError(415, 'not valid UTF-8 text — a text/markdown or text/plain upload must be text');
      }
      mime = docMime;
    } else {
      // image path: the sniff is authoritative
      const sniffed = sniffMime(buf);
      if (!sniffed) {
        throw new ApiError(415, 'unsupported file type — only JPEG, PNG, Markdown (.md) and text (.txt) are allowed');
      }
      const declaredMime = normalizeMime(c.req.header('Content-Type'));
      if (declaredMime && declaredMime !== sniffed) {
        throw new ApiError(415, `declared type does not match the file's actual type (${sniffed})`);
      }
      mime = sniffed;
    }

    const q = c.req.query();
    const retention = q.retention ?? 'keep';
    if (!['keep', 'on_done'].includes(retention)) {
      throw new ApiError(400, "retention must be 'keep' or 'on_done'");
    }
    let expires_at = null;
    if (q.expires_at !== undefined && q.expires_at !== '') {
      if (!isDate(q.expires_at)) throw new ApiError(400, 'expires_at must be YYYY-MM-DD');
      expires_at = q.expires_at;
    }
    const id = ulid();
    const filename = sanitizeFilename(c.req.header('X-Filename'), mime);
    const now = new Date().toISOString();
    mkdirSync(MEDIA_DIR, { recursive: true });
    writeFileSync(filePathFor(MEDIA_DIR, id, mime), buf);
    db.prepare(
      `INSERT INTO attachments (${ATT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'file', NULL)`
    ).run(id, task.id, filename, mime, buf.length, retention, expires_at, c.get('actor'), now);
    return c.json(getAttachment(id), 201);
  });

  // Link a LOCAL document (no bytes stored): {path, title?}. Gated three ways —
  // (1) linking must be configured (PUNCHLIST_DOC_ROOTS non-empty), else 403;
  // (2) the actor must be trusted (never an UNTRUSTED actor), since a link
  //     streams a real on-disk file; (3) the resolved realpath must live inside
  //     an allowed root and be a .md/.txt file that exists NOW. Symlink escapes
  //     are rejected because realpathSync resolves the link before containment.
  app.post('/api/v1/tasks/:id/attachments/link', async c => {
    const task = getTask(c.req.param('id'));
    if (!task) throw new ApiError(404, 'task not found');
    if (DOC_ROOTS.length === 0) throw new ApiError(403, 'document linking not configured');
    const actor = c.get('actor');
    if (UNTRUSTED.has(actor)) {
      throw new ApiError(403, 'an untrusted actor may not link local documents');
    }
    const body = await readJson(c);
    for (const k of Object.keys(body)) {
      if (!['path', 'title'].includes(k)) throw new ApiError(400, `unknown field: ${k}`);
    }
    if (typeof body.path !== 'string' || !body.path.trim()) {
      throw new ApiError(400, 'path is required (an absolute path to a .md or .txt file)');
    }
    const reqPath = body.path.trim();
    if (!isAbsolute(reqPath)) throw new ApiError(400, 'path must be absolute');
    const ext = extname(reqPath).toLowerCase();
    const mime = docMimeForExt(ext);
    if (!mime) throw new ApiError(415, 'only .md and .txt files can be linked');
    if (body.title !== undefined && body.title !== null &&
        (typeof body.title !== 'string' || body.title.length > 200)) {
      throw new ApiError(400, 'title must be a string of at most 200 chars, or null');
    }
    let real;
    try { real = realpathSync(reqPath); }
    catch { throw new ApiError(404, 'linked file not found'); }
    if (!pathInsideRoots(real, DOC_ROOTS)) {
      throw new ApiError(403, 'path is outside the allowed document roots');
    }
    if (!statSync(real).isFile()) throw new ApiError(400, 'path is not a regular file');
    const id = ulid();
    const filename = sanitizeFilename(body.title || basename(real), mime);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO attachments (${ATT_COLS}) VALUES (?, ?, ?, ?, 0, 'keep', NULL, ?, ?, 'link', ?)`
    ).run(id, task.id, filename, mime, c.get('actor'), now, real);
    return c.json(getAttachment(id), 201);
  });

  app.get('/api/v1/tasks/:id/attachments', c => {
    const task = getTask(c.req.param('id'));
    if (!task) throw new ApiError(404, 'task not found');
    const items = db.prepare(
      `SELECT ${ATT_COLS} FROM attachments WHERE task_id = ? ORDER BY created_at, id`).all(task.id);
    return c.json({ items });
  });

  // Stream the bytes inline. Same-origin, auth'd (the whole /api/v1/* tree is);
  // nosniff so the browser honours our Content-Type and won't re-interpret it.
  // A kind='file' row streams the stored media file; a kind='link' row
  // re-validates its path against the (possibly changed) DOC_ROOTS and streams
  // the linked file's CURRENT contents, so edits to the doc show live. The UI
  // never trusts this Content-Type to render — it fetches the raw text and
  // renders through the client-side safe markdown renderer (md.js).
  app.get('/api/v1/attachments/:id', c => {
    const row = getAttachment(c.req.param('id'));
    if (!row) throw new ApiError(404, 'attachment not found');
    let body, contentType, cache;
    if (row.kind === 'link') {
      // config may have changed since the link was made: re-validate every time.
      let real;
      try { real = realpathSync(row.path); }
      catch { throw new ApiError(404, 'linked file not found'); }
      if (!pathInsideRoots(real, DOC_ROOTS) || !statSync(real).isFile()) {
        throw new ApiError(404, 'linked file not found');
      }
      body = readFileSync(real);
      contentType = docContentType(row.mime);
      cache = 'private, no-cache'; // linked doc may change on disk — always revalidate
    } else {
      const path = filePathFor(MEDIA_DIR, row.id, row.mime);
      if (!existsSync(path)) throw new ApiError(404, 'attachment file is gone');
      body = readFileSync(path);
      contentType = isDocMime(row.mime) ? docContentType(row.mime) : row.mime;
      // id-addressed immutable bytes may cache; docs revalidate for safety
      cache = isDocMime(row.mime) ? 'private, no-cache' : 'private, max-age=3600';
    }
    return c.body(body, 200, {
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${row.filename.replace(/["\\]/g, '')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CSP,
      'Cache-Control': cache,
      'Content-Length': String(body.length),
    });
  });

  app.patch('/api/v1/attachments/:id', async c => {
    const row = getAttachment(c.req.param('id'));
    if (!row) throw new ApiError(404, 'attachment not found');
    const actor = c.get('actor');
    if (actor !== HUMAN && actor !== row.created_by) {
      throw new ApiError(403, 'only the uploader or the admin can change an attachment');
    }
    const body = await readJson(c);
    for (const k of Object.keys(body)) {
      if (!['retention', 'expires_at'].includes(k)) throw new ApiError(400, `unknown field: ${k}`);
    }
    const retention = body.retention === undefined ? row.retention : body.retention;
    if (!['keep', 'on_done'].includes(retention)) {
      throw new ApiError(400, "retention must be 'keep' or 'on_done'");
    }
    let expires_at = row.expires_at;
    if (body.expires_at !== undefined) {
      if (body.expires_at === null || body.expires_at === '') expires_at = null;
      else if (!isDate(body.expires_at)) throw new ApiError(400, 'expires_at must be YYYY-MM-DD');
      else expires_at = body.expires_at;
    }
    db.prepare('UPDATE attachments SET retention = ?, expires_at = ? WHERE id = ?')
      .run(retention, expires_at, row.id);
    return c.json(getAttachment(row.id));
  });

  app.delete('/api/v1/attachments/:id', c => {
    const row = getAttachment(c.req.param('id'));
    if (!row) throw new ApiError(404, 'attachment not found');
    const actor = c.get('actor');
    if (actor !== HUMAN && actor !== row.created_by) {
      throw new ApiError(403, 'only the uploader or the admin can delete an attachment');
    }
    return tx(db, () => {
      db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
      // links reference a file we do NOT own — only unlink our own stored bytes
      if (row.kind !== 'link') rmSync(filePathFor(MEDIA_DIR, row.id, row.mime), { force: true });
      return c.json({ ok: true });
    });
  });

  // Lightweight client config probe (auth'd): tells the UI whether local-doc
  // linking is available (a configured, non-empty DOC_ROOTS) and which actors
  // are untrusted, so it can gate the "Link a doc…" affordance and require an
  // explicit confirm before rendering a doc uploaded by an untrusted actor.
  // ---- instance settings (key/value store, migration 014) ----
  const getSetting = (k, dflt = '') => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? dflt;
  const setSetting = (k, v) => db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(k, String(v));

  app.get('/api/v1/config', c => c.json({
    doc_linking: DOC_ROOTS.length > 0,
    template_editing: TPL.available && c.get('actor') === HUMAN,
    untrusted_actors: [...UNTRUSTED],
    max_doc_bytes: MAX_DOC,
    instance_name: getSetting('instance_name'), // for the footer's first paint
    actor: c.get('actor'),
  }));

  // The instance identity + governance surface. GET is readable by any actor
  // (the sweep injects context into agents); PATCH is admin-only (the context
  // becomes agent directives, so only the human may set it).
  app.get('/api/v1/instance', c => c.json({
    name: getSetting('instance_name'),
    context: getSetting('instance_context'),
    data_isolation: getSetting('data_isolation', '1') === '1',
    backup_mode: getSetting('backup_mode', 'snapshot'),
    backup_repo: getSetting('backup_repo'),
  }));

  const INSTANCE_FIELDS = new Set(['name', 'context', 'data_isolation', 'backup_mode', 'backup_repo']);
  app.patch('/api/v1/instance', async c => {
    if (c.get('actor') !== HUMAN) throw new ApiError(403, 'admin only');
    const body = await readJson(c);
    for (const k of Object.keys(body)) if (!INSTANCE_FIELDS.has(k)) throw new ApiError(400, `unknown field: ${k}`);
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.length > 200) throw new ApiError(400, 'name must be a string (<=200 chars)');
      setSetting('instance_name', body.name.trim());
    }
    if (body.context !== undefined) {
      if (typeof body.context !== 'string' || body.context.length > CAPS.notes) throw new ApiError(400, 'context too long');
      setSetting('instance_context', body.context);
    }
    if (body.data_isolation !== undefined) setSetting('data_isolation', body.data_isolation ? '1' : '0');
    if (body.backup_mode !== undefined) {
      if (!['repo', 'snapshot', 'both'].includes(body.backup_mode)) throw new ApiError(400, 'backup_mode must be repo|snapshot|both');
      setSetting('backup_mode', body.backup_mode);
    }
    if (body.backup_repo !== undefined) {
      if (typeof body.backup_repo !== 'string' || body.backup_repo.length > 1024) throw new ApiError(400, 'backup_repo must be a string (<=1024 chars)');
      setSetting('backup_repo', body.backup_repo.trim());
    }
    return c.json({
      name: getSetting('instance_name'), context: getSetting('instance_context'),
      data_isolation: getSetting('data_isolation', '1') === '1',
      backup_mode: getSetting('backup_mode', 'snapshot'), backup_repo: getSetting('backup_repo'),
    });
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
       WHERE status IN ('active', 'in_progress', 'blocked', 'review') AND project_id IS NOT NULL
       GROUP BY project_id`).all()) {
      projects[row.project_id] = row.c;
    }
    return c.json({
      inbox: count('inbox'), today: count('today'), upcoming: count('upcoming'),
      anytime: count('anytime'), // someday/no-when work off the daily plan
      due_soon: count('due_soon'), review: count('review'), delegated: count('delegated'),
      unvetted: count('unvetted'), // quarantined agent work awaiting the admin's vet
      needs_input: count('needs_input'), // blocked on a question for the admin
      projects,
      actor: c.get('actor'), // who this token belongs to (rail footer)
    });
  });

  // ---- tags ----
  // tags gain the same "context notepad" projects have (migration 015):
  // tags.notes (a readme agents read for background on everything that tag
  // touches) + tags.template (a free-string pointer to a punchlist-templates
  // template, mirroring projects.template / migration 012). No actor
  // restriction on writing notes/template — same as project PATCH — only
  // DELETE stays admin-only.
  const TAG_FIELDS = new Set(['notes', 'template']);
  function validateTagTemplate(body) {
    if (body.template !== undefined && body.template !== null &&
        (typeof body.template !== 'string' || body.template.length > CAPS.template)) {
      throw new ApiError(400, `template must be a string of at most ${CAPS.template} chars, or null`);
    }
  }
  function validateTagNotes(body) {
    if (body.notes !== undefined &&
        (typeof body.notes !== 'string' || body.notes.length > CAPS.notes)) {
      throw new ApiError(400, `notes must be a string of at most ${CAPS.notes} chars`);
    }
  }

  app.get('/api/v1/tags', c => {
    // nav listing: every tag with its open-task count (open = the statuses the
    // tag-filtered list view shows, delegated in-flight work included).
    // Small bounded set in practice — no pagination (unlike /tasks, /projects).
    const items = db.prepare(
      `SELECT g.id, g.name, g.notes, g.template, COUNT(t.id) AS count
       FROM tags g
       LEFT JOIN task_tags tt ON tt.tag_id = g.id
       LEFT JOIN tasks t ON t.id = tt.task_id AND t.status IN ('active', 'in_progress', 'blocked', 'review')
       GROUP BY g.id
       ORDER BY g.name COLLATE NOCASE, g.id`
    ).all();
    return c.json({ items });
  });

  app.post('/api/v1/tags', async c => {
    const body = await readJson(c);
    for (const k of Object.keys(body)) if (k !== 'name' && !TAG_FIELDS.has(k)) throw new ApiError(400, `unknown field: ${k}`);
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > CAPS.title) {
      throw new ApiError(400, 'name required (<=500 chars)');
    }
    validateTagNotes(body);
    validateTagTemplate(body);
    const name = body.name.trim().replace(/^#/, '');
    if (!name) throw new ApiError(400, 'name required (<=500 chars)');
    if (db.prepare('SELECT 1 FROM tags WHERE name = ? COLLATE NOCASE').get(name)) {
      throw new ApiError(409, 'tag already exists');
    }
    const id = ulid();
    db.prepare('INSERT INTO tags (id, name, notes, template) VALUES (?, ?, ?, ?)')
      .run(id, name, body.notes ?? '', body.template ?? null);
    return c.json({ id, name, notes: body.notes ?? '', template: body.template ?? null, count: 0 }, 201);
  });

  // Update a tag's context notepad / template pointer. Mirrors PATCH
  // /projects/:id (no actor restriction beyond auth — any actor may write
  // context, same as a project's notepad).
  app.patch('/api/v1/tags/:id', async c => {
    const id = c.req.param('id');
    const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
    if (!tag) throw new ApiError(404, 'tag not found');
    const body = await readJson(c);
    for (const k of Object.keys(body)) if (!TAG_FIELDS.has(k)) throw new ApiError(400, `unknown field: ${k}`);
    validateTagNotes(body);
    validateTagTemplate(body);
    const merged = { ...tag, ...body };
    db.prepare('UPDATE tags SET notes=?, template=? WHERE id=?')
      .run(merged.notes ?? '', merged.template ?? null, id);
    const count = db.prepare(
      `SELECT COUNT(*) c FROM task_tags tt JOIN tasks t ON t.id = tt.task_id
       WHERE tt.tag_id = ? AND t.status IN ('active', 'in_progress', 'blocked', 'review')`
    ).get(id).c;
    return c.json({ id, name: tag.name, notes: merged.notes ?? '', template: merged.template ?? null, count });
  });

  // admin-only: delete a tag and its task_tags rows. Tasks are untouched —
  // they simply lose the tag. Returns {ok, removed} (task_tags rows deleted).
  app.delete('/api/v1/tags/:id', c => {
    if (c.get('actor') !== HUMAN) throw new ApiError(403, `only the admin (${HUMAN}) can delete tags`);
    const id = c.req.param('id');
    const tag = db.prepare('SELECT id FROM tags WHERE id = ?').get(id);
    if (!tag) throw new ApiError(404, 'tag not found');
    return tx(db, () => {
      const { changes } = db.prepare('DELETE FROM task_tags WHERE tag_id = ?').run(id);
      db.prepare('DELETE FROM tags WHERE id = ?').run(id);
      return c.json({ ok: true, removed: changes });
    });
  });

  // ---- projects ----
  const PROJECT_FIELDS = new Set(['name', 'notes', 'parent_id', 'domain', 'archived', 'template', 'working_dir']);
  // working_dir: an absolute local path (or null). Validated only as a bounded
  // string — existence isn't checked (the dir may be created later); it is
  // operator-set, never derived from task content.
  const validateWorkingDir = body => {
    if (body.working_dir === undefined || body.working_dir === null) return;
    if (typeof body.working_dir !== 'string' || body.working_dir.length > 1024) {
      throw new ApiError(400, 'working_dir must be a string (<=1024 chars) or null');
    }
  };

  // template: a free string (a template NAME) or null — mirrors the task
  // field (migration 007); deliberately NOT validated against a known set,
  // since the templates repo is authoritative and public users may not have
  // it checked out at all (migration 012). The project's context notepad can
  // "point to" this template; the same admin-only AI-assisted editor
  // (tpleditor.js) that edits a task's template can open it for a project's.
  function validateProjectTemplate(body) {
    if (body.template !== undefined && body.template !== null &&
        (typeof body.template !== 'string' || body.template.length > CAPS.template)) {
      throw new ApiError(400, `template must be a string of at most ${CAPS.template} chars, or null`);
    }
  }

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
    validateProjectTemplate(body);
    validateWorkingDir(body);
    if (body.parent_id != null && !getProject(body.parent_id)) throw new ApiError(400, 'parent project not found');
    if (db.prepare('SELECT 1 FROM projects WHERE name = ?').get(body.name.trim())) {
      throw new ApiError(409, 'project name already exists');
    }
    const id = ulid();
    const now = new Date().toISOString();
    const { m } = db.prepare('SELECT MAX(rank) m FROM projects').get();
    db.prepare(
      `INSERT INTO projects (id, name, notes, parent_id, domain, rank, archived, created_at, updated_at, template, working_dir)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
    ).run(id, body.name.trim(), body.notes ?? '', body.parent_id ?? null, body.domain ?? null,
          (m ?? 0) + 1024, now, now, body.template ?? null, body.working_dir ?? null);
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
    validateProjectTemplate(body);
    validateWorkingDir(body);
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
      `UPDATE projects SET name=?, notes=?, parent_id=?, domain=?, archived=?, updated_at=?, template=?, working_dir=? WHERE id=?`
    ).run(merged.name.trim(), merged.notes, merged.parent_id, merged.domain, merged.archived,
          new Date().toISOString(), merged.template ?? null, merged.working_dir ?? null, project.id);
    return c.json(getProject(project.id));
  });

  // Reorder a project among its SIBLINGS (fractional rank), mirroring the task
  // reorder's neighbor→between()→renormalize-in-tx shape. {before_id?, after_id?}
  // name the target neighbors (after_id = the sibling it lands below, i.e. lower
  // rank; before_id = the sibling above it — same convention as tasks). An
  // optional {parent_id} makes it a combined reparent+reorder: the project is
  // moved under that parent AND placed at the drop position in one write (drop
  // into an EMPTY parent has no neighbors — the dialog PATCHes parent_id there).
  // Admin-only. Scoped strictly to the target parent's children, so reordering
  // under parent A never renormalizes parent B.
  app.post('/api/v1/projects/:id/reorder', async c => {
    if (c.get('actor') !== HUMAN) throw new ApiError(403, `only the admin (${HUMAN}) can reorder projects`);
    const project = getProject(c.req.param('id'));
    if (!project) throw new ApiError(404, 'project not found');
    const body = await readJson(c);
    for (const k of Object.keys(body)) {
      if (!['before_id', 'after_id', 'parent_id'].includes(k)) throw new ApiError(400, `unknown field: ${k}`);
    }
    if (!body.before_id && !body.after_id) throw new ApiError(400, 'before_id or after_id required');

    // target parent: an explicit parent_id (combined reparent+reorder) or, when
    // absent, the project's current parent (a pure sibling reorder). null = top.
    const reparenting = Object.prototype.hasOwnProperty.call(body, 'parent_id');
    const targetParent = reparenting ? (body.parent_id ?? null) : (project.parent_id ?? null);
    if (reparenting && targetParent !== null) {
      // same cycle guard as PATCH: a project can't move into its own subtree
      let cur = targetParent, hops = 0;
      while (cur != null) {
        if (cur === project.id) throw new ApiError(400, 'parent_id would create a cycle');
        const p = getProject(cur);
        if (!p) throw new ApiError(400, 'parent project not found');
        cur = p.parent_id;
        if (++hops > 100) throw new ApiError(400, 'project tree too deep');
      }
    }

    // siblings under the target parent, in the same COALESCE(rank) order as GET
    const siblingOrder = () => db.prepare(
      `SELECT id, COALESCE(rank, 9.0e18) AS k FROM projects WHERE parent_id IS ?
       ORDER BY k, id`).all(targetParent);
    // neighbors must be distinct siblings under the target parent (never the row itself)
    const neighbors = {};
    for (const key of ['after_id', 'before_id']) {
      if (!body[key]) continue;
      const n = getProject(body[key]);
      if (!n || n.id === project.id || (n.parent_id ?? null) !== targetParent) {
        throw new ApiError(409, `${key} is not a sibling in the target order`);
      }
      neighbors[key] = n;
    }

    const scope = { table: 'projects', column: 'rank', where: 'parent_id IS ?', args: [targetParent] };
    return tx(db, () => {
      // single-neighbor => "directly adjacent to it": derive the missing bound
      // from the visible sibling order (excluding the moved row), same as tasks
      const order = siblingOrder().filter(s => s.id !== project.id);
      const implicit = {};
      if (!neighbors.after_id !== !neighbors.before_id) {
        const given = neighbors.after_id ? 'after_id' : 'before_id';
        const idx = order.findIndex(s => s.id === neighbors[given].id);
        const adj = given === 'after_id' ? order[idx + 1] : order[idx - 1];
        if (adj) implicit[given === 'after_id' ? 'before_id' : 'after_id'] = adj;
      }
      const bound = key => neighbors[key] ?? implicit[key];
      const rankOf = key => bound(key) ? getProject(bound(key).id).rank : null;
      let val = between(rankOf('after_id'), rankOf('before_id'));
      const anyNull = ['after_id', 'before_id'].some(k => bound(k) && rankOf(k) === null);
      if (val === null || anyNull) {
        renormalize(db, scope); // same tx as the write (design M10)
        val = between(rankOf('after_id'), rankOf('before_id'));
        if (val === null) throw new ApiError(409, 'neighbors are not adjacent in that order');
      }
      db.prepare('UPDATE projects SET parent_id = ?, rank = ?, updated_at = ? WHERE id = ?')
        .run(targetParent, val, new Date().toISOString(), project.id);
      return c.json(getProject(project.id));
    });
  });

  // ---- templates (read-only bridge to the punchlist-templates repo) ----
  // The templates repo's `plt` regenerates templates/index.json on any change;
  // we READ that file (never shell plt — least-coupled bridge). Locate the repo
  // via PUNCHLIST_TEMPLATES_DIR, else the default checkout path. Degrade to an
  // empty list whenever the repo/index isn't present or is unreadable — public
  // users may not have the templates repo at all.
  app.get('/api/v1/templates', c => {
    const dir = process.env.PUNCHLIST_TEMPLATES_DIR ||
      join(homedir(), 'code', 'punchlist-templates');
    const file = join(dir, 'templates', 'index.json');
    try {
      if (!existsSync(file)) return c.json({ items: [] });
      const data = JSON.parse(readFileSync(file, 'utf8'));
      return c.json({ items: Array.isArray(data.templates) ? data.templates : [] });
    } catch { return c.json({ items: [] }); }
  });

  // Admin + feature gate shared by every template-editing route. 404 (not 403)
  // when the feature is off, so its existence isn't advertised to non-admins.
  // The feature gate runs BEFORE the admin check on purpose: a non-admin on a
  // feature-off instance gets 404, a non-admin on a feature-on instance gets 403.
  function requireTemplateEditing(c) {
    if (!TPL.available || !existsSync(join(TPL.dir, '.git'))) throw new ApiError(404, 'not found');
    if (c.get('actor') !== HUMAN) throw new ApiError(403, `only the admin (${HUMAN}) can edit templates`);
  }

  app.get('/api/v1/templates/:name', c => {
    requireTemplateEditing(c);
    const name = c.req.param('name');
    const markdown = readTemplate(TPL.dir, name);
    if (markdown == null) throw new ApiError(404, 'template not found');
    return c.json({ name, markdown });
  });

  app.post('/api/v1/templates/:name/ai-edit', async c => {
    requireTemplateEditing(c);
    const name = c.req.param('name');
    const body = await readJson(c);
    if (typeof body.draft !== 'string' || !Array.isArray(body.messages)) {
      throw new ApiError(400, 'draft (string) and messages (array) required');
    }
    // bound the stdin prompt (same 64KB draft cap as /save; plus message limits) so
    // a runaway draft/thread can't build an unbounded prompt for the spawn.
    if (body.draft.length > 65536) throw new ApiError(400, 'template too large');
    if (body.messages.length > 200) throw new ApiError(400, 'too many messages');
    for (const m of body.messages) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
        throw new ApiError(400, 'each message needs role user|assistant and string content');
      }
      if (m.content.length > 65536) throw new ApiError(400, 'message too large');
    }
    const prompt = buildEditPrompt({ name, draft: body.draft, messages: body.messages });
    // HARD text-only: `--tools ""` disables ALL tools (the CLI's documented way to
    // do so), so the spawned model cannot run bash / edit files / hit MCP no matter
    // what a template body tries to inject — it can only emit text. `-p` prints the
    // reply and exits; `--no-session-persistence` keeps it stateless. The prompt is
    // fed on STDIN, not argv: `--tools` is variadic (`<tools...>`) so a trailing
    // positional prompt would be swallowed as a tool name, and stdin also keeps the
    // (large, template-derived) prompt off the command line and out of `ps`.
    const { code, stdout, stderr } = await TPL.run({
      cmd: 'claude', args: ['-p', '--no-session-persistence', '--tools', ''], cwd: TPL.dir, input: prompt, timeoutMs: 120000,
    });
    if (code !== 0) throw new ApiError(502, `claude failed: ${stderr.slice(0, 500)}`);
    let parsed;
    try { parsed = parseAiReply(stdout); }
    catch { throw new ApiError(502, 'could not parse the AI reply'); }
    return c.json({ reply: parsed.note, draft: parsed.draft });
  });

  app.post('/api/v1/templates/:name/save', async c => {
    requireTemplateEditing(c);
    const name = c.req.param('name');
    if (!/^[a-z0-9-]+$/.test(name)) throw new ApiError(404, 'template not found');
    const body = await readJson(c);
    if (typeof body.draft !== 'string' || body.draft.length === 0) throw new ApiError(400, 'draft (non-empty string) required');
    if (body.draft.length > 65536) throw new ApiError(400, 'template too large');

    // 1) validate a temp copy NAMED <name>.md (filename must match for plt).
    // `plt` is not a global binary — it ships as bin/plt INSIDE the templates repo.
    // Invoke it via node (portable, no shebang/exec-bit dependency), cwd at the repo
    // so it resolves its own ROOT/templateNames for cross-ref checks. try/finally so
    // the temp dir is removed even if the write or spawn throws.
    const tmp = mkdtempSync(join(tmpdir(), 'pl-tpl-save-'));
    let v;
    try {
      const tmpFile = join(tmp, `${name}.md`);
      writeFileSync(tmpFile, body.draft);
      v = await TPL.run({ cmd: 'node', args: [join(TPL.dir, 'bin', 'plt'), 'validate', tmpFile], cwd: TPL.dir, timeoutMs: 30000 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    if (v.code !== 0) {
      // plt writes its FAIL findings to stdout; prefer that. stderr only carries
      // execFile's "Command failed: node <path>…" wrapper, which would leak the
      // internal temp path — fall back to it only when stdout is empty.
      return c.json({ ok: false, validation: v.stdout.trim() || v.stderr.trim() || 'validation failed' }, 422);
    }

    // 2) write the override into authored/, then commit (no push). `name` is
    // already constrained to ^[a-z0-9-]+$ above, so the join cannot traverse —
    // that charset guard IS the containment here.
    const authoredDir = join(TPL.dir, 'templates', 'authored');
    mkdirSync(authoredDir, { recursive: true });
    const dest = join(authoredDir, `${name}.md`);
    writeFileSync(dest, body.draft);
    const relDest = join('templates', 'authored', `${name}.md`);
    await TPL.run({ cmd: 'git', args: ['add', '--', relDest], cwd: TPL.dir, timeoutMs: 15000 });
    const commit = await TPL.run({ cmd: 'git', args: ['commit', '-m', `template(${name}): AI-assisted edit via punchlist`, '--', relDest], cwd: TPL.dir, timeoutMs: 15000 });
    return c.json({ ok: true, validation: (v.stdout || 'OK').trim(), committed: commit.code === 0 });
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
