// quickadd.js — pure token parser for POST /tasks/quickadd (the ONLY place
// token parsing lives; email content never goes through here).
// Tokens: #tag  @project  @"multi word"  !due  ^when  *recur
//   dates: YYYY-MM-DD | today | tomorrow | weekday name (strictly after today)
//   recur: *daily | *every:N | *weekly:d1,d2 | *monthly:DOM  [+completion]
// A recurrence without an explicit !due defaults due=today (design C4).

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseDate(word, todayISO) {
  const w = word.toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(word)) {
    const [y, m, d] = word.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
      throw new Error(`invalid date: ${word}`);
    }
    return word;
  }
  const base = new Date(`${todayISO}T00:00:00Z`);
  if (w === 'today') return todayISO;
  if (w === 'tomorrow') {
    base.setUTCDate(base.getUTCDate() + 1);
    return base.toISOString().slice(0, 10);
  }
  const idx = WEEKDAYS.findIndex(d => d === w || d.slice(0, 3) === w);
  if (idx >= 0) {
    let delta = (idx - base.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7; // strictly after today
    base.setUTCDate(base.getUTCDate() + delta);
    return base.toISOString().slice(0, 10);
  }
  throw new Error(`invalid date token: ${word}`);
}

function parseRecur(spec) {
  let anchor = 'due';
  if (spec.endsWith('+completion')) { anchor = 'completion'; spec = spec.slice(0, -'+completion'.length); }
  else if (spec.endsWith('+due')) { spec = spec.slice(0, -'+due'.length); }
  const [freq, arg] = spec.split(':', 2);
  switch (freq) {
    case 'daily':
      if (arg !== undefined) throw new Error('daily takes no argument');
      return { freq: 'daily', anchor };
    case 'every': {
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 1) throw new Error(`every: bad n "${arg}"`);
      return { freq: 'every', n, anchor };
    }
    case 'weekly': {
      const days = (arg || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const valid = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
      if (days.length === 0 || days.some(d => !valid.has(d))) throw new Error(`weekly: bad days "${arg}"`);
      return { freq: 'weekly', days, anchor };
    }
    case 'monthly': {
      const dom = Number(arg);
      if (!Number.isInteger(dom) || dom < 1 || dom > 31) throw new Error(`monthly: bad day-of-month "${arg}"`);
      return { freq: 'monthly', dom, anchor };
    }
    default:
      throw new Error(`invalid recurrence: ${freq}`);
  }
}

export function parse(text, { projects = [], today } = {}) {
  const todayISO = today || new Date().toISOString().slice(0, 10);
  const out = {};
  const tags = [];
  const titleParts = [];
  // tokens are whitespace-delimited; @"..." allows a quoted project name
  const tokens = text.match(/@"[^"]*"|\S+/g) || [];
  for (const tok of tokens) {
    if (tok.startsWith('#') && tok.length > 1) {
      tags.push(tok.slice(1));
    } else if (tok.startsWith('@') && tok.length > 1) {
      const name = tok.startsWith('@"') ? tok.slice(2, -1) : tok.slice(1);
      const proj = projects.find(p => p.name.toLowerCase() === name.toLowerCase());
      if (proj) out.project_id = proj.id;
      else titleParts.push(tok); // unknown project: leave it in the title
    } else if (tok.startsWith('!') && tok.length > 1) {
      out.due_date = parseDate(tok.slice(1), todayISO);
    } else if (tok.startsWith('^') && tok.length > 1) {
      const v = tok.slice(1);
      if (v.toLowerCase() === 'someday') out.when_type = 'someday';
      else { out.when_type = 'date'; out.when_date = parseDate(v, todayISO); }
    } else if (tok.startsWith('*') && tok.length > 1) {
      out.recur = parseRecur(tok.slice(1));
    } else {
      titleParts.push(tok);
    }
  }
  if (out.recur && !out.due_date) out.due_date = todayISO; // review C4
  out.title = titleParts.join(' ');
  if (tags.length) out.tags = tags;
  return out;
}
