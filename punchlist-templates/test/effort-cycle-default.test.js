'use strict';
// cycles.default — which cycle a card runs when it does not name one. It was hardcoded in
// lib/effort.js, which made "does this project use pull requests?" a question only
// editable by patching the library.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const effort = require('../lib/effort');

function processDir(cfg) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-cyc-'));
  fs.mkdirSync(path.join(p, 'config'), { recursive: true });
  fs.mkdirSync(path.join(p, 'efforts'), { recursive: true });
  fs.writeFileSync(path.join(p, 'config', 'defaults.yaml'),
    'gates:\n  human_signals: [artifact-approved]\nmodels:\n  default_model: opus\n');
  if (cfg) fs.writeFileSync(path.join(p, 'config', 'zz.yaml'), cfg);
  fs.writeFileSync(path.join(p, 'efforts', 'e.yaml'),
    'slug: e\ntitle: t\ncards:\n  - A\n  - { id: B, cycle: spike }\n');
  return p;
}

test('a project that sets nothing keeps build-and-ship — the default is an override', () => {
  // No existing effort may change behaviour by adding this feature.
  const cards = effort.readEffort(processDir(null), 'e').cards;
  assert.equal(cards.find((c) => c.id === 'A').cycle, 'build-and-ship');
  assert.equal(effort.CYCLE_FALLBACK, 'build-and-ship');
});

test('cycles.default sets the cycle for cards that do not name one', () => {
  const cards = effort.readEffort(processDir('cycles:\n  default: build-and-commit\n'), 'e').cards;
  assert.equal(cards.find((c) => c.id === 'A').cycle, 'build-and-commit');
});

test("a card's own cycle always wins over the project default", () => {
  // Three levers, most specific first: a card, then the project, then the fallback.
  const cards = effort.readEffort(processDir('cycles:\n  default: build-and-commit\n'), 'e').cards;
  assert.equal(cards.find((c) => c.id === 'B').cycle, 'spike');
});

test('a blank or non-string default falls back rather than producing an empty cycle name', () => {
  // An empty `cycles.default:` in YAML parses as null. Taking it literally would look for
  // a cycle file named '' and fail somewhere far from the typo.
  for (const cfg of ['cycles:\n  default: ""\n', 'cycles:\n  default:\n', 'cycles:\n  default: [a]\n']) {
    const cards = effort.readEffort(processDir(cfg), 'e').cards;
    assert.equal(cards.find((c) => c.id === 'A').cycle, 'build-and-ship', cfg);
  }
});

test('a config that will not parse stops the read, rather than quietly answering wrong', () => {
  // The first version of this test used ':::not yaml:::', which loadConfig does NOT
  // reject — it returns { ':::not yaml::': null } — so the assertion passed because
  // overwriting the file had deleted cycles.default, not because any error path ran. The
  // catch branch had zero coverage and the test passed against the pre-fix commit.
  // `foo: [unclosed` actually throws.
  const p = processDir('cycles:\n  default: build-and-commit\n');
  fs.writeFileSync(path.join(p, 'config', 'zz.yaml'), 'foo: [unclosed\n');
  assert.throws(() => effort.readEffort(p, 'e'), /.+/,
    'plan and launch must agree: launchWave reloads config unguarded and would throw anyway');
});

test('drift guard: build-and-commit shares build-and-ship\'s prefix byte for byte', () => {
  // The cost of shipping a second pack rather than an overlay. `formulaSource` merges
  // overlay steps by id and CANNOT delete one, so an `extends:` overlay genuinely cannot
  // cut a cycle off after `approve` — the duplication is forced. What is not forced is
  // letting the copies drift: editing review.on_fail or pre-pr.overlap in one pack would
  // otherwise leave the other silently different, and nothing would say so.
  const dir = path.resolve(__dirname, '../workflows/packs/core');
  const ship = fs.readFileSync(path.join(dir, 'build-and-ship.md'), 'utf8');
  const commit = fs.readFileSync(path.join(dir, 'build-and-commit.md'), 'utf8');
  // Compare the four genuinely shared steps as BLOCKS, by id. Slicing to the next
  // `- id: pre-` was wrong: a comment explaining why the pre-* step differs sits above it
  // and landed inside the "shared" span, so the guard failed on its own documentation.
  // Comments INSIDE a step are still compared — they are part of what must not drift.
  const block = (src, id) => {
    const start = src.indexOf(`  - id: ${id}\n`);
    assert.notEqual(start, -1, `${id} missing`);
    const after = src.slice(start + 1);
    const rel = after.search(/^ {2}(?:- id:|#)/m);
    return after.slice(0, rel === -1 ? undefined : rel);
  };
  // scope/build/review only. `write-review` left the guarded prefix when the writing
  // adversary pointed out its title named a PR body this cycle never produces — the
  // guard caught that change and its own message says where such a step belongs.
  for (const id of ['scope', 'build', 'review']) {
    assert.equal(block(commit, id), block(ship, id),
      `step ${id} has drifted between the two packs; a step that legitimately differs belongs after the shared prefix, with a comment saying why`);
  }
});

test('build-and-commit is the same shape to the human gate, then commits instead of a PR', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../workflows/packs/core/build-and-commit.md'), 'utf8');
  const ids = [...src.matchAll(/^ {2}- id: (\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(ids, ['scope', 'build', 'review', 'arch', 'write-review', 'pre-pr', 'approve', 'merge', 'close-out']);

  // The step id stays `pre-pr` on purpose: spine.js keys checkTouchesDrift on that exact
  // name, so a truer-sounding id would silently drop a safety check — the same trap as
  // the landing step, found twice in this one card. What changes for the human is the
  // title and the artifact.
  assert.match(src, /- id: pre-pr\b/);
  assert.doesNotMatch(src, /- id: pre-commit\b/);

  // One human gate, and it is the same gate: reviewing commits changes WHAT the human is
  // shown, never WHETHER one is asked.
  assert.equal((src.match(/kind: human/g) || []).length, 1);
  assert.match(src, /- id: approve[\s\S]*?signal: artifact-approved/);
  assert.match(src, /artifact: pre-commit-summary/);

  // The landing step is NAMED `merge` deliberately: spine.gateCheck keys its
  // base-freshness check on the step name, so calling it `commit` silently opted the
  // cycle out of the "branch base is behind origin/main" signal it claims to rely on.
  assert.ok(ids.includes('merge'), 'the landing step must be named merge');

  // The point of the cycle: no PR steps, and therefore no gh call to gate.
  for (const gone of ['open-pr', 'pr-loop', 'resync', 'reply', 'announce']) {
    assert.ok(!ids.includes(gone), `${gone} must not be in a commit-review cycle`);
  }
  assert.ok(!/^\s+gh:/m.test(src), 'no gh verify block');

  // approve is STILL a human gate — reviewing commits changes where the diff is read,
  // never whether a person reads it.
  assert.match(src, /- id: approve[\s\S]*?kind: human/);
  // and the fast-forward can still collide, so the conflict outcome survives (ADR-2 K7).
  assert.match(src, /- id: merge\b[\s\S]*?outcomes: \[merged, conflict\][\s\S]*?repeat_until: merged/);
});

test('the cycle has an architecture pass — dropping the PR must not drop the arch review', () => {
  // The regression this prevents is silent and only visible a cycle later: `build-and-ship`
  // reaches config.review.arch_agents through `review-pr`, which a commit-review project
  // never runs. Switching cycles.default therefore used to stop running the arch adversary
  // on this project's own work, with nothing in the run, the artifact or prime saying so.
  const src = fs.readFileSync(path.resolve(__dirname, '../workflows/packs/core/build-and-commit.md'), 'utf8');
  const step = src.match(/^ {2}- id: arch\n([\s\S]*?)(?=^ {2}(?:#|- id: ))/m);
  assert.ok(step, 'build-and-commit must have an `arch` step');
  assert.match(step[1], /agents: "\{\{config\.review\.arch_agents\}\}"/, 'it must use the configured arch agents, not a hardcoded one');
  assert.match(step[1], /kind: adversarial/);
  assert.match(step[1], /mode: "\{\{config\.review\.arch_mode\}\}"/);

  // After the defect panel, before the text review: the adversary writes the arch_gist and
  // arch_questions the owner reads at pre-pr, so it must run before the artifact is built.
  const ids = [...src.matchAll(/^ {2}- id: (\S+)/gm)].map((m) => m[1]);
  assert.ok(ids.indexOf('arch') > ids.indexOf('review'), 'the arch pass reads the panel findings');
  assert.ok(ids.indexOf('arch') < ids.indexOf('pre-pr'), 'the arch pass feeds the artifact');
});

// This project's own config is private-plane: scripts/publish.sh leaves process/ out of the public
// tree (PRIVATE_ALLOW in scripts/denylist-patterns.sh). Where it is absent there is nothing to guard.
const PROJECT_CONFIG = path.resolve(__dirname, '../process/config/punchlist.yaml');
test('arch_mode is set in project config — an unset one would silently become a hold', { skip: !fs.existsSync(PROJECT_CONFIG) && 'no project config in this tree' }, () => {
  // spine.js gateModeFallback returns `banner` only for a key matching /(writing|prose)_mode$/
  // and `hard` for everything else, so deleting this key does not disable the gate: it
  // promotes an advisory pass to one that holds every card. Asserted here because the
  // failure is a stuck run, not an error.
  const cfg = fs.readFileSync(PROJECT_CONFIG, 'utf8');
  assert.match(cfg, /^\s+arch_mode:\s+banner\s*$/m);
  assert.match(cfg, /^\s+arch_agents:\s+\[arch-adversary\]\s*$/m);
});

test('the pre-commit summary has the slots the arch pass writes into', () => {
  // A step that produces findings with nowhere to put them is a step whose output the
  // owner never sees. arch_questions is optional BUT documented as a claim: absent means
  // none are open, which is only honest if the template says so.
  const t = fs.readFileSync(path.resolve(__dirname, '../templates/packs/core/pre-commit-summary.md'), 'utf8');
  assert.match(t, /<!-- slot:arch_gist required -->/);
  assert.match(t, /<!-- slot:arch_questions -->/);
  assert.match(t, /<!-- slot:overview required -->/);
  assert.match(t, /write "none" rather than omitting the slot/);
});

test('the two cycles settle a merge conflict in different places, and the ship pack says why', () => {
  // The question this pins. `build-and-commit`'s merge declares `outcomes: [merged, conflict]` +
  // `repeat_until: merged`; `build-and-ship`'s declares neither, which reads like an omission and
  // makes `plt card rebase <effort>/<card>` look unreachable from the default cycle. It is not an
  // omission. The PR cycle settles a conflict on `resync`, and it settles it by MERGING origin/main
  // — a pushed branch under review cannot be rewritten. `plt card rebase` rewrites every commit and
  // lib/rebase.js never pushes, so it is the commit cycle's remedy and only that. Copying the
  // conflict outcome onto the ship pack would declare an outcome nothing can settle: `land_on` means
  // `plt run poll` finishes that step, and spine.landRun uses the `land_on` outcome alone.
  const dir = path.resolve(__dirname, '../workflows/packs/core');
  const ship = fs.readFileSync(path.join(dir, 'build-and-ship.md'), 'utf8');
  const commit = fs.readFileSync(path.join(dir, 'build-and-commit.md'), 'utf8');
  const lines = (src) => src.split('\n');
  const stepBlock = (src, id) => {
    const ls = lines(src);
    const i = ls.indexOf(`  - id: ${id}`);
    assert.notEqual(i, -1, `${id} missing`);
    const rest = ls.slice(i + 1);
    const end = rest.findIndex((l) => /^ {2}(?:- id:|#)/.test(l));
    return rest.slice(0, end === -1 ? undefined : end).join('\n');
  };
  const commentAbove = (src, id) => {
    const ls = lines(src);
    const i = ls.indexOf(`  - id: ${id}`);
    assert.notEqual(i, -1, `${id} missing`);
    const out = [];
    for (let j = i - 1; j >= 0 && /^ {2}#/.test(ls[j]); j--) out.unshift(ls[j]);
    return out.join('\n');
  };

  // Exactly one of the two packs declares the conflict outcome, and it is the commit cycle's.
  assert.match(stepBlock(commit, 'merge'), /outcomes: \[merged, conflict\]/);
  assert.doesNotMatch(stepBlock(ship, 'merge'), /^\s*outcomes:/m,
    'build-and-ship\'s merge is settled by `plt run poll` through land_on; an outcome declared here has no caller — the conflict path on this cycle is the `resync` step');
  assert.doesNotMatch(stepBlock(ship, 'merge'), /^\s*repeat_until:/m,
    'a repeat_until on a land_on step would loop a step no agent ever runs');
  assert.match(stepBlock(ship, 'merge'), /land_on: \{ gh: state, equals: MERGED \}/);
  assert.doesNotMatch(stepBlock(commit, 'merge'), /^\s*land_on:/m,
    'the commit cycle has no PR to poll, so its merge cannot be settled by a gh fact');

  // The PR-side conflict path: armed by a live fact, settling as its own outcome. No repeat_until —
  // spine.pollRun re-arms an arm_on step that already settled (test/spine.test.js pins that), so a
  // second conflict re-opens resync by itself.
  const resync = stepBlock(ship, 'resync');
  assert.match(resync, /arm_on: \{ gh: mergeStateStatus, equals: DIRTY \}/);
  assert.match(resync, /outcomes: \[resynced\]/);
  assert.doesNotMatch(resync, /^\s*repeat_until:/m);
  assert.ok(!lines(commit).includes('  - id: resync'), 'a commit-review cycle has no PR to go DIRTY');

  // The repair differs, and the ship pack must keep saying so: merge main in, never rewrite.
  assert.match(commentAbove(ship, 'resync'), /never rebase or force-push/);

  // And the merge step must carry the reasoning, because its ABSENCE of an outcome is what reads
  // wrong. A reader who finds the conflict outcome on one pack and not the other has to be told
  // where the other one put it, or the next card adds a dead outcome here.
  const why = commentAbove(ship, 'merge');
  assert.match(why, /No `conflict` outcome here, and that is deliberate/);
  assert.match(why, /`resync`/, 'it must name where the conflict path actually is');
  assert.match(why, /plt card rebase/, 'and name the repair that belongs to the other cycle');

  // The REASON has to be right, not just the conclusion. A comment whose reason is wrong is worth
  // less than no comment: it stops the next reader checking. Three corrections an adversarial
  // review drove out of the first version of this paragraph, each pinned so it cannot come back.
  //
  // (a) "No agent runs this step" was false. `settle` marks merge ready when pr-loop approves,
  //     `nextCommand` proposes `plt step start merge`, and `stepStart` has no `land_on` guard — the
  //     reviewer drove all three by hand. What refuses a `conflict` finish is `stepFinish` running
  //     `gateCheck`: this step requires `verify.gh: [merged]` and a jira `on_done`, and a conflict
  //     cannot prove the card merged.
  assert.doesNotMatch(why, /No agent runs this step/,
    'an agent can start this step by hand — stepStart has no land_on guard; the receipts are what refuse a conflict finish');
  assert.match(why, /RECEIPTS make `conflict` unsettleable/);
  assert.match(why, /stepFinish/);

  // (b) "landRun settles it with the land_on outcome only" was inexact: spine.js:1281 falls back
  //     `land_on.outcome || repeat_until || outcomes[0] || 'done'`. With the card's change applied
  //     landRun would record `merged`, so only `conflict` is dead. The claim must say which.
  assert.match(why, /only `conflict` would be dead/);
  assert.doesNotMatch(why, /land_on outcome only/,
    'landRun falls back through repeat_until and outcomes[0]; name the outcome that is actually dead');

  // (c) The first version cited lib/render.js as CORROBORATION — "a DIRTY PR and a merge step
  //     settled conflict raise the same need". Read properly, render.js:478 offers `plt card rebase`
  //     for a DIRTY PULL REQUEST, and that entry is reachable only from this cycle, while
  //     render.js:704 says the resync step merges it back. The board contradicts this pack; it does
  //     not corroborate it. Certifying the contradiction as settled intent would hide a real gap,
  //     so the pack records it as open.
  assert.match(why, /UNRESOLVED/, 'the render.js contradiction is open, not settled intent');
  assert.match(why, /lib\/render\.js/);
  assert.doesNotMatch(why, /raise the same/,
    'render.js does not corroborate this pack — it routes a DIRTY PR card at the repair this pack forbids');
});
