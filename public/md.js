// md.js — minimal markdown renderer. EVERYTHING is HTML-escaped first; the
// only markup in the output is what this file itself emits. Links allow
// http(s) hrefs only. Supported: paragraphs, **bold**, *italic*, `code`,
// [text](url), - / 1. lists, ``` code blocks.
export const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function inline(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

export function mdToHtml(src) {
  const out = [];
  const blocks = String(src ?? '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    if (lines.length === 0) continue;
    if (lines[0].startsWith('```')) {
      const code = block.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '');
      out.push(`<pre><code>${esc(code)}</code></pre>`);
    } else if (lines.every(l => /^\s*[-*]\s+/.test(l))) {
      const items = lines.map(l => `<li>${inline(esc(l.replace(/^\s*[-*]\s+/, '')))}</li>`);
      out.push(`<ul>${items.join('')}</ul>`);
    } else if (lines.every(l => /^\s*\d+[.)]\s+/.test(l))) {
      const items = lines.map(l => `<li>${inline(esc(l.replace(/^\s*\d+[.)]\s+/, '')))}</li>`);
      out.push(`<ol>${items.join('')}</ol>`);
    } else {
      out.push(`<p>${inline(esc(lines.join('\n')))}</p>`);
    }
  }
  return out.join('\n');
}
