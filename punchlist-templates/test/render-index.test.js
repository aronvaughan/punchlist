'use strict';
// render-index — the D9 effort panel on `plt render index`: two tabs over one shared roster,
// the needs-a-human strip, the decision log keyed by `who`, and the estimate roll-up.
//
// Every assertion here is STRUCTURAL: an element with a given `data-*`, a count, a link target,
// a state that the events say. None of it matches whitespace or a markup string, because a test
// that fails when a class name is re-ordered is a test nobody keeps.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const spine = require('../lib/spine');
const yaml = require('../lib/yaml');
const render = require('../lib/render');
const effortEvents = require('../lib/effort-events');
const FIX = path.join(__dirname, 'fixtures', 'spine');

function tmpProcess() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-idx-'));
  fs.cpSync(FIX, path.join(root, 'process'), { recursive: true });
  return path.join(root, 'process');
}
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-idx-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  execFileSync('git', ['-C', dir, 'add', 'a.txt']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'init']);
  return dir;
}
const writeInputs = (p, id, v) => fs.writeFileSync(path.join(p, 'runs', id, 'inputs.yaml'), yaml.stringify(v));
function patchState(p, id, fn) { const st = spine.readState(p, id); fn(st); spine.writeState(p, id, st); }
function receipt(p, id, ev) { const st = spine.readState(p, id); return spine.recordReceipt(p, id, { pin: st.pin, ...ev }); }
// `kind: time` lines, written straight onto the run ledger so a span has the timestamps the test
// chose. spine.stepStart/stepFinish would stamp the wall clock, which is the one thing a timing
// assertion cannot have.
function timeEvents(p, id, rows) {
  const f = path.join(p, 'runs', id, 'events.jsonl');
  fs.appendFileSync(f, rows.map((r) => JSON.stringify({ kind: 'time', run: id, ...r })).join('\n') + '\n');
}
// The one element carrying data-<key>="<value>", as a string, or null.
function el(html, key, value) {
  const re = new RegExp(`<[^>]*data-${key}="${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`);
  const m = html.match(re);
  return m ? m[0] : null;
}
const attr = (tag, name) => { const m = String(tag || '').match(new RegExp(`${name}="([^"]*)"`)); return m ? m[1] : null; };
const countOf = (html, re) => (html.match(re) || []).length;

// The greenhouse effort, extended for D9: two more cards that contend for one path, a blocked run
// with an open question, a stale reference and a fresh one, and an effort ledger with one decision
// per `who`.
function fixtureProcess({ references = true } = {}) {
  const p = tmpProcess();
  const repo = tmpRepo();
  fs.writeFileSync(path.join(p, 'config', 'zz-idx.yaml'), yaml.stringify({ actors: { humans: ['pat'] } }));

  const ef = path.join(p, 'efforts', 'greenhouse.yaml');
  const e = yaml.parse(fs.readFileSync(ef, 'utf8'));
  e.cards.push({ id: 'TRK-18', title: 'resolver overlap two', cycle: 'build-and-ship', estimate: 0.5, touches: ['packages/resolvers'], after: [] });
  if (references) {
    e.references = [
      { id: 'code-kb', last_indexed: '2026-08-01T00:00:00.000Z', reindex: 'plt reference index code-kb' },
      // Relative to now, because the newest event on the board is a receipt stamped now: a fixed
      // date would drift past the window and this case would quietly stop being the fresh one.
      { id: 'fresh-kb', last_indexed: new Date(Date.now() - 86400000).toISOString() },
    ];
  }
  fs.writeFileSync(ef, yaml.stringify(e));

  // TRK-10 — at the owner's approve gate, PR in conflict, pages published, 3h of elapsed
  // against a 0.25 ideal-day estimate (2h at the default 8h/day): an over-run.
  spine.launchRun(p, { runId: 'TRK-10', cycle: 'build-and-ship', repoDir: repo, owner: 'pat', estimate: 0.25 });
  writeInputs(p, 'TRK-10', { card: 'TRK-10', title: 'rename the sampler', effort: 'greenhouse' });
  receipt(p, 'TRK-10', { step: 'pre-pr', kind: 'artifact', name: 'pre-pr-summary', ref: 'https://pages.example/pre-pr-10' });
  receipt(p, 'TRK-10', { step: 'pre-pr', kind: 'artifact', name: 'run-TRK-10', ref: 'https://pages.example/run-TRK-10' });
  receipt(p, 'TRK-10', { step: 'pre-pr', kind: 'gh', name: 'pr:create', ref: 'https://github.com/example-org/greenhouse/pull/42', result: 'pass' });
  timeEvents(p, 'TRK-10', [
    { what: 'started', step: 'scope', ts: '2026-09-16T08:00:00.000Z' },
    { what: 'finished', step: 'scope', ts: '2026-09-16T09:00:00.000Z' },
    { what: 'started', step: 'build', ts: '2026-09-16T09:00:00.000Z' },
    { what: 'finished', step: 'build', ts: '2026-09-16T11:00:00.000Z' },
  ]);
  patchState(p, 'TRK-10', (st) => {
    for (const id of ['scope', 'build', 'review', 'write-review', 'pre-pr']) { st.steps[id].status = 'done'; st.steps[id].finished = '2026-09-16T10:00:00.000Z'; }
    st.steps.approve.status = 'ready';
    st.current_step = null;
    st.facts = { at: '2026-09-16T11:00:00.000Z', headSha: 'abc1234def5678', state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED',
      mergeStateStatus: 'DIRTY', checks: { total: 3, pass: 2, fail: 0, pending: 1 }, threadsUnresolved: 0, cursor: null };
  });

  // TRK-12 — closed, well inside its 1 ideal-day estimate.
  spine.launchRun(p, { runId: 'TRK-12', cycle: 'build-and-ship', repoDir: repo, owner: 'pat', estimate: 1 });
  writeInputs(p, 'TRK-12', { card: 'TRK-12', title: 'test resolver', effort: 'greenhouse' });
  timeEvents(p, 'TRK-12', [
    { what: 'started', step: 'scope', ts: '2026-09-16T08:00:00.000Z' },
    { what: 'finished', step: 'scope', ts: '2026-09-16T08:30:00.000Z' },
  ]);
  patchState(p, 'TRK-12', (st) => {
    for (const id of Object.keys(st.steps)) { st.steps[id].status = 'done'; }
    st.current_step = null; st.status = 'closed'; st.closed = '2026-09-16T12:00:00.000Z';
  });

  // TRK-15 — blocked on a question, so the graph has an `open question` edge to draw.
  spine.launchRun(p, { runId: 'TRK-15', cycle: 'build-and-ship', repoDir: repo, owner: 'pat', estimate: 0.5 });
  writeInputs(p, 'TRK-15', { card: 'TRK-15', title: 'waits on product', effort: 'greenhouse' });
  // A question is written by lib/blocked through spine.appendEvent — recordReceipt has no `text`.
  spine.appendEvent(p, 'TRK-15', { kind: 'question', step: 'scope', text: 'which org owns the seed data?' });
  patchState(p, 'TRK-15', (st) => { st.steps.scope.status = 'blocked'; st.current_step = 'scope'; });

  // The effort ledger: one decision per `who`, plus a `wave` line that is NOT a decision.
  effortEvents.appendEffortEvent(p, 'greenhouse', { kind: 'decision', who: 'fan', what: 'held TRK-18', text: 'TRK-18 shares packages/resolvers with TRK-16' });
  effortEvents.appendEffortEvent(p, 'greenhouse', { kind: 'decision', who: 'brain', what: 'answered', text: 'named the sampler rename' });
  effortEvents.appendEffortEvent(p, 'greenhouse', { kind: 'escalation', who: 'gate', what: 'escalated', text: 'the resolver split needs a call' });
  effortEvents.appendEffortEvent(p, 'greenhouse', { kind: 'wave', who: 'brain', what: 'dispatched', text: 'wave 1' });
  return { p, repo };
}
// The page BELOW its stylesheet. Every assertion here is about elements, and the stylesheet names
// the same `data-*` selectors the elements carry — matching the whole page would let a CSS rule
// stand in for the markup it styles, which is a test that passes when the page is empty.
// fixtureProcess, with the effort FILE mutated afterwards — for the cases that are about the file
// rather than its runs. The runs are unchanged, so the board still carries events to measure against.
function tmpEffortWith(mutate) {
  const out = fixtureProcess();
  const ef = path.join(out.p, 'efforts', 'greenhouse.yaml');
  const e = yaml.parse(fs.readFileSync(ef, 'utf8'));
  mutate(e);
  fs.writeFileSync(ef, yaml.stringify(e));
  return out;
}
const page = (p) => render.renderIndex(p, spine.loadConfig(p));
const index = (p) => { const h = page(p); return h.slice(h.indexOf('</style>')); };

test('D9: the panel carries both views, and the roster sits outside them so a tab switch changes only the picture', () => {
  const { p } = fixtureProcess();
  const html = index(p);
  assert.ok(el(html, 'view', 'graph'), 'the fan-out graph view is in the page');
  assert.ok(el(html, 'view', 'swimlanes'), 'the swimlane view is in the page');
  assert.ok(/<ul[^>]*class="roster"/.test(html), 'the shared roster');
  // The roster must not be inside either view — both tabs show the same one.
  const roster = html.indexOf('class="roster"');
  const firstView = html.indexOf('data-view="graph"');
  assert.ok(roster !== -1 && firstView !== -1 && roster < firstView, 'the roster precedes the tabbed views');
  // Two radios in one group, so the tabs are exclusive without a line of script.
  assert.strictEqual(countOf(html, /name="tab-greenhouse"/g), 2, 'two tabs in one radio group');
});

test('D9: the roster leads with the brain, then one entry per card, each with its state, source and artifact chips', () => {
  const { p } = fixtureProcess();
  const html = index(p);
  const brain = el(html, 'entry', 'brain');
  assert.ok(brain, 'the brain entry exists');
  assert.ok(html.indexOf('data-entry="brain"') < html.indexOf('data-rost="TRK-10"'), 'the brain leads the roster');
  assert.strictEqual(attr(brain, 'data-decisions'), '1', 'the brain names its own decisions this epoch — not the fan\'s, not the gate\'s');

  assert.strictEqual(attr(el(html, 'rost', 'TRK-10'), 'data-state'), 'human', 'TRK-10 is at the owner gate');
  assert.strictEqual(attr(el(html, 'rost', 'TRK-12'), 'data-state'), 'done', 'TRK-12 is closed');
  assert.strictEqual(attr(el(html, 'rost', 'TRK-15'), 'data-state'), 'human', 'a blocked run needs a person');
  assert.strictEqual(attr(el(html, 'rost', 'TRK-14'), 'data-state'), 'not-launched', 'a card with no run says so');
  assert.strictEqual(attr(el(html, 'rost', 'TRK-14'), 'data-source'), 'card', 'TRK-14 comes from the effort file');
  // The chips are the run's published pages, on the roster entry itself.
  const chips = html.match(/data-rost="TRK-10"[\s\S]*?<\/li>/);
  assert.ok(chips && chips[0].includes('https://pages.example/pre-pr-10'), 'TRK-10 carries its pre-PR page as a chip');
});

test('D9: the graph answers why a card is waiting — dependency, open question and file overlap are three labelled edges', () => {
  const { p } = fixtureProcess();
  const html = index(p);
  const node = (id) => (html.match(new RegExp(`<li class="node" data-node="${id}"[\\s\\S]*?</li>`)) || [])[0] || '';

  const dep = node('TRK-11');
  assert.ok(/data-edge="dependency"/.test(dep), 'TRK-11 waits on a dependency');
  assert.ok(/data-from="TRK-10"/.test(dep), 'the dependency edge names TRK-10');

  const q = node('TRK-15');
  assert.ok(/data-edge="question"/.test(q), 'a blocked run draws an open-question edge');
  assert.ok(q.includes('which org owns the seed data?'), 'the edge carries the question itself');

  const ov = node('TRK-18');
  assert.ok(/data-edge="overlap"/.test(ov), 'TRK-18 is held by a file overlap');
  assert.ok(/data-from="TRK-16"/.test(ov), 'the overlap edge names the card it collides with');
  assert.ok(ov.includes('packages/resolvers'), 'and the shared path');

  // A card in the wave with nothing holding it has no edges at all.
  const clear = node('TRK-16');
  assert.ok(clear && !/data-edge=/.test(clear), 'TRK-16 is in the wave and draws no edge');
});

test('D9: the swimlane ruler derives from each card\'s own cycle, not one ruler for the effort', () => {
  const { p } = fixtureProcess();
  const html = index(p);
  const lane = (id) => el(html, 'lane', id);
  const steps = (id) => Number(attr(lane(id), 'data-steps'));
  assert.strictEqual(steps('TRK-10'), 13, 'build-and-ship has thirteen steps');
  assert.strictEqual(steps('TRK-13'), 3, 'the spike card rules itself on its own three');
  assert.notStrictEqual(steps('TRK-10'), steps('TRK-13'), 'one ruler per effort would squash the long cycle');
  // The cells are the steps, in cycle order, carrying what the state says.
  const row = (html.match(/<div class="lane" data-lane="TRK-10"[\s\S]*?<\/div>\s*<\/div>/) || [])[0] || '';
  assert.strictEqual(countOf(row, /class="cell"/g), 13, 'one cell per step of that card\'s cycle');
  assert.ok(/data-step="scope"[^>]*data-state="done"/.test(row), 'a finished step reads done');
  assert.ok(/data-step="approve"[^>]*data-state="ready"/.test(row), 'the gate step reads ready');
});

test('D9: the needs strip carries Unblock on a merge conflict and force-index on a stale reference', () => {
  const { p } = fixtureProcess();
  const html = index(p);
  const conflict = el(html, 'need', 'conflict');
  assert.ok(conflict, 'a DIRTY merge state reaches the strip');
  assert.strictEqual(attr(conflict, 'data-card'), 'TRK-10');
  const item = (html.match(/data-need="conflict"[\s\S]*?<\/li>/) || [])[0];
  assert.ok(/Unblock/.test(item), 'the action is named Unblock');
  // TRK-10 is a build-and-ship run, so its repair is `resync`, NOT `plt card rebase` — see the T26
  // tests below. The command is asserted there; what belongs here is that an Unblock carries one.
  assert.ok(/<code>plt [^<]+<\/code>/.test(item), 'and carries the command that runs it');

  const stale = el(html, 'need', 'stale-reference');
  assert.ok(stale, 'a reference past references.stale_after reaches the strip');
  assert.strictEqual(attr(stale, 'data-ref'), 'code-kb');
  const sitem = (html.match(/data-need="stale-reference"[\s\S]*?<\/li>/) || [])[0];
  assert.ok(/force-index/.test(sitem), 'the action is named force-index');
  assert.ok(sitem.includes('plt reference index code-kb'), 'and carries the reindex the reference declares');
  assert.ok(!html.includes('fresh-kb'), 'a reference inside the window is not an item');

  // A held card is in the strip too, naming the overlap — D7 keeps the hold and asks.
  const held = el(html, 'need', 'contention');
  assert.ok(held, 'the contended card asks for a decision');
  assert.strictEqual(attr(held, 'data-card'), 'TRK-18');
  assert.strictEqual(attr(held, 'data-from'), 'TRK-16');
  // TRK-11 overlaps TRK-10 AND waits on it. An Unblock clears contention only, so offering one
  // there asks for a decision that would not move the card — the strip must not raise it.
  assert.strictEqual(countOf(html, /data-need="contention"/g), 1, 'a card held by a dependency too is not offered an Unblock');
  assert.ok(/data-node="TRK-11"[\s\S]*?data-edge="overlap"/.test(html), 'the graph still draws its overlap — the question is why it waits, and both answers are true');
});

test('D9: the needs strip is empty of reference items when the effort declares none', () => {
  const { p } = fixtureProcess({ references: false });
  const html = index(p);
  assert.strictEqual(el(html, 'need', 'stale-reference'), null, 'no references, no force-index item');
  assert.ok(el(html, 'need', 'conflict'), 'the conflict item is unaffected');
});

// ---- T26: one conflict, two cycles, two repairs ------------------------------------------------
// The board used to offer `plt card rebase <effort>/<card>` for EVERY card in conflict. On a PR
// cycle that is the one repair its own pack forbids: lib/rebase.js rewrites the card's commits
// locally and never pushes, so the PR stays DIRTY, the local branch diverges from the pushed head,
// `resync`'s merge-commit-push can no longer fast-forward, and build-and-ship.md:106 forbids the
// force-push that would reconcile them. An owner who followed the board would have stranded the
// branch and burned the reviewers' approvals for a rebase that fixed nothing.
//
// The fixture carries one card of each kind, and the commit-cycle one runs the REAL shipped
// build-and-commit pack, copied into the fixture's cycles dir — so the discriminator is a cycle
// that exists rather than a mock shaped to agree with the code under test.
function fixtureBothCycles() {
  const out = fixtureProcess();
  const { p, repo } = out;
  fs.copyFileSync(path.resolve(__dirname, '../workflows/packs/core/build-and-commit.md'), path.join(p, 'cycles', 'build-and-commit.md'));
  const ef = path.join(p, 'efforts', 'greenhouse.yaml');
  const e = yaml.parse(fs.readFileSync(ef, 'utf8'));
  e.cards.push({ id: 'TRK-20', title: 'commit-review card', cycle: 'build-and-commit', estimate: 0.5, touches: ['packages/commits'], after: [] });
  fs.writeFileSync(ef, yaml.stringify(e));
  spine.launchRun(p, { runId: 'TRK-20', cycle: 'build-and-commit', repoDir: repo, owner: 'pat', estimate: 0.5 });
  writeInputs(p, 'TRK-20', { card: 'TRK-20', title: 'commit-review card', effort: 'greenhouse' });
  // A commit cycle has no PR to report DIRTY. Its conflict is an OUTCOME on its own `merge` step,
  // which is the other half of the `dirty` predicate on the strip.
  timeEvents(p, 'TRK-20', [{ what: 'finished', step: 'merge', outcome: 'conflict', ts: '2026-09-16T12:00:00.000Z' }]);
  return out;
}
const conflictItem = (html, id) => (html.match(new RegExp(`<li class="need" data-need="conflict" data-card="${id}"[\\s\\S]*?</li>`)) || [])[0] || '';

test('T26: the Unblock names the repair the card\'s OWN cycle prescribes — resync for a PR, rebase without one', () => {
  const { p } = fixtureBothCycles();
  const html = index(p);

  // WHICH cards are in trouble was never the bug: both still reach the strip.
  assert.strictEqual(countOf(html, /data-need="conflict"/g), 2, 'a DIRTY PR and a conflicted fast-forward are both needs-a-human');

  const ship = conflictItem(html, 'TRK-10');
  assert.ok(ship, 'the DIRTY PR card is in the strip');
  assert.match(ship, /data-repair="resync"/, 'a cycle with a resync step repairs by merging origin/main in');
  assert.match(ship, /resync/, 'and the entry names that step');
  assert.ok(!/plt card rebase/.test(ship),
    'a rebase rewrites the card\'s commits and never pushes: the PR stays DIRTY, local diverges from the pushed head, and the force-push that would fix it is forbidden by build-and-ship.md');

  const commit = conflictItem(html, 'TRK-20');
  assert.ok(commit, 'a conflicted commit-cycle card is in the strip too');
  assert.match(commit, /data-repair="rebase"/, 'no resync step, so the rebase is the cycle\'s own repair');
  assert.ok(commit.includes('plt card rebase greenhouse/TRK-20'),
    'build-and-commit repairs a conflict with `plt card rebase` and repeats its merge onto the fast-forward');
  assert.ok(!/resync/.test(commit), 'a commit-review cycle has no resync step to start');

  // Both directions in one assertion: a fix that gives every card the same text has replaced one
  // wrong answer with another, and this is the count that catches it.
  assert.strictEqual(countOf(html, /data-repair="resync"/g), 1);
  assert.strictEqual(countOf(html, /data-repair="rebase"/g), 1);
});

test('T26: the Unblock command is one the reader can run — the poll arms resync, the start needs it ready', () => {
  const { p } = fixtureBothCycles();
  // Nothing has polled TRK-10: its facts came from `plt facts`, so resync is still pending.
  // `spine.stepStart` throws on a step that is not ready, and only `plt run poll` arms an arm_on
  // step — advice that throws is the same class of defect as advice that is forbidden.
  const before = conflictItem(index(p), 'TRK-10');
  assert.ok(before.includes('plt run poll TRK-10'), 'a pending resync is named at the poll that arms it');
  assert.ok(!before.includes('plt step start resync'), 'a start on a pending step is a command that throws');

  patchState(p, 'TRK-10', (st) => { st.steps.resync.status = 'ready'; });
  const armed = conflictItem(index(p), 'TRK-10');
  assert.ok(armed.includes('plt step start resync --run TRK-10'), 'once armed, the strip names the step itself');
  assert.ok(!armed.includes('plt run poll'), 'an armed step needs no second poll');

  patchState(p, 'TRK-10', (st) => { st.steps.resync.status = 'in_progress'; });
  const running = conflictItem(index(p), 'TRK-10');
  assert.ok(running.includes('plt step finish resync --run TRK-10 --outcome resynced'), 'a resync already running is finished, not started again');
});

// This one asserts on the RUN page, from the index test file, on purpose: the defect it pins is
// that the two pages answered the same question differently, so the assertion has to read both.
test('T26: the run page merge cell gives the same repair as the board — the two pages cannot disagree', () => {
  const { p } = fixtureBothCycles();
  const cfg = spine.loadConfig(p);
  const run = render.renderRun(p, 'TRK-10', cfg);
  assert.ok(run.includes('🔀 CONFLICT'), 'the cell still reports the conflict');
  assert.match(run, /data-repair="resync"/, 'and routes it at resync, as the board does');
  assert.ok(run.includes('plt run poll TRK-10'), 'naming the step was not enough — the cell carries the command too');
  assert.ok(!/plt card rebase/.test(run), 'the run page never offers the repair its own pack forbids');
  // The command is the SAME string on both pages, which is what makes the contradiction unwritable.
  const board = conflictItem(index(p), 'TRK-10');
  // Scoped to the repair element on each page: the run page's "Next" box carries a `plt` command of
  // its own (the owner's approve gate), and comparing that one would prove nothing.
  const cmd = (s) => ((s.match(/data-repair="[^"]*"[\s\S]*?<code>(plt [^<]+)<\/code>/) || [])[1]) || null;
  // Both sides must be present before they can be compared: null === null is a test that passes on
  // a page with no repair at all, which is exactly the page this card was opened about.
  assert.ok(cmd(run), 'the merge cell carries a command');
  assert.ok(cmd(board), 'the board entry carries a command');
  assert.strictEqual(cmd(run), cmd(board), 'one function answers for both pages');
});

test('D9: the decision log is keyed by who — fan, brain and gate are three different authorities', () => {
  const { p } = fixtureProcess();
  const html = index(p);
  for (const who of ['fan', 'brain', 'gate']) {
    const row = el(html, 'who', who);
    assert.ok(row, `the log has a ${who} row`);
  }
  // The effort's own log, which is the LAST `data-log` on the page: the per-card detail views come
  // first in the document, and each carries the decisions naming its card, so one ledger line can
  // appear more than once on the page by design. "One decision, one row" is a claim about the log,
  // and scoping it there is what keeps it a claim about duplication rather than about the layout.
  const log = html.slice(html.indexOf('data-log="ledger"'));
  assert.ok(log.length, 'the effort log is marked');
  assert.strictEqual((log.match(/data-who="fan"/g) || []).length, 1, 'one fan decision, one row in the log');
  assert.ok(html.indexOf('data-log="card"') < html.indexOf('data-log="ledger"'), 'the per-card slices are drawn before the whole log');
  assert.ok(html.includes('the resolver split needs a call'), 'the escalation text is on the page');
  assert.ok(!html.includes('wave 1'), 'a wave line is not a decision and is not in the log');
});

test('D9: the roll-up shows estimate against elapsed actual, and flags the over-run', () => {
  const { p } = fixtureProcess();
  const html = index(p);
  const over = el(html, 'roll', 'TRK-10');
  assert.ok(over, 'TRK-10 has a roll-up row');
  assert.strictEqual(attr(over, 'data-overrun'), 'true', '3h of elapsed against a 0.25 ideal-day estimate over-runs');
  const row = (html.match(/data-roll="TRK-10"[\s\S]*?<\/tr>/) || [])[0];
  assert.ok(/3h 00m/.test(row), 'the actual is the elapsed the ledger evidences');

  const under = el(html, 'roll', 'TRK-12');
  assert.strictEqual(attr(under, 'data-overrun'), 'false', '30m against a 1 ideal-day estimate does not');
  // A card that was never launched has no actual to claim — and must not read as zero over-run.
  assert.strictEqual(attr(el(html, 'roll', 'TRK-14'), 'data-overrun'), 'unknown', 'no run, no actual');
});

test('D9: the page stays deterministic — an open span is measured to the last event, never to the clock', () => {
  const { p } = fixtureProcess();
  // TRK-15 is blocked with an OPEN span: measured against Date.now() the page would differ on
  // every render, and publishManifest tells a changed page from an unchanged one by sha alone.
  timeEvents(p, 'TRK-15', [{ what: 'started', step: 'scope', ts: '2026-09-16T08:00:00.000Z' }]);
  const a = page(p);
  const b = page(p);
  assert.strictEqual(render.sha256(a), render.sha256(b), 'two renders, one sha');
  assert.ok(el(index(p), 'roll', 'TRK-15'), 'the open-span card is still in the roll-up');
});

// ---- round one of adversarial review: missing data must never render as a passing verdict ----

test('escaping: a value with a quote in it cannot open an attribute of its own', () => {
  const { p } = tmpEffortWith((e) => {
    e.references = [{ id: 'kb" data-injected="yes', last_indexed: '2026-01-01T00:00:00.000Z' }];
  });
  const html = index(p);
  assert.ok(html.includes('data-ref="kb&quot; data-injected=&quot;yes"'), 'the quote is escaped inside the attribute');
  assert.strictEqual(el(html, 'injected', 'yes'), null, 'and no attribute of that name exists on the page');
  // The same shape, one layer over: a chip href is an attribute sink too.
  assert.ok(!/href="[^"]*"[^>]*onmouseover/.test(html), 'nothing escapes an href into a handler');
});

test('a launched run with no time events has NO actual — it is not zero, and not within budget', () => {
  const { p } = fixtureProcess();
  // TRK-15 is launched and has an estimate; nothing has written a `time` event for it.
  const row = el(index(p), 'roll', 'TRK-15');
  assert.strictEqual(attr(row, 'data-overrun'), 'unknown', 'no measurement, no verdict');
  assert.strictEqual(attr(row, 'data-counted'), 'false', 'and it is not counted into the effort total');
  assert.ok(/no data/.test((index(p).match(/data-roll="TRK-15"[\s\S]*?<\/tr>/) || [])[0]), 'the cell says so in words');
  assert.strictEqual(attr(el(index(p), 'rost', 'TRK-15'), 'data-actual'), 'none', 'the roster agrees');
});

test('a run whose span is still open reports a lower bound, not a verdict', () => {
  const { p } = fixtureProcess();
  timeEvents(p, 'TRK-15', [{ what: 'started', step: 'scope', ts: '2026-09-16T08:00:00.000Z' }]);
  const html = index(p);
  const row = el(html, 'roll', 'TRK-15');
  assert.strictEqual(attr(row, 'data-overrun'), 'unknown', 'a step that is still running has not finished over- or under-running');
  assert.strictEqual(attr(el(html, 'rost', 'TRK-15'), 'data-actual'), 'lower-bound');
  assert.ok(/≥/.test((html.match(/data-roll="TRK-15"[\s\S]*?<\/tr>/) || [])[0]), 'the number is marked as a floor');
});

test('the effort total counts only the cards it can measure, and says how many it left out', () => {
  const { p } = fixtureProcess();
  const html = index(p);
  const row = (html.match(/<tr class="rolltotal"[\s\S]*?<\/tr>/) || [])[0];
  assert.ok(row, 'the total row renders');
  assert.strictEqual(attr(row, 'data-counted'), '2', 'only TRK-10 and TRK-12 have a measured actual');
  assert.ok(Number(attr(row, 'data-uncounted')) > 0, 'and the rest are named as uncounted');
  assert.strictEqual(attr(row, 'data-overrun'), 'partial', 'a total over a subset is never a plain within/over');
});

test('estimation.unit is honoured — hours are not multiplied by hours-per-day', () => {
  const { p } = fixtureProcess();
  // A run launched under `unit: hours` carries that unit on its own state.
  const st = spine.readState(p, 'TRK-10'); st.estimate = { unit: 'hours', value: 4 }; spine.writeState(p, 'TRK-10', st);
  const row = (index(p).match(/data-roll="TRK-10"[\s\S]*?<\/tr>/) || [])[0];
  assert.ok(/4h 00m/.test(row), '4 hours is four hours — not 4 x 8');
  assert.ok(!/32h/.test(row), 'the day conversion must not be applied to an hours estimate');
  assert.strictEqual(attr(el(index(p), 'roll', 'TRK-10'), 'data-overrun'), 'false', '3h of elapsed is inside a 4h estimate');
});

test('estimation.unit reaches an UNLAUNCHED card too — its bare number is in the project unit', () => {
  const { p } = fixtureProcess();
  fs.writeFileSync(path.join(p, 'config', 'zz-unit.yaml'), yaml.stringify({ estimation: { unit: 'hours' } }));
  // TRK-13 has `estimate: 0.75` and no run. Under `unit: hours` that is 45 minutes, not six hours.
  const row = (index(p).match(/data-roll="TRK-13"[\s\S]*?<\/tr>/) || [])[0];
  assert.ok(/45m/.test(row), 'the effort file\'s bare number is read in the project unit');
  assert.ok(!/6h/.test(row), 'not converted as if it were a day');
});

test('an estimate in a unit nothing can convert reads unknown, not a plausible number', () => {
  const { p } = fixtureProcess();
  const st = spine.readState(p, 'TRK-10'); st.estimate = { unit: 'story_points', value: 3 }; spine.writeState(p, 'TRK-10', st);
  const html = index(p);
  assert.strictEqual(attr(el(html, 'roll', 'TRK-10'), 'data-overrun'), 'unknown');
  assert.ok(/not understood/.test((html.match(/data-roll="TRK-10"[\s\S]*?<\/tr>/) || [])[0]), 'the row names the unit it could not convert');
});

test('a conflict that was resolved and merged no longer offers a rebase', () => {
  const { p } = fixtureProcess();
  // The last merge attempt conflicted, then the PR landed. Any-of over the history said conflict
  // forever and offered a rebase of a merged branch.
  timeEvents(p, 'TRK-12', [{ what: 'finished', step: 'merge', outcome: 'conflict', ts: '2026-09-16T11:30:00.000Z' }]);
  patchState(p, 'TRK-12', (st) => { st.status = 'in_progress'; st.steps.merge.status = 'in_progress'; st.current_step = 'merge'; });
  assert.ok(el(index(p), 'need', 'conflict'), 'the conflict is live while it is live');
  receipt(p, 'TRK-12', { step: 'merge', kind: 'gh', name: 'merged', ref: 'https://github.com/example-org/greenhouse/pull/43', result: 'pass' });
  const after = index(p);
  const items = (after.match(/data-need="conflict" data-card="([^"]*)"/g) || []).join(' ');
  assert.ok(!items.includes('TRK-12'), 'a landed PR settles it — no rebase offered on a merged branch');
});

test('a wave that could not be computed reads unknown, never clear', () => {
  const { p } = tmpEffortWith((e) => { e.cards.push({ id: '../escape', title: 'malformed' }); });
  const html = index(p);
  assert.ok(el(html, 'need', 'fan-unavailable'), 'the failure is a needs-a-human item');
  const n = (html.match(/<li class="node" data-node="TRK-16"[\s\S]*?<\/li>/) || [])[0] || '';
  assert.ok(n, 'the node still renders');
  assert.ok(!/class="clear"/.test(n), 'a card whose hold nobody could compute does not claim to be clear');
  assert.ok(/data-edge="unknown"/.test(n), 'it says the reason is unknown');
  assert.strictEqual(attr(el(html, 'node', 'TRK-16'), 'data-edges'), 'unknown');
});

test('the contention item states the choice and claims no action, because nothing implements one', () => {
  const { p } = fixtureProcess();
  const html = index(p);
  const held = el(html, 'need', 'contention');
  assert.strictEqual(attr(held, 'data-action'), 'none', 'the affordance is declared absent');
  const item = (html.match(/data-need="contention"[\s\S]*?<\/li>/) || [])[0];
  assert.ok(/held/.test(item) && item.includes('packages/resolvers'), 'the fact is still reported in full');
  assert.ok(/No command takes this decision yet/.test(item), 'and the page says no button does it');
});

test('a reference with no last-indexed date is the stalest one, and says so', () => {
  const { p } = tmpEffortWith((e) => { e.references = [{ id: 'never-kb' }]; });
  const item = el(index(p), 'need', 'stale-reference');
  assert.ok(item, 'a reference nobody has indexed is not silent');
  assert.strictEqual(attr(item, 'data-why'), 'never-indexed');
});

test('references on a board with no events are unchecked, not fresh', () => {
  // A fresh effort, before anything has run, is exactly when a plan is written against a reference.
  const p = tmpProcess();
  const ef = path.join(p, 'efforts', 'greenhouse.yaml');
  const e = yaml.parse(fs.readFileSync(ef, 'utf8'));
  e.references = [{ id: 'code-kb', last_indexed: new Date().toISOString() }];
  fs.writeFileSync(ef, yaml.stringify(e));
  const item = el(index(p), 'need', 'stale-reference');
  assert.ok(item, 'the strip is not empty just because no run has emitted an event');
  assert.strictEqual(attr(item, 'data-why'), 'unmeasurable');
});

test('an unreadable effort ledger says so — it does not report zero decisions', () => {
  const { p } = fixtureProcess();
  fs.writeFileSync(path.join(p, 'efforts', 'greenhouse', 'events.jsonl'), 'not json at all\n{"id":"e1"}\n');
  const html = index(p);
  assert.strictEqual(attr(el(html, 'entry', 'brain'), 'data-decisions'), 'unknown', 'a count nobody could take is not zero');
  assert.ok(el(html, 'need', 'ledger-unreadable'), 'and it reaches the needs strip');
  assert.ok(el(html, 'log', 'unreadable'), 'the decision log says what is missing');
});

test('the footnote says what the number does not measure', () => {
  const { p } = fixtureProcess();
  const html = index(p);
  assert.ok(/LOWER BOUND/.test(html), 'an open step is a floor, and the page says the word');
  assert.ok(/left out of the effort total rather than counted as zero/.test(html), 'and that a run with no data is excluded');
});

// ---- T30: the page is the approved DESIGN, not D9's sections on the old table styling ---------
// The card that built the index (T10) was briefed on D9's structure and never shown the design it
// was drawn for. These assertions are about the design: which tokens the page is painted in, the
// shell it is laid out on, the fan as a picture, and the two pieces that are `:target` sections
// because the page is a file on disk with no server behind it.
const styleOf = (p) => { const h = page(p); return h.slice(h.indexOf('<style>'), h.indexOf('</style>')); };
const block = (css, re) => { const m = css.match(re); return m ? m[1] : null; };
const propsIn = (s) => new Set((String(s).match(/--[a-z0-9-]+(?=:)/g) || []));

test('T30: the index is painted in the design\'s tokens, and every colour token is defined for light, for a dark system and for a dark stamp', () => {
  const css = styleOf(fixtureProcess().p);
  const light = block(css, /^:root\{([^}]*)\}/m);
  const system = block(css, /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme="light"\]\)\{([^}]*)\}/);
  const stamped = block(css, /:root\[data-theme="dark"\]\{([^}]*)\}/);
  assert.ok(light && system && stamped, 'all three token blocks are present');
  // The palette itself, not just "some tokens": the accent and the human hue are the two the
  // design hangs on, and a page that kept the old palette would pass a weaker check.
  assert.match(light, /--accent:#1F7A6D/);
  assert.match(light, /--human:#7E3F8F/);
  // Every token the light block defines, apart from the two font stacks, is redefined in BOTH dark
  // blocks. One missing token is a page that reads dark with a white panel in it.
  const fonts = new Set(['--mono', '--sans']);
  for (const name of propsIn(light)) {
    if (fonts.has(name)) continue;
    assert.ok(propsIn(system).has(name), `${name} has a value for a dark system`);
    assert.ok(propsIn(stamped).has(name), `${name} has a value under data-theme="dark"`);
  }
  assert.match(system, /color-scheme:dark/);
  assert.match(stamped, /color-scheme:dark/);
  // And nothing outside those blocks names a colour of its own: a literal in a rule is a colour
  // that cannot follow the theme.
  const rules = css.slice(css.indexOf('*{box-sizing:border-box}'));
  assert.deepStrictEqual([...new Set(rules.match(/#[0-9A-Fa-f]{3,8}\b/g) || [])], [], 'no colour literal outside the token blocks');
});

test('T30: the page is laid out on the shell — the roster is the left column, the needs strip and the picture are the main one', () => {
  const html = index(fixtureProcess().p);
  // Sliced by position rather than by a paired regex: the columns nest, and a non-greedy match
  // for their closing tags would stop at the first inner one and prove nothing about the rest.
  assert.ok(html.includes('<div class="shell">'), 'an effort is drawn on the shell');
  const leftAt = html.indexOf('<aside class="left">');
  const mainAt = html.indexOf('<div class="main">');
  assert.ok(leftAt !== -1 && mainAt !== -1 && leftAt < mainAt, 'the left column comes before the main one');
  const left = html.slice(leftAt, html.indexOf('</aside>', leftAt));
  const main = html.slice(mainAt);
  assert.ok(/<ul class="roster">/.test(left), 'the roster is in the left column');
  assert.ok(/class="legend-ico"/.test(left), 'and the state-icon legend is under it');
  assert.ok(!/<ul class="roster">/.test(main), 'the roster is not repeated inside the main column');
  const order = (s) => main.indexOf(s);
  assert.ok(order('class="topbar"') < order('class="needs-strip"'), 'the main column opens with the topbar, then the needs band');
  assert.ok(order('class="needs-strip"') < order('data-view="graph"'), 'and the picture comes after the band');
  assert.ok(order('data-view="graph"') < order('data-roll='), 'the roll-up is under the picture');
});

test('T30: the fan is drawn — one node per card, a wire per dependency, a wire per overlap, and the same edges as text underneath', () => {
  const html = index(fixtureProcess().p);
  const svg = (html.match(/<svg class="dag"[\s\S]*?<\/svg>/) || [])[0] || '';
  assert.ok(svg, 'the graph view carries a drawing');
  assert.strictEqual(countOf(svg, /data-svg-node="/g), countOf(html, /<li class="node"/g), 'every card in the list is a node in the picture');
  // TRK-11 declares `after: TRK-10`, so the picture carries that wire and says what it waits for.
  assert.match(svg, /class="wire hold"/, 'an unmet dependency is drawn as a held wire');
  assert.ok(svg.includes('waits for TRK-10'), 'and the wire is labelled with the card it waits for');
  // TRK-18 shares packages/resolvers with TRK-16: contention is its own kind of wire.
  assert.match(svg, /class="wire contend"/, 'a file overlap is a different wire');
  assert.ok(svg.includes('shares packages/resolvers'), 'labelled with the shared path');
  // A card at the owner's gate carries the design's diamond.
  assert.match(svg, /class="human-mark"/, 'a card waiting on a person is marked');
  assert.ok(svg.includes('href="#d-greenhouse-TRK-11"'), 'a node opens that card\'s detail view');
  // The text list stays: the picture is not the only copy of the answer.
  assert.ok(el(html, 'node', 'TRK-11'), 'the edge list is still rendered');
});

test('T30: the detail view and the artifact drawer are closed at rest, and the drawer carries the artifact the ledger recorded', () => {
  const { p } = fixtureProcess();
  const html = index(p);
  const css = styleOf(p);
  assert.match(css, /\.detail\{display:none\}/, 'a detail view is closed until it is the target');
  assert.match(css, /\.detail:target\{display:grid/);
  assert.match(css, /\.drawer\{display:none\}/, 'and so is the drawer, so the page at rest is the overview');
  assert.match(css, /\.drawer:target\{display:flex/);
  assert.ok(el(html, 'detail', 'TRK-10'), 'each card has a detail view');
  assert.ok(el(html, 'detail', 'TRK-14'), 'including one with no run');
  const drawer = (html.match(/<aside class="drawer" id="art-greenhouse-TRK-10-pre-pr-summary"[\s\S]*?<\/aside>/) || [])[0] || '';
  assert.ok(drawer, 'the pre-PR page TRK-10 published has a viewer');
  assert.ok(drawer.includes('https://pages.example/pre-pr-10'), 'which links the artifact itself');
  assert.ok(/class="scrim"/.test(drawer), 'and a scrim that closes it');
  const rost = (html.match(/data-rost="TRK-10"[\s\S]*?<\/li>/) || [])[0] || '';
  assert.ok(rost.includes('href="#art-greenhouse-TRK-10-pre-pr-summary"'), 'the roster chip opens that viewer');
  assert.ok(!html.includes('id="art-greenhouse-TRK-14'), 'a card with no run publishes nothing, so it has no viewer');
});

test('T30: the roll-up bar is drawn only from two numbers — a missing half is named, never filled in', () => {
  const html = index(fixtureProcess().p);
  const row = (id) => (html.match(new RegExp(`data-roll="${id}"[\\s\\S]*?</tr>`)) || [])[0] || '';
  const over = row('TRK-10');
  assert.match(over, /class="vb"/, 'a measured card gets a bar');
  assert.match(over, /class="e"/, 'the estimate is the dashed outline');
  assert.match(over, /class="a over"/, 'and an over-run fills it in the over colour');
  // TRK-15 is launched with an estimate and no time events at all.
  const none = row('TRK-15');
  assert.match(none, /class="e"/, 'the estimate it does have is still drawn');
  assert.ok(!/class="a /.test(none), 'but nothing is filled for an actual that was never measured');
  assert.ok(/no actual measured/.test(none), 'and the bar says which half is missing');
});

test('T30: a roster entry is a drawn state icon with a name in words, and only a card waiting on a person carries the notch', () => {
  const html = index(fixtureProcess().p);
  const rost = (id) => (html.match(new RegExp(`<li class="rost" data-rost="${id}"[\\s\\S]*?</li>`)) || [])[0] || '';
  assert.match(rost('TRK-10'), /<svg viewBox="0 0 16 16"/, 'the state is drawn, not spelled with a punctuation mark');
  assert.match(rost('TRK-10'), /aria-label="[^"]*needs you"/, 'and named for a reader who cannot see it');
  assert.match(rost('TRK-10'), /class="nb"/, 'a card at a gate carries the needs-you notch');
  assert.ok(!/class="nb"/.test(rost('TRK-12')), 'a finished card does not');
  assert.match(rost('TRK-12'), /aria-label="finished"/);
  assert.match(rost('TRK-14'), /aria-label="not launched"/, 'and a card with no run says so');
});

test('T30: a needs item says since when, and takes the time from the ledger rather than the clock', () => {
  const { p } = fixtureProcess();
  const conflict = (index(p).match(/data-need="conflict"[\s\S]*?<\/li>/) || [])[0] || '';
  assert.ok(conflict, 'the conflict item renders');
  assert.match(conflict, /class="kind"/, 'the item carries its kind');
  assert.match(conflict, /class="since"/, 'and since when it has been waiting');
  // TRK-10's facts snapshot is stamped 2026-09-16T11:00 — the strip reads that, so two renders
  // an hour apart are the same page.
  assert.ok(conflict.includes('since 09-16 11:00'), 'the timestamp is the facts snapshot the ledger holds');
});
