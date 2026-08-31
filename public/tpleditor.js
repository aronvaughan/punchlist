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
  const creating = !name;                 // no name → create a brand-new template
  dialog.label = creating ? 'New template' : `Edit template: ${name}`;

  // scope: where the template lives — 'instance' (private, default) or 'global'.
  let scope = 'instance';
  // Restore a stored draft/thread; otherwise fetch the on-disk template (edit) or
  // seed a valid frontmatter scaffold (create). A restored draft = unsaved edits.
  let state = creating ? null : load(name);
  if (!state) {
    if (creating) {
      state = { draft: '---\nname: my-template\nkind: template\n---\n\n## Purpose\n\nWhat this template is for.\n', messages: [] };
    } else {
      try {
        const { markdown, scope: s } = await api('GET', `/templates/${encodeURIComponent(name)}`);
        state = { draft: markdown, messages: [] };
        if (s) scope = s;
      } catch (e) {
        toast(`Couldn't load template: ${e.message}`);
        return;
      }
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

  // editable SOURCE (manual edit — the "UI does manual" half); the AI composer
  // below is the "improve with AI" half. Both drive state.draft.
  const source = el('textarea', 'tpl-source');
  source.value = state.draft;
  source.spellcheck = false;
  // scope: instance (private, default) | global (shared, committed)
  const scopeSel = el('select', 'tpl-scope');
  for (const [v, l] of [['instance', 'Instance (private)'], ['global', 'Global (shared)']]) {
    const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === scope) o.selected = true; scopeSel.append(o);
  }
  // name input, only when creating a new template
  const nameInput = el('input', 'tpl-name');
  nameInput.type = 'text'; nameInput.placeholder = 'template-name (a-z 0-9 -)'; nameInput.spellcheck = false; nameInput.autocapitalize = 'off';

  const renderPreview = () => { preview.innerHTML = mdToHtml(state.draft); }; // mdToHtml escapes ALL input — safe sink
  const syncSource = () => { source.value = state.draft; renderPreview(); };  // after AI/revert, refresh the editable source
  const renderThread = () => {
    thread.replaceChildren(...state.messages.map(m => el('div', `tpl-msg tpl-${m.role}`, m.content)));
    thread.scrollTop = thread.scrollHeight;
  };
  const markUnsaved = () => { unsaved.hidden = creating ? false : !hasLocalDraft(name); };
  source.addEventListener('input', () => {
    state.draft = source.value;
    renderPreview();
    if (!creating) save(name, state);   // autosave manual edits (edit mode keys by name)
    markUnsaved();
  });

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
      const aiName = creating ? (nameInput.value.trim() || 'new-template') : name;
      const { reply, draft } = await api('POST', `/templates/${encodeURIComponent(aiName)}/ai-edit`,
        { draft: state.draft, messages: state.messages });
      state.draft = draft;
      state.messages.push({ role: 'assistant', content: reply || '(updated)' });
      if (!creating) save(name, state);   // autosave this turn (draft + thread)
      renderThread(); syncSource(); markUnsaved();
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
    const saveName = creating ? nameInput.value.trim() : name;
    if (creating && !/^[a-z0-9-]+$/.test(saveName)) {
      status.classList.add('tpl-status-err');
      status.textContent = '✗ name must be a-z, 0-9 and hyphens';
      return;
    }
    status.classList.remove('tpl-status-err', 'tpl-status-ok');
    status.textContent = 'Validating…';
    saveBtn.disabled = true;
    try {
      const res = await api('POST', `/templates/${encodeURIComponent(saveName)}/save`, { draft: state.draft, scope: scopeSel.value });
      if (!creating) clear(saveName);
      markUnsaved();
      status.classList.add('tpl-status-ok');
      const where = res.scope === 'global' ? 'global' : 'instance';
      status.textContent = res.committed === false ? `✓ Saved to ${where} (validated)` : `✓ Saved to ${where} & committed`;
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
      syncSource(); renderThread(); markUnsaved();
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
  // create mode: a name field; both modes: the scope selector
  if (creating) header.append(el('span', 'tpl-field-label', 'Name'), nameInput);
  header.append(el('span', 'tpl-field-label', 'Scope'), scopeSel, dot, status);

  // left: editable source (manual); right: live preview
  const sourceCol = el('div', 'tpl-col tpl-source-col');
  sourceCol.append(el('div', 'tpl-col-head', 'Source (edit directly)'), source);
  const previewCol = el('div', 'tpl-col tpl-preview-col');
  const previewHead = el('div', 'tpl-col-head');
  previewHead.append(icon('file-text', { size: 13 }), el('span', null, 'Live preview'));
  previewCol.append(previewHead, preview);
  const cols = el('div', 'tpl-cols');
  cols.append(sourceCol, previewCol);

  // AI conversation (thread) + composer = the "improve with AI" pass
  const threadWrap = el('div', 'tpl-ai');
  threadWrap.append(el('div', 'tpl-col-head', '✨ Improve with AI'), thread);
  const composer = el('div', 'tpl-composer');
  composer.append(input, sendBtn);
  const actions = el('div', 'tpl-actions');
  actions.append(saveBtn);
  if (!creating) actions.append(revertBtn);

  mount.replaceChildren(header, cols, threadWrap, composer, actions);

  renderPreview(); renderThread(); markUnsaved();
  dialog.open = true;
  setTimeout(() => (creating ? nameInput : input).focus(), 50);
}
