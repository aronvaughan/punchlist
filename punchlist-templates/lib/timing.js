'use strict';
// timing.js — elapsed per step, projected from the `kind: 'time'` events the ledger
// already writes.
//
// No new event kind and no `phase:` key on a step. `started`, `finished`, `unstarted`
// and `repeated` are already recorded with a step and a timestamp, so what was missing
// was never data — it was the reduction. A phase IS a step: the four points asked for
// map onto steps that already exist (planning → scope, coding → build, PR start →
// open-pr, PR end → merge), which is also why the swimlane ruler and this table are the
// same reduction shown two ways.
//
// WHAT THIS MEASURES: calendar elapsed while a step was OPEN, not effort, and not the
// whole wall clock either. Precisely:
//
//   INSIDE  — everything between a `started` and its end: overnight, a wait on CI, a
//             step sitting in_review while a gate is unattended.
//   OUTSIDE — the gap between one round ENDING (`repeated`) and the next `started`. So a
//             pr-loop that waits three days between rounds reports only the minutes each
//             round was actually open. Nothing records that wait today; a consumer that
//             needs "PR open to PR merged" must read the `open-pr` and `merge` timestamps
//             rather than sum these rows.
//
// It is the right measure for "how long was this step open" and the wrong one for "how
// much work was this", so every label says ELAPSED. A second reduction that subtracts blocked spans can come later; conflating
// them silently is how an estimate built on this becomes wrong.
const STARTS = 'started';
// `repeated` ENDS a span. spine.settle() writes `repeated` INSTEAD of `finished` and
// returns, so a real repeat_until step's ledger is
//   started, repeated, started, repeated, started, finished
// and never `finished, repeated`. Leaving it out cost two wrong numbers, both of which
// this module exists to prevent: three rounds of 30m/20m/10m reported 10m — the last pass
// only, because each new `started` replaced an unterminated span — and a loop between
// rounds reported elapsed-to-now and read as still running.
const ENDS = new Set(['finished', 'unstarted', 'repeated']);

// The events that OPEN or CLOSE a span, and so the only ones that make a step a row.
// elapsedByStep used to build its key set from "any `kind: 'time'` event with a truthy
// step", a WIDER vocabulary than the reduction underneath it, so an event that merely
// ANNOTATES a step keyed a row of its own: `{ ms: 0, spans: 0, open: false }`.
//
// lib/spine.js writes several such events, each naming its step truthfully while opening
// and closing nothing — `landed` and `landing-blocked` name the step the landing sequence
// reached, `rearmed` the step whose finish re-armed its dependents, `taken-over` the step
// held when a run changed hands. Receipts are a fifth shape and arrive by another road:
// integrations/claude/spine-stop.py calls `plt receipt --kind time`, which appends a
// `kind: 'time'` line carrying a `name` and NO `what` at all. A `what`-keyed filter
// happens to handle those correctly, but they are the reason to key on a positive list of
// span marks rather than to exclude a known-bad list of annotations.
//
// NOTHING PRINTED THE INVENTED ROW, and the first version of this comment claimed it did.
// lib/render.js is the only production caller; it passes `order = Object.keys(st.steps)`,
// which timingTable uses INSTEAD of these keys, and it reads only `elapsed_ms`, `spans`
// and `open` off the rows — there is no per-step timing table rendered anywhere yet. So
// this fix is prophylactic: it closes the case before a consumer calls elapsedByStep, or
// timingTable without an order, and gets a step that never ran back as a measured row.
// That is reason enough on its own and does not need a reader invented for it.
//
// MARKS is DERIVED from what spansFor reduces, not a second copy of it: spansFor reads
// STARTS and ENDS directly, and also closes spans from a step-less event whose `retired`
// names the step — a branch with no bearing on which steps are rows, since a retired step
// reached `retired` by having been started. Deriving is the point; a hand-written third
// list is how the key set drifted from the reduction in the first place.
const MARKS = new Set([STARTS, ...ENDS]);

function ms(ts) { const t = Date.parse(ts); return Number.isFinite(t) ? t : null; }

// spansFor(events, stepId) -> [{ start, end, open }]
// A step can run more than once: a `repeat_until` step re-opens, and an `unstarted` step
// can be started again. Every pass is its own span and they are summed, because a loop
// that ran three times took the time of all three.
function spansFor(events, stepId) {
  const out = [];
  let open = null;
  for (const e of events) {
    if (e.kind !== 'time') continue;
    const at = ms(e.ts);
    if (at === null) continue;

    // A STEP-LESS event can still end this step's span. discardRun sets every
    // non-done step to `skipped` — an in_progress one included — and records
    // `{ what: 'discarded', step: null, retired: [ids] }`. With nothing to match on
    // `step`, the span stayed open and a discarded card reported elapsed-to-now
    // forever: the same wrong number the `unstarted` branch below exists to prevent,
    // reached by the other abandonment path. `retired` names exactly the steps whose
    // spans should close, so it is the end event for each of them.
    if (e.step === null || e.step === undefined) {
      if (Array.isArray(e.retired) && e.retired.includes(stepId) && open !== null) {
        out.push({ start: open, end: at, open: false });
        open = null;
      }
      continue;
    }
    if (e.step !== stepId) continue;
    if (e.what === STARTS) {
      // A second `started` with no end between it and this one. With `repeated` in ENDS
      // the spine cannot produce that shape, so it means a hand-edited ledger: trust the
      // later start rather than invent an end for the earlier one. (This branch used to
      // swallow every round of a loop — see ENDS above.)
      open = at;
    } else if (ENDS.has(e.what) && open !== null) {
      // `unstarted` ends the span as surely as `finished` does. A step that was
      // started and then unstarted did NOT keep running from then until now, and
      // counting it as open is how an abandoned step reports days of elapsed.
      out.push({ start: open, end: at, open: false });
      open = null;
    }
  }
  if (open !== null) out.push({ start: open, end: null, open: true });
  return out;
}

// elapsedByStep(events, { now }) -> { <step>: { ms, spans, open } }
// `now` is injected so a test is not a race and an open span is reproducible.
function elapsedByStep(events, { now = Date.now() } = {}) {
  const steps = [];
  for (const e of events) {
    if (e.kind === 'time' && e.step && MARKS.has(e.what) && !steps.includes(e.step)) steps.push(e.step);
  }
  const out = {};
  for (const step of steps) {
    const spans = spansFor(events, step);
    let total = 0;
    let open = false;
    for (const s of spans) {
      const end = s.open ? now : s.end;
      // Clamp at zero: a clock that moved backwards must not subtract from the total.
      // Negative elapsed is never true, and one bad span would poison the whole card.
      total += Math.max(0, end - s.start);
      if (s.open) open = true;
    }
    out[step] = { ms: total, spans: spans.length, open };
  }
  return out;
}

// A card with no time events has zero elapsed, not an error: a card that was launched
// and never started is a legitimate state, and the roll-up has to be able to show it.
function elapsedTotal(byStep) {
  return Object.values(byStep).reduce((a, s) => a + s.ms, 0);
}

// Human duration. Hours and minutes, because the unit people ask this question in is
// "how long did that take" — never milliseconds, never a bare decimal of days.
function humanMs(v) {
  if (!Number.isFinite(v) || v < 0) return '—';
  const mins = Math.round(v / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${String(mins % 60).padStart(2, '0')}m`;
}

// timingTable(events, { order, now }) -> rows in the order the cycle runs. A step in
// `order` that has no row of its own is filled with `{ ms: 0, spans: 0, open: false }`
// rather than dropped, because an absent row makes a stalled cycle read as a complete one.
//
// WHAT CARRIES "NOT STARTED" IS `spans`, NOT the zero. The older wording here said the
// fill exists "because 'not started' and 'took no time' are different facts", which argues
// against itself: `elapsed_ms: 0` is the same number for both. `spans: 0` is what tells
// them apart, and it is exact — a step that ran and took under a second has `spans: 1`.
// render.js reads exactly that (`rows.filter((row) => row.spans > 0)`) and prints "no data"
// rather than "0m" when nothing ran, so the one consumer there is honors the distinction.
//
// The residual, named so the next consumer is not surprised by it: the `elapsed` STRING is
// `'0m'` for both cases, because humanMs(0) cannot know which it was handed. No caller
// prints a per-step row today, so nothing conflates them yet. A card that renders this
// table for a human is the card that should decide what a `spans: 0` row reads as — '—',
// 'not started', or a blank — with the actual page in front of it. Deciding it here, with
// no reader, is how the invented row above got its invented audience.
//
// (The swimlane is NOT this table shown another way, whatever the header of this file
// says: render.js's rulerFor() maps step STATUSES and never calls into timing.)
function timingTable(events, { order = null, now = Date.now() } = {}) {
  const byStep = elapsedByStep(events, { now });
  const ids = order && order.length ? order : Object.keys(byStep);
  return ids.map((step) => {
    const s = byStep[step] || { ms: 0, spans: 0, open: false };
    return { step, elapsed_ms: s.ms, elapsed: humanMs(s.ms), spans: s.spans, open: s.open };
  });
}

// timingTable is the exported name its callers use; do not rename it.
//
// NOT YET WIRED: there is no `plt effort timing` CLI. The exports below are what it needs.
module.exports = { spansFor, elapsedByStep, elapsedTotal, timingTable, humanMs };
