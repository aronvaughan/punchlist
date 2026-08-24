// detail.js — slide-over task editor (wa-drawer). Field edits PATCH sparsely;
// the list re-renders in the background. Titles/labels via textContent only;
// notes preview goes through md.js (escaped).
import Sortable from '/vendor/sortable.core.esm.js';
import { api, state, reload, toast, todayISO, pickWhen } from '/app.js';
import { mdToHtml } from '/md.js';

const drawer = () => document.getElementById('detail');
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

let current = null; // the task being edited (kept fresh from PATCH responses)

export function isDetailOpen() { return !!drawer().open; }
export function closeDetail() { drawer().open = false; }

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function labeled(label, child) {
  const wrap = el('div');
  wrap.append(el('label', null, label), child);
  return wrap;
}

async function patch(fields) {
  try {
    current = await api('PATCH', `/tasks/${current.id}`, fields);
    reload(); // background: keep the list truthful
    return true;
  } catch (e) {
    toast(`Save failed: ${e.message}`);
    return false;
  }
}

export function openDetail(task) {
  current = task;
  // eyebrow: the task's project name (or Inbox) as the drawer heading,
  // styled small/muted in tokens.css via ::part(title); keeps the close X
  const proj = state.projects.find(p => p.id === task.project_id);
  drawer().label = proj ? proj.name : 'Inbox';
  const body = document.getElementById('detail-body');
  body.replaceChildren();

  // title
  const title = el('input');
  title.type = 'text';
  title.id = 'detail-title';
  title.value = task.title;
  title.addEventListener('change', () => { if (title.value.trim()) patch({ title: title.value.trim() }); });
  body.append(title);

  body.append(whenEditor(), dueEditor(), projectEditor(), tagsEditor());
  body.append(notesEditor(), stepsEditor(), recurEditor(), actions());
  body.append(el('div', 'meta-line', `added by ${task.created_by} · ${(task.created_at || '').slice(0, 10)}`));
  drawer().open = true;
}

function rebuild() { openDetail(current); }

// ---- when: Today | date | Someday | Clear ----
function whenEditor() {
  const seg = el('div', 'seg');
  const isToday = current.when_type === 'date' && current.when_date === todayISO();
  const mk = (label, on, fn) => {
    const b = el('button', on ? 'on' : null, label);
    b.addEventListener('click', async () => { if (await fn()) rebuild(); });
    seg.append(b);
  };
  mk('Today', isToday, () => patch({ when_type: 'date', when_date: todayISO() }));
  const dateLabel = current.when_type === 'date' && !isToday ? current.when_date : 'Date…';
  mk(dateLabel, current.when_type === 'date' && !isToday, async () => {
    const d = await pickWhen(current.when_date);
    return d ? patch({ when_type: 'date', when_date: d }) : false;
  });
  mk('Someday', current.when_type === 'someday', () => patch({ when_type: 'someday' }));
  mk('Clear', false, () => patch({ when_type: null }));
  return labeled('When', seg);
}

// ---- due date + time ----
function dueEditor() {
  const row = el('div', 'field-row');
  const date = el('input');
  date.type = 'date';
  date.value = current.due_date ?? '';
  date.addEventListener('change', () => patch({ due_date: date.value || null }));
  const time = el('input');
  time.type = 'time';
  time.value = current.due_time ?? '';
  time.addEventListener('change', () => patch({ due_time: time.value || null }));
  row.append(labeled('Deadline', date), labeled('Time', time));
  return row;
}

function projectEditor() {
  const sel = el('select');
  const none = el('option', null, '(none — inbox)');
  none.value = '';
  sel.append(none);
  for (const p of state.projects.filter(p => !p.archived)) {
    const o = el('option', null, p.name);
    o.value = p.id;
    sel.append(o);
  }
  sel.value = current.project_id ?? '';
  sel.addEventListener('change', () => patch({ project_id: sel.value || null }));
  return labeled('Project', sel);
}

function tagsEditor() {
  const input = el('input');
  input.type = 'text';
  input.placeholder = 'comma, separated';
  input.value = (current.tags ?? []).join(', ');
  input.addEventListener('change', () => {
    const tags = input.value.split(',').map(s => s.trim()).filter(Boolean);
    patch({ tags });
  });
  return labeled('Tags', input);
}

function notesEditor() {
  const wrap = el('div');
  const ta = el('textarea');
  ta.placeholder = 'Notes (markdown)';
  ta.value = current.notes ?? '';
  const preview = el('div', 'notes-preview');
  const render = () => {
    // mdToHtml escapes ALL input; this is the only innerHTML sink and it is safe
    preview.innerHTML = mdToHtml(current.notes ?? '');
    preview.hidden = !(current.notes ?? '').trim();
  };
  ta.addEventListener('change', async () => { if (await patch({ notes: ta.value })) render(); });
  render();
  wrap.append(labeled('Notes', ta), preview);
  return wrap;
}

// ---- steps checklist ----
function stepsEditor() {
  const wrap = el('div');
  wrap.append(el('label', null, 'Steps'));
  const ul = el('ul', 'steps-list');

  const stepRow = step => {
    const li = el('li', 'step-row');
    li.dataset.sid = step.id;
    const check = el('button', 'check' + (step.done ? ' checked' : ''));
    check.setAttribute('aria-label', 'Toggle step');
    check.addEventListener('click', async () => {
      check.classList.toggle('checked');
      try { await api('PATCH', `/tasks/${current.id}/steps/${step.id}`, { done: check.classList.contains('checked') }); }
      catch (e) { check.classList.toggle('checked'); toast(`Save failed: ${e.message}`); }
    });
    const name = el('input');
    name.type = 'text';
    name.value = step.title;
    name.addEventListener('change', async () => {
      if (!name.value.trim()) { name.value = step.title; return; }
      try { await api('PATCH', `/tasks/${current.id}/steps/${step.id}`, { title: name.value.trim() }); }
      catch (e) { toast(`Save failed: ${e.message}`); }
    });
    const del = el('button', 'del', '✕');
    del.setAttribute('aria-label', 'Delete step');
    del.addEventListener('click', async () => {
      try { await api('DELETE', `/tasks/${current.id}/steps/${step.id}`); li.remove(); }
      catch (e) { toast(`Delete failed: ${e.message}`); }
    });
    li.append(check, name, del);
    return li;
  };
  for (const s of current.steps ?? []) ul.append(stepRow(s));

  const ranks = new Map((current.steps ?? []).map(s => [s.id, s.rank]));
  new Sortable(ul, {
    animation: 150,
    handle: '.step-row',
    onEnd: async evt => {
      const sid = evt.item.dataset.sid;
      const prev = evt.item.previousElementSibling?.dataset.sid;
      const next = evt.item.nextElementSibling?.dataset.sid;
      const p = prev ? ranks.get(prev) : null;
      const n = next ? ranks.get(next) : null;
      const rank = p != null && n != null ? (p + n) / 2 : p != null ? p + 1024 : n != null ? n - 1024 : 1024;
      try {
        const updated = await api('PATCH', `/tasks/${current.id}/steps/${sid}`, { rank });
        ranks.set(sid, updated.rank);
      } catch (e) { toast(`Reorder failed: ${e.message}`); }
    },
  });

  const add = el('input');
  add.type = 'text';
  add.placeholder = 'Add a step…';
  add.addEventListener('keydown', async e => {
    if (e.key !== 'Enter' || !add.value.trim()) return;
    e.stopPropagation();
    try {
      const step = await api('POST', `/tasks/${current.id}/steps`, { title: add.value.trim() });
      ranks.set(step.id, step.rank);
      ul.append(stepRow(step));
      add.value = '';
    } catch (err) { toast(`Add failed: ${err.message}`); }
  });
  wrap.append(ul, add);
  return wrap;
}

// ---- recurrence: freq + params + anchor ----
function recurEditor() {
  const wrap = el('div', 'recur-grid');
  wrap.append(el('label', null, 'Repeat'));
  const rule = current.recur ? { ...current.recur, days: [...(current.recur.days ?? [])] } : null;
  const draft = rule ?? { freq: null, anchor: 'due', n: 2, days: ['mon'], dom: 1 };
  if (draft.n == null) draft.n = 2;
  if (!draft.days?.length) draft.days = ['mon'];
  if (draft.dom == null) draft.dom = 1;

  const freqSeg = el('div', 'seg');
  const paramsBox = el('div');
  const anchorSeg = el('div', 'seg');

  const apply = async () => {
    if (draft.freq === null) { if (current.recur && await patch({ recur: null })) rebuild(); return; }
    const out = { freq: draft.freq, anchor: draft.anchor };
    if (draft.freq === 'every') out.n = Number(draft.n) || 1;
    if (draft.freq === 'weekly') out.days = draft.days;
    if (draft.freq === 'monthly') out.dom = Number(draft.dom) || 1;
    if (await patch({ recur: out })) rebuild();
  };

  const renderParams = () => {
    paramsBox.replaceChildren();
    if (draft.freq === 'every') {
      const n = el('input');
      n.type = 'number';
      n.min = '1';
      n.value = String(draft.n);
      n.addEventListener('change', () => { draft.n = n.value; apply(); });
      paramsBox.append(labeled('Every N days', n));
    } else if (draft.freq === 'weekly') {
      const row = el('div', 'seg weekday-row');
      for (const d of WEEKDAYS) {
        const b = el('button', draft.days.includes(d) ? 'on' : null, d);
        b.addEventListener('click', () => {
          draft.days = draft.days.includes(d) ? draft.days.filter(x => x !== d) : [...draft.days, d];
          if (draft.days.length) apply(); else b.classList.remove('on');
        });
        row.append(b);
      }
      paramsBox.append(labeled('On days', row));
    } else if (draft.freq === 'monthly') {
      const dom = el('input');
      dom.type = 'number';
      dom.min = '1';
      dom.max = '31';
      dom.value = String(draft.dom);
      dom.addEventListener('change', () => { draft.dom = dom.value; apply(); });
      paramsBox.append(labeled('Day of month', dom));
    }
    anchorSeg.replaceChildren();
    if (draft.freq !== null) {
      for (const [val, label] of [['due', 'On schedule (from due)'], ['completion', 'After completion']]) {
        const b = el('button', draft.anchor === val ? 'on' : null, label);
        b.addEventListener('click', () => { draft.anchor = val; apply(); });
        anchorSeg.append(b);
      }
    }
  };

  const freqs = [[null, 'None'], ['daily', 'Daily'], ['every', 'Every N'], ['weekly', 'Weekly'], ['monthly', 'Monthly']];
  for (const [val, label] of freqs) {
    const b = el('button', draft.freq === val ? 'on' : null, label);
    b.addEventListener('click', () => { draft.freq = val; renderParams(); apply(); });
    freqSeg.append(b);
  }
  renderParams();
  wrap.append(freqSeg, paramsBox, anchorSeg);
  return wrap;
}

function actions() {
  const row = el('div', 'detail-actions');
  const complete = document.createElement('wa-button');
  complete.setAttribute('variant', 'brand');
  complete.textContent = current.status === 'done' ? 'Completed' : 'Complete';
  if (current.status !== 'done') {
    complete.addEventListener('click', async () => {
      try {
        const res = await api('POST', `/tasks/${current.id}/complete`);
        if (res.spawned_id) toast('Done — next occurrence scheduled', 'success');
        closeDetail();
        reload();
      } catch (e) { toast(`Complete failed: ${e.message}`); }
    });
  } else complete.setAttribute('disabled', '');
  const archive = document.createElement('wa-button');
  archive.setAttribute('appearance', 'outlined');
  archive.textContent = current.status === 'archived' ? 'Unarchive' : 'Archive';
  archive.addEventListener('click', async () => {
    const to = current.status === 'archived' ? 'active' : 'archived';
    if (await patch({ status: to })) { closeDetail(); }
  });
  row.append(complete, archive);
  return row;
}
