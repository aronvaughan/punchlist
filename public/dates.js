// dates.js — shared deadline-countdown helpers (views, inline editor, drawer).
// Pure date-only arithmetic on the UTC grid; unit-tested in test/dates.test.js.
const DAY = 86400000;
const URGENT_WINDOW = 7; // red when overdue, today, or within 7 days

export function daysBetween(fromISO, toISO) {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / DAY);
}

// chip text: "3d overdue" | "due today" | "in Nd"
export function dueCountdown(dueISO, todayISO) {
  const d = daysBetween(todayISO, dueISO);
  if (d < 0) return { text: `${-d}d overdue`, urgent: true };
  if (d === 0) return { text: 'due today', urgent: true };
  return { text: `in ${d}d`, urgent: d <= URGENT_WINDOW };
}

// drawer line: "Due Tue, Aug 25 — in 2 days"
export function dueLine(dueISO, todayISO) {
  const d = daysBetween(todayISO, dueISO);
  const s = n => (n === 1 ? '' : 's');
  const rel = d < 0 ? `${-d} day${s(-d)} overdue`
    : d === 0 ? 'due today'
    : `in ${d} day${s(d)}`;
  const fmt = new Date(`${dueISO}T00:00:00Z`).toLocaleDateString('en-US',
    { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return { text: `Due ${fmt} — ${rel}`, urgent: d <= URGENT_WINDOW };
}
