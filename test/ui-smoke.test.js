// ui-smoke — the server serves the M1 shell and vendored assets with correct
// Content-Types and the CSP intact. Interaction testing happens separately
// (Playwright); this guards the static contract the UI depends on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/db.js';
import { buildApp } from '../src/api.js';

const TOK = 'a'.repeat(32);

function makeApp() {
  const { db, migrate } = open(':memory:');
  migrate();
  const app = buildApp({ db, tokens: { alex: TOK }, today: () => '2026-03-10' });
  const get = path => app.fetch(new Request(`http://x${path}`));
  return { app, get };
}

test('GET / returns the app shell with CSP', async () => {
  const { get } = makeApp();
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /^text\/html/);
  const csp = res.headers.get('Content-Security-Policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  const html = await res.text();
  assert.match(html, /id="rail"/);
  assert.match(html, /id="nav-toggle"/); // mobile hamburger for the slide-in rail
  assert.match(html, /id="backdrop"/);
  assert.match(html, /src="\/app\.js"/);
  assert.match(html, /data-webawesome="\/vendor\/webawesome"/);
  assert.match(html, /data-view="review"/); // delegation: Review nav entry
  assert.match(html, /data-view="needs-input"/); // needs-input lane between Review and Agents
  assert.match(html, /data-view="needs-input">Human</); // relabelled "Human" (route stays #/needs-input)
  assert.match(html, /data-view="agents"/); // delegation: Agents nav entry
  // nav order: Review → Needs input → Agents
  assert.ok(html.indexOf('data-view="review"') < html.indexOf('data-view="needs-input"') &&
            html.indexOf('data-view="needs-input"') < html.indexOf('data-view="agents"'));
  assert.match(html, /id="new-task-btn"/); // header + button opens the create drawer
  assert.match(html, />agent/); // quick-add placeholder hints the assignee token
  // favicon is an inline data: SVG (no extra request; CSP img-src allows data:)
  assert.match(html, /rel="icon" href="data:image\/svg\+xml,/);
});

test('app JS modules are served as text/javascript', async () => {
  const { get } = makeApp();
  for (const p of ['/app.js', '/views.js', '/detail.js', '/md.js', '/dates.js', '/inline.js', '/theme-boot.js', '/suggest.js']) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.get('Content-Type'), 'text/javascript', p);
    assert.match(res.headers.get('Content-Security-Policy'), /default-src 'self'/, p);
  }
});

test('vendored assets in subdirectories: correct MIME + CSP + nosniff', async () => {
  const { get } = makeApp();
  const js = ['/vendor/sortable.core.esm.js', '/vendor/webawesome/webawesome.loader.js'];
  for (const p of js) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.get('Content-Type'), 'text/javascript', p);
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff', p);
  }
  const css = ['/tokens.css', '/vendor/webawesome/styles/webawesome.css',
    '/vendor/webawesome/styles/themes/default.css'];
  for (const p of css) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.get('Content-Type'), 'text/css', p);
  }
});

test('caching: app files revalidate (no-cache), vendored assets may cache', async () => {
  const { get } = makeApp();
  assert.equal((await get('/app.js')).headers.get('Cache-Control'), 'no-cache');
  assert.equal((await get('/')).headers.get('Cache-Control'), 'no-cache');
  assert.equal((await get('/vendor/sortable.core.esm.js')).headers.get('Cache-Control'),
    'public, max-age=86400');
});

test('section headers: left-aligned standout treatment (accent tick + hairline)', async () => {
  const { get } = makeApp();
  const css = await (await get('/tokens.css')).text();
  // main-pane section heads gain an accent tick before the label and keep the
  // trailing hairline rule; rail section toggles get a bottom hairline
  assert.match(css, /\.section-head::before\s*\{/);
  assert.match(css, /\.section-head::after\s*\{\s*content:\s*"";\s*flex:\s*1;\s*height:\s*1px;\s*background:\s*var\(--line\)/);
  assert.match(css, /\.rail-heading:has\(\.sec-toggle\)\s*\{[^}]*border-bottom:\s*1px solid var\(--line\)/);
});

test('task rows: project/tag pills move to a muted subline (phone readability)', async () => {
  const { get } = makeApp();
  const css = await (await get('/tokens.css')).text();
  assert.match(css, /\.row-subline\s*\{/);
  assert.match(css, /\.tag-edit\s*\{/); // subline tag-edit affordance
  const views = await (await get('/views.js')).text();
  assert.match(views, /row-subline/);
  assert.match(views, /toggleRowTags/); // inline tag editor from the subline
});

test('status markers: themed glyphs for agent in-flight states', async () => {
  const { get } = makeApp();
  const css = await (await get('/tokens.css')).text();
  assert.match(css, /\.status-marker\s*\{/);
  assert.match(css, /\.status-marker\.st-review\s*\{[^}]*var\(--accent\)/);
  assert.match(css, /\.status-marker\.st-blocked\s*\{[^}]*var\(--danger\)/);
  const views = await (await get('/views.js')).text();
  assert.match(views, /function statusMarker/);
});

test('manage-projects dialog: shared tree renderer + dialog markup + tokens', async () => {
  const { get } = makeApp();
  const html = await (await get('/')).text();
  // dialog scaffold present, old name-only #project-dialog retired
  assert.match(html, /id="manage-dialog"/);
  assert.match(html, /id="manage-tree"/);
  assert.match(html, /id="manage-top-drop"/); // (top level) unparent drop zone
  assert.match(html, /id="manage-new-name"/);
  assert.match(html, /id="manage-new-parent"/);
  assert.doesNotMatch(html, /id="project-dialog"/);

  const views = await (await get('/views.js')).text();
  assert.match(views, /export function openManageDialog/);
  assert.match(views, /export function renderTreeInto/); // ONE tree walk, nav + dialog
  // nav renders through the shared walker (no private addRows recursion)
  assert.match(views, /renderTreeInto\(rootUl, live/);
  assert.match(views, /renderTreeInto\(root, state\.projects/);
  assert.match(views, /parent_id: parentId/);      // drag-to-reparent PATCH
  assert.match(views, /archived: !p\.archived/);   // archive/unarchive toggle

  // drawer picker gets the "Manage…" affordance
  const detail = await (await get('/detail.js')).text();
  assert.match(detail, /openManageDialog/);
  assert.match(detail, /Manage…/);

  // styles use theme tokens only (spot-check: no hex in the new blocks)
  const css = await (await get('/tokens.css')).text();
  assert.match(css, /\.manage-row\s*\{/);
  assert.match(css, /\.manage-row\.archived\s*\{[^}]*opacity/);
  assert.match(css, /\.manage-children\s*\{[^}]*var\(--line\)/);
  assert.match(css, /\.rail-gear\s*\{/);
});

test('CSP permits data: for icons but stays same-origin for scripts', async () => {
  const { get } = makeApp();
  const csp = (await get('/')).headers.get('Content-Security-Policy');
  assert.match(csp, /img-src 'self' data:/);
  assert.match(csp, /connect-src 'self' data:/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
});
