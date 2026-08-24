import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysBetween, dueCountdown, dueLine } from '../public/dates.js';

const T = '2026-08-23';

test('daysBetween across month/DST boundaries', () => {
  assert.equal(daysBetween(T, T), 0);
  assert.equal(daysBetween(T, '2026-09-01'), 9);
  assert.equal(daysBetween(T, '2026-08-20'), -3);
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2); // US DST spring-forward
});

test('countdown boundaries: overdue / today / +1 / +7 urgent, +8 muted', () => {
  assert.deepEqual(dueCountdown('2026-08-20', T), { text: '3d overdue', urgent: true });
  assert.deepEqual(dueCountdown(T, T), { text: 'due today', urgent: true });
  assert.deepEqual(dueCountdown('2026-08-24', T), { text: 'in 1d', urgent: true });
  assert.deepEqual(dueCountdown('2026-08-30', T), { text: 'in 7d', urgent: true });
  assert.deepEqual(dueCountdown('2026-08-31', T), { text: 'in 8d', urgent: false });
  assert.deepEqual(dueCountdown('2026-10-01', T), { text: 'in 39d', urgent: false });
});

test('dueLine long form with weekday and pluralization', () => {
  assert.deepEqual(dueLine('2026-08-25', T), { text: 'Due Tue, Aug 25 — in 2 days', urgent: true });
  assert.deepEqual(dueLine('2026-08-24', T), { text: 'Due Mon, Aug 24 — in 1 day', urgent: true });
  assert.deepEqual(dueLine(T, T), { text: 'Due Sun, Aug 23 — due today', urgent: true });
  assert.deepEqual(dueLine('2026-08-22', T), { text: 'Due Sat, Aug 22 — 1 day overdue', urgent: true });
  assert.deepEqual(dueLine('2026-08-19', T), { text: 'Due Wed, Aug 19 — 4 days overdue', urgent: true });
  assert.equal(dueLine('2026-09-15', T).urgent, false);
});
