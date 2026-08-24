// app.js — core: token flow, fetch wrapper, hash routing, quick-add, search,
// keyboard, toasts. Rendering lives in views.js; the drawer in detail.js.
import { setBasePath } from '/vendor/webawesome/webawesome.loader.js';
import { renderRail, renderMain } from '/views.js';
import { closeDetail } from '/detail.js';

setBasePath('/vendor/webawesome');

// ---- theme: follow the system, via WA theme classes ----
const mq = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  document.documentElement.classList.toggle('wa-dark', mq.matches);
  document.documentElement.classList.toggle('wa-light', !mq.matches);
}
mq.addEventListener('change', applyTheme);
applyTheme();

// ---- state ----
export const state = {
  route: { view: 'today', projectId: null, tag: null },
  tag: null,
  q: '',
  tasks: [],
  projects: [],
  tags: [],
  nextCursor: null,
};

export const todayISO = () => new Date().toLocaleDateString('en-CA');

// ---- toasts ----
export function toast(message, variant = 'danger') {
  const el = document.createElement('wa-callout');
  el.setAttribute('variant', variant);
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4500);
}

// ---- token handling ----
const TOKEN_KEY = 'av-tasks-token';
let tokenPrompt = null; // shared: concurrent 401s wait on one dialog

function promptToken() {
  if (tokenPrompt) return tokenPrompt;
  const dialog = document.getElementById('token-dialog');
  const input = document.getElementById('token-input');
  tokenPrompt = new Promise(resolve => {
    const save = () => {
      const v = input.value.trim();
      if (!v) return;
      localStorage.setItem(TOKEN_KEY, v);
      input.value = '';
      dialog.open = false;
      tokenPrompt = null;
      resolve();
    };
    document.getElementById('token-save').addEventListener('click', save, { once: true });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    dialog.open = true;
    setTimeout(() => input.focus(), 50);
  });
  return tokenPrompt;
}

// ---- fetch wrapper: bearer token, 401 -> prompt + retry ----
export async function api(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const headers = {};
    const tok = localStorage.getItem(TOKEN_KEY);
    if (tok) headers.Authorization = `Bearer ${tok}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`/api/v1${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && attempt === 0) { await promptToken(); continue; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }
}

// optimistic-update escape hatch: the DOM already changed (drag, checkbox);
// on failure restore server truth and explain.
export async function rollback(message) {
  toast(message);
  await reload();
}

// ---- when-picker dialog (used by drag-to-UPCOMING and the drawer) ----
export function pickWhen(initial) {
  const dialog = document.getElementById('when-dialog');
  const input = document.getElementById('when-date-input');
  input.value = initial || todayISO();
  return new Promise(resolve => {
    const done = value => {
      dialog.open = false;
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      dialog.removeEventListener('wa-hide', onCancel);
      resolve(value);
    };
    const ok = document.getElementById('when-ok');
    const cancel = document.getElementById('when-cancel');
    const onOk = () => done(input.value || null);
    const onCancel = e => { if (e.target === dialog || e.type === 'click') done(null); };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    dialog.addEventListener('wa-hide', onCancel);
    dialog.open = true;
  });
}

// ---- routing ----
const VIEWS = ['inbox', 'today', 'upcoming', 'logbook'];

function parseHash() {
  const h = location.hash || '#/today';
  const m = /^#\/project\/([^/]+)$/.exec(h);
  if (m) return { view: 'project', projectId: decodeURIComponent(m[1]), tag: null };
  const tm = /^#\/tag\/([^/]+)$/.exec(h);
  if (tm) return { view: 'tag', projectId: null, tag: decodeURIComponent(tm[1]) };
  const v = h.replace(/^#\//, '');
  return { view: VIEWS.includes(v) ? v : 'today', projectId: null, tag: null };
}

function onRoute() {
  const next = parseHash();
  const changed = next.view !== state.route.view || next.projectId !== state.route.projectId ||
    next.tag !== state.route.tag;
  state.route = next;
  if (changed) { state.tag = null; state.q = ''; document.getElementById('search').value = ''; }
  closeNav();
  closeDetail();
  reload();
}

export async function reload() {
  const r = state.route;
  const params = new URLSearchParams();
  if (r.view === 'project') params.set('project', r.projectId);
  else if (r.view === 'tag') params.set('tag', r.tag);
  else params.set('view', r.view);
  if (state.tag && r.view !== 'tag') params.set('tag', state.tag);
  if (state.q) params.set('q', state.q);
  params.set('limit', '500');
  try {
    const [tasksRes, projRes, tagsRes] = await Promise.all([
      api('GET', `/tasks?${params}`),
      api('GET', '/projects?limit=500'),
      api('GET', '/tags'),
    ]);
    state.tasks = tasksRes.items;
    state.nextCursor = tasksRes.next_cursor || null;
    state.projects = projRes.items;
    state.tags = tagsRes.items;
  } catch (e) {
    toast(`Load failed: ${e.message}`);
    return;
  }
  renderRail();
  renderMain();
}

export function setTagFilter(tag) {
  state.tag = state.tag === tag ? null : tag;
  reload();
}

// ---- mobile nav drawer: same rail element, slid in behind a hamburger ----
const navToggle = document.getElementById('nav-toggle');

export function closeNav() {
  document.body.classList.remove('nav-open');
  navToggle.setAttribute('aria-expanded', 'false');
}

navToggle.addEventListener('click', () => {
  const open = document.body.classList.toggle('nav-open');
  navToggle.setAttribute('aria-expanded', String(open));
});
document.getElementById('backdrop').addEventListener('click', closeNav);
// selecting anything in the rail closes the drawer (carets only toggle subtrees)
document.getElementById('rail').addEventListener('click', e => {
  if (e.target.closest('.caret, .add-child')) return;
  if (e.target.closest('a, .rail-project, .rail-tag')) closeNav();
});

// ---- quick-add + search + keyboard ----
const quickadd = document.getElementById('quickadd');
const search = document.getElementById('search');

quickadd.addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return;
  const text = quickadd.value.trim();
  if (!text) return;
  quickadd.value = '';
  try {
    await api('POST', '/tasks/quickadd', { text });
    await reload();
  } catch (err) {
    quickadd.value = text; // don't lose the input
    toast(`Add failed: ${err.message}`);
  }
});

let searchTimer = null;
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = search.value.trim();
    reload();
  }, 250);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeNav(); closeDetail(); return; }
  const t = e.target;
  if (t instanceof Element &&
      (t.closest('input, textarea, select, [contenteditable]') || t.closest('wa-dialog, wa-drawer'))) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'n') { e.preventDefault(); quickadd.focus(); }
  else if (e.key === '/') { e.preventDefault(); search.focus(); }
});

// ---- boot ----
window.addEventListener('hashchange', onRoute);
if (!location.hash) location.replace('#/today');
state.route = parseHash();
reload();
