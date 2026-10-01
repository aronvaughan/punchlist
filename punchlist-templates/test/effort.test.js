'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const effort = require('../lib/effort');
const spine = require('../lib/spine');
const yaml = require('../lib/yaml');
const FIX = path.join(__dirname, 'fixtures', 'spine');

function tmpProcess() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-'));
  fs.cpSync(FIX, path.join(root, 'process'), { recursive: true });
  return root;
}

// A standalone one-commit repo — good enough for overlapCheck's own-diff comparisons, which
// never need two runs to share history (each run diffs only against its own captured base).
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

// A bare "origin" with one commit on `main`, cloned twice — for the base-freshness check, which
// needs a real `origin/main` ref that one clone can push past the other.
function tmpRepoPair() {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-'));
  execFileSync('git', ['-C', origin, 'init', '-q', '--bare']);
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
  execFileSync('git', ['-C', seed, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', seed, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', seed, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(seed, 'seed.txt'), 'seed\n');
  execFileSync('git', ['-C', seed, 'add', 'seed.txt']);
  execFileSync('git', ['-C', seed, 'commit', '-qm', 'init']);
  execFileSync('git', ['-C', seed, 'remote', 'add', 'origin', origin]);
  execFileSync('git', ['-C', seed, 'push', '-q', 'origin', 'main']);
  execFileSync('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);   // bare init defaults HEAD elsewhere
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-b-'));
  execFileSync('git', ['clone', '-q', origin, a]);
  execFileSync('git', ['clone', '-q', origin, b]);
  for (const dir of [a, b]) {
    execFileSync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  }
  return { origin, a, b };
}

function writeFile(repoDir, relPath, content) {
  const full = path.join(repoDir, relPath);
  if (content === null) { fs.rmSync(full, { force: true }); return; }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function gitAdd(repoDir) {
  execFileSync('git', ['-C', repoDir, 'add', '-A']);
}

function writeInputs(processDir, runId, inputs) {
  const dir = path.join(processDir, 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'inputs.yaml'), yaml.stringify(inputs));
}

// A real canonical checkout with a resolvable `origin/main` — `git worktree add` needs it, and
// launchWave's exec is stubbed to actually run git commands (only the fake `windows.command` is
// intercepted), so worktrees really land on disk and `spine.launchRun` sees a real repo.
function tmpCanonical() {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-origin-'));
  execFileSync('git', ['-C', origin, 'init', '-q', '--bare']);
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-seed-'));
  execFileSync('git', ['-C', seed, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', seed, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', seed, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(seed, 'seed.txt'), 'seed\n');
  execFileSync('git', ['-C', seed, 'add', 'seed.txt']);
  execFileSync('git', ['-C', seed, 'commit', '-qm', 'init']);
  execFileSync('git', ['-C', seed, 'remote', 'add', 'origin', origin]);
  execFileSync('git', ['-C', seed, 'push', '-q', 'origin', 'main']);
  execFileSync('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const canon = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-canon-'));
  execFileSync('git', ['clone', '-q', origin, canon]);
  execFileSync('git', ['-C', canon, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', canon, 'config', 'user.name', 't']);
  return canon;
}

// Overlay written into a copied tmpProcess's config dir — sorts after every fixture org file
// (alphabetically last), so it wins on the keys it sets, same rule `loadConfig` documents.
function writeConfigOverlay(processDir, obj) {
  fs.writeFileSync(path.join(processDir, 'config', 'zz-launch-test.yaml'), yaml.stringify(obj));
}

// Logs every command; runs git (and any setup) for real so worktrees actually land on disk, but
// intercepts the fixture's fake `windows.command` (`echo WINDOW <card>`) and hands back JSON
// instead of running it, since no real windowing tool exists in the test environment.
function launchStub(log) {
  return (cmd, opts) => {
    log.push(cmd);
    if (cmd.startsWith('echo WINDOW ')) {
      const card = cmd.slice('echo WINDOW '.length).trim();
      return JSON.stringify({ root_pane: { pane_id: `pane-${card}` }, tab: { tab_id: `tab-${card}` } });
    }
    return execFileSync('sh', ['-c', cmd], { encoding: 'utf8', cwd: opts && opts.cwd });
  };
}

test('launchWave: one worktree/run/window per card in the wave; a spike gets no worktree', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  const canon = tmpCanonical();
  writeConfigOverlay(p, {
    worktree: { canonical: canon, repo: 'greenhouse-app' },
    windows: { command: 'echo WINDOW {card}', open: 'echo OPEN {pane_id} {tab_id}' },
  });
  const log = [];
  const result = effort.launchWave(p, 'greenhouse', { dryRun: false, exec: launchStub(log) });

  assert.deepStrictEqual(result.launched.map((l) => l.card), ['TRK-10', 'TRK-12', 'TRK-13', 'TRK-14']);
  assert.deepStrictEqual(result.skipped, []);

  assert.ok(log.some((c) => /^git -C '.*' worktree add '.*TRK-10-rename-the-sampler\/greenhouse-app' -b 'feat\/TRK-10-rename-the-sampler' 'origin\/main'$/.test(c)),
    `expected a worktree-add command for TRK-10, got:\n${log.join('\n')}`);
  assert.ok(!log.some((c) => c.includes('worktree add') && c.includes('TRK-13')), 'spike TRK-13 must get no worktree command');

  for (const card of ['TRK-10', 'TRK-12', 'TRK-13', 'TRK-14']) {
    assert.ok(log.includes(`echo WINDOW ${card}`), `expected a windows.command for ${card}`);
    assert.ok(log.includes(`echo OPEN pane-${card} tab-${card}`), `expected windows.open with the parsed pane/tab id for ${card}`);
  }

  assert.equal(spine.readState(p, 'TRK-10').steps.scope.status, 'ready');
  assert.deepStrictEqual(spine.readInputs(p, 'TRK-10').touches, ['packages/sensors', 'packages/dashboard']);
  assert.deepStrictEqual(spine.readInputs(p, 'TRK-10').window, { tab_id: 'tab-TRK-10', pane_id: 'pane-TRK-10', label: 'TRK-10-RenameTheSampler' });

  const spikeInputs = spine.readInputs(p, 'TRK-13');
  assert.equal(spikeInputs.repo_dir, canon);
  assert.equal(spikeInputs.branch, undefined);
  assert.equal(spikeInputs.merge, 'auto');
});

test('launchWave: --dry-run writes nothing and never invokes exec', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  const canon = tmpCanonical();
  writeConfigOverlay(p, {
    worktree: { canonical: canon, repo: 'greenhouse-app' },
    windows: { command: 'echo WINDOW {card}', open: 'echo OPEN {pane_id} {tab_id}' },
  });
  const log = [];
  const result = effort.launchWave(p, 'greenhouse', { dryRun: true, exec: launchStub(log) });
  assert.deepStrictEqual(result.launched.map((l) => l.card), ['TRK-10', 'TRK-12', 'TRK-13', 'TRK-14']);
  assert.deepStrictEqual(log, []);
  assert.equal(spine.readState(p, 'TRK-10'), null);
  assert.equal(fs.existsSync(path.join(p, 'runs', 'TRK-10')), false);
});

test('launchWave: a worktree-add failure for one card is recorded in `skipped` and the wave continues', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  const canon = tmpCanonical();
  // No `origin/main` for this canonical clone once its remote is broken: worktree add fails.
  execFileSync('git', ['-C', canon, 'remote', 'remove', 'origin']);
  writeConfigOverlay(p, { worktree: { canonical: canon, repo: 'greenhouse-app' } });
  const log = [];
  const result = effort.launchWave(p, 'greenhouse', { dryRun: false, exec: launchStub(log) });
  assert.deepStrictEqual(result.launched.map((l) => l.card), ['TRK-13']);   // the spike needs no worktree, so it still launches
  const failedIds = result.skipped.map((s) => s.card);
  assert.ok(failedIds.includes('TRK-10'));
  assert.ok(failedIds.includes('TRK-12'));
  assert.ok(failedIds.includes('TRK-14'));
  for (const s of result.skipped) assert.ok(s.error && s.error.length > 0);
});

test('launchWave: --only restricts the launch to the named cards', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  const canon = tmpCanonical();
  writeConfigOverlay(p, { worktree: { canonical: canon, repo: 'greenhouse-app' } });
  const result = effort.launchWave(p, 'greenhouse', { dryRun: false, exec: launchStub([]), only: ['TRK-10'] });
  assert.deepStrictEqual(result.launched.map((l) => l.card), ['TRK-10']);
});

test('launchWave: a window-command failure is per-card, not fatal — the card still counts as launched and the wave continues', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  const canon = tmpCanonical();
  writeConfigOverlay(p, {
    worktree: { canonical: canon, repo: 'greenhouse-app' },
    windows: { command: 'echo WINDOW {card}', open: 'echo OPEN {pane_id} {tab_id}' },
  });
  const log = [];
  // Same stub as the other tests, except the window command for TRK-10 throws (a flaky window
  // tool) instead of returning JSON — TRK-10's worktree/run/inputs.yaml are already on disk by
  // the time this runs, and TRK-12 must still get its own worktree, run and window afterward.
  const flaky = (cmd, opts) => {
    log.push(cmd);
    if (cmd === 'echo WINDOW TRK-10') throw new Error('window tool is down');
    if (cmd.startsWith('echo WINDOW ')) {
      const card = cmd.slice('echo WINDOW '.length).trim();
      return JSON.stringify({ root_pane: { pane_id: `pane-${card}` }, tab: { tab_id: `tab-${card}` } });
    }
    return execFileSync('sh', ['-c', cmd], { encoding: 'utf8', cwd: opts && opts.cwd });
  };
  const result = effort.launchWave(p, 'greenhouse', { dryRun: false, exec: flaky, only: ['TRK-10', 'TRK-12'] });

  assert.deepStrictEqual(result.launched.map((l) => l.card), ['TRK-10', 'TRK-12']);
  assert.deepStrictEqual(result.skipped, []);

  const trk10 = result.launched.find((l) => l.card === 'TRK-10');
  assert.ok(trk10.run, 'TRK-10 must still have launched its run despite the window failure');
  assert.match(trk10.window.error, /window tool is down/);
  assert.ok(spine.readState(p, 'TRK-10'), 'TRK-10 run state must exist on disk');
  assert.ok(fs.existsSync(path.join(p, 'runs', 'TRK-10', 'inputs.yaml')));

  const trk12 = result.launched.find((l) => l.card === 'TRK-12');
  assert.equal(trk12.window.pane_id, 'pane-TRK-12');
  assert.ok(log.includes('echo OPEN pane-TRK-12 tab-TRK-12'), 'TRK-12 must still get its window opened');
  assert.ok(!log.includes('echo OPEN pane-TRK-10 tab-TRK-10'), 'TRK-10 must never reach windows.open after its command failed');
});

test('kebab: lowercases, hyphenates, and caps at three words', () => {
  assert.equal(effort.kebab('rename the sampler'), 'rename-the-sampler');
  assert.equal(effort.kebab('Rename TaxonomyHydrator to TaxonomyHydratorService'), 'rename-taxonomyhydrator-to');
  assert.equal(effort.kebab(''), '');
});

test('pascalSummary: PascalCases the first two-to-three words', () => {
  assert.equal(effort.pascalSummary('rename the sampler'), 'RenameTheSampler');
  assert.equal(effort.pascalSummary('test resolver'), 'TestResolver');
});

test('planWave: independent cards form the wave; ordered and overlapping ones are excluded with a reason', () => {
  const p = path.join(tmpProcess(), 'process');
  const plan = effort.planWave(p, 'greenhouse');
  assert.deepStrictEqual(plan.wave.map((c) => c.id), ['TRK-10', 'TRK-12', 'TRK-13', 'TRK-14']);
  const why = Object.fromEntries(plan.excluded.map((e) => [e.card, e.why]));
  assert.match(why['TRK-11'], /after TRK-10 \(not closed\)/);
  assert.match(why['TRK-11'], /packages\/dashboard/);       // also overlaps TRK-10's touches
  assert.match(why['TRK-15'], /EXT-1 is not a card of this effort/);
  assert.match(why['TRK-16'], /shared with TRK-12/);        // overlaps a card already placed in the wave
  // TRK-16 touches packages/resolvers, TRK-12 packages/resolvers/test: the path both cover is the
  // deeper one, so that is what the reason names — not TRK-16's own, wider path.
  assert.match(why['TRK-16'], /touches packages\/resolvers\/test — shared with TRK-12/);
});

test('planWave: a running card is excluded and reported in `running`; other cards overlapping it are excluded too; a closed card is excluded and no longer blocks its dependents or overlap checks', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  // TRK-10 is closed: it drops out of both the `after` check (TRK-11's dependency is satisfied)
  // and the touches-overlap check (its packages/dashboard no longer collides with TRK-11).
  spine.writeState(p, 'TRK-10', { run: 'TRK-10', status: 'closed', steps: {} });
  // TRK-12 is running (a launched, unfinished run): excluded as already running, listed in
  // `running`, and still counts toward overlap for any other card touching the same paths.
  spine.writeState(p, 'TRK-12', { run: 'TRK-12', steps: { scope: { status: 'in_progress' } } });
  const plan = effort.planWave(p, 'greenhouse');
  const why = Object.fromEntries(plan.excluded.map((e) => [e.card, e.why]));
  assert.match(why['TRK-10'], /already closed/);
  assert.match(why['TRK-12'], /already running/);
  assert.deepStrictEqual(plan.running, ['TRK-12']);
  assert.match(why['TRK-16'], /shared with TRK-12/);        // packages/resolvers overlaps TRK-12's packages/resolvers/test
  assert.deepStrictEqual(plan.wave.map((c) => c.id), ['TRK-11', 'TRK-13', 'TRK-14']);
});

test('normalizeCards: a bare id becomes a build-and-ship card with no touches', () => {
  const [c] = effort.normalizeCards(['TRK-14']);
  assert.deepStrictEqual(c, { id: 'TRK-14', cycle: 'build-and-ship', touches: [], after: [] });
});

test('prefix overlap is by path segment', () => {
  assert.equal(effort.touchesOverlap(['packages/taxonomy'], ['packages/taxonomy/src/x']), true);
  assert.equal(effort.touchesOverlap(['packages/tax'], ['packages/taxonomy']), false);
  assert.equal(effort.touchesOverlap([], ['anything']), false);
});

test('overlapCheck: two runs in one effort sharing a changed file block each other; disjoint runs pass', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  const repoA = tmpRepo(); const repoB = tmpRepo();          // independent repos: each diffs only against its own base
  writeFile(repoA, 'packages/sensors/a.ts', 'a'); gitAdd(repoA);
  writeFile(repoB, 'packages/sensors/a.ts', 'b'); gitAdd(repoB);
  spine.launchRun(p, { runId: 'TRK-10', cycle: 'build-and-ship', repoDir: repoA, owner: 'o', estimate: 1 });
  spine.launchRun(p, { runId: 'TRK-12', cycle: 'build-and-ship', repoDir: repoB, owner: 'o', estimate: 1 });
  writeInputs(p, 'TRK-10', { effort: 'greenhouse' }); writeInputs(p, 'TRK-12', { effort: 'greenhouse' });
  const r = effort.overlapCheck(p, 'TRK-10', { repoDir: repoA });
  assert.equal(r.ok, false);
  assert.deepStrictEqual(r.shared, [{ run: 'TRK-12', files: ['packages/sensors/a.ts'] }]);
  writeFile(repoB, 'packages/sensors/a.ts', null); writeFile(repoB, 'packages/resolvers/b.ts', 'b'); gitAdd(repoB);
  assert.equal(effort.overlapCheck(p, 'TRK-10', { repoDir: repoA }).ok, true);
});

test('gateCheck: a step with overlap: effort reports overlap and base-staleness as missing', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  const { origin, a, b } = tmpRepoPair();                    // shared origin: needed for the base-freshness half of this test
  writeFile(a, 'packages/sensors/a.ts', 'a'); gitAdd(a);
  writeFile(b, 'packages/sensors/a.ts', 'b'); gitAdd(b);
  spine.launchRun(p, { runId: 'TRK-10', cycle: 'build-and-ship', repoDir: a, owner: 'o', estimate: 1 });
  spine.launchRun(p, { runId: 'TRK-12', cycle: 'build-and-ship', repoDir: b, owner: 'o', estimate: 1 });
  writeInputs(p, 'TRK-10', { effort: 'greenhouse' }); writeInputs(p, 'TRK-12', { effort: 'greenhouse' });
  // Push a new commit to origin (from a third clone) so TRK-10's captured base falls behind —
  // then fetch it into `a` so the live `origin/main` ref there actually reflects that.
  const c = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-c-'));
  execFileSync('git', ['clone', '-q', origin, c]);
  execFileSync('git', ['-C', c, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', c, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(c, 'z.txt'), 'z\n');
  execFileSync('git', ['-C', c, 'add', 'z.txt']);
  execFileSync('git', ['-C', c, 'commit', '-qm', 'z']);
  execFileSync('git', ['-C', c, 'push', '-q', 'origin', 'main']);
  execFileSync('git', ['-C', a, 'fetch', '-q', 'origin']);
  const g = spine.gateCheck(p, 'TRK-10', 'open-pr', a);
  assert.ok(g.missing.some((m) => m.kind === 'overlap' && /TRK-12/.test(m.reason) && /a\.ts/.test(m.reason)));
  assert.ok(g.missing.some((m) => m.kind === 'base' && /rebase/.test(m.reason)));
  // (a) TRK-12 (repo b) never fetched: its local view of origin/main is still the commit its own
  // base_sha equals (trivially its own ancestor) — fresh, no `base` entry, at the same step kind.
  const gFresh = spine.gateCheck(p, 'TRK-12', 'open-pr', b);
  assert.ok(!gFresh.missing.some((m) => m.kind === 'base'));
  // (b) pre-pr never checks base freshness, even on the same stale repo that failed it at open-pr.
  const gPrePr = spine.gateCheck(p, 'TRK-10', 'pre-pr', a);
  assert.ok(!gPrePr.missing.some((m) => m.kind === 'base'));
});

test('gateCheck: base freshness is ancestry, not equality — a branch with its own commit past an unmoved origin/main is still fresh', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  const { a } = tmpRepoPair();
  // Commit locally without pushing: `a` is one commit ahead of origin/main, which hasn't moved.
  fs.writeFileSync(path.join(a, 'local.txt'), 'x\n');
  execFileSync('git', ['-C', a, 'add', 'local.txt']);
  execFileSync('git', ['-C', a, 'commit', '-qm', 'local change']);
  // Then stage one more change so the launch pin is a TREE pin: base_sha = that new local commit,
  // which the old equality test (base_sha === origin/main) would call stale forever. Ancestry
  // correctly calls it fresh, because origin/main is still reachable from that commit.
  fs.writeFileSync(path.join(a, 'staged.txt'), 'y\n');
  execFileSync('git', ['-C', a, 'add', 'staged.txt']);
  spine.launchRun(p, { runId: 'TRK-20', cycle: 'build-and-ship', repoDir: a, owner: 'o', estimate: 1 });
  writeInputs(p, 'TRK-20', { effort: 'greenhouse' });
  const g = spine.gateCheck(p, 'TRK-20', 'open-pr', a);
  assert.ok(!g.missing.some((m) => m.kind === 'base'));
});

function gitCommitAll(repoDir, msg) {
  execFileSync('git', ['-C', repoDir, 'add', '-A']);
  execFileSync('git', ['-C', repoDir, 'commit', '-qm', msg]);
}

test('overlapCheck: a file both runs COMMITTED on their branches is shared — the diff base is the branch base, not the launch pin', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  const { a, b } = tmpRepoPair();
  // Both runs commit a change to the same file; nothing is left staged in B. A additionally
  // stages one unrelated file so its launch pin is a TREE pin whose base_sha is A's own HEAD —
  // a diff from that pin sees only the staged file and misses the committed one.
  writeFile(a, 'packages/sensors/a.ts', 'a'); gitCommitAll(a, 'a: sensors');
  writeFile(b, 'packages/sensors/a.ts', 'b'); gitCommitAll(b, 'b: sensors');
  writeFile(a, 'packages/dashboard/unrelated.ts', 'u'); gitAdd(a);
  spine.launchRun(p, { runId: 'TRK-10', cycle: 'build-and-ship', repoDir: a, owner: 'o', estimate: 1 });
  spine.launchRun(p, { runId: 'TRK-12', cycle: 'build-and-ship', repoDir: b, owner: 'o', estimate: 1 });
  assert.equal(spine.readState(p, 'TRK-10').pin.kind, 'tree');
  assert.equal(spine.readState(p, 'TRK-12').pin.kind, 'sha');
  writeInputs(p, 'TRK-10', { effort: 'greenhouse' }); writeInputs(p, 'TRK-12', { effort: 'greenhouse' });
  const r = effort.overlapCheck(p, 'TRK-10', { repoDir: a });
  assert.equal(r.ok, false);
  assert.deepStrictEqual(r.shared, [{ run: 'TRK-12', files: ['packages/sensors/a.ts'] }]);
  // Symmetric: seen from B (a clean sha pin), A's committed change is visible too.
  const rb = effort.overlapCheck(p, 'TRK-12', { repoDir: b });
  assert.deepStrictEqual(rb.shared, [{ run: 'TRK-10', files: ['packages/sensors/a.ts'] }]);
});

test('branchBase: merge-base with origin/main when it resolves; the launch pin sha without a remote; HEAD without a pin', () => {
  const { a } = tmpRepoPair();
  const seed = execFileSync('git', ['-C', a, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFile(a, 'local.txt', 'x'); gitCommitAll(a, 'local');
  const head = execFileSync('git', ['-C', a, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(effort.branchBase(a, { kind: 'sha', value: head }), seed);
  const solo = tmpRepo();
  const soloHead = execFileSync('git', ['-C', solo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(effort.branchBase(solo, { kind: 'tree', value: 't', base_sha: 'deadbeef' }), 'deadbeef');
  assert.equal(effort.branchBase(solo, { kind: 'sha', value: 'cafef00d' }), 'cafef00d');
  assert.equal(effort.branchBase(solo, null), soloHead);
});

test('normalizeCards: a card id that is not a safe identifier is refused before it can reach a shell', () => {
  assert.throws(() => effort.normalizeCards(['TRK 99']), /effort card id "TRK 99" is not a safe identifier/);
  assert.throws(() => effort.normalizeCards([{ id: 'TRK-99; rm -rf x' }]), /not a safe identifier/);
  assert.doesNotThrow(() => effort.normalizeCards(['TRK-99', 'trk.99_a']));
});

function captureStdout(fn) {
  const lines = []; const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.log = orig; }
  return lines;
}

test('launchWave: every path and ref interpolated into the git command is single-quoted (a worktree root with a space survives)', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  const canon = tmpCanonical();
  writeConfigOverlay(p, { worktree: { canonical: canon, repo: 'greenhouse-app', root: 'code/my branches' } });
  const lines = captureStdout(() => effort.launchWave(p, 'greenhouse', { dryRun: true, exec: launchStub([]), only: ['TRK-10'] }));
  const add = lines.find((l) => l.includes('worktree add'));
  assert.ok(add, `expected a worktree-add line, got:\n${lines.join('\n')}`);
  assert.ok(add.includes(`'${path.join(root, 'code/my branches', 'TRK-10-rename-the-sampler', 'greenhouse-app')}'`), add);
  assert.ok(add.endsWith(`-b 'feat/TRK-10-rename-the-sampler' 'origin/main'`), add);
  assert.ok(add.startsWith(`git -C '${canon}' worktree add`), add);
});

test('launchWave: a card with an unknown cycle is skipped BEFORE its worktree is added — no orphan on disk', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  const canon = tmpCanonical();
  writeConfigOverlay(p, { worktree: { canonical: canon, repo: 'greenhouse-app' } });
  fs.writeFileSync(path.join(p, 'efforts', 'badcycle.yaml'), yaml.stringify({ slug: 'badcycle', cards: [
    { id: 'TRK-30', title: 'no such cycle', cycle: 'nope', touches: [] },
  ] }));
  const log = [];
  const result = effort.launchWave(p, 'badcycle', { dryRun: false, exec: launchStub(log) });
  assert.deepStrictEqual(result.launched, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].card, 'TRK-30');
  assert.match(result.skipped[0].error, /nope/);
  assert.ok(!log.some((c) => c.includes('worktree add')), `no worktree command expected, got:\n${log.join('\n')}`);
  assert.equal(fs.existsSync(path.join(root, 'code', 'branches', 'TRK-30-no-such-cycle')), false);
  assert.equal(spine.readState(p, 'TRK-30'), null);
});

test('overlapCheck: with no live pin passed it pins the tree itself, so a rebased branch reads fresh (not "base stale" from the launch pin forever)', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  const { origin, a } = tmpRepoPair();
  writeFile(a, 'packages/sensors/a.ts', 'a'); gitAdd(a);
  spine.launchRun(p, { runId: 'TRK-10', cycle: 'build-and-ship', repoDir: a, owner: 'o', estimate: 1 });   // tree pin, base_sha = seed
  writeInputs(p, 'TRK-10', { effort: 'greenhouse' });
  // origin/main moves on (pushed from a third clone), `a` fetches it, commits its work and rebases.
  const c = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-c-'));
  execFileSync('git', ['clone', '-q', origin, c]);
  execFileSync('git', ['-C', c, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', c, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(c, 'z.txt'), 'z\n');
  execFileSync('git', ['-C', c, 'add', 'z.txt']);
  execFileSync('git', ['-C', c, 'commit', '-qm', 'z']);
  execFileSync('git', ['-C', c, 'push', '-q', 'origin', 'main']);
  execFileSync('git', ['-C', a, 'fetch', '-q', 'origin']);
  execFileSync('git', ['-C', a, 'commit', '-qm', 'sensors']);
  execFileSync('git', ['-C', a, 'rebase', '-q', 'origin/main']);
  const r = effort.overlapCheck(p, 'TRK-10', { repoDir: a });
  assert.equal(r.baseFresh, true, 'a rebased, clean branch is fresh — judged from the live tree, not the recorded launch pin');
  // The recorded launch pin, judged on its own, IS stale — proving the live pin is what was used.
  assert.equal(effort.overlapCheck(p, 'TRK-10', { repoDir: a, pin: spine.readState(p, 'TRK-10').pin }).baseFresh, false);
});

test('launchWave: a window command whose JSON wraps the ids under `result` is read too', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  const canon = tmpCanonical();
  writeConfigOverlay(p, {
    worktree: { canonical: canon, repo: 'greenhouse-app' },
    windows: { command: 'echo WINDOW {card}', open: 'echo OPEN {pane_id} {tab_id}' },
  });
  const log = [];
  const wrapped = (cmd, opts) => {
    log.push(cmd);
    if (cmd.startsWith('echo WINDOW ')) {
      const card = cmd.slice('echo WINDOW '.length).trim();
      return JSON.stringify({ result: { root_pane: { pane_id: `pane-${card}` }, tab: { tab_id: `tab-${card}` } } });
    }
    return execFileSync('sh', ['-c', cmd], { encoding: 'utf8', cwd: opts && opts.cwd });
  };
  const result = effort.launchWave(p, 'greenhouse', { dryRun: false, exec: wrapped, only: ['TRK-10'] });
  assert.equal(result.launched[0].window.pane_id, 'pane-TRK-10');
  assert.ok(log.includes('echo OPEN pane-TRK-10 tab-TRK-10'));
});

test('launchWave: owner is --owner, else the first configured human, else null', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  const canon = tmpCanonical();
  writeConfigOverlay(p, { worktree: { canonical: canon, repo: 'greenhouse-app' }, actors: { humans: ['lead', 'other'] } });
  effort.launchWave(p, 'greenhouse', { dryRun: false, exec: launchStub([]), only: ['TRK-10'] });
  assert.equal(spine.readState(p, 'TRK-10').owner, 'lead');
  effort.launchWave(p, 'greenhouse', { dryRun: false, exec: launchStub([]), only: ['TRK-12'], owner: 'me' });
  assert.equal(spine.readState(p, 'TRK-12').owner, 'me');
});

test('launchWave: --dry-run prints the windows.open line as well, with {pane_id} left as-is', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  const canon = tmpCanonical();
  writeConfigOverlay(p, {
    worktree: { canonical: canon, repo: 'greenhouse-app' },
    windows: { command: 'echo WINDOW {card}', open: 'echo OPEN {pane_id} {tab_id}' },
  });
  const lines = captureStdout(() => effort.launchWave(p, 'greenhouse', { dryRun: true, exec: launchStub([]), only: ['TRK-10'] }));
  assert.ok(lines.includes('echo WINDOW TRK-10'), lines.join('\n'));
  assert.ok(lines.includes('echo OPEN {pane_id} {tab_id}'), lines.join('\n'));
});

test('launchWave: --only naming a card outside the wave is reported in `skipped`, not silently dropped', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  const canon = tmpCanonical();
  writeConfigOverlay(p, { worktree: { canonical: canon, repo: 'greenhouse-app' } });
  const result = effort.launchWave(p, 'greenhouse', { dryRun: true, exec: launchStub([]), only: ['TRK-11', 'TRK-99', 'TRK-10'] });
  assert.deepStrictEqual(result.launched.map((l) => l.card), ['TRK-10']);
  assert.deepStrictEqual(result.skipped, [
    { card: 'TRK-11', error: 'not in the wave' },
    { card: 'TRK-99', error: 'not in the wave' },
  ]);
});

test('launchWave: a bare-id card gets branch feat/{card} and a {card}-only worktree dir — no slug made from its own id', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  const canon = tmpCanonical();
  writeConfigOverlay(p, { worktree: { canonical: canon, repo: 'greenhouse-app' } });
  const result = effort.launchWave(p, 'greenhouse', { dryRun: true, exec: launchStub([]), only: ['TRK-14'] });
  assert.equal(result.launched[0].branch, 'feat/TRK-14');
  assert.equal(result.launched[0].path, path.join(root, 'code', 'branches', 'TRK-14', 'greenhouse-app'));
});

test('plt effort plan|launch without a slug prints usage and exits 2', () => {
  const root = tmpProcess();
  const p = path.join(root, 'process');
  const plt = path.join(__dirname, '..', 'bin', 'plt');
  for (const sub of ['plan', 'launch']) {
    const r = require('child_process').spawnSync(process.execPath, [plt, 'effort', sub], { encoding: 'utf8', env: { ...process.env, PLT_PROCESS_DIR: p } });
    assert.equal(r.status, 2, `${sub}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: plt effort/);
    assert.ok(!/at .*\.js:\d+/.test(r.stderr), 'no stack trace');
  }
});

test('overlapCheck: a squash-merged run has no live changes, and a child stacked on it stops inheriting them once main carries them', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  const { a, b } = tmpRepoPair();
  // A (the parent run) changes two files on its branch; B (the child) is stacked on A: same two
  // files plus one of its own.
  writeFile(a, 'packages/x/one.ts', 'one'); writeFile(a, 'packages/x/two.ts', 'two'); gitCommitAll(a, 'a: one+two');
  writeFile(b, 'packages/x/one.ts', 'one'); writeFile(b, 'packages/x/two.ts', 'two'); writeFile(b, 'packages/y/own.ts', 'own'); gitCommitAll(b, 'b: stacked + own');
  spine.launchRun(p, { runId: 'TRK-20', cycle: 'build-and-ship', repoDir: a, owner: 'o', estimate: 1 });
  spine.launchRun(p, { runId: 'TRK-21', cycle: 'build-and-ship', repoDir: b, owner: 'o', estimate: 1 });
  writeInputs(p, 'TRK-20', { effort: 'greenhouse' }); writeInputs(p, 'TRK-21', { effort: 'greenhouse' });
  assert.deepStrictEqual(effort.overlapCheck(p, 'TRK-20', { repoDir: a }).shared, [{ run: 'TRK-21', files: ['packages/x/one.ts', 'packages/x/two.ts'] }]);
  // A's work lands on main as a SQUASH (a fresh commit with the same content) and both clones fetch.
  const c = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-c-'));
  execFileSync('git', ['clone', '-q', execFileSync('git', ['-C', a, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim(), c]);
  execFileSync('git', ['-C', c, 'config', 'user.email', 't@example.com']); execFileSync('git', ['-C', c, 'config', 'user.name', 't']);
  writeFile(c, 'packages/x/one.ts', 'one'); writeFile(c, 'packages/x/two.ts', 'two'); gitCommitAll(c, 'squash of a');
  execFileSync('git', ['-C', c, 'push', '-q', 'origin', 'main']);
  execFileSync('git', ['-C', a, 'fetch', '-q', 'origin']); execFileSync('git', ['-C', b, 'fetch', '-q', 'origin']);
  // The merged parent collides with nobody; the child's live changes are only its own file.
  assert.equal(effort.overlapCheck(p, 'TRK-20', { repoDir: a }).ok, true);
  assert.equal(effort.overlapCheck(p, 'TRK-21', { repoDir: b }).ok, true);
});

test('overlapCheck: a run with a passing `gh merged` receipt is never "behind origin/main"', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  const { a, b } = tmpRepoPair();
  writeFile(a, 'packages/x/one.ts', 'one'); gitCommitAll(a, 'a: one');
  spine.launchRun(p, { runId: 'TRK-22', cycle: 'build-and-ship', repoDir: a, owner: 'o', estimate: 1 });
  writeInputs(p, 'TRK-22', { effort: 'greenhouse' });
  // main moves past the branch base (pushed from b) and a fetches it: the branch is now behind.
  writeFile(b, 'other.txt', 'x'); gitCommitAll(b, 'b: other'); execFileSync('git', ['-C', b, 'push', '-q', 'origin', 'main']);
  execFileSync('git', ['-C', a, 'fetch', '-q', 'origin']);
  assert.equal(effort.overlapCheck(p, 'TRK-22', { repoDir: a }).baseFresh, false);
  spine.recordReceipt(p, 'TRK-22', { step: 'merge', kind: 'gh', name: 'merged', result: 'pass', pin: spine.computePin(a), actor: 'agent' });
  assert.equal(effort.overlapCheck(p, 'TRK-22', { repoDir: a }).baseFresh, true);
});
