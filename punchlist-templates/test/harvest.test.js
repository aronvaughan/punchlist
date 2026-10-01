'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const harvest = require('../lib/harvest');

const FIX = path.join(__dirname, 'fixtures', 'spine');

// Every git call in these tests runs against a throwaway repo under os.tmpdir() — never against a
// working checkout. `exec` is the seam harvestRow calls: it records the command and then runs it.
function recordingExec() {
  const exec = (repoDir, args) => {
    exec.calls.push(['git', '-C', repoDir, ...args].join(' '));
    return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
  };
  exec.calls = [];
  return exec;
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  return dir;
}

function commitAll(dir, msg) {
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', msg]);
}

const TEMPLATE_WITH_SLOTS = [
  '---',
  'name: pre-pr-summary',
  'kind: template',
  'version: 1',
  '---',
  '',
  '# Pre-PR summary',
  '',
  '<!-- slot:meta required source=state -->',
  'Card · branch · pin.',
  '<!-- /slot -->',
  '<!-- slot:risks -->',
  'What could go wrong on merge.',
  '<!-- /slot -->',
  '',
].join('\n');

// A fresh pair of throwaway repos: an umbrella (private plane) holding process/, and a templates
// checkout (public plane) holding config/defaults.yaml, the core formula pack and the core
// template pack. `overlay: true` gives the umbrella its own copy of the formula, which is what
// makes a formula target private.
function setup({ overlay = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-'));
  const umbrella = initRepo(path.join(root, 'umbrella'));
  const templates = initRepo(path.join(root, 'templates'));

  const P = path.join(umbrella, 'process');
  fs.mkdirSync(path.join(P, 'config'), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'suggestions', 'suggestions.md'), path.join(P, 'suggestions.md'));
  fs.writeFileSync(path.join(P, 'config', 'greenhouse.yaml'), 'org: greenhouse\nnotify:\n  channel: ""\n');
  if (overlay) {
    fs.mkdirSync(path.join(P, 'cycles'), { recursive: true });
    fs.copyFileSync(path.join(FIX, 'cycles', 'build-and-ship.md'), path.join(P, 'cycles', 'build-and-ship.md'));
  }
  commitAll(umbrella, 'init');

  fs.mkdirSync(path.join(templates, 'config'), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'config', 'defaults.yaml'), path.join(templates, 'config', 'defaults.yaml'));
  fs.mkdirSync(path.join(templates, 'workflows', 'packs', 'core'), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'cycles', 'build-and-ship.md'), path.join(templates, 'workflows', 'packs', 'core', 'build-and-ship.md'));
  fs.mkdirSync(path.join(templates, 'templates', 'packs', 'core'), { recursive: true });
  fs.writeFileSync(path.join(templates, 'templates', 'packs', 'core', 'pre-pr-summary.md'), TEMPLATE_WITH_SLOTS);
  commitAll(templates, 'init');

  return { root, umbrella, templates, P, exec: recordingExec() };
}

test('readSuggestions parses the table and marks an unparseable target', () => {
  const { P } = setup();
  const rows = harvest.readSuggestions(P);
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(rows[0].runs, ['TRK-10', 'TRK-12']);
  assert.deepStrictEqual(rows[0].target, { kind: 'config', path: 'writing.banned' });
  assert.strictEqual(rows[0].count, 4);
  assert.strictEqual(rows[3].target, null);
});

test('a config key that exists in defaults is public and lands in the templates repo', () => {
  const { P, umbrella, templates, exec } = setup();
  const r = harvest.harvestRow(P, 'S-001', { repoDir: umbrella, templatesDir: templates, exec });
  assert.strictEqual(r.plane, 'public');
  assert.strictEqual(r.repo, templates);
  assert.strictEqual(r.branch, 'harvest/S-001-reprompt-staging');
  assert.strictEqual(r.changed, true);
  assert.match(r.diff, /\+\s*banned:/);
  assert.deepStrictEqual(r.files, ['config/defaults.yaml']);
  // The umbrella was never touched: no branch of its own, still on main, still clean.
  assert.strictEqual(execFileSync('git', ['-C', umbrella, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'main');
  assert.strictEqual(execFileSync('git', ['-C', umbrella, 'status', '--porcelain'], { encoding: 'utf8' }), '');
});

test('a config key defaults does not carry is private and lands in the umbrella', () => {
  const { P, umbrella, templates, exec } = setup();
  fs.writeFileSync(path.join(P, 'suggestions.md'), [
    '| id | signal | count | runs | target | detail |',
    '| --- | --- | --- | --- | --- | --- |',
    '| S-010 | reprompt:org | 2 | TRK-10 | config:notify.channel | proposed: greenhouse-dev |',
    '',
  ].join('\n'));
  const r = harvest.harvestRow(P, 'S-010', { repoDir: umbrella, templatesDir: templates, exec });
  assert.strictEqual(r.plane, 'private');
  assert.strictEqual(r.repo, umbrella);
  assert.deepStrictEqual(r.files, ['process/config/greenhouse.yaml']);
  assert.match(r.diff, /^\+.*channel: greenhouse-dev$/m);
});

test('a formula step key change is written and nothing is merged or pushed', () => {
  const { P, umbrella, templates, exec } = setup();
  const r = harvest.harvestRow(P, 'S-003', { repoDir: umbrella, templatesDir: templates, exec });
  assert.match(r.diff, /^\+.*model: fable$/m);
  assert.strictEqual(exec.calls.some((c) => c.includes('merge') || c.includes('push')), false);
});

test('an overlay formula under process/cycles is private, the core pack copy is public', () => {
  const overlaid = setup({ overlay: true });
  const a = harvest.harvestRow(overlaid.P, 'S-003', { repoDir: overlaid.umbrella, templatesDir: overlaid.templates, exec: overlaid.exec });
  assert.strictEqual(a.plane, 'private');
  assert.deepStrictEqual(a.files, ['process/cycles/build-and-ship.md']);

  const plain = setup();
  const b = harvest.harvestRow(plain.P, 'S-003', { repoDir: plain.umbrella, templatesDir: plain.templates, exec: plain.exec });
  assert.strictEqual(b.plane, 'public');
  assert.deepStrictEqual(b.files, ['workflows/packs/core/build-and-ship.md']);
});

test('a template slot gets the comment immediately above it', () => {
  const { P, umbrella, templates, exec } = setup();
  const r = harvest.harvestRow(P, 'S-002', { repoDir: umbrella, templatesDir: templates, exec });
  assert.strictEqual(r.plane, 'public');
  assert.deepStrictEqual(r.files, ['templates/packs/core/pre-pr-summary.md']);
  assert.match(r.diff, /^\+<!-- harvest S-002: name the rollback command -->$/m);
  // The edit lives on the branch, not in the working tree — the repo is left where it started.
  const onBranch = execFileSync('git', ['-C', templates, 'show', `${r.branch}:templates/packs/core/pre-pr-summary.md`], { encoding: 'utf8' }).split('\n');
  const i = onBranch.indexOf('<!-- slot:risks -->');
  assert.strictEqual(onBranch[i - 1], '<!-- harvest S-002: name the rollback command -->');
});

test('a row with no proposed value is refused', () => {
  const { P, umbrella, templates, exec } = setup();
  assert.throws(
    () => harvest.harvestRow(P, 'S-004', { repoDir: umbrella, templatesDir: templates, exec }),
    /names no proposed value/,
  );
});

test('--dry-run computes the diff and creates no branch', () => {
  const { P, umbrella, templates, exec } = setup();
  const r = harvest.harvestRow(P, 'S-001', { repoDir: umbrella, templatesDir: templates, exec, dryRun: true });
  assert.strictEqual(r.changed, false);
  assert.match(r.diff, /\+\s*banned:/);
  assert.strictEqual(execFileSync('git', ['-C', templates, 'branch', '--list', r.branch], { encoding: 'utf8' }).trim(), '');
  assert.strictEqual(execFileSync('git', ['-C', templates, 'status', '--porcelain'], { encoding: 'utf8' }), '');
});

test('a second harvest of the same id is a no-op', () => {
  const { P, umbrella, templates, exec } = setup();
  const opts = { repoDir: umbrella, templatesDir: templates, exec };
  const first = harvest.harvestRow(P, 'S-001', opts);
  assert.strictEqual(first.changed, true);
  const second = harvest.harvestRow(P, 'S-001', opts);
  assert.strictEqual(second.changed, false);
  assert.match(second.message, /branch harvest\/S-001-reprompt-staging already exists at [0-9a-f]{7,} — nothing to do/);
});

test('harvest never merges, pushes or leaves the repo on the new branch', () => {
  const { P, umbrella, templates, exec } = setup();
  harvest.harvestRow(P, 'S-001', { repoDir: umbrella, templatesDir: templates, exec });
  assert.strictEqual(exec.calls.some((c) => /\bmerge\b|\bpush\b|\bremote\b/.test(c)), false);
  assert.strictEqual(execFileSync('git', ['-C', templates, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'main');
});

test('a dirty target file is refused before any branch, and the message names it', () => {
  const { P, umbrella, templates, exec } = setup();
  const f = path.join(templates, 'config', 'defaults.yaml');   // S-001's target
  fs.appendFileSync(f, '# a human edit in progress\n');
  assert.throws(
    () => harvest.harvestRow(P, 'S-001', { repoDir: umbrella, templatesDir: templates, exec }),
    /harvest S-001: .* has uncommitted changes to config\/defaults\.yaml; commit or stash them first/,
  );
  assert.strictEqual(exec.calls.some((c) => /checkout -b/.test(c)), false);
  assert.strictEqual(execFileSync('git', ['-C', templates, 'branch', '--list', 'harvest/*'], { encoding: 'utf8' }).trim(), '');
  assert.match(fs.readFileSync(f, 'utf8'), /a human edit in progress/);
});

test('a dirty file harvest does not write never blocks it, and stays out of the harvest commit', () => {
  const { P, umbrella, templates, exec } = setup();
  const other = path.join(templates, 'templates', 'packs', 'core', 'pre-pr-summary.md');
  fs.appendFileSync(other, '\nanother window\'s edit\n');
  const r = harvest.harvestRow(P, 'S-001', { repoDir: umbrella, templatesDir: templates, exec });
  assert.strictEqual(r.changed, true);
  const committed = execFileSync('git', ['-C', templates, 'show', '--name-only', '--format=', r.branch], { encoding: 'utf8' }).trim();
  assert.strictEqual(committed, 'config/defaults.yaml');
  assert.match(fs.readFileSync(other, 'utf8'), /another window's edit/);
});

test('a repo claimed by another window is refused before any branch', () => {
  const { P, umbrella, templates, exec } = setup();
  const repoWindow = require('../lib/repo-window');
  assert.strictEqual(repoWindow.claimRepo(templates, 'w-other').claimed, true);
  assert.throws(
    () => harvest.harvestRow(P, 'S-001', { repoDir: umbrella, templatesDir: templates, exec, window: 'w-mine' }),
    /is being driven by window w-other/,
  );
  assert.strictEqual(exec.calls.some((c) => /checkout -b/.test(c)), false);
  // The claiming window itself proceeds.
  assert.strictEqual(harvest.harvestRow(P, 'S-001', { repoDir: umbrella, templatesDir: templates, exec, window: 'w-other' }).changed, true);
});

test('bumpChangelog prepends an entry carrying expected and measure at', () => {
  const { P } = setup();
  const { entry, file } = harvest.bumpChangelog(P, {
    target: 'config:writing.banned',
    expected: 'staging re-prompts drop below 1/run',
    measureAt: '2026-10-09',
    id: 'S-001',
    now: new Date('2026-09-25T00:00:00Z'),
  });
  assert.match(entry, /^## 2026-09-25 — config:writing\.banned$/m);
  assert.match(entry, /^- from: suggestion S-001 \(4 occurrence\(s\): TRK-10, TRK-12\)$/m);
  assert.match(entry, /^- expected: staging re-prompts drop below 1\/run$/m);
  assert.match(entry, /^- measure at: 2026-10-09$/m);
  assert.strictEqual(file, path.join(P, 'CHANGELOG.md'));
  assert.match(fs.readFileSync(path.join(P, 'CHANGELOG.md'), 'utf8').split('\n')[0], /^## 2026-09-25/);
});

test('bumpChangelog prepends the newest entry above the previous one', () => {
  const { P } = setup();
  harvest.bumpChangelog(P, { target: 'config:writing.banned', expected: 'fewer re-prompts', measureAt: '2026-10-09', id: 'S-001', now: new Date('2026-09-25T00:00:00Z') });
  harvest.bumpChangelog(P, { target: 'formula:build-and-ship:review:model', expected: 'less rework', measureAt: '2026-10-16', id: 'S-003', now: new Date('2026-09-26T00:00:00Z') });
  const text = fs.readFileSync(path.join(P, 'CHANGELOG.md'), 'utf8');
  assert.ok(text.indexOf('## 2026-09-26') < text.indexOf('## 2026-09-25'), 'newest entry is first');
});

test('bumpChangelog increments the version of the formula it names', () => {
  const { P, umbrella, templates } = setup({ overlay: true });
  harvest.bumpChangelog(P, {
    target: 'formula:build-and-ship:review:model',
    expected: 'less rework', measureAt: '2026-10-16', id: 'S-003',
    now: new Date('2026-09-26T00:00:00Z'), repoDir: umbrella, templatesDir: templates,
  });
  const text = fs.readFileSync(path.join(P, 'cycles', 'build-and-ship.md'), 'utf8');
  assert.match(text, /^version: 2$/m);
});

test('the commands export names harvest and bump with their usage', () => {
  const names = harvest.commands.map((c) => c.name);
  assert.deepStrictEqual(names, ['harvest', 'bump']);
  assert.strictEqual(harvest.commands[0].usage, 'plt harvest <id> [--dry-run] [--json]');
  assert.strictEqual(harvest.commands[1].usage, 'plt bump --target <t> --expected <text> --measure-at <date> [--id <suggestion-id>]');
  for (const c of harvest.commands) assert.strictEqual(typeof c.handler, 'function');
});

// ---- the round trip: what `plt mine` writes is what `plt harvest` reads ------------------------
//
// renderMine used to emit four sectioned tables (name/key/step | count | runs | proposed target)
// and readSuggestions has always parsed one table (id | signal | count | runs | target | detail).
// Both halves were tested and neither could read the other, so the suggestion -> diff pipeline was
// broken end to end. The writer moved: `plt harvest <id>` addresses a row by a stable id, and the
// reader cannot invent an id that the writer never emitted.
test('round trip: real renderMine output parses back through real readSuggestions, ids intact', () => {
  const spine = require('../lib/spine');
  const { P } = setup();
  const m = {
    reprompts: [
      { id: 'menu:near-miss', count: 3, runs: ['TRK-10', 'TRK-12'], target: 'ignored' },
      { id: 'style', count: 2, runs: ['TRK-10'], target: 'ignored' },
    ],
    extrapolations: [{ id: 'touches-drift', count: 2, runs: ['TRK-10'], assumed: 'lib/x.js outside declared lib/y/' }],
    reapprovals: [{ id: 'approve', count: 1, runs: ['TRK-11'], cycle: 'build-and-ship' }],
    writing: [{ id: 'write-review', count: 1, total: 2, rate: 50, runs: ['TRK-12'] }],
  };
  fs.writeFileSync(path.join(P, 'suggestions.md'), spine.renderMine(m));
  const rows = harvest.readSuggestions(P);

  assert.deepStrictEqual(rows.map((r) => r.id), ['S-001', 'S-002', 'S-003', 'S-004', 'S-005']);
  // Every section survives, folded into `signal` — nothing the four tables carried is lost.
  assert.deepStrictEqual(rows.map((r) => r.signal), [
    'reprompt:menu:near-miss', 'reprompt:style', 'extrapolation:touches-drift',
    'reapproval:approve', 'writing:write-review',
  ]);
  assert.deepStrictEqual(rows.map((r) => r.count), [3, 2, 2, 1, 1]);
  assert.deepStrictEqual(rows[0].runs, ['TRK-10', 'TRK-12']);
  assert.deepStrictEqual(rows[4].runs, ['TRK-12']);

  // The harvestable targets come back parsed, in the machine form readSuggestions understands.
  assert.deepStrictEqual(rows[0].target, { kind: 'config', path: 'menu.words' });
  assert.deepStrictEqual(rows[3].target, { kind: 'formula', cycle: 'build-and-ship', step: 'approve', key: 'reapprove.rearm' });
  assert.deepStrictEqual(rows[4].target, { kind: 'config', path: 'review.writing_mode' });
  // A row plt cannot mechanically act on names no target rather than a target that is not one.
  assert.strictEqual(rows[1].target, null);
  assert.strictEqual(rows[2].target, null);

  // The detail column carries what the old per-section columns carried.
  assert.match(rows[2].detail, /lib\/x\.js outside declared lib\/y\//);
  assert.match(rows[4].detail, /1\/2/);
  assert.match(rows[4].detail, /50%/);
});

test('round trip: mine never invents a proposal, so harvest refuses the row until a human edits it', () => {
  const spine = require('../lib/spine');
  const { P } = setup();
  fs.writeFileSync(path.join(P, 'suggestions.md'), spine.renderMine({
    reprompts: [{ id: 'menu:near-miss', count: 3, runs: ['TRK-10'] }],
    extrapolations: [], reapprovals: [], writing: [],
  }));
  assert.throws(() => harvest.harvestRow(P, 'S-001', { repoDir: P, templatesDir: P, exec: recordingExec() }), /proposed/);
});

test('renderMine ids are stable: the same mine result renders the same ids', () => {
  const spine = require('../lib/spine');
  const m = {
    reprompts: [{ id: 'a', count: 2, runs: ['TRK-1'] }, { id: 'b', count: 1, runs: ['TRK-1'] }],
    extrapolations: [{ id: 'k', count: 1, runs: ['TRK-1'], assumed: 'x' }],
    reapprovals: [], writing: [],
  };
  assert.strictEqual(spine.renderMine(m), spine.renderMine(m));
  assert.match(spine.renderMine(m), /\| S-001 \| reprompt:a \|/);
  assert.match(spine.renderMine(m), /\| S-003 \| extrapolation:k \|/);
});

test('renderMine with nothing to suggest still emits the header row harvest looks for', () => {
  const spine = require('../lib/spine');
  const { P } = setup();
  fs.writeFileSync(path.join(P, 'suggestions.md'), spine.renderMine({ reprompts: [], extrapolations: [], reapprovals: [], writing: [] }));
  assert.deepStrictEqual(harvest.readSuggestions(P), []);
});
