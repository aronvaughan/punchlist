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

const VIEWS = {
  inbox: {
    where: `${LIVE} AND project_id IS NULL AND when_type IS NULL`, // derived (C5)
    keys: [`COALESCE(rank, ${BIG})`], dir: 'ASC',
  },
  today: {
    // status filter covers BOTH disjuncts (C1)
    where: `${LIVE} AND ((when_type = 'date' AND when_date <= :today) OR due_date <= :today)`,
    // manual today_rank first; arrivals (NULL) append after (C3, I11)
    keys: [`COALESCE(today_rank, ${BIG})`, `COALESCE(when_date, ${FAR})`, `COALESCE(rank, ${BIG})`],
    dir: 'ASC',
  },
  upcoming: {
    where: `${LIVE} AND when_type = 'date' AND when_date > :today`,
    keys: ['when_date', `COALESCE(rank, ${BIG})`], dir: 'ASC',
  },
  overdue: {
    where: `${LIVE} AND due_date < :today`, // strictly before (C6)
    keys: ['due_date', `COALESCE(rank, ${BIG})`], dir: 'ASC',
  },
  logbook: {
    where: `status = 'done'`,
    keys: [`COALESCE(completed_at, '')`], dir: 'DESC',
  },
  // no view: active tasks; when scoped to a project, section-ordered
  _default: {
    where: LIVE,
    keys: [SECTION, `COALESCE(rank, ${BIG})`], dir: 'ASC',
  },
};

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

export function taskWhere(view, { today, project, tag, q, limit = 100, cursor } = {}) {
  const def = view == null ? VIEWS._default : VIEWS[view];
  if (!def) throw new Error(`unknown view: ${view}`);
  const named = { today };
  const wheres = [def.where];
  const posArgs = [];

  if (project) { wheres.push('project_id = ?'); posArgs.push(project); }
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
  const cappedLimit = Math.min(Math.max(1, Number(limit) || 100), 500);
  const sql =
    `SELECT tasks.*, ${selectKeys} FROM tasks WHERE ${wheres.join(' AND ')}
     ORDER BY ${orderBy} LIMIT ?`;
  posArgs.push(cappedLimit);

  // node:sqlite supports named parameters mixed with anonymous ones poorly;
  // inline :today as a positional by substituting the marker with ? in order.
  const args = [];
  let idx = 0;
  const finalSql = sql.replace(/:today|\?/g, m => {
    if (m === ':today') { args.push(today); return '?'; }
    args.push(posArgs[idx++]);
    return '?';
  });
  return { sql: finalSql, args, keys: keyAliases };
}
