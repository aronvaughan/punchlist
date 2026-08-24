// suggest.js — shared tags field: chips with x-remove + an add-input with a
// custom suggestion popover (replaces <datalist>, which is unreliable inside
// the inline card's animated overflow-hidden container). Used by both the
// inline row editor and the detail drawer.
// save(fields) -> Promise<boolean>; on success the field repaints itself.
import { state } from '/app.js';

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function tagsField(task, save) {
  let tags = [...(task.tags ?? [])];
  const box = el('div', 'tag-field');
  const chips = el('div', 'inline-tag-chips');
  const addWrap = el('div', 'tag-add-wrap');
  const input = el('input', 'inline-tag-add');
  input.type = 'text';
  input.placeholder = 'add tag…';
  input.autocomplete = 'off';
  const pop = el('div', 'tag-pop');
  pop.hidden = true;
  let items = [];
  let sel = -1;

  const paintChips = () => {
    chips.replaceChildren();
    for (const name of tags) {
      const chip = el('span', 'chip tag', `#${name}`);
      const x = el('button', 'chip-x', '✕');
      x.setAttribute('aria-label', `Remove tag ${name}`);
      x.addEventListener('click', async e => {
        e.stopPropagation();
        const next = tags.filter(t => t !== name);
        if (await save({ tags: next })) { tags = next; paintChips(); }
      });
      chip.append(x);
      chips.append(chip);
    }
  };

  const closePop = () => { pop.hidden = true; sel = -1; };

  const paintPop = () => {
    const q = input.value.trim().replace(/^#/, '').toLowerCase();
    const have = new Set(tags.map(t => t.toLowerCase()));
    items = (state.tags ?? []).map(t => t.name)
      .filter(n => !have.has(n.toLowerCase()) && (!q || n.toLowerCase().includes(q)))
      .slice(0, 8);
    pop.replaceChildren();
    if (!items.length) { closePop(); return; }
    items.forEach((name, i) => {
      const b = el('button', 'tag-pop-item' + (i === sel ? ' sel' : ''), `#${name}`);
      // pointerdown, not click: fires before the input's blur hides the popover
      b.addEventListener('pointerdown', e => { e.preventDefault(); addTag(name); });
      pop.append(b);
    });
    pop.hidden = false;
  };

  async function addTag(raw) {
    const v = String(raw).trim().replace(/^#/, '');
    if (!v) return;
    if (!tags.some(t => t.toLowerCase() === v.toLowerCase())) {
      const next = [...tags, v];
      if (!(await save({ tags: next }))) return;
      tags = next;
      paintChips();
    }
    input.value = '';
    closePop();
    input.focus();
  }

  input.addEventListener('input', () => { sel = -1; paintPop(); });
  input.addEventListener('focus', paintPop);
  input.addEventListener('blur', () => setTimeout(closePop, 150));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (pop.hidden) { paintPop(); }
      if (!items.length) return;
      e.preventDefault();
      sel = e.key === 'ArrowDown' ? (sel + 1) % items.length : (sel - 1 + items.length) % items.length;
      paintPop();
    } else if (e.key === 'Enter') {
      e.stopPropagation();
      addTag(sel >= 0 ? items[sel] : input.value);
    } else if (e.key === 'Escape') {
      // first Esc closes the popover only — never the card/drawer around it
      if (!pop.hidden) { e.stopPropagation(); closePop(); }
    }
  });

  paintChips();
  addWrap.append(input, pop);
  box.append(chips, addWrap);
  return box;
}
