'use strict';
// `kind: effort` — the formula that runs once per effort, above the cards (ADR-1, "The effort
// cycle"), plus the two step keys it introduces.
//
// The vocabulary matters more than it looks. `kind` was not validated at all, so `kind: effort`
// already "worked" in the sense that nothing rejected it — and so did `kind: efort`. A value that
// is tolerated rather than declared is the same failure this effort has found all day: it reads as
// supported and means nothing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateFile } = require('../lib/validate');

const DEFAULTS = path.join(__dirname, 'fixtures', 'spine', 'config', 'defaults.yaml');

// A pack on disk, parsed by the real parser — the shape validateFile actually sees.
function pack({ kind = 'effort', actors = '[brain, owner]', steps }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-effort-'));
  fs.mkdirSync(path.join(root, 'process', 'config'), { recursive: true });
  fs.copyFileSync(DEFAULTS, path.join(root, 'process', 'config', 'defaults.yaml'));
  const f = path.join(root, 'w.md');
  fs.writeFileSync(f, [
    '---', 'name: w', `kind: ${kind}`, 'version: 1', 'description: "d"',
    'domain: engineering', 'tags: [t]', `actors: ${actors}`, '---', '', '# W', '', 'steps:',
    steps, '',
  ].join('\n'));
  return { f, processDir: path.join(root, 'process') };
}
const errs = (o, re) => ((validateFile(o.f, { processDir: o.processDir }) || {}).errors || [])
  .filter((e) => re.test(e.msg));

const OPEN = '  - id: open\n    assignee: brain\n    pane: brain\n    title: "t"';

test('kind effort is a declared kind, and a typo in kind is refused by name', () => {
  // Before this, `kind` was never read by the validator: `effort`, `efort` and `banana` were all
  // equally accepted, so declaring the new kind bought nothing.
  assert.deepEqual(errs(pack({ kind: 'effort', steps: OPEN }), /kind/), []);
  assert.deepEqual(errs(pack({ kind: 'workflow', actors: '[agent]', steps: '  - id: open\n    assignee: agent\n    title: "t"' }), /kind/), []);
  for (const bad of ['efort', 'banana', 'Effort']) {
    const e = errs(pack({ kind: bad, steps: OPEN }), /kind/);
    assert.equal(e.length, 1, `kind: ${bad} must be refused`);
    assert.match(e[0].msg, /`kind` must be workflow\|effort/);
  }
});

test('assignee brain is allowed where the actors declare it, and refused where they do not', () => {
  // `brain` is not special-cased: it is an actor like any other, so a pack that forgets to declare
  // it still fails. The alternative — hardcoding `brain` as always-valid — would let a workflow
  // pack assign a step to a brain that cycle has no pane for.
  assert.deepEqual(errs(pack({ steps: OPEN }), /assignee/), []);
  const e = errs(pack({ actors: '[agent, owner]', steps: OPEN }), /assignee/);
  assert.equal(e.length, 1);
  assert.match(e[0].msg, /assignee `brain` is not in the declared actors/);
});

test('pane takes brain|card|none and refuses anything else, by name', () => {
  for (const v of ['brain', 'card', 'none']) {
    assert.deepEqual(errs(pack({ steps: `  - id: open\n    assignee: brain\n    pane: ${v}\n    title: "t"` }), /pane/), [],
      `pane: ${v} must validate`);
  }
  for (const v of ['both', 'Brain', '1', 'true']) {
    const e = errs(pack({ steps: `  - id: open\n    assignee: brain\n    pane: ${v}\n    title: "t"` }), /pane/);
    assert.equal(e.length, 1, `pane: ${v} must be refused`);
    assert.match(e[0].msg, /`pane` must be brain\|card\|none/);
  }
});

test('pane is optional — a step that does not mention it is silent', () => {
  assert.deepEqual(errs(pack({ steps: '  - id: open\n    assignee: brain\n    title: "t"' }), /pane/), []);
});

test('`pane` on a workflow pack is allowed — a card pane is the default case', () => {
  // The ADR's default is `card` outside an effort cycle, so the key is not effort-only.
  const o = pack({ kind: 'workflow', actors: '[agent]', steps: '  - id: build\n    assignee: agent\n    pane: card\n    title: "t"' });
  assert.deepEqual(errs(o, /pane|kind|assignee/), []);
});

test('the shipped effort pack validates, and is the kind it claims', () => {
  // The pack is the deliverable; a pack that cannot be loaded is a document.
  const p = path.resolve(__dirname, '../workflows/packs/core/effort.md');
  assert.ok(fs.existsSync(p), 'workflows/packs/core/effort.md must exist');
  const src = fs.readFileSync(p, 'utf8');
  assert.match(src, /^kind: effort$/m);
  assert.match(src, /^actors: \[brain, owner\]$/m);
  const r = validateFile(p, { processDir: path.resolve(__dirname, '../process') });
  assert.deepEqual((r && r.errors) || [], []);
});

test('the effort cycle has the steps the ADR specifies, in order, with the outer loop', () => {
  // The shape is the contract: one wave, one human gate, one epoch. `review` is the only human
  // step; `park` is its else_of, so a parked effort leaves the loop rather than sitting in it.
  const src = fs.readFileSync(path.resolve(__dirname, '../workflows/packs/core/effort.md'), 'utf8');
  const ids = [...src.matchAll(/^ {2}- id: (\S+)/gm)].map((m) => m[1]);
  // The two else branches sit together at the end, after the loop they leave: `stand-down` is
  // plan's, `park` is review's. Position is not the contract — `else_of` is — but keeping them
  // adjacent means a reader finds both exits in one place.
  assert.deepEqual(ids, ['open', 'plan', 'dispatch', 'steward', 'roll-up', 'review', 'next-wave', 'close', 'stand-down', 'park']);
  assert.match(src, /- id: steward[\s\S]*?repeat_until: wave_done/);
  assert.match(src, /- id: next-wave[\s\S]*?repeat_until: none/);
  assert.match(src, /- id: park[\s\S]*?else_of: review/);
  assert.equal((src.match(/assignee: owner/g) || []).length, 1, 'exactly one human step — stand-down is the brain\u2019s, not a second gate');
  assert.match(src, /- id: review[\s\S]*?assignee: owner/);
});

// ---- through the command, not the function ---------------------------------------------
// The test above validated the pack through `validateFile` and passed while `plt validate all`
// FAILED on it: bin/plt has its own `kind` dispatch that knew only template|workflow. Testing a
// function while the command that matters takes another path is the same defect this effort keeps
// finding, so this asserts the command.
const { execFileSync } = require('node:child_process');
const NODE = '/opt/homebrew/bin/node';
const PLT = path.resolve(__dirname, '..', 'bin', 'plt');
const REPO = path.resolve(__dirname, '..');

test('plt validate accepts the effort pack — the command, not just the library', () => {
  const out = execFileSync(NODE, [PLT, 'validate', 'workflows/packs/core/effort.md'], { cwd: REPO, encoding: 'utf8' });
  assert.match(out, /^OK/m);
  assert.doesNotMatch(out, /unknown kind/);
});

test('plt validate still refuses a kind it does not know, and names the three it does', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-kind-'));
  const f = path.join(dir, 'w.md');
  fs.writeFileSync(f, ['---', 'name: w', 'kind: banana', 'version: 1', '---', '', '# W', ''].join('\n'));
  let out = '';
  try { execFileSync(NODE, [PLT, 'validate', f], { cwd: REPO, encoding: 'utf8' }); }
  catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
  assert.match(out, /unknown kind `banana`/);
  assert.match(out, /template\|workflow\|effort/, 'the message names every kind, so a typo is self-correcting');
});

// ---- every declared outcome must lead somewhere ---------------------------------------
// The generalisation of the bug, and the test that would have caught it. `plan` declared
// `nothing_to_do` and nothing consumed it: `dispatch` wants `planned`, everything after needs
// `dispatch`, and `park` was only `review`'s else_of. So the effort finished `plan` and stopped —
// no ready step, no gate, no command. The outcome READ as handled because it was in the list.
//
// Found by launching the real effort, which stopped in it two minutes in. Reading the pack does
// not surface it, because the pack is correct line by line.

// A step's outcome is consumed when some other step names it in a `when`, or when the step has an
// `else_of` branch that the outcome falls through to, or when it is the step's own repeat_until
// terminal and the next step merely `needs` it.
function outcomeConsumers(steps, id, outcome) {
  const whens = steps.filter((s) => s.when && s.when.step === id && s.when.outcome === outcome);
  const elses = steps.filter((s) => s.else_of === id);
  const plainNeeds = steps.filter((s) => (s.needs || []).includes(id) && !s.when);
  return { whens, elses, plainNeeds };
}

test('every outcome of every step in the effort cycle leads somewhere', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../workflows/packs/core/effort.md'), 'utf8');
  // A deliberately small parser: id, outcomes, when, else_of, needs, repeat_until per step block.
  const blocks = src.split(/^ {2}- id: /m).slice(1);
  const steps = blocks.map((b) => {
    const id = b.split('\n')[0].trim();
    const g = (re) => { const m = b.match(re); return m ? m[1].trim() : null; };
    const outs = g(/^\s+outcomes: \[([^\]]*)\]/m);
    const when = b.match(/^\s+when: \{ step: (\S+), outcome: (\S+) \}/m);
    return {
      id,
      outcomes: outs ? outs.split(',').map((x) => x.trim()).filter(Boolean) : [],
      when: when ? { step: when[1], outcome: when[2].replace(/[},]/g, '') } : null,
      else_of: g(/^\s+else_of: (\S+)/m),
      needs: (g(/^\s+needs: \[([^\]]*)\]/m) || '').split(',').map((x) => x.trim()).filter(Boolean),
      repeat_until: g(/^\s+repeat_until: (\S+)/m),
    };
  });
  assert.ok(steps.length >= 9, `parsed ${steps.length} steps — the parser is wrong, not the pack`);

  const dead = [];
  for (const s of steps) {
    for (const o of s.outcomes) {
      if (s.repeat_until && o !== s.repeat_until) continue;   // a loop round: it re-opens itself
      const { whens, elses, plainNeeds } = outcomeConsumers(steps, s.id, o);
      if (whens.length || plainNeeds.length) continue;        // something takes this outcome
      // Nothing names it. An else_of branch is the catch-all, and only valid as one if no
      // `when` on this step matches the outcome either.
      const named = steps.some((x) => x.when && x.when.step === s.id && x.when.outcome === o);
      if (elses.length && !named) continue;
      // Terminal steps legitimately have nowhere to go.
      if (!steps.some((x) => (x.needs || []).includes(s.id) || x.else_of === s.id)) continue;
      dead.push(`${s.id} -> ${o}`);
    }
  }
  assert.deepEqual(dead, [], `these outcomes lead nowhere: ${dead.join(', ')}`);
});

test('plan’s nothing_to_do reaches stand-down, and it is NOT park', () => {
  // The specific case, asserted separately from the general rule so a reader sees the shape.
  const src = fs.readFileSync(path.resolve(__dirname, '../workflows/packs/core/effort.md'), 'utf8');
  assert.match(src, /- id: stand-down[\s\S]*?else_of: plan/, 'stand-down is plan’s else branch');
  assert.match(src, /- id: park[\s\S]*?else_of: review/, 'park stays review’s, and means something different');
  // Two distinct facts: a person chose to stop, versus the fan had nothing to give.
  assert.match(src, /`park` means a person looked at a roll-up and chose to stop/);
  assert.match(src, /stand-down` means the fan had\s*\n\s*# nothing to dispatch/);
  const ids = [...src.matchAll(/^ {2}- id: (\S+)/gm)].map((m) => m[1]);
  assert.ok(ids.includes('stand-down') && ids.includes('park'), 'both terminal branches exist');
});
