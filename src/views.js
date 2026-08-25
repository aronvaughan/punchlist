// views.js — the single source of view semantics. taskWhere(view, params)
// builds the complete SELECT with parameter args ONLY — no string
// interpolation of user data, ever (invariant). Keyset pagination via
// coalesced sort-key expressions + base64url cursor.

const BIG = '9.0e18';           // stand-in for "null sorts last" on REAL ranks
const FAR = "'9999-12-31'";     // ditto for dates

// Section order inside a project: TODAY(0) UPCOMING(1) ANYTIME(2) SOMEDAY(3).
// A someday task keeps section SOMEDAY even when its due has arrived (C13).
const SECTION = `CASE
  WHEN when_type = 'date' AND when_date <= :today THEN 0
  WHEN when_type = 'date' THEN 1
  WHEN when_type IS NULL THEN 2
  ELSE 3 END`;

const LIVE = `status = 'active'`;
// delegation: in_progress/blocked/review tasks are still open work — project/
// tag/search views show them (with assignee chips); logbook stays done-only.
const OPEN = `status IN ('active', 'in_progress', 'blocked', 'review')`;
// Inbox/Upcoming are the HUMAN's lanes (delegation design): when-driven
// delegated work must not clutter the owner's day. But DUE-DATES OVERRIDE
// ASSIGNEE SCOPING (2026-08-24 amendment): a deadline is a deadline no matter
// whose plate it sits on — today's due disjunct, due_soon, and overdue include
// ALL assignees. Project/tag/search/logbook stay unscoped entirely.
// :admin = the admin (human) actor, bound at query time like :today.
const MINE = `assignee = :admin`;
// Agents view order inside one assignee: in_progress, then blocked (needs
// input), then review, then queued
const AGENT_STATUS = `CASE status WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 WHEN 'review' THEN 2 ELSE 3 END`;

const VIEWS = {
  inbox: {
    where: `${LIVE} AND ${MINE} AND project_id IS NULL AND when_type IS NULL`, // derived (C5)
    keys: [`COALESCE(rank, ${BIG})`], dir: 'ASC',
  },
  today: {
    // status filter covers BOTH disjuncts (C1). Assignee scoping covers only
    // the WHEN disjunct: an arrived when-date is the admin's plan, a due-date is a
    // deadline for everyone (due overrides assignee — 2026-08-24 amendment).
    where: `${LIVE} AND ((${MINE} AND when_type = 'date' AND when_date <= :today) OR due_date <= :today)`,
    // manual today_rank first; arrivals (NULL) append after (C3, I11)
    keys: [`COALESCE(today_rank, ${BIG})`, `COALESCE(when_date, ${FAR})`, `COALESCE(rank, ${BIG})`],
    dir: 'ASC',
  },
  upcoming: {
    where: `${LIVE} AND ${MINE} AND when_type = 'date' AND when_date > :today`,
    keys: ['when_date', `COALESCE(rank, ${BIG})`], dir: 'ASC',
  },
  overdue: {
    where: `${LIVE} AND due_date < :today`, // strictly before (C6)
    keys: ['due_date', `COALESCE(rank, ${BIG})`], dir: 'ASC',
  },
  due_soon: {
    // future deadlines inside the window (:soon = today + N days); due
    // today/overdue belong to the today/overdue views, not here. ALL
    // assignees: due overrides assignee scoping (2026-08-24 amendment)
    where: `${LIVE} AND due_date > :today AND due_date <= :soon`,
    keys: ['due_date', `COALESCE(rank, ${BIG})`], dir: 'ASC',
  },
  logbook: {
    where: `status = 'done'`,
    keys: [`COALESCE(completed_at, '')`], dir: 'DESC',
  },
  // delegation: everything awaiting the admin's approval, freshest finish first
  review: {
    where: `status = 'review'`,
    keys: ['updated_at'], dir: 'DESC',
  },
  // delegation: everything in flight off the admin's plate, grouped by agent
  // then status (in_progress → review → queued active)
  delegated: {
    where: `assignee <> :admin AND ${OPEN}`,
    keys: ['assignee', AGENT_STATUS, `COALESCE(rank, ${BIG})`], dir: 'ASC',
  },
  // needs-input: everything blocked on a question for the admin, oldest wait
  // first (updated_at is stamped when the task blocks)
  needs_input: {
    where: `status = 'blocked'`,
    keys: ['updated_at'], dir: 'ASC',
  },
  // agent work queue (agent-security layer 1): what an agent may pick up.
  // vetted=0 rows are EXCLUDED server-side — combined with the ?assignee=
  // filter this is the whole queue contract for pl.sh queue / MCP
  // punchlist_queue; the claim/finish doors enforce the same gate. Status-
  // scoped: blocked tasks stay out until the admin's answer re-activates them.
  queue: {
    where: `status IN ('active', 'in_progress') AND vetted = 1`,
    keys: [AGENT_STATUS, `COALESCE(rank, ${BIG})`], dir: 'ASC',
  },
  // quarantined arrivals: delegated work an agent will not execute until
  // the admin vets it (counts badge + Agents-view header line)
  unvetted: {
    where: `assignee <> :admin AND vetted = 0 AND ${OPEN}`,
    keys: ['assignee', `COALESCE(rank, ${BIG})`], dir: 'ASC',
  },
  // no view: open tasks; when scoped to a project, section-ordered
  _default: {
    where: OPEN,
    keys: [SECTION, `COALESCE(rank, ${BIG})`], dir: 'ASC',
  },
};

// COUNT(*) over a view's WHERE (no pagination cap) — single source for the
// nav-count endpoint. Project/tag/q filters don't apply here.
export function taskCount(view, { today, soon, admin } = {}) {
  const def = VIEWS[view];
  if (!def) throw new Error(`unknown view: ${view}`);
  const args = [];
  const sql = `SELECT COUNT(*) c FROM tasks WHERE ${def.where}`
    .replace(/:today|:soon|:admin/g, m => {
      args.push(m === ':today' ? today : m === ':soon' ? soon : admin);
      return '?';
    });
  return { sql, args };
}

export function escapeLike(s) {
  return s.replace(/[\\%_]/g, ch => '\\' + ch);
}

export function encodeCursor(row, keys) {
  const vals = keys.map(k => row[k]);
  vals.push(row.id);
  return Buffer.from(JSON.stringify(vals)).toString('base64url');
}

export function decodeCursor(cursor, nKeys) {
  let vals;
  try { vals = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { vals = null; }
  if (!Array.isArray(vals) || vals.length !== nKeys + 1 ||
      vals.some(v => typeof v !== 'string' && typeof v !== 'number')) {
    throw new Error('invalid cursor');
  }
  return vals;
}

export function taskWhere(view, { today, soon, admin, project, tag, q, assignee, limit = 100, cursor } = {}) {
  const def = view == null ? VIEWS._default : VIEWS[view];
  if (!def) throw new Error(`unknown view: ${view}`);
  const wheres = [def.where];
  const posArgs = [];

  if (project) { wheres.push('project_id = ?'); posArgs.push(project); }
  if (assignee) { wheres.push('assignee = ?'); posArgs.push(assignee); }
  if (tag) {
    wheres.push(`EXISTS (SELECT 1 FROM task_tags tt JOIN tags g ON g.id = tt.tag_id
                 WHERE tt.task_id = tasks.id AND g.name = ? COLLATE NOCASE)`);
    posArgs.push(tag);
  }
  if (q) {
    wheres.push(`(title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')`);
    const pat = `%${escapeLike(q)}%`;
    posArgs.push(pat, pat);
  }

  const keyAliases = def.keys.map((_, i) => `__k${i}`);
  const op = def.dir === 'ASC' ? '>' : '<';
  if (cursor) {
    const vals = decodeCursor(cursor, def.keys.length);
    const tuple = [...def.keys, 'id'].join(', ');
    wheres.push(`(${tuple}) ${op} (${vals.map(() => '?').join(', ')})`);
    posArgs.push(...vals);
  }

  const selectKeys = def.keys.map((k, i) => `${k} AS __k${i}`).join(', ');
  const orderBy = [...def.keys, 'id'].map(k => `${k} ${def.dir}`).join(', ');
  // cap at 501, not 500: api.js over-fetches lim+1 (lim <= 500) to detect the
  // next page — re-capping at 500 would swallow the probe row at limit=500 and
  // suppress next_cursor exactly at the documented max page size.
  const cappedLimit = Math.min(Math.max(1, Number(limit) || 100), 501);
  const sql =
    `SELECT tasks.*, ${selectKeys} FROM tasks WHERE ${wheres.join(' AND ')}
     ORDER BY ${orderBy} LIMIT ?`;
  posArgs.push(cappedLimit);

  // node:sqlite supports named parameters mixed with anonymous ones poorly;
  // inline :today/:soon/:admin as positionals by substituting each marker in order.
  const args = [];
  let idx = 0;
  const finalSql = sql.replace(/:today|:soon|:admin|\?/g, m => {
    if (m === ':today') { args.push(today); return '?'; }
    if (m === ':soon') { args.push(soon); return '?'; }
    if (m === ':admin') { args.push(admin); return '?'; }
    args.push(posArgs[idx++]);
    return '?';
  });
  return { sql: finalSql, args, keys: keyAliases };
}
