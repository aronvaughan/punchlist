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

// ------------------------------------------------- the scope slot on `lands` pages

const LANDS_PAGES = [
  'templates/packs/core/pre-commit-summary.md',
  'templates/packs/core/pre-pr-summary.md',
  'templates/packs/core/fix-summary.md',
  'templates/packs/core/pre-push-review.md',
];

for (const p of LANDS_PAGES) {
  test(`${path.basename(p)} is tagged lands and declares the scope slot directly after meta`, () => {
    const text = require('fs').readFileSync(path.join(REPO, p), 'utf8');
    assert.ok(plt.parseFrontmatter(text).fm.tags.includes('lands'), 'tagged lands, so the validator checks it');
    assert.match(text, /<!-- slot:scope required source=git -->/);
    assert.deepStrictEqual(plt.validateFile(path.join(REPO, p)), []);
  });
}

// A `lands` template with the given slot lines, written to a temp dir under its own name.
function landsTemplate(slotLines, tags = '[spine, gate, lands]') {
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-lands-'));
  const file = path.join(dir, 'approval-page.md');
  fs.writeFileSync(file, [
    '---', 'name: approval-page', 'kind: template', `tags: ${tags}`,
    'inputs:', '  - name: card', '    exemplar: "TRK-42"', 'output: markdown', '---', '',
    '## Output shape', '',
    ...slotLines.flatMap((s) => [s, 'Body text.', '<!-- /slot -->']), '',
    '## Golden exemplar', '',
    'Card TRK-42 · branch feat/TRK-42 · repo soil-station at ~/code/soil-station · origin private ·',
    'lands on local main by fast-forward · pushes in scope: none · origin/main is not in scope.',
    'Gates: unit 212 pass. Findings: none open. On approval the base branch fast-forwards.',
  ].join('\n'));
  return file;
}

test('validateFile rejects a lands template with no scope slot', () => {
  const errors = plt.validateFile(landsTemplate(['<!-- slot:meta required source=state -->', '<!-- slot:diff required source=git -->']));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].msg, /tagged `lands` must declare `<!-- slot:scope required source=git -->`/);
});

test('validateFile rejects a scope slot that is not directly after meta', () => {
  const errors = plt.validateFile(landsTemplate([
    '<!-- slot:meta required source=state -->', '<!-- slot:gates required source=events -->', '<!-- slot:scope required source=git -->',
  ]));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].msg, /directly after `meta`/);
});

test('validateFile rejects a scope slot that is optional or names no source', () => {
  const msgs = plt.validateFile(landsTemplate(['<!-- slot:meta required source=state -->', '<!-- slot:scope -->'])).map((e) => e.msg);
  assert.strictEqual(msgs.length, 2);
  assert.ok(msgs.some((m) => /must be `required`/.test(m)));
  assert.ok(msgs.some((m) => /must name its `source=`/.test(m)));
});

test('validateFile wants scope first on a lands template with no meta slot', () => {
  assert.deepStrictEqual(plt.validateFile(landsTemplate(['<!-- slot:scope required source=git -->', '<!-- slot:diff required source=git -->'])), []);
  const errors = plt.validateFile(landsTemplate(['<!-- slot:diff required source=git -->', '<!-- slot:scope required source=git -->']));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].msg, /must be the first slot/);
});

test('validateFile ignores a slot opener inside a code fence', () => {
  const errors = plt.validateFile(landsTemplate(['```', '<!-- slot:scope required source=git -->', '```']));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].msg, /must declare/);
});

test('validateFile ignores a slot opener inside a ~~~ fence or an indented code block', () => {
  for (const block of [['~~~', '<!-- slot:scope required source=git -->', '~~~'], ['    <!-- slot:scope required source=git -->']]) {
    const errors = plt.validateFile(landsTemplate(['<!-- slot:meta required source=state -->', ...block]));
    assert.strictEqual(errors.length, 1, block[0]);
    assert.match(errors[0].msg, /must declare/);
  }
});

test('validateFile keeps a longer fence open past a shorter run or an info-string line', () => {
  const nested = ['````markdown', '```', '<!-- slot:scope required source=git -->', '```', '````'];
  // The trailing ``` keeps findSection's own fence count even, so the exemplar stays visible.
  const info = ['```', '```js', '<!-- slot:scope required source=git -->', '```', '```'];
  for (const block of [nested, info]) {
    const errors = plt.validateFile(landsTemplate(['<!-- slot:meta required source=state -->', ...block]));
    assert.strictEqual(errors.length, 1, block.join(' '));
    assert.match(errors[0].msg, /must declare/);
  }
});

test('validateFile reads slots from Output shape only, not from the golden exemplar', () => {
  const file = landsTemplate(['<!-- slot:meta required source=state -->']);
  const fs = require('fs');
  fs.appendFileSync(file, '\n<!-- slot:scope required source=git -->\n');
  const errors = plt.validateFile(file);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].msg, /must declare/);
  assert.strictEqual(errors[0].line, 11, 'points at the ## Output shape heading');
});

test('validateFile rejects a scope slot declared twice', () => {
  const errors = plt.validateFile(landsTemplate([
    '<!-- slot:meta required source=state -->', '<!-- slot:scope required source=git -->', '<!-- slot:scope -->',
  ]));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].msg, /declared twice/);
});

test('validateFile checks a lands tag written as a scalar', () => {
  for (const tags of ['lands', '"gate, lands"']) {
    const errors = plt.validateFile(landsTemplate(['<!-- slot:meta required source=state -->'], tags));
    assert.strictEqual(errors.length, 1, tags);
    assert.match(errors[0].msg, /must declare/);
  }
});

test('validateFile accepts a > inside a slot attribute', () => {
  assert.deepStrictEqual(plt.validateFile(landsTemplate([
    '<!-- slot:meta required source=state -->', '<!-- slot:scope required source=git hint="a>b" -->',
  ])), []);
});

test('validateFile does not ask for a scope slot on a template not tagged lands', () => {
  assert.deepStrictEqual(plt.validateFile(landsTemplate(['<!-- slot:meta required source=state -->'], '[spine, gate]')), []);
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


// ---------------------------------------------------------------- help derivation
//
// `plt help` prints each command's OWN declared usage. It used to keep a hand-written copy of
// every usage line and the copies drifted: `plt fan` grew `--unblock` (declared in lib/fan.js,
// refused by name when misused) while the help described the older command, and `deps`, `doctor`
// and `repo` never reached the help at all. Deriving the help only helps if the declarations are
// complete and if the hand-written prose around them cannot name things that do not exist, so
// these tests hold three properties: the printed usage IS the declaration, the declaration names
// every subverb its module dispatches, and the prose invents no verb and no flag.

const registry = require(path.join(REPO, 'lib', 'registry.js'));
const spineCli = require(path.join(REPO, 'lib', 'spine-cli.js'));

// Every verb the CLI can dispatch: the lib modules the registry discovers, plus the few verbs
// bin/plt still implements itself — the same two sources dispatch() merges.
function declaredUsages() {
  const map = new Map();
  for (const [name, c] of registry.discoverCommands(path.join(REPO, 'lib'))) map.set(name, c.usage);
  for (const c of plt.commands) if (!map.has(c.name)) map.set(c.name, c.usage || `plt ${c.name}`);
  return map;
}

// A declaration separates whole alternatives with ` | ` before another `plt `; a bare `|` inside
// one alternative (`[--run ID | --all]`, `check|approve|revoke`) is part of that line. Spelled out
// here rather than imported, so the test judges the help and not the code that built it.
function alternativesOf(usage) {
  return String(usage).split(/ \| (?=plt )/).map((u) => u.trim());
}

function allAlternatives() {
  const out = new Set();
  for (const usage of declaredUsages().values()) for (const a of alternativesOf(usage)) out.add(a);
  return out;
}

// The bare subverbs a declaration names: the words between the verb and the first placeholder or
// flag. `plt gate check|approve|revoke <run>` declares check, approve and revoke; `plt watch
// [--once]` declares none, and a command that declares none cannot be checked for one.
function declaredSubverbs(usage) {
  const set = new Set();
  for (const alt of alternativesOf(usage)) {
    for (const tok of alt.split(/\s+/).slice(2)) {
      if (!/^[a-z][a-z0-9|-]*$/.test(tok)) break;
      for (const part of tok.split('|')) set.add(part);
    }
  }
  return set;
}

function pltHelp() {
  const res = spawnSync(process.execPath, [PLT, 'help'], { cwd: REPO, encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  return res.stdout;
}

// The usage lines the help printed, folded back into single strings: a usage alternative starts
// at indent 2 with `plt `, and a line at indent 5 continues the one above it.
function printedUsages(help) {
  const out = [];
  let open = false;
  for (const line of help.split('\n')) {
    if (/^\s*plt [a-z]/.test(line)) { out.push(line.trim()); open = /^ {2}plt /.test(line); }
    else if (open && /^ {5}\S/.test(line)) out[out.length - 1] += ' ' + line.trim();
    else open = false;
  }
  return out;
}

test('plt help prints every command usage exactly as the command declares it', () => {
  const printed = new Set(printedUsages(pltHelp()));
  for (const [name, usage] of declaredUsages()) {
    for (const alt of alternativesOf(usage)) {
      assert.ok(printed.has(alt), `plt help does not print ${name}'s declared usage: ${alt}`);
    }
  }
});

test('plt help invents no usage line of its own — at any indent', () => {
  const declared = allAlternatives();
  const printed = printedUsages(pltHelp());
  assert.ok(printed.length >= declared.size, `plt help printed only ${printed.length} usage lines`);
  for (const line of printed) {
    assert.ok(declared.has(line), `plt help prints a usage line no command declares: ${line}`);
  }
});

test('a builtin verb argument error prints that verb\'s declared usage, not a copy of it', () => {
  const declared = declaredUsages();
  for (const verb of ['show', 'render', 'launch']) {
    const res = spawnSync(process.execPath, [PLT, verb], { cwd: REPO, encoding: 'utf8' });
    assert.strictEqual(res.status, 2, `plt ${verb} with no argument should exit 2`);
    assert.strictEqual(res.stderr, `usage: ${declared.get(verb)}\n`, `plt ${verb} error line`);
  }
});

// The same string, not two that happen to agree: lib/spine-cli exports the constant its error
// path throws, and the descriptor must be that constant.
test('a spine-cli verb declares one usage string, used by its error path and its descriptor', () => {
  const pairs = [['run', 'RUN_USAGE'], ['step', 'STEP_USAGE'], ['gate', 'GATE_USAGE'],
    ['receipt', 'RECEIPT_USAGE'], ['menu', 'MENU_USAGE'], ['effort', 'EFFORT_USAGE'],
    ['digest', 'DIGEST_USAGE']];
  for (const [verb, constant] of pairs) {
    const declared = spineCli.commands.find((c) => c.name === verb);
    assert.ok(declared, `lib/spine-cli declares no ${verb} command`);
    assert.ok(spineCli[constant], `lib/spine-cli exports no ${constant}`);
    assert.strictEqual(declared.usage, spineCli[constant], `${verb}: descriptor is not ${constant}`);
  }
});

// The declaration must name what the module actually dispatches. These lists are the subverbs
// lib/spine-cli branches on: `sub === 'unstart'`, `o._[0] === 'poll'`, `sub === 'revoke'`, …
test('a declaration names every subverb its module dispatches', () => {
  const dispatched = {
    run: ['launch', 'recompile', 'discard', 'close', 'poll'],
    step: ['start', 'unstart', 'finish', 'block', 'answer'],
    gate: ['check', 'approve', 'revoke'],
    menu: ['parse', 'words', 'json'],
    effort: ['plan', 'launch'],
    digest: ['launch', 'collect', 'standup'],
  };
  const declared = declaredUsages();
  const help = pltHelp();
  for (const [verb, subs] of Object.entries(dispatched)) {
    const named = declaredSubverbs(declared.get(verb));
    for (const sub of subs) {
      assert.ok(named.has(sub), `plt ${verb} dispatches "${sub}" and its usage does not name it`);
      assert.ok(help.includes(`plt ${verb} ${sub}`) || help.includes(`${sub}|`) || help.includes(`|${sub}`),
        `plt help never shows plt ${verb} ${sub}`);
    }
  }
});

// ------------------------------------------------- the prose around the declarations
//
// Deriving the usage lines is worth nothing if the hand-written prose beside them can name a
// command or a flag that does not exist. The old tail said `step start|unstart|finish|block|
// answer … take --take-over` while the step descriptor named only start and finish.

// Everything the help prints that is NOT a declared usage line: the descriptions, the notes and
// the epilogue. Read back from the rendered text, so the check does not care how it was built.
function proseText(help) {
  const out = [];
  let open = false;
  for (const line of help.split('\n').slice(1)) { // line 1 is the banner, not prose
    if (/^\s*plt [a-z]/.test(line)) { open = /^ {2}plt /.test(line); continue; }
    if (open && /^ {5}\S/.test(line)) continue;
    open = false;
    out.push(line.trim());
  }
  return out.join(' ');
}

function backtickSpans(text) {
  return (text.match(/`[^`]*`/g) || []).map((s) => s.slice(1, -1));
}

test('help prose names a command only in backticks — and only a command that exists', () => {
  const prose = proseText(pltHelp());
  const outside = prose.replace(/`[^`]*`/g, '');
  assert.ok(!/\bplt\b/.test(outside), `the help names plt outside a usage line and outside backticks: ${outside}`);
  const declared = declaredUsages();
  const spans = backtickSpans(prose);
  for (const span of spans) {
    const m = /\bplt\s+([a-z][a-z0-9-]*)((?:\s+\S+)*)/.exec(span);
    if (!m) continue;
    assert.ok(declared.has(m[1]), `help names a command that does not exist: plt ${m[1]}`);
    const subs = declaredSubverbs(declared.get(m[1]));
    for (const tok of m[2].trim().split(/\s+/).filter(Boolean)) {
      if (!/^[a-z][a-z0-9|-]*$/.test(tok)) break;
      for (const part of tok.split('|')) {
        assert.ok(subs.has(part), `help names \`plt ${m[1]} ${part}\`, which plt ${m[1]} does not declare`);
      }
    }
  }
});

test('every --flag the help prints is declared by some command', () => {
  const declaredText = [...declaredUsages().values()].join(' ');
  for (const flag of pltHelp().match(/--[a-z][a-z0-9-]*/g) || []) {
    assert.ok(declaredText.includes(flag), `plt help names ${flag}, which no command declares`);
  }
});

test('usage alternation stays inside usage lines — prose spells it out in words', () => {
  const usage = new Set(printedUsages(pltHelp()));
  for (const line of pltHelp().split('\n')) {
    if (/^\s*plt [a-z]/.test(line) || /^ {5}\S/.test(line)) continue;
    const alt = /[a-z]\|[a-z]/.exec(line);
    assert.ok(!alt, `prose spells a usage alternation: ${line.trim()}`);
  }
  assert.ok(usage.size > 0);
});

test('no help line runs past the width the terminal is given', () => {
  for (const line of pltHelp().split('\n')) {
    assert.ok(line.length <= 96, `help line is ${line.length} chars: ${line}`);
  }
});

// ------------------------------------------------------------- the builder itself

test('helpText: a verb no order list mentions still prints, and a descriptor with no usage falls back', () => {
  const declared = new Map([
    ['validate', { usage: 'plt validate [path|all] [--project <dir>]' }],
    ['zzunlisted', { usage: 'plt zzunlisted --flagless' }],
    ['bare', {}],
  ]);
  const text = plt.helpText(declared);
  assert.ok(text.includes('  plt zzunlisted --flagless'), 'a verb outside HELP_ORDER must still print');
  assert.ok(text.includes('  plt bare\n'), 'a descriptor with no usage falls back to the bare verb');
  // ordered verbs first, then the unlisted ones by name
  assert.ok(text.indexOf('plt validate') < text.indexOf('plt bare'), 'HELP_ORDER comes first');
  assert.ok(text.indexOf('plt bare') < text.indexOf('plt zzunlisted'), 'unlisted verbs sort by name');
});

test('a builtin that collides with a lib verb stops the help, as it stops dispatch', () => {
  assert.throws(
    () => plt.mergeBuiltins(new Map([['fan', { usage: 'plt fan <plan-file>', module: 'fan.js' }]]),
      [{ name: 'fan', usage: 'plt fan whatever' }]),
    /duplicate command "fan" in fan\.js and <builtin>/,
  );
});
