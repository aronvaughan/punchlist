// rank.js — fractional ordering. between(a, b) -> REAL strictly between its
// neighbors, or null when the float gap is exhausted (caller must call
// renormalize IN THE SAME TRANSACTION as the write that triggered it).

const SPACING = 1024;

export function between(a, b) {
  if (a === null && b === null) return SPACING;
  if (a === null) return b - SPACING;
  if (b === null) return a + SPACING;
  if (!(a < b)) return null;
  const mid = a + (b - a) / 2;
  if (!(mid > a && mid < b)) return null; // gap exhausted
  return mid;
}

// renormalize(db, {table, column='rank', where, args}) — rewrite the scoped
// rows' ranks to SPACING, 2*SPACING, ... preserving current order (NULLs
// last, id as tiebreak). Caller owns the transaction.
export function renormalize(db, { table, column = 'rank', where = '1=1', args = [] }) {
  if (!['tasks', 'steps', 'projects'].includes(table)) throw new Error(`bad table: ${table}`);
  if (!['rank', 'today_rank'].includes(column)) throw new Error(`bad column: ${column}`);
  const rows = db.prepare(
    `SELECT id FROM ${table} WHERE ${where}
     ORDER BY CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END, ${column}, id`
  ).all(...args);
  const upd = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
  rows.forEach((r, i) => upd.run((i + 1) * SPACING, r.id));
}
