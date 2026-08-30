// views.js — list rendering + drag & drop. All user content goes through
// textContent (titles/tags/names) — never innerHTML.
import Sortable from '/vendor/sortable.core.esm.js';
import { api, state, reload, rollback, toast, todayISO, setTagFilter, pickWhen, dueWindow, currentActor } from '/app.js';
import { dueCountdown, dueShort } from '/dates.js';
import { expandRow, createInline } from '/inline.js';
import { mdToHtml } from '/md.js';
import { icon } from '/icons.js';

const SECTION_NAMES = ['Today', 'Upcoming', 'Anytime', 'Someday'];
const lastSection = new Map(); // projectId -> section the user last touched

// one-shot entrance-animation intents: set true by a specific USER action
// (route/view change, expand a subtree, open the Manage dialog, create a task),
// consumed by the next render so ordinary in-place reloads DON'T re-animate.
export const animateOnce = { list: false, rail: false, manage: false };

// "+" button / Shift+N: full editor prefilled from the current view
export function openNewTask() {
  const r = state.route;
  let prefill = {};
  let ctx = 'Inbox';
  if (r.view === 'today') {
    prefill = { when_type: 'date', when_date: todayISO() };
    ctx = 'Today';
  } else if (r.view === 'upcoming') {
    prefill = { __openWhenPicker: true }; // date mode, no preset
    ctx = 'Upcoming';
  } else if (r.view === 'project') {
    const p = state.projects.find(x => x.id === r.projectId);
    ctx = p?.name ?? 'Project';
    prefill = { project_id: r.projectId };
    const sec = lastSection.get(r.projectId);
    if (sec === 0) Object.assign(prefill, { when_type: 'date', when_date: todayISO() });
    else if (sec === 3) prefill.when_type = 'someday';
  } else if (r.view === 'tag') {
    prefill = { tags: [r.tag] };
    ctx = `#${r.tag}`;
  } else if (r.view === 'logbook') {
    ctx = 'Logbook';
  } else if (r.view === 'review') {
    ctx = 'Review';
  } else if (r.view === 'needs-input') {
    ctx = 'Human';
  } else if (r.view === 'agents') {
    ctx = 'Agents';
  }
  createInline(prefill, ctx);
}
document.getElementById('new-task-btn').addEventListener('click', openNewTask);
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// press-and-hold to reorder: no dedicated drag-handle bar on task rows. A
// pointer (mouse OR touch) held still on a row for DRAG_HOLD_MS arms the row
// (Sortable's own delay/threshold mechanism — see sortableList below); a tap,
// click, or scroll — anything shorter or that moves past the threshold —
// cancels the hold and behaves like normal. This replaces the old grip icon
// entirely for task-list rows, reclaiming its width for the title/subline.
const DRAG_HOLD_MS = 450;

// mirrors src/views.js SECTION / api.js sectionOf
export function sectionOf(task, today) {
  if (task.when_type === 'date') return task.when_date <= today ? 0 : 1;
  if (task.when_type == null) return 2;
  return 3;
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

// per-pill-type glyphs: Phosphor icons (icons.js) that inherit the chip's color
// via `currentColor` (theme-token driven — no hardcoded fills). project = folder,
// tag = tag — the app's single icon set. (Assignee has its own resolver below,
// since it varies per-agent rather than being a fixed one-icon-per-pill-type.)
const PILL_ICON = { project: 'folder', tag: 'tag' };
function pillIcon(name) {
  return icon(PILL_ICON[name], { size: 11, cls: 'pill-icon' });
}
// a subline pill carrying a leading type-icon + text (button or span)
function iconPill(iconName, text, { className = '', button = false } = {}) {
  const pill = el(button ? 'button' : 'span', `chip ${className}`.trim());
  pill.append(pillIcon(iconName), el('span', 'pill-text', text));
  return pill;
}

// assignee value -> glyph: the two named agents get a dedicated small mark
// (icons.js `claude` / `hermes`), any other value (a human actor) falls back
// to the existing generic person icon. Used to make the list-view assignee
// pill icon-only (see taskRow below) while the name still reaches the DOM
// via title/aria-label for hover/screen-reader access.
const ASSIGNEE_ICON = { claude: 'claude', hermes: 'hermes' };
function assigneeIconName(assignee) {
  return ASSIGNEE_ICON[assignee] || 'user';
}
// icon-only assignee pill for the task LIST view: no visible text, per-agent
// glyph, name surfaced via title + aria-label so hovering/reading still works.
function assigneePill(assignee, { className = '' } = {}) {
  const pill = el('span', `chip ${className}`.trim());
  pill.append(icon(assigneeIconName(assignee), { size: 11, cls: 'pill-icon' }));
  pill.title = assignee;
  pill.setAttribute('aria-label', `Assigned to ${assignee}`);
  return pill;
}

function fmtDate(iso) {
  const t = todayISO();
  if (iso === t) return 'Today';
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// ---- rail ----
const COLLAPSE_KEY = 'av-tasks-collapsed';

// whole-section disclosures (Projects / Tags), persisted, default expanded
const SEC_KEYS = { projects: 'av-tasks-sec-projects', tags: 'av-tasks-sec-tags' };
function secOpen(name) {
  try { return localStorage.getItem(SEC_KEYS[name]) !== '0'; } catch { return true; }
}
function toggleSec(name) {
  try { localStorage.setItem(SEC_KEYS[name], secOpen(name) ? '0' : '1'); } catch { /* private mode */ }
  animateOnce.rail = true; // expanding a section slides its rows in
  renderRail();
}
// heading becomes one full-width 44px toggle: caret + label
function sectionHead(headEl, name, label) {
  headEl.replaceChildren();
  const open = secOpen(name);
  const btn = el('button', 'sec-toggle');
  btn.setAttribute('aria-expanded', String(open));
  btn.setAttribute('aria-label', (open ? 'Collapse ' : 'Expand ') + label);
  btn.addEventListener('click', () => toggleSec(name));
  const caret = el('span', 'caret' + (open ? '' : ' closed'));
  caret.setAttribute('aria-hidden', 'true');
  btn.append(caret, document.createTextNode(label));
  headEl.append(btn);
  return open;
}

function childrenMap(projects) {
  const map = new Map();
  for (const p of projects) {
    const key = p.parent_id ?? '';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  return map;
}
function loadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || []); }
  catch { return new Set(); }
}
function toggleCollapsed(id) {
  const set = loadCollapsed();
  set.has(id) ? set.delete(id) : set.add(id);
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch { /* private mode */ }
  animateOnce.rail = true; // expanding a project slides its subtree rows in
  renderRail();
}

export function renderRail() {
  const rootUl = document.getElementById('rail-projects');
  rootUl.replaceChildren();
  for (const a of document.querySelectorAll('.rail-views a')) {
    a.classList.toggle('active',
      state.route.view === a.dataset.view && state.route.projectId === null);
  }
  // nav counts (muted, right-aligned; zero renders nothing).
  // Agents badge = delegated (which already includes its review rows —
  // summing delegated+review would double-count); accent while reviews wait.
  const counts = state.counts ?? {};
  for (const a of document.querySelectorAll('.rail-views a')) {
    a.querySelector('.nav-count')?.remove();
    if (a.dataset.view === 'logbook') continue;
    const n = a.dataset.view === 'agents' ? (counts.delegated ?? 0)
      : a.dataset.view === 'needs-input' ? (counts.needs_input ?? 0)
      : (counts[a.dataset.view] ?? 0);
    if (n > 0) {
      const badge = el('span', 'nav-count', String(n));
      // work waiting on the human = accent/bold: reviews (Review + Agents)
      // and blocked questions (Needs input)
      if (a.dataset.view === 'review' || a.dataset.view === 'needs-input' ||
          (a.dataset.view === 'agents' && (counts.review ?? 0) > 0)) badge.classList.add('attention');
      a.append(badge);
    }
  }
  const collapsed = loadCollapsed();
  const live = state.projects.filter(p => !p.archived);
  const children = childrenMap(live);
  const projCounts = counts.projects ?? {};
  const subtreeCount = id => (projCounts[id] ?? 0) +
    (children.get(id) ?? []).reduce((sum, ch) => sum + subtreeCount(ch.id), 0);
  // one nav row (.rail-project). The tree-walk/indent lives in renderTreeInto,
  // shared with the Manage-projects dialog; this only paints a row.
  const navRow = (p, { hasKids }) => {
    const row = el('div', 'rail-project');
    // No drag-grip here: rail reorder isn't built, and the inert grabber only ate
    // horizontal space and read as a drag handle. The tree reads through the
    // disclosure caret + the .rail-subtree indent guide. (Row scroll is handled by
    // .rail-project { touch-action: pan-y }.)
    if (hasKids) {
      // disclosure caret: toggles the subtree, never navigates
      const caret = el('button', 'caret' + (collapsed.has(p.id) ? ' closed' : ''));
      caret.setAttribute('aria-label', (collapsed.has(p.id) ? 'Expand ' : 'Collapse ') + p.name);
      caret.setAttribute('aria-expanded', String(!collapsed.has(p.id)));
      caret.addEventListener('click', e => { e.stopPropagation(); toggleCollapsed(p.id); });
      row.append(caret);
    } else {
      row.append(el('span', 'caret-spacer'));
    }
    row.append(el('span', 'rail-name', p.name));
    // count: own when expanded (children show theirs); own+descendants when collapsed
    const n = hasKids && collapsed.has(p.id) ? subtreeCount(p.id) : (projCounts[p.id] ?? 0);
    if (n > 0) row.append(el('span', 'nav-count', String(n)));
    // per-parent shortcut: "+" on hover (desktop pointers only, via CSS) —
    // opens the Manage dialog focused on an add-child under this parent
    const addChild = el('button', 'add-child', '+');
    addChild.setAttribute('aria-label', `New project under ${p.name}`);
    addChild.addEventListener('click', e => { e.stopPropagation(); openManageDialog({ addChild: p.id }); });
    row.append(addChild);
    row.dataset.projectId = p.id;
    row.tabIndex = 0;
    if (state.route.view === 'project' && state.route.projectId === p.id) row.classList.add('active');
    const go = () => { location.hash = `#/project/${encodeURIComponent(p.id)}`; };
    row.addEventListener('click', go);
    row.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    // drop target: drag a task from any list onto a project to file it
    new Sortable(row, {
      group: { name: 'tasks', put: true, pull: false },
      sort: false,
      onAdd: async evt => {
        const id = evt.item.dataset.id;
        evt.item.remove();
        try {
          await api('PATCH', `/tasks/${id}`, { project_id: p.id });
          toast(`Moved to ${p.name}`, 'success');
          await reload();
        } catch (e) {
          await rollback(`Move failed: ${e.message}`);
        }
      },
    });
    return row;
  };
  const projHead = document.getElementById('rail-projects-head');
  const projOpen = sectionHead(projHead, 'projects', 'Projects');
  // pencil on the header line (right-aligned) opens the Manage-projects dialog —
  // it replaces the old bottom "+ New project" row. The per-parent hover "+"
  // (add-child) and the dialog's own add stay.
  const manageBtn = el('button', 'rail-head-action');
  manageBtn.append(icon('pencil-simple', { size: 15 }));
  manageBtn.setAttribute('aria-label', 'Manage projects');
  manageBtn.title = 'Manage projects';
  manageBtn.addEventListener('click', () => openManageDialog('new'));
  projHead.append(manageBtn);
  if (projOpen) renderTreeInto(rootUl, live, { renderRow: navRow, collapsed: id => collapsed.has(id) });
  // one-shot: animate the freshly-rendered subtree rows only when a user just
  // toggled a caret/section (flag), never on ordinary reloads
  rootUl.classList.toggle('anim-in', animateOnce.rail);
  animateOnce.rail = false;
  renderRailTags();
}

// Shared project-tree walker: NAV and the Manage dialog both use this so the
// tree-walk + indent (nested <ul>) logic lives in ONE place. renderRow paints a
// single row for a project; the walker handles children/nesting.
// opts: { renderRow, collapsed?, archivedLast?, alwaysList?, listClass?, onList? }
export function renderTreeInto(rootUl, projects, opts) {
  const { renderRow, collapsed = () => false, archivedLast = false,
    alwaysList = false, listClass = 'rail-subtree', onList } = opts;
  const children = childrenMap(projects);
  // dialog: archived siblings sort last (stable — keeps rank order within a group)
  if (archivedLast) {
    for (const arr of children.values()) arr.sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0));
  }
  onList?.(rootUl, '');
  const addRows = (ul, parentKey, depth) => {
    for (const p of children.get(parentKey) ?? []) {
      const hasKids = children.has(p.id);
      const li = el('li');
      li.dataset.projectId = p.id;
      li.append(renderRow(p, { depth, hasKids }));
      const expand = hasKids && !collapsed(p.id);
      if (expand || alwaysList) {
        const sub = el('ul', listClass);
        sub.dataset.parentId = p.id;
        onList?.(sub, p.id);
        if (expand) addRows(sub, p.id, depth + 1);
        li.append(sub);
      }
      ul.append(li);
    }
  };
  addRows(rootUl, '', 0);
}

// ---- rail: tags section ----
function renderRailTags() {
  const head = document.getElementById('rail-tags-head');
  const ul = document.getElementById('rail-tags');
  ul.replaceChildren();
  head.replaceChildren();
  const tags = state.tags ?? [];
  const open = sectionHead(head, 'tags', 'Tags');
  // pencil on the header line (right-aligned) opens the new-tag dialog — mirrors
  // the Projects pencil and replaces the old bottom "+ New tag" row.
  const newTagBtn = el('button', 'rail-head-action');
  newTagBtn.append(icon('pencil-simple', { size: 15 }));
  newTagBtn.setAttribute('aria-label', 'New tag');
  newTagBtn.title = 'New tag';
  newTagBtn.addEventListener('click', () => openTagDialog());
  head.append(newTagBtn);
  if (!tags.length || !open) return;
  for (const t of tags) {
    const li = el('li');
    // div (not button) so the delete affordance can nest without invalid markup
    const row = el('div', 'rail-tag');
    row.tabIndex = 0;
    // No drag-grip: rail-tag reorder isn't built, and the inert grabber only ate
    // space. (Row scroll handled by .rail-tag { touch-action: pan-y }.)
    row.append(el('span', 'rail-name', `#${t.name}`));
    if (t.count > 0) row.append(el('span', 'tag-count', String(t.count)));
    if (state.route.view === 'tag' && state.route.tag === t.name) row.classList.add('active');
    const go = () => { location.hash = `#/tag/${encodeURIComponent(t.name)}`; };
    row.addEventListener('click', go);
    row.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    // trash affordance: hover on desktop, always on touch (see tokens.css)
    const del = el('button', 'tag-del');
    del.append(icon('x', { size: 13 }));
    del.setAttribute('aria-label', `Delete tag ${t.name}`);
    del.title = 'Delete tag';
    del.addEventListener('click', e => { e.stopPropagation(); deleteTag(t); });
    row.append(del);
    li.append(row);
    ul.append(li);
  }
}

async function deleteTag(tag) {
  const n = tag.count ?? 0;
  const msg = `Delete tag #${tag.name}? Removes it from ${n} task${n === 1 ? '' : 's'}.`;
  if (!confirm(msg)) return;
  try {
    await api('DELETE', `/tags/${encodeURIComponent(tag.id)}`);
    toast(`Deleted #${tag.name}`, 'success');
    // if we're viewing the deleted tag, leave for Today; else refresh in place
    if (state.route.view === 'tag' && state.route.tag === tag.name) location.hash = '#/today';
    else await reload();
  } catch (e) { toast(`Delete failed: ${e.message}`); }
}

// ---- Manage projects dialog ----
// One tree-admin surface: rename inline, add-child, archive/unarchive, and
// drag-to-reparent (nested SortableJS). Shares the tree walk (renderTreeInto)
// with the nav. The API is the source of truth — every mutation reloads.
const mdialog = () => document.getElementById('manage-dialog');
let manageCreatedId = null; // last project created here (picker selects it on close)
let manageFocus = null;     // 'new' | { addChild: parentId } — applied on open only
let manageTopWired = false; // the persistent (top level) drop zone is wired once
let manageShowArchived = false; // archived projects hidden by default (icon toggles)

// open the dialog; resolves { createdId } when it closes (drawer picker awaits)
export function openManageDialog(focus = null) {
  manageFocus = focus;
  manageCreatedId = null;
  animateOnce.manage = true; // tree rows slide in when the dialog opens
  const dlg = mdialog();
  renderManageTree();
  dlg.open = true;
  return new Promise(resolve => {
    const onHide = e => {
      if (e.target !== dlg) return; // ignore bubbled hides from inner controls
      dlg.removeEventListener('wa-hide', onHide);
      resolve({ createdId: manageCreatedId });
    };
    dlg.addEventListener('wa-hide', onHide);
  });
}

function manageDragActive(on) {
  document.getElementById('manage-body').classList.toggle('dragging', on);
}

// after any mutation: reload app state (rail + current view) then repaint tree
async function reloadManage() {
  await reload();
  renderManageTree();
}

// derive {after_id?, before_id?} for a dropped <li> from its sibling <li>s in
// the target list: the row ABOVE is the after_id (we land below it → lower rank
// neighbor), the row BELOW is the before_id (we land above it) — the same
// after/before convention the task reorder uses. Returns null when there are no
// project siblings (dropped into an empty list → caller falls back to a plain
// parent_id PATCH, since the reorder endpoint needs a neighbor).
function projNeighborBody(li) {
  const body = {};
  const above = li.previousElementSibling?.dataset?.projectId;
  const below = li.nextElementSibling?.dataset?.projectId;
  if (above) body.after_id = above;
  if (below) body.before_id = below;
  return (body.after_id || body.before_id) ? body : null;
}

// nested SortableJS: each children <ul> (and the (top level) zone) is a drop
// target in one group. A drop that stays in the same list REORDERS the project
// among its siblings (rank); a drop into a different list REPARENTS it — and,
// when it lands next to siblings, sets its rank so it stays where it was
// dropped. The API is the source of truth (cycle check 400) → toast + reload.
function manageSortableOpts() {
  return {
    group: 'proj-move',
    animation: 150,
    handle: '.grip',
    fallbackOnBody: true,
    onStart: () => manageDragActive(true),
    onEnd: async evt => {
      manageDragActive(false);
      // cross-list moves are handled by onAdd; here only same-list reorders
      if (evt.to !== evt.from || evt.oldIndex === evt.newIndex) return;
      const id = evt.item.dataset.projectId;
      const body = projNeighborBody(evt.item);
      if (body) {
        try { await api('POST', `/projects/${id}/reorder`, body); }
        catch (e) { toast(`Reorder failed: ${e.message}`); }
      }
      await reloadManage();
    },
    onAdd: async evt => {
      manageDragActive(false);
      const id = evt.item.dataset.projectId;
      const parentId = evt.to.dataset.parentId || null;
      const neighbors = projNeighborBody(evt.item);
      try {
        // reparent AND place at the drop position when there are neighbors;
        // an empty target list has none → a plain reparent (appends by rank)
        if (neighbors) await api('POST', `/projects/${id}/reorder`, { parent_id: parentId, ...neighbors });
        else await api('PATCH', `/projects/${id}`, { parent_id: parentId });
        toast(parentId ? 'Moved' : 'Moved to top level', 'success');
      } catch (e) {
        toast(e.status === 400 ? 'Cannot move a project into its own subtree' : `Move failed: ${e.message}`);
      }
      await reloadManage();
    },
  };
}

function renderManageTree() {
  const root = document.getElementById('manage-tree');
  root.replaceChildren();
  root.dataset.parentId = '';
  // persistent (top level) drop zone: clear any stray dropped row, wire once
  const top = document.getElementById('manage-top-drop');
  top.replaceChildren();
  top.dataset.parentId = '';
  if (!manageTopWired) { new Sortable(top, manageSortableOpts()); manageTopWired = true; }

  // archived projects are hidden by default; the toolbar icon reveals them
  const projects = (state.projects ?? []).filter(p => manageShowArchived || !p.archived);
  renderTreeInto(root, projects, {
    renderRow: manageRow,
    archivedLast: true,
    alwaysList: true,          // every row gets a children <ul> (a drop target)
    listClass: 'manage-children',
    onList: ul => { new Sortable(ul, manageSortableOpts()); },
  });
  renderManageParentOptions();
  // one-shot: animate the tree in on open, not on every mutation repaint
  root.classList.toggle('anim-in', animateOnce.manage);
  animateOnce.manage = false;

  // focus intent applies once, on open (not on later repaints)
  if (manageFocus === 'new') setTimeout(() => document.getElementById('manage-new-name')?.focus(), 60);
  else if (manageFocus?.addChild) { const pid = manageFocus.addChild; setTimeout(() => openChildInput(pid), 60); }
  manageFocus = null;
}

function manageRow(p) {
  const row = el('div', 'manage-row' + (p.archived ? ' archived' : ''));
  row.dataset.projectId = p.id;
  // the same grip the step rows use (reused markup/CSS) — the drag handle
  const grip = el('span', 'grip');
  grip.setAttribute('aria-hidden', 'true');
  grip.title = 'Drag to reparent';
  row.append(grip);
  const name = el('button', 'manage-name', p.name);
  name.title = 'Rename';
  name.setAttribute('aria-label', `Rename ${p.name}`);
  name.addEventListener('click', () => startRename(p, name));
  row.append(name);
  const actions = el('div', 'manage-actions');
  // icons over text throughout the dialog
  const arch = el('button', 'manage-btn manage-archive');
  arch.append(icon(p.archived ? 'arrow-counter-clockwise' : 'archive', { size: 17 }));
  arch.title = p.archived ? `Unarchive ${p.name}` : `Archive ${p.name}`;
  arch.setAttribute('aria-label', `${p.archived ? 'Unarchive' : 'Archive'} ${p.name}`);
  arch.addEventListener('click', async () => {
    try {
      await api('PATCH', `/projects/${p.id}`, { archived: !p.archived });
      toast(p.archived ? 'Restored' : 'Archived', 'success');
      await reloadManage();
    } catch (e) { toast(`Save failed: ${e.message}`); }
  });
  // archived projects can't gain sub-projects — you can't nest under a dead
  // project — so the add-child "+" only appears on live rows
  if (!p.archived) {
    const add = el('button', 'manage-btn');
    add.append(icon('plus', { size: 17 }));
    add.title = `Add a sub-project under ${p.name}`;
    add.setAttribute('aria-label', `Add a sub-project under ${p.name}`);
    add.addEventListener('click', () => openChildInput(p.id));
    actions.append(add);
  }
  actions.append(arch);
  row.append(actions);
  return row;
}

// click a name → inline text input; Enter/blur commit (PATCH name), Escape
// cancels; empty is rejected inline, duplicate surfaces the API 409 inline.
function startRename(p, nameBtn) {
  const input = el('input', 'manage-name-input');
  input.type = 'text';
  input.value = p.name;
  input.setAttribute('aria-label', `Rename ${p.name}`);
  const err = el('span', 'manage-inline-error');
  err.hidden = true;
  let busy = false;
  const commit = async () => {
    if (busy) return;
    const v = input.value.trim();
    if (!v || v === p.name) { input.replaceWith(nameBtn); err.remove(); return; }
    busy = true;
    try {
      await api('PATCH', `/projects/${p.id}`, { name: v });
      await reloadManage();
    } catch (e) {
      busy = false;
      err.textContent = e.status === 409 ? 'Name already exists' : (e.status === 400 ? 'Invalid name' : 'Save failed');
      err.hidden = false;
      input.focus();
    }
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); input.replaceWith(nameBtn); err.remove(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (input.isConnected) commit(); }, 120));
  nameBtn.replaceWith(input);
  input.after(err);
  input.focus();
  input.select();
}

// inline "add a child" input under a project row
function openChildInput(parentId) {
  const li = document.querySelector(`#manage-tree li[data-project-id="${CSS.escape(parentId)}"]`);
  if (!li) return;
  let ul = li.querySelector(':scope > ul.manage-children');
  if (!ul) { ul = el('ul', 'manage-children'); ul.dataset.parentId = parentId; li.append(ul); }
  const existing = ul.querySelector('.manage-child-input input');
  if (existing) { existing.focus(); return; }
  const wrap = el('li', 'manage-child-input');
  const input = el('input', 'manage-name-input');
  input.type = 'text';
  input.placeholder = 'Sub-project name…';
  input.setAttribute('aria-label', 'New sub-project name');
  const err = el('span', 'manage-inline-error');
  err.hidden = true;
  input.addEventListener('keydown', async e => {
    if (e.key === 'Escape') { e.preventDefault(); wrap.remove(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) { wrap.remove(); return; }
      try {
        const created = await api('POST', '/projects', { name: v, parent_id: parentId });
        manageCreatedId = created.id;
        await reloadManage();
      } catch (e2) {
        err.textContent = e2.status === 409 ? 'Name already exists' : (e2.status === 400 ? 'Invalid name' : 'Create failed');
        err.hidden = false;
        input.focus();
      }
    }
  });
  input.addEventListener('blur', () => setTimeout(() => wrap.remove(), 150));
  wrap.append(input, err);
  ul.prepend(wrap);
  input.focus();
}

// the bottom "+ New project" row's parent <select> (live projects, indented)
function renderManageParentOptions() {
  const sel = document.getElementById('manage-new-parent');
  const prev = sel.value;
  sel.replaceChildren();
  const none = el('option', null, '(top level)');
  none.value = '';
  sel.append(none);
  const children = childrenMap((state.projects ?? []).filter(p => !p.archived));
  const walk = (key, depth) => {
    for (const p of children.get(key) ?? []) {
      const o = el('option', null, `${'   '.repeat(depth)}${depth ? '└ ' : ''}${p.name}`);
      o.value = p.id;
      sel.append(o);
      walk(p.id, depth + 1);
    }
  };
  walk('', 0);
  sel.value = prev; // survive repaints
}

// bottom row: the plain create case (name + optional parent)
async function createProject() {
  const name = document.getElementById('manage-new-name');
  const parent = document.getElementById('manage-new-parent');
  const err = document.getElementById('manage-error');
  const value = name.value.trim();
  if (!value) { err.textContent = 'Name is required.'; err.hidden = false; name.focus(); return; }
  const body = { name: value };
  if (parent.value) body.parent_id = parent.value;
  try {
    const p = await api('POST', '/projects', body);
    manageCreatedId = p.id;
    name.value = '';
    err.hidden = true;
    await reloadManage();
    document.getElementById('manage-new-name').focus();
  } catch (e) {
    err.textContent = e.status === 409 ? 'A project with that name already exists.' : `Create failed: ${e.message}`;
    err.hidden = false;
  }
}

// ---- due-soon window dialog ----
function openWindowDialog() {
  const input = document.getElementById('window-input');
  input.value = String(dueWindow());
  document.getElementById('window-dialog').open = true;
  setTimeout(() => input.focus(), 50);
}
function saveWindow() {
  const v = Number(document.getElementById('window-input').value);
  if (!Number.isInteger(v) || v < 1 || v > 365) return;
  try { localStorage.setItem('av-tasks-due-window', String(v)); } catch { /* private mode */ }
  document.getElementById('window-dialog').open = false;
  reload();
}
document.getElementById('window-ok').addEventListener('click', saveWindow);
document.getElementById('window-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveWindow(); });
document.getElementById('window-cancel').addEventListener('click', () => {
  document.getElementById('window-dialog').open = false;
});

// ---- new-tag dialog ----
function openTagDialog() {
  const input = document.getElementById('tag-name-input');
  input.value = '';
  document.getElementById('tag-error').hidden = true;
  document.getElementById('tag-dialog').open = true;
  setTimeout(() => input.focus(), 50);
}
async function createTag() {
  const input = document.getElementById('tag-name-input');
  const err = document.getElementById('tag-error');
  const name = input.value.trim().replace(/^#/, '');
  if (!name) { err.textContent = 'Name is required.'; err.hidden = false; return; }
  if ((state.tags ?? []).some(t => t.name.toLowerCase() === name.toLowerCase())) {
    err.textContent = 'That tag already exists.';
    err.hidden = false;
    return;
  }
  try {
    await api('POST', '/tags', { name });
    document.getElementById('tag-dialog').open = false;
    await reload(); // zero-count tag appears in the nav immediately
  } catch (e) {
    err.textContent = e.status === 409 ? 'That tag already exists.' : `Create failed: ${e.message}`;
    err.hidden = false;
  }
}
document.getElementById('tag-create').addEventListener('click', createTag);
document.getElementById('tag-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') createTag(); });
document.getElementById('tag-cancel').addEventListener('click', () => {
  document.getElementById('tag-dialog').open = false;
});

document.getElementById('manage-close').addEventListener('click', () => { mdialog().open = false; });
// show-archived icon toggle: archived projects are hidden by default
document.getElementById('manage-show-archived').addEventListener('click', e => {
  manageShowArchived = !manageShowArchived;
  const btn = e.currentTarget;
  btn.setAttribute('aria-pressed', String(manageShowArchived));
  btn.classList.toggle('on', manageShowArchived);
  btn.replaceChildren(icon(manageShowArchived ? 'eye-slash' : 'eye', { size: 17 }));
  btn.title = manageShowArchived ? 'Hide archived projects' : 'Show archived projects';
  btn.setAttribute('aria-label', btn.title);
  renderManageTree();
});
document.getElementById('manage-new-add').addEventListener('click', createProject);
document.getElementById('manage-new-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') createProject();
});

// ---- rows ----
// (Row tags are display-only — a tag icon + count that opens the drawer. Tag
// editing lives at the bottom of the drawer, via suggest.js tagsField.)

// status marker: one small themed glyph per agent in-flight state, shown where
// the checkbox sits. active/queued and done use the checkbox itself.
// Phosphor glyph per in-flight state: in_progress = half-filled circle (work
// underway), blocked = question (waiting on a human), review = check (done,
// awaiting approval). Themed via the .status-marker.* rules.
const STATUS_ICON = { in_progress: 'circle-half', blocked: 'question', review: 'check' };
const STATUS_LABEL = {
  in_progress: 'In progress', blocked: 'Blocked — waiting on a human', review: 'In review — awaiting approval',
};
function statusMarker(task) {
  const m = el('span', `status-marker st-${task.status}`);
  if (STATUS_ICON[task.status]) m.append(icon(STATUS_ICON[task.status], { size: 14 }));
  m.setAttribute('role', 'img');
  m.setAttribute('aria-label', STATUS_LABEL[task.status] ?? task.status);
  m.title = STATUS_LABEL[task.status] ?? '';
  return m;
}

// hard delete (admin-only server-side): confirm, then DELETE + fade the row and
// reload from server truth. Distinct from Archive (reversible) — the copy says
// so. Shared by the row overflow menu and the drawer's trash affordance.
export async function performDelete(task) {
  if (!confirm(`Delete "${task.title}"? This can't be undone.`)) return false;
  try {
    await api('DELETE', `/tasks/${task.id}`);
    toast('Deleted', 'success');
    const row = document.querySelector(`.task-row[data-id="${CSS.escape(task.id)}"]`);
    const wait = (reducedMotion() || !row) ? Promise.resolve()
      : new Promise(r => { row.classList.add('removing'); setTimeout(r, 250); });
    await wait;
    await reload();
    return true;
  } catch (e) { toast(`Delete failed: ${e.message}`); return false; }
}

function taskRow(task, { showProject = false, logbook = false, sortable = false, showClaimed = false } = {}) {
  const row = el('div', 'task-row');
  row.dataset.id = task.id;
  const t = todayISO();
  if (task.when_type === 'someday') row.classList.add('someday');
  if (task.status === 'done') row.classList.add('done');

  // no grip: press-and-hold (see DRAG_HOLD_MS / sortableList) arms dragging
  // from anywhere on the row, on mouse or touch alike.
  // one status vocabulary: active/queued and done keep the checkbox; the agent
  // in-flight states (in_progress, blocked, review) show a status marker in its
  // place so board state reads at a glance across every view.
  if (task.status === 'in_progress' || task.status === 'blocked' || task.status === 'review') {
    row.append(statusMarker(task));
  } else {
    const check = el('button', 'check' + (task.status === 'done' ? ' checked' : ''));
    check.setAttribute('aria-label', task.status === 'done' ? 'Reopen' : 'Complete');
    check.addEventListener('click', async e => {
      e.stopPropagation();
      // optimistic: flip immediately, roll back on failure
      check.classList.toggle('checked');
      row.classList.toggle('done');
      const completing = !(logbook || task.status === 'done');
      try {
        if (completing) {
          // micro-interaction: fill, fade + collapse (~250ms), then remove;
          // prefers-reduced-motion skips the animation entirely
          const wait = reducedMotion() ? Promise.resolve()
            : new Promise(r => { row.classList.add('removing'); setTimeout(r, 250); });
          const [res] = await Promise.all([api('POST', `/tasks/${task.id}/complete`), wait]);
          if (res.spawned_id) toast('Done — next occurrence scheduled', 'success');
        } else {
          await api('PATCH', `/tasks/${task.id}`, { status: 'active' });
        }
        await reload();
      } catch (err) {
        row.classList.remove('removing');
        await rollback(`Update failed: ${err.message}`);
      }
    });
    row.append(check);
  }

  // two-line layout: the title line is JUST the title (+ due countdown at the
  // right, which reads best beside a deadline). Everything else — project,
  // assignee, status, tags-indicator — lives on the muted subline beneath, each
  // pill carrying a small type-icon so the row scans at a glance on a phone.
  const main = el('div', 'row-main');
  const titleLine = el('div', 'row-title-line');
  titleLine.append(el('span', 'title', task.title));
  if (task.due_date) {
    // deadline chip stays on the title line (right) — flag + short date · countdown
    // (· time), the same compact shape the drawer pill uses.
    const { text: countdown, urgent } = dueCountdown(task.due_date, t);
    const bits = [dueShort(task.due_date), countdown];
    if (task.due_time) bits.push(task.due_time);
    const chip = el('span', 'chip due' + (urgent && task.status === 'active' ? ' arrived' : ''));
    chip.append(icon('flag', { size: 11 }), el('span', 'pill-text', bits.join(' · ')));
    titleLine.append(chip);
  }
  main.append(titleLine);

  const subline = el('div', 'row-subline');
  if (showProject && task.project_id) {
    const p = state.projects.find(x => x.id === task.project_id);
    if (p) subline.append(iconPill('project', p.name, { className: 'project-name' }));
  }
  {
    // assignee pill: icon-only in the list view (claude/hermes glyph, else the
    // generic person icon), shown for EVERY task incl. your own — name still
    // reachable via title/aria-label. The delegated extras (accent "working"
    // outline, claimed-at, the review chip) only apply to agent-assigned tasks.
    const who = task.assignee || currentActor();
    const delegated = task.assignee && task.assignee !== currentActor();
    subline.append(assigneePill(who,
      { className: (delegated ? 'agent' : '') + (delegated && task.status === 'in_progress' ? ' working' : '') }));
    if (delegated && task.status === 'in_progress' && task.claimed_at && showClaimed) {
      subline.append(el('span', 'claimed-at', `claimed ${task.claimed_at.slice(5, 16).replace('T', ' ')}`));
    }
    if (delegated && task.status === 'review') {
      const chip = el('button', 'chip review-chip', 'review');
      chip.setAttribute('aria-label', `Review ${task.assignee}'s report`);
      chip.addEventListener('click', e => { e.stopPropagation(); openReviewDialog(task); });
      subline.append(chip);
    }
  }
  if (task.status === 'blocked') {
    // needs-input: the agent is waiting on an answer — jump to the lane
    const chip = el('button', 'chip blocked-chip');
    chip.append(icon('question', { size: 13 }), el('span', 'pill-text', 'waiting'));
    chip.title = 'Blocked on a question — answer it in the Human lane';
    chip.setAttribute('aria-label', 'Waiting for your answer — open the Human lane');
    chip.addEventListener('click', e => { e.stopPropagation(); location.hash = '#/needs-input'; });
    subline.append(chip);
  }
  if (task.vetted === 0) {
    // amber quarantine chip (agent-security layer 1): agents will not execute
    // this task. Tapping it is the admin's Vet action — the server 403s
    // anyone else, and the toast explains.
    const chip = el('button', 'chip unvetted');
    chip.append(icon('shield-warning', { size: 13 }), el('span', 'pill-text', 'unvetted'));
    chip.title = 'Created by an untrusted source — agents will not execute it. Tap to vet.';
    chip.setAttribute('aria-label', 'Unvetted — tap to vet for agent execution');
    chip.addEventListener('click', e => { e.stopPropagation(); vetTask(task.id); });
    subline.append(chip);
  }
  // attachment count chip: a paperclip glyph + N when the task carries any
  // attachments (images and documents both count)
  if (task.attachment_count > 0) {
    const chip = el('span', 'chip attach-count');
    chip.append(icon('paperclip', { size: 12 }), el('span', 'pill-text', String(task.attachment_count)));
    chip.setAttribute('aria-label', `${task.attachment_count} attachment${task.attachment_count === 1 ? '' : 's'}`);
    subline.append(chip);
  }
  // comment count chip: a small chat glyph + N when the task's timeline has activity
  if (task.comment_count > 0) {
    const chip = el('span', 'chip comment-count');
    chip.append(icon('chat-circle', { size: 12 }), el('span', 'pill-text', String(task.comment_count)));
    chip.setAttribute('aria-label', `${task.comment_count} timeline entr${task.comment_count === 1 ? 'y' : 'ies'}`);
    subline.append(chip);
  }
  // step progress: a small check-glyph N/M when the task carries a checklist.
  // Kept fresh by the drawer/inline step editors (write-through + reload), so
  // checking a step in review updates this indicator without a page reload.
  const steps = task.steps ?? [];
  if (steps.length) {
    const done = steps.filter(s => s.done).length;
    const chip = el('span', 'chip step-count' + (done === steps.length ? ' complete' : ''));
    chip.append(icon('check', { size: 12 }), el('span', 'pill-text', `${done}/${steps.length}`));
    chip.setAttribute('aria-label', `${done} of ${steps.length} steps done`);
    subline.append(chip);
  }
  // tags are DISPLAY-ONLY on the row now: a single tag icon + count when the
  // task has any. Tapping it expands the row inline, where tags are edited.
  const tagCount = task.tags?.length ?? 0;
  if (tagCount > 0) {
    const ind = iconPill('tag', String(tagCount), { className: 'tags-indicator', button: true });
    ind.title = `${tagCount} tag${tagCount === 1 ? '' : 's'}: ${task.tags.join(', ')} — expand to edit`;
    ind.setAttribute('aria-label', `${tagCount} tag${tagCount === 1 ? '' : 's'} (${task.tags.join(', ')}) — expand to edit`);
    ind.addEventListener('click', e => { e.stopPropagation(); expandRow(task, row); });
    subline.append(ind);
  }
  main.append(subline);
  row.append(main);

  // Delete lives ONLY on the expanded task view (the drawer's actions) — it is a
  // HARD, irreversible remove, so it's deliberately kept off the list rows. The
  // list has no per-row overflow/right-click/long-press delete affordance.

  row.tabIndex = 0;
  // Things-style: every row (active OR done/archived) expands in place. The
  // inline card's actions adapt to status (Complete / Completed / Unarchive).
  const open = () => {
    // remember which section the user last worked in per project — the new-task
    // button seeds its when-prefill from it
    if (state.route.view === 'project' && state.route.projectId) {
      lastSection.set(state.route.projectId, sectionOf(task, todayISO()));
    }
    return expandRow(task, row);
  };
  row.addEventListener('click', e => {
    if (row.classList.contains('expanded')) return; // clicks inside the editor
    if (e.target.closest('button, input, textarea, select, a')) return;
    open();
  });
  row.addEventListener('keydown', e => {
    if (e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); }
  });
  return row;
}

function taskList(tasks, opts) {
  const ul = el('div', 'task-list');
  for (const task of tasks) ul.append(taskRow(task, opts));
  return ul;
}

// ---- reorder plumbing ----
// nearest task-row sibling in a direction — lets a list interleave non-row
// cards (question/review) between rows without confusing neighbor detection
function siblingRowId(item, dir) {
  let n = item[dir];
  while (n && !n.classList?.contains('task-row')) n = n[dir];
  return n?.dataset.id;
}
function neighborBody(item, list) {
  const body = {};
  const prev = siblingRowId(item, 'previousElementSibling');
  const next = siblingRowId(item, 'nextElementSibling');
  if (prev) body.after_id = prev;
  if (next) body.before_id = next;
  if (list) body.list = list;
  return (prev || next) ? body : null;
}

async function postReorder(item, list) {
  const body = neighborBody(item, list);
  if (!body) return true;
  try {
    await api('POST', `/tasks/${item.dataset.id}/reorder`, body);
    return true;
  } catch (e) {
    // 409: scope changed under us — re-render from server truth (the contract)
    await rollback(e.status === 409 ? 'List changed — restored server order' : `Reorder failed: ${e.message}`);
    return false;
  }
}

// rowsOnly: the list interleaves non-draggable cards (Human lane question
// cards); only .task-row drags, and a successful reorder reloads so the cards
// re-align under their rows in the new order.
//
// No grip handle: any row arms for dragging by press-and-hold (mouse or
// touch) rather than a dedicated handle. Sortable's own delay + move-
// threshold IS the "press and hold" state machine — it starts a DRAG_HOLD_MS
// timer on pointerdown, cancels it on pointerup/pointercancel or on movement
// past the threshold (so an ordinary tap/click/scroll is untouched), and —
// only if the timer fires uncancelled — arms native dragging and toggles
// chosenClass (our .drag-armed highlight) on the row.
function sortableList(ul, { list, section, rowsOnly = false } = {}) {
  new Sortable(ul, {
    group: { name: 'tasks', put: section !== undefined, pull: true },
    animation: 150,
    delay: DRAG_HOLD_MS,
    delayOnTouchOnly: false, // press-and-hold applies to mouse too, not just touch
    touchStartThreshold: 10, // a little slack for a held (not perfectly still) finger
    chosenClass: 'drag-armed', // the "row highlights and is in drag mode" cue
    filter: '.expanded', // the expanded editing card must not drag
    preventOnFilter: false,
    ...(rowsOnly ? { draggable: '.task-row' } : {}),
    // while a drag is live, empty project sections re-appear as drop targets
    onStart: () => document.body.classList.add('drag-active'),
    onEnd: async evt => {
      document.body.classList.remove('drag-active');
      if (evt.to !== evt.from) return; // cross-list handled by onAdd
      if (evt.oldIndex === evt.newIndex) return;
      const ok = await postReorder(evt.item, list);
      if (ok && rowsOnly) await reload(); // realign interleaved cards
    },
    onAdd: async evt => {
      if (section === undefined) return;
      await crossSectionDrop(evt, section);
    },
  });
}

// dragging BETWEEN sections in a project edits the when fields
async function crossSectionDrop(evt, targetSection) {
  const id = evt.item.dataset.id;
  let patch;
  if (targetSection === 0) patch = { when_type: 'date', when_date: todayISO() };
  else if (targetSection === 2) patch = { when_type: null };
  else if (targetSection === 3) patch = { when_type: 'someday' };
  else {
    const date = await pickWhen();
    if (!date) { await reload(); return; } // cancelled: restore server order
    patch = { when_type: 'date', when_date: date };
  }
  try {
    await api('PATCH', `/tasks/${id}`, patch);
    await postReorder(evt.item, 'project');
    await reload();
  } catch (e) {
    await rollback(`Move failed: ${e.message}`);
  }
}

// ---- main pane ----
export function renderMain() {
  const listEl = document.getElementById('list');
  const titleEl = document.getElementById('view-title');
  const chipsEl = document.getElementById('filter-chips');
  const subEl = document.getElementById('view-sub');
  listEl.replaceChildren();
  chipsEl.replaceChildren();
  subEl.textContent = state.route.view === 'today'
    ? new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    : state.route.view === 'agents' && (state.counts?.unvetted ?? 0) > 0
      ? `${state.counts.unvetted} unvetted — agents will not execute`
      : '';

  if (state.tag) {
    const chip = el('button', 'chip filter');
    chip.append(el('span', 'pill-text', `#${state.tag}`), icon('x', { size: 12 }));
    chip.setAttribute('aria-label', `Clear #${state.tag} filter`);
    chip.addEventListener('click', () => setTagFilter(state.tag));
    chipsEl.append(chip);
  }

  const r = state.route;
  const tasks = state.tasks;
  if (r.view === 'project') {
    const project = state.projects.find(p => p.id === r.projectId);
    titleEl.textContent = project ? project.name : 'Project';
    renderProject(listEl, tasks);
  } else if (r.view === 'today') {
    titleEl.textContent = 'Today';
    // pinned DUE SOON group above the today list; hidden when empty
    if (state.dueSoon.length) {
      const block = el('div', 'section-block');
      const head = el('div', 'section-head');
      head.append(document.createTextNode('Due soon'));
      const windowBtn = el('button', 'window-chip', `${dueWindow()}d`);
      windowBtn.setAttribute('aria-label', 'Change due-soon window');
      windowBtn.addEventListener('click', openWindowDialog);
      head.append(windowBtn);
      block.append(head, taskList(state.dueSoon, { showProject: true }));
      listEl.append(block);
      listEl.append(el('div', 'section-head', 'Today'));
    }
    const ul = taskList(tasks, { showProject: true, sortable: true });
    listEl.append(ul);
    sortableList(ul, { list: 'today' });
  } else if (r.view === 'tag') {
    titleEl.textContent = `#${r.tag}`;
    listEl.append(taskList(tasks, { showProject: true }));
  } else if (r.view === 'upcoming') {
    titleEl.textContent = 'Upcoming';
    renderGrouped(listEl, tasks, t => t.when_date, { showProject: true });
  } else if (r.view === 'anytime') {
    titleEl.textContent = 'Anytime';
    listEl.append(taskList(tasks, { showProject: true }));
  } else if (r.view === 'logbook') {
    titleEl.textContent = 'Logbook';
    renderGrouped(listEl, tasks, t => (t.completed_at || '').slice(0, 10) || 'Earlier',
      { showProject: true, logbook: true });
  } else if (r.view === 'review') {
    titleEl.textContent = 'Review';
    renderReview(listEl, tasks);
  } else if (r.view === 'needs-input') {
    titleEl.textContent = 'Human';
    renderNeedsInput(listEl, tasks);
  } else if (r.view === 'agents') {
    titleEl.textContent = 'Agents';
    renderAgents(listEl, tasks);
  } else {
    titleEl.textContent = 'Inbox';
    const ul = taskList(tasks, { sortable: true });
    listEl.append(ul);
    sortableList(ul, { list: 'inbox' }); // manual order persists to view_ranks('inbox')
  }
  if (tasks.length === 0) listEl.append(el('div', 'empty-note', emptyNote(r.view)));
  // one-shot: rows slide in only on a view/route change or a new task (flag),
  // not on every in-place reload
  listEl.classList.toggle('anim-in', animateOnce.list);
  animateOnce.list = false;
}

function emptyNote(view) {
  return {
    inbox: 'Nothing to triage — add a task with n.',
    today: 'Nothing scheduled today.',
    upcoming: 'No scheduled tasks yet.',
    anytime: 'Nothing waiting — someday and unscheduled tasks land here.',
    logbook: 'Completed tasks land here.',
    review: 'Nothing waiting on your review.',
    'needs-input': 'Nothing waiting on a human.',
    agents: 'Nothing delegated — assign a task to Claude or Hermes.',
  }[view] ?? 'No tasks here yet.';
}

function renderGrouped(listEl, tasks, keyFn, opts) {
  let current = null;
  let ul = null;
  for (const task of tasks) {
    const key = keyFn(task);
    if (key !== current) {
      current = key;
      listEl.append(el('div', 'group-head', /^\d{4}-\d{2}-\d{2}$/.test(key) ? fmtDate(key) : key));
      ul = el('div', 'task-list');
      listEl.append(ul);
    }
    ul.append(taskRow(task, opts));
    // logbook: agent report, collapsed to one line, tap to expand
    if (opts?.logbook && task.report) {
      const line = el('div', 'report-line notes-preview');
      line.innerHTML = mdToHtml(task.report); // md renderer escapes all input
      line.addEventListener('click', () => line.classList.toggle('open'));
      ul.append(line);
    }
  }
}

// ---- Agents view + review actions ----
async function approveTask(id) {
  try {
    const res = await api('POST', `/tasks/${id}/approve`);
    toast(res.spawned_id ? 'Approved — next occurrence scheduled' : 'Approved', 'success');
  } catch (e) { toast(`Approve failed: ${e.message}`); }
  await reload();
}
async function vetTask(id) {
  try {
    await api('POST', `/tasks/${id}/vet`);
    toast('Vetted — agents may now work it', 'success');
  } catch (e) { toast(`Vet failed: ${e.message}`); }
  await reload();
}
async function reopenTask(id) {
  // optional reopen comment (skippable): feedback-for-rework attached to the
  // timeline before the status flips back to active
  const reason = (prompt('Reason for reopening (optional — leave blank to skip):') || '').trim();
  const body = { status: 'active' };
  if (reason) body.comment = reason;
  try {
    await api('PATCH', `/tasks/${id}`, body);
    toast('Reopened — back at the top of the agent backlog', 'success');
  } catch (e) { toast(`Reopen failed: ${e.message}`); }
  await reload();
}

let reviewTask = null;
function openReviewDialog(task) {
  reviewTask = task;
  const dlg = document.getElementById('review-dialog');
  dlg.label = `${task.assignee}: ${task.title}`;
  const box = document.getElementById('review-report');
  box.innerHTML = mdToHtml(task.report || '(no report)'); // escaped by md.js
  dlg.open = true;
}
document.getElementById('review-approve').addEventListener('click', () => {
  document.getElementById('review-dialog').open = false;
  if (reviewTask) approveTask(reviewTask.id);
});
document.getElementById('review-reopen').addEventListener('click', () => {
  document.getElementById('review-dialog').open = false;
  if (reviewTask) reopenTask(reviewTask.id);
});

// report card under a review row: rendered report + Approve / Reopen
function reviewCard(task) {
  const card = el('div', 'review-card');
  const body = el('div', 'report-body notes-preview');
  body.innerHTML = mdToHtml(task.report || '(no report)'); // escaped by md.js
  const actions = el('div', 'review-actions');
  const approve = document.createElement('wa-button');
  approve.setAttribute('variant', 'brand');
  approve.setAttribute('size', 'small');
  approve.textContent = 'Approve';
  approve.addEventListener('click', () => approveTask(task.id));
  const reopen = el('button', 'link-btn', 'Reopen');
  reopen.addEventListener('click', () => reopenTask(task.id));
  actions.append(approve, reopen);
  card.append(body, actions);
  return card;
}

// needs-input: answer the agent's question — blocked -> active
async function answerTask(id, answer) {
  try {
    await api('POST', `/tasks/${id}/answer`, { answer });
    toast('Answer sent — the task is back in the agent\'s queue', 'success');
  } catch (e) { toast(`Answer failed: ${e.message}`); }
  await reload();
}

// question card under a blocked row: the agent's question (accent-left, like
// report cards) + an inline answer box. Used in Needs input and Agents views.
function questionCard(task) {
  const card = el('div', 'question-card');
  const body = el('div', 'report-body notes-preview');
  body.innerHTML = mdToHtml(task.question || '(no question)'); // escaped by md.js
  card.append(body);
  const box = el('textarea', 'answer-input');
  box.placeholder = 'Answer…';
  box.rows = 2;
  box.setAttribute('aria-label', `Answer ${task.assignee}'s question`);
  const actions = el('div', 'review-actions');
  const send = document.createElement('wa-button');
  send.setAttribute('variant', 'brand');
  send.setAttribute('size', 'small');
  send.textContent = 'Send answer';
  send.addEventListener('click', () => {
    const v = box.value.trim();
    if (!v) { toast('Type an answer first'); return; }
    answerTask(task.id, v);
  });
  actions.append(send);
  card.append(box, actions);
  return card;
}

// Human lane: every task here is status=blocked. Drag-reorderable — the human
// hand-orders which question to answer next (persists to view_ranks('human')).
// Each row carries its question card with an inline answer box. The card is a
// sibling of the row inside the list; SortableJS drags whole rows (.task-row),
// and the question cards are filtered out of dragging so they ride with reorder
// via a full reload.
function renderNeedsInput(listEl, tasks) {
  const ul = el('div', 'task-list');
  for (const task of tasks) {
    ul.append(taskRow(task, { showProject: true, sortable: true }));
    ul.append(questionCard(task));
  }
  listEl.append(ul);
  sortableList(ul, { list: 'human', rowsOnly: true });
}

// Review view: every task here is status=review — row (with agent chip) + card
function renderReview(listEl, tasks) {
  const ul = el('div', 'task-list');
  for (const task of tasks) {
    ul.append(taskRow(task, { showProject: true }));
    ul.append(reviewCard(task));
  }
  listEl.append(ul);
}

// quarantine card under an unvetted row in the Agents view: why it's held +
// the admin's Vet button (the row chip does the same)
function unvetCard(task) {
  const card = el('div', 'unvet-card');
  card.append(el('div', 'unvet-note',
    `Created by ${task.created_by || 'an untrusted source'} — quarantined until you vet it.`));
  const actions = el('div', 'review-actions');
  const vet = document.createElement('wa-button');
  vet.setAttribute('variant', 'brand');
  vet.setAttribute('size', 'small');
  vet.textContent = 'Vet';
  vet.addEventListener('click', () => vetTask(task.id));
  actions.append(vet);
  card.append(actions);
  return card;
}

// Agents view: ONE shared, drag-reorderable backlog across ALL agent-assigned
// open (active + in_progress) tasks, in the global manual order the server
// returns (view_ranks('agents'), nulls last). Agent identity is a per-row chip
// (visual affordance) — the order is global, not grouped into per-agent
// sections. Work waiting on the human (blocked / in review / unvetted) drops
// below into a non-draggable "Waiting on you" area with its action cards.
function renderAgents(listEl, tasks) {
  const claimable = t => t.vetted !== 0 && (t.status === 'active' || t.status === 'in_progress');
  const backlog = tasks.filter(claimable);
  const waiting = tasks.filter(t => !claimable(t)); // blocked / review / unvetted

  if (backlog.length) {
    listEl.append(el('div', 'section-head', 'Backlog'));
    const ul = taskList(backlog, { showProject: true, showClaimed: true, sortable: true });
    listEl.append(ul);
    sortableList(ul, { list: 'agents' }); // reorder persists to view_ranks('agents')
  }

  if (waiting.length) {
    listEl.append(el('div', 'section-head', 'Waiting on you'));
    const ul = el('div', 'task-list');
    for (const task of waiting) {
      ul.append(taskRow(task, { showProject: true, showClaimed: true }));
      if (task.status === 'blocked') ul.append(questionCard(task));
      else if (task.status === 'review') ul.append(reviewCard(task));
      else if (task.vetted === 0) ul.append(unvetCard(task));
    }
    listEl.append(ul);
  }
}

function renderProject(listEl, tasks) {
  const t = todayISO();
  const bySection = [[], [], [], []];
  for (const task of tasks) bySection[sectionOf(task, t)].push(task);
  bySection.forEach((sectionTasks, i) => {
    // empty sections hide (CSS) — except while a drag is active, when all
    // four must be visible as drop targets
    const block = el('div', 'section-block' + (sectionTasks.length ? '' : ' empty'));
    block.append(el('div', 'section-head', SECTION_NAMES[i]));
    const ul = taskList(sectionTasks, { sortable: true });
    if (i === 3) ul.classList.add('section-someday');
    block.append(ul);
    listEl.append(block);
    sortableList(ul, { list: 'project', section: i });
  });
}
