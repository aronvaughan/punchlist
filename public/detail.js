// detail.js — shared task-field editors and pickers. Once the home of a
// slide-over wa-drawer; that editor is gone (the inline expand card in inline.js
// is the sole task editor now). What remains here are the reusable pieces the
// inline card composes: the When/Project/Assignee/Template/Tags pickers, the
// steps + recurrence + attachments editors, the timeline/report views, and the
// status action bar (actionsFor). Titles/labels via textContent only; notes and
// reports render through md.js (escaped).
import Sortable from '/vendor/sortable.core.esm.js';
import { api, state, reload, toast, todayISO, currentActor,
  uploadAttachment, attachmentObjectURL, attachmentText, linkDoc, getConfig } from '/app.js';
import { mdToHtml } from '/md.js';
import { icon } from '/icons.js';
import { dueShort } from '/dates.js';
import { assigneeField } from '/suggest.js';
import { openManageDialog, performDelete } from '/views.js';

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

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

// ---- when: Today | date | Someday | Clear ----
// When as ONE calendar control (icon→value pattern, like Due). Unset = a bare
// calendar icon; set = a pill of the value (Today / mm/dd / Someday). Both open
// the shared #whenpick-dialog.
export function whenLabel(t) {
  if (t.when_type === 'someday') return 'Someday';
  if (t.when_type === 'date' && t.when_date) {
    return t.when_date === todayISO() ? 'Today' : dueShort(t.when_date);
  }
  return null;
}

// Populate + open the shared When picker, binding to a task's apply(fields)->bool
// and a render() callback. Quick actions (Today/Someday/Clear) and a date pick
// each apply then close; Done just closes. Reused by the drawer and the inline row.
export function openWhenPicker(initial, apply, render) {
  const dlg = document.getElementById('whenpick-dialog');
  const date = document.getElementById('whenpick-date');
  date.value = (initial.when_type === 'date' && initial.when_date) ? initial.when_date : todayISO();
  const set = async (fields) => { if (await apply(fields)) render(); dlg.open = false; };
  document.getElementById('whenpick-today').onclick = () => set({ when_type: 'date', when_date: todayISO() });
  document.getElementById('whenpick-someday').onclick = () => set({ when_type: 'someday' });
  document.getElementById('whenpick-clear').onclick = () => set({ when_type: null });
  date.onchange = () => set({ when_type: 'date', when_date: date.value || null });
  document.getElementById('whenpick-done').onclick = () => { render(); dlg.open = false; };
  dlg.open = true;
}

// ---- project — icon→value pattern (drawer only) ----
// Unset (Inbox / no project): a bare folder icon. Set: a pill of folder + the
// project name. Both open #project-dialog, which lists the non-archived projects
// as selectable rows plus a "(none — Inbox)" choice and a "Manage…" action.
export function projectLabel(t) {
  const p = state.projects.find(pr => pr.id === t.project_id);
  return p ? p.name : null;
}

// Populate + open the shared project picker. apply(fields)->bool, render() repaints.
export function openProjectPicker(initialId, apply, render) {
  const dlg = document.getElementById('project-dialog');
  const list = document.getElementById('project-dialog-list');
  list.replaceChildren();
  const pick = async id => { if (await apply({ project_id: id })) render(); dlg.open = false; };
  const rows = [{ id: null, name: '(none — Inbox)' }, ...state.projects.filter(p => !p.archived)];
  for (const p of rows) {
    const b = el('button', 'picker-row' + ((initialId ?? null) === p.id ? ' sel' : ''), p.id ? undefined : p.name);
    b.type = 'button';
    if (p.id) { b.append(icon('folder', { size: 15 }), el('span', 'pill-text', p.name)); }
    b.addEventListener('click', () => pick(p.id));
    list.append(b);
  }
  // "Manage…" opens the shared tree-admin dialog; a project created there is
  // selected on return
  document.getElementById('project-dialog-manage').onclick = async () => {
    dlg.open = false;
    const { createdId } = await openManageDialog();
    if (createdId) await apply({ project_id: createdId });
    render();
  };
  document.getElementById('project-dialog-cancel').onclick = () => { dlg.open = false; };
  dlg.open = true;
}

// ---- assignee — value pill → dialog (drawer + inline) ----
// Assignee ALWAYS has a value, so there is no unset icon: always a pill of the
// per-actor glyph (claude/hermes, else a person) + a friendly name ("Me" for the
// current actor). The dialog hosts the shared segmented field (Me | Claude |
// Hermes) + the delegate auto-close toggle.
export function assigneeGlyph(who) {
  return (who === 'claude' || who === 'hermes') ? who : 'user';
}
export function assigneeLabel(who) {
  return (!who || who === currentActor()) ? 'Me' : who;
}

// Host the shared assigneeField in #assignee-dialog; repaint the pill on close.
export function openAssigneePicker(task, save, render) {
  const dlg = document.getElementById('assignee-dialog');
  const mount = document.getElementById('assignee-dialog-mount');
  mount.replaceChildren(assigneeField(task, save));
  document.getElementById('assignee-dialog-done').onclick = () => { dlg.open = false; };
  const onHide = e => { if (e.target !== dlg) return; dlg.removeEventListener('wa-after-hide', onHide); render(); };
  dlg.addEventListener('wa-after-hide', onHide);
  dlg.open = true;
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

// Host a template chooser in #template-dialog: "(none)" + each template name as
// a picker row (a stale/unlisted stamped template stays selectable). Selecting
// applies it and closes; repaints the pill on close.
export function openTemplatePicker(task, save, render) {
  const dlg = document.getElementById('template-dialog');
  const mount = document.getElementById('template-dialog-mount');
  const build = (items, canEdit) => {
    mount.replaceChildren();
    // rows are a container div (choose-button + optional AI-edit pencil sibling)
    // so the pencil is never a nested <button> inside the choose <button>.
    const mk = (label, value, sel, editable) => {
      const rowEl = el('div', 'picker-row-wrap' + (sel ? ' sel' : ''));
      const choose = el('button', 'picker-row-choose', label);
      choose.type = 'button';
      choose.addEventListener('click', async () => { if (await save({ template: value })) render(); dlg.open = false; });
      rowEl.append(choose);
      if (editable && canEdit) {
        const pen = el('button', 'picker-row-edit');
        pen.type = 'button';
        pen.append(icon('pencil-simple', { size: 14 }));
        pen.title = `Edit "${value}" with AI`;
        pen.setAttribute('aria-label', `Edit template ${value} with AI`);
        pen.addEventListener('click', async e => {
          e.stopPropagation();
          const { openTemplateEditor } = await import('/tpleditor.js');
          openTemplateEditor(value);
        });
        rowEl.append(pen);
      }
      mount.append(rowEl);
    };
    mk('(none)', null, !task.template, false);
    const names = new Set(items.map(t => t.name));
    for (const tpl of items) mk(tpl.name, tpl.name, task.template === tpl.name, true);
    if (task.template && !names.has(task.template)) mk(`${task.template} (unlisted)`, task.template, true, true);
  };
  // the AI-edit pencil now lives HERE (per template row), gated by the same
  // template_editing config probe — not on the task detail page.
  Promise.all([loadTemplates(), getConfig()]).then(([items, cfg]) => build(items, !!cfg.template_editing));
  document.getElementById('template-dialog-done').onclick = () => { dlg.open = false; };
  dlg.open = true;
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

// ---- collapsed Timeline: a compact SVG sparkline of activity over time ----
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};
const dayNum = iso => Math.floor(Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`) / 86400000);

// A horizontal axis with a dot per activity (dd day-label under each unique day),
// small vertical month ticks with month names, and TODAY drawn as a thin ring
// around a small dot. Dates are grouped by calendar day; a narrow range is padded
// so a single day still reads. Returns an <svg> that scales to the container width.
function buildSparkline(items, todayIso) {
  const W = 400, PADX = 26, BASE = 42, PLOT = W - 2 * PADX;
  const svg = svgEl('svg', { class: 'tl-svg', viewBox: `0 0 ${W} 70`, role: 'img', 'aria-label': 'Activity timeline' });
  const todayN = dayNum(todayIso);
  const days = items.map(cm => dayNum(cm.created_at)).filter(n => !Number.isNaN(n));
  let lo = Math.min(todayN, ...(days.length ? days : [todayN]));
  let hi = Math.max(todayN, ...(days.length ? days : [todayN]));
  if (hi - lo < 6) { const mid = (hi + lo) / 2; lo = Math.floor(mid - 3); hi = Math.ceil(mid + 3); }
  const xOf = d => PADX + ((d - lo) / (hi - lo)) * PLOT;

  svg.append(svgEl('line', { x1: PADX, y1: BASE, x2: W - PADX, y2: BASE, class: 'tl-axis' }));

  // month ticks + labels: each month-start day that falls in [lo,hi]
  const start = new Date(lo * 86400000);
  let m = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  for (let guard = 0; guard < 60; guard++) {
    const dn = Math.floor(m.getTime() / 86400000);
    if (dn > hi) break;
    if (dn >= lo) {
      const x = xOf(dn);
      svg.append(svgEl('line', { x1: x, y1: BASE - 7, x2: x, y2: BASE + 7, class: 'tl-month-tick' }));
      const t = svgEl('text', { x, y: 15, class: 'tl-month-label', 'text-anchor': 'middle' });
      t.textContent = m.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
      svg.append(t);
    }
    m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
  }

  // activity dots (+ one dd label per unique day)
  const labelled = new Set();
  const ddLabel = (dn, cls) => {
    if (labelled.has(dn)) return;
    labelled.add(dn);
    const t = svgEl('text', { x: xOf(dn), y: BASE + 17, class: `tl-day-label${cls || ''}`, 'text-anchor': 'middle' });
    t.textContent = String(new Date(dn * 86400000).getUTCDate());
    svg.append(t);
  };
  // one dot per DAY (multiple events on a day collapse to a single dot with a
  // small count above it)
  const byDay = new Map();
  for (const cm of items) {
    const dn = dayNum(cm.created_at);
    if (!Number.isNaN(dn)) byDay.set(dn, (byDay.get(dn) || 0) + 1);
  }
  const countBadge = (dn, count) => {
    if (count <= 1) return;
    const t = svgEl('text', { x: xOf(dn), y: BASE - 9, class: 'tl-count', 'text-anchor': 'middle' });
    t.textContent = String(count);
    svg.append(t);
  };
  for (const [dn, count] of byDay) {
    if (dn === todayN) continue; // today is drawn as a ring below
    svg.append(svgEl('circle', { cx: xOf(dn), cy: BASE, r: 3, class: 'tl-dot' }));
    countBadge(dn, count);
    ddLabel(dn);
  }
  // today: thin ring + small solid dot (+ a count above if there were several)
  const tx = xOf(todayN);
  svg.append(svgEl('circle', { cx: tx, cy: BASE, r: 6, class: 'tl-today-ring' }));
  svg.append(svgEl('circle', { cx: tx, cy: BASE, r: 2.3, class: 'tl-today-dot' }));
  countBadge(todayN, byDay.get(todayN) || 0);
  ddLabel(todayN, ' tl-today-label');
  return svg;
}

export function timelineSection(task) {
  const wrap = el('div', 'timeline');

  // collapsible header (default collapsed → shows the sparkline). Persisted.
  const KEY = 'av-tasks-tl-collapsed';
  let collapsed = (() => { try { return localStorage.getItem(KEY) !== '0'; } catch { return true; } })();
  const header = el('button', 'tl-toggle');
  header.type = 'button';
  const caret = icon('caret-down', { size: 18, cls: 'tl-caret' });
  header.append(caret, el('span', 'tl-title', 'Timeline'));

  const spark = el('div', 'tl-spark');
  const listEl = el('div', 'tl-list');
  let items = [];

  const applyState = () => {
    header.classList.toggle('collapsed', collapsed);
    header.setAttribute('aria-expanded', String(!collapsed));
    spark.hidden = !collapsed || !items.length;
    listEl.hidden = collapsed;
    composer.hidden = collapsed;
  };
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch { /* private mode */ }
    applyState();
  });

  const load = async () => {
    try { items = (await api('GET', `/tasks/${task.id}/comments`)).items; }
    catch (e) { items = []; listEl.replaceChildren(el('div', 'tl-empty', `Couldn't load timeline: ${e.message}`)); return; }
    listEl.replaceChildren();
    if (!items.length) listEl.append(el('div', 'tl-empty', 'No activity yet.'));
    else for (const cm of items) listEl.append(timelineEntry(cm));
    spark.replaceChildren(buildSparkline(items, todayISO()));
    applyState();
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
      reload(); // refresh the row comment count in the background
    } catch (e) { toast(`Comment failed: ${e.message}`); }
    finally { post.removeAttribute('loading'); }
  };
  post.addEventListener('click', submit);
  composer.append(ta, post);
  wrap.append(header, spark, listEl, composer);
  applyState();
  load();
  return wrap;
}

// agent's report (markdown, safe renderer) — shown for review/done delegated work
export function reportView(task) {
  if (!task.report) return null;
  const wrap = el('div');
  wrap.append(el('label', null, 'Report'));
  const bodyEl = el('div', 'report-body notes-preview');
  bodyEl.innerHTML = mdToHtml(task.report); // mdToHtml escapes ALL input
  wrap.append(bodyEl);
  return wrap;
}

// ---- attachments: images (jpg/png) + documents (md/txt uploads + local links) ----
const ACCEPT = '.md,.txt,image/png,image/jpeg';
const objectUrls = new Set(); // revoked on each repaint to avoid leaks

const isImageAtt = att => att.mime === 'image/png' || att.mime === 'image/jpeg';
const isDocAtt = att => att.mime === 'text/markdown' || att.mime === 'text/plain';
const isDropDoc = f => /\.(md|markdown|txt)$/i.test(f.name);
const isDropImage = f => f.type === 'image/png' || f.type === 'image/jpeg';

// current retention rule → the selector value the card should show
function retentionValue(att) {
  if (att.expires_at) return 'expires';
  return att.retention === 'on_done' ? 'on_done' : 'keep';
}

// ---- attachments — icon→count pill → dialog (drawer only) ----
// Unset (0): a bare paperclip icon. Set: a pill of paperclip + count. Both open
// #attachments-dialog, which hosts the full grid + "Attach file" + drag-drop.
// The count comes from task.attachment_count, refreshed after add/delete.
export function attachmentsEditor(task) {
  const wrap = el('div', 'meta-field');
  const btn = el('button', 'meta-icon-btn');
  btn.type = 'button';
  btn.append(icon('paperclip', { size: 15 }));
  btn.setAttribute('aria-label', 'Add attachments');
  btn.title = 'Add attachments';
  const pill = el('button', 'meta-pill');
  pill.type = 'button';
  pill.title = 'Manage attachments';

  const render = () => {
    const n = task.attachment_count || 0;
    if (n > 0) {
      pill.replaceChildren(icon('paperclip', { size: 13 }), el('span', 'pill-text', String(n)));
      pill.hidden = false;
      btn.hidden = true;
    } else {
      pill.hidden = true;
      btn.hidden = false;
    }
  };
  const open = () => openAttachmentsPicker(task, render);
  btn.addEventListener('click', open);
  pill.addEventListener('click', open);
  render();
  wrap.append(btn, pill);
  return labeled('Attachments', wrap);
}

function openAttachmentsPicker(task, onCount) {
  const dlg = document.getElementById('attachments-dialog');
  const mount = document.getElementById('attachments-dialog-mount');
  mount.replaceChildren(buildAttachmentsPanel(task, onCount));
  document.getElementById('attachments-dialog-done').onclick = () => { dlg.open = false; };
  dlg.open = true;
}

// The attachment grid + "Attach file" + "Link a doc…" + drag-drop machinery,
// hosted inside #attachments-dialog. refresh() keeps task.attachment_count and
// the collapsed pill (onCount) in sync after each load/add/delete.
function buildAttachmentsPanel(task, onCount = () => {}) {
  const wrap = el('div', 'attachments');

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = ACCEPT;
  input.multiple = true;
  input.className = 'att-input';
  input.id = 'att-input';

  const trigger = el('button', 'att-add');
  trigger.append(icon('plus', { size: 16 }), el('span', null, 'Attach file'));
  trigger.type = 'button';
  trigger.addEventListener('click', () => input.click());

  // "Link a doc…" — only when the server has document roots configured
  const linkBtn = el('button', 'att-add att-link-add');
  linkBtn.append(icon('link', { size: 16 }), el('span', null, 'Link a doc…'));
  linkBtn.type = 'button';
  linkBtn.hidden = true;
  getConfig().then(cfg => { linkBtn.hidden = !cfg.doc_linking; });

  const grid = el('div', 'att-grid');
  const drop = el('div', 'att-drop');
  const actions = el('div', 'att-actions');
  actions.append(trigger, linkBtn);
  drop.append(actions, input, grid);

  const refresh = async () => {
    for (const u of objectUrls) URL.revokeObjectURL(u);
    objectUrls.clear();
    grid.replaceChildren();
    // learn which actors are untrusted (gates doc rendering) once per refresh
    try { _untrustedActors = (await getConfig()).untrusted_actors || []; } catch { /* keep prior */ }
    let items;
    try { items = (await api('GET', `/tasks/${task.id}/attachments`)).items; }
    catch (e) { grid.append(el('div', 'att-empty', `Couldn't load attachments: ${e.message}`)); return; }
    task.attachment_count = items.length; // keep the collapsed pill truthful
    onCount();
    if (!items.length) { grid.append(el('div', 'att-empty', 'No attachments yet.')); return; }
    for (const att of items) {
      grid.append(isDocAtt(att) ? docRow(att, refresh) : attachmentCard(att, refresh));
    }
  };

  const doUpload = async files => {
    const ok = [...files].filter(f => isDropImage(f) || isDropDoc(f));
    if (!ok.length) { if (files.length) toast('Only images (PNG/JPEG) and documents (.md/.txt) are supported'); return; }
    for (const f of ok) {
      try { await uploadAttachment(task.id, f); }
      catch (e) { toast(`Upload failed: ${e.message}`); }
    }
    await refresh();
    reload(); // refresh the row attachment count in the background
  };

  linkBtn.addEventListener('click', async () => {
    const path = prompt('Absolute path to a local .md or .txt document:');
    if (!path || !path.trim()) return;
    const title = prompt('Title (optional):') || undefined;
    try { await linkDoc(task.id, path.trim(), title && title.trim()); await refresh(); reload(); }
    catch (e) { toast(`Link failed: ${e.message}`); }
  });

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

// ---- document attachment row: file-text icon + name + View; uploads carry a
// retention selector, links carry a "linked" badge + the path (no retention). ----
function docRow(att, refresh) {
  const row = el('div', 'att-doc');
  const isLink = att.kind === 'link';

  const head = el('div', 'att-doc-head');
  head.append(icon('file-text', { size: 18, cls: 'att-doc-icon' }));
  const nameCol = el('div', 'att-doc-namecol');
  nameCol.append(el('div', 'att-doc-name', att.filename));
  if (isLink) {
    const badge = el('span', 'att-linked-badge');
    badge.append(icon('link', { size: 12 }), el('span', null, 'linked'));
    nameCol.append(badge);
    if (att.path) nameCol.append(el('div', 'att-doc-path', att.path));
  }
  head.append(nameCol);

  const view = el('button', 'att-doc-view');
  const untrusted = !isLink && isUntrustedActor(att.created_by);
  view.append(icon('eye', { size: 15 }), el('span', null, untrusted ? 'View (untrusted source)' : 'View'));
  view.type = 'button';
  if (untrusted) view.classList.add('att-doc-untrusted');
  view.addEventListener('click', () => openDocViewer(att, { untrusted }));
  head.append(view);
  row.append(head);

  // retention selector for uploaded docs only (links carry no bytes / retention)
  if (!isLink) row.append(docRetentionRow(att));

  const del = el('button', 'att-del att-doc-del');
  del.append(icon('trash', { size: 16 }));
  del.type = 'button';
  del.title = isLink ? 'Remove link' : 'Delete document';
  del.setAttribute('aria-label', `${isLink ? 'Remove link to' : 'Delete'} ${att.filename}`);
  del.addEventListener('click', async () => {
    try { await api('DELETE', `/attachments/${att.id}`); await refresh(); reload(); }
    catch (e) { toast(`Delete failed: ${e.message}`); }
  });
  row.append(del);
  return row;
}

function docRetentionRow(att) {
  const sel = document.createElement('select');
  sel.className = 'att-retention';
  for (const [v, label] of [['keep', 'Keep'], ['on_done', 'Delete when done'], ['expires', 'Expire…']]) {
    const o = el('option', null, label); o.value = v; sel.append(o);
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
  const rr = el('div', 'att-retention-row');
  rr.append(sel, dateInput);
  return rr;
}

// Is this actor one the server flags as untrusted? (docs they upload render only
// behind an explicit confirm — the same quarantine model as untrusted tasks.)
// Populated lazily from /config on the first attachments refresh — NOT at module
// load, which would call getConfig() before app.js finishes initializing.
let _untrustedActors = [];
function isUntrustedActor(actor) { return !!actor && _untrustedActors.includes(actor); }

// ---- rendered-document viewer (nested wa-drawer) ----
function openDocViewer(att, { untrusted = false } = {}) {
  const drawerEl = document.getElementById('doc-viewer');
  const body = document.getElementById('doc-viewer-body');
  drawerEl.label = att.filename || 'Document';
  body.replaceChildren();

  const render = async () => {
    body.replaceChildren();
    body.append(el('div', 'doc-loading', 'Loading…'));
    let text;
    try { text = await attachmentText(att.id); }
    catch (e) { body.replaceChildren(el('div', 'doc-error', `Couldn't load: ${e.message}`)); return; }
    body.replaceChildren();
    const doc = el('div', 'doc-rendered');
    if (att.mime === 'text/plain') {
      const pre = document.createElement('pre');
      pre.className = 'doc-plain';
      pre.textContent = text; // escaped by textContent — preformatted plain text
      doc.append(pre);
    } else {
      // md.js escapes ALL input; this is the only innerHTML sink here and is safe
      doc.innerHTML = mdToHtml(text);
    }
    body.append(doc);
  };

  if (untrusted) {
    const gate = el('div', 'doc-gate');
    gate.append(icon('shield-warning', { size: 32, cls: 'doc-gate-icon' }));
    gate.append(el('p', 'doc-gate-msg',
      `This document was uploaded by "${att.created_by}", an untrusted source. ` +
      `Only view it if you trust its contents.`));
    const go = el('button', 'doc-gate-btn');
    go.type = 'button';
    go.append(el('span', null, 'View anyway'));
    go.addEventListener('click', render);
    gate.append(go);
    body.append(gate);
  } else {
    render();
  }
  drawerEl.open = true;
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

  const del = el('button', 'att-del');
  del.append(icon('trash', { size: 16 }));
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

// ---- tags — icon→value pill → dialog ----
// No tags yet: a bare tag-icon button. Set: a pill of the tag icon + the names
// joined by ", " (or "N tags" past 3). Both open #tags-dialog, which hosts the
// shared chips + suggestion-popover field (suggest.js) for editing; the pill
// repaints from the task's tags on close.
export function tagsLabel(t) {
  const tags = Array.isArray(t.tags) ? t.tags : [];
  if (!tags.length) return null;
  return tags.length > 3 ? `${tags.length} tags` : tags.join(', ');
}

// A tag PICKER for the dialog: every existing tag shown as a toggle chip
// (selected = on the task), plus an add-a-new-tag row. Clicking a chip
// adds/removes it; typing + Add (or Enter) creates a new tag and applies it.
// `save({tags})` persists; `onChange` repaints the collapsed pill.
function buildTagPicker(task, save, onChange) {
  const box = el('div', 'tag-picker');
  let tags = [...(task.tags ?? [])];
  const has = name => tags.some(t => t.toLowerCase() === name.toLowerCase());

  const list = el('div', 'tag-picker-list');
  const paint = () => {
    list.replaceChildren();
    const all = (state.tags ?? []).map(t => t.name);
    const names = [...new Set([...all, ...tags])].sort((a, b) => a.localeCompare(b));
    if (!names.length) { list.append(el('div', 'att-empty', 'No tags yet — add one below.')); return; }
    for (const name of names) {
      const on = has(name);
      const chip = el('button', 'chip tag tag-choice' + (on ? ' sel' : ''), `#${name}`);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(on));
      chip.addEventListener('click', async () => {
        const next = on ? tags.filter(t => t.toLowerCase() !== name.toLowerCase()) : [...tags, name];
        if (await save({ tags: next })) { tags = next; paint(); onChange(); }
      });
      list.append(chip);
    }
  };

  const addRow = el('div', 'tag-add-row');
  const input = el('input', 'tag-add-input');
  input.type = 'text';
  input.placeholder = 'New tag…';
  input.autocomplete = 'off';
  const addBtn = el('button', 'wa-primary tag-add-btn', 'Add');
  addBtn.type = 'button';
  const doAdd = async () => {
    const v = input.value.trim().replace(/^#/, '');
    input.value = '';
    if (!v || has(v)) return;
    const next = [...tags, v];
    if (await save({ tags: next })) { tags = next; reload(); paint(); onChange(); }
  };
  addBtn.addEventListener('click', doAdd);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
  addRow.append(input, addBtn);

  box.append(list, addRow);
  paint();
  return box;
}

// Host the tag picker in #tags-dialog; repaint the pill on close.
export function openTagsPicker(task, save, render) {
  const dlg = document.getElementById('tags-dialog');
  const mount = document.getElementById('tags-dialog-mount');
  mount.replaceChildren(buildTagPicker(task, save, render));
  document.getElementById('tags-dialog-done').onclick = () => { dlg.open = false; };
  const onHide = e => { if (e.target !== dlg) return; dlg.removeEventListener('wa-after-hide', onHide); render(); };
  dlg.addEventListener('wa-after-hide', onHide);
  dlg.open = true;
}

// ---- steps checklist (shared with the inline row editor) ----
// Every mutation writes THROUGH to task.steps (task === the live state.tasks
// row), so the in-memory task stays truthful and a reopened drawer/list is never
// stale. onChange() lets the host surface repaint the affected surfaces (the
// drawer passes a background reload so the list row's step indicator + review
// card update immediately; the inline card omits it — a mid-edit reload would
// tear down the open card, and its collapse already re-syncs). This is the fix
// for the review-lane bug where step edits saved but the UI didn't reflect them.
export function stepsEditorFor(task, { onChange } = {}) {
  if (!Array.isArray(task.steps)) task.steps = [];
  const notify = () => { try { onChange?.(); } catch { /* repaint is best-effort */ } };
  const wrap = el('div');
  wrap.append(el('label', null, 'Steps'));
  const ul = el('ul', 'steps-list');

  const stepRow = step => {
    const li = el('li', 'step-row');
    li.dataset.sid = step.id;
    // no drag-grip gutter — the step uses the full width; reorder is press-and-hold
    // on the row (Sortable delay below), matching the task-row pattern.
    const check = el('button', 'check' + (step.done ? ' checked' : ''));
    check.setAttribute('aria-label', 'Toggle step');
    check.addEventListener('click', async () => {
      check.classList.toggle('checked');
      const done = check.classList.contains('checked');
      try {
        await api('PATCH', `/tasks/${task.id}/steps/${step.id}`, { done });
        step.done = done ? 1 : 0; // write through to the live task
        notify();
      } catch (e) { check.classList.toggle('checked'); toast(`Save failed: ${e.message}`); }
    });
    const name = el('input');
    name.type = 'text';
    name.value = step.title;
    name.addEventListener('change', async () => {
      if (!name.value.trim()) { name.value = step.title; return; }
      const title = name.value.trim();
      try {
        await api('PATCH', `/tasks/${task.id}/steps/${step.id}`, { title });
        step.title = title;
        notify();
      } catch (e) { toast(`Save failed: ${e.message}`); }
    });
    const del = el('button', 'del');
    del.append(icon('x', { size: 14 }));
    del.setAttribute('aria-label', 'Delete step');
    del.addEventListener('click', async () => {
      try {
        await api('DELETE', `/tasks/${task.id}/steps/${step.id}`);
        li.remove();
        const i = task.steps.indexOf(step);
        if (i >= 0) task.steps.splice(i, 1);
        notify();
      } catch (e) { toast(`Delete failed: ${e.message}`); }
    });
    li.append(check, name, del);
    return li;
  };
  for (const s of task.steps) ul.append(stepRow(s));

  const ranks = new Map(task.steps.map(s => [s.id, s.rank]));
  new Sortable(ul, {
    animation: 150,
    delay: 250,           // press-and-hold to reorder; a quick tap focuses the field
    delayOnTouchOnly: false,
    filter: 'button',     // clicking the check/delete never starts a drag
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
        const moved = task.steps.find(s => s.id === sid);
        if (moved) { moved.rank = updated.rank; task.steps.sort((a, b) => a.rank - b.rank); }
        notify();
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
      task.steps.push(step); // write through to the live task
      ul.append(stepRow(step));
      add.value = '';
      notify();
    } catch (err) { toast(`Add failed: ${err.message}`); }
  });
  wrap.append(ul, add);
  return wrap;
}

// ---- recurrence: freq + params + anchor — icon-first affordance ----
// Unset: a bare repeat-icon button (the freq/params/anchor grid stays hidden
// until tapped — most tasks don't repeat, so it shouldn't cost a whole
// always-visible grid of buttons). Set: a compact "Daily" / "Every N days" /
// etc. pill with an x to stop repeating; tapping the pill reopens the grid to
// change it. Same underlying freq/params/anchor picker as before, just gated
// behind the icon/pill the way Things gates its per-field affordances.
// Repeat-rule editor. Parameterized on (task, save, onChange) so the drawer and
// the inline card share it. `applied` tracks the persisted rule locally (never
// re-reads task.recur) so it's immune to the drawer's current-reassignment; the
// segments self-render on every change, so no external rebuild is needed.
export function recurEditor(task, save, onChange = () => {}) {
  const wrap = el('div', 'recur-editor');
  let applied = task.recur ? { ...task.recur, days: [...(task.recur.days ?? [])] } : null;
  const draft = applied ? { ...applied, days: [...(applied.days ?? [])] } : { freq: null, anchor: 'due', n: 2, days: ['mon'], dom: 1 };
  if (draft.n == null) draft.n = 2;
  if (!draft.days?.length) draft.days = ['mon'];
  if (draft.dom == null) draft.dom = 1;

  const btn = el('button', 'meta-icon-btn');
  btn.type = 'button';
  btn.append(icon('arrow-counter-clockwise', { size: 15 }));
  btn.setAttribute('aria-label', 'Repeat');
  btn.title = 'Repeat';
  const pill = el('button', 'meta-pill recur-pill');
  pill.type = 'button';
  pill.title = 'Edit repeat';

  const summary = () => {
    const r = applied;
    if (!r) return '';
    if (r.freq === 'daily') return 'Daily';
    if (r.freq === 'every') return `Every ${r.n} days`;
    if (r.freq === 'weekly') return `Weekly: ${(r.days || []).join(', ')}`;
    if (r.freq === 'monthly') return `Monthly: day ${r.dom}`;
    return '';
  };
  const render = () => {
    if (applied) {
      pill.replaceChildren(icon('arrow-counter-clockwise', { size: 13 }), el('span', 'pill-text', summary()));
      pill.hidden = false; btn.hidden = true;
    } else { pill.hidden = true; btn.hidden = false; }
  };

  // persist the current draft (or clear). Local `applied` stays in sync so it's
  // immune to the drawer's current-reassignment.
  const persist = async () => {
    let fields;
    if (draft.freq === null) fields = { recur: null };
    else {
      const out = { freq: draft.freq, anchor: draft.anchor };
      if (draft.freq === 'every') out.n = Number(draft.n) || 1;
      if (draft.freq === 'weekly') out.days = draft.days;
      if (draft.freq === 'monthly') out.dom = Number(draft.dom) || 1;
      fields = { recur: out };
    }
    if (await save(task, fields)) { applied = fields.recur; render(); onChange(); }
  };

  // The picker lives in #recur-dialog and STAYS OPEN across selections — the
  // segments rebuild on each change so a multi-part rule can be completed (the
  // old inline body collapsed on the first pick).
  const open = () => {
    const dlg = document.getElementById('recur-dialog');
    const mount = document.getElementById('recur-dialog-mount');
    const build = () => {
      mount.replaceChildren();
      const freqSeg = el('div', 'seg');
      for (const [val, label] of [[null, 'None'], ['daily', 'Daily'], ['every', 'Every N'], ['weekly', 'Weekly'], ['monthly', 'Monthly']]) {
        const b = el('button', draft.freq === val ? 'on' : null, label);
        b.addEventListener('click', () => { draft.freq = val; persist(); build(); });
        freqSeg.append(b);
      }
      mount.append(labeled('Frequency', freqSeg));
      if (draft.freq === 'every') {
        const n = el('input'); n.type = 'number'; n.min = '1'; n.value = String(draft.n);
        n.addEventListener('change', () => { draft.n = n.value; persist(); });
        mount.append(labeled('Every N days', n));
      } else if (draft.freq === 'weekly') {
        const row = el('div', 'seg weekday-row');
        for (const d of WEEKDAYS) {
          const b = el('button', draft.days.includes(d) ? 'on' : null, d);
          b.addEventListener('click', () => {
            draft.days = draft.days.includes(d) ? draft.days.filter(x => x !== d) : [...draft.days, d];
            if (draft.days.length) { persist(); build(); }
          });
          row.append(b);
        }
        mount.append(labeled('On days', row));
      } else if (draft.freq === 'monthly') {
        const dom = el('input'); dom.type = 'number'; dom.min = '1'; dom.max = '31'; dom.value = String(draft.dom);
        dom.addEventListener('change', () => { draft.dom = dom.value; persist(); });
        mount.append(labeled('Day of month', dom));
      }
      if (draft.freq !== null) {
        const anchorSeg = el('div', 'seg');
        for (const [val, label] of [['due', 'On schedule (from due)'], ['completion', 'After completion']]) {
          const b = el('button', draft.anchor === val ? 'on' : null, label);
          b.addEventListener('click', () => { draft.anchor = val; persist(); build(); });
          anchorSeg.append(b);
        }
        mount.append(labeled('Anchor', anchorSeg));
      }
    };
    build();
    document.getElementById('recur-dialog-clear').onclick = async () => { draft.freq = null; await persist(); dlg.open = false; };
    document.getElementById('recur-dialog-done').onclick = () => { render(); dlg.open = false; };
    dlg.open = true;
  };

  btn.addEventListener('click', open);
  pill.addEventListener('click', open);
  render();
  wrap.append(btn, pill);
  return labeled('Repeat', wrap);
}

export function actionsFor(task, { save, onDone = () => {} } = {}) {
  const row = el('div', 'detail-actions');
  const primaryDoor = async (path, okMsg) => {
    try {
      const res = await api('POST', `/tasks/${task.id}${path}`);
      if (res.spawned_id) toast('Done — next occurrence scheduled', 'success');
      else if (okMsg) toast(okMsg, 'success');
      onDone();
      reload();
    } catch (e) { toast(`Failed: ${e.message}`); }
  };
  const complete = document.createElement('wa-button');
  complete.setAttribute('variant', 'brand');
  if (task.status === 'review') {
    complete.textContent = 'Approve';
    complete.addEventListener('click', () => primaryDoor('/approve', 'Approved'));
    const reopen = document.createElement('wa-button');
    reopen.setAttribute('appearance', 'plain');
    reopen.textContent = 'Reopen';
    reopen.addEventListener('click', async () => {
      const reason = (prompt('Reason for reopening (optional — leave blank to skip):') || '').trim();
      if (await save(task, reason ? { status: 'active', comment: reason } : { status: 'active' })) onDone();
    });
    row.append(reopen);
  } else if (task.status === 'done') {
    complete.textContent = 'Completed';
    complete.setAttribute('disabled', '');
  } else if (task.status === 'in_progress') {
    complete.textContent = `In progress (${task.assignee})`;
    complete.setAttribute('disabled', '');
  } else if (task.status === 'blocked') {
    // the real state transition (blocked -> active) lives in the answer box
    // above (inline.js's answerCard) — this bar stays informational so
    // "Complete" can't be mistaken for the way to unblock the task.
    complete.textContent = 'Waiting for your answer';
    complete.setAttribute('disabled', '');
  } else {
    complete.textContent = 'Complete';
    complete.addEventListener('click', () => primaryDoor('/complete'));
  }
  const archive = document.createElement('wa-button');
  archive.setAttribute('appearance', 'outlined');
  archive.textContent = task.status === 'archived' ? 'Unarchive' : 'Archive';
  archive.addEventListener('click', async () => {
    if (task.status === 'archived') { if (await save(task, { status: 'active' })) onDone(); return; }
    const id = task.id;
    const rowEl = document.querySelector(`.task-row[data-id="${CSS.escape(id)}"]`);
    const wait = (reducedMotion() || !rowEl) ? Promise.resolve()
      : new Promise(r => { rowEl.classList.add('removing'); setTimeout(r, 250); });
    try {
      const [updated] = await Promise.all([api('PATCH', `/tasks/${id}`, { status: 'archived' }), wait]);
      Object.assign(task, updated);
      onDone();
      reload();
    } catch (e) { rowEl?.classList.remove('removing'); toast(`Archive failed: ${e.message}`); }
  });
  const del = document.createElement('wa-button');
  del.setAttribute('variant', 'danger');
  del.setAttribute('appearance', 'plain');
  del.className = 'detail-delete';
  del.textContent = 'Delete';
  del.addEventListener('click', async () => { if (await performDelete(task)) onDone(); });
  row.append(complete, archive, del);
  return row;
}
