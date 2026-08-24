// inline.js — Things-style inline row editor: a task row expands in place
// into an editing card. One expanded at a time; PATCH on change (optimistic,
// no full re-render while editing); collapse (Esc / outside / another row)
// re-syncs from the server. The pencil opens the full drawer.
import { api, state, reload, toast, todayISO, pickWhen } from '/app.js';
import { openDetail, stepsEditorFor } from '/detail.js';
import { dueCountdown } from '/dates.js';
import { tagsField } from '/suggest.js';

let expanded = null; // { row, task, orig, titleSpan }

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function hasExpanded() { return expanded !== null; }

// restore the collapsed DOM; optionally re-sync the whole list from server
export function collapseInline({ sync = true } = {}) {
  if (!expanded) return false;
  const e = expanded;
  expanded = null;
  e.row.classList.remove('expanded');
  e.row.replaceChildren(...e.orig);
  if (sync) reload();
  return true;
}

async function save(task, fields) {
  try {
    const updated = await api('PATCH', `/tasks/${task.id}`, fields);
    Object.assign(task, updated);
    const i = state.tasks.findIndex(t => t.id === task.id);
    if (i >= 0) state.tasks[i] = task;
    return true;
  } catch (e) {
    toast(`Save failed: ${e.message}`);
    return false;
  }
}

export function expandRow(task, row) {
  if (expanded?.row === row) return;
  if (expanded) collapseInline({ sync: false }); // switching rows: no reload mid-interaction
  const orig = [...row.childNodes];
  const titleSpan = row.querySelector('.title');
  expanded = { row, task, orig, titleSpan };
  row.classList.add('expanded');
  row.replaceChildren();

  // header: title input + pencil (opens the full drawer)
  const head = el('div', 'inline-head');
  const title = el('input', 'inline-title');
  title.type = 'text';
  title.value = task.title;
  title.addEventListener('change', async () => {
    const v = title.value.trim();
    if (!v) { title.value = task.title; return; }
    if (await save(task, { title: v }) && titleSpan) titleSpan.textContent = v;
  });
  const pencil = el('button', 'inline-pencil', '✎');
  pencil.setAttribute('aria-label', 'Open full details');
  pencil.addEventListener('click', e => {
    e.stopPropagation();
    collapseInline({ sync: false });
    openDetail(task);
  });
  head.append(title, pencil);

  // body (grid-rows 0fr -> 1fr for the height transition)
  const body = el('div', 'inline-body');
  const inner = el('div', 'inline-body-inner');
  body.append(inner);

  // notes: auto-growing textarea
  const notes = el('textarea', 'inline-notes');
  notes.placeholder = 'Notes…';
  notes.value = task.notes ?? '';
  const grow = () => { notes.style.height = 'auto'; notes.style.height = `${notes.scrollHeight + 2}px`; };
  notes.addEventListener('input', grow);
  notes.addEventListener('change', () => save(task, { notes: notes.value }));
  inner.append(notes);

  inner.append(stepsEditorFor(task));
  inner.append(controlsRow(task));
  row.append(head, body);

  // after the expand transition, release overflow so popovers (tag
  // suggestions) can escape the card; reduced motion has no transition
  const release = () => body.classList.add('done');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) release();
  else {
    body.addEventListener('transitionend', release, { once: true });
    setTimeout(release, 350); // fallback: transitionend can be swallowed
  }
  requestAnimationFrame(() => { body.classList.add('open'); grow(); });
  setTimeout(() => title.focus({ preventScroll: true }), 30);
}

// compact controls: When | Due | Tags — wraps on narrow screens
function controlsRow(task) {
  const wrap = el('div', 'inline-controls');
  wrap.append(whenControl(task), dueControl(task), tagsControl(task));
  return wrap;
}

function whenControl(task) {
  const seg = el('div', 'seg inline-when');
  const paint = () => {
    const isToday = task.when_type === 'date' && task.when_date === todayISO();
    const marks = [isToday, task.when_type === 'date' && !isToday, task.when_type === 'someday', false];
    [...seg.children].forEach((b, i) => b.classList.toggle('on', marks[i]));
    seg.children[1].textContent = marks[1] ? task.when_date : 'Date…';
  };
  const mk = (label, fn) => {
    const b = el('button', null, label);
    b.addEventListener('click', async e => { e.stopPropagation(); if (await fn()) paint(); });
    seg.append(b);
  };
  mk('Today', () => save(task, { when_type: 'date', when_date: todayISO() }));
  mk('Date…', async () => {
    const d = await pickWhen(task.when_date);
    return d ? save(task, { when_type: 'date', when_date: d }) : false;
  });
  mk('Someday', () => save(task, { when_type: 'someday' }));
  mk('Clear', () => save(task, { when_type: null }));
  paint();
  return labeled('When', seg);
}

function dueControl(task) {
  const box = el('div', 'inline-due');
  const date = el('input');
  date.type = 'date';
  date.value = task.due_date ?? '';
  const chip = el('span', 'chip due');
  const paint = () => {
    if (!task.due_date) { chip.hidden = true; return; }
    const { text, urgent } = dueCountdown(task.due_date, todayISO());
    chip.textContent = text;
    chip.classList.toggle('arrived', urgent);
    chip.hidden = false;
  };
  date.addEventListener('change', async () => {
    if (await save(task, { due_date: date.value || null })) paint();
  });
  paint();
  box.append(date, chip);
  return labeled('Due', box);
}

// tags: shared chips + suggestion-popover field (suggest.js)
function tagsControl(task) {
  return labeled('Tags', tagsField(task, fields => save(task, fields)));
}

function labeled(label, child) {
  const wrap = el('div', 'inline-field');
  wrap.append(el('label', null, label), child);
  return wrap;
}

// collapse on outside click (dialogs/drawer/toasts don't count as outside)
document.addEventListener('pointerdown', e => {
  if (!expanded) return;
  // clicks on any task row are handled by expandRow (switch) or the row's own
  // controls; dialogs/drawer/toasts are not "outside" either
  if (e.target.closest('.task-row, wa-dialog, wa-drawer, #toasts')) return;
  collapseInline();
});
