'use strict';
// timing — the reduction from `kind: 'time'` events to elapsed per step. Each test
// names the wrong number it prevents, because every one of these produces a plausible
// figure when it is wrong, and a plausible wrong number is worse than an error.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../lib/timing');

const T = (iso) => Date.parse(iso);
const ev = (what, step, iso) => ({ kind: 'time', what, step, ts: iso });
const NOW = T('2026-09-29T12:00:00.000Z');

test('one span: elapsed is finish minus start', () => {
  const events = [ev('started', 'build', '2026-09-29T09:00:00Z'), ev('finished', 'build', '2026-09-29T10:30:00Z')];
  const by = t.elapsedByStep(events, { now: NOW });
  assert.equal(by.build.ms, 90 * 60000);
  assert.equal(by.build.spans, 1);
  assert.equal(by.build.open, false);
});

test('a repeated step sums EVERY pass, not just the last', () => {
  // The failure this prevents: a pr-loop that ran three times reporting the duration of
  // round three, which makes the slowest cards look like the fastest.
  // THE REAL SHAPE. spine.settle() writes `repeated` INSTEAD of `finished` and returns,
  // so a loop is started/repeated/started/repeated/started/finished. The first version of
  // this fixture had `finished, repeated`, which no spine writes — and that is exactly why
  // the test passed while three rounds reported the duration of one.
  const events = [
    ev('started', 'pr-loop', '2026-09-29T09:00:00Z'), ev('repeated', 'pr-loop', '2026-09-29T09:30:00Z'),
    ev('started', 'pr-loop', '2026-09-29T10:00:00Z'), ev('repeated', 'pr-loop', '2026-09-29T10:20:00Z'),
    ev('started', 'pr-loop', '2026-09-29T11:00:00Z'), ev('finished', 'pr-loop', '2026-09-29T11:10:00Z'),
  ];
  const by = t.elapsedByStep(events, { now: NOW });
  assert.equal(by['pr-loop'].spans, 3);
  assert.equal(by['pr-loop'].ms, (30 + 20 + 10) * 60000);
});

test('unstarted ENDS a span — an abandoned step does not keep running', () => {
  // Without this, a step started and abandoned yesterday reports a day of elapsed and
  // reads as the most expensive step on the board.
  const events = [ev('started', 'build', '2026-09-29T09:00:00Z'), ev('unstarted', 'build', '2026-09-29T09:15:00Z')];
  const by = t.elapsedByStep(events, { now: NOW });
  assert.equal(by.build.ms, 15 * 60000);
  assert.equal(by.build.open, false, 'not still running');
});

test('an open span is elapsed-to-now and says so', () => {
  const events = [ev('started', 'build', '2026-09-29T11:00:00Z')];
  const by = t.elapsedByStep(events, { now: NOW });
  assert.equal(by.build.ms, 60 * 60000);
  assert.equal(by.build.open, true, 'a running card must not read as finished');
});

test('a span across midnight is real elapsed, not negative and not a day', () => {
  const events = [ev('started', 'build', '2026-09-28T23:40:00Z'), ev('finished', 'build', '2026-09-29T00:10:00Z')];
  assert.equal(t.elapsedByStep(events, { now: NOW }).build.ms, 30 * 60000);
});

test('a backwards clock contributes zero, never a negative', () => {
  // One bad span must not subtract from the card's total and make a slow card look fast.
  const events = [ev('started', 'build', '2026-09-29T10:00:00Z'), ev('finished', 'build', '2026-09-29T09:00:00Z')];
  assert.equal(t.elapsedByStep(events, { now: NOW }).build.ms, 0);
});

test('a card with no time events is zero, not an error', () => {
  const by = t.elapsedByStep([], { now: NOW });
  assert.deepEqual(by, {});
  assert.equal(t.elapsedTotal(by), 0);
});

test('non-time events and other steps are ignored', () => {
  const events = [
    { kind: 'artifact', step: 'build', ts: '2026-09-29T09:00:00Z', name: 'x' },
    ev('started', 'scope', '2026-09-29T08:00:00Z'), ev('finished', 'scope', '2026-09-29T08:30:00Z'),
    ev('started', 'build', '2026-09-29T09:00:00Z'), ev('finished', 'build', '2026-09-29T09:10:00Z'),
    { kind: 'time', what: 'claimed', step: null, ts: '2026-09-29T07:00:00Z' },
  ];
  const by = t.elapsedByStep(events, { now: NOW });
  assert.equal(by.scope.ms, 30 * 60000);
  assert.equal(by.build.ms, 10 * 60000);
  assert.equal(Object.keys(by).length, 2, 'a step-less event makes no row');
});

test('rows follow the cycle order, and a step that has not run is present with zero', () => {
  // "has not started" and "took no time" are different facts; an absent row conflates
  // them and makes a stalled cycle look complete.
  const events = [ev('started', 'build', '2026-09-29T09:00:00Z'), ev('finished', 'build', '2026-09-29T09:10:00Z')];
  const rows = t.timingTable(events, { order: ['scope', 'build', 'review'], now: NOW });
  assert.deepEqual(rows.map((r) => r.step), ['scope', 'build', 'review']);
  assert.equal(rows[0].elapsed_ms, 0);
  assert.equal(rows[1].elapsed, '10m');
  assert.equal(rows[2].spans, 0);
});

test('durations read as hours and minutes', () => {
  assert.equal(t.humanMs(0), '0m');
  assert.equal(t.humanMs(45 * 60000), '45m');
  assert.equal(t.humanMs(90 * 60000), '1h 30m');
  assert.equal(t.humanMs(60 * 60000), '1h 00m');
  assert.equal(t.humanMs(-1), '—');
});

test('reduces a ledger in the exact shape the spine writes, with asserted numbers', () => {
  // The previous version of this test read process/runs/T1 — which is gitignored, so it
  // returned early in every clone and CI run, and its two assertions (ms >= 0, isFinite)
  // were guaranteed by Math.max(0, …) and could not fail on any input. A test that cannot
  // fail is not coverage.
  //
  // WHAT THIS FIXTURE IS, exactly, because the earlier comment here overclaimed. It is
  // ASSEMBLED from the event shapes lib/spine.js writes, not transcribed from a ledger on
  // disk. The step-bearing run — started/finished, an abandoned pass closed by `unstarted`
  // — is the shape a real ledger has. T1's own ledger carries exactly THREE step-less
  // lines, `claimed`, `recompiled` and `closed`, and all three are here; an earlier
  // version of this comment said two, which is the same overclaiming this test was
  // rewritten to stop. The trailing `landed` is the constructed part — no ledger under
  // process/runs/ carries a `landed` line yet — but its SHAPE is exact, and an earlier
  // version of this comment got that backwards. It claimed spine.js records `landed` with
  // a "LANDING DEFINITION id, never a cycle step", so that no real ledger could name
  // `merge`. It can and it must: landRun takes `def = wf.steps.find((s) => s.land_on)`,
  // which in build-and-ship IS the `merge` step, and starts and finishes it before writing
  // the event. `landed` therefore never invents a row; `landing-blocked` on a step the
  // landing never started is the event that can, and has its own test below. This line
  // earns its place for the single thing it pins — an event arriving after `finished` must
  // not reopen the span it follows.
  const events = [
    { kind: 'time', what: 'claimed', step: null, ts: '2026-09-29T08:00:00Z' },
    ev('started', 'scope', '2026-09-29T08:10:00Z'), ev('finished', 'scope', '2026-09-29T08:25:00Z'),
    ev('started', 'build', '2026-09-29T08:30:00Z'), ev('unstarted', 'build', '2026-09-29T08:35:00Z'),
    ev('started', 'build', '2026-09-29T09:00:00Z'),
    { kind: 'time', what: 'recompiled', step: null, ts: '2026-09-29T09:20:00Z', pin: null },
    ev('finished', 'build', '2026-09-29T09:45:00Z'),
    ev('started', 'merge', '2026-09-29T10:00:00Z'), ev('finished', 'merge', '2026-09-29T10:00:02Z'),
    ev('landed', 'merge', '2026-09-29T10:00:02Z'),
    // The real `closed` shape: step-less, human, and `retired` naming steps that have
    // ALREADY finished. It must close nothing, because there is nothing left open, and
    // above all must not reach back and re-end spans that ended properly.
    { kind: 'time', what: 'closed', step: null, ts: '2026-09-29T10:05:00Z', actor: 'human',
      retired: ['scope', 'build', 'merge', 'announce'], closed_as: 'done' },
    { kind: 'artifact', step: 'build', ts: '2026-09-29T09:40:00Z', name: 'pre-pr-summary' },
  ];
  const by = t.elapsedByStep(events, { now: NOW });
  assert.equal(by.scope.ms, 15 * 60000);
  assert.equal(by.build.ms, (5 + 45) * 60000, 'the abandoned pass counts, and ends');
  assert.equal(by.build.spans, 2);
  assert.equal(by.build.open, false);
  // `landed` arrives after `finished`, so no span is open for it to extend. The merge row
  // is the poll's own two seconds — NOT "PR open to PR merged", which no row answers.
  assert.equal(by.merge.ms, 2000);
  assert.equal(by.merge.open, false);
  assert.equal(Object.keys(by).length, 3, 'no step-less event makes a row');
  assert.equal(by.scope.spans, 1, 'the trailing `closed` adds no span to a finished step');
  assert.equal(by.merge.spans, 1);
  // `recompiled` is placed INSIDE build's second, open pass on purpose. It carries no
  // `retired` array, so it must not close that span: sited in the quiet gap between two
  // passes it would be inert whatever the code did, and would pin nothing.
  assert.equal(t.elapsedTotal(by), (15 + 50) * 60000 + 2000);
});

test('a loop still between rounds is NOT running, and has banked its rounds', () => {
  // The second wrong number the missing `repeated` produced: a step whose last event is
  // `repeated` is `ready`, not in progress, so reporting elapsed-to-now made an idle card
  // the most expensive on the board.
  const events = [
    ev('started', 'pr-loop', '2026-09-29T09:00:00Z'), ev('repeated', 'pr-loop', '2026-09-29T09:30:00Z'),
    ev('started', 'pr-loop', '2026-09-29T10:00:00Z'), ev('repeated', 'pr-loop', '2026-09-29T10:15:00Z'),
  ];
  const by = t.elapsedByStep(events, { now: NOW });
  assert.equal(by['pr-loop'].open, false, 'waiting between rounds is not running');
  assert.equal(by['pr-loop'].ms, 45 * 60000, 'both finished rounds are banked');
  assert.equal(by['pr-loop'].spans, 2);
});

test('a discarded card stops accruing — a step-less `discarded` closes the spans it retires', () => {
  // The other abandonment path, and the same wrong number `unstarted` exists to prevent.
  // discardRun sets EVERY non-done step to `skipped` — an in_progress one included — and
  // records { what: 'discarded', step: null, retired: [ids] }. With nothing to match on
  // `step`, the span never closed: a card discarded last week reported a week of elapsed,
  // still running, forever.
  const LATER = T('2026-10-06T12:00:00.000Z');
  const events = [
    ev('started', 'build', '2026-09-29T09:00:00Z'),
    { kind: 'time', what: 'discarded', step: null, ts: '2026-09-29T09:20:00Z', retired: ['build', 'review'] },
  ];
  const by = t.elapsedByStep(events, { now: LATER });
  assert.equal(by.build.ms, 20 * 60000, 'the span ends when the card was discarded');
  assert.equal(by.build.open, false, 'a discarded card is not running');

  // A step NOT named in `retired` is untouched, and a step-less event with no `retired`
  // array closes nothing — `claimed`, `polled` and `recompiled` must stay inert.
  const other = t.elapsedByStep([
    ev('started', 'build', '2026-09-29T09:00:00Z'),
    { kind: 'time', what: 'discarded', step: null, ts: '2026-09-29T09:20:00Z', retired: ['review'] },
    { kind: 'time', what: 'claimed', step: null, ts: '2026-09-29T09:30:00Z' },
  ], { now: LATER });
  assert.equal(other.build.open, true, 'this card was not discarded');
});

test('a normal close does not truncate a step that already finished', () => {
  // closeRun writes `{ what: 'closed', step: null, retired: [...] }` too, for ready and
  // pending steps. It must not reach back into a span that closed properly.
  const events = [
    ev('started', 'build', '2026-09-29T09:00:00Z'), ev('finished', 'build', '2026-09-29T09:10:00Z'),
    { kind: 'time', what: 'closed', step: null, ts: '2026-09-29T09:11:00Z', retired: ['announce', 'build'] },
  ];
  const by = t.elapsedByStep(events, { now: NOW });
  assert.equal(by.build.ms, 10 * 60000);
  assert.equal(by.build.spans, 1, 'no extra span from the close');
});

test('an annotative event makes no row — a step the landing never started is not a measured 0m', () => {
  // The invented row: `{ ms: 0, spans: 0 }` keyed for a step that HAS NOT RUN. landRun
  // stops with `needs not done` BEFORE stepStart, so it writes `{ what: 'landing-blocked',
  // step: 'merge' }` for a merge with no `started` anywhere. The step id on it is TRUE —
  // it names where the landing stopped — so the row must be dropped by the projection, not
  // the id by the writer.
  //
  // NO CALLER SURFACED THIS. render.js always passes an `order`, which overrides the key
  // set, and reads no per-step row anyway; see the MARKS comment in lib/timing.js, which
  // says the same thing. This test pins the reduction, not a page.
  const events = [
    ev('started', 'build', '2026-09-29T09:00:00Z'), ev('finished', 'build', '2026-09-29T09:30:00Z'),
    { kind: 'time', what: 'landing-blocked', step: 'merge', ts: '2026-09-29T09:31:00Z',
      reason: 'needs not done', finished: [], facts: { state: 'MERGED' } },
  ];
  const by = t.elapsedByStep(events, { now: NOW });
  assert.deepEqual(Object.keys(by), ['build'], 'merge never ran, so it has no row here');
  assert.equal(by.build.ms, 30 * 60000);
});

test('the same phantom reaches timingTable when no order is passed', () => {
  // timingTable falls back to the byStep keys when `order` is absent, so the invented row
  // becomes an invented ROW: `merge · 0m · 0 spans`. lib/render.js always passes an order,
  // so no page shows this — the earlier name for this test said "the table the swimlane
  // reads", and there is no such table: the swimlane is rulerFor(), which maps step
  // STATUSES and never calls timing at all.
  const events = [
    ev('started', 'build', '2026-09-29T09:00:00Z'), ev('finished', 'build', '2026-09-29T09:30:00Z'),
    { kind: 'time', what: 'landing-blocked', step: 'merge', ts: '2026-09-29T09:31:00Z', reason: 'needs not done' },
    { kind: 'time', what: 'taken-over', step: 'review', ts: '2026-09-29T09:32:00Z', from: 'aron' },
  ];
  const rows = t.timingTable(events, { now: NOW });
  assert.deepEqual(rows.map((r) => r.step), ['build'], 'only steps with spans are rows');
});

test('an annotative event on a step that DID run leaves its number alone', () => {
  // The other half of the same rule, and the reason the fix is a KEY filter rather than an
  // event filter: `landed` and `rearmed` name steps that really ran, and dropping those
  // rows would lose the merge step's own elapsed. Guard, not a discriminator — it passes
  // before the change as well, and is here so a wider filter cannot pass unnoticed.
  const events = [
    ev('started', 'merge', '2026-09-29T10:00:00Z'), ev('finished', 'merge', '2026-09-29T10:00:02Z'),
    ev('landed', 'merge', '2026-09-29T10:00:02Z'),
  ];
  const by = t.elapsedByStep(events, { now: NOW });
  assert.deepEqual(Object.keys(by), ['merge']);
  assert.equal(by.merge.ms, 2000);
});
