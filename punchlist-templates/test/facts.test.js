'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const spine = require('../lib/spine');
const yaml = require('../lib/yaml');
const facts = require('../lib/facts');
const FIX = path.join(__dirname, 'fixtures', 'spine');
const GH_FIX = path.join(FIX, 'gh');

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

// Layered on top of the fixture's defaults/sprout org files, never replacing them: `actors.humans`
// (the review-posted check reads its first entry) and `review.arch_agents` (the review-pr cycle's
// `gist` step needs it — neither defaults.yaml nor sprout.yaml declares it, since no other test
// launches that cycle yet).
function writeConfigOverlay(processDir, obj) {
  fs.writeFileSync(path.join(processDir, 'config', 'zz-facts-test.yaml'), yaml.stringify(obj));
}

function loadFixture(name) { return JSON.parse(fs.readFileSync(path.join(GH_FIX, `${name}.json`), 'utf8')); }

// gh injected as a plain function reading one fixture's {view, threads} shape — ignores which PR
// number/repo was asked for, since a single-fixture test only ever means one PR.
function ghOne(name) {
  const fixture = loadFixture(name);
  return (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(fixture.view);
    if (args[0] === 'api' && args.includes('graphql')) return JSON.stringify(fixture.threads);
    throw new Error('unexpected gh call: ' + args.join(' '));
  };
}

// gh injected across several PRs at once (for collect()) — keyed by PR number, dispatching on the
// number gh was actually asked about (view's positional arg, graphql's `number=` -F value).
function ghMulti(byNumber) {
  return (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(byNumber[args[2]].view);
    const numArg = args.find((a) => /^number=\d+$/.test(a));
    const num = numArg ? numArg.split('=')[1] : null;
    return JSON.stringify(byNumber[num].threads);
  };
}

test('prFacts parses open-green-approved.json into the documented shape', () => {
  const f = facts.prFacts(ghOne('open-green-approved'), 'example-org/greenhouse', 42);
  assert.strictEqual(f.number, 42);
  assert.strictEqual(f.url, 'https://github.com/example-org/greenhouse/pull/42');
  assert.strictEqual(f.state, 'OPEN');
  assert.strictEqual(f.isDraft, false);
  assert.strictEqual(f.headSha, 'aaaa1111');
  assert.strictEqual(f.reviewDecision, 'APPROVED');
  assert.strictEqual(f.mergeStateStatus, 'CLEAN');
  assert.deepStrictEqual(f.checks, { total: 2, pass: 2, fail: 0, pending: 0 });
  assert.strictEqual(f.threadsUnresolved, 0);
  assert.deepStrictEqual(f.reviews, [{ id: 'REV_1', author: 'lead', state: 'APPROVED', submittedAt: '2026-09-15T10:00:00Z', commitOid: 'aaaa1111' }]);
  assert.deepStrictEqual(f.comments, [{ id: 'IC_1', author: 'lead', createdAt: '2026-09-15T10:05:00Z' }]);
});

test('prFacts: open-red.json has a failing/pending check and an unresolved thread', () => {
  const f = facts.prFacts(ghOne('open-red'), 'example-org/greenhouse', 43);
  assert.deepStrictEqual(f.checks, { total: 2, pass: 0, fail: 1, pending: 1 });
  assert.strictEqual(f.threadsUnresolved, 1);
  assert.strictEqual(f.reviewDecision, 'REVIEW_REQUIRED');
});

// The shipped `build-and-ship` cycle's spelling was unified on the hyphen (`checks-green`) in both
// `open-pr`'s `verify.gh` and `merge`'s `gate.checks`. One green-checks fact still records once
// per REQUIRING STEP — never the fact's canonical spelling collapsed across steps — so open-pr and
// merge each get their own `checks-green` receipt, plus merge's other checks.
test('recordFacts on the shipped build-and-ship cycle: one checks-green fact records once on open-pr and once on merge, plus merge\'s other checks', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-1', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  const f = facts.prFacts(ghOne('open-green-approved'), 'example-org/greenhouse', 42);

  const first = facts.recordFacts(p, 'TRK-1', f);
  assert.deepStrictEqual(first.recorded.sort(), ['approved_on_head', 'checks-green', 'checks-green', 'threads_resolved']);
  assert.deepStrictEqual(first.skipped, []);

  const gh = spine.readEvents(p, 'TRK-1').filter((e) => e.kind === 'gh');
  assert.strictEqual(gh.length, 4);
  const byStep = {};
  for (const e of gh) (byStep[e.step] = byStep[e.step] || []).push(e.name);
  assert.deepStrictEqual(byStep['open-pr'], ['checks-green']);
  assert.deepStrictEqual(byStep['merge'].sort(), ['approved_on_head', 'checks-green', 'threads_resolved']);
  for (const e of gh) { assert.strictEqual(e.result, 'pass'); assert.strictEqual(e.ref, 'aaaa1111'); }

  const second = facts.recordFacts(p, 'TRK-1', f);
  assert.deepStrictEqual(second.recorded, []);
  assert.deepStrictEqual(second.skipped.sort(), ['approved_on_head', 'checks-green', 'checks-green', 'threads_resolved']);
  assert.strictEqual(spine.readEvents(p, 'TRK-1').filter((e) => e.kind === 'gh').length, 4);   // no duplicates
});

// gateCheck (the reader half, in lib/spine.js) must still accept the cross-spelling for backward
// compatibility — an OLD receipt (or a private overlay cycle) spelled with the underscore still
// satisfies today's hyphen-spelled `checks-green` requirement (D-020's normalisation stays live
// even after the shipped formulas standardise on one spelling).
test('gateCheck on merge: an old receipt spelled `checks_green` still satisfies today\'s `checks-green` requirement (gh names normalise `-`/`_`)', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-31', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  const pin = spine.computePin(repo);
  spine.recordReceipt(p, 'TRK-31', { step: 'merge', kind: 'gh', name: 'checks_green', result: 'pass', pin, actor: 'agent' });
  spine.recordReceipt(p, 'TRK-31', { step: 'merge', kind: 'gh', name: 'approved_on_head', result: 'pass', pin, actor: 'agent' });
  spine.recordReceipt(p, 'TRK-31', { step: 'merge', kind: 'gh', name: 'threads_resolved', result: 'pass', pin, actor: 'agent' });
  spine.recordReceipt(p, 'TRK-31', { step: 'merge', kind: 'gh', name: 'merged', result: 'pass', pin, actor: 'agent' });
  const g = spine.gateCheck(p, 'TRK-31', 'merge', repo);
  assert.deepStrictEqual(g.missing.filter((m) => m.kind === 'gh'), []);
});

test('recordFacts: nothing satisfied (open-red) records and skips nothing, but still snapshots state.facts', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-2', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  const f = facts.prFacts(ghOne('open-red'), 'example-org/greenhouse', 43);
  const r = facts.recordFacts(p, 'TRK-2', f);
  assert.deepStrictEqual(r.recorded, []);
  assert.deepStrictEqual(r.skipped, []);
  const st = spine.readState(p, 'TRK-2');
  assert.strictEqual(st.facts.headSha, 'bbbb2222');
  assert.strictEqual(st.facts.state, 'OPEN');
  assert.strictEqual(st.facts.threadsUnresolved, 1);
  assert.deepStrictEqual(st.facts.checks, { total: 2, pass: 0, fail: 1, pending: 1 });
});

test('recordFacts: merged.json additionally records `merged` on the merge step (build-and-ship), never `pr_closed` (that cycle never declares it)', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-3', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  const f = facts.prFacts(ghOne('merged'), 'example-org/greenhouse', 44);
  const r = facts.recordFacts(p, 'TRK-3', f);
  assert.ok(r.recorded.includes('merged'), 'expected `merged` recorded on the merge step');
  const ev = spine.readEvents(p, 'TRK-3').find((e) => e.kind === 'gh' && e.name === 'merged');
  assert.strictEqual(ev.step, 'merge');
  assert.strictEqual(ev.ref, 'cccc3333');
  assert.ok(!spine.readEvents(p, 'TRK-3').some((e) => e.name === 'pr_closed'));
});

test('recordFacts on the shipped review-pr cycle: merged.json records `pr_closed` on close-out and `review-posted` on post', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  writeConfigOverlay(p, { actors: { humans: ['lead'] }, review: { arch_agents: ['fixture-arch-reviewer'] } });
  spine.launchRun(p, { runId: 'PR-44', cycle: 'review-pr', repoDir: repo, owner: 'agent' });

  const merged = facts.prFacts(ghOne('merged'), 'example-org/greenhouse', 44);   // merged.json's one review is by "lead"
  const r = facts.recordFacts(p, 'PR-44', merged);
  assert.deepStrictEqual(r.recorded.sort(), ['pr-facts', 'pr_closed', 'review-posted']);
  assert.ok(!r.recorded.includes('merged'), 'a review-pr run never declares a `merged` requirement');

  const events = spine.readEvents(p, 'PR-44');
  assert.strictEqual(events.find((e) => e.kind === 'gh' && e.name === 'pr_closed').step, 'close-out');
  assert.strictEqual(events.find((e) => e.kind === 'gh' && e.name === 'review-posted').step, 'post');
  assert.strictEqual(events.find((e) => e.kind === 'gh' && e.name === 'pr-facts').step, 'intake');
});

test('recordFacts: review-activity is quiet on the first collect ever, fires only for what is genuinely new after that, and a same-second item is tracked by id (not dropped by a strict >)', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-4', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  const f = facts.prFacts(ghOne('review-activity'), 'example-org/greenhouse', 46);

  // First collect ever (state.facts absent): seeds the cursor at the newest item quietly — nothing
  // existing is "new activity" to a run that just started watching.
  const first = facts.recordFacts(p, 'TRK-4', f);
  assert.strictEqual(first.activity, 0);
  assert.strictEqual(spine.readEvents(p, 'TRK-4').filter((e) => e.kind === 'review-activity').length, 0);
  assert.strictEqual(spine.readState(p, 'TRK-4').facts.cursor, '2026-09-17T08:05:00Z');
  assert.deepStrictEqual(spine.readState(p, 'TRK-4').facts.cursor_ids, ['IC_10']);

  // Nothing changed: still quiet.
  const second = facts.recordFacts(p, 'TRK-4', f);
  assert.strictEqual(second.activity, 0);
  assert.strictEqual(spine.readEvents(p, 'TRK-4').filter((e) => e.kind === 'review-activity').length, 0);

  // A new review lands the EXACT same second as the cursor. A strict `>` would drop it forever
  // (never > the cursor, never seen before); the id-set exclusion must still count it as new.
  const withTie = { ...f, reviews: [...f.reviews, { id: 'REV_11', author: 'reviewer2', state: 'COMMENTED', submittedAt: '2026-09-17T08:05:00Z' }] };
  const third = facts.recordFacts(p, 'TRK-4', withTie);
  assert.strictEqual(third.activity, 1);
  const tieEvents = spine.readEvents(p, 'TRK-4').filter((e) => e.kind === 'review-activity');
  assert.strictEqual(tieEvents.length, 1);
  assert.deepStrictEqual(tieEvents[0].ids, ['REV_11']);
  assert.strictEqual(tieEvents[0].actor, 'facts');
  assert.deepStrictEqual(spine.readState(p, 'TRK-4').facts.cursor_ids.sort(), ['IC_10', 'REV_11']);

  // A genuinely later item advances the cursor and fires exactly once more.
  const withLater = { ...withTie, comments: [...withTie.comments, { id: 'IC_11', author: 'author1', createdAt: '2026-09-17T08:10:00Z' }] };
  const fourth = facts.recordFacts(p, 'TRK-4', withLater);
  assert.strictEqual(fourth.activity, 1);
  const laterEvents = spine.readEvents(p, 'TRK-4').filter((e) => e.kind === 'review-activity');
  assert.strictEqual(laterEvents.length, 2);
  assert.deepStrictEqual(laterEvents[1].ids, ['IC_11']);
  assert.strictEqual(spine.readState(p, 'TRK-4').facts.cursor, '2026-09-17T08:10:00Z');
});

test('recordFacts: an APPROVED review on a stale commit does not satisfy approved_on_head', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-7', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  const f = facts.prFacts(ghOne('stale-approval'), 'example-org/greenhouse', 47);
  assert.strictEqual(f.reviewDecision, 'APPROVED');   // GitHub's decision is APPROVED...
  const r = facts.recordFacts(p, 'TRK-7', f);
  assert.ok(!r.recorded.includes('approved_on_head'), '...but the approving review is for an older commit, not the current head');
  assert.ok(!spine.readEvents(p, 'TRK-7').some((e) => e.name === 'approved_on_head'));
  // Everything else about this PR is still fine — only the head-scoped approval check is withheld.
  assert.ok(r.recorded.includes('checks-green'));
  assert.ok(r.recorded.includes('threads_resolved'));
});

test('candidateNames: review-posted matches config.actors.github_logins, which may differ from humans[0] (a display name, not a GitHub login)', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  writeConfigOverlay(p, { actors: { humans: ['lead'], github_logins: ['lead-gh'] }, review: { arch_agents: ['fixture-arch-reviewer'] } });
  spine.launchRun(p, { runId: 'PR-51', cycle: 'review-pr', repoDir: repo, owner: 'agent' });
  const f = { number: 51, url: 'https://github.com/example-org/greenhouse/pull/51', state: 'OPEN', isDraft: false,
    headSha: 'gggg7777', reviewDecision: null, mergeStateStatus: 'CLEAN', threadsUnresolved: 1,
    checks: { total: 0, pass: 0, fail: 0, pending: 0 },
    reviews: [{ id: 'REV_30', author: 'lead-gh', state: 'COMMENTED', submittedAt: '2026-09-18T00:00:00Z', commitOid: 'gggg7777' }], comments: [] };
  const r = facts.recordFacts(p, 'PR-51', f);
  assert.ok(r.recorded.includes('review-posted'), 'expected review-posted from github_logins, even though it differs from humans[0]');
});

test('candidateNames: without github_logins, review-posted falls back to humans[0] literally (which may just not match a real login)', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  writeConfigOverlay(p, { actors: { humans: ['lead'] }, review: { arch_agents: ['fixture-arch-reviewer'] } });
  spine.launchRun(p, { runId: 'PR-52', cycle: 'review-pr', repoDir: repo, owner: 'agent' });
  const f = { number: 52, url: 'https://github.com/example-org/greenhouse/pull/52', state: 'OPEN', isDraft: false,
    headSha: 'hhhh8888', reviewDecision: null, mergeStateStatus: 'CLEAN', threadsUnresolved: 1,
    checks: { total: 0, pass: 0, fail: 0, pending: 0 },
    reviews: [{ id: 'REV_31', author: 'lead-gh', state: 'COMMENTED', submittedAt: '2026-09-18T00:00:00Z', commitOid: 'hhhh8888' }], comments: [] };
  const r = facts.recordFacts(p, 'PR-52', f);
  assert.ok(!r.recorded.includes('review-posted'), 'humans[0] "lead" is a display name, not the login "lead-gh" — must not match');
});

test('recordFacts: a poll-landed receipt (ref: <PR url>, not a head sha) counts as already recorded — no duplicate `merged`', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-6', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  const pin = spine.computePin(repo);
  // Simulates `plt run poll`'s landing sequence (lib/spine.js#landRun), which records gh receipts
  // with `ref: <PR url>` rather than a head sha.
  spine.recordReceipt(p, 'TRK-6', { step: 'merge', kind: 'gh', name: 'merged', result: 'pass',
    ref: 'https://github.com/example-org/greenhouse/pull/44', pin, actor: 'agent' });
  const f = facts.prFacts(ghOne('merged'), 'example-org/greenhouse', 44);   // same PR (44); a fresh headSha-based ref
  const r = facts.recordFacts(p, 'TRK-6', f);
  assert.ok(!r.recorded.includes('merged'), 'landRun already recorded `merged` for this PR — facts must not duplicate it');
  assert.ok(r.skipped.includes('merged'));
  assert.strictEqual(spine.readEvents(p, 'TRK-6').filter((e) => e.kind === 'gh' && e.name === 'merged').length, 1);
});

test('recordFacts: pr-facts is recorded once on review-pr\'s intake step, never head-scoped, never duplicated', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  writeConfigOverlay(p, { review: { arch_agents: ['fixture-arch-reviewer'] } });
  spine.launchRun(p, { runId: 'PR-53', cycle: 'review-pr', repoDir: repo, owner: 'agent' });

  const f1 = facts.prFacts(ghOne('open-red'), 'example-org/greenhouse', 43);
  const r1 = facts.recordFacts(p, 'PR-53', f1);
  assert.ok(r1.recorded.includes('pr-facts'));
  const ev = spine.readEvents(p, 'PR-53').find((e) => e.kind === 'gh' && e.name === 'pr-facts');
  assert.strictEqual(ev.step, 'intake');
  assert.strictEqual(ev.ref, 'https://github.com/example-org/greenhouse/pull/43');

  // A later collect, even against a different PR fetch — pr-facts is "we looked this PR up at all",
  // never re-verified per head, so it must never fire twice on the same step.
  const f2 = facts.prFacts(ghOne('open-green-approved'), 'example-org/greenhouse', 42);
  const r2 = facts.recordFacts(p, 'PR-53', f2);
  assert.ok(!r2.recorded.includes('pr-facts'));
  assert.ok(r2.skipped.includes('pr-facts'));
  assert.strictEqual(spine.readEvents(p, 'PR-53').filter((e) => e.kind === 'gh' && e.name === 'pr-facts').length, 1);
});

test('recordFacts: a refused pin (unstaged worktree change) skips gh receipts but still advances the review-activity cursor', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-5', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'x\n');   // refuses the pin
  const f = facts.prFacts(ghOne('open-green-approved'), 'example-org/greenhouse', 42);
  const r = facts.recordFacts(p, 'TRK-5', f);
  assert.deepStrictEqual(r.recorded, []);
  assert.deepStrictEqual(r.skipped, []);
  assert.strictEqual(spine.readState(p, 'TRK-5').facts.headSha, 'aaaa1111');
});

test('collect: every in-flight run naming a PR (inputs.pr_number), skipping closed runs and runs with no PR', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  const repoA = tmpRepo(); const repoB = tmpRepo(); const repoC = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-10', cycle: 'build-and-ship', repoDir: repoA, owner: 'agent' });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-10', 'inputs.yaml'), yaml.stringify({ card: 'TRK-10', pr_number: 42 }));
  spine.launchRun(p, { runId: 'TRK-11', cycle: 'build-and-ship', repoDir: repoB, owner: 'agent' });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-11', 'inputs.yaml'), yaml.stringify({ card: 'TRK-11', pr_number: 43 }));
  spine.launchRun(p, { runId: 'TRK-12', cycle: 'build-and-ship', repoDir: repoC, owner: 'agent' });   // no PR at all — skipped

  const byNumber = { 42: loadFixture('open-green-approved'), 43: loadFixture('open-red') };
  const results = facts.collect(p, { gh: ghMulti(byNumber) });
  assert.strictEqual(results.length, 2);
  const byRun = Object.fromEntries(results.map((r) => [r.run, r]));
  assert.strictEqual(byRun['TRK-10'].pr, 42);
  assert.deepStrictEqual(byRun['TRK-10'].recorded.sort(), ['approved_on_head', 'checks-green', 'checks-green', 'threads_resolved']);
  assert.strictEqual(byRun['TRK-11'].pr, 43);
  assert.deepStrictEqual(byRun['TRK-11'].recorded, []);
  assert.ok(!('TRK-12' in byRun));
});

test('collect: one unreachable PR cannot abort the pass — the other runs still collect and the failure is named in the result', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  const repoA = tmpRepo(); const repoB = tmpRepo(); const repoC = tmpRepo();
  for (const [id, repo, pr] of [['TRK-14', repoA, 42], ['TRK-15', repoB, 43], ['TRK-16', repoC, 44]]) {
    spine.launchRun(p, { runId: id, cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
    fs.writeFileSync(path.join(p, 'runs', id, 'inputs.yaml'), yaml.stringify({ card: id, pr_number: pr }));
  }
  const byNumber = { 42: loadFixture('open-green-approved'), 44: loadFixture('open-red') };
  // PR 43 is gone (deleted, private, or the token expired): gh exits non-zero for it and only it.
  const gh = (args) => {
    if (args.some((a) => a === '43' || a === 'number=43')) throw new Error('gh: HTTP 404: Not Found');
    return ghMulti(byNumber)(args);
  };

  const results = facts.collect(p, { gh });
  assert.strictEqual(results.length, 3, 'every run is reported, the failing one included');
  const byRun = Object.fromEntries(results.map((r) => [r.run, r]));
  assert.match(byRun['TRK-15'].error, /HTTP 404/);
  assert.strictEqual(byRun['TRK-15'].pr, 43);
  assert.ok(!byRun['TRK-14'].error && !byRun['TRK-16'].error);
  assert.deepStrictEqual(byRun['TRK-14'].recorded.sort(), ['approved_on_head', 'checks-green', 'checks-green', 'threads_resolved']);
  assert.deepStrictEqual(byRun['TRK-16'].recorded, []);
  // The two healthy runs really wrote their facts snapshot — the pass was not merely survived.
  assert.ok(spine.readState(p, 'TRK-14').facts, 'TRK-14 got its snapshot despite TRK-15 failing');
  assert.ok(spine.readState(p, 'TRK-16').facts);
});

test('defaultGh puts a timeout on gh, so one hung call cannot stop the watch timer forever', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-hang-'));
  const stub = path.join(dir, 'gh-hangs');
  fs.writeFileSync(stub, '#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n');
  fs.chmodSync(stub, 0o755);
  const started = Date.now();
  assert.throws(() => {
    try {
      process.env.PLT_GH = stub; process.env.PLT_GH_TIMEOUT_MS = '400';
      facts.defaultGh(['pr', 'view', '42']);
    } finally { delete process.env.PLT_GH; delete process.env.PLT_GH_TIMEOUT_MS; }
  }, /gh timed out after 400ms/);
  assert.ok(Date.now() - started < 10000, 'the call was killed, not waited out');
});

test('collect: a hung gh is a per-run error like any other — the pass continues', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-17', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-17', 'inputs.yaml'), yaml.stringify({ card: 'TRK-17', pr_number: 42 }));
  const gh = () => { const e = new Error('gh timed out after 30000ms: pr view 42'); e.code = 'ETIMEDOUT'; throw e; };
  const results = facts.collect(p, { gh });
  assert.strictEqual(results.length, 1);
  assert.match(results[0].error, /timed out/);
});

test('collect: --run filters to one run; resolves the PR from a receipt ref when inputs.pr is absent', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  writeConfigOverlay(p, { review: { arch_agents: ['fixture-arch-reviewer'] } });
  spine.launchRun(p, { runId: 'PR-42', cycle: 'review-pr', repoDir: repo, owner: 'agent' });
  spine.recordReceipt(p, 'PR-42', { step: 'intake', kind: 'artifact', name: 'seed', result: 'pass',
    ref: 'https://github.com/example-org/greenhouse/pull/42', pin: spine.computePin(repo), actor: 'agent' });
  const results = facts.collect(p, { gh: ghOne('open-green-approved'), runId: 'PR-42' });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].pr, 42);   // resolved from the receipt ref, not inputs.pr
});

test('CLI: `plt facts` names a failing run and exits non-zero, while `plt watch --once` logs it and still renders', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  const repoA = tmpRepo(); const repoB = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-18', cycle: 'build-and-ship', repoDir: repoA, owner: 'agent' });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-18', 'inputs.yaml'), yaml.stringify({ card: 'TRK-18', pr_number: 42 }));
  spine.launchRun(p, { runId: 'TRK-19', cycle: 'build-and-ship', repoDir: repoB, owner: 'agent' });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-19', 'inputs.yaml'), yaml.stringify({ card: 'TRK-19', pr_number: 43 }));
  const plt = path.join(__dirname, '..', 'bin', 'plt');
  const env = { ...process.env, PLT_PROCESS_DIR: p, PLT_GH: path.join(GH_FIX, 'stub.js'),
    PLT_GH_FIXTURE: path.join(GH_FIX, 'open-green-approved.json'), PLT_GH_FAIL_PR: '43' };

  const f = require('child_process').spawnSync(process.execPath, [plt, 'facts'], { encoding: 'utf8', env });
  assert.strictEqual(f.status, 1, f.stdout + f.stderr);
  assert.match(f.stdout + f.stderr, /TRK-19/);
  assert.match(f.stdout, /TRK-18: recorded/, 'the healthy run still reported');

  // The unattended pass must survive the same failure: it renders, and says so on stderr.
  const w = require('child_process').spawnSync(process.execPath, [plt, 'watch', '--once'], { encoding: 'utf8', env });
  assert.strictEqual(w.status, 0, w.stdout + w.stderr);
  assert.match(w.stderr, /TRK-19/);
  assert.ok(fs.existsSync(path.join(p, 'build', 'index.html')), 'render still ran after the collect failure');
});

test('CLI: plt facts --run <id> prints one recorded/skipped/activity line, driven through PLT_GH', () => {
  const root = tmpProcess(); const p = path.join(root, 'process'); const repo = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-20', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-20', 'inputs.yaml'), yaml.stringify({ card: 'TRK-20', pr_number: 42 }));
  const plt = path.join(__dirname, '..', 'bin', 'plt');
  const env = { ...process.env, PLT_PROCESS_DIR: p, PLT_GH: path.join(GH_FIX, 'stub.js'), PLT_GH_FIXTURE: path.join(GH_FIX, 'open-green-approved.json') };
  const r = require('child_process').spawnSync(process.execPath, [plt, 'facts', '--run', 'TRK-20'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^TRK-20: recorded (approved_on_head|checks-green|threads_resolved)(,(approved_on_head|checks-green|threads_resolved)){3} · skipped - · activity 0\n$/);
});

test('findPrRepo: a run names its own repo — one config default must not send a second repo\'s run at the wrong PR', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  const cfg = spine.loadConfig(p);
  const w = (id, inputs) => {
    fs.mkdirSync(path.join(p, 'runs', id), { recursive: true });
    fs.writeFileSync(path.join(p, 'runs', id, 'inputs.yaml'), yaml.stringify(inputs));
  };
  w('R-1', { card: 'R-1', repo: 'example-org/libs', pr_number: 4 });
  w('R-2', { card: 'R-2', pr: 'https://github.com/example-org/libs/pull/4' });
  w('R-3', { card: 'R-3', pr_number: 4 });
  assert.strictEqual(facts.findPrRepo(p, 'R-1', cfg), 'example-org/libs', 'inputs.repo wins');
  assert.strictEqual(facts.findPrRepo(p, 'R-2', cfg), 'example-org/libs', 'then the owner/name in the PR URL');
  assert.strictEqual(facts.findPrRepo(p, 'R-3', cfg), (cfg.links || {}).pr_repo, 'then the config default');
});

test('collect: two runs on the same PR number in DIFFERENT repos each read their own PR', () => {
  const root = tmpProcess(); const p = path.join(root, 'process');
  const repoA = tmpRepo(); const repoB = tmpRepo();
  spine.launchRun(p, { runId: 'TRK-80', cycle: 'build-and-ship', repoDir: repoA, owner: 'agent' });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-80', 'inputs.yaml'),
    yaml.stringify({ card: 'TRK-80', pr_number: 42 }));                                   // config default repo
  spine.launchRun(p, { runId: 'TRK-81', cycle: 'build-and-ship', repoDir: repoB, owner: 'agent' });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-81', 'inputs.yaml'),
    yaml.stringify({ card: 'TRK-81', repo: 'example-org/libs', pr_number: 42 }));          // a DIFFERENT repo, same number

  // The same number in each repo, with opposite facts: the closed one is the trap. Before the fix
  // both runs read the config repo, so TRK-81 would have collected TRK-80's PR — on a real run
  // that wrote a passing `pr_closed` receipt onto a run whose PR is wide open.
  const open = loadFixture('open-green-approved');
  const closed = JSON.parse(JSON.stringify(open));
  closed.view.state = 'MERGED';
  closed.view.url = 'https://github.com/example-org/libs/pull/42';   // the guard: facts must come from the repo asked for
  const gh = (args) => {
    const forLibs = args.some((a) => String(a).includes('example-org/libs'));
    const fixture = forLibs ? closed : open;
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(fixture.view);
    return JSON.stringify(fixture.threads);
  };

  const byRun = Object.fromEntries(facts.collect(p, { gh }).map((r) => [r.run, r]));
  assert.strictEqual(byRun['TRK-80'].repo, (spine.loadConfig(p).links || {}).pr_repo);
  assert.strictEqual(byRun['TRK-81'].repo, 'example-org/libs');
  assert.ok(!byRun['TRK-80'].error && !byRun['TRK-81'].error, JSON.stringify(byRun));
  assert.ok(!byRun['TRK-80'].recorded.includes('merged'), 'the open PR never records merged');
  assert.ok(byRun['TRK-81'].recorded.includes('merged'), 'the merged one does');

  // And the guard itself: facts that came back from another repo are refused, not recorded.
  const wrongRepo = (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(open.view);   // always greenhouse
    return JSON.stringify(open.threads);
  };
  const guarded = facts.collect(p, { gh: wrongRepo, runId: 'TRK-81' })[0];
  assert.match(guarded.error, /example-org\/libs#42 resolved to https:\/\/github.com\/example-org\/greenhouse\/pull\/42/);
});
