'use strict';
// Workflow format: parser, validator, and mermaid renderer.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PLT = path.join(REPO, 'bin', 'plt');
const FIXTURES = path.join(__dirname, 'fixtures');
const SHIPPED = path.join(REPO, 'workflows', 'packs', 'core', 'research-and-buy.md');

const plt = require(PLT);

function run(args, env = {}) {
  const res = spawnSync('node', [PLT, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// ------------------------------------------------------------------- parser

test('parseWorkflow: steps block with inline lists, inline maps, nesting', () => {
  const { fm, steps, errors } = plt.parseWorkflow([
    '---',
    'name: sample',
    'kind: workflow',
    'inputs: [item, budget]',
    'actors: [hermes, owner]',
    '---',
    'steps:',
    '  - id: research',
    '    assignee: hermes',
    '    template: research-brief',
    '    title: "Research {item} under {budget}"',
    '  - id: decide',
    '    assignee: owner',
    '    needs: [research]',
    '    outcomes: [approved, rejected]',
    '  - id: order',
    '    assignee: hermes',
    '    when: { step: decide, outcome: approved }',
    '    on_fail: { retry: 2, then: escalate }',
    '  - id: escalate',
    '    assignee: owner',
    '',
    'Trailing prose ends the block.',
  ].join('\n'));
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(fm.kind, 'workflow');
  assert.deepStrictEqual(fm.inputs, ['item', 'budget']);
  assert.strictEqual(steps.length, 4);
  assert.strictEqual(steps[0].template, 'research-brief');
  assert.strictEqual(steps[0].title, 'Research {item} under {budget}');
  assert.deepStrictEqual(steps[1].needs, ['research']);
  assert.deepStrictEqual(steps[1].outcomes, ['approved', 'rejected']);
  assert.deepStrictEqual(steps[2].when, { step: 'decide', outcome: 'approved' });
  assert.deepStrictEqual(steps[2].on_fail, { retry: '2', then: 'escalate' });
});

test('parseWorkflow: mermaid block and prose after steps are ignored', () => {
  const { steps, errors } = plt.parseWorkflow([
    '---', 'name: x', 'kind: workflow', 'actors: [a]', '---',
    'steps:',
    '  - id: one',
    '    assignee: a',
    '',
    plt.MERMAID_OPEN,
    '```mermaid',
    'flowchart TD',
    '  one --> two',
    '  - id: fake',
    '```',
    plt.MERMAID_CLOSE,
  ].join('\n'));
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(steps.length, 1);
});

test('parseWorkflow: no steps block -> steps null', () => {
  const { steps } = plt.parseWorkflow('---\nname: x\nkind: workflow\n---\nno steps here\n');
  assert.strictEqual(steps, null);
});

test('parseScalar: inline map with quoted values', () => {
  assert.deepStrictEqual(plt.parseScalar('{ step: decide, outcome: "approved" }'),
    { step: 'decide', outcome: 'approved' });
  assert.deepStrictEqual(plt.parseScalar('{}'), {});
});

// ---------------------------------------------------------------- validator

test('shipped workflow research-and-buy validates', () => {
  assert.deepStrictEqual(plt.validateFile(SHIPPED), []);
});

const BAD = {
  'wf-unknown-edge.md': /needs references unknown step `ghost`/,
  'wf-dup-id.md': /duplicate step id `one`/,
  'wf-missing-template.md': /template `no-such-template` does not exist/,
  'wf-else-no-when.md': /no step has a `when` branch on `one`/,
  'wf-cycle.md': /dependency cycle: /,
  'wf-empty-outcomes.md': /`outcomes` must be a nonempty inline list/,
  'wf-bad-actor.md': /assignee `nobody` is not in the declared actors/,
};

for (const [file, re] of Object.entries(BAD)) {
  test(`validator rejects ${file}`, () => {
    const errors = plt.validateFile(path.join(FIXTURES, file));
    assert.ok(errors.length >= 1, 'expected at least one error');
    assert.ok(errors.some((e) => re.test(e.msg)), `no error matched ${re}: ${JSON.stringify(errors)}`);
  });
}

function wfText(stepLines) {
  return ['---', 'name: t', 'kind: workflow', 'actors: [a, owner]', 'inputs: [item]', '---', 'steps:',
    ...stepLines].join('\n');
}

function validate(stepLines) {
  const parsed = plt.parseWorkflow(wfText(stepLines));
  return plt.validateWorkflow(parsed, '/tmp/t.md', new Set(['research-brief']));
}

test('validator: when outcome must be declared by the target step', () => {
  const errors = validate([
    '  - id: one', '    assignee: a', '    outcomes: [ok, bad]',
    '  - id: two', '    assignee: a', '    when: { step: one, outcome: maybe }',
  ]);
  assert.ok(errors.some((e) => /`maybe` is not a declared outcome of `one`/.test(e.msg)));
});

test('validator: when on an outcome-less step only matches `done`', () => {
  assert.deepStrictEqual(validate([
    '  - id: one', '    assignee: a',
    '  - id: two', '    assignee: a', '    when: { step: one, outcome: done }',
    '  - id: three', '    assignee: a', '    else_of: one',
  ]), []);
});

test('validator: repeat_until requires and must match declared outcomes', () => {
  assert.ok(validate(['  - id: one', '    assignee: a', '    repeat_until: ok'])
    .some((e) => /`repeat_until` requires the step to declare `outcomes`/.test(e.msg)));
  assert.ok(validate(['  - id: one', '    assignee: a', '    outcomes: [ok, more]', '    repeat_until: nope'])
    .some((e) => /is not one of the step's outcomes/.test(e.msg)));
  assert.deepStrictEqual(
    validate(['  - id: one', '    assignee: a', '    outcomes: [ok, more]', '    repeat_until: ok']), []);
});

test('validator: undeclared {placeholder} in title is rejected', () => {
  const errors = validate(['  - id: one', '    assignee: a', '    title: "Buy {thing}"']);
  assert.ok(errors.some((e) => /uses \{thing\} which is not a declared input/.test(e.msg)));
});

test('validator: on_fail.then must reference a real step; retry must be an integer', () => {
  assert.ok(validate(['  - id: one', '    assignee: a', '    on_fail: { retry: 1, then: ghost }'])
    .some((e) => /on_fail\.then references unknown step `ghost`/.test(e.msg)));
  assert.ok(validate(['  - id: one', '    assignee: a', '    on_fail: { retry: lots }'])
    .some((e) => /`on_fail.retry` must be a non-negative integer/.test(e.msg)));
});

test('validator: missing steps block fails', () => {
  const parsed = plt.parseWorkflow('---\nname: t\nkind: workflow\nactors: [a]\n---\nprose only\n');
  const errors = plt.validateWorkflow(parsed, '/tmp/t.md', new Set());
  assert.ok(errors.some((e) => /must have a body-level `steps:` block/.test(e.msg)));
});

test('findDependencyCycle: allows diamonds, catches loops', () => {
  const diamond = [
    { id: 'a' }, { id: 'b', needs: ['a'] }, { id: 'c', needs: ['a'] }, { id: 'd', needs: ['b', 'c'] },
  ];
  assert.strictEqual(plt.findDependencyCycle(diamond), null);
  const loop = [{ id: 'a', needs: ['b'] }, { id: 'b', needs: ['a'] }];
  assert.ok(Array.isArray(plt.findDependencyCycle(loop)));
});

// ------------------------------------------------------------------ mermaid

test('renderMermaid: nodes, join edges, outcome labels, else, dashed on_fail, repeat loop', () => {
  const m = plt.renderMermaid([
    { id: 'research', assignee: 'hermes' },
    { id: 'decide', assignee: 'owner', needs: ['research'], outcomes: ['approved', 'rejected'] },
    { id: 'order', assignee: 'hermes', when: { step: 'decide', outcome: 'approved' },
      on_fail: { retry: '2', then: 'escalate' } },
    { id: 'shelve', assignee: 'owner', else_of: 'decide' },
    { id: 'escalate', assignee: 'owner' },
    { id: 'poll', assignee: 'hermes', needs: ['order'], outcomes: ['arrived', 'waiting'],
      repeat_until: 'arrived' },
  ]);
  assert.ok(m.startsWith('flowchart TD'));
  assert.ok(m.includes('research["research (hermes)"]'));
  assert.ok(m.includes('research --> decide'));
  assert.ok(m.includes('decide -- approved --> order'));
  assert.ok(m.includes('decide -- else --> shelve'));
  assert.ok(m.includes('order -. fail x2 .-> escalate'));
  assert.ok(m.includes('poll -- until arrived --> poll'));
});

test('injectMermaid: appends markers when absent, replaces in place when present', () => {
  const first = plt.injectMermaid('body\n', 'flowchart TD\n  a["a (x)"]');
  assert.ok(first.includes(plt.MERMAID_OPEN));
  assert.ok(first.includes('a["a (x)"]'));
  const second = plt.injectMermaid(first, 'flowchart TD\n  b["b (y)"]');
  assert.ok(!second.includes('a["a (x)"]'));
  assert.ok(second.includes('b["b (y)"]'));
  assert.strictEqual((second.match(/plt:mermaid/g) || []).length, 2); // one open + one close
});

test('cli: render is idempotent on the shipped workflow (diagram committed up to date)', () => {
  const before = fs.readFileSync(SHIPPED, 'utf8');
  const { status, stdout } = run(['render', 'research-and-buy']);
  assert.strictEqual(status, 0);
  assert.match(stdout, /already up to date/);
  assert.strictEqual(fs.readFileSync(SHIPPED, 'utf8'), before);
});

test('cli: render rewrites a stale diagram', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-render-'));
  for (const d of ['workflows/authored', 'templates/authored']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflows/authored/tiny.md'), [
    '---', 'name: tiny', 'kind: workflow', 'actors: [hermes]', '---',
    'steps:', '  - id: solo', '    assignee: hermes', '',
    plt.MERMAID_OPEN, '```mermaid', 'flowchart TD', '  stale', '```', plt.MERMAID_CLOSE, '',
  ].join('\n'));
  const { status } = run(['render', 'tiny'], { PUNCHLIST_TEMPLATES_DIR: dir });
  assert.strictEqual(status, 0);
  const text = fs.readFileSync(path.join(dir, 'workflows/authored/tiny.md'), 'utf8');
  assert.ok(text.includes('solo["solo (hermes)"]'));
  assert.ok(!text.includes('stale'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cli: validate all covers the shipped workflow', () => {
  const { status, stdout } = run(['validate', 'all']);
  assert.strictEqual(status, 0);
  assert.ok(stdout.includes('OK    workflows/packs/core/research-and-buy.md'));
});

test('cli: launch without a token fails with a clear message', () => {
  const { status, stderr } = run(
    ['launch', 'research-and-buy', '--input', 'item=x', '--input', 'budget=$1'],
    { PUNCHLIST_TOKEN: '', PUNCHLIST_ENV_FILE: '/nonexistent', HOME: os.tmpdir(), HERMES_HOME: '' });
  assert.strictEqual(status, 1);
  assert.match(stderr, /PUNCHLIST_TOKEN is not set/);
});

test('cli: launch rejects missing and undeclared inputs before touching the API', () => {
  const miss = run(['launch', 'research-and-buy', '--input', 'item=x']);
  assert.strictEqual(miss.status, 2);
  assert.match(miss.stderr, /missing --input budget=/);
  const extra = run(['launch', 'research-and-buy',
    '--input', 'item=x', '--input', 'budget=$1', '--input', 'color=red']);
  assert.strictEqual(extra.status, 2);
  assert.match(extra.stderr, /`color` is not a declared input/);
});
