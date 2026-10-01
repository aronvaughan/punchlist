'use strict';
// digest — a daily/weekly rollup computed PURELY from every run's events.jsonl/state.yaml/
// inputs.yaml and efforts/*.yaml. No gh, no writes: `collectDigest` only reads. The `plt digest`
// CLI (lib/spine-cli.js) is what writes process/digests/<date>.json and prints the standup.
const fs = require('fs');
const path = require('path');
const spine = require('./spine');
const yaml = require('./yaml');

const DAY_MS = 24 * 60 * 60 * 1000;

const runIds = spine.runIds;   // one definition, in lib/spine.js beside readState/readEvents

// A step's assignee, from the run's own formula: `owner` reads as `human`, everything else (agent,
// or a step the formula no longer has) reads as `agent`. Never throws — a run whose cycle file has
// moved or was removed still gets its time counted, just as agent time.
function assigneeOf(processDir, state, stepId) {
  try {
    const wf = spine.loadFormula(processDir, state.cycle);
    const def = wf.steps.find((s) => s.id === stepId);
    return def && def.assignee === 'owner' ? 'human' : 'agent';
  } catch (e) {
    return 'agent';
  }
}

// The PR a run names, the same rule render.js uses: the latest receipt whose ref is a pull url,
// else `inputs.pr`/`inputs.pr_number`.
function prOf(events, inputs) {
  const ev = events.filter((e) => e.ref && /pull\/\d+/.test(String(e.ref))).pop();
  if (ev) { const m = String(ev.ref).match(/pull\/(\d+)/); return Number(m[1]); }
  if (inputs.pr_number !== undefined) return Number(inputs.pr_number);
  if (inputs.pr) {
    const m = String(inputs.pr).match(/pull\/(\d+)/) || String(inputs.pr).match(/^(\d+)$/);
    if (m) return Number(m[1]);
  }
  return null;
}

function inWindow(ts, from, to) { return Boolean(ts) && ts >= from && ts < to; }

// `estimation.actual.{from,to}` name an endpoint as `<step>.<started|finished>` (e.g. build.started).
function parseEndpoint(spec) {
  const m = String(spec || '').match(/^(.+)\.(started|finished)$/);
  return m ? { step: m[1], what: m[2] } : null;
}

// actualSpan(events, {from, to}) — hours from the FIRST `from` event to the LAST `to` event, or
// null (never 0) when either endpoint is absent or `to` is not after `from`. A run that never
// started its `from` step has no actual.
function actualSpan(events, { from, to }) {
  const a = parseEndpoint(from);
  const b = parseEndpoint(to);
  if (!a || !b) return null;
  const match = (ep) => (e) => e.kind === 'time' && e.what === ep.what && e.step === ep.step && e.ts;
  const start = events.filter(match(a)).map((e) => e.ts).sort()[0];
  const end = events.filter(match(b)).map((e) => e.ts).sort().pop();
  if (!start || !end || !(end > start)) return null;
  return (new Date(end).getTime() - new Date(start).getTime()) / 3600000;
}

// Hours per unit an actual may be reported in (`estimation.actual.unit`).
const ACTUAL_UNITS = { hours: 1, days: 24 };

// The span estimation.yaml declares, or null when it declares none. A malformed endpoint, a step
// that NO formula under process/cycles/ has, or a unit other than hours/days is an error naming the
// config key — a typo there would otherwise read as "every run is missing its actual".
function declaredSpan(processDir) {
  const actual = (spine.loadConfig(processDir).estimation || {}).actual;
  if (!actual) return null;
  const dir = path.join(processDir, 'cycles');
  const known = new Set();
  const cycles = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
  for (const f of cycles) {
    try { for (const s of spine.loadFormula(processDir, path.basename(f, '.md')).steps) known.add(s.id); } catch (e) { /* unreadable cycle: names nothing */ }
  }
  for (const key of ['from', 'to']) {
    const ep = parseEndpoint(actual[key]);
    if (!ep) throw new Error(`estimation.actual.${key}: "${actual[key]}" is not <step>.started or <step>.finished`);
    if (!known.has(ep.step)) throw new Error(`estimation.actual.${key}: step "${ep.step}" is in no formula under ${dir}`);
  }
  if (!Object.prototype.hasOwnProperty.call(ACTUAL_UNITS, actual.unit)) {
    throw new Error(`estimation.actual.unit: "${actual.unit === undefined ? '' : actual.unit}" is not hours or days`);
  }
  return { from: actual.from, to: actual.to, unit: actual.unit };
}

// Why a run has no actual, or null when it has one: no span declared, the run's own cycle lacks an
// endpoint step (e.g. a spike has no build), or the endpoint event never happened.
function actualMissing(processDir, state, events, span) {
  if (!span) return 'estimation.actual is not declared';
  let stepIds = null;
  try { stepIds = new Set(spine.loadFormula(processDir, state.cycle).steps.map((s) => s.id)); } catch (e) { stepIds = null; }
  for (const spec of [span.from, span.to]) {
    const ep = parseEndpoint(spec);
    if (stepIds && !stepIds.has(ep.step)) return `cycle ${state.cycle} has no step ${ep.step}`;
  }
  for (const spec of [span.from, span.to]) {
    const ep = parseEndpoint(spec);
    if (!events.some((e) => e.kind === 'time' && e.what === ep.what && e.step === ep.step)) return `no ${spec} event`;
  }
  return `${span.to} is not after ${span.from}`;
}

// Decisions are a snapshot of the CURRENT efforts/*.yaml, not window-scoped: an effort file has no
// per-day history, only a `status` a human edits in place. `age_days` is measured to `to` (the
// window's end — "as of" the report date) from the decision's own `since`/`opened` date; with
// neither, age is null (never derived from the file's mtime — that is not a recorded fact). Every
// decision carries the `effort` it belongs to (the file's own `slug:`, else its filename minus
// `.yaml`) — decision ids are only unique WITHIN an effort (two efforts can both have a `D-002`).
function readDecisions(processDir, to) {
  const settled = [];
  const open = [];
  const dir = path.join(processDir, 'efforts');
  if (!fs.existsSync(dir)) return { settled, open };
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.yaml')).sort()) {
    let e;
    try { e = yaml.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (err) { continue; }
    const effortSlug = (e && e.slug) || path.basename(f, '.yaml');
    for (const d of (e && e.decisions) || []) {
      if (!d || !d.id) continue;
      if (d.status === 'settled') { settled.push({ id: d.id, question: d.question || null, effort: effortSlug }); continue; }
      const since = d.since || d.opened || null;
      const age_days = since ? Math.floor((new Date(to).getTime() - new Date(since).getTime()) / DAY_MS) : null;
      open.push({ id: d.id, question: d.question || null, age_days, effort: effortSlug });
    }
  }
  return { settled, open };
}

// collectDigest(processDir, {from, to}) — PURE. from/to are ISO instants; the window is
// [from, to). See lib/spine.js for readEvents/readState/readInputs and efforts/*.yaml for decisions.
function collectDigest(processDir, { from, to }) {
  if (!from || !to) throw new Error('collectDigest needs {from, to} (ISO instants)');

  const runs = [];
  const byCategory = {};
  const byActor = { human: 0, agent: 0 };
  const gates = [];
  const extrapolations = [];
  const estimates = [];
  const reviews = [];
  const span = declaredSpan(processDir);

  for (const runId of runIds(processDir)) {
    const state = spine.readState(processDir, runId);
    if (!state) continue;
    const inputs = spine.readInputs(processDir, runId);
    const events = spine.readEvents(processDir, runId);
    const inWin = events.filter((e) => inWindow(e.ts, from, to));

    // ---- transitions (this run's row, only when something happened in the window) ----
    const transitions = inWin.filter((e) => e.kind === 'time' && (e.what === 'started' || e.what === 'finished'));
    if (transitions.length) {
      runs.push({
        id: runId,
        effort: inputs.effort || null,
        cycle: state.cycle || null,
        from_step: transitions[0].step || null,
        to_step: transitions[transitions.length - 1].step || null,
        transitions: transitions.length,
      });
    }

    // ---- time by category — pair started/finished over the FULL log, clip each pair to the window ----
    const byStep = new Map();
    for (const e of events) {
      if (e.kind !== 'time' || (e.what !== 'started' && e.what !== 'finished') || !e.step) continue;
      if (!byStep.has(e.step)) byStep.set(e.step, []);
      byStep.get(e.step).push(e);
    }
    const addHours = (s, f, stepId) => {
      if (!(f > s)) return;
      const hours = (new Date(f).getTime() - new Date(s).getTime()) / 3600000;
      byCategory[stepId] = (byCategory[stepId] || 0) + hours;
      byActor[assigneeOf(processDir, state, stepId)] += hours;
    };
    for (const [stepId, evs] of byStep) {
      evs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      let openStart = null;
      for (const e of evs) {
        if (e.what === 'started') { openStart = e.ts; continue; }
        if (e.what === 'finished' && openStart) {
          addHours(openStart > from ? openStart : from, e.ts < to ? e.ts : to, stepId);
          openStart = null;
        }
      }
      // A step still in progress at `to` (started, never finished) counts from max(started, from)
      // up to the window's end — it is doing real work through the window, not zero hours just
      // because it has not finished yet.
      if (openStart) addHours(openStart > from ? openStart : from, to, stepId);
    }

    // ---- gates ----
    for (const e of inWin) {
      if (e.kind === 'gate') gates.push({ run: runId, step: e.step, signal: e.name, by: e.by || null, at: e.ts });
    }

    // ---- extrapolations (the "nothing to flag" placeholder, missing.scope === 'none', is noise) ----
    for (const e of inWin) {
      if (e.kind !== 'extrapolation') continue;
      if (e.missing && e.missing.scope === 'none') continue;
      extrapolations.push({ run: runId, step: e.step, key: (e.missing && e.missing.key) || null, assumed: spine.assumedText(e.assumed) });
    }

    // ---- reviews: one row per review-activity event in the window ----
    for (const e of inWin) {
      if (e.kind === 'review-activity') reviews.push({ pr: prOf(events, inputs), step: e.step });
    }

    // ---- estimate vs actual: closed runs only, whose close fell inside the window ----
    // The actual is the span estimation.yaml declares (actual: {from, to, unit}), in that unit. The
    // estimate keeps its own unit: the two are shown side by side, never subtracted.
    if (state.status === 'closed' && state.estimate) {
      const closed = [...events].reverse().find((e) => e.kind === 'time' && e.what === 'closed');
      if (closed && inWindow(closed.ts, from, to)) {
        const hours = span ? actualSpan(events, span) : null;
        estimates.push({
          run: runId,
          estimate: { value: state.estimate.value, unit: state.estimate.unit || null },
          actual: hours === null ? null : { value: Math.round((hours / ACTUAL_UNITS[span.unit]) * 100) / 100, unit: span.unit },
          actual_missing: hours === null ? actualMissing(processDir, state, events, span) : null,
        });
      }
    }
  }

  return {
    runs,
    time: { by_category: byCategory, by_actor: byActor },
    gates,
    decisions: readDecisions(processDir, to),
    extrapolations,
    estimates,
    reviews,
  };
}

// ---- date helpers (UTC, so a fixed `--for <date>` collects the same window on any machine) ----

function dayWindow(dateStr) {
  const from = `${dateStr}T00:00:00.000Z`;
  const to = new Date(new Date(from).getTime() + DAY_MS).toISOString();
  return { from, to };
}

// The Monday..Friday (business week) of the ISO week containing `dateStr`.
function isoWeekdays(dateStr) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  const dow = d.getUTCDay() || 7;   // Mon=1..Sun=7
  const monday = new Date(d.getTime() - (dow - 1) * DAY_MS);
  const out = [];
  for (let i = 0; i < 5; i++) out.push(new Date(monday.getTime() + i * DAY_MS).toISOString().slice(0, 10));
  return out;
}

function isoWeekLabel(dateStr) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  const target = new Date(d.getTime());
  target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target - yearStart) / DAY_MS + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function sumInto(out, obj) { for (const [k, v] of Object.entries(obj || {})) out[k] = (out[k] || 0) + v; return out; }

// A run active across several days of the week appears ONCE: `daily` is chronological (Monday
// first), so the FIRST occurrence's `from_step` (the earliest day's start) is kept, every LATER
// occurrence's `to_step` overwrites it (the latest day's end), and `transitions` sums across days.
function mergeRuns(dailyRunLists) {
  const byId = new Map();
  for (const list of dailyRunLists) {
    for (const r of list) {
      const cur = byId.get(r.id);
      if (!cur) byId.set(r.id, { ...r });
      else { cur.to_step = r.to_step; cur.transitions += r.transitions; }
    }
  }
  return [...byId.values()];
}

// Merge N daily digest JSONs into one weekly digest: counters sum, `runs` dedupes (see
// `mergeRuns`), other lists concatenate, decisions take the LAST day's snapshot (it is a live
// snapshot, not a per-day series — the most recent read is the truest one).
function mergeWeekly(daily) {
  if (!daily.length) throw new Error('mergeWeekly needs at least one daily digest');
  const by_category = {}, by_actor = { human: 0, agent: 0 };
  for (const d of daily) { sumInto(by_category, (d.time || {}).by_category); sumInto(by_actor, (d.time || {}).by_actor); }
  return {
    runs: mergeRuns(daily.map((d) => d.runs || [])),
    time: { by_category, by_actor },
    gates: daily.flatMap((d) => d.gates || []),
    decisions: daily[daily.length - 1].decisions || { settled: [], open: [] },
    extrapolations: daily.flatMap((d) => d.extrapolations || []),
    estimates: daily.flatMap((d) => d.estimates || []),
    reviews: daily.flatMap((d) => d.reviews || []),
  };
}

// `plt digest collect --for <date> --weekly` — the five weekday JSONs already on disk under
// `process/digests/<date>.json`, merged; falls back to a direct 7-day collect (Monday through the
// following Monday) when any of them is missing or unreadable, since a merge of part of the week
// would silently under-count it.
function collectWeekly(processDir, dateStr) {
  const weekdays = isoWeekdays(dateStr);
  const digestsDir = path.join(processDir, 'digests');
  const found = [];
  for (const d of weekdays) {
    const f = path.join(digestsDir, `${d}.json`);
    if (fs.existsSync(f)) { try { found.push(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (e) { /* skip corrupt */ } }
  }
  if (found.length === weekdays.length) return mergeWeekly(found);
  const from = `${weekdays[0]}T00:00:00.000Z`;
  const to = new Date(new Date(from).getTime() + 7 * DAY_MS).toISOString();
  return collectDigest(processDir, { from, to });
}

// ---- standup: Preparing / Ready / Blockers, from live run state + the day's open decisions ----
//
// Preparing = a run whose current step is `in_progress` (the agent is actively on it).
// Blockers  = a `blocked` step, a human gate sitting `in_review` (every human gate in the shipped
//             formulas is `by: owner` — the standup's own poster — so "in_review on a human gate"
//             IS "my approval is what's pending", never someone else's), and every open decision.
// Ready     = "waiting on others": a run with no current step whose formula still has a `arm_on`
//             step not yet done — the author's reply, GitHub going green, a reviewer's approval —
//             the same "waiting" a run's own status page (lib/render.js) reports.
function computeStandup(processDir, dateStr) {
  const { from, to } = dayWindow(dateStr);
  const data = collectDigest(processDir, { from, to });
  const preparing = [];
  const ready = [];
  const blockers = [];
  for (const runId of runIds(processDir)) {
    const st = spine.readState(processDir, runId);
    if (!st || st.status === 'closed') continue;
    const cur = st.current_step;
    const curStatus = cur ? st.steps[cur].status : null;
    let wf = null;
    if (st.cycle) { try { wf = spine.loadFormula(processDir, st.cycle); } catch (e) { wf = null; } }
    if (curStatus === 'in_progress') { preparing.push(`${runId} — ${cur}`); continue; }
    if (curStatus === 'blocked') { blockers.push(`${runId} — blocked on ${cur}`); continue; }
    if (curStatus === 'in_review') {
      const def = wf && wf.steps.find((s) => s.id === cur);
      if (def && def.gate && def.gate.kind === 'external') ready.push(`${runId} — waiting on others (${cur})`);
      else blockers.push(`${runId}: my approval — ${cur}`);
      continue;
    }
    if (!cur && wf) {
      const armed = wf.steps.filter((d) => d.arm_on && st.steps[d.id] && st.steps[d.id].status === 'pending');
      if (armed.length) ready.push(`${runId} — waiting on others (${armed.map((d) => d.id).join(', ')})`);
    }
  }
  for (const d of data.decisions.open) {
    blockers.push(`${d.id} (${d.effort}) — ${d.question || 'open decision'}${d.age_days != null ? ` (${d.age_days}d open)` : ''}`);
  }
  return { preparing, ready, blockers, digest: data };
}

function renderStandup({ preparing, ready, blockers }) {
  const section = (title, items) => `*${title}*\n${items.length ? items.map((i) => `* ${i}`).join('\n') : '* none'}`;
  return [section('Preparing', preparing), section('Ready', ready), section('Blockers', blockers)].join('\n\n');
}

module.exports = { actualSpan, collectDigest, collectWeekly, computeStandup, renderStandup, dayWindow, isoWeekdays, isoWeekLabel };
