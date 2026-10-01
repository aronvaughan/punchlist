'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const spine = require('../lib/spine');
const yaml = require('../lib/yaml');
const digest = require('../lib/digest');
const FIX = path.join(__dirname, 'fixtures', 'spine');
const PLT = path.join(__dirname, '..', 'bin', 'plt');

function tmpProcess() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-'));
  fs.cpSync(FIX, path.join(root, 'process'), { recursive: true });
  return root;
}

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  execFileSync('git', ['-C', dir, 'add', 'a.txt']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'init']);
  return dir;
}

// A minimal build-and-ship run state — just enough for collectDigest (cycle, status, estimate).
// `steps` carries only what the standup test needs to read; collectDigest never reads it.
function writeRunState(p, runId, extra = {}) {
  fs.mkdirSync(path.join(p, 'runs', runId), { recursive: true });
  fs.writeFileSync(path.join(p, 'runs', runId, 'inputs.yaml'), 'card: ' + runId + '\neffort: greenhouse\n');
  spine.writeState(p, runId, {
    run: runId, cycle: 'build-and-ship', formula_version: 1, repo_dir: '/nonexistent', owner: null,
    created: '2026-09-16T09:00:00.000Z', estimate: { unit: 'ideal_days', value: 1 },
    pin: null, current_step: null, status: undefined, steps: {}, ...extra,
  });
}

function ev(p, runId, fields) { spine.appendEvent(p, runId, fields); }

function writeDecisions(p, list) {
  const e = yaml.parse(fs.readFileSync(path.join(p, 'efforts', 'greenhouse.yaml'), 'utf8'));
  e.decisions = list;
  fs.writeFileSync(path.join(p, 'efforts', 'greenhouse.yaml'), yaml.stringify(e));
}

test('collectDigest: day 1 — transitions, human time on approve, agent time on build, one open decision', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  writeRunState(p, 'TRK-10');
  // Day 1 (2026-09-16): build (agent, 2h) then approve (owner, 15m).
  ev(p, 'TRK-10', { kind: 'time', what: 'claimed', step: null, actor: 'agent', ts: '2026-09-16T09:00:00.000Z' });
  ev(p, 'TRK-10', { kind: 'time', what: 'started', step: 'build', actor: 'agent', ts: '2026-09-16T09:00:00.000Z' });
  ev(p, 'TRK-10', { kind: 'time', what: 'finished', step: 'build', actor: 'agent', ts: '2026-09-16T11:00:00.000Z' });
  ev(p, 'TRK-10', { kind: 'time', what: 'started', step: 'approve', actor: 'human', ts: '2026-09-16T11:15:00.000Z' });
  ev(p, 'TRK-10', { kind: 'time', what: 'finished', step: 'approve', actor: 'human', ts: '2026-09-16T11:30:00.000Z' });
  ev(p, 'TRK-10', { kind: 'gate', step: 'approve', name: 'artifact-approved', result: 'approve', by: 'human:o', actor: 'human', ts: '2026-09-16T11:30:00.000Z' });
  writeDecisions(p, [{ id: 'D-004', question: 'does the resolver need a cache?', status: 'open', since: '2026-09-13' }]);

  const data = digest.collectDigest(p, digest.dayWindow('2026-09-16'));

  assert.strictEqual(data.runs.length, 1);
  assert.strictEqual(data.runs[0].id, 'TRK-10');
  assert.strictEqual(data.runs[0].transitions, 4);
  assert.strictEqual(data.runs[0].from_step, 'build');
  assert.strictEqual(data.runs[0].to_step, 'approve');

  assert.strictEqual(data.time.by_category.build, 2);
  assert.strictEqual(data.time.by_category.approve, 0.25);
  assert.strictEqual(data.time.by_actor.agent, 2);       // build is assignee: agent in build-and-ship
  assert.strictEqual(data.time.by_actor.human, 0.25);    // approve is assignee: owner -> human

  assert.strictEqual(data.gates.length, 1);
  assert.deepStrictEqual(data.gates[0], { run: 'TRK-10', step: 'approve', signal: 'artifact-approved', by: 'human:o', at: '2026-09-16T11:30:00.000Z' });

  assert.strictEqual(data.decisions.settled.length, 0);
  assert.strictEqual(data.decisions.open.length, 1);
  assert.strictEqual(data.decisions.open[0].id, 'D-004');
  assert.strictEqual(data.decisions.open[0].effort, 'greenhouse');
  assert.strictEqual(data.decisions.open[0].age_days, 4);   // since 09-13 to the window's end (09-17T00:00)
});

test('collectDigest: a step still in progress at the window end counts from max(started, from) to `to`', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  writeRunState(p, 'TRK-30');
  // build started 2h before the window's end (2026-09-17T00:00) and never finished.
  ev(p, 'TRK-30', { kind: 'time', what: 'started', step: 'build', actor: 'agent', ts: '2026-09-16T22:00:00.000Z' });

  const data = digest.collectDigest(p, digest.dayWindow('2026-09-16'));
  assert.strictEqual(data.time.by_category.build, 2);
  assert.strictEqual(data.time.by_actor.agent, 2);

  // Started BEFORE the window and still open at the window's end: clipped to `from` on the left too.
  const root2 = tmpProcess();
  const p2 = path.join(root2, 'process');
  writeRunState(p2, 'TRK-31');
  ev(p2, 'TRK-31', { kind: 'time', what: 'started', step: 'build', actor: 'agent', ts: '2026-09-15T00:00:00.000Z' });
  const day = digest.collectDigest(p2, digest.dayWindow('2026-09-16'));
  assert.strictEqual(day.time.by_category.build, 24);   // the whole day, clipped at both ends
});

test('collectDigest: decisions are tagged with their effort — two efforts can each have their own D-002', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  writeRunState(p, 'TRK-10');
  writeDecisions(p, [{ id: 'D-002', question: 'greenhouse question', status: 'open' }]);
  fs.mkdirSync(path.join(p, 'efforts'), { recursive: true });
  fs.writeFileSync(path.join(p, 'efforts', 'taxonomy.yaml'),
    'slug: taxonomy\ntitle: Taxonomy\ncards: []\ndecisions:\n  - { id: D-002, question: "taxonomy question", status: open }\n');

  const data = digest.collectDigest(p, digest.dayWindow('2026-09-16'));
  const ids = data.decisions.open.filter((d) => d.id === 'D-002');
  assert.strictEqual(ids.length, 2);
  assert.deepStrictEqual(ids.map((d) => d.effort).sort(), ['greenhouse', 'taxonomy']);
});

// The same `[object Object]` bug fixed in `mine` (spine.js#assumedText): an extrapolation's
// `assumed` can ship as `{ value: "..." }`, not just a plain string — digest.js must render the
// text, reusing spine.assumedText rather than duplicating the unwrap logic.
test('collectDigest: an extrapolation\'s object-shaped `assumed` ({ value: "..." }) renders as text, never [object Object]', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  writeRunState(p, 'TRK-10');
  ev(p, 'TRK-10', { kind: 'extrapolation', step: 'pre-pr', missing: { scope: 'card', key: 'touches-drift' },
    assumed: { value: 'packages/other/x.ts outside declared packages/sensors' }, actor: 'agent', ts: '2026-09-16T10:00:00.000Z' });
  ev(p, 'TRK-10', { kind: 'extrapolation', step: 'pre-pr', missing: { scope: 'card', key: 'plain-string' },
    assumed: 'a plain string assumed', actor: 'agent', ts: '2026-09-16T10:01:00.000Z' });

  const data = digest.collectDigest(p, digest.dayWindow('2026-09-16'));
  assert.strictEqual(data.extrapolations.length, 2);
  const byKey = Object.fromEntries(data.extrapolations.map((e) => [e.key, e.assumed]));
  assert.strictEqual(byKey['touches-drift'], 'packages/other/x.ts outside declared packages/sensors');
  assert.strictEqual(byKey['plain-string'], 'a plain string assumed');
  assert.ok(!JSON.stringify(data.extrapolations).includes('[object Object]'));
});

test('collectDigest: day 2 — a separate day window sees only its own transitions, and the settled decision', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  writeRunState(p, 'TRK-10');
  ev(p, 'TRK-10', { kind: 'time', what: 'started', step: 'build', actor: 'agent', ts: '2026-09-16T09:00:00.000Z' });
  ev(p, 'TRK-10', { kind: 'time', what: 'finished', step: 'build', actor: 'agent', ts: '2026-09-16T11:00:00.000Z' });
  ev(p, 'TRK-10', { kind: 'time', what: 'started', step: 'review', actor: 'agent', ts: '2026-09-17T09:00:00.000Z' });
  ev(p, 'TRK-10', { kind: 'time', what: 'finished', step: 'review', actor: 'agent', ts: '2026-09-17T09:30:00.000Z' });
  writeDecisions(p, [{ id: 'D-004', question: 'does the resolver need a cache?', status: 'settled' }]);

  const day2 = digest.collectDigest(p, digest.dayWindow('2026-09-17'));
  assert.strictEqual(day2.runs.length, 1);
  assert.strictEqual(day2.runs[0].from_step, 'review');
  assert.strictEqual(day2.runs[0].to_step, 'review');
  assert.strictEqual(day2.runs[0].transitions, 2);
  assert.strictEqual(day2.time.by_category.build, undefined);   // day 1's build never falls in day 2's window
  assert.strictEqual(day2.time.by_category.review, 0.5);

  assert.strictEqual(day2.decisions.open.length, 0);
  assert.strictEqual(day2.decisions.settled.length, 1);
  assert.strictEqual(day2.decisions.settled[0].id, 'D-004');
});

test('computeStandup: Preparing / Ready / Blockers, one bullet section each, lines start with *', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  writeRunState(p, 'TRK-20', { current_step: 'build', steps: { build: { status: 'in_progress' } } });
  writeRunState(p, 'TRK-21', { current_step: 'merge', steps: { merge: { status: 'in_review' } } });   // external gate
  writeDecisions(p, [{ id: 'D-005', question: 'cache the resolver?', status: 'open', since: '2026-09-15' }]);

  const s = digest.computeStandup(p, '2026-09-16');
  assert.strictEqual(s.preparing.length, 1);
  assert.match(s.preparing[0], /^TRK-20/);
  assert.strictEqual(s.ready.length, 1);
  assert.match(s.ready[0], /^TRK-21/);
  assert.ok(s.blockers.some((b) => b.startsWith('D-005 (greenhouse)')));

  const rendered = digest.renderStandup(s);
  const lines = rendered.split('\n').filter((l) => l.trim().length);
  assert.ok(lines.every((l) => l.startsWith('*')), 'every line is a `*` bullet, never `-`');
  assert.ok(rendered.includes('*Preparing*'));
  assert.ok(rendered.includes('*Ready*'));
  assert.ok(rendered.includes('*Blockers*'));
});

test('computeStandup: an in_review HUMAN gate is MY approval — a Blocker, never Ready (every shipped gate is by: owner)', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  writeRunState(p, 'TRK-22', { current_step: 'approve', steps: { approve: { status: 'in_review' } } });

  const s = digest.computeStandup(p, '2026-09-16');
  assert.strictEqual(s.ready.length, 0);
  assert.strictEqual(s.preparing.length, 0);
  assert.ok(s.blockers.some((b) => b === 'TRK-22: my approval — approve'), JSON.stringify(s.blockers));
});

test('computeStandup: a run with no current step, waiting on an arm_on condition (e.g. resync on a conflict), is Ready — waiting on others', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  writeRunState(p, 'TRK-23', { current_step: null, steps: { resync: { status: 'pending' } } });

  const s = digest.computeStandup(p, '2026-09-16');
  assert.strictEqual(s.ready.length, 1);
  assert.match(s.ready[0], /^TRK-23 — waiting on others \(resync\)/);
  assert.strictEqual(s.blockers.length, 0);
});

// The week of 2026-09-16 (Wed) runs Monday 09-14 through Friday 09-18. writeWeek writes one daily
// digest per weekday named in `runsByDay` ({ <date>: [run rows] }); a weekday left out has no file.
const WEEK = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'];
function writeWeek(p, runsByDay) {
  const digestsDir = path.join(p, 'digests');
  fs.mkdirSync(digestsDir, { recursive: true });
  const empty = { time: { by_category: {}, by_actor: { human: 0, agent: 0 } }, gates: [], decisions: { settled: [], open: [] }, extrapolations: [], estimates: [], reviews: [] };
  for (const [day, runs] of Object.entries(runsByDay)) fs.writeFileSync(path.join(digestsDir, `${day}.json`), JSON.stringify({ ...empty, runs }));
}
const row = (id, from, to, transitions) => ({ id, effort: 'greenhouse', cycle: 'build-and-ship', from_step: from, to_step: to, transitions });
// A run the ledger shows moving on Tuesday, but that no daily file mentions: it appears only when
// collectWeekly falls back to reading the events directly.
function ledgerOnlyRun(p) {
  writeRunState(p, 'TRK-41');
  ev(p, 'TRK-41', { kind: 'time', what: 'started', step: 'build', actor: 'agent', ts: '2026-09-15T09:00:00.000Z' });
  ev(p, 'TRK-41', { kind: 'time', what: 'finished', step: 'build', actor: 'agent', ts: '2026-09-15T10:00:00.000Z' });
}

test('collectWeekly: all five daily files exist — the week is their merge, and the ledger is not re-read', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  ledgerOnlyRun(p);
  writeWeek(p, Object.fromEntries(WEEK.map((d, i) => [d, [row('TRK-40', 'build', 'build', i + 1)]])));
  const weekly = digest.collectWeekly(p, '2026-09-16');
  assert.deepStrictEqual(weekly.runs.map((r) => r.id), ['TRK-40']);
  assert.strictEqual(weekly.runs[0].transitions, 15);   // 1 + 2 + 3 + 4 + 5
});

test('collectWeekly: two daily files missing — falls back to one 7-day collect from the ledger', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  ledgerOnlyRun(p);
  writeWeek(p, { '2026-09-14': [row('TRK-40', 'build', 'build', 1)], '2026-09-16': [], '2026-09-18': [] });
  const weekly = digest.collectWeekly(p, '2026-09-16');
  assert.deepStrictEqual(weekly.runs.map((r) => r.id), ['TRK-41'], 'the partial daily files are not merged');
  assert.strictEqual(weekly.runs[0].transitions, 2);
});

test('collectWeekly: a run active on three days appears ONCE — earliest from_step, latest to_step, transitions summed', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  writeWeek(p, {
    '2026-09-14': [row('TRK-40', 'build', 'build', 2)],
    '2026-09-15': [],
    '2026-09-16': [row('TRK-40', 'review', 'review', 2)],
    '2026-09-17': [],
    '2026-09-18': [row('TRK-40', 'pre-pr', 'open-pr', 3)],
  });
  const weekly = digest.collectWeekly(p, '2026-09-16');
  const rows = weekly.runs.filter((r) => r.id === 'TRK-40');
  assert.strictEqual(rows.length, 1, 'the run appears once, not once per day');
  assert.strictEqual(rows[0].from_step, 'build');     // the earliest day's start
  assert.strictEqual(rows[0].to_step, 'open-pr');     // the latest day's end
  assert.strictEqual(rows[0].transitions, 7);         // summed
});

test('plt digest launch --for <date> is idempotent: a second launch on an already-closed run is a no-op', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  const repo = tmpRepo();
  const env = { ...process.env, PLT_PROCESS_DIR: p };

  const first = execFileSync('node', [PLT, 'digest', 'launch', '--for', '2026-09-18', '--repo', repo], { encoding: 'utf8', env });
  const state = JSON.parse(first);
  assert.strictEqual(state.run, 'DIGEST-20260918');
  assert.strictEqual(state.cycle, 'digest');

  // Fast-forward to closed without walking every step — this test is about launch's own
  // idempotence check, not the full digest cycle.
  const st = spine.readState(p, state.run);
  st.status = 'closed';
  st.closed_as = 'done';
  spine.writeState(p, state.run, st);

  const second = spawnSync('node', [PLT, 'digest', 'launch', '--for', '2026-09-18', '--repo', repo], { encoding: 'utf8', env });
  assert.strictEqual(second.status, 0);
  assert.match(second.stdout, /no-op/);

  // A relaunch attempt on a NOT-closed run still refuses (unchanged spine.launchRun behaviour) —
  // idempotence is specifically about the closed case.
  const root2 = tmpProcess();
  const p2 = path.join(root2, 'process');
  const env2 = { ...process.env, PLT_PROCESS_DIR: p2 };
  execFileSync('node', [PLT, 'digest', 'launch', '--for', '2026-09-19', '--repo', repo], { encoding: 'utf8', env: env2 });
  const relaunch = spawnSync('node', [PLT, 'digest', 'launch', '--for', '2026-09-19', '--repo', repo], { encoding: 'utf8', env: env2 });
  assert.notStrictEqual(relaunch.status, 0);
  assert.match(relaunch.stderr, /already launched/);
});

test('plt digest collect writes process/digests/<date>.json; plt digest standup prints bullets', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  writeRunState(p, 'TRK-10');
  ev(p, 'TRK-10', { kind: 'time', what: 'started', step: 'build', actor: 'agent', ts: '2026-09-16T09:00:00.000Z' });
  ev(p, 'TRK-10', { kind: 'time', what: 'finished', step: 'build', actor: 'agent', ts: '2026-09-16T10:00:00.000Z' });
  const env = { ...process.env, PLT_PROCESS_DIR: p };

  const collectOut = execFileSync('node', [PLT, 'digest', 'collect', '--for', '2026-09-16'], { encoding: 'utf8', env });
  assert.match(collectOut, /wrote/);
  const written = JSON.parse(fs.readFileSync(path.join(p, 'digests', '2026-09-16.json'), 'utf8'));
  assert.strictEqual(written.runs[0].id, 'TRK-10');

  const standupOut = execFileSync('node', [PLT, 'digest', 'standup', '--for', '2026-09-16'], { encoding: 'utf8', env });
  assert.ok(standupOut.includes('*Preparing*'));
  assert.ok(standupOut.split('\n').filter((l) => l.trim()).every((l) => l.startsWith('*')));
});
