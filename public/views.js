// views.js — list rendering + drag & drop. All user content goes through
// textContent (titles/tags/names) — never innerHTML.
import Sortable from '/vendor/sortable.core.esm.js';
import { api, state, reload, rollback, toast, todayISO, setTagFilter, pickWhen, dueWindow } from '/app.js';
import { openDetail, openCreate } from '/detail.js';
import { dueCountdown } from '/dates.js';
import { expandRow } from '/inline.js';
import { mdToHtml } from '/md.js';

const SECTION_NAMES = ['Today', 'Upcoming', 'Anytime', 'Someday'];
const lastSection = new Map(); // projectId -> section the user last touched

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
  } else if (r.view === 'agents') {
    ctx = 'Agents';
  }
  openCreate(prefill, ctx);
}
document.getElementById('new-task-btn').addEventListener('click', openNewTask);
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// coarse pointers (touch): task rows drag only from a grip so the list
// scrolls normally; fine pointers keep whole-row dragging
const COARSE = matchMedia('(pointer: coarse)').matches;

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
  renderRail();
}

export function renderRail() {
  const rootUl = document.getElementById('rail-projects');
  rootUl.replaceChildren();
  for (const a of document.querySelectorAll('#rail-views a')) {
    a.classList.toggle('active',
      state.route.view === a.dataset.view && state.route.projectId === null);
  }
  // nav counts (muted, right-aligned; zero renders nothing).
  // Agents badge = delegated (which already includes its review rows —
  // summing delegated+review would double-count); accent while reviews wait.
  const counts = state.counts ?? {};
  for (const a of document.querySelectorAll('#rail-views a')) {
    a.querySelector('.nav-count')?.remove();
    if (a.dataset.view === 'logbook') continue;
    const n = a.dataset.view === 'agents' ? (counts.delegated ?? 0) : (counts[a.dataset.view] ?? 0);
    if (n > 0) {
      const badge = el('span', 'nav-count', String(n));
      // reviews waiting on the human = accent/bold on both Review and Agents
      if (a.dataset.view === 'review' ||
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
  const addRows = (ul, parentKey) => {
    for (const p of children.get(parentKey) ?? []) {
      const li = el('li');
      const row = el('div', 'rail-project');
      const hasKids = children.has(p.id);
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
      // per-parent shortcut: "+" on hover (desktop pointers only, via CSS)
      const addChild = el('button', 'add-child', '+');
      addChild.setAttribute('aria-label', `New project under ${p.name}`);
      addChild.addEventListener('click', e => { e.stopPropagation(); openProjectDialog(p.id); });
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
      li.append(row);
      if (hasKids && !collapsed.has(p.id)) {
        const sub = el('ul', 'rail-subtree');
        addRows(sub, p.id);
        li.append(sub);
      }
      ul.append(li);
    }
  };
  const projOpen = sectionHead(document.getElementById('rail-projects-head'), 'projects', 'Projects');
  document.getElementById('rail-new-project').hidden = !projOpen;
  if (projOpen) addRows(rootUl, '');
  renderRailTags();
}

// ---- rail: tags section ----
function renderRailTags() {
  const head = document.getElementById('rail-tags-head');
  const ul = document.getElementById('rail-tags');
  ul.replaceChildren();
  head.replaceChildren();
  const tags = state.tags ?? [];
  head.hidden = tags.length === 0;
  // "+ New tag" shows unless the Tags section is explicitly collapsed
  const open = tags.length ? sectionHead(head, 'tags', 'Tags') : true;
  document.getElementById('rail-new-tag').hidden = !open;
  if (!tags.length || !open) return;
  for (const t of tags) {
    const li = el('li');
    const row = el('button', 'rail-tag');
    row.append(el('span', 'rail-name', `#${t.name}`));
    if (t.count > 0) row.append(el('span', 'tag-count', String(t.count)));
    if (state.route.view === 'tag' && state.route.tag === t.name) row.classList.add('active');
    row.addEventListener('click', () => { location.hash = `#/tag/${encodeURIComponent(t.name)}`; });
    li.append(row);
    ul.append(li);
  }
}

// ---- project creation dialog ----
const pdialog = () => document.getElementById('project-dialog');

export function openProjectDialog(parentId = null) {
  const name = document.getElementById('project-name-input');
  const parent = document.getElementById('project-parent-select');
  const err = document.getElementById('project-error');
  name.value = '';
  err.hidden = true;
  parent.replaceChildren();
  const none = el('option', null, '(none)');
  none.value = '';
  parent.append(none);
  const children = childrenMap(state.projects.filter(p => !p.archived));
  const walk = (key, depth) => {
    for (const p of children.get(key) ?? []) {
      const o = el('option', null, `${'   '.repeat(depth)}${depth ? '└ ' : ''}${p.name}`);
      o.value = p.id;
      parent.append(o);
      walk(p.id, depth + 1);
    }
  };
  walk('', 0);
  parent.value = parentId ?? '';
  pdialog().open = true;
  setTimeout(() => name.focus(), 50);
}

async function createProject() {
  const name = document.getElementById('project-name-input');
  const parent = document.getElementById('project-parent-select');
  const err = document.getElementById('project-error');
  const value = name.value.trim();
  if (!value) { err.textContent = 'Name is required.'; err.hidden = false; return; }
  const body = { name: value };
  if (parent.value) body.parent_id = parent.value;
  try {
    const p = await api('POST', '/projects', body);
    pdialog().open = false;
    const target = `#/project/${encodeURIComponent(p.id)}`;
    if (location.hash === target) await reload();
    else location.hash = target; // navigation triggers reload + tree update
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
document.getElementById('rail-new-tag').addEventListener('click', openTagDialog);
document.getElementById('tag-create').addEventListener('click', createTag);
document.getElementById('tag-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') createTag(); });
document.getElementById('tag-cancel').addEventListener('click', () => {
  document.getElementById('tag-dialog').open = false;
});

document.getElementById('rail-new-project').addEventListener('click', () => openProjectDialog(null));
document.getElementById('project-cancel').addEventListener('click', () => { pdialog().open = false; });
document.getElementById('project-create').addEventListener('click', createProject);
document.getElementById('project-name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') createProject();
});

// ---- rows ----
function taskRow(task, { showProject = false, logbook = false, sortable = false, showClaimed = false } = {}) {
  const row = el('div', 'task-row');
  row.dataset.id = task.id;
  const t = todayISO();
  if (task.when_type === 'someday') row.classList.add('someday');
  if (task.status === 'done') row.classList.add('done');

  if (COARSE && sortable && task.status === 'active') {
    const grip = el('span', 'grip');
    grip.setAttribute('aria-hidden', 'true');
    row.append(grip);
  }
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

  row.append(el('span', 'title', task.title));

  if (showProject && task.project_id) {
    const p = state.projects.find(x => x.id === task.project_id);
    if (p) row.append(el('span', 'chip project-name', p.name));
  }
  if (task.vetted === 0) {
    // amber quarantine chip (agent-security layer 1): agents will not execute
    // this task. Tapping it is the admin's Vet action — the server 403s
    // anyone else, and the toast explains.
    const chip = el('button', 'chip unvetted', '⛨ unvetted');
    chip.title = 'Created by an untrusted source — agents will not execute it. Tap to vet.';
    chip.setAttribute('aria-label', 'Unvetted — tap to vet for agent execution');
    chip.addEventListener('click', e => { e.stopPropagation(); vetTask(task.id); });
    row.append(chip);
  }
  if (task.assignee && task.assignee !== currentActor()) {
    // agent chip: muted; accent outline while claimed (in_progress)
    row.append(el('span', 'chip agent' + (task.status === 'in_progress' ? ' working' : ''), task.assignee));
    if (task.status === 'in_progress' && task.claimed_at && showClaimed) {
      row.append(el('span', 'claimed-at', `claimed ${task.claimed_at.slice(5, 16).replace('T', ' ')}`));
    }
    if (task.status === 'review') {
      const chip = el('button', 'chip review-chip', 'review');
      chip.setAttribute('aria-label', `Review ${task.assignee}'s report`);
      chip.addEventListener('click', e => { e.stopPropagation(); openReviewDialog(task); });
      row.append(chip);
    }
  }
  for (const tag of task.tags ?? []) {
    const chip = el('button', 'chip tag', `#${tag}`);
    chip.addEventListener('click', e => { e.stopPropagation(); setTagFilter(tag); });
    row.append(chip);
  }
  if (task.due_date) {
    // countdown chip: red when overdue/today/within 7 days, muted beyond
    const { text, urgent } = dueCountdown(task.due_date, t);
    const chip = el('span', 'chip due' + (urgent && task.status === 'active' ? ' arrived' : ''),
      `${text}${task.due_time ? ' · ' + task.due_time : ''}`);
    row.append(chip);
  }
  row.tabIndex = 0;
  // Things-style: active rows expand in place; done/archived open the drawer
  const open = () => {
    // remember which section the user last worked in per project — the new-task
    // button seeds its when-prefill from it
    if (state.route.view === 'project' && state.route.projectId) {
      lastSection.set(state.route.projectId, sectionOf(task, todayISO()));
    }
    return task.status === 'active' ? expandRow(task, row) : openDetail(task);
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
function neighborBody(item, list) {
  const body = {};
  const prev = item.previousElementSibling?.dataset.id;
  const next = item.nextElementSibling?.dataset.id;
  if (prev) body.after_id = prev;
  if (next) body.before_id = next;
  if (list) body.list = list;
  return (prev || next) ? body : null;
}

async function postReorder(item, list) {
  const body = neighborBody(item, list);
  if (!body) return;
  try {
    await api('POST', `/tasks/${item.dataset.id}/reorder`, body);
  } catch (e) {
    // 409: scope changed under us — re-render from server truth (the contract)
    await rollback(e.status === 409 ? 'List changed — restored server order' : `Reorder failed: ${e.message}`);
  }
}

function sortableList(ul, { list, section } = {}) {
  new Sortable(ul, {
    group: { name: 'tasks', put: section !== undefined, pull: true },
    animation: 150,
    delay: 150,
    delayOnTouchOnly: true,
    filter: '.expanded', // the expanded editing card must not drag
    preventOnFilter: false,
    ...(COARSE ? { handle: '.grip' } : {}),
    // while a drag is live, empty project sections re-appear as drop targets
    onStart: () => document.body.classList.add('drag-active'),
    onEnd: async evt => {
      document.body.classList.remove('drag-active');
      if (evt.to !== evt.from) return; // cross-list handled by onAdd
      if (evt.oldIndex === evt.newIndex) return;
      await postReorder(evt.item, list);
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
    const chip = el('button', 'chip filter', `#${state.tag} ✕`);
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
  } else if (r.view === 'logbook') {
    titleEl.textContent = 'Logbook';
    renderGrouped(listEl, tasks, t => (t.completed_at || '').slice(0, 10) || 'Earlier',
      { showProject: true, logbook: true });
  } else if (r.view === 'review') {
    titleEl.textContent = 'Review';
    renderReview(listEl, tasks);
  } else if (r.view === 'agents') {
    titleEl.textContent = 'Agents';
    renderAgents(listEl, tasks);
  } else {
    titleEl.textContent = 'Inbox';
    const ul = taskList(tasks, { sortable: true });
    listEl.append(ul);
    sortableList(ul, { list: 'project' });
  }
  if (tasks.length === 0) listEl.append(el('div', 'empty-note', emptyNote(r.view)));
}

function emptyNote(view) {
  return {
    inbox: 'Nothing to triage — add a task with n.',
    today: 'Nothing scheduled today.',
    upcoming: 'No scheduled tasks yet.',
    logbook: 'Completed tasks land here.',
    review: 'Nothing waiting on your review.',
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
  try {
    await api('PATCH', `/tasks/${id}`, { status: 'active' });
    toast('Reopened', 'success');
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

function renderAgents(listEl, tasks) {
  const byAgent = new Map();
  for (const t of tasks) {
    if (!byAgent.has(t.assignee)) byAgent.set(t.assignee, []);
    byAgent.get(t.assignee).push(t);
  }
  for (const [agent, list] of byAgent) {
    listEl.append(el('div', 'section-head', agent[0].toUpperCase() + agent.slice(1)));
    const vetted = list.filter(t => t.vetted !== 0);
    const unvetted = list.filter(t => t.vetted === 0);
    const ul = el('div', 'task-list');
    for (const task of vetted) { // server order: in_progress → review → queued
      ul.append(taskRow(task, { showProject: true, showClaimed: true }));
      if (task.status === 'review') ul.append(reviewCard(task));
    }
    listEl.append(ul);
    if (unvetted.length) {
      // quarantine subsection (agent-security layer 1): visible to the owner,
      // excluded from the agent's queue until vetted
      listEl.append(el('div', 'section-head unvetted-head', 'UNVETTED — agents will not execute'));
      const qul = el('div', 'task-list');
      for (const task of unvetted) {
        qul.append(taskRow(task, { showProject: true }));
        qul.append(unvetCard(task));
      }
      listEl.append(qul);
    }
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
