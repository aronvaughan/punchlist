'use strict';
// JSON Schemas for every spine file. One entry point (`validateObject`) carries every caller, so a
// later change of validation engine touches lib/schemas.js and nothing else.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const s = require('../lib/schemas');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'spine');

// The state/inputs/effort files this repo ships. Config fixtures are excluded on purpose: a config
// is an overlay, and a partial overlay is legal on its own (only the merged config must be whole).
function shippedFixtureFiles() {
  const out = [];
  const efforts = path.join(FIXTURES, 'efforts');
  if (fs.existsSync(efforts)) {
    for (const f of fs.readdirSync(efforts)) if (f.endsWith('.yaml') || f.endsWith('.yml')) out.push(path.join(efforts, f));
  }
  const runs = path.join(FIXTURES, 'runs');
  if (fs.existsSync(runs)) {
    for (const d of fs.readdirSync(runs)) {
      for (const f of ['state.yaml', 'inputs.yaml']) {
        const p = path.join(runs, d, f);
        if (fs.existsSync(p)) out.push(p);
      }
    }
  }
  return out;
}

function kindOf(file) {
  const base = path.basename(file);
  if (base === 'state.yaml') return 'state';
  if (base === 'inputs.yaml') return 'inputs';
  return 'effort';
}

function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-schemas-'));
  test.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const GOOD_EVENT = { id: 'e000001', ts: '2026-09-25T00:00:00Z', run: 'TRK-10', kind: 'skill', name: 'x' };
const GOOD_STATE = { run: 'TRK-10', cycle: 'build-and-ship', status: 'open', steps: { build: { status: 'ready' } } };
const GOOD_CONFIG = { models: { default_model: 'opus' }, actors: { humans: ['a'] }, gates: { human_signals: [] } };

// ---------------------------------------------------------------- the five schema files

test('the five schemas load and every one is draft 2020-12', () => {
  const all = s.loadSchemas();
  assert.deepStrictEqual(Object.keys(all).sort(), ['config', 'effort', 'event', 'inputs', 'state']);
  for (const [kind, sc] of Object.entries(all)) {
    assert.strictEqual(sc.$schema, 'https://json-schema.org/draft/2020-12/schema', kind);
  }
});

test('every kind compiles to a validator', () => {
  const v = s.validators();
  for (const kind of ['state', 'event', 'inputs', 'effort', 'config']) assert.strictEqual(typeof v[kind], 'function', kind);
});

test('an unknown kind is refused by name, not by a silent pass', () => {
  assert.throws(() => s.validateObject('vibes', {}), /vibes/);
});

// ---------------------------------------------------------------- event

test('event: an unknown kind fails, a known one passes', () => {
  assert.strictEqual(s.validateObject('event', GOOD_EVENT).ok, true);
  const bad = s.validateObject('event', { id: 'e000001', ts: '2026-09-25T00:00:00Z', run: 'TRK-10', kind: 'vibes' });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.errors[0].path, /^\/kind$/);
});

test('event: a malformed id fails on /id', () => {
  const bad = s.validateObject('event', { id: '1', ts: '2026-09-25T00:00:00Z', run: 'TRK-10', kind: 'skill' });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.errors.map((e) => e.path).join(' '), /\/id/);
});

test('event: every kind the ledger writes is in the enum', () => {
  const kinds = s.loadSchemas().event.properties.kind.enum;
  // Pinned as an exact list on purpose: adding a kind is a deliberate act, and this
  // test is where it gets declared. The last six are the EFFORT ledger's vocabulary
  // (lib/effort-events.js); they share this enum because lib/spine.js reads exactly
  // `properties.kind.enum` to decide what any writer may append.
  assert.deepStrictEqual(kinds, ['skill', 'agent', 'tool', 'gate', 'jira', 'artifact', 'gh', 'extrapolation',
    'time', 'suggestion', 'reprompt', 'file', 'touches', 'review-activity', 'decision', 'question', 'answer',
    'ask', 'escalation', 'blocked', 'wave', 'epoch', 'pane']);
});

test('event: a line belongs to exactly one ledger — run or effort, never both, never neither', () => {
  const base = { id: 'e000001', ts: '2026-09-25T00:00:00Z' };
  const run = { ...base, kind: 'skill', run: 'TRK-10' };
  // An effort line carries its own vocabulary AND its own required fields: `who`
  // answers who decided, `gate_epoch` says which review it belongs to. A line
  // missing either is a decision that cannot be attributed or cannot be reviewed.
  const effort = { ...base, kind: 'decision', effort: 'greenhouse', who: 'brain', gate_epoch: 0 };
  assert.strictEqual(s.validateObject('event', run).ok, true);
  assert.strictEqual(s.validateObject('event', effort).ok, true);
  assert.strictEqual(s.validateObject('event', { ...run, effort: 'greenhouse' }).ok, false, 'both');
  assert.strictEqual(s.validateObject('event', { ...base, kind: 'skill' }).ok, false, 'neither');
  assert.strictEqual(s.validateObject('event', { ...run, who: 'brain' }).ok, false, 'who on a run line');
  assert.strictEqual(s.validateObject('event', { ...effort, kind: 'skill' }).ok, false, 'a run kind on an effort line');
});

test('event: a pin without a value fails; sha/tree pass', () => {
  assert.strictEqual(s.validateObject('event', { ...GOOD_EVENT, pin: { kind: 'sha', value: 'abc' } }).ok, true);
  assert.strictEqual(s.validateObject('event', { ...GOOD_EVENT, pin: { kind: 'tree', value: 'abc' } }).ok, true);
  const bad = s.validateObject('event', { ...GOOD_EVENT, pin: { kind: 'sha' } });
  assert.strictEqual(bad.ok, false);
});

test('event: the ledger tolerates a newer writer (unknown keys pass)', () => {
  assert.strictEqual(s.validateObject('event', { ...GOOD_EVENT, invented_next_year: true }).ok, true);
});

test('event: a ts that is not a timestamp fails on /ts (the format is checked, not just declared)', () => {
  assert.strictEqual(s.validateObject('event', { ...GOOD_EVENT, ts: '2026-09-25T00:00:00.123Z' }).ok, true);
  assert.strictEqual(s.validateObject('event', { ...GOOD_EVENT, ts: '2026-09-25T00:00:00+01:00' }).ok, true);
  const bad = s.validateObject('event', { ...GOOD_EVENT, ts: 'yesterday' });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.errors.map((e) => e.path).join(' '), /\/ts/);
});

test('event: an actor outside the enum fails on /actor', () => {
  const bad = s.validateObject('event', { ...GOOD_EVENT, actor: 'robot' });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.errors.map((e) => e.path).join(' '), /\/actor/);
});

// ---------------------------------------------------------------- state

test('state: a step status outside the enum fails', () => {
  const bad = s.validateObject('state', { run: 'TRK-10', cycle: 'build-and-ship', status: 'open', steps: { build: { status: 'wip' } } });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.errors[0].path, /^\/steps\/build\/status$/);
});

test('state: an unknown top-level key fails (plt-only file)', () => {
  assert.strictEqual(s.validateObject('state', { run: 'TRK-10', cycle: 'c', status: 'open', steps: {}, scratch: 1 }).ok, false);
});

test('state: an unknown key is named by path, one line per key', () => {
  const bad = s.validateObject('state', { ...GOOD_STATE, scratch: 1, notes: 2 });
  assert.strictEqual(bad.ok, false);
  assert.deepStrictEqual(bad.errors.map((e) => e.path).sort(), ['/notes', '/scratch']);
});

test('state: every step status in STATE_ENUM passes, and `claimed` (never written) does not', () => {
  for (const st of require('../lib/spine').STATE_ENUM) {
    assert.strictEqual(s.validateObject('state', { ...GOOD_STATE, steps: { build: { status: st } } }).ok, true, st);
  }
  assert.strictEqual(s.validateObject('state', { ...GOOD_STATE, steps: { build: { status: 'claimed' } } }).ok, false);
});

test('state: a missing required key names itself', () => {
  const bad = s.validateObject('state', { run: 'TRK-10', cycle: 'c', steps: {} });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.errors.map((e) => e.message).join(' '), /status/);
});

test('state: closed_as is done or discarded', () => {
  assert.strictEqual(s.validateObject('state', { ...GOOD_STATE, status: 'closed', closed_as: 'discarded' }).ok, true);
  assert.strictEqual(s.validateObject('state', { ...GOOD_STATE, status: 'closed', closed_as: 'abandoned' }).ok, false);
});

test('state: a receipt requirement carries a kind from the event enum', () => {
  const ok = s.validateObject('state', { ...GOOD_STATE, steps: { build: { status: 'ready', receipts_required: [{ kind: 'agent', name: 'reviewer' }] } } });
  assert.strictEqual(ok.ok, true);
  const bad = s.validateObject('state', { ...GOOD_STATE, steps: { build: { status: 'ready', receipts_required: [{ kind: 'vibes', name: 'reviewer' }] } } });
  assert.strictEqual(bad.ok, false);
});

// ---------------------------------------------------------------- inputs

test('inputs: a card run and a PR run are both whole; pr takes the number or the URL', () => {
  assert.strictEqual(s.validateObject('inputs', { card: 'TRK-10' }).ok, true);
  assert.strictEqual(s.validateObject('inputs', { effort: 'greenhouse' }).ok, true);
  assert.strictEqual(s.validateObject('inputs', { card: 'TRK-10', pr: 42 }).ok, true);
  assert.strictEqual(s.validateObject('inputs', { card: 'TRK-10', pr: 'https://github.test/o/r/pull/42' }).ok, true);
  assert.strictEqual(s.validateObject('inputs', { card: 42 }).ok, false);
});

test('inputs: merge is auto or human, and an unknown key fails', () => {
  assert.strictEqual(s.validateObject('inputs', { card: 'TRK-10', merge: 'auto' }).ok, true);
  assert.strictEqual(s.validateObject('inputs', { card: 'TRK-10', merge: 'maybe' }).ok, false);
  assert.strictEqual(s.validateObject('inputs', { card: 'TRK-10', scratch: 1 }).ok, false);
});

// ---------------------------------------------------------------- effort

test('effort: a card is a bare id string or a mapping with an id', () => {
  assert.strictEqual(s.validateObject('effort', { slug: 'greenhouse', title: 'T', cards: ['TRK-10', { id: 'TRK-11', estimate: 1.5 }] }).ok, true);
  const bad = s.validateObject('effort', { slug: 'greenhouse', title: 'T', cards: [{ title: 'no id' }] });
  assert.strictEqual(bad.ok, false);
});

test('effort: a card id with a space fails', () => {
  assert.strictEqual(s.validateObject('effort', { slug: 'g', title: 'T', cards: [{ id: 'TRK 10' }] }).ok, false);
});

test('effort: dropped takes a bare id or a reason mapping', () => {
  assert.strictEqual(s.validateObject('effort', { slug: 'g', title: 'T', cards: [], dropped: ['TRK-9', { id: 'TRK-8', reason: 'folded in', replaced_by: 'TRK-10' }] }).ok, true);
});

// ---------------------------------------------------------------- config

test('config: timers.watch.every must parse as a duration', () => {
  assert.strictEqual(s.validateObject('config', { models: { default_model: 'opus' }, actors: { humans: ['a'] }, gates: { human_signals: [] }, timers: { watch: { every: 'soon' } } }).ok, false);
  assert.strictEqual(s.validateObject('config', { ...GOOD_CONFIG, timers: { watch: { every: '10m' } } }).ok, true);
});

test('config: the keys read without a default are required', () => {
  assert.strictEqual(s.validateObject('config', GOOD_CONFIG).ok, true);
  assert.strictEqual(s.validateObject('config', { actors: { humans: ['a'] }, gates: { human_signals: [] } }).ok, false);
  // actors.humans is NOT one of them: assertHuman returns early on an empty or absent list.
  assert.strictEqual(s.validateObject('config', { ...GOOD_CONFIG, actors: { humans: [] } }).ok, true);
});

test('config: lenient by intent — an unknown key passes', () => {
  assert.strictEqual(s.validateObject('config', { ...GOOD_CONFIG, invented: { deeply: true } }).ok, true);
});

test('config: links.pr_repo must look like owner/repo, panel_mode is hard or banner', () => {
  assert.strictEqual(s.validateObject('config', { ...GOOD_CONFIG, links: { pr_repo: 'example-org/greenhouse' } }).ok, true);
  assert.strictEqual(s.validateObject('config', { ...GOOD_CONFIG, links: { pr_repo: 'https://example.test/o/r' } }).ok, false);
  assert.strictEqual(s.validateObject('config', { ...GOOD_CONFIG, review: { panel_mode: 'banner', writing_mode: 'hard' } }).ok, true);
  assert.strictEqual(s.validateObject('config', { ...GOOD_CONFIG, review: { panel_mode: 'loud' } }).ok, false);
});

// ---------------------------------------------------------------- validateFile

test('every shipped fixture state/inputs/effort validates', () => {
  const files = shippedFixtureFiles();
  assert.ok(files.length > 0, 'no shipped fixtures found under test/fixtures/spine');
  for (const f of files) assert.strictEqual(s.validateFile(kindOf(f), f).ok, true, f + ': ' + JSON.stringify(s.validateFile(kindOf(f), f).errors));
});

test('validateFile reads YAML for a state file and reports the failing path', () => {
  const d = tmpdir();
  const f = path.join(d, 'state.yaml');
  fs.writeFileSync(f, 'run: TRK-10\ncycle: build-and-ship\nstatus: open\nsteps:\n  build:\n    status: wip\n');
  const r = s.validateFile('state', f);
  assert.strictEqual(r.ok, false);
  assert.match(r.errors[0].path, /^\/steps\/build\/status$/);
});

test('validateFile validates a .jsonl ledger one line at a time, prefixing the line number', () => {
  const d = tmpdir();
  const f = path.join(d, 'events.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify(GOOD_EVENT),
    JSON.stringify({ ...GOOD_EVENT, id: 'e000002', kind: 'vibes' }),
    '',
  ].join('\n'));
  const r = s.validateFile('event', f);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].path, /^line 2 \/kind$/);
});

test('validateFile on a clean ledger is ok with no errors', () => {
  const d = tmpdir();
  const f = path.join(d, 'events.jsonl');
  fs.writeFileSync(f, JSON.stringify(GOOD_EVENT) + '\n');
  assert.deepStrictEqual(s.validateFile('event', f), { ok: true, errors: [], warnings: [] });
});

test('validateFile names a line that is not JSON at all', () => {
  const d = tmpdir();
  const f = path.join(d, 'events.jsonl');
  fs.writeFileSync(f, '{not json\n');
  const r = s.validateFile('event', f);
  assert.strictEqual(r.ok, false);
  assert.match(r.errors[0].path, /^line 1$/);
});

// ---------------------------------------------------------------- the CLI surface

test('commands exports one schema command with its usage and handler', () => {
  assert.strictEqual(s.commands.length, 1);
  const [c] = s.commands;
  assert.strictEqual(c.name, 'schema');
  assert.strictEqual(c.usage, 'plt schema list | plt schema validate <kind> <file>');
  assert.strictEqual(typeof c.handler, 'function');
});

test('plt schema list prints the five kinds and their file paths', () => {
  const out = [];
  const code = s.schemaHandler(['list'], { write: (t) => out.push(t) });
  assert.strictEqual(code, 0);
  const text = out.join('');
  for (const kind of ['state', 'event', 'inputs', 'effort', 'config']) {
    assert.match(text, new RegExp(`^${kind}\\s+.*${kind}\\.schema\\.json$`, 'm'));
    assert.ok(fs.existsSync(path.join(ROOT, 'schemas', `${kind}.schema.json`)), kind);
  }
});

test('plt schema validate exits 0 on a good file and 1 with one line per error', () => {
  const d = tmpdir();
  const good = path.join(d, 'good.yaml');
  fs.writeFileSync(good, 'run: TRK-10\ncycle: c\nstatus: open\nsteps: {}\n');
  const okOut = [];
  assert.strictEqual(s.schemaHandler(['validate', 'state', good], { write: (t) => okOut.push(t) }), 0);

  const bad = path.join(d, 'bad.yaml');
  fs.writeFileSync(bad, 'run: TRK-10\ncycle: c\nstatus: open\nsteps:\n  build:\n    status: wip\n');
  const badOut = [];
  assert.strictEqual(s.schemaHandler(['validate', 'state', bad], { write: (t) => badOut.push(t), error: (t) => badOut.push(t) }), 1);
  assert.match(badOut.join(''), /^\/steps\/build\/status: .+$/m);
});

test('plt schema validate refuses an unknown kind and a missing file with usage, not a stack', () => {
  const err = [];
  const io = { write: (t) => err.push(t), error: (t) => err.push(t) };
  assert.strictEqual(s.schemaHandler([], io), 2);
  assert.strictEqual(s.schemaHandler(['validate', 'vibes', 'x.yaml'], io), 2);
  assert.strictEqual(s.schemaHandler(['validate', 'state', path.join(tmpdir(), 'absent.yaml')], io), 2);
  assert.match(err.join(''), /plt schema list \| plt schema validate <kind> <file>/);
});

// ---------------------------------------------------------------- reconciled against live runs
//
// Every shape below was taken from the 12 live runs under a real umbrella's process/runs/, where
// the five schemas shipped in c78ea12 raised 820 errors while fsck reported no parse, truncation,
// id, pin, orphan or unknown-step problem at all. A schema states what the code writes today: each
// of these is what a writer in lib/spine.js actually emits.
// See .superpowers/sdd/2026-09-25-plan-3/schema-reconciliation.md for the per-field decisions.

test('state: the keys launchRun, pollRun and closeRun write are all declared', () => {
  const live = {
    ...GOOD_STATE,
    formula_version: '3',
    repo_dir: '/tmp/r',
    owner: 'agent',
    created: '2026-09-15T11:06:49.510Z',
    estimate: { unit: 'ideal_days', value: 0.5 },
    pin: { kind: 'sha', value: 'abc', tree: 'def' },
    current_step: 'scope',
    poll: { at: '2026-09-16T10:00:00.000Z', facts: { pr_state: 'OPEN' } },
    status: 'closed',
    closed: '2026-09-16T10:38:54.149Z',
    closed_as: 'done',
    owner_window: 'w1',
    exit: 'discard',
    facts: { a: 1 },
  };
  const r = s.validateObject('state', live);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('state: estimate is the {unit, value} pair launchRun writes, never a bare number', () => {
  assert.strictEqual(s.validateObject('state', { ...GOOD_STATE, estimate: { unit: 'ideal_days', value: 0.75 } }).ok, true);
  assert.strictEqual(s.validateObject('state', { ...GOOD_STATE, estimate: null }).ok, true);
  assert.strictEqual(s.validateObject('state', { ...GOOD_STATE, estimate: 0.75 }).ok, false);
  assert.strictEqual(s.validateObject('state', { ...GOOD_STATE, estimate: { value: 0.75 } }).ok, false);
});

test('state: a requirement kind is the event vocabulary PLUS overlap and effort', () => {
  // compileRequirements emits these two; neither is ever a ledger event, because both are
  // evaluated live at gateCheck rather than satisfied by a receipt.
  for (const kind of ['overlap', 'effort', 'touches', 'gh', 'jira']) {
    const r = s.validateObject('state', { ...GOOD_STATE, steps: { build: { status: 'ready', receipts_required: [{ kind, name: 'x' }] } } });
    assert.strictEqual(r.ok, true, kind + ': ' + JSON.stringify(r.errors));
  }
  assert.strictEqual(s.loadSchemas().event.properties.kind.enum.includes('overlap'), false);
});

test('state: an adversarial gate requirement carries its mode', () => {
  assert.strictEqual(s.validateObject('state', { ...GOOD_STATE, steps: { review: { status: 'ready', receipts_required: [{ kind: 'agent', name: 'a', mode: 'banner' }] } } }).ok, true);
});

test('inputs: every key the 12 live runs carry is declared, and the list stays closed', () => {
  const live = {
    card: 'TRK-2836', card_url: 'https://tracker.example/TRK-2836', title: 'a card',
    effort: 'greenhouse', epic: 'TRK-602', repo_dir: '/tmp/r', branch: 'feat/x',
    pr: 'https://github.test/o/r/pull/1222', pr_number: 1222,
    author: 'someone', base: 'main', head: 'feat/x',
    verify: ['a'], refuse: ['b'], touches: ['lib/'], comparable: 'TRK-2835',
    review_note: 'n', arch_note: 'n', stacked_on: 'TRK-2835', follow_on: 'TRK-2900',
    question: 'q?', decision_id: 'D-014', after: ['TRK-2835'],
    merge: 'human', cycle: 'build-and-ship', estimate: 0.5, vars: { a: 1 },
    window: { tab_id: 't', pane_id: 'p', label: 'l' },
  };
  const r = s.validateObject('inputs', live);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(s.validateObject('inputs', { ...live, sratch: 1 }).ok, false);
});

test('inputs: `repo` is declared as owner/name, and a bare name or a URL is refused', () => {
  assert.strictEqual(s.validateObject('inputs', { card: 'TRK-10', repo: 'o/r' }).ok, true);
  assert.strictEqual(s.validateObject('inputs', { card: 'TRK-10', repo: 'r' }).ok, false);
  assert.strictEqual(s.validateObject('inputs', { card: 'TRK-10', repo: 'https://github.test/o/r' }).ok, false);
});

// Seam: every `inputs.<key>` lib/facts.js reads is a property of inputs.schema.json, so a key the
// code starts reading can never be one the schema rejects on the live runs that carry it.
test('inputs: every key lib/facts.js reads from inputs is declared in the schema', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'facts.js'), 'utf8');
  const read = [...new Set([...src.matchAll(/\binputs\.([A-Za-z_]+)/g)].map((m) => m[1]))];
  assert.ok(read.includes('repo') && read.includes('pr'), `found ${read}`);
  const declared = Object.keys(s.loadSchemas().inputs.properties);
  for (const k of read) assert.ok(declared.includes(k), `lib/facts.js reads inputs.${k}; inputs.schema.json does not declare it`);
});

test('inputs: a review run carries a pr and no card', () => {
  assert.strictEqual(s.validateObject('inputs', { title: 'PR 1222', pr: 'https://github.test/o/r/pull/1222', pr_number: 1222 }).ok, true);
});

test('inputs: pr is the number or the URL, because three readers accept either', () => {
  assert.strictEqual(s.validateObject('inputs', { pr: 1244 }).ok, true);
  assert.strictEqual(s.validateObject('inputs', { pr: 'https://github.test/o/r/pull/1222' }).ok, true);
  assert.strictEqual(s.validateObject('inputs', { pr: { n: 1 } }).ok, false);
});

test('event: a pin is what computePin writes — sha+tree, or tree+base_sha, or none at all', () => {
  assert.strictEqual(s.validateObject('event', { ...GOOD_EVENT, pin: { kind: 'sha', value: 'a', tree: 'b' } }).ok, true);
  assert.strictEqual(s.validateObject('event', { ...GOOD_EVENT, pin: { kind: 'tree', value: 'a', base_sha: 'b' } }).ok, true);
  assert.strictEqual(s.validateObject('event', { ...GOOD_EVENT, pin: null }).ok, true);
  assert.strictEqual(s.validateObject('event', { ...GOOD_EVENT, pin: { kind: 'commit', value: 'a' } }).ok, false);
});

test('event: result is free text — approve, revoke and a review round summary all pass', () => {
  for (const result of ['pass', 'skip', 'approve', 'revoke', 'round 2: all 10 prior findings addressed']) {
    assert.strictEqual(s.validateObject('event', { ...GOOD_EVENT, result }).ok, true, result);
  }
  assert.strictEqual(s.validateObject('event', { ...GOOD_EVENT, result: 7 }).ok, false);
});

test('config: actors.humans is optional — the shipped public defaults carry no names', () => {
  const noHumans = { models: { default_model: 'opus' }, gates: { human_signals: [] } };
  assert.strictEqual(s.validateObject('config', noHumans).ok, true);
  assert.strictEqual(s.validateObject('config', { ...noHumans, actors: { github_logins: [] } }).ok, true);
  assert.strictEqual(s.validateObject('config', { ...noHumans, actors: { humans: 'me' } }).ok, false);
});

test('the shipped public defaults validate as a config', () => {
  const f = path.join(FIXTURES, 'config', 'defaults.yaml');
  assert.ok(fs.existsSync(f), f);
  const r = s.validateFile('config', f);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

// Event ledgers are append-only, so an event written before the writer fix (fa0beaa) that fails the
// schema is a warning; one written after it is held strictly.
test('validateFile: a bad event written before the writer fix is a warning; after it, an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schemas-legacy-'));
  const before = { id: 'e000001', ts: '2026-09-17T20:11:57.618Z', run: 'TRK-1', kind: 'time', what: 'closed', step: null, actor: 'someone', pin: null };
  const after = { ...before, id: 'e000002', ts: '2026-09-25T09:00:00.000Z' };
  const f1 = path.join(dir, 'a.jsonl'); fs.writeFileSync(f1, JSON.stringify(before) + '\n');
  const r1 = s.validateFile('event', f1);
  assert.strictEqual(r1.ok, true, JSON.stringify(r1.errors));
  assert.strictEqual(r1.warnings.length, 1);
  assert.match(r1.warnings[0].path, /^line 1/);
  const f2 = path.join(dir, 'b.jsonl'); fs.writeFileSync(f2, JSON.stringify(before) + '\n' + JSON.stringify(after) + '\n');
  const r2 = s.validateFile('event', f2);
  assert.strictEqual(r2.ok, false);
  assert.match(r2.errors[0].path, /^line 2/);
});

test('isLegacyEvent: before the writer fix only; a missing or unreadable ts is never legacy', () => {
  assert.strictEqual(s.EVENT_WRITER_FIX_TS, '2026-09-24T18:05:36Z');
  assert.strictEqual(s.isLegacyEvent({ ts: '2026-09-24T18:05:35.999Z' }), true);
  assert.strictEqual(s.isLegacyEvent({ ts: '2026-09-24T18:05:36Z' }), false);
  assert.strictEqual(s.isLegacyEvent({}), false);
  assert.strictEqual(s.isLegacyEvent({ ts: 'yesterday' }), false);
});
