// inline.js — Things-style inline row editor: a task row expands in place
// into an editing card. One expanded at a time; PATCH on change (optimistic,
// no full re-render while editing); collapse (Esc / outside / another row)
// re-syncs from the server. The pencil opens the full drawer.
import { api, state, reload, toast, todayISO, currentActor } from '/app.js';
import { openDetail, stepsEditorFor, openWhenPicker, whenLabel,
  openTagsPicker, tagsLabel, openAssigneePicker, assigneeGlyph, assigneeLabel,
  openProjectPicker, projectLabel, openTemplatePicker, attachmentsEditor,
  reportView, timelineSection, recurEditor, actionsFor } from '/detail.js';
import { dueCountdown, dueShort } from '/dates.js';
import { icon } from '/icons.js';
// animateOnce is read only at runtime (inside submit) — the views.js ⇄ inline.js
// import cycle is safe because the binding isn't touched during module init.
import { animateOnce } from '/views.js';

let expanded = null; // { row, task, orig, titleSpan }
let createCard = null; // the transient create-mode card (a bare .task-row in #list)

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
  cancelCreate(); // opening a real row abandons an unsaved create draft
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
  const pencil = el('button', 'inline-pencil');
  pencil.append(icon('pencil-simple', { size: 16 }));
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
  const rep = reportView(task);
  if (rep) inner.append(rep);
  inner.append(timelineSection(task));
  // Complete / Archive / Delete (Approve/Reopen in review) — collapse the row on
  // any terminal action (the task leaves the active list; collapseInline reloads).
  inner.append(actionsFor(task, { save, onDone: () => collapseInline() }));
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

// compact icon→value controls, same set + order as the drawer's meta-row — wraps
// on narrow screens. (attachmentsEditor is already task-based; reused directly.)
// saveFn is the module `save` (PATCH) for a live task, or a local draft-save for
// the create card (no id to PATCH yet); create mode omits attachments (the task
// doesn't exist to attach to) and recur repaints locally instead of reloading.
function controlsRow(task, { saveFn = save, create = false } = {}) {
  const wrap = el('div', 'inline-controls');
  wrap.append(whenControl(task, saveFn), dueControl(task, saveFn), projectControl(task, saveFn),
    assigneeControl(task, saveFn), templateControl(task, saveFn),
    recurEditor(task, saveFn, create ? () => {} : () => reload()), tagsControl(task, saveFn));
  if (!create) wrap.append(attachmentsEditor(task));
  return wrap;
}

// Project: folder icon → pill (folder + name) → the shared project picker.
function projectControl(task, saveFn = save) {
  const wrap = el('div', 'inline-when');
  const btn = el('button', 'meta-icon-btn');
  btn.type = 'button';
  btn.append(icon('folder', { size: 15 }));
  btn.setAttribute('aria-label', 'Set project');
  btn.title = 'Set project';
  const pill = el('button', 'meta-pill');
  pill.type = 'button';
  pill.title = 'Change project';
  const paint = () => {
    const label = projectLabel(task);
    if (label) {
      pill.replaceChildren(icon('folder', { size: 13 }), el('span', 'pill-text', label));
      pill.hidden = false; btn.hidden = true;
    } else { pill.hidden = true; btn.hidden = false; }
  };
  const open = () => openProjectPicker(task.project_id, f => saveFn(task, f), paint);
  btn.addEventListener('click', open);
  pill.addEventListener('click', open);
  paint();
  wrap.append(btn, pill);
  return labeled('Project', wrap);
}

// Template: book icon → pill (book + name) → the shared template picker.
function templateControl(task, saveFn = save) {
  const wrap = el('div', 'inline-when');
  const btn = el('button', 'meta-icon-btn');
  btn.type = 'button';
  btn.append(icon('book', { size: 15 }));
  btn.setAttribute('aria-label', 'Use a template');
  btn.title = 'Use a template';
  const pill = el('button', 'meta-pill');
  pill.type = 'button';
  pill.title = 'Change template';
  const paint = () => {
    if (task.template) {
      pill.replaceChildren(icon('book', { size: 13 }), el('span', 'pill-text', task.template));
      pill.hidden = false; btn.hidden = true;
    } else { pill.hidden = true; btn.hidden = false; }
  };
  const open = () => openTemplatePicker(task, f => saveFn(task, f), paint);
  btn.addEventListener('click', open);
  pill.addEventListener('click', open);
  paint();
  wrap.append(btn, pill);
  return labeled('Template', wrap);
}

// Same calendar icon→value pattern as the drawer's whenEditor: unset = calendar
// icon, set = pill (calendar + Today / mm/dd / Someday). Both open the shared
// When picker (#whenpick-dialog) via the exported openWhenPicker.
function whenControl(task, saveFn = save) {
  const wrap = el('div', 'inline-when');
  const btn = el('button', 'meta-icon-btn');
  btn.type = 'button';
  btn.append(icon('calendar', { size: 15 }));
  btn.setAttribute('aria-label', 'Schedule (when)');
  btn.title = 'Schedule (when)';
  const pill = el('button', 'meta-pill');
  pill.type = 'button';
  pill.title = 'Edit when';

  const paint = () => {
    const w = whenLabel(task);
    if (w) {
      pill.replaceChildren(icon('calendar', { size: 13 }), el('span', 'pill-text', w));
      pill.hidden = false;
      btn.hidden = true;
    } else {
      pill.hidden = true;
      btn.hidden = false;
    }
  };
  const open = () => openWhenPicker(task, f => saveFn(task, f), paint);
  btn.addEventListener('click', open);
  pill.addEventListener('click', open);
  paint();
  wrap.append(btn, pill);
  return labeled('When', wrap);
}

// Same icon→value pattern as the drawer's dueEditor: unset = flag icon; set =
// a compact pill (flag + mm/dd · countdown · time). Both open the shared
// #due-dialog (Date + Time + Clear + Done) — no always-visible date box.
function dueControl(task, saveFn = save) {
  const box = el('div', 'inline-due');

  const btn = el('button', 'meta-icon-btn');
  btn.type = 'button';
  btn.append(icon('flag', { size: 15 }));
  btn.setAttribute('aria-label', 'Set deadline');
  btn.title = 'Set deadline';

  const pill = el('button', 'meta-pill due-pill');
  pill.type = 'button';
  pill.title = 'Edit deadline';

  const paint = () => {
    if (task.due_date) {
      const { text: countdown, urgent } = dueCountdown(task.due_date, todayISO());
      const bits = [dueShort(task.due_date), countdown];
      if (task.due_time) bits.push(task.due_time);
      pill.replaceChildren(icon('flag', { size: 13 }), el('span', 'pill-text', bits.join(' · ')));
      pill.classList.toggle('urgent', urgent);
      pill.hidden = false;
      btn.hidden = true;
    } else {
      pill.hidden = true;
      btn.hidden = false;
    }
  };

  const openDialog = () => {
    const dlg = document.getElementById('due-dialog');
    const date = document.getElementById('due-dialog-date');
    const time = document.getElementById('due-dialog-time');
    date.value = task.due_date ?? '';
    time.value = task.due_time ?? '';
    date.onchange = async () => { if (await saveFn(task, { due_date: date.value || null })) paint(); };
    time.onchange = async () => { if (await saveFn(task, { due_time: time.value || null })) paint(); };
    document.getElementById('due-dialog-clear').onclick = async () => {
      if (await saveFn(task, { due_date: null, due_time: null })) paint();
      dlg.open = false;
    };
    document.getElementById('due-dialog-done').onclick = () => { paint(); dlg.open = false; };
    dlg.open = true;
    setTimeout(() => { try { date.showPicker ? date.showPicker() : date.focus(); } catch { date.focus(); } }, 0);
  };

  btn.addEventListener('click', openDialog);
  pill.addEventListener('click', openDialog);
  paint();
  box.append(btn, pill);
  return labeled('Due', box);
}

// tags: same icon→value pill → dialog pattern as the drawer. Unset = tag icon;
// set = pill (tag + names / "N tags"). Both open the shared #tags-dialog, which
// hosts the chips + suggestion-popover field; the pill repaints on close.
function tagsControl(task, saveFn = save) {
  const wrap = el('div', 'tags-editor');
  const btn = el('button', 'meta-icon-btn');
  btn.type = 'button';
  btn.append(icon('tag', { size: 15 }));
  btn.setAttribute('aria-label', 'Add tags');
  btn.title = 'Add tags';
  const pill = el('button', 'meta-pill');
  pill.type = 'button';
  pill.title = 'Edit tags';
  const paint = () => {
    const label = tagsLabel(task);
    if (label) {
      pill.replaceChildren(icon('tag', { size: 13 }), el('span', 'pill-text', label));
      pill.hidden = false;
      btn.hidden = true;
    } else {
      pill.hidden = true;
      btn.hidden = false;
    }
  };
  const open = () => openTagsPicker(task, fields => saveFn(task, fields), paint);
  btn.addEventListener('click', open);
  pill.addEventListener('click', open);
  paint();
  wrap.append(btn, pill);
  return labeled('Tags', wrap);
}

// assignee: always a value pill (glyph + friendly name) opening the shared
// #assignee-dialog (segmented Me | Claude | Hermes + delegate auto-close).
function assigneeControl(task, saveFn = save) {
  const wrap = el('div', 'inline-when');
  const pill = el('button', 'meta-pill');
  pill.type = 'button';
  pill.title = 'Change assignee';
  const paint = () => {
    const who = task.assignee ?? currentActor();
    // expanded inline card keeps the name beside the glyph (only the collapsed
    // row list view is icon-only — see views.js assigneePill)
    pill.replaceChildren(icon(assigneeGlyph(who), { size: 13 }), el('span', 'pill-text', assigneeLabel(who)));
    pill.setAttribute('aria-label', `Assigned to ${assigneeLabel(who)}`);
  };
  pill.addEventListener('click', () => openAssigneePicker(task, fields => saveFn(task, fields), paint));
  paint();
  wrap.append(pill);
  return labeled('Assignee', wrap);
}

function labeled(label, child) {
  const wrap = el('div', 'inline-field');
  wrap.append(el('label', null, label), child);
  return wrap;
}

// ---- create mode: a blank inline card at the top of the list (Option A) ----
// A draft task object collects field edits locally (no id yet, so nothing is
// PATCHed) and a single POST on Create persists everything at once — the same
// shape submitCreate uses in the drawer, but rendered inline so the drawer is no
// longer needed to add a task.
export function hasCreateCard() { return createCard !== null; }

export function cancelCreate() {
  if (!createCard) return false;
  createCard.remove();
  createCard = null;
  return true;
}

export function createInline(prefill = {}, contextName = 'Inbox') {
  cancelCreate();
  if (expanded) collapseInline({ sync: false });
  const { __openWhenPicker, ...fields } = prefill;
  const task = {
    id: null, title: '', notes: '', project_id: null, when_type: null, when_date: null,
    due_date: null, due_time: null, recur: null, tags: [], steps: [],
    assignee: currentActor(), auto_close: 0, status: 'active', template: null, report: null,
    ...fields,
  };
  // draft-save: fields land on the local object; controls repaint from it. No API
  // call and always "succeeds" so the shared pickers behave exactly as when live.
  const draftSave = (t, f) => { Object.assign(t, f); return true; };

  const row = el('div', 'task-row expanded creating');

  const head = el('div', 'inline-head');
  const title = el('input', 'inline-title');
  title.type = 'text';
  title.placeholder = 'New task';
  title.value = task.title;
  title.addEventListener('input', () => { task.title = title.value; });
  title.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelCreate(); }
  });
  head.append(title, el('span', 'inline-ctx', contextName));

  const body = el('div', 'inline-body');
  const inner = el('div', 'inline-body-inner');
  body.append(inner);

  const notes = el('textarea', 'inline-notes');
  notes.placeholder = 'Notes…';
  notes.value = task.notes ?? '';
  const grow = () => { notes.style.height = 'auto'; notes.style.height = `${notes.scrollHeight + 2}px`; };
  notes.addEventListener('input', () => { task.notes = notes.value; grow(); });
  inner.append(notes);

  inner.append(draftStepsEditor(task));
  inner.append(controlsRow(task, { saveFn: draftSave, create: true }));

  const actions = el('div', 'detail-actions');
  const create = document.createElement('wa-button');
  create.setAttribute('variant', 'brand');
  create.textContent = 'Create';
  create.addEventListener('click', () => submit());
  const cancel = document.createElement('wa-button');
  cancel.setAttribute('appearance', 'plain');
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => cancelCreate());
  actions.append(create, cancel);
  inner.append(actions);

  row.append(head, body);

  let creating = false; // double-submit guard
  async function submit() {
    if (creating) return;
    const t = title.value.trim();
    if (!t) { toast('A title is required'); title.focus(); return; }
    creating = true;
    create.setAttribute('loading', ''); create.setAttribute('disabled', '');
    const payload = {
      title: t, notes: task.notes, project_id: task.project_id,
      when_type: task.when_type, when_date: task.when_date,
      due_date: task.due_date, due_time: task.due_time,
      recur: task.recur, tags: task.tags, steps: task.steps,
      assignee: task.assignee, auto_close: !!task.auto_close, template: task.template ?? null,
    };
    try {
      const created = await api('POST', '/tasks', payload);
      createCard = null; // reload() rebuilds #list and drops this card
      animateOnce.list = true;
      await reload();
      if (!state.tasks.some(x => x.id === created.id)) {
        const proj = state.projects.find(p => p.id === created.project_id);
        const where = created.assignee !== currentActor() ? `${created.assignee}'s queue`
          : proj ? proj.name
          : created.when_type === 'someday' ? 'Someday'
          : created.when_type === 'date' ? 'Upcoming'
          : 'Inbox';
        toast(`Added to ${where}`, 'success');
      }
    } catch (e) {
      toast(`Create failed: ${e.message}`);
      creating = false;
      create.removeAttribute('loading'); create.removeAttribute('disabled');
    }
  }

  const listEl = document.getElementById('list');
  listEl.insertBefore(row, listEl.firstChild);
  createCard = row;

  // no expand animation to fight (freshly inserted) — open immediately
  requestAnimationFrame(() => { body.classList.add('open', 'done'); grow(); });
  setTimeout(() => title.focus({ preventScroll: true }), 30);
  if (__openWhenPicker) {
    const btn = row.querySelector('.inline-when .meta-icon-btn');
    setTimeout(() => btn?.click(), 80); // Upcoming: prompt a date right away
  }
}

// local draft steps: titles collected into task.steps, POSTed with the task.
function draftStepsEditor(task) {
  const wrap = el('div');
  wrap.append(el('label', null, 'Steps'));
  const ul = el('ul', 'steps-list');
  const render = () => {
    ul.replaceChildren();
    task.steps.forEach((title, i) => {
      const li = el('li', 'step-row');
      const name = el('input');
      name.type = 'text';
      name.value = title;
      name.addEventListener('change', () => {
        if (name.value.trim()) task.steps[i] = name.value.trim();
        else { task.steps.splice(i, 1); render(); }
      });
      const del = el('button', 'del');
      del.append(icon('x', { size: 14 }));
      del.setAttribute('aria-label', 'Delete step');
      del.addEventListener('click', () => { task.steps.splice(i, 1); render(); });
      li.append(name, del);
      ul.append(li);
    });
  };
  render();
  const add = el('input', 'step-add');
  add.type = 'text';
  add.placeholder = 'Add a step…';
  add.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !add.value.trim()) return;
    e.preventDefault();
    e.stopPropagation();
    task.steps.push(add.value.trim());
    add.value = '';
    render();
  });
  wrap.append(ul, add);
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
