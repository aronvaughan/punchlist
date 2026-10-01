'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process'); // used by the git-backed tests added in later tasks

const spine = require('../lib/spine');
const yaml = require('../lib/yaml');
const FIX = path.join(__dirname, 'fixtures', 'spine');
const PLT = path.join(__dirname, '..', 'bin', 'plt');

function tmpProcess() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-'));
  fs.cpSync(FIX, path.join(root, 'process'), { recursive: true });
  return root;
}

test('findProcessDir walks up to the dir holding process/config', () => {
  const root = tmpProcess();
  const deep = path.join(root, 'code', 'branches', 'x');
  fs.mkdirSync(deep, { recursive: true });
  assert.strictEqual(spine.findProcessDir(deep), path.join(root, 'process'));
  assert.strictEqual(spine.findProcessDir(os.tmpdir()), null);
});

test('loadConfig layers defaults < org < run inputs; lists replace, maps merge', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  // config/sprout.yaml (Task 6 fixture) is always present in FIX and would otherwise outrank
  // acme.yaml alphabetically — remove it here so this test's own org override is the only one.
  fs.rmSync(path.join(p, 'config', 'sprout.yaml'), { force: true });
  fs.writeFileSync(path.join(p, 'config', 'acme.yaml'),
    'review:\n  panel_agents: [acme-reviewer]\njira:\n  project: ACME\n');
  fs.mkdirSync(path.join(p, 'runs', 'TRK-1'), { recursive: true });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-1', 'inputs.yaml'),
    'card: TRK-1\nvars:\n  jira:\n    board: 42\n');
  const cfg = spine.loadConfig(p, 'TRK-1');
  assert.deepStrictEqual(cfg.review.panel_agents, ['acme-reviewer']);   // replaced, not appended
  assert.strictEqual(cfg.jira.project, 'ACME');
  assert.strictEqual(cfg.jira.board, 42);                                // merged in
  assert.strictEqual(cfg.gates.human_signals.includes('artifact-approved'), true); // from defaults
});

test('appendEvent assigns sequential ids and readEvents returns them in order', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  fs.mkdirSync(path.join(p, 'runs', 'TRK-1'), { recursive: true });
  const a = spine.appendEvent(p, 'TRK-1', { kind: 'skill', name: 'x', step: 'build' });
  const b = spine.appendEvent(p, 'TRK-1', { kind: 'tool', name: 'y', step: 'build' });
  assert.strictEqual(a.id, 'e000001');
  assert.strictEqual(b.id, 'e000002');
  assert.deepStrictEqual(spine.readEvents(p, 'TRK-1').map((e) => e.id), ['e000001', 'e000002']);
});

test('readEvents tolerates a truncated trailing line; appendEvent repairs it and continues the sequence', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  const dir = path.join(p, 'runs', 'TRK-1');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  const line1 = JSON.stringify({ id: 'e000001', kind: 'skill', name: 'x', step: 'build' });
  const line2 = JSON.stringify({ id: 'e000002', kind: 'tool', name: 'y', step: 'build' });
  fs.writeFileSync(file, line1 + '\n' + line2 + '\n' + '{"id":"e000003","kind":"t');
  assert.deepStrictEqual(spine.readEvents(p, 'TRK-1').map((e) => e.id), ['e000001', 'e000002']);
  const c = spine.appendEvent(p, 'TRK-1', { kind: 'skill', name: 'z', step: 'build' });
  assert.strictEqual(c.id, 'e000003');
  assert.deepStrictEqual(spine.readEvents(p, 'TRK-1').map((e) => e.id), ['e000001', 'e000002', 'e000003']);
});

test('writeState/readState round-trip with stable key order', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  spine.writeState(p, 'TRK-1', { run: 'TRK-1', steps: { b: { status: 'ready' }, a: { status: 'done' } } });
  const s = spine.readState(p, 'TRK-1');
  assert.strictEqual(s.steps.a.status, 'done');
  assert.match(fs.readFileSync(path.join(p, 'runs', 'TRK-1', 'state.yaml'), 'utf8'), /^run: TRK-1/);
});

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

test('computePin: clean → sha; staged-only → tree with base; unstaged → refused', () => {
  const dir = tmpRepo();
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const headTree = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  assert.deepStrictEqual(spine.computePin(dir), { kind: 'sha', value: head, tree: headTree });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  assert.ok(spine.computePin(dir).refused.some((r) => /a\.txt/.test(r)));
  execFileSync('git', ['-C', dir, 'add', 'a.txt']);
  const tree = spine.computePin(dir);
  assert.strictEqual(tree.kind, 'tree');
  assert.strictEqual(tree.base_sha, head);
  assert.match(tree.value, /^[0-9a-f]{40}$/);
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'x');
  assert.ok(spine.computePin(dir).refused.some((r) => /untracked\.txt/.test(r)));
});

test('compileRequirements expands step keys and resolves config references', () => {
  const step = {
    id: 'review', skills: '{{config.skills.review}}', tools: ['graph_impact'], artifact: 'pre-pr-summary',
    gate: { kind: 'adversarial', agents: '{{config.review.panel_agents}}' },
  };
  const config = { skills: { review: ['skill-a'] }, review: { panel_agents: ['rev-1', 'rev-2'] } };
  assert.deepStrictEqual(spine.compileRequirements(step, config), [
    { kind: 'skill', name: 'skill-a' },
    { kind: 'tool', name: 'graph_impact' },
    { kind: 'artifact', name: 'pre-pr-summary' },
    { kind: 'agent', name: 'rev-1' },
    { kind: 'agent', name: 'rev-2' },
  ]);
  assert.deepStrictEqual(spine.compileRequirements({ id: 'x', gate: { kind: 'human', signal: 's' } }, {}),
    [{ kind: 'gate', name: 's' }]);
});

test('gateCheck: receipts count only at the current pin; agent receipts need verdict pass', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.writeState(p, 'TRK-1', { run: 'TRK-1', repo_dir: repo, steps: { review: {
    status: 'in_progress', receipts_required: [{ kind: 'skill', name: 'k' }, { kind: 'agent', name: 'rev-1' }] } } });
  const pin = spine.computePin(repo);
  spine.recordReceipt(p, 'TRK-1', { step: 'review', kind: 'skill', name: 'k', pin, session: 's1', actor: 'agent' });
  spine.recordReceipt(p, 'TRK-1', { step: 'review', kind: 'agent', name: 'rev-1', pin, session: 's1', actor: 'agent', verdict: 'fail' });
  let g = spine.gateCheck(p, 'TRK-1', 'review', repo);
  assert.strictEqual(g.ok, false);
  assert.deepStrictEqual(g.missing.map((m) => m.name), ['rev-1']);
  spine.recordReceipt(p, 'TRK-1', { step: 'review', kind: 'agent', name: 'rev-1', pin, session: 's1', actor: 'agent', verdict: 'pass' });
  assert.strictEqual(spine.gateCheck(p, 'TRK-1', 'review', repo).ok, true);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n'); execFileSync('git', ['-C', repo, 'add', 'a.txt']);
  g = spine.gateCheck(p, 'TRK-1', 'review', repo);                 // pin moved → receipts stale
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.missing.length, 2);
});

test('gateCheck: a receipt recorded at the staged tree pin still satisfies after that tree is committed', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.writeState(p, 'TRK-1', { run: 'TRK-1', repo_dir: repo, steps: { review: {
    status: 'in_progress', receipts_required: [{ kind: 'skill', name: 'k' }] } } });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['-C', repo, 'add', 'a.txt']);
  const stagedPin = spine.computePin(repo);
  assert.strictEqual(stagedPin.kind, 'tree');
  spine.recordReceipt(p, 'TRK-1', { step: 'review', kind: 'skill', name: 'k', pin: stagedPin, session: 's1', actor: 'agent' });
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'second']);
  const g = spine.gateCheck(p, 'TRK-1', 'review', repo);
  assert.strictEqual(g.ok, true);
});

test('gateApprove writes a pinned gate event and refuses on an unpinnable tree', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.writeState(p, 'TRK-1', { run: 'TRK-1', repo_dir: repo, steps: { approve: {
    status: 'in_review', receipts_required: [{ kind: 'gate', name: 'artifact-approved' }] } } });
  const ev = spine.gateApprove(p, 'TRK-1', 'approve', { by: 'human:lead', repoDir: repo });
  assert.strictEqual(ev.kind, 'gate'); assert.strictEqual(ev.result, 'approve'); assert.strictEqual(ev.pin.kind, 'sha');
  assert.strictEqual(spine.gateCheck(p, 'TRK-1', 'approve', repo).ok, true);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty\n');
  assert.throws(() => spine.gateApprove(p, 'TRK-1', 'approve', { by: 'human:lead', repoDir: repo }), /stage or ignore/);
});

test('recordReceipt refuses to write gate events; only gateApprove may', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  const pin = spine.computePin(repo);
  assert.throws(() => spine.recordReceipt(p, 'TRK-1', { step: 'approve', kind: 'gate', name: 'artifact-approved', pin, session: 's1', actor: 'agent' }),
    /gate events are written only by gateApprove/);
});

test('gateCheck: a forged gate event (actor agent) does not satisfy; gateApprove still does', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.writeState(p, 'TRK-1', { run: 'TRK-1', repo_dir: repo, steps: { approve: {
    status: 'in_review', receipts_required: [{ kind: 'gate', name: 'artifact-approved' }] } } });
  const pin = spine.computePin(repo);
  spine.appendEvent(p, 'TRK-1', { kind: 'gate', step: 'approve', name: 'artifact-approved', result: 'approve', pin, actor: 'agent' });
  assert.strictEqual(spine.gateCheck(p, 'TRK-1', 'approve', repo).ok, false);
  spine.gateApprove(p, 'TRK-1', 'approve', { by: 'human:lead', repoDir: repo });
  assert.strictEqual(spine.gateCheck(p, 'TRK-1', 'approve', repo).ok, true);
});

test('resolveRef throws on an unresolved config reference or a non-config template', () => {
  assert.throws(() => spine.compileRequirements({ id: 'r', gate: { kind: 'adversarial', agents: '{{config.review.panel_agents}}' } }, {}),
    /unresolved config reference/);
  assert.throws(() => spine.compileRequirements({ id: 'r', skills: '{{inputs.x}}' }, {}),
    /only \{\{config\.\*\}\} references are supported/);
});

test('gateApprove requires a non-empty --by and refuses a step already done', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.writeState(p, 'TRK-1', { run: 'TRK-1', repo_dir: repo, steps: { approve: {
    status: 'in_review', receipts_required: [{ kind: 'gate', name: 'artifact-approved' }] } } });
  assert.throws(() => spine.gateApprove(p, 'TRK-1', 'approve', { by: '', repoDir: repo }), /gateApprove needs --by/);
  spine.writeState(p, 'TRK-1', { run: 'TRK-1', repo_dir: repo, steps: { approve: {
    status: 'done', receipts_required: [{ kind: 'gate', name: 'artifact-approved' }] } } });
  spine.appendEvent(p, 'TRK-1', { kind: 'gate', step: 'approve', name: 'artifact-approved', result: 'approve', by: 'human:lead', pin: spine.computePin(repo), actor: 'human' });
  assert.throws(() => spine.gateApprove(p, 'TRK-1', 'approve', { by: 'human:lead', repoDir: repo }), /approve is already done and approved at this pin/);
});

test('gateApprove re-approves a done step when the tree moved on after the approval', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.writeState(p, 'TRK-1', { run: 'TRK-1', repo_dir: repo, steps: { approve: {
    status: 'done', receipts_required: [{ kind: 'gate', name: 'artifact-approved' }] } } });
  spine.appendEvent(p, 'TRK-1', { kind: 'gate', step: 'approve', name: 'artifact-approved', result: 'approve', by: 'human:lead', pin: spine.computePin(repo), actor: 'human' });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['-C', repo, 'add', 'a.txt']);
  assert.strictEqual(spine.gateCheck(p, 'TRK-1', 'approve', repo).ok, false);
  const ev = spine.gateApprove(p, 'TRK-1', 'approve', { by: 'human:lead', repoDir: repo });
  assert.strictEqual(ev.pin.kind, 'tree');
  assert.strictEqual(spine.gateCheck(p, 'TRK-1', 'approve', repo).ok, true);
  assert.strictEqual(spine.readState(p, 'TRK-1').steps.approve.status, 'done');
});

test('gateCheck: missing receipts_required key means no requirements compiled; empty array is ok', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.writeState(p, 'TRK-1', { run: 'TRK-1', repo_dir: repo, steps: { review: { status: 'in_progress' } } });
  let g = spine.gateCheck(p, 'TRK-1', 'review', repo);
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.missing[0].reason, 'no requirements compiled — launch the run with plt');
  spine.writeState(p, 'TRK-1', { run: 'TRK-1', repo_dir: repo, steps: { review: { status: 'in_progress', receipts_required: [] } } });
  assert.strictEqual(spine.gateCheck(p, 'TRK-1', 'review', repo).ok, true);
});

test('launchRun compiles requirements, marks initial steps ready, records estimate once', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  const st = spine.launchRun(p, { runId: 'TRK-7', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  assert.strictEqual(st.steps.scope.status, 'ready');
  assert.strictEqual(st.steps.build.status, 'pending');
  assert.deepStrictEqual(st.steps.review.receipts_required.filter((r) => r.kind === 'agent'), [{ kind: 'agent', name: 'sprout-reviewer' }]);
  assert.deepStrictEqual(st.steps.approve.receipts_required, [{ kind: 'gate', name: 'artifact-approved' }]);
  assert.deepStrictEqual(st.estimate, { unit: 'ideal_days', value: 0.5 });
  assert.throws(() => spine.launchRun(p, { runId: 'TRK-7', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 1 }), /never re-pointed/);
});

test('stepStart/stepFinish: gate + extrapolation rule, dependents become ready', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-7', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  spine.stepStart(p, 'TRK-7', 'scope', { session: 's1' });
  assert.strictEqual(spine.readState(p, 'TRK-7').current_step, 'scope');
  assert.throws(() => spine.stepFinish(p, 'TRK-7', 'scope', { outcome: 'ready' }), /missing receipts/);
  const pin = spine.computePin(repo);
  spine.recordReceipt(p, 'TRK-7', { step: 'scope', kind: 'skill', name: 'sprout-scope', pin, actor: 'agent' });
  spine.recordReceipt(p, 'TRK-7', { step: 'scope', kind: 'artifact', name: 'dispatch-brief', pin, actor: 'agent', ref: 'receipts/brief.md' });
  spine.recordReceipt(p, 'TRK-7', { step: 'scope', kind: 'jira', name: 'on_start:In Progress', pin, actor: 'agent' });
  spine.recordReceipt(p, 'TRK-7', { step: 'scope', kind: 'touches', name: 'declared', pin, actor: 'agent', files: ['x'] });
  assert.throws(() => spine.stepFinish(p, 'TRK-7', 'scope', { outcome: 'ready' }), /extrapolation/);
  const st = spine.stepFinish(p, 'TRK-7', 'scope', { outcome: 'ready', noExtrapolations: true });
  assert.strictEqual(st.steps.scope.status, 'done');
  assert.strictEqual(st.steps.scope.outcome, 'ready');
  assert.strictEqual(st.steps.build.status, 'ready');
  assert.ok(spine.readEvents(p, 'TRK-7').some((e) => e.kind === 'extrapolation' && e.missing.scope === 'none'));
});

test('renderPrime is bounded, leads with the NEXT command, and uses gateCheck for missing/satisfied receipts', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-7', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  spine.writeHandoff(p, 'TRK-7', { goal: 'Keep the probe unit.', next: 'plt step start scope --run TRK-7', verified: [], questions: [] });
  const pin = spine.computePin(repo);
  spine.recordReceipt(p, 'TRK-7', { step: 'scope', kind: 'skill', name: 'sprout-scope', pin, actor: 'agent' });
  const out = spine.renderPrime(p, 'TRK-7');
  const lines = out.split('\n');
  assert.ok(lines.length <= 90);
  assert.match(lines[0], /TRK-7/);
  assert.match(lines[0], /launched at/);
  assert.match(out, /NEXT: plt step start scope --run TRK-7/);
  assert.match(out, /scope .*ready/);
  assert.match(out, /✓ skill sprout-scope/);
  assert.match(out, /MISSING artifact dispatch-brief/);
});

test('launchRun refuses to relaunch an existing run and validates the estimate', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-8', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  assert.throws(() => spine.launchRun(p, { runId: 'TRK-8', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 }), /already launched/);
  assert.throws(() => spine.launchRun(p, { runId: 'TRK-9', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: NaN }), /estimate must be a number/);
});

test('stepFinish refuses a step that is not in_progress or in_review', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-7', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  assert.throws(() => spine.stepFinish(p, 'TRK-7', 'build', { outcome: 'done', noExtrapolations: true }),
    /step build is pending; only in_progress or in_review can be finished/);
});

test('approve step: finish sets in_review; gateApprove settles it to done and readies dependents', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-7', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  const pin = spine.computePin(repo);
  const finish = (step, opts = {}) => spine.stepFinish(p, 'TRK-7', step, { noExtrapolations: true, ...opts });

  spine.stepStart(p, 'TRK-7', 'scope');
  spine.recordReceipt(p, 'TRK-7', { step: 'scope', kind: 'skill', name: 'sprout-scope', pin, actor: 'agent' });
  spine.recordReceipt(p, 'TRK-7', { step: 'scope', kind: 'artifact', name: 'dispatch-brief', pin, actor: 'agent' });
  spine.recordReceipt(p, 'TRK-7', { step: 'scope', kind: 'jira', name: 'on_start:In Progress', pin, actor: 'agent' });
  spine.recordReceipt(p, 'TRK-7', { step: 'scope', kind: 'touches', name: 'declared', pin, actor: 'agent', files: ['x'] });
  finish('scope', { outcome: 'ready' });

  spine.stepStart(p, 'TRK-7', 'build');
  spine.recordReceipt(p, 'TRK-7', { step: 'build', kind: 'skill', name: 'sprout-conventions', pin, actor: 'agent' });
  spine.recordReceipt(p, 'TRK-7', { step: 'build', kind: 'tool', name: 'graph_impact', pin, actor: 'agent' });
  finish('build');

  spine.stepStart(p, 'TRK-7', 'review');
  spine.recordReceipt(p, 'TRK-7', { step: 'review', kind: 'agent', name: 'sprout-reviewer', pin, actor: 'agent', verdict: 'pass' });
  finish('review', { outcome: 'pass' });

  spine.stepStart(p, 'TRK-7', 'write-review');
  spine.recordReceipt(p, 'TRK-7', { step: 'write-review', kind: 'agent', name: 'writing-adversary', pin, actor: 'agent', verdict: 'pass' });
  finish('write-review', { outcome: 'pass' });

  spine.stepStart(p, 'TRK-7', 'pre-pr');
  spine.recordReceipt(p, 'TRK-7', { step: 'pre-pr', kind: 'skill', name: 'sprout-pre-pr', pin, actor: 'agent' });
  spine.recordReceipt(p, 'TRK-7', { step: 'pre-pr', kind: 'artifact', name: 'pre-pr-summary', pin, actor: 'agent' });
  finish('pre-pr');

  spine.stepStart(p, 'TRK-7', 'approve');
  const afterFinish = finish('approve');
  assert.strictEqual(afterFinish.steps.approve.status, 'in_review');

  spine.gateApprove(p, 'TRK-7', 'approve', { by: 'human:lead', repoDir: repo });
  const st = spine.readState(p, 'TRK-7');
  assert.strictEqual(st.steps.approve.status, 'done');
  assert.strictEqual(st.steps['open-pr'].status, 'ready');
  assert.strictEqual(st.current_step, null);
});

test('recompileRun refreshes requirements of unfinished steps only', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-8', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  const before = spine.readState(p, 'TRK-8');
  assert.ok(before.steps['write-review'].receipts_required.some((r) => r.kind === 'agent'));
  before.steps.scope.status = 'done';
  spine.writeState(p, 'TRK-8', before);
  const cfg = path.join(p, 'config', 'sprout.yaml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace(/writing_agents: \[[^\]]*\]/, 'writing_agents: []'));
  const after = spine.recompileRun(p, 'TRK-8');
  assert.strictEqual(after.steps['write-review'].receipts_required.filter((r) => r.kind === 'agent').length, 0);
  assert.strictEqual(after.steps.scope.status, 'done');
  assert.deepStrictEqual(after.steps.scope.receipts_required, before.steps.scope.receipts_required);
  assert.ok(spine.readEvents(p, 'TRK-8').some((e) => e.kind === 'time' && e.what === 'recompiled'));
  assert.throws(() => spine.recompileRun(p, 'TRK-999'), /not launched/);
});

test('recompileRun adds a step that appeared in the formula after launch', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-11', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  const cyc = path.join(p, 'cycles', 'build-and-ship.md');
  const text = fs.readFileSync(cyc, 'utf8');
  fs.writeFileSync(cyc, text.replace('  - id: close-out', '  - id: extra\n    assignee: owner\n    needs: [scope]\n    manual: true\n  - id: close-out'));
  const after = spine.recompileRun(p, 'TRK-11');
  assert.strictEqual(after.steps.extra.status, 'pending');            // scope is not done yet
  assert.deepStrictEqual(after.steps.extra.receipts_required, []);
  after.steps.scope.status = 'done'; spine.writeState(p, 'TRK-11', after);
  assert.strictEqual(spine.recompileRun(p, 'TRK-11').steps.extra.status, 'pending'); // status never downgraded or upgraded once present
});

test('closeRun: refuses before close-out, then retires standing steps and marks the run closed', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-9', cycle: 'build-and-ship', repoDir: repo, owner: 'o', estimate: 1 });
  assert.throws(() => spine.closeRun(p, 'TRK-9'), /close-out is not done/);
  const st = spine.readState(p, 'TRK-9');
  for (const id of Object.keys(st.steps)) st.steps[id].status = id === 'pr-loop' ? 'ready' : 'done';
  st.current_step = null; spine.writeState(p, 'TRK-9', st);
  const closed = spine.closeRun(p, 'TRK-9', { by: 'human:o' });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.steps['pr-loop'].status, 'skipped');
  assert.equal(spine.nextCommand(closed), 'nothing — run closed');
  assert.ok(spine.readEvents(p, 'TRK-9').some((e) => e.what === 'closed' && e.retired.includes('pr-loop')));
});

test('closeRun: a run naming a PR takes a final facts snapshot before closing (T1 — run pages must not show "not collected yet" forever)', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  const GH_FIX = path.join(__dirname, 'fixtures', 'spine', 'gh');
  spine.launchRun(p, { runId: 'TRK-40', cycle: 'build-and-ship', repoDir: repo, owner: 'o', estimate: 1 });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-40', 'inputs.yaml'), yaml.stringify({ card: 'TRK-40', pr_number: 42 }));
  const st = spine.readState(p, 'TRK-40');
  for (const id of Object.keys(st.steps)) st.steps[id].status = 'done';
  st.current_step = null; spine.writeState(p, 'TRK-40', st);
  assert.equal(spine.readState(p, 'TRK-40').facts, undefined);

  const env = process.env.PLT_GH; const fixEnv = process.env.PLT_GH_FIXTURE;
  process.env.PLT_GH = path.join(GH_FIX, 'stub.js');
  process.env.PLT_GH_FIXTURE = path.join(GH_FIX, 'open-green-approved.json');
  try {
    const closed = spine.closeRun(p, 'TRK-40', { by: 'human:o' });
    assert.equal(closed.status, 'closed');
    assert.ok(closed.facts, 'expected a state.facts snapshot to be written before closing');
    assert.equal(closed.facts.headSha, 'aaaa1111');
  } finally {
    if (env === undefined) delete process.env.PLT_GH; else process.env.PLT_GH = env;
    if (fixEnv === undefined) delete process.env.PLT_GH_FIXTURE; else process.env.PLT_GH_FIXTURE = fixEnv;
  }
});

test('closeRun: the final facts snapshot reads the run\'s own inputs.repo, not the config default', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  const GH_FIX = path.join(__dirname, 'fixtures', 'spine', 'gh');
  spine.launchRun(p, { runId: 'TRK-41', cycle: 'build-and-ship', repoDir: repo, owner: 'o', estimate: 1 });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-41', 'inputs.yaml'), yaml.stringify({ card: 'TRK-41', pr_number: 4, repo: 'example-org/greenhouse-lib' }));
  const st = spine.readState(p, 'TRK-41');
  for (const id of Object.keys(st.steps)) st.steps[id].status = 'done';
  st.current_step = null; spine.writeState(p, 'TRK-41', st);
  const log = path.join(root, 'gh.log');
  const saved = { PLT_GH: process.env.PLT_GH, PLT_GH_FIXTURE: process.env.PLT_GH_FIXTURE, PLT_GH_LOG: process.env.PLT_GH_LOG };
  process.env.PLT_GH = path.join(GH_FIX, 'stub.js');
  process.env.PLT_GH_FIXTURE = path.join(GH_FIX, 'open-green-approved.json');
  process.env.PLT_GH_LOG = log;
  try {
    const closed = spine.closeRun(p, 'TRK-41', { by: 'human:o' });
    assert.ok(closed.facts, 'expected a state.facts snapshot');
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const view = calls.find((a) => a[0] === 'pr' && a[1] === 'view');
    assert.strictEqual(view[view.indexOf('--repo') + 1], 'example-org/greenhouse-lib');
    assert.ok(!calls.some((a) => a.includes('example-org/greenhouse') || a.includes('repo=greenhouse')), JSON.stringify(calls));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('closeRun: a gh failure during the final facts snapshot is a warning naming the run, never a block', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  const GH_FIX = path.join(__dirname, 'fixtures', 'spine', 'gh');
  spine.launchRun(p, { runId: 'TRK-42', cycle: 'build-and-ship', repoDir: repo, owner: 'o', estimate: 1 });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-42', 'inputs.yaml'), yaml.stringify({ card: 'TRK-42', pr_number: 42 }));
  const st = spine.readState(p, 'TRK-42');
  for (const id of Object.keys(st.steps)) st.steps[id].status = 'done';
  st.current_step = null; spine.writeState(p, 'TRK-42', st);
  const saved = { PLT_GH: process.env.PLT_GH, PLT_GH_FIXTURE: process.env.PLT_GH_FIXTURE, PLT_GH_FAIL_PR: process.env.PLT_GH_FAIL_PR };
  process.env.PLT_GH = path.join(GH_FIX, 'stub.js');
  process.env.PLT_GH_FIXTURE = path.join(GH_FIX, 'open-green-approved.json');
  process.env.PLT_GH_FAIL_PR = '42';   // the stub answers 404 for this PR
  const warnings = [];
  try {
    const closed = spine.closeRun(p, 'TRK-42', { by: 'human:o', warn: (m) => warnings.push(m) });
    assert.equal(closed.status, 'closed');
    assert.equal(closed.facts, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /TRK-42: final facts snapshot skipped — .*404/);
    assert.match(warnings[0], /plt facts --run TRK-42/);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('closeRun: a run with no PR closes cleanly and writes no facts snapshot (never throws because GitHub is unreachable)', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-41', cycle: 'build-and-ship', repoDir: repo, owner: 'o', estimate: 1 });
  const st = spine.readState(p, 'TRK-41');
  for (const id of Object.keys(st.steps)) st.steps[id].status = 'done';
  st.current_step = null; spine.writeState(p, 'TRK-41', st);
  const env = process.env.PLT_GH;
  process.env.PLT_GH = path.join(__dirname, 'fixtures', 'spine', 'gh', 'nonexistent-binary-xyz');   // would throw ENOENT if ever called
  try {
    const closed = spine.closeRun(p, 'TRK-41', { by: 'human:o' });
    assert.equal(closed.status, 'closed');
    assert.equal(closed.facts, undefined);
  } finally {
    if (env === undefined) delete process.env.PLT_GH; else process.env.PLT_GH = env;
  }
});

test('gateApprove: a re-approval on a moved tree needs the formula\'s reapprove artifact at the new pin', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-11', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  // Park approve as done + approved at the current pin (the first approval, with its pre-pr page).
  const st = spine.readState(p, 'TRK-11');
  st.steps.approve.status = 'done';
  spine.writeState(p, 'TRK-11', st);
  spine.appendEvent(p, 'TRK-11', { kind: 'gate', step: 'approve', name: 'artifact-approved', result: 'approve', by: 'human:lead', pin: spine.computePin(repo), actor: 'human' });
  assert.throws(() => spine.gateApprove(p, 'TRK-11', 'approve', { by: 'human:lead', repoDir: repo }), /already done and approved at this pin/);
  // A follow-on change (a CI fix) moves the tree: re-approval is refused until fix-summary exists there.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  execFileSync('git', ['-C', repo, 'add', 'a.txt']);
  assert.throws(() => spine.gateApprove(p, 'TRK-11', 'approve', { by: 'human:lead', repoDir: repo }), /follow-on change needs its own page.*fix-summary/);
  const pin = spine.computePin(repo);
  spine.recordReceipt(p, 'TRK-11', { step: 'approve', kind: 'artifact', name: 'fix-summary', pin, actor: 'agent' });
  const ev = spine.gateApprove(p, 'TRK-11', 'approve', { by: 'human:lead', repoDir: repo });
  assert.equal(ev.result, 'approve');
  assert.equal(ev.pin.value, pin.value);
});

test('gateRevoke cancels a named approval and reopens a step it had settled; approve refuses a non-human --by', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.writeState(p, 'TRK-12', { run: 'TRK-12', repo_dir: repo, steps: { approve: {
    status: 'in_review', receipts_required: [{ kind: 'gate', name: 'artifact-approved' }] } } });
  const ok = spine.gateApprove(p, 'TRK-12', 'approve', { by: 'human:lead', repoDir: repo });
  assert.equal(spine.gateCheck(p, 'TRK-12', 'approve', repo).ok, true);
  const rv = spine.gateRevoke(p, 'TRK-12', 'approve', { by: 'human:lead', eventId: ok.id, reason: 'written by a probe' });
  assert.equal(rv.result, 'revoke'); assert.equal(rv.revokes, ok.id);
  assert.equal(spine.gateCheck(p, 'TRK-12', 'approve', repo).ok, false);
  assert.throws(() => spine.gateRevoke(p, 'TRK-12', 'approve', { by: 'human:lead', eventId: 'e999999' }), /not an approval/);
  // With a humans list in config, an unknown --by is refused.
  fs.mkdirSync(path.join(p, 'config'), { recursive: true });
  fs.writeFileSync(path.join(p, 'config', 'defaults.yaml'), 'actors:\n  humans: [lead]\n');
  assert.throws(() => spine.gateApprove(p, 'TRK-12', 'approve', { by: 'probe', repoDir: repo }), /not a human in config.actors.humans/);
  assert.equal(spine.gateApprove(p, 'TRK-12', 'approve', { by: 'lead', repoDir: repo }).result, 'approve');
});

// Cheapest way to reach pre-pr in_progress (per the neighbouring ad-hoc tests): write the state
// directly with just the receipts pre-pr itself needs, rather than walking every earlier step.
function walkToPrePr(p, runId, repo, { touchesFiles, laterTouches } = {}) {
  spine.writeState(p, runId, { run: runId, cycle: 'build-and-ship', repo_dir: repo, steps: { 'pre-pr': {
    status: 'in_progress', receipts_required: [{ kind: 'skill', name: 'sprout-pre-pr' }, { kind: 'artifact', name: 'pre-pr-summary' }] } } });
  if (touchesFiles) {
    const declPin = spine.computePin(repo);
    spine.appendEvent(p, runId, { kind: 'touches', step: 'scope', name: 'declared', pin: declPin, actor: 'agent', files: touchesFiles });
  }
  if (laterTouches) spine.appendEvent(p, runId, { kind: 'touches', name: 'declared', pin: spine.computePin(repo), actor: 'agent', ...laterTouches });

  // Stage the actual work after the declared touches (if any); pre-pr's own receipts must be
  // recorded at the fresh (staged) pin.
  fs.mkdirSync(path.join(repo, 'packages', 'other'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'packages', 'other', 'x.ts'), 'x\n');
  fs.mkdirSync(path.join(repo, 'packages', 'sensors'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'packages', 'sensors', 'y.ts'), 'y\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  const stagedPin = spine.computePin(repo);

  spine.recordReceipt(p, runId, { step: 'pre-pr', kind: 'skill', name: 'sprout-pre-pr', pin: stagedPin, actor: 'agent' });
  spine.recordReceipt(p, runId, { step: 'pre-pr', kind: 'artifact', name: 'pre-pr-summary', pin: stagedPin, actor: 'agent' });
  spine.stepFinish(p, runId, 'pre-pr', { noExtrapolations: true });
}

test('pre-pr settle records a touches-drift extrapolation for each file outside the declared prefixes', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  walkToPrePr(p, 'TRK-13', repo, { touchesFiles: ['packages/sensors'] });
  const events = spine.readEvents(p, 'TRK-13');
  const drift = events.filter((e) => e.kind === 'extrapolation' && e.missing && e.missing.key === 'touches-drift');
  assert.strictEqual(drift.length, 1);
  assert.match(drift[0].assumed, /packages\/other\/x\.ts/);
  assert.ok(!drift.some((e) => /packages\/sensors\/y\.ts/.test(e.assumed)));
});

test('pre-pr settle measures drift against the scope step\'s touches, not a later touches event from another step', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  walkToPrePr(p, 'TRK-15', repo, { touchesFiles: ['packages/sensors'], laterTouches: { step: 'build', files: ['packages'] } });
  const drift = spine.readEvents(p, 'TRK-15').filter((e) => e.kind === 'extrapolation' && e.missing && e.missing.key === 'touches-drift');
  assert.strictEqual(drift.length, 1);
  assert.match(drift[0].assumed, /packages\/other\/x\.ts outside declared packages\/sensors/);
});

test('pre-pr settle records no drift when no touches receipt was recorded', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  walkToPrePr(p, 'TRK-14', repo, {});
  const events = spine.readEvents(p, 'TRK-14');
  const drift = events.filter((e) => e.kind === 'extrapolation' && e.missing && e.missing.key === 'touches-drift');
  assert.strictEqual(drift.length, 0);
});

test('a re-approval re-arms the steps named in reapprove.rearm (the owner asks for reviews again)', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-13', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  const st = spine.readState(p, 'TRK-13');
  st.steps.approve.status = 'done'; st.steps.announce.status = 'done'; st.steps.announce.outcome = 'done';
  spine.writeState(p, 'TRK-13', st);
  spine.appendEvent(p, 'TRK-13', { kind: 'gate', step: 'approve', name: 'artifact-approved', result: 'approve', by: 'human:lead', pin: spine.computePin(repo), actor: 'human' });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n'); execFileSync('git', ['-C', repo, 'add', 'a.txt']);
  const pin = spine.computePin(repo);
  spine.recordReceipt(p, 'TRK-13', { step: 'approve', kind: 'artifact', name: 'fix-summary', pin, actor: 'agent' });
  spine.gateApprove(p, 'TRK-13', 'approve', { by: 'human:lead', repoDir: repo });
  const after = spine.readState(p, 'TRK-13');
  assert.equal(after.steps.announce.status, 'ready');
  assert.ok(spine.renderBanners(p, 'TRK-13').some((b) => /SLACK FOR REVIEWS/.test(b)));
});

test('pollRun arms a gh-conditioned step on DIRTY and disarms it when clean; needs still gate it', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-14', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  let st = spine.readState(p, 'TRK-14');
  assert.equal(st.steps.resync.status, 'pending');            // never ready from needs alone
  assert.deepEqual(spine.pollRun(p, 'TRK-14', { mergeStateStatus: 'DIRTY' }).armed, []); // open-pr not done yet
  st = spine.readState(p, 'TRK-14');                          // the poll wrote its snapshot since
  st.steps['open-pr'].status = 'done'; spine.writeState(p, 'TRK-14', st);
  assert.deepEqual(spine.pollRun(p, 'TRK-14', { mergeStateStatus: 'DIRTY' }).armed, ['resync']);
  assert.equal(spine.readState(p, 'TRK-14').steps.resync.status, 'ready');
  assert.ok(spine.renderBanners(p, 'TRK-14').some((b) => /MERGE CONFLICT/.test(b)));
  assert.deepEqual(spine.pollRun(p, 'TRK-14', { mergeStateStatus: 'CLEAN' }).disarmed, ['resync']);
  assert.equal(spine.readState(p, 'TRK-14').steps.resync.status, 'pending');
  // A settled resync re-arms on the next conflict.
  st = spine.readState(p, 'TRK-14'); st.steps.resync.status = 'done'; spine.writeState(p, 'TRK-14', st);
  assert.deepEqual(spine.pollRun(p, 'TRK-14', { mergeStateStatus: 'DIRTY' }).armed, ['resync']);
});

test('pre-pr settle: drift is measured from the branch base — a change COMMITTED after scope (sha pin, clean tree, no remote) still extrapolates', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-21', cycle: 'build-and-ship', repoDir: repo, owner: 'o', estimate: 1 });
  const st = spine.readState(p, 'TRK-21');
  assert.equal(st.pin.kind, 'sha');
  spine.appendEvent(p, 'TRK-21', { kind: 'touches', step: 'scope', name: 'declared', pin: st.pin, actor: 'agent', files: ['packages/sensors'] });
  fs.mkdirSync(path.join(repo, 'packages', 'other'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'packages', 'other', 'x.ts'), 'x\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'outside the declared touches']);
  const pin = spine.computePin(repo);
  assert.equal(pin.kind, 'sha');
  st.steps['pre-pr'] = { status: 'in_progress', receipts_required: [{ kind: 'skill', name: 'sprout-pre-pr' }, { kind: 'artifact', name: 'pre-pr-summary' }] };
  spine.writeState(p, 'TRK-21', st);
  spine.recordReceipt(p, 'TRK-21', { step: 'pre-pr', kind: 'skill', name: 'sprout-pre-pr', pin, actor: 'agent' });
  spine.recordReceipt(p, 'TRK-21', { step: 'pre-pr', kind: 'artifact', name: 'pre-pr-summary', pin, actor: 'agent' });
  spine.stepFinish(p, 'TRK-21', 'pre-pr', { noExtrapolations: true });
  const drift = spine.readEvents(p, 'TRK-21').filter((e) => e.kind === 'extrapolation' && e.missing && e.missing.key === 'touches-drift');
  assert.strictEqual(drift.length, 1);
  assert.match(drift[0].assumed, /packages\/other\/x\.ts/);
});

test('reviewFacts: author reply after our review arms follow-up; head movement arms re-review; bots and our own comments do not', () => {
  const base = { ours: 'us', prAuthor: 'them', headRefOid: 'aaa' };
  const ourReview = { author: { login: 'us' }, submittedAt: '2026-09-16T10:00:00Z', commit: { oid: 'aaa' } };
  assert.equal(spine.reviewFacts({ ...base, reviews: [] }).ourReviewPosted, false);
  let f = spine.reviewFacts({ ...base, reviews: [ourReview], comments: [{ author: { login: 'us' }, createdAt: '2026-09-16T11:00:00Z' }, { author: { login: 'github-actions' }, createdAt: '2026-09-16T11:00:00Z' }] });
  assert.equal(f.authorRepliedSinceOurReview, false); assert.equal(f.headMovedSinceOurReview, false);
  f = spine.reviewFacts({ ...base, reviews: [ourReview], reviewComments: [{ user: { login: 'them' }, created_at: '2026-09-16T11:00:00Z' }] });
  assert.equal(f.authorRepliedSinceOurReview, true);
  f = spine.reviewFacts({ ...base, reviews: [ourReview], reviewComments: [{ user: { login: 'them' }, created_at: '2026-09-16T09:00:00Z' }] });
  assert.equal(f.authorRepliedSinceOurReview, false, 'a reply before our review is not a follow-up');
  f = spine.reviewFacts({ ...base, headRefOid: 'bbb', reviews: [ourReview] });
  assert.equal(f.headMovedSinceOurReview, true);
});

test('reviewFacts: our approval is a live fact — standing on the latest verdict review, withdrawn when GitHub dismisses it, untouched by our COMMENTED replies', () => {
  const base = { ours: 'us', prAuthor: 'them', headRefOid: 'bbb' };
  const at = (t) => `2026-09-16T${t}:00Z`;
  const first = { author: { login: 'us' }, state: 'DISMISSED', submittedAt: at('10:00'), commit: { oid: 'aaa' } };
  const replies = [{ author: { login: 'us' }, state: 'COMMENTED', submittedAt: at('12:00'), commit: { oid: 'bbb' } }];
  const approve = { author: { login: 'us' }, state: 'APPROVED', submittedAt: at('12:01'), commit: { oid: 'bbb' } };
  // No review from us: nothing stands, nothing was dismissed.
  let f = spine.reviewFacts({ ...base, reviews: [] });
  assert.equal(f.ourApprovalStanding, false); assert.equal(f.ourApprovalDismissed, false); assert.equal(f.ourApprovalSha, null);
  // Re-approved on the current head after the first review was dismissed by a push.
  f = spine.reviewFacts({ ...base, reviews: [first, ...replies, approve] });
  assert.equal(f.ourApprovalStanding, true); assert.equal(f.ourApprovalSha, 'bbb'); assert.equal(f.ourApprovalOnHead, true);
  assert.equal(f.ourApprovalDismissed, false); assert.equal(f.headMovedSinceOurReview, false);
  // A COMMENTED reply after the approval is not a verdict: the approval still stands.
  f = spine.reviewFacts({ ...base, reviews: [approve, { author: { login: 'us' }, state: 'COMMENTED', submittedAt: at('13:00'), commit: { oid: 'bbb' } }] });
  assert.equal(f.ourApprovalStanding, true);
  // The author pushes: the approval is dismissed by GitHub — standing goes, dismissed is named, re-review's fact fires.
  const dismissedApproval = { ...approve, state: 'DISMISSED' };
  f = spine.reviewFacts({ ...base, headRefOid: 'ccc', reviews: [first, ...replies, dismissedApproval] });
  assert.equal(f.ourApprovalStanding, false); assert.equal(f.ourApprovalSha, null);
  assert.equal(f.ourApprovalDismissed, true); assert.equal(f.headMovedSinceOurReview, true);
  // No dismiss-stale-reviews: the approval stands on an older commit; onHead says so, re-review still arms.
  f = spine.reviewFacts({ ...base, headRefOid: 'ccc', reviews: [first, ...replies, approve] });
  assert.equal(f.ourApprovalStanding, true); assert.equal(f.ourApprovalOnHead, false); assert.equal(f.headMovedSinceOurReview, true);
  // CHANGES_REQUESTED is a verdict too: it is not an approval.
  f = spine.reviewFacts({ ...base, reviews: [{ ...approve, state: 'CHANGES_REQUESTED' }] });
  assert.equal(f.ourApprovalStanding, false); assert.equal(f.ourApprovalDismissed, false);
  // Someone else's approval is not ours.
  f = spine.reviewFacts({ ...base, reviews: [replies[0], { ...approve, author: { login: 'lead' } }] });
  assert.equal(f.ourApprovalStanding, false);
});

test('pollRun keeps the last facts on state.poll — rewritten only when a fact changes, never a status, no steps armed by it', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-40', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  const facts = { mergeStateStatus: 'CLEAN', state: 'OPEN', ourApprovalStanding: true, ourApprovalSha: 'bbb' };
  const r1 = spine.pollRun(p, 'TRK-40', facts);
  assert.deepEqual(r1.armed, []); assert.deepEqual(r1.disarmed, []);
  const st1 = spine.readState(p, 'TRK-40');
  assert.deepEqual(st1.poll.facts, facts);
  assert.ok(st1.poll.at);
  assert.equal(st1.status, 'open', 'approval is a fact on state.poll and never moves the run status');
  assert.ok(!spine.readEvents(p, 'TRK-40').some((e) => e.what === 'polled'), 'a snapshot refresh is not a polled event');
  // Same facts again: the snapshot (and its `at`) are left alone.
  spine.pollRun(p, 'TRK-40', { ...facts });
  assert.equal(spine.readState(p, 'TRK-40').poll.at, st1.poll.at);
  // A fact changes (the approval was dismissed): the snapshot moves.
  spine.pollRun(p, 'TRK-40', { ...facts, ourApprovalStanding: false, ourApprovalDismissed: true });
  const st3 = spine.readState(p, 'TRK-40');
  assert.equal(st3.poll.facts.ourApprovalStanding, false); assert.equal(st3.poll.facts.ourApprovalDismissed, true);
});


// ---- Task 11: the prompt menu ----

test('menuFor picks the mode from step status and gate kind', () => {
  const mk = (status, gate) => ({ run: 'TRK-7', current_step: 'approve', cycle: 'build-and-ship',
    steps: { approve: { status, receipts_required: gate ? [{ kind: 'gate', name: 'artifact-approved' }] : [] } } });
  assert.strictEqual(spine.menuFor(mk('in_review', true), []).mode, 'GATE');
  assert.strictEqual(spine.menuFor(mk('in_progress', false), []).mode, 'RESUME');
  assert.strictEqual(spine.menuFor(mk('blocked', false), []).mode, 'BLOCKED');
  assert.strictEqual(spine.menuFor({ run: 'TRK-7', current_step: null, steps: { a: { status: 'ready' } } }, []).mode, 'START');
  assert.strictEqual(spine.menuFor({ run: 'TRK-7', current_step: null, steps: { a: { status: 'done' } } }, []).mode, 'CLOSED');
});

test('renderMenu is ≤ 3 lines and names only phrases valid in the mode', () => {
  const st = { run: 'TRK-7', current_step: 'approve', cycle: 'build-and-ship',
    steps: { approve: { status: 'in_review', receipts_required: [{ kind: 'gate', name: 'artifact-approved' }] } } };
  const out = spine.renderMenu(st, [], spine.DEFAULT_MENU_WORDS);
  assert.ok(out.split('\n').length <= 3);
  assert.match(out, /waiting on you \(artifact-approved\)/);
  assert.match(out, /Say: approve · block: <why> · drop: <tag> · change: <tag> · where are we/);
});

test('parseMenuPhrase: exact bare phrases, prefix+colon payloads, never "looks good"', () => {
  const w = spine.DEFAULT_MENU_WORDS;
  assert.deepStrictEqual(spine.parseMenuPhrase('  Approve ', w), { id: 'approve', payload: null });
  assert.deepStrictEqual(spine.parseMenuPhrase('block: needs the migration first', w), { id: 'block', payload: 'needs the migration first' });
  assert.deepStrictEqual(spine.parseMenuPhrase("what's next", w), { id: 'next', payload: null });
  assert.strictEqual(spine.parseMenuPhrase('looks good, approve it', w), null);
  assert.strictEqual(spine.parseMenuPhrase('approve the other one too', w), null);
});

test('parseMenuPhrase: a curly apostrophe normalises to a straight one ("what’s next" matches)', () => {
  const w = spine.DEFAULT_MENU_WORDS;
  assert.deepStrictEqual(spine.parseMenuPhrase('what’s next', w), { id: 'next', payload: null });
});

test('menuFor: PANEL-FAIL uses the LATEST verdict per agent — an earlier fail a later pass overturned is not sticky', () => {
  const state = { run: 'TRK-7', current_step: 'review', cycle: 'build-and-ship',
    steps: { review: { status: 'in_progress', receipts_required: [{ kind: 'agent', name: 'writing-adversary' }] } } };
  const failThenPass = [
    { step: 'review', kind: 'agent', name: 'writing-adversary', verdict: 'fail' },
    { step: 'review', kind: 'agent', name: 'writing-adversary', verdict: 'pass' },
  ];
  assert.strictEqual(spine.menuFor(state, failThenPass).mode, 'RESUME', 'a later pass clears an earlier fail');
  const stillFailing = [
    { step: 'review', kind: 'agent', name: 'writing-adversary', verdict: 'pass' },
    { step: 'review', kind: 'agent', name: 'writing-adversary', verdict: 'fail' },
  ];
  assert.strictEqual(spine.menuFor(state, stillFailing).mode, 'PANEL-FAIL', 'the latest verdict is fail');
  const twoAgentsOnePassingOneNot = [
    { step: 'review', kind: 'agent', name: 'writing-adversary', verdict: 'pass' },
    { step: 'review', kind: 'agent', name: 'tech-reviewer', verdict: 'fail' },
  ];
  assert.strictEqual(spine.menuFor(state, twoAgentsOnePassingOneNot).mode, 'PANEL-FAIL', 'any required agent still failing is enough');
});

test('landing: pollRun on state MERGED records the merge step\'s gh checks, runs jira on_done, finishes merge and readies close-out', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  // This test is ABOUT the jira landing, so the project must have a tracker. The shipped
  // fixture declares `jira: { kind: none }`, and it used to make no difference: the merge step
  // compiled a jira requirement either way, so a project with no tracker had its merge blocked
  // by "jira transition to Done failed" — a transition into a system it does not have. That was
  // the bug, asserted here as behaviour. The `kind: none` case is now its own test below.
  fs.writeFileSync(path.join(p, 'config', 'zz-tracked.yaml'), 'jira:\n  kind: jira\n');
  spine.launchRun(p, { runId: 'TRK-30', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  const st = spine.readState(p, 'TRK-30');
  for (const id of ['scope', 'build', 'review', 'write-review', 'pre-pr', 'approve', 'open-pr', 'pr-loop']) st.steps[id].status = 'done';
  spine.writeState(p, 'TRK-30', st);
  spine.appendEvent(p, 'TRK-30', { kind: 'gh', step: 'open-pr', name: 'pr:create', result: 'pass', ref: 'https://github.com/o/r/pull/7', pin: spine.computePin(repo), actor: 'agent' });
  // Not merged yet: nothing lands, nothing changes.
  assert.equal(spine.pollRun(p, 'TRK-30', { state: 'OPEN', mergeStateStatus: 'CLEAN' }).landed, undefined);
  assert.equal(spine.readState(p, 'TRK-30').steps.merge.status, 'pending');
  // No jira action wired: the landing stops at the jira receipt and says so; merge stays in progress.
  const blocked = spine.pollRun(p, 'TRK-30', { state: 'MERGED' }).landed;
  assert.match(blocked.blocked.reason, /jira transition to Done failed/);
  assert.equal(spine.readState(p, 'TRK-30').steps.merge.status, 'in_progress');
  // With the action wired the poll finishes the step; the transition ran once, with the card and status.
  const calls = [];
  const landed = spine.pollRun(p, 'TRK-30', { state: 'MERGED' }, { jira: (card, status) => calls.push([card, status]) }).landed;
  assert.deepEqual(calls, [['TRK-30', 'Done']]);
  assert.deepEqual(landed.finished, ['merge']);
  assert.ok(landed.ready.includes('close-out'));
  const after = spine.readState(p, 'TRK-30');
  assert.equal(after.steps.merge.status, 'done');
  assert.equal(after.steps['close-out'].status, 'ready');
  const ev = spine.readEvents(p, 'TRK-30').filter((e) => e.step === 'merge' && e.kind === 'gh');
  assert.deepEqual(ev.map((e) => e.name).sort(), ['approved_on_head', 'checks-green', 'merged', 'threads_resolved']);
  assert.ok(ev.every((e) => e.result === 'pass' && e.ref === 'https://github.com/o/r/pull/7'));
  // D-027: a gh receipt the landing back-filled was not collected; it says so. The jira receipt is
  // the transition the landing really ran, so it is not marked.
  assert.ok(ev.every((e) => e.out_of_band === true), 'every back-filled gh receipt is out of band');
  assert.ok(spine.readEvents(p, 'TRK-30').filter((e) => e.step === 'merge' && e.kind === 'jira').every((e) => e.out_of_band === undefined));
  assert.ok(spine.readEvents(p, 'TRK-30').some((e) => e.what === 'landed' && e.step === 'merge'));
  // Idempotent: a second poll after the landing is a no-op.
  assert.equal(spine.pollRun(p, 'TRK-30', { state: 'MERGED' }, { jira: () => calls.push('again') }).landed, undefined);
  assert.equal(calls.length, 1);
});

test('landing: a project with jira.kind none lands without attempting a transition', () => {
  // The other half of the fix. With no tracker there is no transition to run, so the landing
  // must not stop at one — and must not need a jira action wired to get a card merged. Before
  // this, punchlist (kind: none) could not have landed a card through pollRun at all.
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-32', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  const st = spine.readState(p, 'TRK-32');
  for (const id of ['scope', 'build', 'review', 'write-review', 'pre-pr', 'approve', 'open-pr', 'pr-loop']) st.steps[id].status = 'done';
  spine.writeState(p, 'TRK-32', st);
  spine.appendEvent(p, 'TRK-32', { kind: 'gh', step: 'open-pr', name: 'pr:create', result: 'pass', ref: 'https://github.com/o/r/pull/9', pin: spine.computePin(repo), actor: 'agent' });

  const calls = [];
  const landed = spine.pollRun(p, 'TRK-32', { state: 'MERGED' }, { jira: (c, s2) => calls.push([c, s2]) }).landed;
  assert.ok(landed, 'the landing must not be blocked by a tracker the project does not have');
  assert.equal(landed.blocked, undefined);
  assert.deepEqual(calls, [], 'no transition is attempted');
  assert.deepEqual(landed.finished, ['merge']);
  const after = spine.readState(p, 'TRK-32');
  assert.equal(after.steps.merge.status, 'done');
  assert.equal(after.steps['close-out'].status, 'ready');
  assert.equal(spine.readEvents(p, 'TRK-32').filter((e) => e.kind === 'jira').length, 0, 'and no jira receipt is written');
});

test('landing: an unfinished ancestor that needs a human or artifact receipt blocks the landing at that step', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-31', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  const st = spine.readState(p, 'TRK-31');
  for (const id of ['scope', 'build', 'review', 'write-review', 'pre-pr', 'approve', 'open-pr']) st.steps[id].status = 'done';
  st.steps['pr-loop'].status = 'ready';
  spine.writeState(p, 'TRK-31', st);
  const landed = spine.pollRun(p, 'TRK-31', { state: 'MERGED' }, { jira: () => {} }).landed;
  assert.equal(landed.blocked.step, 'pr-loop');           // the fixture's pr-loop carries a human gate + skill
  assert.match(landed.blocked.reason, /cannot satisfy/);
  assert.equal(spine.readState(p, 'TRK-31').steps.merge.status, 'pending');
});

// ---- the discard exit ----

function launchOnEffort(p, runId, repo, effort = 'greenhouse') {
  spine.launchRun(p, { runId, cycle: 'build-and-ship', repoDir: repo, owner: 'o', estimate: 1 });
  fs.writeFileSync(path.join(p, 'runs', runId, 'inputs.yaml'), `card: ${runId}\neffort: ${effort}\nrepo_dir: ${repo}\n`);
}

test('discardRun: the owner\'s decision retires the cycle, records the gate in their name, and readies record', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  launchOnEffort(p, 'TRK-12', repo);
  spine.stepStart(p, 'TRK-12', 'scope');
  const st = spine.discardRun(p, 'TRK-12', { by: 'human:o', reason: 'adds code we would delete', replacedBy: 'TRK-99' });
  assert.equal(st.exit, 'discard');
  assert.equal(st.current_step, null);
  assert.equal(st.steps.scope.status, 'skipped');
  assert.equal(st.steps.scope.outcome, 'discarded');
  assert.equal(st.steps.build.status, 'skipped');
  assert.equal(st.steps.drop.status, 'done');
  assert.equal(st.steps.record.status, 'ready');
  assert.equal(st.steps['close-out'].status, 'pending');            // the exit's close-out, not the cycle's
  assert.deepEqual(st.steps['close-out'].receipts_required, []);   // no harvest skill on a drop
  const events = spine.readEvents(p, 'TRK-12');
  const gate = events.find((e) => e.kind === 'gate' && e.step === 'drop');
  assert.equal(gate.name, 'run-discarded'); assert.equal(gate.by, 'o'); assert.equal(gate.actor, 'human');
  const dropped = events.find((e) => e.what === 'discarded');
  assert.equal(dropped.reason, 'adds code we would delete'); assert.equal(dropped.replaced_by, 'TRK-99');
  assert.ok(dropped.retired.includes('scope') && dropped.retired.includes('merge'));
  assert.match(spine.nextCommand(st), /plt step start record/);
  assert.match(spine.renderPrime(p, 'TRK-12'), /exit discard/);
});

test('discardRun refuses without a reason, for a non-human, and twice', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  launchOnEffort(p, 'TRK-12', repo);
  assert.throws(() => spine.discardRun(p, 'TRK-12', { by: 'human:o' }), /--reason/);
  assert.throws(() => spine.discardRun(p, 'TRK-12', { reason: 'x' }), /--by/);
  fs.appendFileSync(path.join(p, 'config', 'sprout.yaml'), 'actors: { humans: [o] }\n');
  assert.throws(() => spine.discardRun(p, 'TRK-12', { by: 'agent', reason: 'x' }), /not a human/);
  spine.discardRun(p, 'TRK-12', { by: 'human:o', reason: 'x' });
  assert.throws(() => spine.discardRun(p, 'TRK-12', { by: 'human:o', reason: 'x' }), /already on the discard exit/);
});

test('record: finishes only once the effort file lists the card under dropped:, then close marks the run discarded', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  launchOnEffort(p, 'TRK-12', repo);
  spine.discardRun(p, 'TRK-12', { by: 'human:o', reason: 'x' });
  spine.stepStart(p, 'TRK-12', 'record');
  const pin = spine.computePin(repo);
  spine.recordReceipt(p, 'TRK-12', { step: 'record', kind: 'skill', name: 'sprout-board', pin });
  spine.recordReceipt(p, 'TRK-12', { step: 'record', kind: 'jira', name: 'on_done:Discarded', pin });
  // Every receipt is in, but the effort file does not say the card is dropped.
  let g = spine.gateCheck(p, 'TRK-12', 'record', repo);
  assert.equal(g.ok, false);
  assert.deepEqual(g.missing.map((m) => m.kind), ['effort']);
  assert.match(g.missing[0].reason, /not listed under `dropped:`/);
  assert.throws(() => spine.stepFinish(p, 'TRK-12', 'record', { outcome: 'worktree_kept', noExtrapolations: true }), /effort:dropped/);
  const ef = path.join(p, 'efforts', 'greenhouse.yaml');
  fs.appendFileSync(ef, 'dropped:\n  - { id: TRK-12, reason: adds code we would delete, replaced_by: TRK-99 }\n');
  g = spine.gateCheck(p, 'TRK-12', 'record', repo);
  assert.equal(g.ok, true);
  // A removed-worktree claim is checked on disk.
  assert.throws(() => spine.stepFinish(p, 'TRK-12', 'record', { outcome: 'worktree_removed', noExtrapolations: true }), /still exists/);
  let st = spine.stepFinish(p, 'TRK-12', 'record', { outcome: 'worktree_kept', noExtrapolations: true });
  assert.equal(st.steps.record.status, 'done');
  assert.equal(st.steps['close-out'].status, 'ready');
  assert.throws(() => spine.closeRun(p, 'TRK-12', { by: 'human:o' }), /close-out is not done/);
  spine.stepStart(p, 'TRK-12', 'close-out');
  st = spine.stepFinish(p, 'TRK-12', 'close-out', { outcome: 'done', noExtrapolations: true });
  const closed = spine.closeRun(p, 'TRK-12', { by: 'human:o' });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closed_as, 'discarded');
  assert.ok(spine.readEvents(p, 'TRK-12').some((e) => e.what === 'closed' && e.closed_as === 'discarded'));
  // The planner: a dropped card is never scheduled and never satisfies a dependency on it.
  const effort = require('../lib/effort');
  assert.equal(effort.runStatus(p, 'TRK-12'), 'discarded');
  fs.appendFileSync(ef, '  - TRK-14\n');
  fs.writeFileSync(ef, fs.readFileSync(ef, 'utf8').replace('touches: [packages/resolvers], after: [] }', 'touches: [packages/resolvers], after: [TRK-12] }'));
  const plan = effort.planWave(p, 'greenhouse');
  assert.equal(plan.excluded.find((e) => e.card === 'TRK-12').why, 'dropped');
  assert.equal(plan.excluded.find((e) => e.card === 'TRK-14').why, 'dropped');
  assert.match(plan.excluded.find((e) => e.card === 'TRK-16').why, /after TRK-12, which was dropped/);
});

test('a plain close records closed_as done', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-9', cycle: 'build-and-ship', repoDir: repo, owner: 'o', estimate: 1 });
  const st = spine.readState(p, 'TRK-9');
  for (const id of Object.keys(st.steps)) st.steps[id].status = 'done';
  st.current_step = null; spine.writeState(p, 'TRK-9', st);
  assert.equal(spine.closeRun(p, 'TRK-9', { by: 'human:o' }).closed_as, 'done');
});

test('stepFinish: a declared `skipped` outcome needs no verify receipts (the work did not happen)', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'REV-9', cycle: 'review-pr', repoDir: repo, owner: 'me', estimate: 0.5 });
  const st = spine.readState(p, 'REV-9');
  for (const id of ['intake', 'gist', 'panel', 'write-review', 'outbound', 'approve']) { st.steps[id].status = 'done'; st.steps[id].outcome = 'done'; }
  st.steps.post.status = 'in_progress'; spine.writeState(p, 'REV-9', st);
  assert.throws(() => spine.stepFinish(p, 'REV-9', 'post', { outcome: 'posted', noExtrapolations: true }), /missing receipts: gh:review-posted/);
  const r = spine.stepFinish(p, 'REV-9', 'post', { outcome: 'skipped', noExtrapolations: true });
  assert.equal(spine.readState(p, 'REV-9').steps.post.outcome, 'skipped');
});


// ---- gate lifecycle (Plan 2, Task 4) ----

// Walks a fresh build-and-ship run to `write-review` ready by marking the earlier steps done in state.
function atWriteReview(p, runId, repo, opts = {}) {
  spine.launchRun(p, { runId, cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  const st = spine.readState(p, runId);
  for (const id of ['scope', 'build', 'review']) { st.steps[id].status = 'done'; st.steps[id].finished = '2026-09-16T10:00:00.000Z'; }
  st.steps['write-review'].status = 'ready';
  Object.assign(st, opts);
  spine.writeState(p, runId, st);
  return st;
}

test('compileRequirements: ANY unresolved gate.mode config ref falls back to hard — no key whitelist, so a new adversarial gate cannot crash a live project', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  const config = spine.loadConfig(p);
  // A third adversarial gate a pack author adds tomorrow, naming a config key no project defines.
  const step = { id: 'security-review', gate: { kind: 'adversarial', mode: '{{config.review.security_mode}}', agents: ['security-adversary'] } };
  const reqs = spine.compileRequirements(step, config);
  assert.deepStrictEqual(reqs, [{ kind: 'agent', name: 'security-adversary' }], 'hard is written as no mode key');
  // hard is the SAFE fallback: the reviewer's pass is held as a missing receipt, never silently passed.
  const banner = spine.compileRequirements({ ...step, gate: { ...step.gate, mode: 'banner' } }, config);
  assert.strictEqual(banner[0].mode, 'banner', 'an explicit banner is still honoured');
  // resolveRef itself keeps throwing for every other unresolved config key — only gate.mode defaults.
  assert.throws(() => spine.resolveRef('{{config.review.nope}}', config), /unresolved config reference/);
});

test('compileRequirements: gate.mode ref defaults in code when the config key is absent — no throw; the panel gate falls back to hard, the writing gate to banner', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  const config = spine.loadConfig(p);
  delete config.review.panel_mode;
  delete config.review.writing_mode;
  const formula = spine.loadFormula(p, 'build-and-ship');
  const review = formula.steps.find((s) => s.id === 'review');
  const writeReview = formula.steps.find((s) => s.id === 'write-review');
  assert.strictEqual(review.gate.mode, '{{config.review.panel_mode}}');
  assert.strictEqual(writeReview.gate.mode, '{{config.review.writing_mode}}');
  // Must not throw `unresolved config reference` (this reproduces the live crash on
  // `plt run launch|recompile` / `plt step start` for a project whose config lacks the keys).
  const reviewReqs = spine.compileRequirements(review, config);
  const writeReviewReqs = spine.compileRequirements(writeReview, config);
  const reviewAgent = reviewReqs.find((r) => r.kind === 'agent');
  assert.strictEqual(reviewAgent && reviewAgent.mode, undefined, 'hard is written as no mode key');
  const writeReviewAgent = writeReviewReqs.find((r) => r.kind === 'agent');
  assert.strictEqual(writeReviewAgent && writeReviewAgent.mode, 'banner', 'a WRITING gate falls back to banner — a writing review surfaces its findings, it does not block');
  // resolveRef itself keeps throwing for any other unresolved config key — only gate.mode defaults.
  assert.throws(() => spine.resolveRef('{{config.review.nope}}', config), /unresolved config reference/);
});

test('gate.mode banner: a failing agent verdict never blocks gateCheck/stepFinish; prime shows ⚠ banner: <agent> failed', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  atWriteReview(p, 'TRK-30', repo);
  const st = spine.stepStart(p, 'TRK-30', 'write-review');
  const req = st.steps['write-review'].receipts_required.find((r) => r.kind === 'agent' && r.name === 'writing-adversary');
  assert.strictEqual(req.mode, 'banner', 'the fixture defaults resolve write-review to banner');
  const pin = spine.computePin(repo);
  spine.recordReceipt(p, 'TRK-30', { step: 'write-review', kind: 'agent', name: 'writing-adversary', pin, actor: 'agent', verdict: 'fail' });
  assert.strictEqual(spine.gateCheck(p, 'TRK-30', 'write-review', repo).ok, true);
  const prime = spine.renderPrime(p, 'TRK-30');
  assert.match(prime, /⚠ banner: writing-adversary failed/);
  assert.strictEqual(spine.menuFor(spine.readState(p, 'TRK-30'), spine.readEvents(p, 'TRK-30')).mode, 'RESUME', 'a banner fail is not PANEL-FAIL');
  const after = spine.stepFinish(p, 'TRK-30', 'write-review', { outcome: 'pass', noExtrapolations: true });
  assert.strictEqual(after.steps['write-review'].status, 'done');
});

test('gateCheck reports banner requirements separately: ok is driven by hard requirements only, never by banner state', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  atWriteReview(p, 'TRK-36', repo);
  spine.stepStart(p, 'TRK-36', 'write-review');
  // Unseen: the banner reviewer never ran — gateCheck must still surface it, not stay silent.
  let g = spine.gateCheck(p, 'TRK-36', 'write-review', repo);
  assert.strictEqual(g.ok, true);
  assert.deepStrictEqual(g.banner.map((b) => [b.kind, b.name, b.state]), [['agent', 'writing-adversary', 'unseen']]);
  // Failed: recorded but still never blocks `ok`.
  const pin = spine.computePin(repo);
  spine.recordReceipt(p, 'TRK-36', { step: 'write-review', kind: 'agent', name: 'writing-adversary', pin, actor: 'agent', verdict: 'fail' });
  g = spine.gateCheck(p, 'TRK-36', 'write-review', repo);
  assert.strictEqual(g.ok, true);
  assert.deepStrictEqual(g.banner.map((b) => [b.kind, b.name, b.state]), [['agent', 'writing-adversary', 'fail']]);
  // Passed: state flips, ok stays true.
  spine.recordReceipt(p, 'TRK-36', { step: 'write-review', kind: 'agent', name: 'writing-adversary', pin, actor: 'agent', verdict: 'pass' });
  g = spine.gateCheck(p, 'TRK-36', 'write-review', repo);
  assert.strictEqual(g.ok, true);
  assert.deepStrictEqual(g.banner.map((b) => [b.kind, b.name, b.state]), [['agent', 'writing-adversary', 'pass']]);
});

test('`plt gate check` prints banner state under a `banner:` line', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  atWriteReview(p, 'TRK-37', repo);
  spine.stepStart(p, 'TRK-37', 'write-review');
  const plt = path.join(__dirname, '..', 'bin', 'plt');
  const r = require('child_process').spawnSync(process.execPath, [plt, 'gate', 'check', 'TRK-37', 'write-review'],
    { encoding: 'utf8', env: { ...process.env, PLT_PROCESS_DIR: p } });
  assert.match(r.stdout, /banner:/);
  assert.match(r.stdout, /writing-adversary/);
});

test('gate.mode hard (config.review.writing_mode override): a failing agent verdict blocks', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  fs.writeFileSync(path.join(p, 'config', 'zz-modes.yaml'), 'review:\n  writing_mode: hard\n');
  atWriteReview(p, 'TRK-31', repo);
  const st = spine.stepStart(p, 'TRK-31', 'write-review');
  const req = st.steps['write-review'].receipts_required.find((r) => r.kind === 'agent' && r.name === 'writing-adversary');
  assert.strictEqual(req.mode, undefined, 'hard is the default and is written as no mode key');
  const pin = spine.computePin(repo);
  spine.recordReceipt(p, 'TRK-31', { step: 'write-review', kind: 'agent', name: 'writing-adversary', pin, actor: 'agent', verdict: 'fail' });
  assert.strictEqual(spine.gateCheck(p, 'TRK-31', 'write-review', repo).ok, false);
  assert.throws(() => spine.stepFinish(p, 'TRK-31', 'write-review', { outcome: 'pass', noExtrapolations: true }), /missing receipts/);
  assert.doesNotMatch(spine.renderPrime(p, 'TRK-31'), /⚠ banner/);
});

test('stepStart recompiles the step\'s receipts_required from the current formula + config', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  atWriteReview(p, 'TRK-32', repo);
  const before = spine.readState(p, 'TRK-32').steps['write-review'].receipts_required.map((r) => r.name);
  assert.ok(!before.includes('style-cop'));
  const cfg = path.join(p, 'config', 'sprout.yaml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('writing_agents: [writing-adversary]', 'writing_agents: [writing-adversary, style-cop]'));
  const st = spine.stepStart(p, 'TRK-32', 'write-review');
  assert.strictEqual(st.steps['write-review'].status, 'in_progress');
  assert.ok(st.steps['write-review'].receipts_required.some((r) => r.kind === 'agent' && r.name === 'style-cop'));
});

test('recordReceipt throws without kind and name; `plt receipt` prints usage and exits 2', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-33', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  const pin = spine.computePin(repo);
  assert.throws(() => spine.recordReceipt(p, 'TRK-33', { step: 'scope', kind: 'skill', pin }), /receipt needs --kind and --name/);
  assert.throws(() => spine.recordReceipt(p, 'TRK-33', { step: 'scope', name: 'x', pin }), /receipt needs --kind and --name/);
  const plt = path.join(__dirname, '..', 'bin', 'plt');
  const r = require('child_process').spawnSync(process.execPath, [plt, 'receipt', '--run', 'TRK-33', '--step', 'scope', '--kind', 'skill'], { encoding: 'utf8', env: { ...process.env, PLT_PROCESS_DIR: p } });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /usage: plt receipt/);
  assert.strictEqual(spine.readEvents(p, 'TRK-33').filter((e) => e.kind === 'skill').length, 0);
});

test('nextCommand never proposes `plt step start` for a manual step: gate command for an owner gate, "tell the agent" for a banner step', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-34', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  const st = spine.readState(p, 'TRK-34');
  const wf = spine.runFormula(p, st);
  for (const id of Object.keys(st.steps)) st.steps[id].status = 'done';
  st.steps.reply.status = 'ready';
  assert.strictEqual(spine.nextCommand(st, wf), 'plt gate approve TRK-34 reply --by human:<you>');
  st.steps.reply.status = 'done';
  st.steps.announce.status = 'ready';
  assert.match(spine.nextCommand(st, wf), /^tell the agent: 📣 SLACK FOR REVIEWS/);
  assert.doesNotMatch(spine.nextCommand(st, wf), /\\n/);
  // An agent step that is also ready wins over the manual ones.
  st.steps['pr-loop'].status = 'ready';
  assert.strictEqual(spine.nextCommand(st, wf), 'plt step start pr-loop --run TRK-34');
  // Without a formula (ad-hoc state) nothing is known to be manual — today's behaviour.
  st.steps['pr-loop'].status = 'done';
  assert.strictEqual(spine.nextCommand(st), 'plt step start announce --run TRK-34');
});

test('nextCommand: `manual: false` is not manual — the parser makes every scalar a string, and "false" must not read as truthy', () => {
  const st = { run: 'R', steps: { one: { status: 'ready' } } };
  assert.strictEqual(spine.nextCommand(st, { steps: [{ id: 'one', manual: 'false' }] }), 'plt step start one --run R');
  assert.strictEqual(spine.nextCommand(st, { steps: [{ id: 'one', manual: true }] }), 'plt gate approve R one --by human:<you>');
  assert.strictEqual(spine.nextCommand(st, { steps: [{ id: 'one', manual: 'true' }] }), 'plt gate approve R one --by human:<you>');
});

test('owner_window: the driving window claims the run; another window is refused until handoff or --take-over', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-35', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-35', 'inputs.yaml'), 'card: TRK-35\nwindow:\n  tab_id: A\n  label: TRK-35-x\n');
  const st = spine.stepStart(p, 'TRK-35', 'scope', { window: 'A' });
  assert.strictEqual(st.owner_window, 'A', 'the caller window claims the run');
  const pin = spine.computePin(repo);
  spine.recordReceipt(p, 'TRK-35', { step: 'scope', kind: 'skill', name: 'sprout-scope', pin, actor: 'agent', window: 'A' });   // same window — fine
  assert.throws(() => spine.recordReceipt(p, 'TRK-35', { step: 'scope', kind: 'artifact', name: 'dispatch-brief', pin, actor: 'agent', window: 'B' }),
    /run TRK-35 is driven by window A; hand off first \(or --take-over\)/);
  assert.throws(() => spine.stepFinish(p, 'TRK-35', 'scope', { outcome: 'ready', noExtrapolations: true, window: 'B' }), /driven by window A/);
  assert.throws(() => spine.gateApprove(p, 'TRK-35', 'scope', { by: 'human:lead', window: 'B' }), /driven by window A/);
  // PLT_WINDOW env is the same resolution as the option.
  process.env.PLT_WINDOW = 'B';
  try { assert.throws(() => spine.stepFinish(p, 'TRK-35', 'scope', { outcome: 'ready', noExtrapolations: true }), /driven by window A/); }
  finally { delete process.env.PLT_WINDOW; }
  // Take-over: one time event, then B drives.
  spine.recordReceipt(p, 'TRK-35', { step: 'scope', kind: 'artifact', name: 'dispatch-brief', pin, actor: 'agent', window: 'B', takeOver: true });
  const took = spine.readEvents(p, 'TRK-35').find((e) => e.kind === 'time' && e.what === 'taken-over');
  assert.ok(took); assert.strictEqual(took.from, 'A'); assert.strictEqual(took.window, 'B');
  assert.strictEqual(spine.readState(p, 'TRK-35').owner_window, 'B');
  // Handoff releases the window claim only through the same guard: a caller resolving to 'A'
  // cannot release B's claim without --take-over — that guard is finding 5's fix (writeHandoff
  // used to release unconditionally).
  assert.throws(() => spine.writeHandoff(p, 'TRK-35', { goal: 'g', next: 'plt prime TRK-35', window: 'A' }), /driven by window B/);
  assert.strictEqual(spine.readState(p, 'TRK-35').owner_window, 'B', 'a non-owning window did not release the claim');
  // Handoff clears the claim; the next start from any window claims again.
  spine.writeHandoff(p, 'TRK-35', { goal: 'g', next: 'plt prime TRK-35', window: 'B' });
  assert.strictEqual(spine.readState(p, 'TRK-35').owner_window, null);
  spine.recordReceipt(p, 'TRK-35', { step: 'scope', kind: 'jira', name: 'on_start:In Progress', pin, actor: 'agent', window: 'C' });
  spine.recordReceipt(p, 'TRK-35', { step: 'scope', kind: 'touches', name: 'declared', pin, actor: 'agent', files: ['x'], window: 'C' });
  spine.stepFinish(p, 'TRK-35', 'scope', { outcome: 'ready', noExtrapolations: true, window: 'C' });
  const st2 = spine.stepStart(p, 'TRK-35', 'build', { window: 'C' });
  assert.strictEqual(st2.owner_window, 'C');
  // A null caller window (no PLT_WINDOW, no --window) never claims and is never blocked.
  spine.writeHandoff(p, 'TRK-35', { goal: 'g', next: 'plt prime TRK-35', window: 'C' });
  spine.recordReceipt(p, 'TRK-35', { step: 'build', kind: 'skill', name: 'sprout-conventions', pin, actor: 'agent' });
  assert.strictEqual(spine.readState(p, 'TRK-35').owner_window, null);
});

test('owner_window: the caller window is PLT_WINDOW alone — a run that records inputs.window is never self-owned, so two windows genuinely collide', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-39', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-39', 'inputs.yaml'), 'card: TRK-39\nwindow:\n  tab_id: A\n  label: TRK-39-x\n');
  const pin = spine.computePin(repo);

  // The run RECORDS window A, but that recording is not the caller's identity: with no PLT_WINDOW
  // the caller is null, so it claims nothing. (Reading inputs.window here made every caller on the
  // run resolve to the same value, and the guard could never fire.)
  assert.strictEqual(spine.callerWindow(p, 'TRK-39'), null);
  assert.ok(!spine.stepStart(p, 'TRK-39', 'scope').owner_window, 'a null caller never claims');
  spine.recordReceipt(p, 'TRK-39', { step: 'scope', kind: 'skill', name: 'sprout-scope', pin, actor: 'agent' });

  // Window A exports PLT_WINDOW and claims the run on the next start.
  const reset = spine.readState(p, 'TRK-39'); reset.steps.scope.status = 'ready'; spine.writeState(p, 'TRK-39', reset);
  process.env.PLT_WINDOW = 'A';
  try {
    assert.strictEqual(spine.callerWindow(p, 'TRK-39'), 'A');
    assert.strictEqual(spine.stepStart(p, 'TRK-39', 'scope').owner_window, 'A');
  } finally { delete process.env.PLT_WINDOW; }

  // Window B is a second caller on the SAME run and is refused — the collision the guard exists for.
  process.env.PLT_WINDOW = 'B';
  try {
    assert.throws(() => spine.recordReceipt(p, 'TRK-39', { step: 'scope', kind: 'artifact', name: 'dispatch-brief', pin, actor: 'agent' }),
      /run TRK-39 is driven by window A; hand off first \(or --take-over\)/);
    assert.throws(() => spine.stepFinish(p, 'TRK-39', 'scope', { outcome: 'ready', noExtrapolations: true }), /driven by window A/);
  } finally { delete process.env.PLT_WINDOW; }

  // A caller with PLT_WINDOW unset is still never refused, whatever the run recorded.
  spine.recordReceipt(p, 'TRK-39', { step: 'scope', kind: 'artifact', name: 'dispatch-brief', pin, actor: 'agent' });
  assert.strictEqual(spine.readState(p, 'TRK-39').owner_window, 'A', 'a null caller neither claims nor releases');
});

// ---- Task 5: plt sync ("what moved since the last session") ----

test('syncSince: seeds silently on the first call, reports exactly the run whose next command moved, then settles to "nothing moved"', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repoA = tmpRepo(); const repoB = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-70', cycle: 'build-and-ship', repoDir: repoA, owner: 'agent' });
  spine.launchRun(p, { runId: 'TRK-71', cycle: 'build-and-ship', repoDir: repoB, owner: 'agent' });

  // First ever call: nothing has "moved" relative to a baseline that did not exist — seeds only.
  const first = spine.syncSince(p);
  assert.strictEqual(first.seeded, true);
  assert.deepStrictEqual(first.moved, []);
  assert.strictEqual(first.unchanged, 0);
  const syncJson = JSON.parse(fs.readFileSync(path.join(p, 'build', 'sync.json'), 'utf8'));
  assert.strictEqual(syncJson.runs['TRK-70'], 'plt step start scope --run TRK-70');
  assert.strictEqual(syncJson.runs['TRK-71'], 'plt step start scope --run TRK-71');

  // Advance only TRK-70's next command; leave TRK-71 alone.
  spine.stepStart(p, 'TRK-70', 'scope');

  const second = spine.syncSince(p);
  assert.strictEqual(second.seeded, false);
  assert.deepStrictEqual(second.moved, [{ run: 'TRK-70',
    from: 'plt step start scope --run TRK-70', to: 'plt step finish scope --run TRK-70 --outcome <outcome>' }]);
  assert.strictEqual(second.unchanged, 1);   // TRK-71 unchanged
  assert.ok(second.since, 'since resolves to the prior sync.json\'s `at`');

  // Idempotent: an immediate third call (nothing advanced) reports nothing moved.
  const third = spine.syncSince(p);
  assert.deepStrictEqual(third.moved, []);
  assert.strictEqual(third.unchanged, 2);
});

test('syncSince: a run launched after the first sync is seeded silently on its first sighting, never reported as moved', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-72', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  spine.syncSince(p);
  const repo2 = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-73', cycle: 'build-and-ship', repoDir: repo2, owner: 'agent' });
  const r = spine.syncSince(p);
  assert.deepStrictEqual(r.moved, []);
  assert.strictEqual(r.unchanged, 1);   // only TRK-72 had a prior baseline to compare against
  const syncJson = JSON.parse(fs.readFileSync(path.join(p, 'build', 'sync.json'), 'utf8'));
  assert.strictEqual(syncJson.runs['TRK-73'], 'plt step start scope --run TRK-73');
});

test('plt sync (CLI): seeds, reports the moved run with old -> new text and a summary line, then "nothing moved"; --json shape', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-90', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  const env = { ...process.env, PLT_PROCESS_DIR: p };

  const first = spawnSync(process.execPath, [PLT, 'sync'], { encoding: 'utf8', env });
  assert.strictEqual(first.status, 0, first.stderr);
  assert.match(first.stdout, /seeded 1 run/);

  spine.stepStart(p, 'TRK-90', 'scope');

  const second = spawnSync(process.execPath, [PLT, 'sync'], { encoding: 'utf8', env });
  assert.strictEqual(second.status, 0, second.stderr);
  assert.match(second.stdout, /^TRK-90: plt step start scope --run TRK-90 → plt step finish scope --run TRK-90 --outcome <outcome>$/m);
  assert.match(second.stdout, /since .*: 1 moved, 0 unchanged/);

  const third = spawnSync(process.execPath, [PLT, 'sync'], { encoding: 'utf8', env });
  assert.strictEqual(third.status, 0, third.stderr);
  assert.strictEqual(third.stdout.trim(), 'nothing moved');

  const asJson = spawnSync(process.execPath, [PLT, 'sync', '--json'], { encoding: 'utf8', env });
  assert.strictEqual(asJson.status, 0, asJson.stderr);
  const j = JSON.parse(asJson.stdout);
  assert.deepStrictEqual(j.moved, []);
  assert.strictEqual(j.unchanged, 1);
  assert.strictEqual(j.seeded, false);
});

// ---- Task 5: plt mine (re-prompt / extrapolation / re-approval / writing-gate aggregates) ----

test('mine: aggregates reprompt families, extrapolations, gate re-approvals and writing-adversary fail rate, deterministic count-desc-then-id-asc order', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-80', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  const pin = spine.computePin(repo);

  // Three reprompt receipts of one family, two of another.
  for (let i = 0; i < 3; i++) spine.recordReceipt(p, 'TRK-80', { step: 'scope', kind: 'reprompt', name: 'menu:near-miss', pin, actor: 'human' });
  for (let i = 0; i < 2; i++) spine.recordReceipt(p, 'TRK-80', { step: 'scope', kind: 'reprompt', name: 'style', pin, actor: 'human' });

  // Two extrapolations sharing a missing.key — the LATEST assumed text wins.
  spine.appendEvent(p, 'TRK-80', { kind: 'extrapolation', step: 'pre-pr', missing: { scope: 'card', key: 'touches-drift' }, assumed: 'first guess', actor: 'agent', pin });
  spine.appendEvent(p, 'TRK-80', { kind: 'extrapolation', step: 'pre-pr', missing: { scope: 'card', key: 'touches-drift' }, assumed: 'latest guess', actor: 'agent', pin });
  // The "nothing to flag" placeholder is noise and must not appear as a row.
  spine.appendEvent(p, 'TRK-80', { kind: 'extrapolation', step: 'build', missing: { scope: 'none', key: 'none' }, actor: 'agent', pin });

  // One step with two artifact-approved gate receipts — a re-approval.
  spine.appendEvent(p, 'TRK-80', { kind: 'gate', step: 'approve', name: 'artifact-approved', result: 'approve', by: 'human:o', actor: 'human', pin });
  spine.appendEvent(p, 'TRK-80', { kind: 'gate', step: 'approve', name: 'artifact-approved', result: 'approve', by: 'human:o', actor: 'human', pin });

  // Writing-adversary: 1 fail, 2 total (config.review.writing_agents from the fixture's sprout.yaml overlay).
  spine.recordReceipt(p, 'TRK-80', { step: 'write-review', kind: 'agent', name: 'writing-adversary', pin, actor: 'agent', verdict: 'fail' });
  spine.recordReceipt(p, 'TRK-80', { step: 'write-review', kind: 'agent', name: 'writing-adversary', pin, actor: 'agent', verdict: 'pass' });

  const m = spine.mine(p);
  assert.deepStrictEqual(m.reprompts.map((r) => [r.id, r.count, r.runs]), [
    ['menu:near-miss', 3, ['TRK-80']],
    ['style', 2, ['TRK-80']],
  ]);
  assert.strictEqual(m.extrapolations.length, 1);
  assert.strictEqual(m.extrapolations[0].id, 'touches-drift');
  assert.strictEqual(m.extrapolations[0].count, 2);
  assert.deepStrictEqual(m.extrapolations[0].runs, ['TRK-80']);
  assert.strictEqual(m.extrapolations[0].assumed, 'latest guess');
  assert.deepStrictEqual(m.reapprovals.map((r) => [r.id, r.count, r.runs]), [['approve', 1, ['TRK-80']]]);
  assert.deepStrictEqual(m.writing.map((r) => [r.id, r.count, r.total, r.rate]), [['write-review', 1, 2, 50]]);

  // One table, the one `plt harvest` reads: every row has an id, and the section it came from is
  // folded into `signal` so nothing the old four tables carried is lost.
  const md = spine.renderMine(m);
  assert.match(md, /^\| id \| signal \| count \| runs \| target \| detail \|$/m);
  assert.match(md, /^\| S-001 \| reprompt:menu:near-miss \| 3 \| TRK-80 \| config:menu.words \|/m);
  assert.match(md, /^\| S-002 \| reprompt:style \| 2 \| TRK-80 \| \(none\) \|/m);
  assert.match(md, /^\| S-003 \| extrapolation:touches-drift \| 2 \| TRK-80 \| \(none\) \| most recent assumed: latest guess/m);
  assert.match(md, /^\| S-004 \| reapproval:approve \| 1 \| TRK-80 \| formula:build-and-ship:approve:reapprove.rearm \|/m);
  assert.match(md, /^\| S-005 \| writing:write-review \| 1 \| TRK-80 \| config:review.writing_mode \| 1\/2 .*50%/m);
  assert.strictEqual(md.split('\n').filter((l) => l.startsWith('| id |')).length, 1, 'one table, not four');
});

test('plt mine (CLI): --out writes process/suggestions.md (or the override), --json returns the structure', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-91', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  const pin = spine.computePin(repo);
  spine.recordReceipt(p, 'TRK-91', { step: 'scope', kind: 'reprompt', name: 'menu:near-miss', pin, actor: 'human' });
  const env = { ...process.env, PLT_PROCESS_DIR: p };

  const defaultOut = spawnSync(process.execPath, [PLT, 'mine'], { encoding: 'utf8', env });
  assert.strictEqual(defaultOut.status, 0, defaultOut.stderr);
  assert.match(defaultOut.stdout, /wrote .*suggestions\.md/);
  assert.ok(fs.existsSync(path.join(p, 'suggestions.md')));

  const outFile = path.join(root, 'mine-out.md');
  const withOut = spawnSync(process.execPath, [PLT, 'mine', '--out', outFile, '--json'], { encoding: 'utf8', env });
  assert.strictEqual(withOut.status, 0, withOut.stderr);
  const parsed = JSON.parse(withOut.stdout);
  assert.strictEqual(parsed.reprompts[0].id, 'menu:near-miss');
  assert.ok(fs.existsSync(outFile));
  assert.match(fs.readFileSync(outFile, 'utf8'), /menu:near-miss/);
});

// ---------------------------------------------------------------- fix round: gate-mode fallback

test('gate.mode fallback is derived from the gate\'s own declaration: a WRITING gate falls back to banner, every other gate to hard', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  // A brand-new project: no config at all under process/config. The packs still compile, and the
  // ruling holds — writing reviews surface findings (banner), panel/adversarial reviews block (hard).
  fs.rmSync(path.join(p, 'config'), { recursive: true, force: true });
  fs.mkdirSync(path.join(p, 'config'), { recursive: true });
  const config = spine.loadConfig(p);
  const modeOf = (step) => {
    const reqs = spine.compileRequirements(step, { ...config, review: { ...(config.review || {}), panel_agents: ['a'], writing_agents: ['w'] } });
    const agent = reqs.find((r) => r.kind === 'agent');
    return agent && agent.mode ? agent.mode : 'hard';
  };
  const gate = (mode, agents) => ({ id: 'x', gate: { kind: 'adversarial', mode, agents } });
  assert.strictEqual(modeOf(gate('{{config.review.writing_mode}}', ['w'])), 'banner', 'a writing gate never blocks by default');
  assert.strictEqual(modeOf(gate('{{config.review.panel_mode}}', ['a'])), 'hard', 'a panel gate holds the step by default');
  // No whitelist: a key a pack author invents tomorrow still falls back to hard, and a writing-shaped
  // key nobody has written yet still falls back to banner — neither needs a code change.
  assert.strictEqual(modeOf(gate('{{config.review.security_mode}}', ['a'])), 'hard');
  assert.strictEqual(modeOf(gate('{{config.review.prose_mode}}', ['w'])), 'banner');
  // An explicit config value still wins over the fallback, in both directions.
  const hardWriting = { ...config, review: { panel_agents: ['a'], writing_agents: ['w'], writing_mode: 'hard' } };
  assert.strictEqual(spine.compileRequirements(gate('{{config.review.writing_mode}}', ['w']), hardWriting).find((r) => r.kind === 'agent').mode, undefined);
});

test('a project with no config gets the shipped packs\' writing review as banner and its panel as hard', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  const config = spine.loadConfig(p);
  delete config.review.panel_mode;
  delete config.review.writing_mode;
  for (const cycle of ['build-and-ship', 'review-pr', 'digest']) {
    const formula = spine.loadFormula(p, cycle);
    for (const step of formula.steps.filter((s) => s.gate && s.gate.kind === 'adversarial')) {
      const agents = spine.compileRequirements(step, config).filter((r) => r.kind === 'agent');
      const banner = agents.every((r) => r.mode === 'banner');
      const hard = agents.every((r) => r.mode === undefined);
      if (/writing_mode/.test(String(step.gate.mode))) assert.ok(banner, `${cycle}/${step.id}: writing gate must default to banner`);
      else assert.ok(hard, `${cycle}/${step.id}: ${step.id} must default to hard`);
    }
  }
});

// ---------------------------------------------------------------- fix round: `plt run poll` gh calls

test('plt run poll drives gh through PLT_GH and bounds it with PLT_GH_TIMEOUT_MS', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-90', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  spine.recordReceipt(p, 'TRK-90', { step: 'scope', kind: 'artifact', name: 'dispatch-brief',
    ref: 'https://github.com/example-org/greenhouse/pull/42', pin: spine.computePin(repo), actor: 'agent' });
  const env = { ...process.env, PLT_PROCESS_DIR: p, PLT_GH: path.join(FIX, 'gh', 'stub.js'),
    PLT_GH_FIXTURE: path.join(FIX, 'gh', 'open-green-approved.json') };
  const ok = spawnSync(process.execPath, [PLT, 'run', 'poll', 'TRK-90'], { encoding: 'utf8', env });
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.strictEqual(JSON.parse(ok.stdout).facts.state, 'OPEN', 'the facts came from the stub, not from the real gh');

  // A hung gh must not hang the poll: it is bounded and the error names the timeout.
  const hang = path.join(root, 'gh-hangs');
  fs.writeFileSync(hang, '#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n');
  fs.chmodSync(hang, 0o755);
  const slow = spawnSync(process.execPath, [PLT, 'run', 'poll', 'TRK-90'],
    { encoding: 'utf8', env: { ...env, PLT_GH: hang, PLT_GH_TIMEOUT_MS: '400' } });
  assert.notStrictEqual(slow.status, 0);
  assert.match(slow.stdout + slow.stderr, /gh timed out after 400ms/);
});

// ---------------------------------------------------------------- fix round: null-window handoff

test('writeHandoff from a caller that cannot identify itself writes the handoff but never releases another window\'s claim', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-91', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  spine.stepStart(p, 'TRK-91', 'scope', { window: 'A' });
  assert.strictEqual(spine.readState(p, 'TRK-91').owner_window, 'A');
  const md = spine.writeHandoff(p, 'TRK-91', { goal: 'g', next: 'plt prime TRK-91', window: null });
  assert.match(md, /# Handoff/, 'the handoff is still written');
  assert.strictEqual(spine.readState(p, 'TRK-91').owner_window, 'A', 'a plain shell must not release window A\'s claim');
  // The owning window still releases it.
  spine.writeHandoff(p, 'TRK-91', { goal: 'g', next: 'plt prime TRK-91', window: 'A' });
  assert.strictEqual(spine.readState(p, 'TRK-91').owner_window, null);
});

// ---------------------------------------------------------------- fix round: writeState temp file

test('writeState leaves no .tmp file behind when the write or rename fails', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  const dir = path.join(p, 'runs', 'TRK-92');
  fs.mkdirSync(dir, { recursive: true });
  // A state.yaml that is a DIRECTORY makes the rename fail (EISDIR/ENOTEMPTY) after the temp write.
  fs.mkdirSync(path.join(dir, 'state.yaml'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.yaml', 'keep'), 'x');
  assert.throws(() => spine.writeState(p, 'TRK-92', { status: 'open' }));
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'the temp file was cleaned up');
});

// ---- writer moves: the schemas caught real defects in what plt writes -------------------------
// See .superpowers/sdd/2026-09-25-plan-3/schema-reconciliation.md.

test('launchRun writes status: open, so an open run is not a run with no status', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  const st = spine.launchRun(p, { runId: 'TRK-200', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  assert.strictEqual(st.status, 'open');
  assert.strictEqual(spine.readState(p, 'TRK-200').status, 'open');
  assert.strictEqual(require('../lib/schemas').validateObject('state', spine.readState(p, 'TRK-200')).ok, true);
});

test('appendEvent refuses an event with no kind — the one choke point every writer goes through', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-201', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  assert.throws(() => spine.appendEvent(p, 'TRK-201', { step: 'scope', actor: 'agent' }), /kind/);
  assert.throws(() => spine.appendEvent(p, 'TRK-201', { kind: 'vibes', step: 'scope' }), /vibes/);
});

test('recordReceipt refuses a kind no requirement can ever compile to', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-202', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  const pin = spine.computePin(repo);
  // `test` and `commit` both reached a live ledger: a receipt under a word nothing satisfies.
  assert.throws(() => spine.recordReceipt(p, 'TRK-202', { step: 'scope', kind: 'test', name: 'x', pin }), /test/);
  assert.throws(() => spine.recordReceipt(p, 'TRK-202', { step: 'scope', kind: 'commit', name: 'x', pin }), /commit/);
  assert.ok(spine.recordReceipt(p, 'TRK-202', { step: 'scope', kind: 'tool', name: 'x', pin }));
});

test('recordReceipt refuses a verdict outside pass|fail — bannerFails keys off fail', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-203', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  const pin = spine.computePin(repo);
  assert.throws(() => spine.recordReceipt(p, 'TRK-203', { step: 'review', kind: 'agent', name: 'a', pin, verdict: 'approve' }), /verdict/);
  assert.ok(spine.recordReceipt(p, 'TRK-203', { step: 'review', kind: 'agent', name: 'a', pin, verdict: 'pass' }));
});

test('closeRun and discardRun write the ROLE in actor and the PERSON in by, with no human: prefix', () => {
  const schemas = require('../lib/schemas');
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-204', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  spine.discardRun(p, 'TRK-204', { by: 'human:alice', reason: 'superseded' });
  const discarded = spine.readEvents(p, 'TRK-204').find((e) => e.what === 'discarded');
  assert.strictEqual(discarded.actor, 'human');
  assert.strictEqual(discarded.by, 'alice');

  const mid = spine.readState(p, 'TRK-204');
  for (const id of Object.keys(mid.steps)) mid.steps[id].status = 'done';
  mid.current_step = null; spine.writeState(p, 'TRK-204', mid);
  spine.closeRun(p, 'TRK-204', { by: 'alice' });
  const closed = spine.readEvents(p, 'TRK-204').find((e) => e.what === 'closed');
  assert.strictEqual(closed.actor, 'human');
  assert.strictEqual(closed.by, 'alice');

  for (const e of spine.readEvents(p, 'TRK-204')) {
    assert.strictEqual(schemas.validateObject('event', e).ok, true, e.id + ' ' + JSON.stringify(e));
  }
});

test('closeRun by the agent stays actor: agent and names no person', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-205', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  const st = spine.readState(p, 'TRK-205');
  for (const id of Object.keys(st.steps)) st.steps[id].status = 'done';
  st.current_step = null; spine.writeState(p, 'TRK-205', st);
  spine.closeRun(p, 'TRK-205', { by: 'agent' });
  const closed = spine.readEvents(p, 'TRK-205').find((e) => e.what === 'closed');
  assert.strictEqual(closed.actor, 'agent');
  assert.strictEqual(closed.by, undefined);
});

test('reviewFacts: authorHandedBack separates "the author is working" from "the author is done"', () => {
  const base = { ours: 'me', prAuthor: 'them', headRefOid: 'aaa',
    reviews: [{ author: { login: 'me' }, state: 'COMMENTED', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: 'aaa' } }] };
  const replied = [{ user: { login: 'them' }, created_at: '2026-01-02T00:00:00Z' }];

  // One reply, threads still open, no re-request: the author is WORKING. This is the case that used
  // to arm the owner's follow-up and put "needs you" on the board while three more commits landed.
  const working = spine.reviewFacts({ ...base, reviewComments: replied, threadsUnresolved: 5 });
  assert.strictEqual(working.authorRepliedSinceOurReview, true, 'they did reply');
  assert.strictEqual(working.authorHandedBack, false, 'but they have not handed it back');

  // Re-requesting our review is the explicit second ask.
  assert.strictEqual(spine.reviewFacts({ ...base, reviewComments: replied, threadsUnresolved: 5,
    reviewRequests: [{ login: 'me' }] }).authorHandedBack, true);
  // Someone ELSE being re-requested is not our signal.
  assert.strictEqual(spine.reviewFacts({ ...base, reviewComments: replied, threadsUnresolved: 5,
    reviewRequests: [{ login: 'other' }] }).authorHandedBack, false);
  // Every thread answered and none unresolved is the other way to be done.
  assert.strictEqual(spine.reviewFacts({ ...base, reviewComments: replied, threadsUnresolved: 0 }).authorHandedBack, true);
  // Zero unresolved with no reply at all is not a hand-back — it is a PR nobody has touched.
  assert.strictEqual(spine.reviewFacts({ ...base, reviewComments: [], threadsUnresolved: 0 }).authorHandedBack, false);
  // A thread count we could not read is not zero.
  assert.strictEqual(spine.reviewFacts({ ...base, reviewComments: replied, threadsUnresolved: null }).authorHandedBack, false);

  // Before we have posted anything, both facts are false rather than absent.
  const none = spine.reviewFacts({ ours: 'me', prAuthor: 'them', reviews: [], headRefOid: 'aaa' });
  assert.strictEqual(none.authorHandedBack, false);
  assert.strictEqual(none.reReviewRequested, false);
});

test('stepUnstart: a step started in error goes back, but only when it produced no evidence', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-90', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  spine.stepStart(p, 'TRK-90', 'scope');
  assert.strictEqual(spine.readState(p, 'TRK-90').steps.scope.status, 'in_progress');

  assert.throws(() => spine.stepUnstart(p, 'TRK-90', 'scope', {}), /unstart needs --reason/);
  const st = spine.stepUnstart(p, 'TRK-90', 'scope', { reason: 'started by mistake', by: 'lead' });
  assert.strictEqual(st.steps.scope.status, 'ready', 'the first step is armed again exactly as at launch');
  assert.strictEqual(st.steps.scope.started, null);
  const ev = spine.readEvents(p, 'TRK-90').filter((e) => e.what === 'unstarted').pop();
  assert.strictEqual(ev.reason, 'started by mistake', 'the ledger records why, not just that');
  // stepStart sets current_step and claims owner_window; unstart must release both, or the prime
  // keeps saying "finish this step" and the run stays claimed by the window that mis-started it.
  assert.strictEqual(spine.readState(p, 'TRK-90').current_step, undefined, 'current_step released');
  assert.strictEqual(spine.readState(p, 'TRK-90').owner_window, undefined, 'window claim released');

  // Only in_progress can be unstarted — unless the step is stranded as current_step, which is the
  // same corruption half-applied and has no other way back, because start refuses a pending step.
  assert.throws(() => spine.stepUnstart(p, 'TRK-90', 'scope', { reason: 'again' }), /is ready; only in_progress/);
  const half = spine.readState(p, 'TRK-90'); half.current_step = 'scope'; half.owner_window = 'w9:pZ';
  spine.writeState(p, 'TRK-90', half);
  const repaired = spine.stepUnstart(p, 'TRK-90', 'scope', { reason: 'stranded as current_step' });
  assert.strictEqual(repaired.current_step, undefined);
  assert.strictEqual(repaired.owner_window, undefined);

  // A step that produced evidence is never silently rewound.
  spine.stepStart(p, 'TRK-90', 'scope');
  spine.recordReceipt(p, 'TRK-90', { step: 'scope', kind: 'skill', name: 'sprout-scope', pin: spine.computePin(repo), actor: 'agent' });
  assert.throws(() => spine.stepUnstart(p, 'TRK-90', 'scope', { reason: 'oops' }), /has 1 receipt\(s\); finish or discard it/);
});

// ---- a formula that fails validation does not launch (plan 4 D-025) ----

const SEEDLING_CYCLE = (signal) => ['---', 'name: seedling', 'kind: workflow', 'version: 1',
  'description: "Pot a seedling."', 'inputs: [card]', 'actors: [agent, owner]', '---', '', '# Seedling', '', 'steps:',
  '  - id: pot', '    assignee: agent', '    title: "Pot {card}"',
  '  - id: check', '    assignee: owner', '    title: "Check {card}"', '    needs: [pot]',
  '    gate:', '      kind: human', `      signal: ${signal}`, ''].join('\n');

test('launchRun: a formula with a gate.signal outside config.gates.human_signals refuses with file and line, and creates no run directory', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  fs.writeFileSync(path.join(p, 'cycles', 'seedling.md'), SEEDLING_CYCLE('seedling-sprouted'));
  assert.throws(() => spine.launchRun(p, { runId: 'TRK-300', cycle: 'seedling', repoDir: repo, owner: 'lead' }),
    /^Error: formula process\/cycles\/seedling\.md:\d+: .*seedling-sprouted/);
  assert.strictEqual(fs.existsSync(path.join(p, 'runs', 'TRK-300')), false, 'nothing is written for a refused launch');
  // The same formula with a known signal launches unchanged.
  fs.writeFileSync(path.join(p, 'cycles', 'seedling.md'), SEEDLING_CYCLE('artifact-approved'));
  assert.strictEqual(spine.launchRun(p, { runId: 'TRK-300', cycle: 'seedling', repoDir: repo, owner: 'lead' }).steps.pot.status, 'ready');
});

test('launchRun: an overlay is validated merged with its base — a broken override refuses at the overlay line, a clean one launches', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  fs.writeFileSync(path.join(p, 'config', 'tools.yaml'), 'tools: { research: [seed_catalog] }\nreview: { spike_agents: [] }\n');   // core/spike names it
  const overlay = (extra) => ['---', 'name: greenhouse-spike', 'kind: workflow', 'version: 1', 'extends: core/spike',
    'description: "Greenhouse overlay of the core spike."', 'inputs: [card, effort, repo_dir]', 'actors: [agent]', '---', '',
    '# Greenhouse spike', '', 'steps:', '  - id: investigate', '    assignee: agent', '    title: "Investigate {card} in the greenhouse"', ...extra, ''].join('\n');
  // `{bench}` is not an input of the overlay or of core/spike: the merged formula fails at the overlay's step.
  fs.writeFileSync(path.join(p, 'cycles', 'greenhouse-spike.md'), overlay(['    notes: "Check {bench} first."']));
  assert.throws(() => spine.launchRun(p, { runId: 'TRK-301', cycle: 'greenhouse-spike', repoDir: repo }),
    /formula process\/cycles\/greenhouse-spike\.md:14: step `investigate`: notes uses \{bench\}/);
  assert.strictEqual(fs.existsSync(path.join(p, 'runs', 'TRK-301')), false);
  // A clean overlay launches, and the base's steps come through the merge.
  fs.writeFileSync(path.join(p, 'cycles', 'greenhouse-spike.md'), overlay(['    notes: "Check {card} first."']));
  const st = spine.launchRun(p, { runId: 'TRK-301', cycle: 'greenhouse-spike', repoDir: repo });
  assert.deepStrictEqual(Object.keys(st.steps).sort(), Object.keys(spine.loadFormula(p, 'greenhouse-spike').steps.reduce((a, s) => ({ ...a, [s.id]: 1 }), {})).sort());
});

test('launchRun: an overlay with `steps: []` validates as the merged formula, not as an empty file', () => {
  // The fixture discard exit declares no steps of its own; alone it fails "must have a steps block".
  const root = tmpProcess(); const p = path.join(root, 'process');
  assert.deepStrictEqual(spine.validateFormula(p, 'discard'), []);
});

test('launchRun: an artifact named by a template under process/templates is known', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  fs.mkdirSync(path.join(p, 'templates'), { recursive: true });
  const cyc = SEEDLING_CYCLE('artifact-approved').replace('    title: "Pot {card}"', '    title: "Pot {card}"\n    artifact: bench-plan');
  fs.writeFileSync(path.join(p, 'cycles', 'seedling.md'), cyc);
  assert.throws(() => spine.launchRun(p, { runId: 'TRK-302', cycle: 'seedling', repoDir: repo }), /artifact `bench-plan` is not a known template/);
  fs.writeFileSync(path.join(p, 'templates', 'bench-plan.md'), '---\nname: bench-plan\nkind: template\n---\n\n# Bench plan\n');
  assert.strictEqual(spine.launchRun(p, { runId: 'TRK-302', cycle: 'seedling', repoDir: repo }).run, 'TRK-302');
});

test('recompileRun: a formula broken after launch refuses and writes nothing', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  fs.writeFileSync(path.join(p, 'cycles', 'seedling.md'), SEEDLING_CYCLE('artifact-approved'));
  spine.launchRun(p, { runId: 'TRK-303', cycle: 'seedling', repoDir: repo });
  const before = fs.readFileSync(path.join(p, 'runs', 'TRK-303', 'state.yaml'), 'utf8');
  const events = spine.readEvents(p, 'TRK-303').length;
  fs.writeFileSync(path.join(p, 'cycles', 'seedling.md'), SEEDLING_CYCLE('seedling-sprouted'));
  assert.throws(() => spine.recompileRun(p, 'TRK-303'), /formula process\/cycles\/seedling\.md:\d+: .*seedling-sprouted/);
  assert.strictEqual(fs.readFileSync(path.join(p, 'runs', 'TRK-303', 'state.yaml'), 'utf8'), before);
  assert.strictEqual(spine.readEvents(p, 'TRK-303').length, events);
});

test('cli: plt validate --project knows the templates under <project>/process/templates, as launch does', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  const file = path.join(p, 'cycles', 'seedling.md');
  fs.writeFileSync(file, SEEDLING_CYCLE('artifact-approved').replace('    title: "Pot {card}"', '    title: "Pot {card}"\n    artifact: bench-plan'));
  const env = { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'home-')) };
  delete env.PLT_PROCESS_DIR; delete env.PLT_INSTANCE_DIR; delete env.PUNCHLIST_DATA;
  const run = () => spawnSync('node', [PLT, 'validate', file, '--project', root], { encoding: 'utf8', env });
  assert.match(run().stdout, /artifact `bench-plan` is not a known template/);
  fs.mkdirSync(path.join(p, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(p, 'templates', 'bench-plan.md'), '---\nname: bench-plan\nkind: template\n---\n\n# Bench plan\n');
  const ok = run();
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
});

// ---- a receipt the spine did not earn says so (plan 4 D-027) ----

test('recordReceipt: a receipt on a step that is not in progress or in review carries out_of_band; one on a working step does not; prime counts them', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-310', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  const pin = spine.computePin(repo);
  const early = spine.recordReceipt(p, 'TRK-310', { step: 'build', kind: 'skill', name: 'sprout-conventions', pin, actor: 'agent' });
  assert.strictEqual(early.out_of_band, true, 'build is pending: nothing the spine ran earned this');
  const ready = spine.recordReceipt(p, 'TRK-310', { step: 'scope', kind: 'skill', name: 'sprout-scope', pin, actor: 'agent' });
  assert.strictEqual(ready.out_of_band, true, 'a ready step has not started either');
  spine.stepStart(p, 'TRK-310', 'scope');
  const earned = spine.recordReceipt(p, 'TRK-310', { step: 'scope', kind: 'skill', name: 'sprout-scope', pin, actor: 'agent' });
  assert.strictEqual(earned.out_of_band, undefined);
  // Recorded, marked, never refused: the out-of-band receipt still counts toward the gate.
  assert.ok(!spine.gateCheck(p, 'TRK-310', 'build').missing.some((m) => m.kind === 'skill' && m.name === 'sprout-conventions'));
  assert.match(spine.renderPrime(p, 'TRK-310'), /⚠ 2 receipts recorded out of band/);
});

test('renderPrime: no out-of-band line when every receipt was earned', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-311', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  spine.stepStart(p, 'TRK-311', 'scope');
  spine.recordReceipt(p, 'TRK-311', { step: 'scope', kind: 'skill', name: 'sprout-scope', pin: spine.computePin(repo), actor: 'agent' });
  assert.doesNotMatch(spine.renderPrime(p, 'TRK-311'), /out of band/);
});

// ---- a per-reply gate re-opens instead of settling once (plan 4, the reply step's repeat_until) ----

function atReply(p, runId, repo) {
  spine.launchRun(p, { runId, cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  const st = spine.readState(p, runId);
  for (const id of ['scope', 'build', 'review', 'write-review', 'pre-pr', 'approve', 'open-pr']) st.steps[id].status = 'done';
  for (const id of ['pr-loop', 'reply', 'announce']) st.steps[id].status = 'ready';
  spine.writeState(p, runId, st);
}

test('gateApprove: the reply step re-opens after each approval — a second approval at the same pin or a new pin is recorded, not refused', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  atReply(p, 'TRK-320', repo);
  spine.gateApprove(p, 'TRK-320', 'reply', { by: 'human:lead' });
  let st = spine.readState(p, 'TRK-320');
  assert.strictEqual(st.steps.reply.status, 'ready', 'one approval is one reply, not the end of replies');
  assert.strictEqual(st.steps.reply.outcome, 'replied');
  assert.ok(spine.readEvents(p, 'TRK-320').some((e) => e.what === 'repeated' && e.step === 'reply' && e.outcome === 'replied'));
  // The next reply, same tree: approved again, not "already done and approved at this pin".
  spine.gateApprove(p, 'TRK-320', 'reply', { by: 'human:lead' });
  // And after a push.
  fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
  execFileSync('git', ['-C', repo, 'add', 'b.txt']); execFileSync('git', ['-C', repo, 'commit', '-qm', 'fix']);
  spine.gateApprove(p, 'TRK-320', 'reply', { by: 'human:lead' });
  st = spine.readState(p, 'TRK-320');
  assert.strictEqual(st.steps.reply.status, 'ready');
  assert.strictEqual(spine.readEvents(p, 'TRK-320').filter((e) => e.kind === 'gate' && e.step === 'reply' && e.result === 'approve').length, 3);
  // Closing the run retires the standing step as before.
  st.steps.merge.status = 'done'; st.steps['close-out'].status = 'done'; st.steps['pr-loop'].status = 'done'; st.steps.announce.status = 'done';
  spine.writeState(p, 'TRK-320', st);
  assert.strictEqual(spine.closeRun(p, 'TRK-320', { warn: () => {} }).steps.reply.status, 'skipped');
});

test('repeat_until: pr-loop settles only on its terminal outcome; changes_requested re-opens it and leaves merge pending', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  atReply(p, 'TRK-321', repo);
  const pin = spine.computePin(repo);
  const loop = () => {
    spine.stepStart(p, 'TRK-321', 'pr-loop');
    for (const r of spine.readState(p, 'TRK-321').steps['pr-loop'].receipts_required.filter((x) => x.kind !== 'gate')) {
      spine.recordReceipt(p, 'TRK-321', { step: 'pr-loop', kind: r.kind, name: r.name, pin, actor: 'agent', verdict: r.kind === 'agent' ? 'pass' : undefined });
    }
  };
  loop();
  spine.stepFinish(p, 'TRK-321', 'pr-loop', { outcome: 'changes_requested', noExtrapolations: true });
  spine.gateApprove(p, 'TRK-321', 'pr-loop', { by: 'human:lead' });
  let st = spine.readState(p, 'TRK-321');
  assert.strictEqual(st.steps['pr-loop'].status, 'ready');
  assert.strictEqual(st.steps.merge.status, 'pending', 'a loop that has not ended readies nothing');
  loop();
  spine.stepFinish(p, 'TRK-321', 'pr-loop', { outcome: 'approved', noExtrapolations: true });
  spine.gateApprove(p, 'TRK-321', 'pr-loop', { by: 'human:lead' });
  st = spine.readState(p, 'TRK-321');
  assert.strictEqual(st.steps['pr-loop'].status, 'done');
  assert.strictEqual(st.steps['pr-loop'].outcome, 'approved');
  assert.strictEqual(st.steps.merge.status, 'ready');
});

// ---- dead constants and the words prime and the menu use (plan 4 Task 7) ----

test('STATE_ENUM and the state schema have no `claimed`: nothing writes it (the launch time event keeps the name)', () => {
  assert.ok(!spine.STATE_ENUM.includes('claimed'));
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'state.schema.json'), 'utf8'));
  assert.ok(!JSON.stringify(schema).includes('"claimed"'));
});

test('prime names the block command that exists, and the menu block phrase runs it', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-330', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  assert.match(spine.renderPrime(p, 'TRK-330'), /block with `plt step block <step> --run TRK-330 --question <text>`/);
  const st = spine.readState(p, 'TRK-330'); st.steps.scope.status = 'in_review';
  const block = spine.menuFor(st, []).phrases.find((x) => x.id === 'block');
  assert.strictEqual(block.command, 'plt step block {step} --run {run} --question {payload}');
});

test('repeat_until: a re-open on one step does not drop an approval given on another', () => {
  // The owner approves pr-loop while it is still in progress, then a reply re-opens `reply`.
  // pr-loop's approval was given after none of pr-loop's own re-opens, so it still counts.
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  atReply(p, 'TRK-322', repo);
  const pin = spine.computePin(repo);
  spine.stepStart(p, 'TRK-322', 'pr-loop');
  spine.gateApprove(p, 'TRK-322', 'pr-loop', { by: 'human:lead' });
  assert.strictEqual(spine.readState(p, 'TRK-322').steps['pr-loop'].status, 'in_progress', 'receipts still missing: no settle yet');
  spine.gateApprove(p, 'TRK-322', 'reply', { by: 'human:lead' });
  assert.ok(spine.readEvents(p, 'TRK-322').some((e) => e.what === 'repeated' && e.step === 'reply'));
  for (const r of spine.readState(p, 'TRK-322').steps['pr-loop'].receipts_required.filter((x) => x.kind !== 'gate')) {
    spine.recordReceipt(p, 'TRK-322', { step: 'pr-loop', kind: r.kind, name: r.name, pin, actor: 'agent', verdict: r.kind === 'agent' ? 'pass' : undefined });
  }
  const st = spine.stepFinish(p, 'TRK-322', 'pr-loop', { outcome: 'approved', noExtrapolations: true });
  assert.strictEqual(st.steps['pr-loop'].status, 'done', 'the earlier pr-loop approval satisfies the gate');
});

test('recordReceipt: the fact collector\'s receipt on a pending step that requires it is expected, not out of band; an agent receipt there still is', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  atReply(p, 'TRK-312', repo);
  assert.strictEqual(spine.readState(p, 'TRK-312').steps.merge.status, 'pending');
  const pin = spine.computePin(repo);
  const fact = spine.recordReceipt(p, 'TRK-312', { step: 'merge', kind: 'gh', name: 'checks-green', result: 'pass', pin, actor: 'facts', [spine.FACTS_COLLECTOR]: true });
  assert.strictEqual(fact.out_of_band, undefined, 'the spine collected this fact for the step that names it');
  assert.doesNotMatch(spine.renderPrime(p, 'TRK-312'), /out of band/);
  // A facts receipt for a name the step does not require is not the collector doing its job.
  assert.strictEqual(spine.recordReceipt(p, 'TRK-312', { step: 'merge', kind: 'gh', name: 'review-posted', result: 'pass', pin, actor: 'facts', [spine.FACTS_COLLECTOR]: true }).out_of_band, true);
  const agent = spine.recordReceipt(p, 'TRK-312', { step: 'merge', kind: 'gh', name: 'threads_resolved', result: 'pass', pin, actor: 'agent' });
  assert.strictEqual(agent.out_of_band, true);
  assert.match(spine.renderPrime(p, 'TRK-312'), /⚠ 2 receipts recorded out of band/);
});

test('recordReceipt: a receipt with no step, or an unknown step, is out of band', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-313', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  const pin = spine.computePin(repo);
  assert.strictEqual(spine.recordReceipt(p, 'TRK-313', { kind: 'skill', name: 'x', pin }).out_of_band, true);
  assert.strictEqual(spine.recordReceipt(p, 'TRK-313', { step: 'no-such', kind: 'skill', name: 'x', pin }).out_of_band, true);
});

// ---- a re-opened loop step is not a standing "needs you" (fix round 1, item 3) ----

test('repeat_until: a loop step with arm_on re-opens to pending, and the poll re-arms it on the next hit', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  fs.writeFileSync(path.join(p, 'cycles', 'answering.md'), ['---', 'name: answering', 'kind: workflow', 'version: 1',
    'description: "Answer the author."', 'inputs: [card]', 'actors: [agent, owner]', '---', '', '# Answering', '', 'steps:',
    '  - id: post', '    assignee: agent', '    title: "Post {card}"',
    '  - id: follow-up', '    assignee: owner', '    title: "Approve each reply on {card}"', '    needs: [post]',
    '    arm_on: { gh: authorRepliedSinceOurReview, equals: true }', '    waiting: "the author to reply"',
    '    gate:', '      kind: human', '      signal: reply-approved', '    outcomes: [replied, done]', '    repeat_until: done', ''].join('\n'));
  spine.launchRun(p, { runId: 'TRK-323', cycle: 'answering', repoDir: repo });
  spine.stepStart(p, 'TRK-323', 'post');
  spine.stepFinish(p, 'TRK-323', 'post', { noExtrapolations: true });
  assert.deepStrictEqual(spine.pollRun(p, 'TRK-323', { authorRepliedSinceOurReview: true }).armed, ['follow-up']);
  spine.gateApprove(p, 'TRK-323', 'follow-up', { by: 'human:lead' });
  assert.strictEqual(spine.readState(p, 'TRK-323').steps['follow-up'].status, 'pending', 'no reply is waiting after the approval');
  assert.deepStrictEqual(spine.pollRun(p, 'TRK-323', { authorRepliedSinceOurReview: true }).armed, ['follow-up'], 'the next hit re-arms it');
});

test('render: a ready owner step whose last event is `repeated` waits for the next round; it is not "Needs you"', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  const render = require('../lib/render');
  atReply(p, 'TRK-13', repo);
  fs.writeFileSync(path.join(p, 'runs', 'TRK-13', 'inputs.yaml'), 'card: TRK-13\neffort: greenhouse\n');
  const st = spine.readState(p, 'TRK-13');
  st.steps['pr-loop'].status = 'done'; st.steps.announce.status = 'done';
  spine.writeState(p, 'TRK-13', st);
  const needsYou = (html) => (html.match(/<div class="human">[\s\S]*?<\/div>/) || [''])[0];
  const cfg = spine.loadConfig(p);
  assert.match(needsYou(render.renderIndex(p, cfg)), /TRK-13/, 'before the first approval the reply waits on the owner');
  spine.gateApprove(p, 'TRK-13', 'reply', { by: 'human:lead' });
  const html = render.renderIndex(p, cfg);
  assert.doesNotMatch(needsYou(html), /TRK-13/, 'after an approval there is nothing to approve');
  assert.match(html, /waiting on the next reply/);
});

// ---- between rounds, no surface offers an approval (fix round 2) ----

const ANSWERING = ['---', 'name: answering', 'kind: workflow', 'version: 1',
  'description: "Answer the author."', 'inputs: [card]', 'actors: [agent, owner]', '---', '', '# Answering', '', 'steps:',
  '  - id: post', '    assignee: agent', '    title: "Post {card}"',
  '  - id: follow-up', '    assignee: owner', '    title: "Approve each reply on {card}"', '    needs: [post]', '    manual: true',
  '    arm_on: { gh: authorRepliedSinceOurReview, equals: true }', '    waiting: "the author to reply"',
  '    gate:', '      kind: human', '      signal: reply-approved', '    outcomes: [replied, done]', '    repeat_until: done', ''].join('\n');

// The three surfaces a person or agent reads for "what now": nextCommand (prime's NEXT line), the
// menu under prime, and the board row. Returns what each offers.
function surfaces(p, runId) {
  const st = spine.readState(p, runId); const events = spine.readEvents(p, runId);
  const wf = spine.runFormula(p, st);
  const render = require('../lib/render');
  const html = render.renderIndex(p, spine.loadConfig(p));
  const row = (html.match(new RegExp(`<tr[^>]*><td>(?:<a[^>]*>)?${runId}[\\s\\S]*?</tr>`)) || [''])[0];
  const needsYou = (html.match(/<div class="human">[\s\S]*?<\/div>/) || [''])[0];
  const menu = spine.menuFor(st, events);
  return { next: spine.nextCommand(st, wf, events), prime: spine.renderPrime(p, runId), menu, row, needsYou };
}
function assertNoApproval(x, runId, step) {
  assert.doesNotMatch(x.next, /gate approve/, 'nextCommand: ' + x.next);
  assert.doesNotMatch(x.prime, new RegExp(`NEXT: .*gate approve ${runId} ${step}`), 'prime NEXT line');
  assert.strictEqual(x.menu.mode, 'WAITING');
  assert.ok(!x.menu.phrases.some((f) => f.id === 'approve' || f.id === 'go'), 'menu: ' + x.menu.phrases.map((f) => f.id));
  assert.doesNotMatch(x.row, /gate approve/, 'board row');
  assert.doesNotMatch(x.needsYou, new RegExp(runId), 'Needs you');
}

test('between rounds: the reply step offers no approve and no go on nextCommand, prime, the menu or the board', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  atReply(p, 'TRK-13', repo);
  fs.writeFileSync(path.join(p, 'runs', 'TRK-13', 'inputs.yaml'), 'card: TRK-13\neffort: greenhouse\n');
  const st = spine.readState(p, 'TRK-13');
  st.steps['pr-loop'].status = 'done'; st.steps.announce.status = 'done';
  spine.writeState(p, 'TRK-13', st);
  assert.match(surfaces(p, 'TRK-13').next, /gate approve TRK-13 reply/, 'before the first approval the reply is offered');
  spine.gateApprove(p, 'TRK-13', 'reply', { by: 'human:lead' });
  const x = surfaces(p, 'TRK-13');
  assertNoApproval(x, 'TRK-13', 'reply');
  assert.match(x.next, /waiting on the next reply/);
  assert.match(x.prime, /▶ TRK-13 · reply · waiting on the next reply/);
});

test('between rounds on an arm_on loop: nothing is offered until the poll sees a new reply, then all three offer it again', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  fs.writeFileSync(path.join(p, 'cycles', 'answering.md'), ANSWERING);
  spine.launchRun(p, { runId: 'TRK-14', cycle: 'answering', repoDir: repo });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-14', 'inputs.yaml'), 'card: TRK-14\neffort: greenhouse\n');
  spine.stepStart(p, 'TRK-14', 'post');
  spine.stepFinish(p, 'TRK-14', 'post', { noExtrapolations: true });
  spine.pollRun(p, 'TRK-14', { authorRepliedSinceOurReview: true });
  spine.gateApprove(p, 'TRK-14', 'follow-up', { by: 'human:lead' });
  const x = surfaces(p, 'TRK-14');
  assertNoApproval(x, 'TRK-14', 'follow-up');
  assert.match(x.next, /waiting on the author to reply/);
  // A new reply: the poll re-arms the step, and every surface offers the approval again.
  spine.pollRun(p, 'TRK-14', { authorRepliedSinceOurReview: false });
  spine.pollRun(p, 'TRK-14', { authorRepliedSinceOurReview: true });
  const y = surfaces(p, 'TRK-14');
  assert.match(y.next, /gate approve TRK-14 follow-up/);
  assert.match(y.prime, /NEXT: plt gate approve TRK-14 follow-up/);
  assert.notStrictEqual(y.menu.mode, 'WAITING');
  assert.ok(y.menu.phrases.some((f) => f.id === 'go'), 'the menu offers go again');
  assert.match(y.needsYou, /TRK-14 — <code>plt gate approve TRK-14 follow-up/);
});

test('between rounds: the run page names the wait, not an approval', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  atReply(p, 'TRK-13', repo);
  const st = spine.readState(p, 'TRK-13');
  st.steps['pr-loop'].status = 'done'; st.steps.announce.status = 'done';
  spine.writeState(p, 'TRK-13', st);
  spine.gateApprove(p, 'TRK-13', 'reply', { by: 'human:lead' });
  const page = require('../lib/render').renderRun(p, 'TRK-13', spine.loadConfig(p));
  assert.ok(page.includes('nothing for you — waiting on the next reply'));
  assert.doesNotMatch(page, /gate approve TRK-13 reply/);
});

// ---- final review F-1: stepUnstart takes the guards every step writer takes ----

test('stepUnstart: a foreign window is refused, --take-over moves the claim and logs it, a windowless caller passes', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-91', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  spine.stepStart(p, 'TRK-91', 'scope', { window: 'w1' });
  const n = spine.readEvents(p, 'TRK-91').length;
  assert.throws(() => spine.stepUnstart(p, 'TRK-91', 'scope', { reason: 'mistake', window: 'w2' }), /driven by window w1; hand off first \(or --take-over\)/);
  assert.strictEqual(spine.readState(p, 'TRK-91').steps.scope.status, 'in_progress', 'a refused unstart writes nothing');
  assert.strictEqual(spine.readEvents(p, 'TRK-91').length, n);
  const st = spine.stepUnstart(p, 'TRK-91', 'scope', { reason: 'mistake', window: 'w2', takeOver: true });
  assert.strictEqual(st.steps.scope.status, 'ready');
  assert.ok(spine.readEvents(p, 'TRK-91').some((e) => e.what === 'taken-over' && e.from === 'w1' && e.window === 'w2'), 'the take-over is in the ledger');
  // A caller with no window passes, as it does for every other writer.
  spine.stepStart(p, 'TRK-91', 'scope', { window: 'w1' });
  assert.strictEqual(spine.stepUnstart(p, 'TRK-91', 'scope', { reason: 'again', window: null }).steps.scope.status, 'ready');
});

test('stepUnstart: a window that does not hold the run\'s repo is refused', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-92', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  spine.stepStart(p, 'TRK-92', 'scope', { window: null });
  spine.claimRepo(repo, 'w1');
  assert.throws(() => spine.stepUnstart(p, 'TRK-92', 'scope', { reason: 'mistake', window: 'w2' }), /is being driven by window w1/);
});

test('cli: plt step unstart honours --take-over', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-93', cycle: 'build-and-ship', repoDir: repo, owner: 'lead', estimate: 0.5 });
  spine.stepStart(p, 'TRK-93', 'scope', { window: 'w1' });
  const env = { ...process.env, PLT_PROCESS_DIR: p, PLT_WINDOW: 'w2' };
  delete env.PLT_BIN; delete env.PUNCHLIST_TEMPLATES_DIR;
  const run = (extra) => spawnSync('node', [PLT, 'step', 'unstart', 'scope', '--run', 'TRK-93', '--reason', 'mistake', ...extra], { encoding: 'utf8', env });
  assert.notStrictEqual(run([]).status, 0);
  const ok = run(['--take-over']);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.strictEqual(spine.readState(p, 'TRK-93').steps.scope.status, 'ready');
});

// ---- final review F-3: the collector exemption keys on the code path, not the actor string ----

test('recordReceipt: actor facts alone does not earn the exemption — only the collector\'s internal option does', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  atReply(p, 'TRK-314', repo);
  const pin = spine.computePin(repo);
  const typed = spine.recordReceipt(p, 'TRK-314', { step: 'merge', kind: 'gh', name: 'checks-green', result: 'pass', pin, actor: 'facts' });
  assert.strictEqual(typed.out_of_band, true, 'a hand-written actor: facts is not the collector');
  assert.ok(!Object.getOwnPropertySymbols(typed).length && !('collector' in typed), 'the option is not written to the ledger');
});

test('cli: plt receipt --actor facts is refused; only plt facts records as the collector', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  atReply(p, 'TRK-315', repo);
  const env = { ...process.env, PLT_PROCESS_DIR: p }; delete env.PLT_BIN; delete env.PUNCHLIST_TEMPLATES_DIR; delete env.PLT_WINDOW;
  const r = spawnSync('node', [PLT, 'receipt', '--run', 'TRK-315', '--step', 'merge', '--kind', 'gh', '--name', 'checks-green', '--result', 'pass', '--actor', 'facts'], { encoding: 'utf8', env });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /--actor facts is reserved for plt facts/);
  assert.ok(!spine.readEvents(p, 'TRK-315').some((e) => e.kind === 'gh' && e.name === 'checks-green'), 'nothing is recorded');
});
