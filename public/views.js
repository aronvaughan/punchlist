// views.js — list rendering + drag & drop. All user content goes through
// textContent (titles/tags/names) — never innerHTML.
import Sortable from '/vendor/sortable.core.esm.js';
import { api, state, reload, rollback, toast, todayISO, setTagFilter, pickWhen } from '/app.js';
import { openDetail } from '/detail.js';

const SECTION_NAMES = ['Today', 'Upcoming', 'Anytime', 'Someday'];

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
export function renderRail() {
  const ul = document.getElementById('rail-projects');
  ul.replaceChildren();
  for (const a of document.querySelectorAll('#rail-views a')) {
    a.classList.toggle('active',
      state.route.view === a.dataset.view && state.route.projectId === null);
  }
  const live = state.projects.filter(p => !p.archived);
  const children = new Map();
  for (const p of live) {
    const key = p.parent_id ?? '';
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(p);
  }
  const addRows = (parentKey, depth) => {
    for (const p of children.get(parentKey) ?? []) {
      const li = el('li');
      const row = el('div', 'rail-project' + (depth ? ' rail-child' : ''), p.name);
      row.dataset.projectId = p.id;
      if (state.route.view === 'project' && state.route.projectId === p.id) row.classList.add('active');
      row.addEventListener('click', () => { location.hash = `#/project/${encodeURIComponent(p.id)}`; });
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
      ul.append(li);
      addRows(p.id, depth + 1);
    }
  };
  addRows('', 0);
}

// ---- rows ----
function taskRow(task, { showProject = false, logbook = false } = {}) {
  const row = el('div', 'task-row');
  row.dataset.id = task.id;
  const t = todayISO();
  if (task.when_type === 'someday') row.classList.add('someday');
  if (task.status === 'done') row.classList.add('done');

  const check = el('button', 'check' + (task.status === 'done' ? ' checked' : ''));
  check.setAttribute('aria-label', task.status === 'done' ? 'Reopen' : 'Complete');
  check.addEventListener('click', async e => {
    e.stopPropagation();
    // optimistic: flip immediately, roll back on failure
    check.classList.toggle('checked');
    row.classList.toggle('done');
    try {
      if (logbook || task.status === 'done') await api('PATCH', `/tasks/${task.id}`, { status: 'active' });
      else {
        const res = await api('POST', `/tasks/${task.id}/complete`);
        if (res.spawned_id) toast('Done — next occurrence scheduled', 'success');
      }
      await reload();
    } catch (err) {
      await rollback(`Update failed: ${err.message}`);
    }
  });
  row.append(check);

  row.append(el('span', 'title', task.title));

  if (showProject && task.project_id) {
    const p = state.projects.find(x => x.id === task.project_id);
    if (p) row.append(el('span', 'chip project-name', p.name));
  }
  for (const tag of task.tags ?? []) {
    const chip = el('button', 'chip tag', `#${tag}`);
    chip.addEventListener('click', e => { e.stopPropagation(); setTagFilter(tag); });
    row.append(chip);
  }
  if (task.due_date) {
    const arrived = task.due_date <= t && task.status === 'active';
    const chip = el('span', 'chip due' + (arrived ? ' arrived' : ''),
      `due ${fmtDate(task.due_date)}${task.due_time ? ' ' + task.due_time : ''}`);
    row.append(chip);
  }
  row.addEventListener('click', () => openDetail(task));
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
    onEnd: async evt => {
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
  listEl.replaceChildren();
  chipsEl.replaceChildren();

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
    const ul = taskList(tasks, { showProject: true });
    listEl.append(ul);
    sortableList(ul, { list: 'today' });
  } else if (r.view === 'upcoming') {
    titleEl.textContent = 'Upcoming';
    renderGrouped(listEl, tasks, t => t.when_date, { showProject: true });
  } else if (r.view === 'logbook') {
    titleEl.textContent = 'Logbook';
    renderGrouped(listEl, tasks, t => (t.completed_at || '').slice(0, 10) || 'Earlier',
      { showProject: true, logbook: true });
  } else {
    titleEl.textContent = 'Inbox';
    const ul = taskList(tasks, {});
    listEl.append(ul);
    sortableList(ul, { list: 'project' });
  }
  if (tasks.length === 0) listEl.append(el('div', 'empty-note', emptyNote(r.view)));
}

function emptyNote(view) {
  return {
    inbox: 'Inbox zero.',
    today: 'Nothing scheduled for today.',
    upcoming: 'Nothing scheduled.',
    logbook: 'Nothing completed yet.',
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
  }
}

function renderProject(listEl, tasks) {
  const t = todayISO();
  const bySection = [[], [], [], []];
  for (const task of tasks) bySection[sectionOf(task, t)].push(task);
  bySection.forEach((sectionTasks, i) => {
    const head = el('div', 'section-head', SECTION_NAMES[i]);
    listEl.append(head);
    const ul = taskList(sectionTasks, {});
    if (i === 3) ul.classList.add('section-someday');
    listEl.append(ul);
    sortableList(ul, { list: 'project', section: i });
  });
}
