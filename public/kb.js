// kb.js — a native "web notebook" over the instance private plane (data/). Reads
// the GET /kb/tree + /kb/file endpoints (admin-only, sandboxed, secrets excluded)
// and renders markdown through md.js (the XSS-safe sink). Read-only for now.
import { api, toast } from '/app.js';
import { mdToHtml } from '/md.js';
import { icon } from '/icons.js';

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export async function openKbBrowser() {
  const dlg = document.getElementById('kb-dialog');
  const treeEl = document.getElementById('kb-tree');
  const contentEl = document.getElementById('kb-content');
  if (!dlg || !treeEl || !contentEl) return;
  treeEl.replaceChildren(el('div', 'kb-hint', 'Loading…'));
  contentEl.replaceChildren();
  dlg.open = true;

  let data;
  try { data = await api('GET', '/kb/tree'); }
  catch (e) { toast(`KB load failed: ${e.message}`); dlg.open = false; return; }

  const openFile = async (path) => {
    contentEl.replaceChildren(el('div', 'kb-hint', 'Loading…'));
    let f;
    try { f = await api('GET', `/kb/file?path=${encodeURIComponent(path)}`); }
    catch (e) { contentEl.replaceChildren(el('div', 'kb-err', `Failed: ${e.message}`)); return; }
    contentEl.replaceChildren();
    contentEl.append(el('div', 'kb-filepath', path));
    if (/\.(md|markdown)$/i.test(path)) {
      const body = el('div', 'kb-md');
      body.innerHTML = mdToHtml(f.content);   // mdToHtml escapes ALL input — safe sink
      contentEl.append(body);
    } else {
      contentEl.append(el('pre', 'kb-pre', f.content)); // textContent — safe for json/txt/yaml
    }
  };

  const renderNodes = (nodes, container, depth) => {
    for (const n of nodes) {
      if (n.type === 'dir') {
        const d = el('details', 'kb-dir');
        d.open = depth < 1;
        const s = document.createElement('summary');
        s.append(icon('folder', { size: 13 }), el('span', null, n.name));
        d.append(s);
        const kids = el('div', 'kb-children');
        renderNodes(n.children || [], kids, depth + 1);
        d.append(kids);
        container.append(d);
      } else {
        const b = el('button', 'kb-file');
        b.type = 'button';
        b.append(icon('file-text', { size: 13 }), el('span', null, n.name));
        b.addEventListener('click', () => {
          treeEl.querySelectorAll('.kb-file.sel').forEach(x => x.classList.remove('sel'));
          b.classList.add('sel');
          openFile(n.path);
        });
        container.append(b);
      }
    }
  };

  treeEl.replaceChildren();
  if (!data.tree.length) treeEl.append(el('div', 'kb-hint', 'No instance notes yet — files under data/ (kb, templates, skills) show here.'));
  else renderNodes(data.tree, treeEl, 0);
  contentEl.replaceChildren(el('div', 'kb-hint', `Browsing instance data at ${data.root}. Select a file to read it.`));
}
