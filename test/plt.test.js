'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PLT = path.join(REPO, 'bin', 'plt');
const FIXTURES = path.join(__dirname, 'fixtures');

const plt = require(PLT);

function run(args, env = {}) {
  const res = spawnSync('node', [PLT, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// ------------------------------------------------------------- frontmatter

test('parseFrontmatter: scalars, inline lists, block list of maps', () => {
  const { fm, errors } = plt.parseFrontmatter(
    [
      '---',
      'name: sample',
      'kind: template',
      'domain: personal            # trailing comment',
      'inputs:',
      '  - name: week_notes',
      '    exemplar: "raw bullets"',
      '  - name: other',
      '    exemplar: plain text',
      'output: markdown',
      'tags: [review, writing]',
      '---',
      'body',
    ].join('\n')
  );
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(fm.name, 'sample');
  assert.strictEqual(fm.domain, 'personal');
  assert.deepStrictEqual(fm.tags, ['review', 'writing']);
  assert.strictEqual(fm.inputs.length, 2);
  assert.strictEqual(fm.inputs[0].name, 'week_notes');
  assert.strictEqual(fm.inputs[0].exemplar, 'raw bullets');
  assert.strictEqual(fm.inputs[1].exemplar, 'plain text');
});

test('parseFrontmatter: missing and unterminated frontmatter', () => {
  assert.strictEqual(plt.parseFrontmatter('# no fm').fm, null);
  assert.match(plt.parseFrontmatter('# no fm').errors[0].msg, /missing frontmatter/);
  assert.match(plt.parseFrontmatter('---\nname: x\n').errors[0].msg, /unterminated/);
});

test('parseFrontmatter: flags unparseable lines with line numbers', () => {
  const { errors } = plt.parseFrontmatter('---\nname: x\n   ???\n---\n');
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].line, 3);
});

test('parseScalar: quotes, inline lists, comments', () => {
  assert.strictEqual(plt.parseScalar('"quoted # not comment"'), 'quoted # not comment');
  assert.strictEqual(plt.parseScalar('bare  # comment'), 'bare');
  assert.deepStrictEqual(plt.parseScalar('[a, "b c", d]'), ['a', 'b c', 'd']);
});

// -------------------------------------------------------------- validation

const PACKS = [
  'templates/packs/core/weekly-review.md',
  'templates/packs/core/research-brief.md',
  'templates/packs/core/purchase-decision.md',
];

for (const p of PACKS) {
  test(`validateFile accepts shipped pack ${path.basename(p)}`, () => {
    const errors = plt.validateFile(path.join(REPO, p));
    assert.deepStrictEqual(errors, []);
  });
}

test('validateFile rejects file without frontmatter', () => {
  const errors = plt.validateFile(path.join(FIXTURES, 'no-frontmatter.md'));
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].line, 1);
  assert.match(errors[0].msg, /missing frontmatter/);
});

test('validateFile rejects input without exemplar', () => {
  const errors = plt.validateFile(path.join(FIXTURES, 'missing-exemplar.md'));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].msg, /`topic` is missing an `exemplar`/);
});

test('validateFile rejects missing Output shape section', () => {
  const errors = plt.validateFile(path.join(FIXTURES, 'no-shape.md'));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].msg, /missing `## Output shape`/);
});

test('validateFile rejects thin golden exemplar', () => {
  const errors = plt.validateFile(path.join(FIXTURES, 'thin-exemplar.md'));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].msg, /too thin/);
});

test('validateFile rejects frontmatter name that mismatches filename', () => {
  const errors = plt.validateFile(path.join(FIXTURES, 'name-mismatch.md'));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].msg, /does not match filename/);
});

test('findSection: golden exemplar may contain ## headings (toEnd)', () => {
  const body = ['## Golden exemplar', '', '# Title', '', '## Wins', 'text'];
  const sec = plt.findSection(body, 1, 'Golden exemplar', { toEnd: true });
  assert.ok(sec.content.includes('## Wins'));
});

test('findSection: headings inside code fences are ignored', () => {
  const body = ['## Output shape', '```markdown', '## Fake heading', '```', 'tail', '## Next'];
  const sec = plt.findSection(body, 1, 'Output shape');
  assert.ok(sec.content.includes('## Fake heading'));
  assert.ok(sec.content.includes('tail'));
  assert.ok(!sec.content.includes('## Next'));
});

// --------------------------------------------------------------------- CLI

test('cli: validate all passes on the shipped packs', () => {
  const { status, stdout } = run(['validate', 'all']);
  assert.strictEqual(status, 0);
  for (const p of PACKS) assert.ok(stdout.includes(`OK    ${p}`), `expected OK for ${p}`);
});

test('cli: validate a bad fixture fails with file:line message', () => {
  const { status, stdout } = run(['validate', path.join(FIXTURES, 'thin-exemplar.md')]);
  assert.strictEqual(status, 1);
  assert.match(stdout, /thin-exemplar\.md:\d+: .*too thin/);
});

test('cli: validate the fixtures directory fails', () => {
  const { status } = run(['validate', FIXTURES]);
  assert.strictEqual(status, 1);
});

test('cli: list shows the three pack templates as a table', () => {
  const { status, stdout } = run(['list']);
  assert.strictEqual(status, 0);
  assert.match(stdout, /NAME\s+KIND\s+TAGS\s+PATH/);
  for (const name of ['weekly-review', 'research-brief', 'purchase-decision']) {
    assert.ok(stdout.includes(name));
  }
});

test('cli: list --tag filters', () => {
  const { stdout } = run(['list', '--tag', 'purchase']);
  assert.ok(stdout.includes('purchase-decision'));
  assert.ok(!stdout.includes('weekly-review'));
});

test('cli: list --domain filters', () => {
  const { stdout } = run(['list', '--domain', 'personal']);
  assert.ok(stdout.includes('weekly-review'));
  assert.ok(!stdout.includes('research-brief'));
});

test('cli: list --kind splits templates from workflows', () => {
  const templates = run(['list', '--kind', 'template']).stdout;
  assert.ok(templates.includes('weekly-review'));
  assert.ok(!templates.includes('research-and-buy'));
  const workflows = run(['list', '--kind', 'workflow']).stdout;
  assert.ok(workflows.includes('research-and-buy'));
  assert.ok(!workflows.includes('templates/packs')); // no template rows
});

test('cli: list --tag with no matches prints only the header', () => {
  const { stdout } = run(['list', '--tag', 'no-such-tag']);
  assert.strictEqual(stdout.trim().split('\n').length, 1);
});

test('cli: show prints the full template markdown', () => {
  const { status, stdout } = run(['show', 'weekly-review']);
  assert.strictEqual(status, 0);
  assert.ok(stdout.startsWith('---\nname: weekly-review'));
  assert.ok(stdout.includes('## Output shape'));
  assert.ok(stdout.includes('## Golden exemplar'));
  assert.ok(stdout.includes('week of 2026-03-09')); // exemplar body present
});

test('cli: show unknown name exits 1', () => {
  const { status, stderr } = run(['show', 'no-such-template']);
  assert.strictEqual(status, 1);
  assert.match(stderr, /no template or workflow named/);
});

test('cli: no/unknown subcommand prints usage and exits 2', () => {
  assert.strictEqual(run([]).status, 2);
  assert.strictEqual(run(['bogus']).status, 2);
  assert.match(run([]).stderr, /usage:/);
});

test('cli: PUNCHLIST_TEMPLATES_DIR overrides repo root', () => {
  const { status, stdout } = run(['list'], { PUNCHLIST_TEMPLATES_DIR: REPO });
  assert.strictEqual(status, 0);
  assert.ok(stdout.includes('weekly-review'));
});

// ------------------------------------------------------------------- skills

const fs = require('fs');
const os = require('os');
const SCAFFOLD = path.join(REPO, 'skills', 'shared', 'wf-scaffold.sh');

function scaffold(name, root) {
  return spawnSync('bash', [SCAFFOLD, name], {
    encoding: 'utf8',
    env: { ...process.env, PUNCHLIST_TEMPLATES_DIR: root },
  });
}

test('wf-scaffold: writes a skeleton and refuses to overwrite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-scaffold-'));
  const res = scaffold('my-flow', root);
  assert.strictEqual(res.status, 0);
  const file = path.join(root, 'workflows', 'authored', 'my-flow.md');
  assert.strictEqual(res.stdout.trim(), file);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('---\nname: my-flow\nkind: workflow'));
  // one commented example of each edge kind
  for (const kw of ['needs:', 'outcomes:', 'when:', 'else_of:', 'on_fail:', 'repeat_until:']) {
    assert.ok(text.includes(kw), `skeleton mentions ${kw}`);
  }
  const again = scaffold('my-flow', root);
  assert.notStrictEqual(again.status, 0);
  assert.match(again.stderr, /refusing to overwrite/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('wf-scaffold: rejects bad names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-scaffold-'));
  for (const bad of ['My Flow', 'UPPER', 'a_b', '-lead', 'trail-', ''])
    assert.notStrictEqual(scaffold(bad, root).status, 0, `rejects \`${bad}\``);
  fs.rmSync(root, { recursive: true, force: true });
});

test('wf-scaffold: validates with only the first step uncommented', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-scaffold-'));
  scaffold('my-flow', root);
  const file = path.join(root, 'workflows', 'authored', 'my-flow.md');
  const text = fs.readFileSync(file, 'utf8');
  // uncomment exactly the first step's three lines
  const first = text
    .replace('#  - id: first', '  - id: first')
    .replace('#    assignee: owner', '    assignee: owner')
    .replace('#    title: "Do the first thing"', '    title: "Do the first thing"');
  fs.writeFileSync(file, first);
  const res = run(['validate', file], { PUNCHLIST_TEMPLATES_DIR: root });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
});

test('wf-scaffold: validates and renders fully uncommented', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-scaffold-'));
  scaffold('my-flow', root);
  const file = path.join(root, 'workflows', 'authored', 'my-flow.md');
  const text = fs.readFileSync(file, 'utf8').replace(/^#( {2,})/gm, '$1');
  fs.writeFileSync(file, text);
  assert.strictEqual(run(['validate', file], { PUNCHLIST_TEMPLATES_DIR: root }).status, 0);
  assert.strictEqual(run(['render', 'my-flow'], { PUNCHLIST_TEMPLATES_DIR: root }).status, 0);
  assert.ok(fs.readFileSync(file, 'utf8').includes('```mermaid'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('skills: every SKILL.md has frontmatter and a name matching its dir', () => {
  const skillFiles = [];
  for (const agent of ['claude', 'hermes']) {
    const dir = path.join(REPO, 'skills', agent);
    for (const entry of fs.readdirSync(dir)) {
      const f = path.join(dir, entry, 'SKILL.md');
      if (fs.existsSync(f)) skillFiles.push({ dir: entry, file: f });
    }
  }
  assert.ok(skillFiles.length >= 4, 'expected resolver + writer skills for both agents');
  for (const { dir, file } of skillFiles) {
    const { fm } = plt.parseFrontmatter(fs.readFileSync(file, 'utf8'));
    assert.ok(fm, `${file} has frontmatter`);
    assert.strictEqual(fm.name, dir, `${file} name matches its directory`);
    assert.ok(fm.description && String(fm.description).length > 20, `${file} has a description`);
  }
});

// ------------------------------------------------------------ coding-task + index

test('validateFile accepts the coding-task pack template', () => {
  const errors = plt.validateFile(path.join(REPO, 'templates/packs/core/coding-task.md'));
  assert.deepStrictEqual(errors, []);
});

test('buildIndex: one row per template (not workflows), sorted, with the bridge fields', () => {
  const idx = plt.buildIndex();
  assert.ok(Array.isArray(idx.templates));
  const names = idx.templates.map((t) => t.name);
  assert.ok(names.includes('coding-task'));
  assert.ok(!names.some((n) => n === 'research-and-buy')); // workflows excluded
  assert.deepStrictEqual(names, [...names].sort()); // stable sort by name
  const coding = idx.templates.find((t) => t.name === 'coding-task');
  assert.deepStrictEqual(coding, {
    name: 'coding-task', kind: 'template', tags: ['code', 'engineering', 'tdd'],
    domain: 'engineering', output: 'markdown', path: 'templates/packs/core/coding-task.md',
  });
});

test('cli: plt index regenerates templates/index.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-index-'));
  // minimal repo: bin (via PUNCHLIST_TEMPLATES_DIR) + one template file
  fs.mkdirSync(path.join(root, 'templates', 'packs', 'core'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'templates/packs/core/coding-task.md'),
    path.join(root, 'templates/packs/core/coding-task.md'));
  const res = run(['index'], { PUNCHLIST_TEMPLATES_DIR: root });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'templates', 'index.json'), 'utf8'));
  assert.strictEqual(idx.templates.length, 1);
  assert.strictEqual(idx.templates[0].name, 'coding-task');
  assert.strictEqual(idx.templates[0].path, 'templates/packs/core/coding-task.md');
  // idempotent: a second run reports "up to date" and leaves the file identical
  const before = fs.readFileSync(path.join(root, 'templates', 'index.json'), 'utf8');
  const again = run(['index'], { PUNCHLIST_TEMPLATES_DIR: root });
  assert.match(again.stdout, /up to date/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'templates', 'index.json'), 'utf8'), before);
  fs.rmSync(root, { recursive: true, force: true });
});

test('committed templates/index.json is in sync with the templates on disk', () => {
  // the generated bridge file must be committed fresh — buildIndex matches it
  const onDisk = JSON.parse(fs.readFileSync(path.join(REPO, 'templates', 'index.json'), 'utf8'));
  assert.deepStrictEqual(onDisk, plt.buildIndex());
});
