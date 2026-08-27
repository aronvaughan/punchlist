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

test('task rows: title line is title+due only; everything else on an icon-pilled subline', async () => {
  const { get } = makeApp();
  const css = await (await get('/tokens.css')).text();
  assert.match(css, /\.row-subline\s*\{[^}]*flex-wrap:\s*wrap/); // subline wraps, no collision
  assert.match(css, /\.pill-icon\s*\{[^}]*stroke:\s*currentColor/); // type-icons theme-token colored
  assert.match(css, /\.chip\.tags-indicator\s*\{/);
  const views = await (await get('/views.js')).text();
  assert.match(views, /function pillIcon/);
  assert.match(views, /function iconPill/);
  // the title line carries only the title (+ due); assignee/project/status/tags
  // moved to the subline
  assert.match(views, /titleLine\.append\(el\('span', 'title', task\.title\)\)/);
  assert.match(views, /subline\.append\(iconPill\('project'/);
  assert.match(views, /subline\.append\(iconPill\('assignee'/);
  // tags are display-only on the row: a tag-count indicator that opens the drawer
  assert.match(views, /tags-indicator/);
  assert.match(views, /ind\.addEventListener\('click', e => \{ e\.stopPropagation\(\); openDetail\(task\); \}\)/);
  assert.doesNotMatch(views, /toggleRowTags/); // inline row tag-editing is gone
});

test('drawer: tag editor relocated to the bottom (single edit surface)', async () => {
  const { get } = makeApp();
  const detail = await (await get('/detail.js')).text();
  // tags no longer in the top field group; appended just before the actions row
  assert.doesNotMatch(detail, /assigneeEditor\(\), templateEditor\(\), tagsEditor\(\)/);
  assert.match(detail, /assigned tags \+ editor at the BOTTOM/);
  assert.match(detail, /body\.append\(tagsEditor\(\)\);\n\s*body\.append\(actions\(\)\)/);
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
  assert.match(html, /id="manage-show-archived"/); // icon toggle: archived hidden by default
  assert.doesNotMatch(html, /id="project-dialog"/);

  const views = await (await get('/views.js')).text();
  assert.match(views, /export function openManageDialog/);
  assert.match(views, /export function renderTreeInto/); // ONE tree walk, nav + dialog
  // nav renders through the shared walker (no private addRows recursion)
  assert.match(views, /renderTreeInto\(rootUl, live/);
  assert.match(views, /renderTreeInto\(root, projects/); // dialog tree (archived-filtered)
  assert.match(views, /manageShowArchived \|\| !p\.archived/); // archived hidden by default
  assert.match(views, /parent_id: parentId/);      // drag-to-reparent PATCH
  assert.match(views, /archived: !p\.archived/);   // archive/unarchive toggle
  // the gear on the rail Projects header is gone; the dialog opens from
  // "+ New project" and the per-parent + only
  assert.doesNotMatch(views, /rail-gear/);
  // the reparent drag handle reuses the step-row ⋮⋮ grip (.grip), not a
  // bespoke .manage-grip
  assert.match(views, /el\('span', 'grip'\)/);
  assert.doesNotMatch(views, /manage-grip/);

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

test('motion: subtle entrance + press feedback, all gated on reduced-motion', async () => {
  const { get } = makeApp();
  const css = await (await get('/tokens.css')).text();
  // keyframes are transform/opacity only (compositor — no CLS)
  assert.match(css, /@keyframes row-in\b/);
  assert.match(css, /@keyframes marker-in\b/);
  assert.match(css, /@keyframes toast-in\b/);
  // one-shot entrance classes the renderers toggle (list / rail subtree / dialog)
  assert.match(css, /#list\.anim-in \.task-row\s*\{[^}]*animation:\s*row-in/);
  assert.match(css, /#rail-projects\.anim-in .* \.rail-project\s*\{[^}]*animation:\s*row-in/);
  assert.match(css, /#manage-tree\.anim-in \.manage-row\s*\{[^}]*animation:\s*row-in/);
  assert.match(css, /#toasts > \*\s*\{[^}]*animation:\s*toast-in/);
  assert.match(css, /\.status-marker\s*\{[^}]*animation:\s*marker-in/);
  // press feedback + all of the above live UNDER the no-preference guard
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\)/);
  assert.match(css, /#new-task-btn:active[^{]*\{[^}]*scale\(/);
  assert.match(css, /wa-button\[variant="brand"\]:active::part\(base\)\s*\{[^}]*scale\(/);

  // renderers gate entrance behind a one-shot intent flag, not every reload
  const views = await (await get('/views.js')).text();
  assert.match(views, /export const animateOnce/);
  assert.match(views, /anim-in['"]?,\s*animateOnce\.(list|rail|manage)/);
});

test('CSP permits data: for icons but stays same-origin for scripts', async () => {
  const { get } = makeApp();
  const csp = (await get('/')).headers.get('Content-Security-Policy');
  assert.match(csp, /img-src 'self' data:/);
  assert.match(csp, /connect-src 'self' data:/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
});

test('activity thread: drawer Timeline + composer, md-safe rendering (Part A)', async () => {
  const { get } = makeApp();
  const detail = await (await get('/detail.js')).text();
  // a Timeline section + a comment composer that POSTs then refreshes
  assert.match(detail, /function timelineSection/);
  assert.match(detail, /\/tasks\/\$\{task\.id\}\/comments/);
  assert.match(detail, /timelineSection\(task\)/); // wired into the drawer
  // md-safety: comment text goes through the safe md renderer — never raw innerHTML
  assert.match(detail, /mdToHtml\(cm\.text\)/);
  assert.doesNotMatch(detail, /innerHTML\s*=\s*cm\.text/);
  // kind styling classes for the entry types
  const css = await (await get('/tokens.css')).text();
  assert.match(css, /\.tl-question,\s*\.tl-answer,\s*\.tl-report\s*\{[^}]*border-left:\s*3px solid var\(--accent\)/);
  assert.match(css, /\.tl-status\s*\{[^}]*var\(--line\)/); // status one-liner subtle rule
  assert.match(css, /\.chip\.comment-count\s*\{/);
  // the row 💬 count chip
  const views = await (await get('/views.js')).text();
  assert.match(views, /comment-count/);
  assert.match(views, /task\.comment_count > 0/);
});

test('template picker: drawer select from GET /templates + name chip (Part B)', async () => {
  const { get } = makeApp();
  const detail = await (await get('/detail.js')).text();
  assert.match(detail, /function templateEditor/);
  assert.match(detail, /api\('GET', '\/templates'\)/);
  assert.match(detail, /patch\(\{ template: sel\.value \|\| null \}\)/);
  assert.match(detail, /templateEditor\(\)/); // wired into the drawer
  const css = await (await get('/tokens.css')).text();
  assert.match(css, /\.template-picker-row\s*\{/);
  assert.match(css, /\.chip\.template-chip\s*\{/);
});

test('task delete: row overflow menu + drawer trash, tokens only, distinct from archive', async () => {
  const { get } = makeApp();
  const views = await (await get('/views.js')).text();
  assert.match(views, /export async function performDelete/);
  assert.match(views, /This can't be undone/); // exact confirm copy
  assert.match(views, /row-overflow/);          // the "…" affordance
  assert.match(views, /function openRowMenu/);  // the one-item Delete menu
  const detail = await (await get('/detail.js')).text();
  assert.match(detail, /performDelete\(current\)/); // wired into the drawer actions
  assert.match(detail, /detail-delete/);
  const css = await (await get('/tokens.css')).text();
  assert.match(css, /\.row-overflow\s*\{/);
  assert.match(css, /\.row-menu\s*\{/);
  assert.match(css, /\.row-menu-item\.danger\s*\{[^}]*var\(--danger\)/);
});

test('duplicate-create guard: client debounces both add flows', async () => {
  const { get } = makeApp();
  const app = await (await get('/app.js')).text();
  assert.match(app, /quickAdding/);         // quick-add in-flight flag
  assert.match(app, /quickadd\.disabled = true/);
  const detail = await (await get('/detail.js')).text();
  assert.match(detail, /if \(creating\) return/); // drawer Create re-entrancy guard
  assert.match(detail, /setAttribute\('loading', ''\)/);
});
