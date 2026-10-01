'use strict';
// lib/validate.js — the workflow validator as a module, and the `opts` every caller now builds.
// Before this module, all three bin/plt call sites omitted `opts`, so the config and on-disk
// checks ran only in tests that supplied it by hand.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PLT = path.join(REPO, 'bin', 'plt');
const DEFAULTS = path.join(__dirname, 'fixtures', 'spine', 'config', 'defaults.yaml');

const validate = require('../lib/validate');

// A scratch project: <root>/process/config/defaults.yaml, plus a project-level .claude with one
// skill (a directory) and one agent (a .md file), and a separate fake home with its own skill.
function scratchProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-validate-'));
  const processDir = path.join(root, 'process');
  fs.mkdirSync(path.join(processDir, 'config'), { recursive: true });
  fs.copyFileSync(DEFAULTS, path.join(processDir, 'config', 'defaults.yaml'));
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'greenhouse-watering'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'skills', 'greenhouse-watering', 'SKILL.md'), '# watering\n');
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'soil-reviewer.md'), '# soil\n');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-validate-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'seed-catalog'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'seed-catalog', 'SKILL.md'), '# seeds\n');
  return { root, processDir, home };
}

function workflow(dir, name, stepLines) {
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, [
    '---', `name: ${name}`, 'kind: workflow', 'actors: [agent, owner]', '---', '',
    'steps:', '  - id: plant', '    assignee: agent', ...stepLines, '',
  ].join('\n'));
  return file;
}

test('buildOpts: loads the project config and finds skills and agents on disk', () => {
  const { processDir, home } = scratchProject();
  const opts = validate.buildOpts(processDir, { home });
  assert.deepStrictEqual(opts.config.gates.human_signals, ['artifact-approved', 'reply-approved', 'run-discarded']);
  assert.ok(opts.skillsOnDisk instanceof Set);
  assert.ok(opts.skillsOnDisk.has('greenhouse-watering'), 'project skill');
  assert.ok(opts.skillsOnDisk.has('seed-catalog'), 'user skill');
  assert.ok(!opts.skillsOnDisk.has('compost-turner'), 'a skill that does not exist');
  assert.ok(opts.agentsOnDisk.has('soil-reviewer'));
  assert.ok(!opts.agentsOnDisk.has('greenhouse-watering'));
});

test('buildOpts: a skill is a directory holding SKILL.md, found nested; a container without one is not a skill', () => {
  const { root, processDir, home } = scratchProject();
  const skills = path.join(root, '.claude', 'skills');
  fs.mkdirSync(path.join(skills, 'irrigation', 'drip-schedule'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'irrigation', 'drip-schedule', 'SKILL.md'), '# drip\n');
  fs.mkdirSync(path.join(skills, 'empty-shelf'), { recursive: true });
  // A symlink loop must not hang the walk.
  fs.symlinkSync(skills, path.join(skills, 'irrigation', 'loop'));
  const agents = path.join(root, '.claude', 'agents');
  fs.mkdirSync(path.join(agents, 'reviewers'), { recursive: true });
  fs.writeFileSync(path.join(agents, 'reviewers', 'leaf-reviewer.md'), '# leaf\n');
  const opts = validate.buildOpts(processDir, { home });
  assert.ok(opts.skillsOnDisk.has('drip-schedule'), 'nested skill found by its own directory name');
  assert.ok(!opts.skillsOnDisk.has('irrigation'), 'a container with no SKILL.md is not a skill');
  assert.ok(!opts.skillsOnDisk.has('empty-shelf'), 'a directory with no SKILL.md is not a skill');
  assert.ok(opts.skillsOnDisk.has('greenhouse-watering'));
  assert.ok(opts.agentsOnDisk.has('leaf-reviewer'), 'an agent one level down');
  assert.ok(opts.agentsOnDisk.has('soil-reviewer'));
});

test('validateFile: a plugin:skill name is never checked against disk; a missing plain skill still fails', () => {
  const { root, processDir, home } = scratchProject();
  const file = workflow(root, 'greenhouse-plugin-skill', ['    skills: [potting-kit:repot, compost-turner]']);
  const msgs = validate.validateFile(file, { processDir, templates: new Set(), home }).errors.map((e) => e.msg);
  assert.ok(!msgs.some((m) => /potting-kit:repot/.test(m)), JSON.stringify(msgs));
  assert.ok(msgs.some((m) => /skill `compost-turner` is not on disk/.test(m)));
});

test('buildOpts: absent skill and agent directories yield empty Sets, never a throw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-validate-bare-'));
  const processDir = path.join(root, 'process');
  fs.mkdirSync(path.join(processDir, 'config'), { recursive: true });
  fs.copyFileSync(DEFAULTS, path.join(processDir, 'config', 'defaults.yaml'));
  const home = path.join(root, 'no-such-home');
  const opts = validate.buildOpts(processDir, { home });
  assert.deepStrictEqual([...opts.skillsOnDisk], []);
  assert.deepStrictEqual([...opts.agentsOnDisk], []);
  assert.ok(opts.config.models, 'config still loads');
});

test('buildOpts: no process directory at all still yields opts (empty config)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-validate-nohome-'));
  const opts = validate.buildOpts(null, { home });
  assert.deepStrictEqual(opts.config, {});
  assert.deepStrictEqual([...opts.skillsOnDisk], []);
  assert.deepStrictEqual([...opts.agentsOnDisk], []);
});

test('buildOpts: a process directory with no config/ yields an empty config, never a throw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-validate-noconfig-'));
  const opts = validate.buildOpts(path.join(root, 'process'), { home: path.join(root, 'no-home') });
  assert.deepStrictEqual(opts.config, {});
});

test('validateFile: a bad gate.signal is reported (it passed before opts were built)', () => {
  const { root, processDir, home } = scratchProject();
  const file = workflow(root, 'greenhouse-bad-signal', [
    '    gate:', '      kind: human', '      signal: seedling-sprouted',
  ]);
  const res = validate.validateFile(file, { processDir, templates: new Set(), home });
  assert.strictEqual(res.ok, false);
  assert.ok(res.errors.some((e) => /gate\.signal `seedling-sprouted` is not in config\.gates\.human_signals/.test(e.msg)),
    JSON.stringify(res.errors));
});

test('validateFile: a clean workflow is ok, and a missing skill or agent is named', () => {
  const { root, processDir, home } = scratchProject();
  const good = workflow(root, 'greenhouse-good', [
    '    skills: [greenhouse-watering]', '    agents: [soil-reviewer]',
  ]);
  assert.deepStrictEqual(validate.validateFile(good, { processDir, templates: new Set(), home }), { ok: true, errors: [] });
  const bad = workflow(root, 'greenhouse-missing', [
    '    skills: [compost-turner]', '    agents: [pest-reviewer]',
  ]);
  const msgs = validate.validateFile(bad, { processDir, templates: new Set(), home }).errors.map((e) => e.msg);
  assert.ok(msgs.some((m) => /skill `compost-turner` is not on disk/.test(m)));
  assert.ok(msgs.some((m) => /agent `pest-reviewer` is not on disk/.test(m)));
});

test('validateFile: an unreadable file is an error, not a throw', () => {
  const res = validate.validateFile(path.join(os.tmpdir(), 'plt-no-such-greenhouse.md'), { processDir: null, templates: new Set() });
  assert.strictEqual(res.ok, false);
  assert.ok(/cannot read file/.test(res.errors[0].msg));
});

test('bin/plt re-exports the moved validator', () => {
  const plt = require(PLT);
  assert.strictEqual(plt.validateWorkflow, validate.validateWorkflow);
  assert.strictEqual(plt.findDependencyCycle, validate.findDependencyCycle);
});

test('lib/validate owns the `validate` verb through the registry', () => {
  assert.ok(Array.isArray(validate.commands));
  assert.ok(validate.commands.some((c) => c.name === 'validate' && typeof c.handler === 'function'));
});

test('cli: plt validate <file> --project runs the config check', () => {
  const { root } = scratchProject();
  const file = workflow(root, 'greenhouse-cli-signal', [
    '    gate:', '      kind: human', '      signal: seedling-sprouted',
  ]);
  // A fake HOME, so the result cannot depend on the skills and agents of the machine running it.
  const env = { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'plt-validate-clihome-')) };
  delete env.PLT_PROCESS_DIR;
  const res = spawnSync('node', [PLT, 'validate', file, '--project', root], { cwd: REPO, encoding: 'utf8', env });
  assert.strictEqual(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /gate\.signal `seedling-sprouted` is not in config\.gates\.human_signals/);
});

// A key the validator checked and no runtime path read is now an error, not a green
// `plt validate` with no behaviour behind it.
const DEAD_KEYS = [
  ['gate.quorum', ['    gate:', '      kind: human', '      signal: artifact-approved', '      quorum: all']],
  ['gate.timeout', ['    gate:', '      kind: human', '      signal: artifact-approved', '      timeout: 30m']],
  ['gate.max_open_severity', ['    gate:', '      kind: human', '      signal: artifact-approved', '      max_open_severity: low']],
  ['gate.by', ['    gate:', '      kind: human', '      signal: artifact-approved', '      by: owner']],
  ['model', ['    model: opus']],
  ['reasoning', ['    reasoning: high']],
  ['jira.sprint', ['    jira:', '      sprint: active']],
];
for (const [key, lines] of DEAD_KEYS) {
  test(`validateFile: \`${key}\` is read by nothing, so it is an error`, () => {
    const { root, processDir, home } = scratchProject();
    const file = workflow(root, `greenhouse-dead-${key.replace(/\./g, '-').replace(/_/g, '-')}`, lines);
    const res = validate.validateFile(file, { processDir, templates: new Set(), home });
    assert.strictEqual(res.ok, false);
    const want = `step \`plant\`: key \`${key}\` is not read by anything, so it has no effect — remove it`;
    assert.deepStrictEqual(res.errors.map((e) => e.msg), [want]);
  });
}

test('validateFile: `on_fail` still validates (kept on purpose, not yet executed)', () => {
  const { root, processDir, home } = scratchProject();
  const file = workflow(root, 'greenhouse-on-fail', [
    '    on_fail: { retry: 2, then: water }', '  - id: water', '    assignee: agent',
  ]);
  assert.deepStrictEqual(validate.validateFile(file, { processDir, templates: new Set(), home }), { ok: true, errors: [] });
  const bad = workflow(root, 'greenhouse-on-fail-bad', ['    on_fail: { retry: two, then: compost }']);
  const msgs = validate.validateFile(bad, { processDir, templates: new Set(), home }).errors.map((e) => e.msg);
  assert.ok(msgs.some((m) => /on_fail\.retry` must be a non-negative integer/.test(m)), JSON.stringify(msgs));
  assert.ok(msgs.some((m) => /on_fail\.then references unknown step `compost`/.test(m)), JSON.stringify(msgs));
});

test('validateFile: the verify.gh allowlist is the collector\'s own list, plus `pr-facts`', () => {
  const { GH_FACT_NAMES } = require('../lib/facts');
  const { root, processDir, home } = scratchProject();
  const check = (name) => validate.validateFile(workflow(root, `greenhouse-gh-${name.replace(/_/g, '-')}`, [
    '    verify:', `      gh: [${name}]`,
  ]), { processDir, templates: new Set(), home });
  for (const name of [...GH_FACT_NAMES, 'pr-facts']) assert.deepStrictEqual(check(name), { ok: true, errors: [] }, name);
  // `-` and `_` are one character to the collector (spine.normalizeGhName), so both spellings pass.
  assert.deepStrictEqual(check('checks_green'), { ok: true, errors: [] });
  assert.deepStrictEqual(check('review-approved'), { ok: true, errors: [] });
  // `approved` was on the old hard-coded list and nothing ever produced it.
  for (const name of ['approved', 'seedling-sprouted']) {
    const res = check(name);
    assert.strictEqual(res.ok, false, name);
    assert.match(res.errors[0].msg, new RegExp(`verify\\.gh \`${name}\` is unknown`));
  }
});
