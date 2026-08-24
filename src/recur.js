// recur.js — pure recurrence engine + spawn.
// nextDue(rule, oldDueISO, completedISO, todayISO) -> ISO date.
//   anchor 'due':        first schedule tick STRICTLY AFTER max(oldDue, today)
//                        (always future; no same-day respawn).
//   anchor 'completion': tick relative to the completion DATE (strictly after).
// All arithmetic on UTC date-only values — immune to DST.
import { ulid } from './db.js';

const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function toUTC(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) throw new Error(`invalid ISO date: ${iso}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}
function fromUTC(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
const DAY = 86400000;

function clampDom(year, month /* 0-based */, dom) {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(dom, last));
}

function validate(rule) {
  if (!rule || typeof rule !== 'object') throw new Error('recur rule required');
  const { freq, anchor } = rule;
  if (anchor !== 'due' && anchor !== 'completion') throw new Error(`invalid anchor: ${anchor}`);
  switch (freq) {
    case 'daily':
      break;
    case 'every':
      if (!Number.isInteger(rule.n) || rule.n < 1) throw new Error('every: n must be a positive integer');
      break;
    case 'weekly':
      if (!Array.isArray(rule.days) || rule.days.length === 0 ||
          rule.days.some(d => !(d in WEEKDAYS))) throw new Error('weekly: days must be a non-empty list of weekday names');
      break;
    case 'monthly':
      if (!Number.isInteger(rule.dom) || rule.dom < 1 || rule.dom > 31) throw new Error('monthly: dom must be 1..31');
      break;
    default:
      throw new Error(`invalid freq: ${freq}`);
  }
}

// First tick of the rule's schedule strictly after `afterMs`.
// `originMs` seeds the grid for daily/every (due anchor keeps the grid;
// completion anchor uses the completion date itself as origin).
function firstTickAfter(rule, originMs, afterMs) {
  switch (rule.freq) {
    case 'daily':
    case 'every': {
      const step = (rule.freq === 'daily' ? 1 : rule.n) * DAY;
      const k = Math.floor((afterMs - originMs) / step) + 1;
      return originMs + Math.max(k, 1) * step;
    }
    case 'weekly': {
      const wanted = new Set(rule.days.map(d => WEEKDAYS[d]));
      for (let ms = afterMs + DAY; ; ms += DAY) {
        if (wanted.has(new Date(ms).getUTCDay())) return ms;
      }
    }
    case 'monthly': {
      const d = new Date(afterMs);
      let y = d.getUTCFullYear(), mo = d.getUTCMonth();
      let tick = clampDom(y, mo, rule.dom);
      while (tick <= afterMs) {
        mo += 1; if (mo > 11) { mo = 0; y += 1; }
        tick = clampDom(y, mo, rule.dom);
      }
      return tick;
    }
  }
}

export function nextDue(rule, oldDueISO, completedISO, todayISO) {
  validate(rule);
  if (rule.anchor === 'due') {
    if (!oldDueISO) throw new Error('due-anchored recurrence requires a due date');
    const oldDue = toUTC(oldDueISO);
    const after = Math.max(oldDue, toUTC(todayISO));
    return fromUTC(firstTickAfter(rule, oldDue, after));
  }
  const completed = toUTC(completedISO);
  return fromUTC(firstTickAfter(rule, completed, completed));
}

// spawn(db, task, nextDueISO, todayISO?) -> newTaskId
// Caller wraps in the completion transaction. Copies project, tags, steps
// (unchecked) and the delegation shape (assignee + auto_close — a recurring
// delegated chore stays delegated; claim/report start fresh); status active,
// when=nextDue (date), due=nextDue, rank at the end of the target (UPCOMING)
// section, spawned_from = old id.
export function spawn(db, task, nextDueISO, todayISO = new Date().toISOString().slice(0, 10)) {
  const id = ulid();
  const now = new Date().toISOString();
  // end of target section: after the last active dated-future task in scope
  const { m } = db.prepare(
    `SELECT MAX(rank) m FROM tasks
     WHERE status='active' AND project_id IS ? AND when_type='date' AND when_date > ?`
  ).get(task.project_id, todayISO);
  const rank = (m ?? 0) + 1024;
  db.prepare(
    `INSERT INTO tasks (id, title, notes, project_id, status, when_type, when_date,
                        due_date, due_time, rank, today_rank, recur, spawned_from,
                        created_by, completed_at, created_at, updated_at, assignee, auto_close)
     VALUES (?, ?, ?, ?, 'active', 'date', ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?)`
  ).run(id, task.title, task.notes, task.project_id, nextDueISO, nextDueISO,
        task.due_time, rank, task.recur, task.id, task.created_by, now, now,
        task.assignee, task.auto_close);
  const steps = db.prepare('SELECT title, rank FROM steps WHERE task_id = ? ORDER BY rank').all(task.id);
  const insStep = db.prepare('INSERT INTO steps (id, task_id, title, done, rank) VALUES (?, ?, ?, 0, ?)');
  for (const s of steps) insStep.run(ulid(), id, s.title, s.rank);
  const tags = db.prepare('SELECT tag_id FROM task_tags WHERE task_id = ?').all(task.id);
  const insTag = db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)');
  for (const t of tags) insTag.run(id, t.tag_id);
  return id;
}
