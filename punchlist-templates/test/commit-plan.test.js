'use strict';
// commit-plan — the artifact, its gate, and the reconcile step (K8).
//
// Every test here names the wrong OUTCOME it prevents, not the code path it walks. Each
// one was run against the naive implementation it describes and seen to fail: a gate that
// fires on any overlap, a containment check done with startsWith, a reconcile that reads
// git's newest-first order as written, a divergence that never escalates. A test that
// cannot fail is not coverage.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const cp = require('../lib/commit-plan');

const commit = (sha, subject, files) => ({ sha, subject, files });

// ------------------------------------------------------------------ parse

const PLAN = `# Commit plan

| # | commit | files |
|---|--------|-------|
| 1 | lib: the reconcile library | \`lib/commit-plan.js\` |
| 2 | test: reconcile's discriminating tests | \`test/commit-plan.test.js\` |
| 3 | templates: the commit-plan artifact | \`templates/packs/core/commit-plan.md\` |
`;

test('the plan table parses to numbered entries with their files', () => {
  const { entries, errors } = cp.parseCommitPlan(PLAN);
  assert.deepEqual(errors, []);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { n: 1, subject: 'lib: the reconcile library', files: ['lib/commit-plan.js'] });
  assert.deepEqual(entries[2].files, ['templates/packs/core/commit-plan.md']);
});

test('a second table on the page is not read as the plan', () => {
  // The wrong outcome: a card reconciles against the rows of its gates table, and every
  // real commit reports as "not in the plan" while the plan itself is invisible.
  const withNoise = `| gate | state |\n|---|---|\n| typecheck | pass |\n\n${PLAN}`;
  const { entries, errors } = cp.parseCommitPlan(withNoise);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.n), [1, 2, 3]);
  // And the other table raises nothing. A parser that reads every table and then rejects
  // the rows it cannot number turns an ordinary page into a plan full of errors.
  assert.deepEqual(errors, []);
});

test('an entry with no files is an error, not an entry', () => {
  // The wrong outcome this prevents is the expensive one: an entry declaring nothing can
  // intersect nobody, so a lenient parser switches the card's gate OFF and the human who
  // should have ordered two colliding commits is never asked.
  const bad = `| # | commit | files |\n|---|---|---|\n| 1 | tidy up | |\n`;
  const { entries, errors } = cp.parseCommitPlan(bad);
  assert.deepEqual(entries, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /declares no files/);
});

test('gaps in the numbering are reported', () => {
  const bad = `| # | commit | files |\n|---|---|---|\n| 1 | a | \`x.js\` |\n| 3 | b | \`y.js\` |\n`;
  const { errors } = cp.parseCommitPlan(bad);
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /numbered 1\.\.n/);
});

// ------------------------------------------------------------------ containment

test('a file inside a declared DIRECTORY touch is inside it', () => {
  assert.equal(cp.inside('lib/deep/file.js', ['lib']), true);
});

test('containment is segment-wise: a declared file does not cover its lookalikes', () => {
  // The wrong outcome: a `startsWith` containment check reads `lib/commit-plan.js` as
  // covering `lib/commit-plan.js.orig` — and a scope escape passes the check that exists
  // to catch scope escapes.
  assert.equal(cp.inside('lib/commit-plan.js.orig', ['lib/commit-plan.js']), false);
  assert.equal(cp.inside('libs/commit-plan.js', ['lib']), false);
});

test('containment is one-directional: declaring one file does not declare its parent', () => {
  // The wrong outcome: effort.touchesOverlap is SYMMETRIC because it answers "do two
  // declarations collide". Reused here it would read a card that declared
  // `lib/commit-plan.js` as having declared the whole of `lib`.
  assert.equal(cp.inside('lib', ['lib/commit-plan.js']), false);
});

// ------------------------------------------------------------------ the gate

const CARDS = [
  { id: 'T3', touches: ['lib/fan.js', 'test/fan.test.js'], status: 'closed' },
  { id: 'T4', touches: ['lib/rebase.js'], status: 'absent' },
  { id: 'T5', touches: ['lib/timing.js'], status: 'running' },
  { id: 'T6', touches: ['lib/commit-plan.js'], status: 'running' },
  { id: 'T7', touches: ['lib/commit-plan.js'], status: 'running' },
];

test('only LOWER cards gate, and a closed one does not', () => {
  const lower = cp.lowerOpenCards(CARDS, 'T6');
  assert.deepEqual(lower.map((c) => c.id), ['T4', 'T5'], 'T3 is closed; T7 is higher');
});

test('a card with no run yet (absent) is OPEN and can gate a card above it', () => {
  // The wrong outcome: "no run state" read as "finished". A card that has not started is
  // the one most likely to rewrite the shared file, so treating it as closed is how the
  // gate quietly stops asking.
  // T4 has no run state at all and must still be in the list.
  const lower = cp.lowerOpenCards(CARDS, 'T6');
  assert.ok(lower.some((c) => c.id === 'T4'), 'T4 is absent — not started — and still open');
});

test('a card that is not in the effort list is refused by name', () => {
  assert.throws(() => cp.lowerOpenCards(CARDS, 'T99'), /T99/);
});

test('the plan is NOT gated when nothing intersects a lower open card', () => {
  const { entries } = cp.parseCommitPlan(PLAN);
  const g = cp.planGate(entries, cp.lowerOpenCards(CARDS, 'T6'));
  assert.equal(g.gated, false, 'T5 owns lib/timing.js, which no entry touches');
  assert.deepEqual(g.reasons, []);
});

test('the plan IS gated when an entry intersects a lower open card, and names entry, card and path', () => {
  const { entries } = cp.parseCommitPlan(PLAN);
  const lower = [{ id: 'T2', touches: ['lib'], status: 'running' }];
  const g = cp.planGate(entries, lower);
  assert.equal(g.gated, true);
  // The decision the human makes is about ORDER — put the shared-file commit last — and a
  // bare boolean cannot be acted on. This is the assertion a naive `return true` fails.
  assert.deepEqual(g.reasons, [{ entry: 1, with: 'T2', paths: ['lib/commit-plan.js'] }]);
});

test('an intersection with a CLOSED lower card does not gate', () => {
  // The wrong outcome: every card in a long effort stays gated forever on files that
  // landed weeks ago, and the gate is clicked through by habit.
  const { entries } = cp.parseCommitPlan(PLAN);
  const cards = [{ id: 'T2', touches: ['lib'], status: 'closed' }, { id: 'T6', touches: ['lib/commit-plan.js'], status: 'running' }];
  assert.equal(cp.planGate(entries, cp.lowerOpenCards(cards, 'T6')).gated, false);
});

// ------------------------------------------------------------------ reconcile

const TOUCHES = ['lib/commit-plan.js', 'test/commit-plan.test.js', 'templates/packs/core/commit-plan.md'];
const PLANNED = cp.parseCommitPlan(PLAN).entries;
const MADE = [
  commit('aaa1111', 'lib: the reconcile library', ['lib/commit-plan.js']),
  commit('bbb2222', "test: reconcile's discriminating tests", ['test/commit-plan.test.js']),
  commit('ccc3333', 'templates: the commit-plan artifact', ['templates/packs/core/commit-plan.md']),
];

test('commits that match the plan reconcile as matches, with no mode escalation', () => {
  const r = cp.reconcile({ entries: PLANNED, commits: MADE, touches: TOUCHES });
  assert.equal(r.outcome, 'matches');
  assert.equal(r.mode, 'banner');
  assert.deepEqual(r.reasons, []);
});

test('a commit the plan does not have diverges — as a BANNER', () => {
  // Rewriting a plan after the fact is normal work. Holding the card for it would make
  // the artifact a tax, which is how artifacts get skipped.
  const commits = [...MADE, commit('ddd4444', 'lib: tidy', ['lib/commit-plan.js'])];
  const r = cp.reconcile({ entries: PLANNED, commits, touches: TOUCHES });
  assert.equal(r.outcome, 'diverged');
  assert.equal(r.mode, 'banner');
  assert.deepEqual(r.reasons.map((x) => x.kind), ['plan-added']);
  assert.equal(r.replanned.length, 4, 'the plan is rewritten from git');
});

test('a planned commit never made diverges, and the plan-diff says which', () => {
  const r = cp.reconcile({ entries: PLANNED, commits: MADE.slice(0, 2), touches: TOUCHES });
  assert.equal(r.outcome, 'diverged');
  assert.deepEqual(r.diff, [{ n: 3, kind: 'removed', subject: 'templates: the commit-plan artifact', files: ['templates/packs/core/commit-plan.md'] }]);
});

test('commits made in a different ORDER than planned diverge', () => {
  // The wrong outcome: "put the shared-file commit last" is the whole point of ordering a
  // plan, and a set-comparison reconcile reports a card that ignored that order as matching.
  const swapped = [MADE[1], MADE[0], MADE[2]];
  const r = cp.reconcile({ entries: PLANNED, commits: swapped, touches: TOUCHES });
  assert.equal(r.outcome, 'diverged');
  assert.deepEqual(r.diff.map((d) => d.kind), ['files', 'files']);
});

test('a commit outside the card\'s touches is HARD, and names the file', () => {
  const commits = [...MADE, commit('eee5555', 'drive-by fix', ['lib/spine.js'])];
  const r = cp.reconcile({ entries: PLANNED, commits, touches: TOUCHES });
  assert.equal(r.mode, 'hard');
  const over = r.reasons.find((x) => x.kind === 'over-touches');
  assert.deepEqual(over.files, ['lib/spine.js']);
});

test('a commit outside touches is hard EVEN WHEN the plan itself listed that file', () => {
  // The wrong outcome, and the reason the check is commits ⊆ touches rather than
  // commits ⊆ plan ⊆ touches: a plan can name a file the effort never deconflicted on,
  // and then matching the plan exactly is precisely the wrong answer.
  const plan = cp.parseCommitPlan(`| # | commit | files |\n|---|---|---|\n| 1 | reach | \`lib/spine.js\` |\n`).entries;
  const r = cp.reconcile({ entries: plan, commits: [commit('f1', 'reach', ['lib/spine.js'])], touches: TOUCHES });
  assert.equal(r.outcome, 'diverged', 'matching a plan that exceeded scope is not "matches"');
  assert.equal(r.mode, 'hard');
});

test('a re-plan that flips the gate false->true is HARD', () => {
  // Someone already ruled on a plan that collided with nobody. The new one collides and
  // nobody has looked at it — the exact case a banner would wave through.
  const lower = [{ id: 'T5', touches: ['lib/timing.js'], status: 'running' }];
  const commits = [...MADE, commit('ddd4444', 'timing: fix', ['lib/timing.js'])];
  const r = cp.reconcile({ entries: PLANNED, commits, touches: [...TOUCHES, 'lib/timing.js'], lower });
  assert.equal(r.gate.before, false);
  assert.equal(r.gate.after, true);
  assert.equal(r.mode, 'hard');
  assert.ok(r.reasons.some((x) => x.kind === 'gate-flip'));
});

test('a re-plan that flips the gate true->false is only a banner', () => {
  // The reverse flip has strictly LESS to rule on than the plan already approved.
  // Escalating it would teach people that a hard gate means nothing.
  const lower = [{ id: 'T5', touches: ['lib/timing.js'], status: 'running' }];
  const planned = cp.parseCommitPlan(`| # | commit | files |\n|---|---|---|\n| 1 | a | \`lib/commit-plan.js\` |\n| 2 | b | \`lib/timing.js\` |\n`).entries;
  const r = cp.reconcile({ entries: planned, commits: [MADE[0]], touches: ['lib/commit-plan.js', 'lib/timing.js'], lower });
  assert.equal(r.gate.before, true);
  assert.equal(r.gate.after, false);
  assert.equal(r.outcome, 'diverged');
  assert.equal(r.mode, 'banner');
});

test('the gate flip is measured against the gate that was APPROVED, not a recomputed one', () => {
  // gatedBefore is the decision recorded at approval. Recomputing "before" from the
  // current card list re-decides history: a card that closed since approval makes the old
  // gate look false, and the flip fires on a plan nothing changed about.
  // The story: at approval this plan WAS gated and a human ruled on it. The card it
  // collided with has since closed, so recomputing "before" from today's card list says
  // false — and the flip then fires on a plan nobody changed anything about.
  const lower = [{ id: 'T5', touches: ['lib/timing.js'], status: 'running' }];
  const commits = [...MADE, commit('ddd4444', 'timing: fix', ['lib/timing.js'])];
  const r = cp.reconcile({ entries: PLANNED, commits, touches: [...TOUCHES, 'lib/timing.js'], lower, gatedBefore: true });
  assert.equal(r.gate.before, true, 'the recorded decision, not a recomputed one');
  assert.equal(r.gate.after, true);
  assert.equal(r.mode, 'banner', 'true->true is not a flip');
});

test('a plan entry pinned to a sha that HEAD no longer has diverges', () => {
  // The wrong outcome: `recommit` replays to the approved plan, and a rewritten commit
  // with the same subject and the same files is invisible to every other check here.
  const entries = PLANNED.map((e, i) => (i === 0 ? { ...e, sha: 'aaa1111' } : e));
  const commits = [{ ...MADE[0], sha: '9999999' }, MADE[1], MADE[2]];
  const r = cp.reconcile({ entries, commits, touches: TOUCHES });
  assert.equal(r.outcome, 'diverged');
  assert.ok(r.reasons.some((x) => x.kind === 'plan-sha'));
});

test('an abbreviated sha in the plan still matches the full sha in git', () => {
  const entries = PLANNED.map((e, i) => (i === 0 ? { ...e, sha: 'aaa1' } : e));
  const r = cp.reconcile({ entries, commits: MADE, touches: TOUCHES });
  assert.equal(r.outcome, 'matches');
});

test('the reconcile step is the one the ADR specifies', () => {
  assert.equal(cp.reconcileStep.id, 'reconcile');
  assert.deepEqual(cp.reconcileStep.needs, ['commit-plan']);
  assert.deepEqual(cp.reconcileStep.outcomes, ['matches', 'diverged']);
});

// ------------------------------------------------------------------ git

test('commitsBetween reads base..HEAD OLDEST FIRST, with each commit\'s files', () => {
  // The wrong outcome: `git log` is newest-first. Reconciling a plan written top-down
  // against a list read bottom-up reports every commit of a correct card as reordered,
  // which trains people to ignore the banner.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-plan-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(dir, 'one.js'), '1\n');
    git('add', '-A'); git('commit', '-qm', 'first: one');
    fs.writeFileSync(path.join(dir, 'two.js'), '2\n');
    git('add', '-A'); git('commit', '-qm', 'second: two');

    const commits = cp.commitsBetween(dir, base);
    assert.deepEqual(commits.map((c) => c.subject), ['first: one', 'second: two']);
    assert.deepEqual(commits.map((c) => c.files), [['one.js'], ['two.js']]);
    assert.equal(commits.length, 2, 'the base commit is not in base..HEAD');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('commitsBetween skips a merge of the base branch', () => {
  // The wrong outcome: a card that merged main to stay current reports an extra commit
  // touching every file main moved, which diverges the plan AND blows the touches check.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-plan-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', '-b', 'card');
    fs.writeFileSync(path.join(dir, 'one.js'), '1\n');
    git('add', '-A'); git('commit', '-qm', 'first: one');
    git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'elsewhere.js'), 'x\n');
    git('add', '-A'); git('commit', '-qm', 'main moved');
    git('checkout', '-q', 'card');
    git('merge', '-q', '--no-edit', 'main');

    // THE BASE BRANCH'S OWN COMMITS ARE NOT THIS CARD'S. This assertion replaces one that
    // pinned the opposite as correct: it expected `main moved` in the list, which is how a
    // card that merely merged main to stay current earns a HARD gate naming a file it never
    // touched. `base` here is a FIXED sha — the launch-pin fallback effort.branchBase uses
    // when origin/main does not resolve, and the only base under which this can happen.
    const commits = cp.commitsBetween(dir, base, 'HEAD', { upstream: 'main' });
    assert.deepEqual(commits.map((c) => c.subject), ['first: one']);
    assert.ok(!commits.some((c) => /^Merge /.test(c.subject)), 'the merge commit itself is skipped');

    // And without the upstream to exclude, main's commit IS in the range. This is not a
    // wish: it is why the option exists, and it fails if --not stops being passed.
    const naive = cp.commitsBetween(dir, base, 'HEAD', { upstream: null });
    assert.ok(naive.some((c) => c.subject === 'main moved'),
      "the hazard is real — a fixed base pulls in the base branch's commits");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the template

test('the shipped commit-plan template\'s own table parses', () => {
  // The failure this prevents is the one that would make the whole artifact useless: a
  // page whose golden exemplar teaches a table shape the reconcile step cannot read.
  // Nothing else in the repo checks the template body against the parser.
  const md = fs.readFileSync(path.join(__dirname, '..', 'templates', 'packs', 'core', 'commit-plan.md'), 'utf8');
  const { entries, errors } = cp.parseCommitPlan(md);
  assert.deepEqual(errors, []);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.n), [1, 2, 3]);
  assert.deepEqual(entries[0].files, ['lib/commit-plan.js']);
  assert.equal(entries[0].sha, '4f9a1c2');
  assert.equal(entries[2].sha, undefined, 'an em-dash in the sha column is "not committed yet", not a sha');
});


// ---------------------------------------------------- round 1 of review: the fixes

test('a card that did its work on a SIDE branch keeps every commit of it', () => {
  // Why --first-parent was refused as the fix for the merged-base-branch problem. Under it
  // this card reports ZERO commits and the scope escape below is invisible — a silent
  // escape traded for a visible false gate, which is the wrong way round for a module whose
  // whole job is catching escapes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-plan-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', '-b', 'card');
    git('checkout', '-q', '-b', 'card-side');
    fs.writeFileSync(path.join(dir, 'escape.js'), 'x\n');
    git('add', '-A'); git('commit', '-qm', 'side: a file outside touches');
    git('checkout', '-q', 'card');
    git('merge', '-q', '--no-edit', '--no-ff', 'card-side');

    const commits = cp.commitsBetween(dir, base, 'HEAD', { upstream: 'main' });
    assert.deepEqual(commits.map((c) => c.subject), ['side: a file outside touches']);
    const r = cp.reconcile({ entries: [{ n: 1, subject: 'x', files: ['lib/commit-plan.js'] }], commits, touches: ['lib/commit-plan.js'] });
    assert.equal(r.mode, 'hard', 'the escape is still caught through the merge');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a card with NO declared touches is hard, not a quiet banner', () => {
  // effort.js defaults every card to `touches: []`. Skipping containment on an empty list
  // switched the escalation off for exactly the cards most likely to need it: a card that
  // never said what it would touch could commit anywhere and reconcile called it a banner.
  const r = cp.reconcile({ entries: [], commits: [commit('a1', 'anywhere', ['bin/plt'])], touches: [] });
  assert.equal(r.mode, 'hard');
  assert.equal(r.undeclared, true);
  assert.ok(r.reasons.some((x) => x.kind === 'touches-undeclared'));
});

test('undefined touches is the same as empty — not "everything is in scope"', () => {
  const r = cp.reconcile({ entries: [], commits: [commit('a1', 'anywhere', ['bin/plt'])] });
  assert.equal(r.mode, 'hard');
  assert.ok(r.reasons.some((x) => x.kind === 'touches-undeclared'));
});

test('a card with no touches and no commits is not accused of anything', () => {
  // Nothing has landed, so there is nothing that could have escaped. Raising here would
  // put a hard gate on every card the moment it was created.
  const r = cp.reconcile({ entries: [], commits: [], touches: [] });
  assert.equal(r.undeclared, false);
  assert.ok(!r.reasons.some((x) => x.kind === 'touches-undeclared'));
});

test('a page with no plan table is an ERROR, not an empty success', () => {
  // The failure that matters most in a gate module: `{entries: [], errors: []}` reduces to
  // "not gated", so a page nobody could read switches the dispatch gate off silently.
  for (const bad of ['', '# Commit plan\n\nWe will commit it all at once.\n', '| step | files |\n|---|---|\n| build | `x.js` |\n']) {
    const { entries, errors } = cp.parseCommitPlan(bad);
    assert.deepEqual(entries, []);
    assert.ok(errors.length > 0, `no error raised for: ${JSON.stringify(bad.slice(0, 30))}`);
    assert.match(errors[0].msg, /no commit-plan table/);
  }
});

test('a plan table with a header and no rows is an error', () => {
  const { errors } = cp.parseCommitPlan('| # | commit | files |\n|---|---|---|\n');
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /no entries/);
});

test('an unreadable plan is GATED and says it does not know', () => {
  // Fail-closed. This is the assertion that stops an empty parse from reading as safe.
  const g = cp.planGate([], [{ id: 'T5', touches: ['lib'], status: 'running' }]);
  assert.equal(g.gated, true);
  assert.equal(g.unknown, true);
  assert.equal(g.reasons[0].kind, 'no-entries');
});

test('an unknown gate is not counted as a gate FLIP', () => {
  // It is already reported as a parse error and as removed entries. Spending the hard
  // escalation on an unreadable page hides the case the escalation is for, and the two
  // need different fixes.
  const lower = [{ id: 'T5', touches: ['lib/timing.js'], status: 'running' }];
  const r = cp.reconcile({ entries: PLANNED, commits: [], touches: TOUCHES, lower, gatedBefore: false });
  assert.equal(r.gate.after, true);
  assert.equal(r.gate.flipped, false, 'gated-because-unreadable is not gated-because-it-collides');
  assert.equal(r.mode, 'banner');
});

test('an escaped pipe in a cell keeps the row intact', () => {
  const md = '| # | commit | files |\n|---|---|---|\n| 1 | parse: split on unescaped \\| only | `lib/commit-plan.js` |\n';
  const { entries, errors } = cp.parseCommitPlan(md);
  assert.deepEqual(errors, []);
  assert.equal(entries[0].subject, 'parse: split on unescaped | only');
  assert.deepEqual(entries[0].files, ['lib/commit-plan.js'], 'the files column did not shift');
});

test('a row whose cell count does not match the header is an error, not a silent loss', () => {
  // The unescaped pipe. Every cell after it shifts one column left, so the subject lands in
  // `files` and the real files land nowhere — an entry that lost its files, reported clean,
  // which under-reports the gate.
  const md = '| # | commit | files |\n|---|---|---|\n| 1 | a | b | `lib/commit-plan.js` |\n';
  const { entries, errors } = cp.parseCommitPlan(md);
  assert.equal(entries.length, 0);
  assert.equal(errors.length, 1, 'one precise error naming the row, not a pile of consequences');
  assert.match(errors[0].msg, /4 cells, the header has 3/);
});

test('entry number 0 is refused', () => {
  const { entries, errors } = cp.parseCommitPlan('| # | commit | files |\n|---|---|---|\n| 0 | a | `x.js` |\n');
  assert.deepEqual(entries, []);
  assert.match(errors[0].msg, /no entry number/);
});

test('a card id in the number column is refused, not read as a number', () => {
  // `T6-1` with the digits stripped out is entry 61: it sorts to the end and reports every
  // real entry as a gap in the numbering.
  const { entries, errors } = cp.parseCommitPlan('| # | commit | files |\n|---|---|---|\n| T6-1 | a | `x.js` |\n');
  assert.deepEqual(entries, []);
  assert.match(errors[0].msg, /no entry number/);
});

test('a word in the sha column is refused, not kept as a sha', () => {
  // Kept as one, the reconcile sha check compares HEAD against "pending" and reports a
  // rewritten commit on every card that filled the column in honestly.
  const { entries, errors } = cp.parseCommitPlan('| # | commit | files | sha |\n|---|---|---|---|\n| 1 | a | `x.js` | pending |\n');
  assert.equal(entries[0].sha, undefined);
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /is not a sha/);
});

test('a dropped lower card does not gate the cards above it', () => {
  // effort.runStatus returns only absent|running|closed|discarded. The first version of the
  // closed set spelled 'dropped' and 'merged', which nothing writes, so a dropped card
  // arrived as open and gated every card above it for the rest of the effort.
  const cards = [{ id: 'T2', touches: ['lib'], status: 'running', dropped: true }, { id: 'T6', touches: ['lib/commit-plan.js'], status: 'running' }];
  assert.deepEqual(cp.lowerOpenCards(cards, 'T6').map((c) => c.id), []);
});

test('a status this module does not know keeps the card OPEN', () => {
  // Fail-closed again: an unrecognised status must not read as finished.
  const cards = [{ id: 'T2', touches: ['lib'], status: 'in_review' }, { id: 'T6', touches: ['lib/commit-plan.js'], status: 'running' }];
  assert.deepEqual(cp.lowerOpenCards(cards, 'T6').map((c) => c.id), ['T2']);
});

test('a dot segment does not change what a path is', () => {
  assert.equal(cp.inside('./lib/commit-plan.js', ['lib/commit-plan.js']), true);
  assert.equal(cp.inside('lib/./commit-plan.js', ['lib']), true);
});

test('a path that climbs OUT of a declared directory is outside it', () => {
  // `lib/../bin/plt` is two segments under `lib` to anything that does not resolve `..`,
  // so it passes a containment check on `lib` — a scope escape spelled as a path.
  assert.equal(cp.inside('lib/../bin/plt', ['lib']), false);
  assert.equal(cp.inside('lib/../bin/plt', ['bin']), true);
});
