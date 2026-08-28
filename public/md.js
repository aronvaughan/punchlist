// md.js — minimal markdown renderer. EVERYTHING is HTML-escaped first; the
// only markup in the output is what this file itself emits. Links allow
// http(s) hrefs only. Supported: # headings, paragraphs, **bold**, *italic*,
// `code`, [text](url), - / 1. lists, ``` code blocks.
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

// Render a run of consecutive non-heading, non-fence lines: an all-bullet run
// is a <ul>, an all-numbered run an <ol>, otherwise one <p>.
function renderSegment(lines) {
  if (lines.every(l => /^\s*[-*]\s+/.test(l))) {
    const items = lines.map(l => `<li>${inline(esc(l.replace(/^\s*[-*]\s+/, '')))}</li>`);
    return `<ul>${items.join('')}</ul>`;
  }
  if (lines.every(l => /^\s*\d+[.)]\s+/.test(l))) {
    const items = lines.map(l => `<li>${inline(esc(l.replace(/^\s*\d+[.)]\s+/, '')))}</li>`);
    return `<ol>${items.join('')}</ol>`;
  }
  return `<p>${inline(esc(lines.join('\n')))}</p>`;
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
      continue;
    }
    // Headings (# … ######) break a block into segments — a heading line emits
    // an <h1>–<h6>; the runs of lines around it render as list/paragraph. This
    // lets "## Title" glued to a list still produce a heading + a list.
    let run = [];
    const flush = () => { if (run.length) { out.push(renderSegment(run)); run = []; } };
    for (const line of lines) {
      const h = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
      if (h) { flush(); out.push(`<h${h[1].length}>${inline(esc(h[2]))}</h${h[1].length}>`); }
      else run.push(line);
    }
    flush();
  }
  return out.join('\n');
}
