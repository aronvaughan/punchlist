'use strict';
// lint — deterministic prose checks a writing review runs before the adversary reads the text.
// `plt lint prose <file|->` — one line per hit, `file:line: rule — text`, exit 1 on any hit.
//
// Rules (all heuristics; the config under `writing:` tunes them, and every list defaults empty):
//   long-sentence      a sentence of more than 25 words
//   banned-word        a word from config.writing.banned (whole word, case-insensitive)
//   ticket-ref         config.writing.ticket_pattern (a regex) inside the comments of a code file
//                      (.js .ts .tsx .py), or anywhere in a test file — a tracker key in code is
//                      an internal reference the next reader cannot resolve
//   undefined-acronym  an ALL-CAPS token of three or more letters used before it is defined —
//                      `Long Form (ACRONYM)` or `ACRONYM (long form)` on first use;
//                      DEFAULT_KNOWN_ACRONYMS (CLI, JSON, YAML, ...) plus config.writing.known_acronyms
//                      list the ones that need no definition; a token also skips when it appears
//                      elsewhere in the same file in a non-all-caps form (emphasis, not an acronym)
//
// What counts as prose: every line of a text file outside fenced code blocks (inline code and
// URLs removed); for a code file, only its comments. The three prose rules run on that; ticket-ref
// runs on comments (code file) or the whole file (test file), never on a prose file.
const fs = require('fs');
const path = require('path');

const CODE_EXT = new Set(['.js', '.ts', '.tsx', '.py']);
const MAX_WORDS = 25;

// Common acronyms nobody defines on first use — shipped so a project's own README/docs are not
// flooded with false positives before config.writing.known_acronyms is ever set. The project's
// list is additive (merged, never replaces).
const DEFAULT_KNOWN_ACRONYMS = ['CLI', 'JSON', 'YAML', 'URL', 'URI', 'API', 'HTTP', 'HTTPS', 'ISO',
  'UTC', 'MIT', 'PR', 'CI', 'CD', 'SHA', 'UUID', 'HTML', 'CSS', 'SQL', 'TDD', 'OK', 'ID'];

function isCodeFile(file) { return CODE_EXT.has(path.extname(file || '').toLowerCase()); }
function isTestFile(file) {
  const base = path.basename(file || '');
  return /\.(test|spec)\.[a-z]+$/.test(base) || /(^|[\\/])(test|tests|__tests__)([\\/]|$)/.test(String(file || ''));
}

// ---- segments: { line, text } for the parts of the file the prose rules read ----

// A code file's comments: `//` (not the `//` of a URL) and `/* ... */` for JS/TS, `#` for Python.
function commentSegments(text, ext) {
  const lines = text.split('\n');
  const out = [];
  if (ext === '.py') {
    lines.forEach((l, i) => { const m = l.match(/(?:^|\s)#(.*)$/); if (m) out.push({ line: i + 1, text: m[1].trim() }); });
    return out;
  }
  let inBlock = false;
  lines.forEach((l, i) => {
    let rest = l;
    let buf = [];
    while (rest.length) {
      if (inBlock) {
        const end = rest.indexOf('*/');
        const chunk = end >= 0 ? rest.slice(0, end) : rest;
        buf.push(chunk.replace(/^\s*\*+\s?/, ''));
        if (end < 0) { rest = ''; break; }
        inBlock = false; rest = rest.slice(end + 2);
        continue;
      }
      const block = rest.indexOf('/*');
      const lineC = rest.search(/(?<!:)\/\//);
      if (block >= 0 && (lineC < 0 || block < lineC)) { inBlock = true; rest = rest.slice(block + 2); continue; }
      if (lineC >= 0) { buf.push(rest.slice(lineC + 2)); rest = ''; continue; }
      rest = '';
    }
    const t = buf.join(' ').trim();
    if (t) out.push({ line: i + 1, text: t });
  });
  return out;
}

// A text file's prose: outside ``` fences, with inline code and URLs blanked so their tokens are
// never read as words or acronyms.
function proseSegments(text) {
  const out = [];
  let fenced = false;
  text.split('\n').forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fenced = !fenced; return; }
    if (fenced) return;
    const t = l.replace(/`[^`]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ');
    out.push({ line: i + 1, text: t });
  });
  return out;
}

// Paragraphs: runs of consecutive non-blank segments; a heading or a list item starts its own.
function paragraphs(segments) {
  const out = [];
  let cur = null;
  for (const s of segments) {
    const blank = !s.text.trim();
    const starts = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?)/.test(s.text);
    if (blank) { cur = null; continue; }
    if (!cur || starts || s.line !== cur[cur.length - 1].line + 1) { cur = []; out.push(cur); }
    cur.push({ line: s.line, text: s.text.replace(/^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?)/, '') });
  }
  return out;
}

// ---- rules ----

function longSentences(segments) {
  const hits = [];
  for (const para of paragraphs(segments)) {
    // One string per paragraph, with an offset -> line table so a sentence reports the line it starts on.
    let joined = ''; const starts = [];
    for (const s of para) { starts.push({ at: joined.length, line: s.line }); joined += s.text.trim() + ' '; }
    const lineAt = (i) => { let l = starts[0].line; for (const s of starts) if (s.at <= i) l = s.line; return l; };
    const re = /[^.!?]+(?:[.!?]+|$)/g;
    let m;
    while ((m = re.exec(joined)) !== null) {
      const sentence = m[0].trim();
      if (!sentence) continue;
      const words = sentence.split(/\s+/).filter((w) => /\w/.test(w)).length;
      if (words > MAX_WORDS) hits.push({ rule: 'long-sentence', line: lineAt(m.index + (m[0].length - m[0].trimStart().length)), text: sentence });
    }
  }
  return hits;
}

function bannedWords(segments, banned) {
  const words = (banned || []).filter((w) => typeof w === 'string' && w.trim());
  if (!words.length) return [];
  const re = new RegExp('\\b(' + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'gi');
  const hits = [];
  for (const s of segments) {
    let m;
    while ((m = re.exec(s.text)) !== null) hits.push({ rule: 'banned-word', line: s.line, text: m[1] });
  }
  return hits;
}

function ticketRefs(segments, pattern) {
  if (!pattern) return [];
  const re = new RegExp(pattern, 'g');
  const hits = [];
  for (const s of segments) {
    let m;
    while ((m = re.exec(s.text)) !== null) { hits.push({ rule: 'ticket-ref', line: s.line, text: m[0] }); if (m[0] === '') re.lastIndex++; }
  }
  return hits;
}

// A token used elsewhere in the same file in a form that is not entirely upper-case (e.g.
// `PURELY` .. `purely`, or a title-cased heading like `License`) reads as an ordinary word
// capitalized for emphasis, not an acronym — cheap, reliable, no dictionary needed.
function hasNonCapsElsewhere(token, fullText) {
  if (!fullText) return false;
  const re = new RegExp('\\b' + token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
  let m;
  while ((m = re.exec(fullText)) !== null) {
    if (m[0] !== m[0].toUpperCase()) return true;
  }
  return false;
}

function undefinedAcronyms(segments, known, fullText) {
  const skip = new Set([...DEFAULT_KNOWN_ACRONYMS, ...(known || []).map(String)]);
  const seen = new Set();
  const hits = [];
  // Bare tokens only: `TRK-12` (a key), `ADR-style` (a compound) are not acronym uses.
  const re = /(?<![-\w])[A-Z]{3,}(?![-\w])/g;
  for (const s of segments) {
    let m;
    while ((m = re.exec(s.text)) !== null) {
      const tok = m[0];
      if (seen.has(tok) || skip.has(tok)) continue;
      seen.add(tok);
      const before = s.text.slice(0, m.index);
      const after = s.text.slice(m.index + tok.length);
      const defined = /^\s*\(/.test(after) || (/\($/.test(before) && /^\)/.test(after));
      if (defined) continue;
      if (hasNonCapsElsewhere(tok, fullText)) continue;
      hits.push({ rule: 'undefined-acronym', line: s.line, text: tok });
    }
  }
  return hits;
}

// lintProse(text, { file, config }) -> [{ file, line, rule, text }], in file order.
function lintProse(text, { file = '-', config = {} } = {}) {
  const writing = (config && config.writing) || {};
  const ext = path.extname(file).toLowerCase();
  const code = isCodeFile(file);
  const prose = code ? commentSegments(text, ext) : proseSegments(text);
  const hits = [...longSentences(prose), ...bannedWords(prose, writing.banned), ...undefinedAcronyms(prose, writing.known_acronyms, text)];
  if (code) {
    const scope = isTestFile(file) ? text.split('\n').map((t, i) => ({ line: i + 1, text: t })) : prose;
    hits.push(...ticketRefs(scope, writing.ticket_pattern));
  }
  const order = ['long-sentence', 'banned-word', 'ticket-ref', 'undefined-acronym'];
  hits.sort((a, b) => a.line - b.line || order.indexOf(a.rule) - order.indexOf(b.rule));
  return hits.map((h) => ({ file, ...h }));
}

function format(hits) { return hits.map((h) => `${h.file}:${h.line}: ${h.rule} — ${h.text}`); }

const USAGE = 'usage: plt lint prose <file|-> [--json]';

async function cli(args) {
  const [what, target] = args;
  const json = args.includes('--json');
  if (what !== 'prose' || !target || target.startsWith('--')) { process.stderr.write(USAGE + '\n'); return 2; }
  const text = target === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(target), 'utf8');
  let config = {};
  try {
    const spine = require('./spine');
    const p = process.env.PLT_PROCESS_DIR || spine.findProcessDir(process.cwd());
    if (p && fs.existsSync(path.join(p, 'config'))) config = spine.loadConfig(p);
  } catch (e) { config = {}; }
  const hits = lintProse(text, { file: target, config });
  if (json) process.stdout.write(JSON.stringify(hits, null, 2) + '\n');
  else if (hits.length) process.stdout.write(format(hits).join('\n') + '\n');
  return hits.length ? 1 : 0;
}

module.exports = { lintProse, format, cli, isCodeFile, isTestFile, MAX_WORDS, DEFAULT_KNOWN_ACRONYMS };
