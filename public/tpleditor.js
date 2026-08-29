// tpleditor.js — conversational, AI-assisted template editor (admin-only).
// Opens the #tpl-editor-dialog shell (added in Task 6) and mounts a chat thread
// beside a LIVE rendered preview of the working draft. The draft + thread persist
// in localStorage keyed by the template name so a mid-edit close is recoverable;
// they're cleared on a successful save or an explicit revert.
//
// Integration notes (verified against the real app, not the plan's guesses):
//  - `el`/`icon` are NOT exported by app.js — `el` is defined locally here and
//    `icon` comes from /icons.js. Only `api`/`toast` come from /app.js.
//  - api(method, path, body) returns parsed JSON on 2xx and THROWS on non-2xx
//    with { status, body, message }. The 422 save response carries no `error`
//    field, so its validation text lives on `err.body.validation` (message is
//    just "HTTP 422"). doSave() reads it from there.
//  - dialogs open/close via `dialog.open = true/false` (Web Awesome).
import { api, toast } from '/app.js';
import { icon } from '/icons.js';
import { mdToHtml } from '/md.js';

// Local element helper: (tag, className, ...children) where a child may be a
// Node or a string (appended as text). Mirrors detail.js's `el` but accepts
// multiple children so the two-column layout can be built inline.
function el(tag, className, ...kids) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  for (const k of kids) {
    if (k == null) continue;
    n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return n;
}

// ---- localStorage draft persistence (all wrapped for private-mode safety) ----
const key = name => `pl.tpl-edit.${name}`;
function load(name) {
  try { return JSON.parse(localStorage.getItem(key(name))) || null; } catch { return null; }
}
function save(name, state) {
  try { localStorage.setItem(key(name), JSON.stringify(state)); } catch { /* private mode */ }
}
function clear(name) {
  try { localStorage.removeItem(key(name)); } catch { /* private mode */ }
}
// Is there a locally-persisted draft (edits not yet saved to disk)?
function hasLocalDraft(name) {
  try { return localStorage.getItem(key(name)) != null; } catch { return false; }
}

export async function openTemplateEditor(name) {
  const dialog = document.getElementById('tpl-editor-dialog');
  const mount = document.getElementById('tpl-editor-mount');
  if (!dialog || !mount) return;
  dialog.label = `Edit template: ${name}`;

  // Restore a stored draft/thread; otherwise fetch the on-disk template as the
  // starting draft. A restored draft means there are unsaved edits from before.
  let state = load(name);
  if (!state) {
    try {
      const { markdown } = await api('GET', `/templates/${encodeURIComponent(name)}`);
      state = { draft: markdown, messages: [] };
    } catch (e) {
      toast(`Couldn't load template: ${e.message}`);
      return;
    }
  }

  // ---- pieces ----
  const preview = el('div', 'tpl-preview');
  const thread = el('div', 'tpl-thread');
  const input = el('textarea', 'tpl-instruction');
  input.placeholder = 'Describe a change… (e.g. add a priority input; tighten the output shape) — ⌘/Ctrl+Enter to send';
  const unsaved = el('span', 'tpl-unsaved-dot');
  unsaved.title = 'Unsaved changes (kept locally until you Save)';
  const status = el('div', 'tpl-status');

  const renderPreview = () => { preview.innerHTML = mdToHtml(state.draft); }; // mdToHtml escapes ALL input — safe sink
  const renderThread = () => {
    thread.replaceChildren(...state.messages.map(m => el('div', `tpl-msg tpl-${m.role}`, m.content)));
    thread.scrollTop = thread.scrollHeight;
  };
  const markUnsaved = () => { unsaved.hidden = !hasLocalDraft(name); };

  // ---- one conversational turn: POST /ai-edit, update draft + thread ----
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.disabled = true;
    sendBtn.disabled = true;
    state.messages.push({ role: 'user', content: text });
    renderThread();
    try {
      const { reply, draft } = await api('POST', `/templates/${encodeURIComponent(name)}/ai-edit`,
        { draft: state.draft, messages: state.messages });
      state.draft = draft;
      state.messages.push({ role: 'assistant', content: reply || '(updated)' });
      save(name, state);            // autosave this turn (draft + thread)
      renderThread(); renderPreview(); markUnsaved();
    } catch (e) {
      state.messages.pop();         // drop the user turn we couldn't answer
      renderThread();
      toast(`AI edit failed: ${e.message}`);
    } finally {
      input.disabled = false; sendBtn.disabled = false; input.focus();
    }
  };

  // ---- save: POST /save; clears local draft + reports on success, surfaces the
  // 422 validation text (from err.body.validation) on an invalid draft ----
  const doSave = async () => {
    status.classList.remove('tpl-status-err', 'tpl-status-ok');
    status.textContent = 'Validating…';
    saveBtn.disabled = true;
    try {
      const res = await api('POST', `/templates/${encodeURIComponent(name)}/save`, { draft: state.draft });
      clear(name); markUnsaved();
      status.classList.add('tpl-status-ok');
      status.textContent = res.committed === false ? '✓ Saved (validated; not committed)' : '✓ Saved & committed';
      toast('Template saved', 'success');
    } catch (e) {
      status.classList.add('tpl-status-err');
      // 422: validation detail rides on err.body.validation (no `error` field, so
      // e.message is just "HTTP 422"). Fall back to the message for other errors.
      const detail = (e.body && e.body.validation) || e.message;
      status.textContent = `✗ ${detail}`;
    } finally {
      saveBtn.disabled = false;
    }
  };

  // ---- revert: drop the local draft, re-GET the on-disk template ----
  const revert = async () => {
    status.classList.remove('tpl-status-err', 'tpl-status-ok');
    try {
      const { markdown } = await api('GET', `/templates/${encodeURIComponent(name)}`);
      clear(name);
      state = { draft: markdown, messages: [] };
      renderPreview(); renderThread(); markUnsaved();
      status.textContent = 'Reverted to the saved template';
    } catch (e) {
      status.classList.add('tpl-status-err');
      status.textContent = `✗ ${e.message}`;
    }
  };

  // ---- controls ----
  const sendBtn = el('button', 'tpl-btn tpl-btn-primary', 'Send');
  sendBtn.type = 'button';
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  });
  const saveBtn = el('button', 'tpl-btn tpl-btn-primary', 'Save draft');
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', doSave);
  const revertBtn = el('button', 'tpl-btn', 'Revert to saved');
  revertBtn.type = 'button';
  revertBtn.addEventListener('click', revert);

  // ---- assemble ----
  const dot = el('span', 'tpl-dot-wrap');
  dot.append(unsaved, el('span', 'tpl-dot-label', 'draft'));
  const header = el('div', 'tpl-editor-header');
  header.append(dot, status);

  const threadCol = el('div', 'tpl-col tpl-thread-col');
  threadCol.append(el('div', 'tpl-col-head', 'Conversation'), thread);
  const previewCol = el('div', 'tpl-col tpl-preview-col');
  const previewHead = el('div', 'tpl-col-head');
  previewHead.append(icon('file-text', { size: 13 }), el('span', null, 'Live preview'));
  previewCol.append(previewHead, preview);
  const cols = el('div', 'tpl-cols');
  cols.append(threadCol, previewCol);

  const composer = el('div', 'tpl-composer');
  composer.append(input, sendBtn);
  const actions = el('div', 'tpl-actions');
  actions.append(saveBtn, revertBtn);

  mount.replaceChildren(header, cols, composer, actions);

  renderPreview(); renderThread(); markUnsaved();
  dialog.open = true;
  setTimeout(() => input.focus(), 50);
}
