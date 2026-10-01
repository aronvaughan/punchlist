'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const spine = require('../lib/spine');
const yaml = require('../lib/yaml');
const render = require('../lib/render');
const FIX = path.join(__dirname, 'fixtures', 'spine');
const PLT = path.join(__dirname, '..', 'bin', 'plt');

function tmpProcess() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-'));
  fs.cpSync(FIX, path.join(root, 'process'), { recursive: true });
  return path.join(root, 'process');
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

function writeInputs(p, runId, inputs) {
  fs.writeFileSync(path.join(p, 'runs', runId, 'inputs.yaml'), yaml.stringify(inputs));
}
function patchState(p, runId, fn) {
  const st = spine.readState(p, runId); fn(st); spine.writeState(p, runId, st);
}
function receipt(p, runId, ev) {
  const st = spine.readState(p, runId);
  return spine.recordReceipt(p, runId, { pin: st.pin, ...ev });
}

// Two runs of the greenhouse effort. TRK-10 is at the owner's `approve` gate (ready, human gate)
// with a PR receipt and a facts snapshot; TRK-12 is closed, has a PR receipt, and no snapshot.
function fixtureProcess() {
  const p = tmpProcess();
  const repo = tmpRepo();
  fs.writeFileSync(path.join(p, 'config', 'zz-render-test.yaml'), yaml.stringify({ actors: { humans: ['pat'] } }));

  spine.launchRun(p, { runId: 'TRK-10', cycle: 'build-and-ship', repoDir: repo, owner: 'pat', estimate: 0.25 });
  writeInputs(p, 'TRK-10', { card: 'TRK-10', title: 'rename the sampler', effort: 'greenhouse' });
  receipt(p, 'TRK-10', { step: 'pre-pr', kind: 'artifact', name: 'pre-pr-summary', ref: 'https://pages.example/pre-pr-10' });
  receipt(p, 'TRK-10', { step: 'pre-pr', kind: 'artifact', name: 'run-TRK-10', ref: 'https://pages.example/run-TRK-10' });
  receipt(p, 'TRK-10', { step: 'pre-pr', kind: 'gh', name: 'pr:create', ref: 'https://github.com/example-org/greenhouse/pull/42', result: 'pass' });
  patchState(p, 'TRK-10', (st) => {
    for (const id of ['scope', 'build', 'review', 'write-review', 'pre-pr']) { st.steps[id].status = 'done'; st.steps[id].finished = '2026-09-16T10:00:00.000Z'; }
    st.steps.approve.status = 'ready';
    st.current_step = null;
    st.facts = { at: '2026-09-16T11:00:00.000Z', headSha: 'abc1234def5678', state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED',
      mergeStateStatus: 'DIRTY', checks: { total: 3, pass: 2, fail: 0, pending: 1 }, threadsUnresolved: 0, cursor: null };
  });

  spine.launchRun(p, { runId: 'TRK-12', cycle: 'build-and-ship', repoDir: repo, owner: 'pat', estimate: 1 });
  writeInputs(p, 'TRK-12', { card: 'TRK-12', title: 'test resolver', effort: 'greenhouse' });
  receipt(p, 'TRK-12', { step: 'open-pr', kind: 'gh', name: 'pr:create', ref: 'https://github.com/example-org/greenhouse/pull/43', result: 'pass' });
  patchState(p, 'TRK-12', (st) => {
    for (const id of Object.keys(st.steps)) { st.steps[id].status = 'done'; }
    st.current_step = null; st.status = 'closed'; st.closed = '2026-09-16T12:00:00.000Z';
  });
  return { p, repo };
}

test('renderIndex: both runs, wave line, needs-you banner for a ready owner gate, dimmed closed run, PR link from a receipt ref, card link from config', () => {
  const { p } = fixtureProcess();
  const cfg = spine.loadConfig(p);
  const html = render.renderIndex(p, cfg);
  assert.ok(html.includes('TRK-10') && html.includes('TRK-12'), 'both run ids');
  assert.ok(html.includes('<b>Wave:</b>'), 'wave line');
  assert.ok(html.includes('Needs you (1)'), 'needs-you banner');
  assert.ok(html.includes('plt gate approve TRK-10 approve --by human:pat'), 'the owner gate is the next command');
  assert.ok(/<tr class="done"><td><a href="https:\/\/tracker\.example\/TRK-12"/.test(html), 'closed run row is dimmed and links the card');
  assert.ok(html.includes('<a href="https://github.com/example-org/greenhouse/pull/42">#42</a> APPROVED'), 'PR link from the receipt ref + facts decision');
  assert.ok(html.includes('🔀 conflict'), 'DIRTY merge state from the facts snapshot');
  assert.ok(html.includes('<a href="https://github.com/example-org/greenhouse/pull/43">#43</a> not collected yet'), 'no facts → not collected yet');
  assert.ok(html.includes('https://tracker.example/TRK-10'), 'card link template');
  assert.ok(html.includes('https://pages.example/run-TRK-10'), 'run page from the run-<id> receipt');
  assert.ok(html.includes('https://pages.example/pre-pr-10'), 'pre-PR page link');
  assert.ok(html.includes('Not launched:'), 'not-launched cards');
  assert.ok(!html.includes('gh pr view'), 'the renderer never names gh');
});

test('renderRun: overlap cell, PR facts from the snapshot, and "not collected yet" without one', () => {
  const { p } = fixtureProcess();
  const cfg = spine.loadConfig(p);
  const a = render.renderRun(p, 'TRK-10', cfg);
  assert.ok(a.includes('<dt>Overlap</dt>'), 'overlap cell');
  assert.ok(a.includes('<span class="pill ok">clear</span>'), 'overlap is clear on a fresh worktree');
  assert.ok(a.includes('<a href="https://github.com/example-org/greenhouse/pull/42">#42</a> · OPEN · APPROVED'), 'PR cell from facts');
  assert.ok(a.includes('2 ok · 0 failing · 1 pending of 3'), 'checks tally from facts');
  assert.ok(a.includes('🔀 CONFLICT') && a.includes('head abc1234def'), 'merge state + head from facts');
  assert.ok(a.includes('<dt>Card</dt><dd><a href="https://tracker.example/TRK-10">TRK-10</a>'), 'card link template');
  assert.ok(a.includes('Needs you') && a.includes('plt gate approve TRK-10 approve --by human:pat'), 'owner gate is the next box');
  assert.ok(a.includes('<h2>Steps</h2>') && a.includes('<h2>Handoff</h2>'), 'sections');
  const b = render.renderRun(p, 'TRK-12', cfg);
  assert.ok(b.includes('<a href="https://github.com/example-org/greenhouse/pull/43">#43</a> · not collected yet'), 'PR without facts');
  assert.ok(b.includes('<dt>Checks</dt><dd>not collected yet</dd>'), 'checks without facts');
  assert.ok(b.includes('n/a (closed)'), 'overlap on a closed run');
});

test('renderRun: a touches-drift extrapolation row shows its assumed TEXT — `assumed` is a plain string, not a {value,basis,confidence} object', () => {
  const { p } = fixtureProcess();
  const cfg = spine.loadConfig(p);
  const pin = spine.readState(p, 'TRK-10').pin;
  // The shape stepFinish/touches-drift actually writes: `assumed` is a string.
  spine.appendEvent(p, 'TRK-10', { kind: 'extrapolation', step: 'build', actor: 'agent', pin,
    missing: { scope: 'touches', key: 'lib/sampler.js', where: 'build' },
    assumed: 'touching lib/sampler.js is in scope for the rename' });
  // The older object shape must still render (assumedText covers both).
  spine.appendEvent(p, 'TRK-10', { kind: 'extrapolation', step: 'review', actor: 'agent', pin,
    missing: { scope: 'schema', key: 'review.rubric', where: 'review' },
    assumed: { value: 'the default rubric applies' } });

  const html = render.renderRun(p, 'TRK-10', cfg);
  assert.ok(html.includes('<h2>Extrapolations (schema tuning backlog)</h2>'), 'the section renders');
  assert.ok(html.includes('touching lib/sampler.js is in scope for the rename'),
    'the string form renders its text, not an empty cell:\n' + html.slice(html.indexOf('Extrapolations'), html.indexOf('Extrapolations') + 900));
  assert.ok(html.includes('the default rubric applies'), 'the {value} form still renders');
  assert.ok(html.includes('touches:lib/sampler.js'), 'the missing scope:key cell');
  assert.ok(!/<td>\s*&mdash;\s*<\/td>\s*<td>\s*<\/td>/.test(html), 'no bare em-dash row with an empty trailing cell');
});

test('writeBuild + publishManifest: unchanged pages are not listed; a state change lists its page; --published records the receipt and url', () => {
  const { p } = fixtureProcess();
  const cfg = spine.loadConfig(p);
  const pages = () => render.renderAll(p, cfg);
  const w1 = render.writeBuild(p, pages());
  assert.deepStrictEqual(w1.written.map((x) => path.basename(x.path)).sort(), ['index.html', 'run-TRK-10.html', 'run-TRK-12.html']);
  const m1 = render.publishManifest(p);
  assert.deepStrictEqual(m1.changed.sort(), ['index', 'TRK-10', 'TRK-12'].sort(), 'first manifest: everything is new');
  render.writeBuild(p, pages());
  const m2 = render.publishManifest(p);
  assert.deepStrictEqual(m2.changed, [], 'same state → nothing changed');
  assert.ok(fs.existsSync(path.join(p, 'build', 'publish.json')));

  patchState(p, 'TRK-12', (st) => { st.steps['close-out'].outcome = 'harvested'; });
  render.writeBuild(p, pages());
  const m3 = render.publishManifest(p);
  assert.deepStrictEqual(m3.changed.sort(), ['TRK-12'], 'only the touched run page changed (the index reads no outcome)');

  const r = execFileSync('node', [PLT, 'render', '--published', 'TRK-12', 'https://pages.example/run-TRK-12'], { encoding: 'utf8', env: { ...process.env, PLT_PROCESS_DIR: p } });
  assert.ok(r.includes('run-TRK-12'), r);
  const man = JSON.parse(fs.readFileSync(path.join(p, 'build', 'publish.json'), 'utf8'));
  assert.strictEqual(man.runs['TRK-12'].url, 'https://pages.example/run-TRK-12');
  assert.strictEqual(man.runs['TRK-12'].changed, false, 'published → no longer pending');
  const ev = spine.readEvents(p, 'TRK-12').filter((e) => e.kind === 'artifact' && e.name === 'run-TRK-12');
  assert.strictEqual(ev.length, 1, 'one run-<id> artifact receipt');
  assert.strictEqual(ev[0].ref, 'https://pages.example/run-TRK-12');
  // Recording the same url twice does not duplicate the receipt.
  execFileSync('node', [PLT, 'render', '--published', 'TRK-12', 'https://pages.example/run-TRK-12'], { encoding: 'utf8', env: { ...process.env, PLT_PROCESS_DIR: p } });
  assert.strictEqual(spine.readEvents(p, 'TRK-12').filter((e) => e.kind === 'artifact' && e.name === 'run-TRK-12').length, 1);
});

test('plt render all --out: writes to the given dir and prints the changed list; render run <id>', () => {
  const { p } = fixtureProcess();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'build-'));
  const env = { ...process.env, PLT_PROCESS_DIR: p };
  const r1 = execFileSync('node', [PLT, 'render', 'all', '--out', out], { encoding: 'utf8', env });
  assert.ok(fs.existsSync(path.join(out, 'index.html')) && fs.existsSync(path.join(out, 'run-TRK-10.html')));
  assert.ok(/changed: .*index/.test(r1) && r1.includes('TRK-10'), r1);
  const r2 = execFileSync('node', [PLT, 'render', 'run', 'TRK-10', '--out', out], { encoding: 'utf8', env });
  assert.ok(r2.includes('changed: none'), r2);
  const r3 = execFileSync('node', [PLT, 'render', 'index'], { encoding: 'utf8', env });
  assert.ok(fs.existsSync(path.join(p, 'build', 'index.html')), 'default out is process/build');
  assert.ok(r3.includes('index'), r3);
});

test('render: receipts recorded out of band are counted apart — on the run page, per step, and on the index row', () => {
  const { p, repo } = fixtureProcess();
  const cfg = spine.loadConfig(p);
  // The fixture recorded three receipts on TRK-10 while their steps were pending: all out of band.
  assert.strictEqual(spine.readEvents(p, 'TRK-10').filter((e) => e.out_of_band).length, 3);
  const html = render.renderRun(p, 'TRK-10', cfg);
  assert.ok(html.includes('3 receipts out of band'), 'the Signals line counts them');
  assert.match(html, /<td>pre-pr<\/td>.*?<td class="num">0\/\d+ \(\+3 out of band\)<\/td>/, 'the step row does not count them as seen');
  assert.match(render.renderIndex(p, cfg), /\d+g · \d+r · \d+x · 3o/);
  // A run with only earned receipts shows none.
  spine.launchRun(p, { runId: 'TRK-14', cycle: 'build-and-ship', repoDir: repo, owner: 'pat', estimate: 1 });
  writeInputs(p, 'TRK-14', { card: 'TRK-14', title: 'water the beds', effort: 'greenhouse' });
  assert.ok(!render.renderRun(p, 'TRK-14', cfg).includes('out of band'));
});
