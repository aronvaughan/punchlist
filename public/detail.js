// detail.js — slide-over task editor (wa-drawer). Field edits PATCH sparsely;
// the list re-renders in the background. Titles/labels via textContent only;
// notes preview goes through md.js (escaped).
import Sortable from '/vendor/sortable.core.esm.js';
import { api, state, reload, toast, todayISO, pickWhen, currentActor,
  uploadAttachment, attachmentObjectURL } from '/app.js';
import { mdToHtml } from '/md.js';
import { dueLine } from '/dates.js';
import { tagsField, assigneeField } from '/suggest.js';
import { openManageDialog, animateOnce, performDelete } from '/views.js';

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const drawer = () => document.getElementById('detail');
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

let current = null; // the task being edited (kept fresh from PATCH responses)
let createMode = false; // create: fields collect locally, ONE POST on Create
let createContext = ''; // view name shown in the eyebrow
let titleInput = null;

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
  if (createMode) {
    // draft: collect locally, mirroring the server's when-field coupling;
    // nothing exists on the server until Create POSTs once
    if (fields.when_type === 'someday' || fields.when_type === null) current.when_date = null;
    if (fields.when_date && fields.when_type === undefined) fields.when_type = 'date';
    Object.assign(current, fields);
    return true;
  }
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
  createMode = false;
  current = task;
  renderDrawer();
}

// create mode: full editor, prefilled from the current view's context.
// prefill.__openWhenPicker opens the date picker right away (Upcoming).
export function openCreate(prefill = {}, contextName = 'Inbox') {
  const { __openWhenPicker, ...fields } = prefill;
  createMode = true;
  createContext = contextName;
  current = { title: '', notes: '', project_id: null, when_type: null, when_date: null,
    due_date: null, due_time: null, recur: null, tags: [], steps: [],
    assignee: currentActor(), auto_close: 0, status: 'active', report: null, ...fields };
  renderDrawer();
  setTimeout(() => titleInput?.focus(), 60);
  if (__openWhenPicker) {
    pickWhen().then(async d => {
      if (d && createMode) { await patch({ when_type: 'date', when_date: d }); rebuild(); }
    });
  }
}

function renderDrawer() {
  const task = current;
  if (createMode) {
    drawer().label = `New task — ${createContext}`;
  } else {
    // eyebrow: the task's project name (or Inbox); keeps the close X
    const proj = state.projects.find(p => p.id === task.project_id);
    drawer().label = proj ? proj.name : 'Inbox';
  }
  const body = document.getElementById('detail-body');
  body.replaceChildren();

  // title
  const title = el('input');
  title.type = 'text';
  title.id = 'detail-title';
  title.value = task.title;
  title.placeholder = createMode ? 'Task title' : '';
  title.addEventListener('change', () => { if (title.value.trim() || createMode) patch({ title: title.value.trim() }); });
  title.addEventListener('keydown', e => { if (e.key === 'Enter' && createMode) submitCreate(); });
  titleInput = title;
  body.append(title);

  body.append(whenEditor(), dueEditor(), projectEditor(), assigneeEditor(), templateEditor());
  body.append(notesEditor(), createMode ? draftStepsEditor() : stepsEditorFor(task), recurEditor());
  if (createMode) {
    // tags near the bottom (rows are display-only; editing happens here)
    body.append(tagsEditor());
    body.append(createActions());
  } else {
    body.append(attachmentsEditor(task));
    const rep = reportView();
    if (rep) body.append(rep);
    body.append(timelineSection(task));
    // assigned tags + editor at the BOTTOM of the drawer (single edit surface)
    body.append(tagsEditor());
    body.append(actions());
    const meta = [`added by ${task.created_by}`, (task.created_at || '').slice(0, 10)];
    if (task.claimed_at) meta.push(`claimed ${task.claimed_at.slice(0, 16).replace('T', ' ')}`);
    body.append(el('div', 'meta-line', meta.join(' · ')));
  }
  drawer().open = true;
}

function rebuild() { renderDrawer(); }

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

// ---- due date + time (+ live countdown line) ----
function dueEditor() {
  const wrap = el('div');
  const row = el('div', 'field-row');
  const line = el('div', 'due-line');
  const renderLine = () => {
    if (!current.due_date) { line.hidden = true; return; }
    const { text, urgent } = dueLine(current.due_date, todayISO());
    line.textContent = text;
    line.classList.toggle('urgent', urgent);
    line.hidden = false;
  };
  const date = el('input');
  date.type = 'date';
  date.value = current.due_date ?? '';
  date.addEventListener('change', async () => {
    if (await patch({ due_date: date.value || null })) renderLine();
  });
  const time = el('input');
  time.type = 'time';
  time.value = current.due_time ?? '';
  time.addEventListener('change', () => patch({ due_time: time.value || null }));
  row.append(labeled('Deadline', date), labeled('Time', time));
  renderLine();
  wrap.append(row, line);
  return wrap;
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
  // "Manage…" opens the shared tree-admin dialog; on close the picker refreshes
  // its options and selects a project that was just created there
  const manage = el('button', 'link-btn', 'Manage…');
  manage.type = 'button';
  manage.addEventListener('click', async () => {
    const { createdId } = await openManageDialog();
    if (createdId) await patch({ project_id: createdId });
    rebuild(); // repaint options (and selection) from fresh state.projects
  });
  const row = el('div', 'project-picker-row');
  row.append(sel, manage);
  return labeled('Project', row);
}

function assigneeEditor() {
  const t = current;
  return labeled('Assignee', assigneeField(t, async fields => {
    const ok = await patch(fields);
    if (ok) Object.assign(t, current); // patch() replaced `current`; refresh the field's ref
    return ok;
  }));
}

// ---- template picker (Part B): a select from GET /templates + "(none)" ----
// Stamps task.template (a free string — the templates repo is authoritative).
// When a task carries a template, an agent `plt show`s it for driving context.
let templatesCache = null;
async function loadTemplates() {
  if (templatesCache) return templatesCache;
  try { templatesCache = (await api('GET', '/templates')).items || []; }
  catch { templatesCache = []; }
  return templatesCache;
}

function templateEditor() {
  const sel = el('select');
  const none = el('option', null, '(none)');
  none.value = '';
  sel.append(none);
  const chip = el('span', 'chip template-chip');
  const renderChip = () => {
    if (current.template) { chip.textContent = `▤ ${current.template}`; chip.hidden = false; }
    else chip.hidden = true;
  };
  const populate = items => {
    // keep a stamped-but-unknown template (stale ref, or repo absent) selectable
    const names = new Set(items.map(t => t.name));
    for (const tpl of items) {
      const o = el('option', null, tpl.name);
      o.value = tpl.name;
      sel.append(o);
    }
    if (current.template && !names.has(current.template)) {
      const o = el('option', null, `${current.template} (unlisted)`);
      o.value = current.template;
      sel.append(o);
    }
    sel.value = current.template ?? '';
  };
  loadTemplates().then(populate);
  sel.value = current.template ?? '';
  sel.addEventListener('change', async () => {
    if (await patch({ template: sel.value || null })) renderChip();
  });
  renderChip();
  const row = el('div', 'template-picker-row');
  row.append(sel, chip);
  return labeled('Template', row);
}

// ---- activity thread (Part A): the drawer's Timeline section + composer ----
const TL_KIND_LABEL = { question: 'asked', answer: 'answered', report: 'reported' };

function relTime(iso) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function timelineEntry(cm) {
  const entry = el('div', `tl-entry tl-${cm.kind}`);
  if (cm.kind === 'status') {
    // muted one-liner with a subtle rule
    const line = el('div', 'tl-status-line');
    line.append(el('span', 'tl-author', cm.author || 'system'),
      document.createTextNode(` ${cm.text} · `), el('span', 'tl-time', relTime(cm.created_at)));
    entry.append(line);
    return entry;
  }
  const head = el('div', 'tl-head');
  head.append(el('span', 'chip tl-author-chip', cm.author || '—'));
  if (TL_KIND_LABEL[cm.kind]) head.append(el('span', 'tl-kind', TL_KIND_LABEL[cm.kind]));
  head.append(el('span', 'tl-time', relTime(cm.created_at)));
  const bodyEl = el('div', 'tl-body notes-preview');
  bodyEl.innerHTML = mdToHtml(cm.text); // mdToHtml escapes ALL input — the only sink, safe
  entry.append(head, bodyEl);
  return entry;
}

function timelineSection(task) {
  const wrap = el('div', 'timeline');
  wrap.append(el('label', null, 'Timeline'));
  const listEl = el('div', 'tl-list');
  wrap.append(listEl);

  const load = async () => {
    let items;
    try { items = (await api('GET', `/tasks/${task.id}/comments`)).items; }
    catch (e) { listEl.replaceChildren(el('div', 'tl-empty', `Couldn't load timeline: ${e.message}`)); return; }
    listEl.replaceChildren();
    if (!items.length) listEl.append(el('div', 'tl-empty', 'No activity yet.'));
    else for (const cm of items) listEl.append(timelineEntry(cm));
  };

  const composer = el('div', 'tl-composer');
  const ta = el('textarea');
  ta.className = 'tl-input';
  ta.placeholder = 'Add a comment (markdown)…';
  const post = document.createElement('wa-button');
  post.setAttribute('variant', 'brand');
  post.setAttribute('size', 'small');
  post.textContent = 'Post';
  const submit = async () => {
    const text = ta.value.trim();
    if (!text) return;
    post.setAttribute('loading', '');
    try {
      await api('POST', `/tasks/${task.id}/comments`, { text });
      ta.value = '';
      await load();
      reload(); // refresh the row 💬 count in the background
    } catch (e) { toast(`Comment failed: ${e.message}`); }
    finally { post.removeAttribute('loading'); }
  };
  post.addEventListener('click', submit);
  composer.append(ta, post);
  wrap.append(composer);
  load();
  return wrap;
}

// agent's report (markdown, safe renderer) — shown for review/done delegated work
function reportView() {
  if (!current.report) return null;
  const wrap = el('div');
  wrap.append(el('label', null, 'Report'));
  const bodyEl = el('div', 'report-body notes-preview');
  bodyEl.innerHTML = mdToHtml(current.report); // mdToHtml escapes ALL input
  wrap.append(bodyEl);
  return wrap;
}

// ---- image attachments (jpg/png): upload control + thumbnail cards ----
const ACCEPT = 'image/png,image/jpeg';
const objectUrls = new Set(); // revoked on each repaint to avoid leaks

// current retention rule → the selector value the card should show
function retentionValue(att) {
  if (att.expires_at) return 'expires';
  return att.retention === 'on_done' ? 'on_done' : 'keep';
}

function attachmentsEditor(task) {
  const wrap = el('div', 'attachments');
  wrap.append(el('label', null, 'Images'));

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = ACCEPT;
  input.multiple = true;
  input.className = 'att-input';
  input.id = 'att-input';

  const trigger = el('button', 'att-add', '＋ Attach image');
  trigger.type = 'button';
  trigger.addEventListener('click', () => input.click());

  const grid = el('div', 'att-grid');
  const drop = el('div', 'att-drop');
  drop.append(trigger, input, grid);

  const refresh = async () => {
    for (const u of objectUrls) URL.revokeObjectURL(u);
    objectUrls.clear();
    grid.replaceChildren();
    let items;
    try { items = (await api('GET', `/tasks/${task.id}/attachments`)).items; }
    catch (e) { grid.append(el('div', 'att-empty', `Couldn't load images: ${e.message}`)); return; }
    if (!items.length) { grid.append(el('div', 'att-empty', 'No images yet.')); return; }
    for (const att of items) grid.append(attachmentCard(att, refresh));
  };

  const doUpload = async files => {
    const imgs = [...files].filter(f => f.type === 'image/png' || f.type === 'image/jpeg');
    if (!imgs.length) { if (files.length) toast('Only PNG and JPEG images are supported'); return; }
    for (const f of imgs) {
      try { await uploadAttachment(task.id, f); }
      catch (e) { toast(`Upload failed: ${e.message}`); }
    }
    await refresh();
    reload(); // refresh the row 📎 count in the background
  };

  input.addEventListener('change', () => { if (input.files.length) doUpload(input.files); input.value = ''; });
  // drag-drop onto the drop zone also uploads
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length) doUpload(e.dataTransfer.files);
  });

  wrap.append(drop);
  refresh();
  return wrap;
}

function attachmentCard(att, refresh) {
  const card = el('div', 'att-card');

  // thumbnail: lazy — fetch the bytes (with the token) only when scrolled near
  const thumb = el('div', 'att-thumb');
  const img = document.createElement('img');
  img.alt = att.filename;
  img.loading = 'lazy';
  thumb.append(img);
  const io = new IntersectionObserver(entries => {
    if (!entries.some(en => en.isIntersecting)) return;
    io.disconnect();
    attachmentObjectURL(att.id)
      .then(url => { objectUrls.add(url); img.src = url; })
      .catch(() => thumb.classList.add('att-broken'));
  }, { root: null, rootMargin: '200px' });
  io.observe(thumb);
  // open full-size in a new tab (blob URL) on click
  thumb.addEventListener('click', async () => {
    try { window.open(await attachmentObjectURL(att.id), '_blank', 'noopener'); }
    catch (e) { toast(`Open failed: ${e.message}`); }
  });

  const meta = el('div', 'att-meta');
  meta.append(el('div', 'att-name', att.filename));

  // retention selector: Keep | Delete when done | Expire…(date)
  const sel = document.createElement('select');
  sel.className = 'att-retention';
  for (const [v, label] of [['keep', 'Keep'], ['on_done', 'Delete when done'], ['expires', 'Expire…']]) {
    const o = el('option', null, label);
    o.value = v;
    sel.append(o);
  }
  sel.value = retentionValue(att);

  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.className = 'att-expires';
  dateInput.value = att.expires_at || '';
  dateInput.hidden = sel.value !== 'expires';

  sel.addEventListener('change', async () => {
    dateInput.hidden = sel.value !== 'expires';
    if (sel.value === 'keep') await patchAttachment(att.id, { retention: 'keep', expires_at: null });
    else if (sel.value === 'on_done') await patchAttachment(att.id, { retention: 'on_done', expires_at: null });
    else if (sel.value === 'expires' && dateInput.value) {
      await patchAttachment(att.id, { retention: 'keep', expires_at: dateInput.value });
    }
  });
  dateInput.addEventListener('change', async () => {
    if (dateInput.value) await patchAttachment(att.id, { retention: 'keep', expires_at: dateInput.value });
  });

  const retentionRow = el('div', 'att-retention-row');
  retentionRow.append(sel, dateInput);
  meta.append(retentionRow);

  const del = el('button', 'att-del', '✕');
  del.type = 'button';
  del.title = 'Delete image';
  del.setAttribute('aria-label', `Delete ${att.filename}`);
  del.addEventListener('click', async () => {
    try { await api('DELETE', `/attachments/${att.id}`); await refresh(); reload(); }
    catch (e) { toast(`Delete failed: ${e.message}`); }
  });

  card.append(thumb, meta, del);
  return card;
}

async function patchAttachment(id, body) {
  try { await api('PATCH', `/attachments/${id}`, body); }
  catch (e) { toast(`Save failed: ${e.message}`); }
}

function tagsEditor() {
  // shared chips + suggestion-popover field (suggest.js); patch() refreshes
  // `current`, the field keeps its own copy in sync on success
  return labeled('Tags', tagsField(current, fields => patch(fields)));
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

// ---- steps checklist (shared with the inline row editor) ----
export function stepsEditorFor(task) {
  const wrap = el('div');
  wrap.append(el('label', null, 'Steps'));
  const ul = el('ul', 'steps-list');

  const stepRow = step => {
    const li = el('li', 'step-row');
    li.dataset.sid = step.id;
    // grip: the ONLY drag handle — the rest of the row scrolls/edits normally
    const grip = el('span', 'grip');
    grip.setAttribute('aria-hidden', 'true');
    li.append(grip);
    const check = el('button', 'check' + (step.done ? ' checked' : ''));
    check.setAttribute('aria-label', 'Toggle step');
    check.addEventListener('click', async () => {
      check.classList.toggle('checked');
      try { await api('PATCH', `/tasks/${task.id}/steps/${step.id}`, { done: check.classList.contains('checked') }); }
      catch (e) { check.classList.toggle('checked'); toast(`Save failed: ${e.message}`); }
    });
    const name = el('input');
    name.type = 'text';
    name.value = step.title;
    name.addEventListener('change', async () => {
      if (!name.value.trim()) { name.value = step.title; return; }
      try { await api('PATCH', `/tasks/${task.id}/steps/${step.id}`, { title: name.value.trim() }); }
      catch (e) { toast(`Save failed: ${e.message}`); }
    });
    const del = el('button', 'del', '✕');
    del.setAttribute('aria-label', 'Delete step');
    del.addEventListener('click', async () => {
      try { await api('DELETE', `/tasks/${task.id}/steps/${step.id}`); li.remove(); }
      catch (e) { toast(`Delete failed: ${e.message}`); }
    });
    li.append(check, name, del);
    return li;
  };
  for (const s of task.steps ?? []) ul.append(stepRow(s));

  const ranks = new Map((task.steps ?? []).map(s => [s.id, s.rank]));
  new Sortable(ul, {
    animation: 150,
    handle: '.grip',
    onEnd: async evt => {
      const sid = evt.item.dataset.sid;
      const prev = evt.item.previousElementSibling?.dataset.sid;
      const next = evt.item.nextElementSibling?.dataset.sid;
      const p = prev ? ranks.get(prev) : null;
      const n = next ? ranks.get(next) : null;
      const rank = p != null && n != null ? (p + n) / 2 : p != null ? p + 1024 : n != null ? n - 1024 : 1024;
      try {
        const updated = await api('PATCH', `/tasks/${task.id}/steps/${sid}`, { rank });
        ranks.set(sid, updated.rank);
      } catch (e) { toast(`Reorder failed: ${e.message}`); }
    },
  });

  const add = el('input', 'step-add');
  add.type = 'text';
  add.placeholder = 'Add a step…';
  add.addEventListener('keydown', async e => {
    if (e.key !== 'Enter' || !add.value.trim()) return;
    e.stopPropagation();
    try {
      const step = await api('POST', `/tasks/${task.id}/steps`, { title: add.value.trim() });
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

// ---- create mode: local draft steps (POSTed as titles with the task) ----
function draftStepsEditor() {
  const wrap = el('div');
  wrap.append(el('label', null, 'Steps'));
  const ul = el('ul', 'steps-list');
  const render = () => {
    ul.replaceChildren();
    current.steps.forEach((title, i) => {
      const li = el('li', 'step-row');
      const name = el('input');
      name.type = 'text';
      name.value = title;
      name.addEventListener('change', () => {
        if (name.value.trim()) current.steps[i] = name.value.trim();
        else { current.steps.splice(i, 1); render(); }
      });
      const del = el('button', 'del', '✕');
      del.setAttribute('aria-label', 'Delete step');
      del.addEventListener('click', () => { current.steps.splice(i, 1); render(); });
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
    e.stopPropagation();
    current.steps.push(add.value.trim());
    add.value = '';
    render();
  });
  wrap.append(ul, add);
  return wrap;
}

// double-submit guard: disable the Create button + a re-entrancy flag while the
// POST is in flight, so a fast double-click can't create the task twice.
let creating = false;
async function submitCreate() {
  if (creating) return;
  const title = (titleInput?.value ?? current.title).trim();
  if (!title) { toast('A title is required'); titleInput?.focus(); return; }
  creating = true;
  const btn = document.querySelector('#detail-body .detail-actions wa-button[variant="brand"]');
  btn?.setAttribute('loading', '');
  btn?.setAttribute('disabled', '');
  const body = {
    title, notes: current.notes, project_id: current.project_id,
    when_type: current.when_type, when_date: current.when_date,
    due_date: current.due_date, due_time: current.due_time,
    recur: current.recur, tags: current.tags, steps: current.steps,
    assignee: current.assignee, auto_close: !!current.auto_close,
    template: current.template ?? null,
  };
  try {
    const created = await api('POST', '/tasks', body);
    createMode = false;
    closeDetail();
    animateOnce.list = true; // the new task slides into the list
    await reload();
    if (!state.tasks.some(t => t.id === created.id)) {
      // landed outside the current view — say where
      const proj = state.projects.find(p => p.id === created.project_id);
      const where = created.assignee !== currentActor()
        ? `${created.assignee}'s queue`
        : proj ? proj.name
        : created.when_type === 'someday' ? 'Someday'
        : created.when_type === 'date' ? 'Upcoming'
        : 'Inbox';
      toast(`Added to ${where}`, 'success');
    }
  } catch (e) { toast(`Create failed: ${e.message}`); }
  finally { creating = false; btn?.removeAttribute('loading'); btn?.removeAttribute('disabled'); }
}

function createActions() {
  const row = el('div', 'detail-actions');
  const create = document.createElement('wa-button');
  create.setAttribute('variant', 'brand');
  create.textContent = 'Create';
  create.addEventListener('click', submitCreate);
  const cancel = document.createElement('wa-button');
  cancel.setAttribute('appearance', 'plain');
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => { createMode = false; closeDetail(); });
  row.append(create, cancel);
  return row;
}

function actions() {
  const row = el('div', 'detail-actions');
  const primaryDoor = async (path, okMsg) => {
    try {
      const res = await api('POST', `/tasks/${current.id}${path}`);
      if (res.spawned_id) toast('Done — next occurrence scheduled', 'success');
      else if (okMsg) toast(okMsg, 'success');
      closeDetail();
      reload();
    } catch (e) { toast(`Failed: ${e.message}`); }
  };
  const complete = document.createElement('wa-button');
  complete.setAttribute('variant', 'brand');
  if (current.status === 'review') {
    // review lane: the admin approves (→ done) or reopens (→ active, report kept)
    complete.textContent = 'Approve';
    complete.addEventListener('click', () => primaryDoor('/approve', 'Approved'));
    const reopen = document.createElement('wa-button');
    reopen.setAttribute('appearance', 'plain');
    reopen.textContent = 'Reopen';
    reopen.addEventListener('click', async () => {
      // optional reopen comment (skippable) rides with the review→active flip;
      // the server posts it (kind=answer) before reopening and lifts the task
      // to the top of the agent backlog
      const reason = (prompt('Reason for reopening (optional — leave blank to skip):') || '').trim();
      if (await patch(reason ? { status: 'active', comment: reason } : { status: 'active' })) closeDetail();
    });
    row.append(reopen);
  } else if (current.status === 'done') {
    complete.textContent = 'Completed';
    complete.setAttribute('disabled', '');
  } else if (current.status === 'in_progress') {
    complete.textContent = `In progress (${current.assignee})`;
    complete.setAttribute('disabled', '');
  } else {
    complete.textContent = 'Complete';
    complete.addEventListener('click', () => primaryDoor('/complete'));
  }
  const archive = document.createElement('wa-button');
  archive.setAttribute('appearance', 'outlined');
  archive.textContent = current.status === 'archived' ? 'Unarchive' : 'Archive';
  archive.addEventListener('click', async () => {
    if (current.status === 'archived') { if (await patch({ status: 'active' })) closeDetail(); return; }
    // archiving: reuse the completion fade+collapse on the list row so the task
    // doesn't vanish abruptly, then close + reload from server truth
    const id = current.id;
    const row = document.querySelector(`.task-row[data-id="${CSS.escape(id)}"]`);
    const wait = (reducedMotion() || !row) ? Promise.resolve()
      : new Promise(r => { row.classList.add('removing'); setTimeout(r, 250); });
    try {
      const [updated] = await Promise.all([api('PATCH', `/tasks/${id}`, { status: 'archived' }), wait]);
      current = updated;
      closeDetail();
      reload();
    } catch (e) { row?.classList.remove('removing'); toast(`Archive failed: ${e.message}`); }
  });
  // hard delete: irreversible, admin-only server-side. Set apart from Archive
  // (reversible) by danger styling and its own confirm ("can't be undone").
  const del = document.createElement('wa-button');
  del.setAttribute('variant', 'danger');
  del.setAttribute('appearance', 'plain');
  del.className = 'detail-delete';
  del.textContent = 'Delete';
  del.addEventListener('click', async () => { if (await performDelete(current)) closeDetail(); });
  row.append(complete, archive, del);
  return row;
}
