// app.js — core: token flow, fetch wrapper, hash routing, quick-add, search,
// keyboard, toasts. Rendering lives in views.js; the drawer in detail.js.

// the ONE place the app's name lives in JS (index.html's <title>/#brand-name
// are synced from it at boot); rename here + <title> text only.
// Wordmark shows APP_NAME; CLI-ish surfaces (title, footer) use the lowercase.
export const APP_NAME = 'Punchlist';
import { setBasePath } from '/vendor/webawesome/webawesome.loader.js';
import { renderRail, renderMain, openNewTask, animateOnce, mountPathField } from '/views.js';
import { collapseInline, cancelCreate } from '/inline.js';

setBasePath('/vendor/webawesome');

// ---- themes: stored pref, "system" follows the OS; boot flash is handled
// by theme-boot.js (blocking, pre-CSS). This mirrors that logic for runtime.
const THEME_GROUPS = [
  ['System', ['system']],
  ['Light', ['light', 'paper', 'slate', 'rose', 'solar', 'mint', 'lilac', 'latte', 'azure', 'glass-light', 'conifer', 'clay', 'coral', 'mustard', 'fog']],
  ['Dark', ['dark', 'spruce', 'midnight', 'ember', 'nord', 'grape', 'ocean', 'terminal', 'cobalt', 'glass-dark', 'synthwave', 'maroon', 'plum', 'jade', 'charcoal']],
];
const THEMES = THEME_GROUPS.flatMap(([, list]) => list);
const DARK_THEMES = new Set(THEME_GROUPS[2][1]);
const THEME_KEY = 'av-tasks-theme';
const mq = matchMedia('(prefers-color-scheme: dark)');

export function themePref() {
  try { const v = localStorage.getItem(THEME_KEY); return THEMES.includes(v) ? v : 'system'; }
  catch { return 'system'; }
}
function applyTheme() {
  const pref = themePref();
  const resolved = pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref;
  const h = document.documentElement;
  h.setAttribute('data-theme', resolved);
  h.classList.remove('wa-dark', 'wa-light');
  h.classList.add(DARK_THEMES.has(resolved) ? 'wa-dark' : 'wa-light');
}
mq.addEventListener('change', applyTheme);
applyTheme();

// picker: swatch grid grouped System / Light / Dark, current pref highlighted
function renderThemeChoices() {
  const box = document.getElementById('theme-choices');
  box.replaceChildren();
  const current = themePref();
  for (const [groupLabel, list] of THEME_GROUPS) {
    const lab = document.createElement('div');
    lab.className = 'theme-group-label';
    lab.textContent = groupLabel;
    box.append(lab);
    for (const t of list) {
      const b = document.createElement('button');
      b.className = `theme-choice${t === current ? ' on' : ''}`;
      const sw = document.createElement('span');
      sw.className = `swatch swatch-${t}`;
      const label = document.createElement('span');
      // title-case each hyphen segment: "glass-light" -> "Glass Light"
      label.textContent = t.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      b.append(sw, label);
      b.addEventListener('click', () => {
        try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ }
        applyTheme();
        document.getElementById('theme-dialog').open = false;
      });
      box.append(b);
    }
  }
}
document.getElementById('theme-open').addEventListener('click', () => {
  renderThemeChoices();
  document.getElementById('theme-dialog').open = true;
});
// the (i) on the "Agent flows" nav heading explains the delegation lifecycle
document.getElementById('agentflows-info').addEventListener('click', () => {
  document.getElementById('agentflows-dialog').open = true;
});
document.getElementById('agentflows-close').addEventListener('click', () => {
  document.getElementById('agentflows-dialog').open = false;
});

// ---- state ----
export const state = {
  route: { view: 'today', projectId: null, tag: null },
  tag: null,
  q: '',
  tasks: [],
  projects: [],
  tags: [],
  counts: null,
  dueSoon: [],
  version: '',
  instanceName: '',
  nextCursor: null,
};

document.getElementById('brand-name').textContent = APP_NAME;
document.title = APP_NAME.toLowerCase();

// The signed-in actor (from /counts). Falls back to 'owner' before first load.
export function currentActor() { return state.counts?.actor || 'owner'; }

// rail footer: instance name (a link to the Instance dialog) · version · actor
function renderFoot() {
  const foot = document.getElementById('rail-foot');
  foot.replaceChildren();
  const link = document.createElement('button');
  link.className = 'foot-instance';
  link.textContent = state.instanceName || APP_NAME.toLowerCase();
  link.title = 'Instance settings';
  link.addEventListener('click', openInstanceDialog);
  foot.append(link);
  const tail = [];
  if (state.version) tail.push(`v${state.version}`);
  if (state.counts?.actor) tail.push(`signed in as ${state.counts.actor}`);
  if (tail.length) foot.append(document.createTextNode(' · ' + tail.join(' · ')));
}

// Instance settings dialog: name + global context (agent directives) + the
// data-isolation flag + backup config. PATCH is admin-only (server-enforced);
// non-admins can view. Populated fresh from GET /instance on open.
async function openInstanceDialog() {
  const dlg = document.getElementById('instance-dialog');
  let inst;
  try { inst = await api('GET', '/instance'); } catch (e) { toast(`Load failed: ${e.message}`); return; }
  document.getElementById('instance-name').value = inst.name || '';
  document.getElementById('instance-context').value = inst.context || '';
  document.getElementById('instance-isolation').checked = !!inst.data_isolation;
  document.getElementById('instance-backup-mode').value = inst.backup_mode || 'snapshot';
  document.getElementById('instance-backup-repo').value = inst.backup_repo || '';
  document.getElementById('instance-kb-url').value = inst.kb_url || '';
  // working_dir/kb_path: the same path-picker (text input + server-side dir
  // browser) projects/tags use, mirrored here as the instance-wide BASE
  // context — mountPathField just needs an object with the right prop names.
  const wd = mountPathField('instance-working-dir', inst, 'working_dir');
  const kb = mountPathField('instance-kb-path', inst, 'kb_path');
  document.getElementById('instance-save').onclick = async () => {
    try {
      const saved = await api('PATCH', '/instance', {
        name: document.getElementById('instance-name').value,
        context: document.getElementById('instance-context').value,
        data_isolation: document.getElementById('instance-isolation').checked,
        backup_mode: document.getElementById('instance-backup-mode').value,
        backup_repo: document.getElementById('instance-backup-repo').value,
        kb_url: document.getElementById('instance-kb-url').value.trim(),
        working_dir: wd.value.trim(),
        kb_path: kb.value.trim(),
      });
      state.instanceName = saved.name;
      inst = saved;
      renderFoot();
    } catch (e) { toast(`Save failed: ${e.message}`); }
    dlg.open = false;
  };
  document.getElementById('instance-cancel').onclick = () => { dlg.open = false; };
  document.getElementById('instance-kb').onclick = () => { dlg.open = false; import('/kb.js').then(m => m.openKbBrowser()); };
  // Full editor: opens the tailscale-serve URL for SilverBullet in a new tab.
  // Only ever navigates to an http(s) URL the admin typed/saved — validated
  // client-side too, so a stray non-http value (or an empty one) never opens
  // about:blank or a javascript: URL.
  document.getElementById('instance-kb-edit').onclick = () => {
    const url = (document.getElementById('instance-kb-url').value || inst.kb_url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      toast('Set the editor URL first: run `punchlist expose-kb` and paste the https://<magicdns-name>/ URL here.');
      return;
    }
    window.open(url, '_blank', 'noopener');
  };
  dlg.open = true;
}
// --- new-version detection: an SPA doesn't re-fetch its JS on in-app nav, so an
// open tab can run stale code after a deploy. Poll /health's `build` stamp and,
// when it changes, offer a one-tap reload. ---
let loadedBuild = null;
function showReloadBanner() {
  if (document.getElementById('reload-banner')) return;
  const bar = document.createElement('div');
  bar.id = 'reload-banner';
  bar.append(document.createTextNode('A new version is available. '));
  const btn = document.createElement('button');
  btn.textContent = 'Reload';
  btn.addEventListener('click', () => location.reload());
  bar.append(btn);
  document.body.append(bar);
}
fetch('/api/v1/health').then(r => r.json())
  .then(h => { state.version = h.version || ''; loadedBuild = h.build ?? null; renderFoot(); })
  .catch(() => {});
// instance name for the footer (auth'd; silently skipped until a token is set)
api('GET', '/instance').then(i => { state.instanceName = i.name || ''; renderFoot(); }).catch(() => {});
setInterval(async () => {
  try {
    const h = await (await fetch('/api/v1/health', { cache: 'no-store' })).json();
    if (loadedBuild != null && h.build != null && h.build !== loadedBuild) showReloadBanner();
  } catch { /* offline: try again next tick */ }
}, 120000);

// due-soon window (days ahead), persisted; server validates 1..365
export function dueWindow() {
  const v = Number(localStorage.getItem('av-tasks-due-window'));
  return Number.isInteger(v) && v >= 1 && v <= 365 ? v : 30;
}

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

// ---- attachment helpers: uploads send RAW bytes (not JSON), and the image
// bytes are fetched WITH the bearer token then shown via an object URL — an
// <img src> can't carry Authorization, and the GET is auth'd like the rest. ----
// The Content-Type the server sees decides the upload path: an image mime takes
// the magic-byte path, a text mime the doc path. Browsers often report an empty
// or generic file.type for .md, so derive the mime from the extension when the
// file is a document — otherwise the server can't tell it's meant as a doc.
export function attachmentMime(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'text/markdown';
  if (ext === 'txt') return 'text/plain';
  if (file.type === 'image/png' || file.type === 'image/jpeg') return file.type;
  return file.type || 'application/octet-stream';
}

export async function uploadAttachment(taskId, file, { retention = 'keep', expiresAt = null } = {}) {
  const params = new URLSearchParams({ retention });
  if (expiresAt) params.set('expires_at', expiresAt);
  for (let attempt = 0; ; attempt++) {
    const headers = { 'Content-Type': attachmentMime(file), 'X-Filename': file.name };
    const tok = localStorage.getItem(TOKEN_KEY);
    if (tok) headers.Authorization = `Bearer ${tok}`;
    const res = await fetch(`/api/v1/tasks/${taskId}/attachments?${params}`,
      { method: 'POST', headers, body: file });
    if (res.status === 401 && attempt === 0) { await promptToken(); continue; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(json.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
    return json;
  }
}

// Link a LOCAL document (kind='link'): no bytes, just a path the server
// re-validates against its allowed roots. Trusted actors only + roots must be
// configured, else the server 403s.
export async function linkDoc(taskId, path, title) {
  const body = { path };
  if (title) body.title = title;
  return api('POST', `/tasks/${taskId}/attachments/link`, body);
}

// Fetch an attachment's bytes as an object URL (caller revokes when done).
export async function attachmentObjectURL(id) {
  const headers = {};
  const tok = localStorage.getItem(TOKEN_KEY);
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(`/api/v1/attachments/${id}`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

// Fetch a document attachment's RAW text (with the bearer token) so the client
// can render it itself via md.js — the server's rendering is never trusted.
export async function attachmentText(id) {
  const headers = {};
  const tok = localStorage.getItem(TOKEN_KEY);
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(`/api/v1/attachments/${id}`, { headers });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.text();
}

// Small client-config probe: whether local-doc linking is available and which
// actors are untrusted (their uploads render only behind an explicit confirm).
// Cached for the session — the config is static per server process.
let _configCache = null;
export async function getConfig() {
  if (_configCache) return _configCache;
  try { _configCache = await api('GET', '/config'); }
  catch { _configCache = { doc_linking: false, untrusted_actors: [] }; }
  return _configCache;
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
const VIEWS = ['inbox', 'today', 'upcoming', 'anytime', 'logbook', 'review', 'needs-input', 'agents'];

function parseHash() {
  const h = location.hash || '#/today';
  const m = /^#\/project\/([^/]+)$/.exec(h);
  if (m) return { view: 'project', projectId: decodeURIComponent(m[1]), tag: null };
  const tm = /^#\/tag\/([^/]+)$/.exec(h);
  if (tm) return { view: 'tag', projectId: null, tag: decodeURIComponent(tm[1]) };
  const v = h.replace(/^#\//, '');
  // #/human is an alias for the needs-input lane (relabelled "Human");
  // #/needs-input keeps working unchanged
  if (v === 'human') return { view: 'needs-input', projectId: null, tag: null };
  return { view: VIEWS.includes(v) ? v : 'today', projectId: null, tag: null };
}

function onRoute() {
  const next = parseHash();
  const changed = next.view !== state.route.view || next.projectId !== state.route.projectId ||
    next.tag !== state.route.tag;
  state.route = next;
  if (changed) {
    state.tag = null; state.q = ''; document.getElementById('search').value = '';
    animateOnce.list = true; // entering a view: rows slide in once
  }
  closeNav();
  cancelCreate();
  collapseInline({ sync: false }); // reload() below re-renders the list fresh
  reload();
}

export async function reload() {
  const r = state.route;
  const params = new URLSearchParams();
  if (r.view === 'project') params.set('project', r.projectId);
  else if (r.view === 'tag') params.set('tag', r.tag);
  else if (r.view === 'agents') params.set('view', 'agents'); // shared backlog, global manual order
  else if (r.view === 'needs-input') params.set('view', 'human'); // Human lane, drag-reorderable
  else params.set('view', r.view);
  if (state.tag && r.view !== 'tag') params.set('tag', state.tag);
  if (state.q) params.set('q', state.q);
  params.set('limit', '500');
  try {
    const w = dueWindow();
    const [tasksRes, projRes, tagsRes, countsRes, dueSoonRes] = await Promise.all([
      api('GET', `/tasks?${params}`),
      api('GET', '/projects?limit=500'),
      api('GET', '/tags'),
      api('GET', `/counts?window=${w}`),
      r.view === 'today' ? api('GET', `/tasks?view=due_soon&window=${w}&limit=500`) : null,
    ]);
    state.tasks = tasksRes.items;
    state.nextCursor = tasksRes.next_cursor || null;
    state.projects = projRes.items;
    state.tags = tagsRes.items;
    state.counts = countsRes;
    state.dueSoon = dueSoonRes ? dueSoonRes.items : [];
  } catch (e) {
    toast(`Load failed: ${e.message}`);
    return;
  }
  renderRail();
  renderMain();
  renderFoot();
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

// double-submit guard: while one quick-add is in flight, ignore further Enters
// (and disable the field) so a fast double-tap can't POST the same task twice.
let quickAdding = false;
quickadd.addEventListener('keydown', async e => {
  if (e.key !== 'Enter' || quickAdding) return;
  const text = quickadd.value.trim();
  if (!text) return;
  quickAdding = true;
  quickadd.value = '';
  quickadd.disabled = true;
  try {
    await api('POST', '/tasks/quickadd', { text });
    animateOnce.list = true; // the new task slides into the list
    await reload();
  } catch (err) {
    quickadd.value = text; // don't lose the input
    toast(`Add failed: ${err.message}`);
  } finally {
    quickAdding = false;
    quickadd.disabled = false;
    quickadd.focus();
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
  if (e.key === 'Escape') {
    if (collapseInline() || cancelCreate()) return; // inline editor / create card first
    closeNav();
    return;
  }
  const t = e.target;
  if (t instanceof Element &&
      (t.closest('input, textarea, select, [contenteditable]') || t.closest('wa-dialog, wa-drawer'))) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'N' && e.shiftKey) { e.preventDefault(); openNewTask(); }
  else if (e.key === 'n') { e.preventDefault(); quickadd.focus(); }
  else if (e.key === '/') { e.preventDefault(); search.focus(); }
});

// ---- notification events (in-app polling, migration 011) ----
// The owner's answer to "what's the first webhook consumer?" was: punchlist's
// own web UI, and it must survive a restart. So instead of an outbound HTTP
// webhook, the server keeps a persisted task_events log and this poller reads
// it via GET /api/v1/events?since=<cursor> — a client that was closed (or a
// server that restarted) never loses an event, it just catches up on the next
// poll. The cursor is kept in localStorage so a page reload doesn't re-toast
// events already seen in a prior session.
const EVENTS_SINCE_KEY = 'av-tasks-events-since';
const EVENTS_POLL_MS = 15000;

function eventsSince() {
  const v = Number(localStorage.getItem(EVENTS_SINCE_KEY));
  return Number.isInteger(v) && v >= 0 ? v : 0;
}
function setEventsSince(v) {
  try { localStorage.setItem(EVENTS_SINCE_KEY, String(v)); } catch { /* private mode */ }
}

// Notifications are DELIBERATELY quiet: no toasts. A screen-filling wall of
// event toasts stole focus and buried in-flight work. Instead, changes surface
// as (a) the rail's own count badges + attention dot (via reload()), and (b) a
// browser-tab count badge — "(3) punchlist" — accumulated only while you're not
// looking, and cleared the moment the window regains focus. Short status toasts
// from your OWN actions ("added to queue", "back in review") are unaffected.
// Native/iOS push notifications were considered and are OUT OF SCOPE for this
// change: they need a service worker + push subscription + a push endpoint,
// well beyond a tab-title badge.
let unreadEvents = 0;
function setTabBadge() {
  const base = APP_NAME.toLowerCase();
  document.title = unreadEvents > 0 ? `(${unreadEvents}) ${base}` : base;
}
window.addEventListener('focus', () => { if (unreadEvents) { unreadEvents = 0; setTabBadge(); } });

// First-ever run (no stored cursor): silently adopt the current tail instead of
// counting the whole history at once. Every poll after that bumps the tab badge
// (when unfocused) + a quiet reload() so the rail badges pick up the change.
let eventsBooted = localStorage.getItem(EVENTS_SINCE_KEY) !== null;

async function pollEvents() {
  let res;
  try { res = await api('GET', `/events?since=${eventsSince()}`); }
  catch { return; } // offline/unauthorized — try again next tick, no spam
  if (!eventsBooted) {
    setEventsSince(res.next_since);
    eventsBooted = true;
    return;
  }
  if (res.items.length) {
    // count only when you can't see the change already; a focused tab shows it
    // via the rail badges that reload() refreshes below.
    if (document.hidden || !document.hasFocus()) {
      unreadEvents += res.items.length;
      setTabBadge();
    }
    setEventsSince(res.next_since);
    reload();
  }
}
setInterval(pollEvents, EVENTS_POLL_MS);
pollEvents();

// ---- boot ----
window.addEventListener('hashchange', onRoute);
if (!location.hash) location.replace('#/today');
state.route = parseHash();
reload();
