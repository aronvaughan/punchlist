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

test('cli: render <name> that is neither a board target nor a real workflow is an unambiguous error (exit 2), never "treated as a name"', () => {
  const { status, stderr } = run(['render', 'no-such-workflow-xyz']);
  assert.strictEqual(status, 2);
  assert.match(stderr, /unknown render target 'no-such-workflow-xyz' — use index, run <id>, or all/);
});

test('cli: render index|run <id>|all always resolve to the spine board pages, never a workflow lookup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-render-board-'));
  const r1 = run(['render', 'all'], { PUNCHLIST_TEMPLATES_DIR: dir, PLT_PROCESS_DIR: path.join(dir, 'process') });
  assert.notStrictEqual(r1.status, 2, r1.stderr);   // routed to spine-cli render, not the "unknown target" error
  const r2 = run(['render', 'index'], { PUNCHLIST_TEMPLATES_DIR: dir, PLT_PROCESS_DIR: path.join(dir, 'process') });
  assert.notStrictEqual(r2.status, 2, r2.stderr);
  const r3 = run(['render', 'run'], { PUNCHLIST_TEMPLATES_DIR: dir, PLT_PROCESS_DIR: path.join(dir, 'process') });
  assert.notStrictEqual(r3.status, 2, r3.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cli: render index names a workflow it shadows, and render --workflow index regenerates that workflow\'s diagram', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-render-shadow-'));
  for (const d of ['workflows/authored', 'templates/authored']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const file = path.join(dir, 'workflows/authored/index.md');
  fs.writeFileSync(file, [
    '---', 'name: index', 'kind: workflow', 'actors: [hermes]', '---',
    'steps:', '  - id: solo', '    assignee: hermes', '',
    plt.MERMAID_OPEN, '```mermaid', 'flowchart TD', '  stale', '```', plt.MERMAID_CLOSE, '',
  ].join('\n'));
  const env = { PUNCHLIST_TEMPLATES_DIR: dir, PLT_PROCESS_DIR: path.join(dir, 'process') };
  const board = run(['render', 'index'], env);
  assert.notStrictEqual(board.status, 2, board.stderr);   // still the board page
  assert.match(board.stderr, /plt render: "index" is a subcommand; use plt render --workflow index to regenerate that workflow's diagram/);
  assert.ok(fs.readFileSync(file, 'utf8').includes('stale'), 'the board target never touches the workflow file');
  const wf = run(['render', '--workflow', 'index'], env);
  assert.strictEqual(wf.status, 0, wf.stderr);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('solo["solo (hermes)"]'));
  assert.ok(!text.includes('stale'));
  const none = run(['render', 'all'], env);
  assert.doesNotMatch(none.stderr, /is a subcommand/, 'no workflow named all, so no note');
});

test('validateWorkflow: a workflow named index/run/all is refused — those names are reserved by `plt render`\'s board targets', () => {
  for (const bad of ['index', 'run', 'all']) {
    const text = ['---', `name: ${bad}`, 'kind: workflow', 'actors: [hermes]', '---',
      'steps:', '  - id: solo', '    assignee: hermes', ''].join('\n');
    const parsed = plt.parseWorkflow(text);
    const errors = plt.validateWorkflow(parsed, `/tmp/${bad}.md`, new Set());
    assert.ok(errors.some((e) => /reserved by `plt render`/.test(e.msg)), `expected a reserved-name error for \`${bad}\`, got: ${JSON.stringify(errors)}`);
  }
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

test('parseSteps: a key with an empty value opens an indented block map (one level)', () => {
  const { steps, errors } = plt.parseWorkflow([
    '---', 'name: sample', 'kind: workflow', 'actors: [agent, owner]', '---',
    'steps:',
    '  - id: review',
    '    assignee: agent',
    '    gate:',
    '      kind: adversarial',
    '      agents: [a, b]',
    '      mode: hard',
    '    outcomes: [pass, fail]',
  ].join('\n'));
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(steps[0].gate, { kind: 'adversarial', agents: ['a', 'b'], mode: 'hard' });
  assert.deepStrictEqual(steps[0].outcomes, ['pass', 'fail']);
});

test('validateWorkflow: spine keys — gate kinds, human signal, dead model/reasoning, skills shape', () => {
  const file = path.join(FIXTURES, 'wf-spine-bad-gate.md');
  const parsed = plt.parseWorkflow(fs.readFileSync(file, 'utf8'));
  const config = {
    gates: { human_signals: ['artifact-approved'] },
    models: { allowed: ['opus'], reasoning_levels: ['low', 'high'] },
  };
  const msgs = plt.validateWorkflow(parsed, file, new Set(), { config }).map((e) => e.msg);
  assert.ok(msgs.some((m) => /gate\.kind `sideways`/.test(m)));
  assert.ok(msgs.some((m) => /human gate needs `signal`/.test(m)));
  assert.ok(msgs.some((m) => /key `model` is not read by anything, so it has no effect — remove it/.test(m)));
  assert.ok(msgs.some((m) => /key `reasoning` is not read by anything, so it has no effect — remove it/.test(m)));
  assert.ok(msgs.some((m) => /`skills` must be an inline list/.test(m)));
});

test('validateWorkflow: on-disk skill and agent existence when sets are supplied', () => {
  const parsed = plt.parseWorkflow([
    '---', 'name: sample', 'kind: workflow', 'actors: [agent]', '---',
    'steps:', '  - id: build', '    assignee: agent', '    skills: [present, missing]', '    agents: [rev]',
  ].join('\n'));
  const msgs = plt.validateWorkflow(parsed, '/x/sample.md', new Set(),
    { skillsOnDisk: new Set(['present']), agentsOnDisk: new Set() }).map((e) => e.msg);
  assert.ok(msgs.some((m) => /skill `missing` is not on disk/.test(m)));
  assert.ok(msgs.some((m) => /agent `rev` is not on disk/.test(m)));
  assert.ok(!msgs.some((m) => /skill `present`/.test(m)));
});

test('validateWorkflow: jira.on_start formula reference skips config.jira.statuses check', () => {
  const parsed = plt.parseWorkflow([
    '---', 'name: sample', 'kind: workflow', 'actors: [agent]', '---',
    'steps:', '  - id: build', '    assignee: agent', '    jira:', '      on_start: "{{config.jira.status.in_progress}}"',
  ].join('\n'));
  const config = { jira: { statuses: ['In Progress', 'Done'] } };
  const msgs = plt.validateWorkflow(parsed, '/x/sample.md', new Set(), { config }).map((e) => e.msg);
  assert.ok(!msgs.some((m) => /jira\.on_start/.test(m)));
});

test('validator: `overlap` is `effort` or a slug; `touches` is `declared`; anything else names the step', () => {
  const ok = validate([
    '  - id: one', '    assignee: a', '    touches: declared',
    '    overlap: effort',
    '  - id: two', '    assignee: a', '    overlap: greenhouse-2',
  ]);
  assert.deepStrictEqual(ok.filter((e) => /overlap|touches/.test(e.msg)), []);
  const bad = validate([
    '  - id: one', '    assignee: a', '    touches: everything',
    '  - id: two', '    assignee: a', '    overlap: Bad Slug',
    '  - id: three', '    assignee: a', '    overlap: -leading',
  ]).map((e) => e.msg);
  assert.ok(bad.some((m) => /step `one`: `touches` must be `declared`/.test(m)), bad.join('\n'));
  assert.ok(bad.some((m) => /step `two`: `overlap` must be `effort` or a slug/.test(m)), bad.join('\n'));
  assert.ok(bad.some((m) => /step `three`: `overlap`/.test(m)), bad.join('\n'));
});

test('renderMermaid: every step carrying `overlap` gets an `-- overlap check --> blocked` edge', () => {
  const m = plt.renderMermaid([
    { id: 'pre-pr', assignee: 'agent', overlap: 'effort' },
    { id: 'open-pr', assignee: 'agent', needs: ['pre-pr'], overlap: 'effort' },
    { id: 'close', assignee: 'agent', needs: ['open-pr'] },
  ]);
  assert.ok(m.includes('pre-pr -- overlap check --> blocked'), m);
  assert.ok(m.includes('open-pr -- overlap check --> blocked'), m);
  assert.ok(!m.includes('close -- overlap check'), m);
});

test('validateWorkflow: `cards:` accepts only `external` or absence — a typo must not silently restore jira requirements', () => {
  const src = (cards) => ['---', 'name: x', 'kind: workflow', 'actors: [agent]', ...(cards ? [`cards: ${cards}`] : []), '---',
    'steps:', '  - id: one', '    assignee: agent', ''].join('\n');
  const msgs = (cards) => plt.validateWorkflow(plt.parseWorkflow(src(cards)), '/tmp/x.md', new Set(), {}).map((e) => e.msg);
  assert.deepStrictEqual(msgs(null), [], 'absent is fine — the run tracks our own cards');
  assert.deepStrictEqual(msgs('external'), []);
  assert.ok(msgs('extenal').some((m) => /`cards: extenal` must be `external` \(the only value\) or absent/.test(m)), msgs('extenal').join('\n'));
  assert.ok(msgs('internal').some((m) => /must be `external`/.test(m)));
});

test('validateWorkflow: an adversarial gate needs `mode: hard|banner` (a config ref is allowed)', () => {
  const src = (mode) => ['---', 'name: x', 'kind: workflow', 'actors: [agent]', '---', 'steps:', '  - id: review', '    assignee: agent',
    '    gate:', '      kind: adversarial', '      agents: [rev]', ...(mode ? [`      mode: ${mode}`] : []), ''].join('\n');
  const msgs = (mode) => plt.validateWorkflow(plt.parseWorkflow(src(mode)), '/tmp/x.md', new Set(), {}).map((e) => e.msg);
  assert.ok(msgs(null).some((m) => /step `review`: adversarial gate needs `mode: hard\|banner`/.test(m)));
  assert.ok(msgs('soft').some((m) => /step `review`: gate\.mode `soft` must be hard\|banner/.test(m)));
  assert.ok(!msgs('hard').some((m) => /mode/.test(m)));
  assert.ok(!msgs('banner').some((m) => /mode/.test(m)));
  assert.ok(!msgs('"{{config.review.writing_mode}}"').some((m) => /mode/.test(m)));
});

test('validateWorkflow: gate.mode only accepts {{config.*}} refs (not a bare {{...}}); any such ref validates, because an unresolved one is defaulted in code', () => {
  const src = (mode) => ['---', 'name: x', 'kind: workflow', 'actors: [agent]', '---', 'steps:', '  - id: review', '    assignee: agent',
    '    gate:', '      kind: adversarial', '      agents: [rev]', `      mode: ${mode}`, ''].join('\n');
  const msgs = (mode, config) => plt.validateWorkflow(plt.parseWorkflow(src(mode)), '/tmp/x.md', new Set(), config ? { config } : {}).map((e) => e.msg);
  // Wrong prefix — `{{cfg....}}` is not `{{config....}}` and must fail even with no config supplied.
  assert.ok(msgs('"{{cfg.review.panel_mode}}"').some((m) => /step `review`: gate\.mode `\{\{cfg\.review\.panel_mode\}\}`/.test(m)),
    msgs('"{{cfg.review.panel_mode}}"').join('\n'));
  // ANY {{config.*}} mode ref passes validation, resolvable or not: the code falls back to `hard`,
  // so config is only an override — never a requirement, and never a key whitelist to hand-sync.
  assert.deepStrictEqual(msgs('"{{config.review.nope}}"', { review: {} }), []);
  assert.deepStrictEqual(msgs('"{{config.review.panel_mode}}"', {}), []);
  assert.deepStrictEqual(msgs('"{{config.review.writing_mode}}"', {}), []);
  assert.deepStrictEqual(msgs('"{{config.review.security_mode}}"', {}), []);
  // A ref that does resolve in the supplied config passes too.
  assert.deepStrictEqual(msgs('"{{config.review.panel_mode}}"', { review: { panel_mode: 'hard' } }), []);
  // No config supplied at all (opts.config undefined) — behaves as before: refs are not checked for resolution.
  assert.deepStrictEqual(msgs('"{{config.review.anything}}"'), []);
});

test('validateWorkflow: `arm_on`/`land_on` name a fact the poll produces — a typo is refused, not left to wait forever', () => {
  const src = (key, gh, equals = 'true') => ['---', 'name: x', 'kind: workflow', 'actors: [agent]', '---',
    'steps:', '  - id: one', '    assignee: agent', `    ${key}:`, `      gh: ${gh}`,
    ...(equals === null ? [] : [`      equals: ${equals}`]), ''].join('\n');
  const msgs = (...a) => plt.validateWorkflow(plt.parseWorkflow(src(...a)), '/tmp/x.md', new Set(), {}).map((e) => e.msg);

  assert.deepStrictEqual(msgs('arm_on', 'authorRepliedSinceOurReview'), []);
  assert.deepStrictEqual(msgs('land_on', 'state', 'MERGED'), []);
  // The three facts `prFacts` produces that the poll used to drop: arming on them now works.
  for (const f of ['isDraft', 'checksGreen', 'threadsUnresolved']) assert.deepStrictEqual(msgs('arm_on', f, '0'), [], f);

  assert.ok(msgs('arm_on', 'authorReplied').some((m) =>
    /step `one`: arm_on\.gh `authorReplied` is not a fact the poll produces/.test(m)), 'a typo must name itself');
  assert.ok(msgs('land_on', 'merged', 'true').some((m) => /land_on\.gh `merged` is not a fact/.test(m)));
  assert.ok(msgs('arm_on', 'state', null).some((m) => /step `one`: `arm_on` needs `equals`/.test(m)));
  // `checks` is a tally object in the snapshot — armable only through its scalar form.
  assert.ok(msgs('arm_on', 'checks', '0').some((m) => /arm_on\.gh `checks` is not a fact/.test(m)));
});

test('validateWorkflow: the prose keys are checked against the substitution each one actually gets', () => {
  const src = (lines) => ['---', 'name: x', 'kind: workflow', 'actors: [agent]', 'inputs:', '  - card', '---',
    'steps:', '  - id: one', '    assignee: agent', ...lines, ''].join('\n');
  const msgs = (lines) => plt.validateWorkflow(plt.parseWorkflow(src(lines)), '/tmp/x.md', new Set(), {}).map((e) => e.msg);

  // title/notes are interpolated with the run's inputs.
  assert.deepStrictEqual(msgs(['    title: "ship {card}"']), []);
  assert.ok(msgs(['    notes: "ask {owner}"']).some((m) => /notes uses \{owner\} which is not a declared input/.test(m)));
  // banner is filled by renderBanners' four run vars and nothing else.
  assert.deepStrictEqual(msgs(['    banner: "reply on {pr_url} for {card}"']), []);
  assert.ok(msgs(['    banner: "ping {owner}"']).some((m) =>
    /banner uses \{owner\}; renderBanners fills only \{run\} \{card\} \{pr_url\} \{card_url\}/.test(m)));
  // waiting is printed raw — a placeholder there is a literal brace on the board.
  assert.deepStrictEqual(msgs(['    waiting: "the author to reply"']), []);
  assert.ok(msgs(['    waiting: "{card} author"']).some((m) => /`waiting` is never substituted/.test(m)));
  assert.ok(msgs(['    title: ""']).some((m) => /`title` must be a non-empty string/.test(m)));
});

test('validateWorkflow: `manual` takes only true|false — the parser makes every scalar a string, so `false` used to be truthy', () => {
  const src = (v) => ['---', 'name: x', 'kind: workflow', 'actors: [agent]', '---',
    'steps:', '  - id: one', '    assignee: agent', `    manual: ${v}`, ''].join('\n');
  const msgs = (v) => plt.validateWorkflow(plt.parseWorkflow(src(v)), '/tmp/x.md', new Set(), {}).map((e) => e.msg);
  assert.deepStrictEqual(msgs('true'), []);
  assert.deepStrictEqual(msgs('false'), []);
  assert.ok(msgs('yes').some((m) => /step `one`: `manual: yes` must be true or false/.test(m)));
});

test('validateWorkflow: `tools`/`files` names must be plain and unique — a requirement no receipt can name is unsatisfiable', () => {
  const src = (key, list) => ['---', 'name: x', 'kind: workflow', 'actors: [agent]', '---',
    'steps:', '  - id: one', '    assignee: agent', `    ${key}: ${list}`, ''].join('\n');
  const msgs = (key, list) => plt.validateWorkflow(plt.parseWorkflow(src(key, list)), '/tmp/x.md', new Set(), {}).map((e) => e.msg);
  assert.deepStrictEqual(msgs('tools', '[gh, jira.py, nx:test]'), []);
  assert.ok(msgs('files', '[a b]').some((m) => /file name `a b` must be a plain name/.test(m)));
  assert.ok(msgs('tools', '[gh, gh]').some((m) => /`tools` has duplicates/.test(m)));
});

test('validateWorkflow: `reapprove` names a real template and real steps; bare `rearm` is refused', () => {
  const src = (lines) => ['---', 'name: x', 'kind: workflow', 'actors: [human, agent]', '---',
    'steps:', '  - id: approve', '    assignee: human', ...lines, '  - id: announce', '    assignee: agent', ''].join('\n');
  const msgs = (lines) => plt.validateWorkflow(plt.parseWorkflow(src(lines)), '/tmp/x.md', new Set(['fix-summary']), {}).map((e) => e.msg);

  assert.deepStrictEqual(msgs(['    reapprove:', '      artifact: fix-summary', '      rearm: [announce]']), []);
  assert.ok(msgs(['    reapprove:', '      artifact: fix-summry', '      rearm: [announce]'])
    .some((m) => /reapprove\.artifact `fix-summry` is not a known template/.test(m)));
  assert.ok(msgs(['    reapprove:', '      artifact: fix-summary', '      rearm: [anounce]'])
    .some((m) => /reapprove\.rearm `anounce` is not a step in this file/.test(m)));
  assert.ok(msgs(['    reapprove:', '      artifact: fix-summary', '      rearm: [approve]'])
    .some((m) => /reapprove\.rearm names its own step/.test(m)));
  assert.ok(msgs(['    reapprove:', '      artifct: fix-summary'])
    .some((m) => /reapprove\.artifct is read by nothing/.test(m)));
  assert.ok(msgs(['    rearm: [announce]']).some((m) => /`rearm` belongs under `reapprove`/.test(m)));
});

test('validateWorkflow: `land_on.outcome` must be one of that step\'s own outcomes', () => {
  const src = (outcome, outcomes) => ['---', 'name: x', 'kind: workflow', 'actors: [agent]', '---',
    'steps:', '  - id: merge', '    assignee: agent',
    ...(outcomes ? [`    outcomes: ${outcomes}`] : []),
    '    land_on:', '      gh: state', '      equals: MERGED', `      outcome: ${outcome}`, ''].join('\n');
  const msgs = (...a) => plt.validateWorkflow(plt.parseWorkflow(src(...a)), '/tmp/x.md', new Set(), {}).map((e) => e.msg);
  assert.deepStrictEqual(msgs('done', null), [], 'the implicit outcome list is [done]');
  assert.deepStrictEqual(msgs('landed', '[landed, dropped]'), []);
  assert.ok(msgs('landed', null).some((m) =>
    /step `merge`: land_on\.outcome `landed` is not one of the step's outcomes \(done\)/.test(m)));
});

// One spelling for the green-checks fact: the hyphen. The validator's verify.gh list and every
// shipped pack use `checks-green`; an old receipt spelled `checks_green` still counts (spine's
// normalizeGhName), and fsck reports it as W_GH_NAME_SPELLING.
// The collector matches gh names with `-` and `_` as one character (spine.normalizeGhName), so the
// validator does too; the shipped packs still spell it one way, `checks-green`.
test('validateWorkflow: verify.gh takes `checks-green` and `checks_green` alike; no shipped pack spells it with `_`', () => {
  const src = (name) => ['---', 'name: x', 'kind: workflow', 'actors: [agent]', '---',
    'steps:', '  - id: open-pr', '    assignee: agent', '    verify:', `      gh: [${name}]`, ''].join('\n');
  const msgs = (name) => plt.validateWorkflow(plt.parseWorkflow(src(name)), '/tmp/x.md', new Set(), {}).map((e) => e.msg);
  assert.deepStrictEqual(msgs('checks-green'), []);
  assert.deepStrictEqual(msgs('checks_green'), []);
  const packs = path.join(REPO, 'workflows', 'packs');
  const files = fs.readdirSync(packs, { recursive: true }).filter((f) => f.endsWith('.md'));
  assert.ok(files.length > 0);
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(packs, f), 'utf8'), /checks_green/, f);
});
