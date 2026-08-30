// ui-smoke — the server serves the M1 shell and vendored assets with correct
// Content-Types and the CSP intact. Interaction testing happens separately
// (Playwright); this guards the static contract the UI depends on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { open } from '../src/db.js';
import { buildApp } from '../src/api.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

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
  assert.match(html, /data-view="needs-input"/); // Human lane (route stays #/needs-input)
  assert.match(html, /data-view="needs-input">Human</); // relabelled "Human" (route stays #/needs-input)
  assert.match(html, /data-view="agents"/); // delegation: Agents nav entry
  // two nav sections: Tasks then Agent flows (the latter carries an (i) explainer)
  assert.match(html, /class="rail-heading">Tasks</);
  assert.match(html, /rail-heading rail-heading-info">\s*<span>Agent flows<\/span>/);
  assert.match(html, /id="agentflows-info"/);
  assert.match(html, /id="agentflows-dialog"/);
  // Agent flows are in workflow (pipeline) order: Agents → Human → Review
  assert.ok(html.indexOf('data-view="agents"') < html.indexOf('data-view="needs-input"') &&
            html.indexOf('data-view="needs-input"') < html.indexOf('data-view="review"'));
  assert.match(html, /id="new-task-btn"/); // header + button opens the inline create card
  assert.match(html, />agent/); // quick-add placeholder hints the assignee token
  // favicon is an inline data: SVG (no extra request; CSP img-src allows data:)
  assert.match(html, /rel="icon" href="data:image\/svg\+xml,/);
});

test('app JS modules are served as text/javascript', async () => {
  const { get } = makeApp();
  for (const p of ['/app.js', '/views.js', '/detail.js', '/md.js', '/dates.js', '/inline.js', '/theme-boot.js', '/suggest.js', '/icons.js']) {
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
  assert.match(views, /subline\.append\(assigneePill\(who/); // assignee glyph on every row (incl. self)
  // tags are display-only on the row: a tag-count indicator that expands the row inline
  assert.match(views, /tags-indicator/);
  assert.match(views, /ind\.addEventListener\('click', e => \{ e\.stopPropagation\(\); expandRow\(task, row\); \}\)/);
  assert.doesNotMatch(views, /toggleRowTags/); // inline row tag-editing is gone
});

test('project context notepad: compact icon/pill control + dialog + agent read paths (pl.sh, MCP)', async () => {
  const { get } = makeApp();
  // UI: the project view renders a compact icon->pill control (project.notes),
  // following the same convention as attachmentsEditor/inline.js controls —
  // unset = bare icon, set = pill with a minimal readout — editable via a dialog
  const views = await (await get('/views.js')).text();
  assert.match(views, /function projectContextPanel/);
  assert.match(views, /function contextNotepad/);        // shared icon->pill->dialog primitive
  assert.match(views, /listEl\.append\(projectContextPanel\(project\)\)/);   // prepended in renderProject
  assert.match(views, /const btn = el\('button', 'meta-icon-btn'\)/);
  assert.match(views, /const pill = el\('button', 'meta-pill'\)/);
  assert.match(views, /pill\.replaceChildren\(icon\('file-text', \{ size: 13 \}\)/); // set state: distinct icon + readout
  assert.match(views, /PATCH', `\$\{patch\}\$\{subject\.id\}`, \{ notes: ta\.value \}/); // saves to project.notes
  const html = await (await get('/')).text();
  assert.match(html, /id="project-context-dialog"/);
  assert.match(html, /id="project-context-text"/);
  assert.match(html, /id="project-context-tpl-btn"/);    // template button now hosted inside the dialog
  const css = await (await get('/tokens.css')).text();
  assert.match(css, /\.project-context\s*\{/);
  assert.match(css, /\.meta-icon-btn\s*\{/);
  assert.match(css, /\.meta-pill\s*\{/);
  // working_dir: a project control + dialog + PATCH; surfaced to agents
  assert.match(views, /function projectWorkingDir/);
  assert.match(views, /listEl\.append\(projectWorkingDir\(project\)\)/);
  assert.match(views, /working_dir: inp\.value\.trim\(\) \|\| null/);
  assert.match(html, /id="project-workdir-dialog"/);
  assert.match(css, /\.project-workdir\s*\{/);
  // Agent read: pl.sh marks projects with context and can print one project's readme
  const pl = readFileSync(join(REPO, 'skills/shared/pl.sh'), 'utf8');
  assert.match(pl, /\[context\]/);                       // list marker
  assert.match(pl, /^\s*project\)/m);                    // `pl.sh project <name|id>` subcommand
  // Agent read: the MCP projects tool includes context (was stripped before)
  const mcp = readFileSync(join(REPO, 'src/mcp.js'), 'utf8');
  assert.match(mcp, /p\.notes \? \{ context: p\.notes \}/);
  assert.match(mcp, /p\.working_dir \? \{ working_dir: p\.working_dir \}/);
});

test('project context notepad: can point to a template via the shared AI-edit picker', async () => {
  const { get } = makeApp();
  const views = await (await get('/views.js')).text();
  // reuses the task drawer's template picker (openTemplatePicker + tpleditor.js),
  // not a bespoke project-only mechanism; the picker button now lives inside
  // the edit dialog rather than the (now-compact) trigger
  assert.match(views, /import \{ openTemplatePicker \} from ['"]\/detail\.js['"]/);
  assert.match(views, /openTemplatePicker\(subject, saveTemplate, \(\) => \{ paintTpl\(\); paint\(\); \}\)/);
  assert.match(views, /PATCH', `\$\{patch\}\$\{subject\.id\}`, fields\)/);
  const css = await (await get('/tokens.css')).text();
  assert.match(css, /\.pc-template\s*\{/);
  // Agent read: pl.sh + MCP surface the template pointer alongside context
  const pl = readFileSync(join(REPO, 'skills/shared/pl.sh'), 'utf8');
  assert.match(pl, /\[template: /);
  const mcp = readFileSync(join(REPO, 'src/mcp.js'), 'utf8');
  assert.match(mcp, /p\.template \? \{ template: p\.template \}/);
});

test('tag context notepad: compact icon/pill control + dialog + agent read paths (pl.sh) — mirrors project context', async () => {
  const { get } = makeApp();
  // UI: the tag view renders the same compact icon->pill control (tag.notes)
  const views = await (await get('/views.js')).text();
  assert.match(views, /function tagContextPanel/);
  assert.match(views, /if \(tag\) listEl\.append\(tagContextPanel\(tag\)\)/);
  const html = await (await get('/')).text();
  assert.match(html, /id="tag-context-dialog"/);
  assert.match(html, /id="tag-context-text"/);
  assert.match(html, /id="tag-context-tpl-btn"/);    // template button now hosted inside the dialog
  // Agent read: pl.sh marks tags with context and can print one tag's readme,
  // AFTER instance + project context per the injection order (root -> project -> tag)
  const pl = readFileSync(join(REPO, 'skills/shared/pl.sh'), 'utf8');
  assert.match(pl, /\[context\]/);              // list marker (shared with projects)
  assert.match(pl, /^\s*tag\)/m);               // `pl.sh tag <name|id>` subcommand
  assert.match(pl, /root -> project -> tag/);   // documents the injection order
});

test('tag context notepad: can point to a template via the shared AI-edit picker', async () => {
  const { get } = makeApp();
  const views = await (await get('/views.js')).text();
  // reuses the shared template picker (openTemplatePicker + tpleditor.js) and
  // the same contextNotepad primitive projects use — not a bespoke tag-only mechanism
  assert.match(views, /function contextNotepad/);
  // Agent read: pl.sh surfaces the template pointer alongside context
  const pl = readFileSync(join(REPO, 'skills/shared/pl.sh'), 'utf8');
  assert.match(pl, /\[template: /);
});

test('context notepad icon: unset = bare icon, set = pill with word-count/template readout', async () => {
  const { get } = makeApp();
  const views = await (await get('/views.js')).text();
  const body = views.slice(views.indexOf('function contextNotepad'), views.indexOf('function contextNotepad') + 3000);
  // unset state: bare book icon (same family as other unset meta-icon-btn triggers)
  assert.match(body, /btn\.append\(icon\('book', \{ size: 15 \}\)\)/);
  // set state: distinct icon (file-text) signals "changed" + a minimal readout
  assert.match(body, /pill\.replaceChildren\(icon\('file-text', \{ size: 13 \}\), el\('span', 'pill-text', summary\(\)\)\)/);
  assert.match(body, /bits\.push\(`\$\{words\} word/);             // count
  assert.match(body, /bits\.push\(subject\.template\)/);           // name
  // both the icon and the pill open the same edit dialog
  assert.match(body, /btn\.addEventListener\('click', open\)/);
  assert.match(body, /pill\.addEventListener\('click', open\)/);
});

test('instance identity: footer name link + Instance dialog + PATCH /instance', async () => {
  const { get } = makeApp();
  const app = await (await get('/app.js')).text();
  assert.match(app, /'foot-instance'/);                         // footer name is a link
  assert.match(app, /async function openInstanceDialog/);
  assert.match(app, /api\('PATCH', '\/instance'/);              // save
  assert.match(app, /state\.instanceName = /);                  // footer reflects the name
  const html = await (await get('/')).text();
  assert.match(html, /id="instance-dialog"/);
  assert.match(html, /id="instance-name"/);
  assert.match(html, /id="instance-context"/);
  assert.match(html, /id="instance-isolation"/);
  const css = await (await get('/tokens.css')).text();
  assert.match(css, /\.foot-instance\s*\{/);
});

test('notifications are quiet: event poll updates a browser-tab count badge, not toasts', async () => {
  const { get } = makeApp();
  const app = await (await get('/app.js')).text();
  assert.match(app, /let unreadEvents = 0/);
  assert.match(app, /function setTabBadge/);
  assert.match(app, /document\.title = unreadEvents > 0/);
  assert.match(app, /addEventListener\('focus'/);          // count cleared on focus
  // the events poller must no longer toast each event (the wall-of-text problem)
  const i = app.indexOf('async function pollEvents');
  assert.doesNotMatch(app.slice(i, i + 900), /toast\(/);
  // native/iOS push is explicitly out of scope, not silently skipped
  assert.match(app, /OUT OF SCOPE/);
});

test('toast() never steals focus: it appends a callout and never calls .focus()/.blur()', async () => {
  const { get } = makeApp();
  const app = await (await get('/app.js')).text();
  const i = app.indexOf('export function toast(');
  const body = app.slice(i, app.indexOf('\n}', i));
  assert.doesNotMatch(body, /\.focus\(\)/);
  assert.doesNotMatch(body, /\.blur\(\)/);
});

test('status-update toasts from direct user action still fire (owner said these are good)', async () => {
  const { get } = makeApp();
  // quick-add success — a direct response to the user's own submit
  const inline = await (await get('/inline.js')).text();
  assert.match(inline, /toast\(`Added to \$\{where\}`, 'success'\)/);
  // approve/vet/answer — direct responses to the user's own review actions
  const views = await (await get('/views.js')).text();
  assert.match(views, /toast\(res\.spawned_id \? 'Approved.*'success'\)/);
  assert.match(views, /toast\('Vetted.*'success'\)/);
  assert.match(views, /toast\('Answer sent.*'success'\)/);
});

test('assignee pill: list view is icon-only per-agent (claude/hermes/person), name via title+aria-label', async () => {
  const { get } = makeApp();
  const icons = await (await get('/icons.js')).text();
  // dedicated glyphs exist for both named agents, distinct from the generic person icon
  assert.match(icons, /claude:\s*'<path/);
  assert.match(icons, /hermes:\s*'<path/);
  const views = await (await get('/views.js')).text();
  assert.match(views, /function assigneeIconName/);
  assert.match(views, /ASSIGNEE_ICON\s*=\s*\{\s*claude:\s*'claude',\s*hermes:\s*'hermes'\s*\}/);
  assert.match(views, /function assigneePill/);
  // icon-only: no pill-text span appended, but title + aria-label carry the name
  assert.match(views, /function assigneePill\([\s\S]{0,400}?pill\.title = assignee;/);
  assert.match(views, /pill\.setAttribute\('aria-label', `Assigned to \$\{assignee\}`\)/);
  assert.doesNotMatch(
    views.slice(views.indexOf('function assigneePill'), views.indexOf('function assigneePill') + 500),
    /pill-text/
  );
});

test('inline card: tags lives in the horizontal controls cluster with the other icon fields', async () => {
  const { get } = makeApp();
  const inline = await (await get('/inline.js')).text();
  // tags is part of the horizontal controls cluster, not a separate bottom block
  assert.match(inline, /wrap\.append\([\s\S]{0,220}tagsControl\(task, saveFn\)/);
  // the drawer's tags editor is gone entirely
  const detail = await (await get('/detail.js')).text();
  assert.doesNotMatch(detail, /function tagsEditor/);
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
  // dialog scaffold present; the old name-only project-creation dialog is gone
  // (project creation lives in the manage tree). #project-dialog was later
  // repurposed as the drawer's project PICKER (selectable rows → patch), which
  // still delegates creation to the manage dialog via its "Manage…" action.
  assert.match(html, /id="manage-dialog"/);
  assert.match(html, /id="manage-tree"/);
  assert.match(html, /id="manage-top-drop"/); // (top level) unparent drop zone
  assert.match(html, /id="manage-new-name"/);
  assert.match(html, /id="manage-new-parent"/);
  assert.match(html, /id="manage-show-archived"/); // icon toggle: archived hidden by default
  assert.doesNotMatch(html, /id="project-name-input"/); // the retired inline create field

  const views = await (await get('/views.js')).text();
  assert.match(views, /export function openManageDialog/);
  assert.match(views, /export function renderTreeInto/); // ONE tree walk, nav + dialog
  // nav renders through the shared walker (no private addRows recursion)
  assert.match(views, /renderTreeInto\(rootUl, live/);
  assert.match(views, /renderTreeInto\(root, projects/); // dialog tree (archived-filtered)
  assert.match(views, /manageShowArchived \|\| !p\.archived/); // archived hidden by default
  assert.match(views, /parent_id: parentId/);      // drag-to-reparent PATCH
  assert.match(views, /archived: !p\.archived/);   // archive/unarchive toggle
  // the gear on the rail Projects header is gone; the Manage dialog now opens
  // from a PENCIL on the Projects header line (the old bottom "+ New project"
  // row is retired) and the per-parent hover "+" (add-child)
  assert.doesNotMatch(views, /rail-gear/);
  assert.doesNotMatch(html, /id="rail-new-project"/);   // bottom row removed
  assert.match(views, /rail-head-action/);              // pencil on the header line
  assert.match(views, /manageBtn\.addEventListener\('click', \(\) => openManageDialog\('new'\)\)/);
  // archived projects can't gain sub-projects — the add-child "+" is live-only
  assert.match(views, /can't gain sub-projects/);
  assert.match(views, /if \(!p\.archived\) \{/);
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

test('template picker: inline icon→pill→#template-dialog from GET /templates', async () => {
  const { get } = makeApp();
  const detail = await (await get('/detail.js')).text();
  assert.match(detail, /api\('GET', '\/templates'\)/);        // loadTemplates still fetches the list
  assert.match(detail, /export function openTemplatePicker/); // shared picker (the inline card uses it)
  assert.match(detail, /save\(\{ template: value \}\)/);       // picking a row applies the template
  const inline = await (await get('/inline.js')).text();
  assert.match(inline, /function templateControl/);            // book icon→pill field on the inline card
  assert.match(inline, /icon\('book'/);
  assert.match(inline, /openTemplatePicker\(task, f => saveFn\(task, f\), paint\)/);
  const html = await (await get('/')).text();
  assert.match(html, /id="template-dialog"/);
  assert.match(html, /id="template-dialog-mount"/);
  const icons = await (await get('/icons.js')).text();
  assert.match(icons, /book:\s*'<path/);
});

test('AI template editor: module exports openTemplateEditor, dialog shell + pencil wiring', async () => {
  const { get } = makeApp();
  // the editor module is served like any app module and exports its entry point
  const tpleditor = await (await get('/tpleditor.js')).text();
  assert.match(tpleditor, /export\s+async\s+function\s+openTemplateEditor/);
  // the drawer-scoped dialog shell + its mount point live in the app shell
  const html = await (await get('/')).text();
  assert.match(html, /id="tpl-editor-dialog"/);
  assert.match(html, /id="tpl-editor-mount"/);
  // the template picker's pencil lazy-imports the editor module
  const detail = await (await get('/detail.js')).text();
  assert.match(detail, /tpleditor\.js/);
});

test('task delete: drawer-only (not on the list rows), distinct from archive', async () => {
  const { get } = makeApp();
  const views = await (await get('/views.js')).text();
  assert.match(views, /export async function performDelete/);
  assert.match(views, /This can't be undone/); // exact confirm copy
  // delete is NOT on the list rows — no per-row overflow menu / right-click / long-press
  assert.doesNotMatch(views, /row-overflow/);
  assert.doesNotMatch(views, /function openRowMenu/);
  const detail = await (await get('/detail.js')).text();
  assert.match(detail, /performDelete\(task\)/); // wired into the shared actionsFor (drawer + inline)
  assert.match(detail, /detail-delete/);
});

test('duplicate-create guard: client debounces both add flows', async () => {
  const { get } = makeApp();
  const app = await (await get('/app.js')).text();
  assert.match(app, /quickAdding/);         // quick-add in-flight flag
  assert.match(app, /quickadd\.disabled = true/);
  const inline = await (await get('/inline.js')).text();
  assert.match(inline, /if \(creating\) return/); // inline Create re-entrancy guard
  assert.match(inline, /create\.setAttribute\('loading', ''\)/);
});

test('rail Tags header: pencil opens new-tag dialog, old bottom "+ New tag" row is retired', async () => {
  const { get } = makeApp();
  const html = await (await get('/')).text();
  // the Tags header is always present (parity with Projects) — no longer hidden
  // until a tag exists, since the pencil is now the only way to create the first one
  assert.match(html, /id="rail-tags-head" class="rail-heading">Tags</);
  assert.doesNotMatch(html, /id="rail-tags-head"[^>]*hidden/);
  assert.doesNotMatch(html, /id="rail-new-tag"/); // bottom row removed

  const views = await (await get('/views.js')).text();
  // pencil on the Tags header line, same affordance class as Projects' pencil
  assert.match(views, /newTagBtn = el\('button', 'rail-head-action'\)/);
  assert.match(views, /newTagBtn\.addEventListener\('click', \(\) => openTagDialog\(\)\)/);
  assert.doesNotMatch(views, /rail-new-tag/);

  const css = await (await get('/tokens.css')).text();
  assert.match(css, /#rail-tags-head:has\(\.sec-toggle\)/);
});

test('rail rows: no inert drag-grip (reclaimed space); scroll via touch-action', async () => {
  const { get } = makeApp();
  const views = await (await get('/views.js')).text();
  // the inert grabber is gone from both project and tag rows — rail reorder was
  // never wired, so it only ate horizontal space and read as a drag handle
  assert.doesNotMatch(views, /grip rail-grip/);
  const css = await (await get('/tokens.css')).text();
  assert.match(css, /\.rail-project, \.rail-tag \{ touch-action: pan-y; \}/); // scroll still safe
  assert.doesNotMatch(css, /\.rail-grip\s*\{/);
});

test('icon set: Phosphor inline SVGs (icons.js) replace the ad-hoc glyphs/emoji', async () => {
  const { get } = makeApp();
  // the helper module is served like any app module
  const icons = await (await get('/icons.js')).text();
  assert.match(icons, /export function icon\(/);
  assert.match(icons, /fill="currentColor"/);       // theme-token colored via currentColor
  assert.match(icons, /viewBox', '0 0 256 256'/);     // Phosphor 256 grid
  for (const name of ['pencil-simple', 'trash', 'archive', 'shield-warning', 'chat-circle', 'paperclip', 'dots-three-vertical']) {
    assert.ok(icons.includes(`'${name}'`) || icons.includes(`${name}:`), `icons.js defines ${name}`);
  }
  // base CSS: icons are decorative, fill:currentColor, sized in CSS
  const css = await (await get('/tokens.css')).text();
  assert.match(css, /\.icon \{[^}]*fill: currentColor/);
  // the emoji/ad-hoc glyphs are gone from the sources — replaced by icon(...)
  const views = await (await get('/views.js')).text();
  for (const glyph of ['📎', '💬', '⛨', '⋯', '🗑', '◐', '❓', '✓']) {
    assert.ok(!views.includes(glyph), `views.js no longer contains ${glyph}`);
  }
  assert.match(views, /import \{ icon \} from '\/icons\.js'/);
  const detail = await (await get('/detail.js')).text();
  assert.ok(!detail.includes('▤') && !detail.includes('✕') && !detail.includes('＋'), 'detail.js glyphs replaced');
  const html = await (await get('/')).text();
  // static-button glyphs (☰ + ◐) replaced by inline Phosphor SVGs in the shell
  assert.ok(!html.includes('☰') && !html.includes('◐'), 'index.html static glyphs replaced');
  assert.match(html, /id="nav-toggle"[^>]*>\s*<svg class="icon"/);
});

test('grip: two solid rounded vertical bars (not the old dotted ⋮⋮)', async () => {
  const { get } = makeApp();
  const css = await (await get('/tokens.css')).text();
  // the grip draws two bars as pseudo-elements; the old radial-gradient dots are gone
  assert.match(css, /\.grip::before, \.grip::after \{/);
  assert.match(css, /\.grip::before \{ left: calc\(50% - 4px\); \}/);
  assert.match(css, /\.grip::after  \{ left: calc\(50% \+ 2px\); \}/);
  assert.doesNotMatch(css, /\.grip \{[^}]*radial-gradient/);
});

test('inline card: deadline/repeat/tags collapse to a bare icon until set (Things-style compact affordance)', async () => {
  const { get } = makeApp();
  const inline = await (await get('/inline.js')).text();
  // deadline (icon→value pattern): icon-only button when unset, a compact pill
  // of the value when set. BOTH open the shared #due-dialog (Date + Time widgets
  // + a Clear); clearing lives in the dialog, not an inline x, and there are no
  // always-visible date/time boxes.
  assert.match(inline, /function dueControl\(task, saveFn = save\)/);
  assert.match(inline, /icon\('flag', \{ size: 15 \}\)/);
  assert.match(inline, /'meta-icon-btn'/);
  assert.match(inline, /pill\.replaceChildren\(icon\('flag', \{ size: 13 \}\)/);
  assert.match(inline, /getElementById\('due-dialog'\)/);            // opens the dialog
  assert.match(inline, /getElementById\('due-dialog-clear'\)/);      // clear is in the dialog
  // tags: bare tag-icon until the first tag exists (inline tagsControl)
  assert.match(inline, /function tagsControl\(task, saveFn = save\)/);
  assert.match(inline, /Add tags/);
  // repeat: bare-icon -> pill -> #recur-dialog stays a shared editor in detail.js
  // (freq/params/anchor stay open across picks)
  const detail = await (await get('/detail.js')).text();
  assert.match(detail, /icon\('arrow-counter-clockwise', \{ size: 15 \}\)/);
  assert.match(detail, /getElementById\('recur-dialog'\)/);
  assert.match(detail, /getElementById\('recur-dialog-clear'\)/);
  const css = await (await get('/tokens.css')).text();
  assert.match(css, /\.meta-icon-btn\s*\{/);
  assert.match(css, /\.meta-pill\s*\{/);
  const icons = await (await get('/icons.js')).text();
  assert.match(icons, /flag:/);
});

test('icon→pill→dialog pattern extended to project/assignee/tags/attachments', async () => {
  const { get } = makeApp();
  const html = await (await get('/')).text();
  // the four new shared dialogs live in the app shell
  assert.match(html, /id="project-dialog"/);
  assert.match(html, /id="project-dialog-list"/);
  assert.match(html, /id="project-dialog-manage"/);      // delegates creation to manage
  assert.match(html, /id="assignee-dialog"/);
  assert.match(html, /id="assignee-dialog-mount"/);       // hosts the shared assigneeField
  assert.match(html, /id="tags-dialog"/);
  assert.match(html, /id="tags-dialog-mount"/);           // hosts the shared tagsField
  assert.match(html, /id="attachments-dialog"/);
  assert.match(html, /id="attachments-dialog-mount"/);    // hosts the grid + upload machinery

  const detail = await (await get('/detail.js')).text();
  // project: shared picker (folder icon when unset, folder+name pill when set) —
  // the drawer's projectEditor field is gone; the inline projectControl uses it
  assert.doesNotMatch(detail, /function projectEditor/);
  assert.match(detail, /export function openProjectPicker/);
  assert.match(detail, /getElementById\('project-dialog'\)/);
  assert.match(detail, /openManageDialog\(\)/);            // Manage… still reachable
  // assignee: always a value pill (glyph + friendly name), no unset icon
  assert.match(detail, /export function assigneeGlyph/);
  assert.match(detail, /export function assigneeLabel/);
  assert.match(detail, /export function openAssigneePicker/);
  assert.match(detail, /replaceChildren\(assigneeField\(task, save\)\)/);
  // tags: icon→pill→dialog hosting a tag PICKER (existing tags as toggle chips + add-new)
  assert.match(detail, /export function tagsLabel/);
  assert.match(detail, /export function openTagsPicker/);
  assert.match(detail, /replaceChildren\(buildTagPicker\(task, save, render\)\)/);
  assert.match(detail, /function buildTagPicker/);
  assert.match(detail, /tag-choice/);
  // attachments: icon→count pill, machinery moved into a hosted panel
  assert.match(detail, /function openAttachmentsPicker/);
  assert.match(detail, /function buildAttachmentsPanel/);
  assert.match(detail, /task\.attachment_count = items\.length/); // pill stays truthful
  assert.match(detail, /icon\('paperclip', \{ size: 15 \}\)/);

  // inline row reuses the same shared pickers (project/attachments are drawer-only)
  const inline = await (await get('/inline.js')).text();
  // controls take a saveFn (module `save` for a live task, a local draft-save in the create card)
  assert.match(inline, /openTagsPicker\(task, fields => saveFn\(task, fields\), paint\)/);
  assert.match(inline, /openAssigneePicker\(task, fields => saveFn\(task, fields\), paint\)/);
  assert.match(inline, /function assigneeControl/);

  // picker-row styling uses theme tokens only
  const css = await (await get('/tokens.css')).text();
  assert.match(css, /\.picker-row\s*\{/);
  assert.match(css, /\.picker-row\.sel\s*\{[^}]*var\(--accent\)/);
});

test('task rows: press-and-hold arms dragging (no grip handle bar)', async () => {
  const { get } = makeApp();
  const views = await (await get('/views.js')).text();
  // the shared hold-delay constant drives Sortable's own delay/threshold
  // state machine: pointerdown starts the timer; pointerup/pointercancel or
  // movement past the threshold cancels it (ordinary tap/click/scroll);
  // only an uncancelled timer arms drag mode + the highlight class.
  assert.match(views, /const DRAG_HOLD_MS = 450/);
  const sortableOptsBlock = views.slice(views.indexOf('function sortableList'), views.indexOf('function sortableList') + 1200);
  assert.match(sortableOptsBlock, /delay:\s*DRAG_HOLD_MS/);
  assert.match(sortableOptsBlock, /delayOnTouchOnly:\s*false/); // press-and-hold on mouse too, not touch-only
  assert.match(sortableOptsBlock, /touchStartThreshold:\s*10/);
  assert.match(sortableOptsBlock, /chosenClass:\s*'drag-armed'/); // "the row highlights and is in drag mode"
  assert.doesNotMatch(sortableOptsBlock, /handle:\s*'\.grip'/);

  // taskRow no longer appends a grip icon — the whole row is the drag surface
  const taskRowBlock = views.slice(views.indexOf('function taskRow('), views.indexOf('function taskRow(') + 800);
  assert.doesNotMatch(taskRowBlock, /el\('span', 'grip'\)/);
  assert.doesNotMatch(views, /const COARSE = matchMedia/); // the coarse/fine-pointer split is gone with the grip

  const css = await (await get('/tokens.css')).text();
  assert.match(css, /\.task-row\.drag-armed\s*\{/); // the armed-state highlight
  assert.doesNotMatch(css, /\.task-row \.grip\s*\{/); // no reserved grip width left on task rows
});

test('step edits write through + refresh the list (review-lane bug fix)', async () => {
  const { get } = makeApp();
  const detail = await (await get('/detail.js')).text();
  // the shared step editor takes an onChange and writes edits through to task.steps
  assert.match(detail, /export function stepsEditorFor\(task, \{ onChange \} = \{\}\)/);
  assert.match(detail, /task\.steps\.push\(step\)/);       // add writes through
  assert.match(detail, /task\.steps\.splice\(i, 1\)/);     // delete writes through
  assert.match(detail, /step\.done = done \? 1 : 0/);      // toggle writes through
  // the inline card composes the shared step editor (its collapse re-syncs the list)
  const inline = await (await get('/inline.js')).text();
  assert.match(inline, /stepsEditorFor\(task\)/);
  // the row carries a step-progress indicator that reflects the write-through
  const views = await (await get('/views.js')).text();
  assert.match(views, /chip step-count/);
  assert.match(views, /steps\.filter\(s => s\.done\)\.length/);
  const css = await (await get('/tokens.css')).text();
  assert.match(css, /\.chip\.step-count\s*\{/);
});
