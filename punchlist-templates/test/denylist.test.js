'use strict';
// denylist.test.js — drives scripts/denylist-scan.sh and scripts/install-hooks.sh (repo-root
// private-plane scripts, R3) through spawnSync in a throwaway git repo whose layout mirrors the
// real one: a scripts/ dir at the fixture root and a punchlist-templates/ subdirectory.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..'); // the repo root, above punchlist-templates/
const SCRIPTS_SRC = path.join(REPO_ROOT, 'scripts');

function run(cwd, cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', ...opts });
}

function tmpRepoWithTerms(words) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-repo-'));
  run(repo, 'git', ['init', '-q', '-b', 'master']);
  run(repo, 'git', ['config', 'user.email', 'test@example.com']);
  run(repo, 'git', ['config', 'user.name', 'Test']);

  // Mirror the real layout: scripts/ at the fixture root, punchlist-templates/ subdirectory.
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  for (const f of ['denylist-patterns.sh', 'denylist-scan.sh', 'install-hooks.sh']) {
    fs.copyFileSync(path.join(SCRIPTS_SRC, f), path.join(repo, 'scripts', f));
    fs.chmodSync(path.join(repo, 'scripts', f), 0o755);
  }
  fs.mkdirSync(path.join(repo, 'punchlist-templates', 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'punchlist-templates', 'README.md'), '# fixture\n');
  run(repo, 'git', ['add', 'scripts', 'punchlist-templates/README.md']);
  run(repo, 'git', ['commit', '-q', '-m', 'init']);

  const termsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-terms-'));
  const terms = path.join(termsDir, 'terms.txt');
  fs.writeFileSync(terms, words.join('\n') + '\n', { mode: 0o600 });
  return { repo, terms };
}

function scan(repo, args, env) {
  return run(repo, path.join(repo, 'scripts', 'denylist-scan.sh'), args, {
    env: { ...process.env, ...env },
  });
}

// publish.sh requires gitleaks. A stub on PATH stands in for it, so these tests run on a machine
// without the scanner and can make it pass (exit 0) or find something (exit 1).
function stubGitleaks(exitCode = 0) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-bin-'));
  fs.writeFileSync(path.join(bin, 'gitleaks'), `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o755 });
  return bin;
}

// A fixture repo with publish.sh committed, a bare `origin` and a bare `public`. public/master is the
// first commit, so it is an ancestor of everything committed after it.
function publishRepo(words) {
  const { repo, terms } = tmpRepoWithTerms(words);
  fs.copyFileSync(path.join(SCRIPTS_SRC, 'publish.sh'), path.join(repo, 'scripts', 'publish.sh'));
  fs.chmodSync(path.join(repo, 'scripts', 'publish.sh'), 0o755);
  run(repo, 'git', ['add', 'scripts/publish.sh']);
  run(repo, 'git', ['commit', '-q', '-m', 'publish script']);
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-origin-'));
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-public-'));
  run(origin, 'git', ['init', '-q', '--bare']);
  run(pub, 'git', ['init', '-q', '--bare']);
  run(repo, 'git', ['remote', 'add', 'origin', origin]);
  run(repo, 'git', ['remote', 'add', 'public', pub]);
  run(repo, 'git', ['push', '-q', 'public', 'master']);
  return { repo, terms, pub };
}

// Write {relPath: content}, commit it on master and push master to origin. Returns the new sha.
function commitFiles(repo, files, msg = 'work') {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
    run(repo, 'git', ['add', '-f', rel]);
  }
  run(repo, 'git', ['commit', '-q', '-m', msg]);
  run(repo, 'git', ['push', '-q', 'origin', 'master']);
  return run(repo, 'git', ['rev-parse', 'HEAD']).stdout.trim();
}

// A message file outside the repo, so the worktree stays clean.
function messageFile(text) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-msg-')), 'bundle.md');
  fs.writeFileSync(f, text);
  return f;
}

function publish(repo, terms, args, { input, gitleaksExit = 0 } = {}) {
  const bin = stubGitleaks(gitleaksExit);
  return run(repo, path.join(repo, 'scripts', 'publish.sh'), args, {
    input,
    env: { ...process.env, LEAK_TERMS: terms, PATH: `${bin}:${process.env.PATH}` },
  });
}

function publishBranch(repo) {
  return run(repo, 'git', ['branch', '--list', 'publish/*', '--format=%(refname:short)']).stdout.trim();
}

function treeOf(repo, rev) {
  return run(repo, 'git', ['ls-tree', '-r', '--name-only', rev]).stdout.split('\n').filter(Boolean);
}

function installHooks(repo) {
  return run(repo, path.join(repo, 'scripts', 'install-hooks.sh'), []);
}

test('a term from the terms file is a hit, and the word is never printed', () => {
  const { repo, terms } = tmpRepoWithTerms(['acmecorp', 'PROJ-\\d+']);
  fs.writeFileSync(path.join(repo, 'punchlist-templates', 'src', 'a.js'), '// built for acmecorp\n');
  run(repo, 'git', ['add', 'punchlist-templates/src/a.js']);
  const r = scan(repo, ['--staged'], { LEAK_TERMS: terms });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /punchlist-templates\/src\/a\.js:1:/);
  assert.doesNotMatch(r.stdout + r.stderr, /acmecorp/);
});

test('--range names the file and line of a hit, and never prints the word or the line', () => {
  const { repo, terms } = tmpRepoWithTerms(['acmecorp']);
  const base = run(repo, 'git', ['rev-parse', 'HEAD']).stdout.trim();
  fs.writeFileSync(path.join(repo, 'punchlist-templates', 'src', 'b.js'), '// built for acmecorp\n');
  run(repo, 'git', ['add', 'punchlist-templates/src/b.js']);
  run(repo, 'git', ['commit', '-q', '-m', 'b']);
  const r = scan(repo, ['--range', `${base}..HEAD`], { LEAK_TERMS: terms });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^punchlist-templates\/src\/b\.js:1: denylisted string$/m);
  assert.doesNotMatch(r.stdout + r.stderr, /acmecorp|built for/);
});

test('the scan runs under macOS /bin/bash 3.2 (no bash-4 builtins)', { skip: !fs.existsSync('/bin/bash') }, () => {
  const { repo, terms } = tmpRepoWithTerms(['acmecorp']);
  fs.writeFileSync(path.join(repo, 'punchlist-templates', 'src', 'c.js'), '// built for acmecorp\n');
  run(repo, 'git', ['add', 'punchlist-templates/src/c.js']);
  const r = run(repo, '/bin/bash', [path.join(repo, 'scripts', 'denylist-scan.sh'), '--staged'], {
    env: { ...process.env, LEAK_TERMS: terms },
  });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stdout, /^punchlist-templates\/src\/c\.js:1: denylisted string$/m);
  assert.doesNotMatch(r.stderr, /command not found/);
});

test('a clean staged tree passes', () => {
  const { repo, terms } = tmpRepoWithTerms(['acmecorp', 'PROJ-\\d+']);
  fs.writeFileSync(path.join(repo, 'punchlist-templates', 'src', 'clean.js'), '// nothing to see\n');
  run(repo, 'git', ['add', 'punchlist-templates/src/clean.js']);
  assert.strictEqual(scan(repo, ['--staged'], { LEAK_TERMS: terms }).status, 0);
});

test('a missing terms file is exit 2, not a pass', () => {
  const { repo } = tmpRepoWithTerms(['acmecorp']);
  const r = scan(repo, ['--staged'], { LEAK_TERMS: '/nonexistent/terms.txt' });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr + r.stdout, /no terms file/);
});

test('a terms file with no terms is exit 2 with a message, not a silent failure or a pass', () => {
  // Only comments and blank lines: the shape of an unset CI secret. grep matched nothing and,
  // under set -e -o pipefail, the scan used to die here with exit 1 and no output.
  const { repo, terms } = tmpRepoWithTerms(['# nothing here', '']);
  const r = scan(repo, ['--staged'], { LEAK_TERMS: terms });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr + r.stdout, /has no terms/);
});

test('a staged file outside the allowlist is refused by path', () => {
  const { repo, terms } = tmpRepoWithTerms(['acmecorp']);
  fs.writeFileSync(path.join(repo, 'notes.private.md'), 'x\n');
  run(repo, 'git', ['add', '-f', 'notes.private.md']);
  const r = scan(repo, ['--staged'], { LEAK_TERMS: terms });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /notes\.private\.md/);
});

test('a workflow under the repo-root .github/workflows passes the commit gate (PRIVATE_ALLOW); other .github files do not', () => {
  const { repo, terms } = tmpRepoWithTerms(['acmecorp']);
  fs.mkdirSync(path.join(repo, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
  run(repo, 'git', ['add', '.github/workflows/ci.yml']);
  assert.strictEqual(scan(repo, ['--staged'], { LEAK_TERMS: terms }).status, 0);
  fs.writeFileSync(path.join(repo, '.github', 'CODEOWNERS'), '* @someone\n');
  run(repo, 'git', ['add', '.github/CODEOWNERS']);
  const r = scan(repo, ['--staged'], { LEAK_TERMS: terms });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^\.github\/CODEOWNERS:0: outside the publishable paths$/m);
});

// The CI workflows are private-plane: committable (PRIVATE_ALLOW, the pre-commit/CI gate) but never
// published — publish.sh drops them from the release squash.
test('publish.sh --dry-run leaves .github/workflows out of the public squash', () => {
  const { repo, terms } = tmpRepoWithTerms(['acmecorp']);
  fs.copyFileSync(path.join(SCRIPTS_SRC, 'publish.sh'), path.join(repo, 'scripts', 'publish.sh'));
  fs.chmodSync(path.join(repo, 'scripts', 'publish.sh'), 0o755);
  run(repo, 'git', ['add', 'scripts/publish.sh']);
  run(repo, 'git', ['commit', '-q', '-m', 'publish script']);
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-origin-'));
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-public-'));
  run(origin, 'git', ['init', '-q', '--bare']);
  run(pub, 'git', ['init', '-q', '--bare']);
  run(repo, 'git', ['remote', 'add', 'origin', origin]);
  run(repo, 'git', ['remote', 'add', 'public', pub]);
  run(repo, 'git', ['push', '-q', 'public', 'master']);

  fs.mkdirSync(path.join(repo, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
  fs.writeFileSync(path.join(repo, 'punchlist-templates', 'src', 'd.js'), '// public code\n');
  fs.mkdirSync(path.join(repo, 'docs', 'releases'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'releases', 'v0.0.1.md'), 'v0.0.1\n\nA test release.\n');
  run(repo, 'git', ['add', '-f', '.github', 'punchlist-templates/src/d.js', 'docs/releases/v0.0.1.md']);
  run(repo, 'git', ['commit', '-q', '-m', 'work']);
  run(repo, 'git', ['push', '-q', 'origin', 'master']);

  const r = publish(repo, terms, ['v0.0.1', '--dry-run']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const branch = run(repo, 'git', ['branch', '--list', 'publish/*', '--format=%(refname:short)']).stdout.trim();
  const tree = run(repo, 'git', ['ls-tree', '-r', '--name-only', branch]).stdout.split('\n');
  assert.ok(tree.includes('punchlist-templates/src/d.js'), tree.join(','));
  assert.ok(!tree.some((f) => f.startsWith('.github/')), tree.join(','));
  // The private repo keeps them, and the checkout is back on a clean master.
  assert.ok(run(repo, 'git', ['ls-tree', '-r', '--name-only', 'master']).stdout.includes('.github/workflows/ci.yml'));
  assert.strictEqual(run(repo, 'git', ['status', '--porcelain']).stdout, '');
});

test('publish.sh --dry-run names the file and line of a denylist hit, never the word or the line', () => {
  const { repo, terms } = tmpRepoWithTerms(['zqxtermword']);
  fs.copyFileSync(path.join(SCRIPTS_SRC, 'publish.sh'), path.join(repo, 'scripts', 'publish.sh'));
  fs.chmodSync(path.join(repo, 'scripts', 'publish.sh'), 0o755);
  run(repo, 'git', ['add', 'scripts/publish.sh']);
  run(repo, 'git', ['commit', '-q', '-m', 'publish script']);
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-origin-'));
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-public-'));
  run(origin, 'git', ['init', '-q', '--bare']);
  run(pub, 'git', ['init', '-q', '--bare']);
  run(repo, 'git', ['remote', 'add', 'origin', origin]);
  run(repo, 'git', ['remote', 'add', 'public', pub]);
  run(repo, 'git', ['push', '-q', 'public', 'master']);

  fs.writeFileSync(path.join(repo, 'punchlist-templates', 'src', 'e.js'), '// first line\n// built for ZqxTermWord here\n');
  fs.mkdirSync(path.join(repo, 'docs', 'releases'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'releases', 'v0.0.2.md'), 'v0.0.2\n\nshipped to zqxtermword\n');
  run(repo, 'git', ['add', 'punchlist-templates/src/e.js', 'docs/releases/v0.0.2.md']);
  run(repo, 'git', ['commit', '-q', '-m', 'work']);
  run(repo, 'git', ['push', '-q', 'origin', 'master']);

  const r = publish(repo, terms, ['v0.0.2', '--dry-run']);
  const out = r.stdout + r.stderr;
  assert.strictEqual(r.status, 1, out);
  assert.match(out, /^ {2}punchlist-templates\/src\/e\.js:2: denylisted string$/m);
  assert.match(out, /^ {2}docs\/releases\/v0\.0\.2\.md:3: denylisted string$/m);
  assert.doesNotMatch(out, /zqxtermword|built for|shipped to/i);
});

// ---- bundle publishing: --at, --message, --no-tag, and the private-plane paths --------------------

test('publish.sh --at publishes the tree at that commit, not master', () => {
  const { repo, terms } = publishRepo(['zqxtermword']);
  const first = commitFiles(repo, { 'punchlist-templates/src/f.js': '// one\n' }, 'first');
  commitFiles(repo, { 'punchlist-templates/src/f.js': '// two\n', 'punchlist-templates/src/g.js': '// later\n' }, 'second');
  const r = publish(repo, terms, ['v0.1.0', '--at', first, '--message', messageFile('First bundle.\n'), '--no-tag', '--dry-run']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const branch = publishBranch(repo);
  assert.strictEqual(run(repo, 'git', ['show', `${branch}:punchlist-templates/src/f.js`]).stdout, '// one\n');
  assert.ok(!treeOf(repo, branch).includes('punchlist-templates/src/g.js'), treeOf(repo, branch).join(','));
  assert.strictEqual(run(repo, 'git', ['log', '-1', '--format=%B', branch]).stdout.trim(), 'First bundle.');
  assert.strictEqual(run(repo, 'git', ['status', '--porcelain']).stdout, '');
});

test('publish.sh refuses an --at commit that origin/master does not contain', () => {
  const { repo, terms } = publishRepo(['zqxtermword']);
  commitFiles(repo, { 'punchlist-templates/src/f.js': '// on master\n' });
  run(repo, 'git', ['checkout', '-q', '-b', 'side']);
  fs.writeFileSync(path.join(repo, 'punchlist-templates', 'src', 'side.js'), '// never pushed\n');
  run(repo, 'git', ['add', 'punchlist-templates/src/side.js']);
  run(repo, 'git', ['commit', '-q', '-m', 'side']);
  const side = run(repo, 'git', ['rev-parse', 'HEAD']).stdout.trim();
  run(repo, 'git', ['checkout', '-q', 'master']);
  const r = publish(repo, terms, ['v0.1.0', '--at', side, '--message', messageFile('Side.\n'), '--dry-run']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /not a first-parent commit of origin\/master/);
  assert.strictEqual(publishBranch(repo), '');
});

test('publish.sh scans a --message file and names its line, never the word', () => {
  const { repo, terms } = publishRepo(['zqxtermword']);
  const sha = commitFiles(repo, { 'punchlist-templates/src/f.js': '// clean\n' });
  const msg = messageFile('Bundle one\n\nbuilt for ZqxTermWord\n');
  const r = publish(repo, terms, ['v0.1.0', '--at', sha, '--message', msg, '--dry-run']);
  const out = r.stdout + r.stderr;
  assert.strictEqual(r.status, 1, out);
  assert.match(out, new RegExp(`^ {2}${msg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:3: denylisted string$`, 'm'));
  assert.doesNotMatch(out, /zqxtermword|built for/i);
  assert.strictEqual(publishBranch(repo), '');
});

test('publish.sh drops the spine runs, plans and every dated doc from the snapshot, and keeps the shipped defaults and undated docs', () => {
  const { repo, terms } = publishRepo(['zqxtermword']);
  const sha = commitFiles(repo, {
    'punchlist-templates/src/f.js': '// public\n',
    'punchlist-templates/process/config/defaults.yaml': 'review: {}\n',
    'punchlist-templates/process/config/punchlist.yaml': 'actors: {}\n',
    'punchlist-templates/process/cycles/build-and-commit.md': '# overlay\n',
    'punchlist-templates/process/efforts/e.yaml': 'slug: e\n',
    'punchlist-templates/process/runs/R1/state.yaml': 'run: R1\n',
    'punchlist-templates/docs/plans/2026-01-01-plan.md': '# plan\n',
    'punchlist-templates/docs/2026-01-01-adr-a-decision.md': '# adr\n',
    'punchlist-templates/docs/2026-01-01-prd.md': '# prd\n',
    'docs/2026-01-01-architecture.md': '# design\n',
    'docs/2026-01-01-adr-root.md': '# adr\n',
    'docs/macos-setup.md': '# setup\n',
    'docs/screenshots/today.png': 'png\n',
    'docs/releases/v0.0.9.md': 'v0.0.9\n',
  });
  const r = publish(repo, terms, ['v0.1.0', '--at', sha, '--message', messageFile('Bundle.\n'), '--dry-run']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const tree = treeOf(repo, publishBranch(repo));
  assert.deepStrictEqual(tree.filter((f) => /^(punchlist-templates|docs)\//.test(f)).sort(), [
    'docs/macos-setup.md',
    'docs/releases/v0.0.9.md',
    'docs/screenshots/today.png',
    'punchlist-templates/README.md',
    'punchlist-templates/process/config/defaults.yaml',
    'punchlist-templates/src/f.js',
  ]);
  // The private repo keeps every one of them.
  assert.ok(treeOf(repo, 'master').includes('punchlist-templates/process/runs/R1/state.yaml'));
  assert.ok(treeOf(repo, 'master').includes('docs/2026-01-01-architecture.md'));
});

test('publish.sh --no-tag pushes the bundle without a tag; the next bundle builds on it and carries the tag', () => {
  const { repo, terms, pub } = publishRepo(['zqxtermword']);
  const one = commitFiles(repo, { 'punchlist-templates/src/f.js': '// one\n' }, 'one');
  const two = commitFiles(repo, { 'punchlist-templates/src/g.js': '// two\n' }, 'two');

  let r = publish(repo, terms, ['v0.1.0', '--at', one, '--message', messageFile('Bundle one.\n'), '--no-tag'], { input: 'y\n' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(run(pub, 'git', ['tag', '--list']).stdout, '');
  const b1 = run(pub, 'git', ['rev-parse', 'master']).stdout.trim();
  assert.strictEqual(run(pub, 'git', ['log', '-1', '--format=%s', b1]).stdout.trim(), 'Bundle one.');

  r = publish(repo, terms, ['v0.1.0', '--at', two, '--message', messageFile('Bundle two.\n')], { input: 'y\n' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /this bundle builds on it/);
  const b2 = run(pub, 'git', ['rev-parse', 'master']).stdout.trim();
  assert.strictEqual(run(pub, 'git', ['rev-parse', `${b2}^`]).stdout.trim(), b1);
  assert.strictEqual(run(pub, 'git', ['tag', '--list']).stdout.trim(), 'v0.1.0');
  assert.strictEqual(run(pub, 'git', ['rev-parse', 'v0.1.0^{commit}']).stdout.trim(), b2);
  assert.ok(treeOf(pub, b2).includes('punchlist-templates/src/g.js'));
});

test('publish.sh refuses a bundle older than the one public/master already holds', () => {
  const { repo, terms } = publishRepo(['zqxtermword']);
  const one = commitFiles(repo, { 'punchlist-templates/src/f.js': '// one\n' }, 'one');
  const two = commitFiles(repo, { 'punchlist-templates/src/g.js': '// two\n' }, 'two');
  let r = publish(repo, terms, ['v0.1.0', '--at', two, '--message', messageFile('Two.\n'), '--no-tag'], { input: 'y\n' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  r = publish(repo, terms, ['v0.1.0', '--at', one, '--message', messageFile('One.\n'), '--dry-run']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /public moved on its own, or this bundle is out of order/i);
});

test('publish.sh refuses to build on a commit made on public itself', () => {
  const { repo, terms, pub } = publishRepo(['zqxtermword']);
  const sha = commitFiles(repo, { 'punchlist-templates/src/f.js': '// one\n' });
  // A commit made on public, outside publish.sh: the snapshot would silently revert it.
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-clone-'));
  run(clone, 'git', ['clone', '-q', '-b', 'master', pub, '.']);
  run(clone, 'git', ['config', 'user.email', 'test@example.com']);
  run(clone, 'git', ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(clone, 'punchlist-templates', 'README.md'), '# changed on public\n');
  run(clone, 'git', ['commit', '-q', '-am', 'public-only']);
  run(clone, 'git', ['push', '-q', 'origin', 'master']);
  const r = publish(repo, terms, ['v0.1.0', '--at', sha, '--message', messageFile('One.\n'), '--dry-run']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /public moved on its own/i);
  // The refusal names the command that fixes it.
  assert.match(r.stdout, /git merge -s ours --no-commit public\/master .*git push origin master/);
});

test('publish.sh refuses the commit when gitleaks finds a secret, back on master with the branch kept to inspect', () => {
  const { repo, terms } = publishRepo(['zqxtermword']);
  const sha = commitFiles(repo, { 'punchlist-templates/src/f.js': '// one\n' });
  const r = publish(repo, terms, ['v0.1.0', '--at', sha, '--message', messageFile('One.\n'), '--dry-run'], { gitleaksExit: 1 });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /gitleaks found secrets/);
  const branch = publishBranch(repo);
  assert.match(r.stdout, new RegExp(`gitleaks git \\. --log-opts=public/master\\.\\.${branch} --redact`));
  assert.strictEqual(run(repo, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'master');
  assert.strictEqual(run(repo, 'git', ['status', '--porcelain']).stdout, '');
});

test('publish.sh makes no tag when the push is rejected, so the rerun is not blocked by one', () => {
  const { repo, terms, pub } = publishRepo(['zqxtermword']);
  const sha = commitFiles(repo, { 'punchlist-templates/src/f.js': '// one\n' });
  const hook = path.join(pub, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  let r = publish(repo, terms, ['v0.1.0', '--at', sha, '--message', messageFile('One.\n')], { input: 'y\n' });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /push to public\/master failed; nothing was published/);
  assert.strictEqual(run(repo, 'git', ['tag', '--list']).stdout, '');
  assert.strictEqual(run(repo, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'master');
  fs.unlinkSync(hook);
  r = publish(repo, terms, ['v0.1.0', '--at', sha, '--message', messageFile('One.\n')], { input: 'y\n' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(run(pub, 'git', ['tag', '--list']).stdout.trim(), 'v0.1.0');
  // A tagged rerun for a version already tagged here is refused up front, naming the fix.
  commitFiles(repo, { 'punchlist-templates/src/g.js': '// two\n' });
  r = publish(repo, terms, ['v0.1.0', '--message', messageFile('Two.\n'), '--dry-run']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /tag v0\.1\.0 already exists here.*git tag -d v0\.1\.0/);
});

test('publish.sh without --at or --message still publishes master with its release note', () => {
  const { repo, terms } = publishRepo(['zqxtermword']);
  commitFiles(repo, { 'punchlist-templates/src/f.js': '// one\n', 'docs/releases/v0.1.0.md': 'v0.1.0\n\nThe note.\n' });
  const r = publish(repo, terms, ['v0.1.0', '--dry-run']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const branch = publishBranch(repo);
  assert.deepStrictEqual(treeOf(repo, branch), treeOf(repo, 'master'));
  assert.strictEqual(run(repo, 'git', ['log', '-1', '--format=%B', branch]).stdout.trim(), 'v0.1.0\n\nThe note.');
});

test('publish.sh refuses when the tree at --at is what public/master already holds', () => {
  const { repo, terms } = publishRepo(['zqxtermword']);
  commitFiles(repo, { '.github/workflows/ci.yml': 'name: ci\n' });
  const r = publish(repo, terms, ['v0.1.0', '--message', messageFile('Nothing.\n'), '--dry-run']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /nothing to publish/);
  assert.strictEqual(publishBranch(repo), '');
});

test('publish.sh refuses an --at commit from a merged branch: a bundle is a state master was in', () => {
  const { repo, terms } = publishRepo(['zqxtermword']);
  commitFiles(repo, { 'punchlist-templates/src/f.js': '// one\n' });
  run(repo, 'git', ['checkout', '-q', '-b', 'side']);
  fs.writeFileSync(path.join(repo, 'punchlist-templates', 'src', 'side.js'), '// side\n');
  run(repo, 'git', ['add', 'punchlist-templates/src/side.js']);
  run(repo, 'git', ['commit', '-q', '-m', 'side']);
  const side = run(repo, 'git', ['rev-parse', 'HEAD']).stdout.trim();
  run(repo, 'git', ['checkout', '-q', 'master']);
  run(repo, 'git', ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
  run(repo, 'git', ['push', '-q', 'origin', 'master']);
  const r = publish(repo, terms, ['v0.1.0', '--at', side, '--message', messageFile('Side.\n'), '--dry-run']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /not a first-parent commit of origin\/master.*git log --first-parent/);
});

test('publish.sh refuses to build on a private-plane file committed on public', () => {
  // The next snapshot would delete it without a word, so public counts as moved.
  const { repo, terms, pub } = publishRepo(['zqxtermword']);
  const one = commitFiles(repo, { 'punchlist-templates/src/f.js': '// one\n' }, 'one');
  let r = publish(repo, terms, ['v0.1.0', '--at', one, '--message', messageFile('One.\n'), '--no-tag'], { input: 'y\n' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-clone-'));
  run(clone, 'git', ['clone', '-q', '-b', 'master', pub, '.']);
  run(clone, 'git', ['config', 'user.email', 'test@example.com']);
  run(clone, 'git', ['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(clone, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(clone, '.github', 'workflows', 'ui.yml'), 'name: ui\n');
  run(clone, 'git', ['add', '.github']);
  run(clone, 'git', ['commit', '-q', '-m', 'added on public']);
  run(clone, 'git', ['push', '-q', 'origin', 'master']);
  const two = commitFiles(repo, { 'punchlist-templates/src/g.js': '// two\n' }, 'two');
  r = publish(repo, terms, ['v0.1.0', '--at', two, '--message', messageFile('Two.\n'), '--dry-run']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /public moved on its own/i);
});

test('publish.sh --message still scans the release note in the tree', () => {
  // The tree scan used to skip docs/releases, trusting the note scan. With --message the note is
  // not the message, so it must be scanned as part of the tree.
  const { repo, terms } = publishRepo(['zqxtermword']);
  const sha = commitFiles(repo, { 'docs/releases/v0.1.0.md': 'v0.1.0\n\nbuilt for zqxtermword\n' });
  const r = publish(repo, terms, ['v0.1.0', '--at', sha, '--message', messageFile('Clean.\n'), '--dry-run']);
  const out = r.stdout + r.stderr;
  assert.strictEqual(r.status, 1, out);
  assert.match(out, /^ {2}docs\/releases\/v0\.1\.0\.md:3: denylisted string$/m);
  assert.doesNotMatch(out, /zqxtermword|built for/i);
});

test('publish.sh leaves master checked out and no branch when a git step fails after the checkout', () => {
  // An empty message makes git commit fail under set -e, after the publish branch exists.
  const { repo, terms } = publishRepo(['zqxtermword']);
  const sha = commitFiles(repo, { 'punchlist-templates/src/f.js': '// one\n' });
  const r = publish(repo, terms, ['v0.1.0', '--at', sha, '--message', messageFile(''), '--dry-run']);
  assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(run(repo, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'master');
  assert.strictEqual(publishBranch(repo), '');
  assert.strictEqual(run(repo, 'git', ['status', '--porcelain']).stdout, '');
});

test('publish.sh drops a private path with a non-ASCII name', () => {
  // git quotes such a path by default, and a quoted path does not match the anchored pattern.
  const { repo, terms } = publishRepo(['zqxtermword']);
  const sha = commitFiles(repo, { 'punchlist-templates/src/f.js': '// one\n', 'punchlist-templates/process/runs/café.md': 'x\n' });
  const r = publish(repo, terms, ['v0.1.0', '--at', sha, '--message', messageFile('One.\n'), '--dry-run']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(!treeOf(repo, publishBranch(repo)).some((f) => f.includes('process/')));
});

test('publish.sh reads a relative --message path from where it was started', () => {
  const { repo, terms } = publishRepo(['zqxtermword']);
  const sha = commitFiles(repo, { 'punchlist-templates/src/f.js': '// one\n' });
  const msg = messageFile('Relative.\n');
  const r = run(path.dirname(msg), path.join(repo, 'scripts', 'publish.sh'), ['v0.1.0', '--at', sha, '--message', 'bundle.md', '--dry-run'], {
    env: { ...process.env, LEAK_TERMS: terms, PATH: `${stubGitleaks()}:${process.env.PATH}`, GIT_DIR: path.join(repo, '.git'), GIT_WORK_TREE: repo },
  });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(run(repo, 'git', ['log', '-1', '--format=%B', publishBranch(repo)]).stdout.trim(), 'Relative.');
});

test('publish.sh refuses a missing --message file, and a tree with no release note, naming the fix', () => {
  const { repo, terms } = publishRepo(['zqxtermword']);
  const sha = commitFiles(repo, { 'punchlist-templates/src/f.js': '// one\n' });
  let r = publish(repo, terms, ['v0.1.0', '--at', sha, '--message', '/nonexistent/bundle.md', '--dry-run']);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /no message file at \/nonexistent\/bundle\.md/);
  r = publish(repo, terms, ['v0.1.0', '--at', sha, '--dry-run']);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /Write and commit docs\/releases\/v0\.1\.0\.md, or pass --message/);
  assert.strictEqual(publishBranch(repo), '');
});

test('publish.sh builds on a rewritten public history, before and after private merges it', () => {
  // A rewrite gives public/master new shas that private has never seen. Its tree is still a private
  // tree, so the next bundle is accepted; after private merges the rewritten history, the ancestry
  // check accepts it too.
  const { repo, terms, pub } = publishRepo(['zqxtermword']);
  const one = commitFiles(repo, { 'punchlist-templates/src/f.js': '// one\n' }, 'one');
  let r = publish(repo, terms, ['v0.1.0', '--at', one, '--message', messageFile('One.\n'), '--no-tag'], { input: 'y\n' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  // Rewrite public: the same tree, as a new root commit with a new message.
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-clone-'));
  run(clone, 'git', ['clone', '-q', '-b', 'master', pub, '.']);
  run(clone, 'git', ['config', 'user.email', 'test@example.com']);
  run(clone, 'git', ['config', 'user.name', 'Test']);
  const rewritten = run(clone, 'git', ['commit-tree', 'HEAD^{tree}', '-m', 'rewritten']).stdout.trim();
  run(clone, 'git', ['push', '-q', '-f', 'origin', `${rewritten}:refs/heads/master`]);

  const two = commitFiles(repo, { 'punchlist-templates/src/g.js': '// two\n' }, 'two');
  r = publish(repo, terms, ['v0.1.0', '--at', two, '--message', messageFile('Two.\n'), '--no-tag'], { input: 'y\n' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const b2 = run(pub, 'git', ['rev-parse', 'master']).stdout.trim();
  assert.strictEqual(run(pub, 'git', ['rev-parse', `${b2}^`]).stdout.trim(), rewritten);

  // Private merges the rewritten public history once; the next bundle passes on ancestry.
  run(repo, 'git', ['fetch', '-q', 'public']);
  run(repo, 'git', ['merge', '-q', '-s', 'ours', '--allow-unrelated-histories', '-m', 'merge public', 'public/master']);
  run(repo, 'git', ['push', '-q', 'origin', 'master']);
  const three = commitFiles(repo, { 'punchlist-templates/src/h.js': '// three\n' }, 'three');
  r = publish(repo, terms, ['v0.1.0', '--at', three, '--message', messageFile('Three.\n')], { input: 'y\n' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /bundle of private/);
  assert.strictEqual(run(pub, 'git', ['tag', '--list']).stdout.trim(), 'v0.1.0');
});

// ---- public's own edits: an early bundle carries them forward --------------------------------------

// The situation, in a fixture. public's history is rewritten: a new root with the tree at `base`
// (a dated doc included, which the snapshots drop). public then gets an edit of its own, to
// public/views.js. Private goes on with c1 and c2, then takes the edit with an ours-merge that
// keeps public's views.js (`merge`), then c3. Options:
//   privateChange  c2 also changes public/views.js on the private side.
//   cherryPick     private takes the edit as a plain commit before c2, and the merge takes nothing.
//   sideBranch     the merge that takes public's edit happens on a branch, which master then merges with --no-ff.
//   mergeRemoves   c1 adds these private files, and the reconcile merge deletes them.
//   flipFlop       c1 changes f.js and c2 changes it back.
//   publicDropsDoc public also deletes the private-plane doc, and the merge takes the deletion.
const VIEWS_BASE = '// views\nrender(all)\n';
const VIEWS_PUBLIC = '// views\nrender(dedupe(all))\n';
function carryRepo({ privateChange = false, cherryPick = false, sideBranch = false, mergeRemoves = [], flipFlop = false, publicDropsDoc = false } = {}) {
  const { repo, terms, pub } = publishRepo(['zqxtermword']);
  const before = run(repo, 'git', ['rev-parse', 'HEAD']).stdout.trim();
  const base = commitFiles(repo, {
    'public/views.js': VIEWS_BASE,
    'punchlist-templates/src/f.js': '// f\n',
    'docs/2026-01-01-design.md': '# design\n',
  }, 'base');
  const root = run(repo, 'git', ['commit-tree', `${base}^{tree}`, '-m', 'rewritten']).stdout.trim();
  run(repo, 'git', ['checkout', '-q', '-b', 'on-public', root]);
  fs.writeFileSync(path.join(repo, 'public', 'views.js'), VIEWS_PUBLIC);
  if (publicDropsDoc) run(repo, 'git', ['rm', '-q', 'docs/2026-01-01-design.md']);
  run(repo, 'git', ['commit', '-q', '-am', 'dedupe the Today view']);
  run(repo, 'git', ['push', '-q', '-f', 'public', 'on-public:master']);
  run(repo, 'git', ['checkout', '-q', 'master']);
  run(repo, 'git', ['branch', '-q', '-D', 'on-public']);
  run(repo, 'git', ['fetch', '-q', 'public']);
  const publicTip = run(repo, 'git', ['rev-parse', 'public/master']).stdout.trim();

  const c1files = { 'punchlist-templates/src/g.js': '// c1\n' };
  for (const p of mergeRemoves) c1files[p] = 'private\n';
  if (flipFlop) c1files['punchlist-templates/src/f.js'] = '// f, for a while\n';
  const c1 = commitFiles(repo, c1files, 'c1');
  if (cherryPick) commitFiles(repo, { 'public/views.js': VIEWS_PUBLIC }, 'take the dedupe as a plain commit');
  const c2files = { 'punchlist-templates/src/h.js': '// c2\n' };
  if (privateChange) c2files['public/views.js'] = '// views\nrender(all) // private\n';
  if (flipFlop) c2files['punchlist-templates/src/f.js'] = '// f\n';
  const c2 = commitFiles(repo, c2files, 'c2');
  if (sideBranch) run(repo, 'git', ['checkout', '-q', '-b', 'reconcile']);
  run(repo, 'git', ['merge', '-q', '-s', 'ours', '--no-commit', '--allow-unrelated-histories', 'public/master']);
  if (!cherryPick) run(repo, 'git', ['checkout', 'public/master', '--', 'public/views.js']);
  for (const p of mergeRemoves) run(repo, 'git', ['rm', '-q', p]);
  if (publicDropsDoc) run(repo, 'git', ['rm', '-q', 'docs/2026-01-01-design.md']);
  run(repo, 'git', ['commit', '-q', '-m', 'merge public']);
  if (sideBranch) {
    // A private change on the same branch, so the merge into master brings more than public's edit.
    commitFiles(repo, { 'punchlist-templates/src/side.js': '// side\n' }, 'side work');
    run(repo, 'git', ['checkout', '-q', 'master']);
    run(repo, 'git', ['merge', '-q', '--no-ff', '-m', 'merge the reconcile branch', 'reconcile']);
  }
  run(repo, 'git', ['push', '-q', 'origin', 'master']);
  const merge = run(repo, 'git', ['rev-parse', 'HEAD']).stdout.trim();
  const c3 = commitFiles(repo, { 'punchlist-templates/src/k.js': '// c3\n' }, 'c3');
  return { repo, terms, pub, publicTip, before, c1, c2, merge, c3 };
}

function show(repo, rev, file) {
  return run(repo, 'git', ['show', `${rev}:${file}`]).stdout;
}

// No revert: public's edit is in the tree, and the diff from the old public/master never touches it.
function assertNoRevert(repo, from, to) {
  assert.strictEqual(show(repo, to, 'public/views.js'), VIEWS_PUBLIC);
  const changed = run(repo, 'git', ['diff', '--name-only', from, to]).stdout.split('\n');
  assert.ok(!changed.includes('public/views.js'), changed.join(','));
}

test('publish.sh: a bundle cut before the reconcile merge carries public\'s edit instead of being refused', () => {
  const { repo, terms, publicTip, c1 } = carryRepo();
  const r = publish(repo, terms, ['v0.1.0', '--at', c1, '--message', messageFile('One.\n'), '--no-tag', '--dry-run']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /bundle of private [0-9a-f]{7}; this bundle builds on it/);
  assert.match(r.stdout, /carries public's own edits[^\n]*\n {2}public\/views\.js$/m);
  const branch = publishBranch(repo);
  assertNoRevert(repo, publicTip, branch);
  const tree = treeOf(repo, branch);
  assert.ok(tree.includes('punchlist-templates/src/g.js'));
  assert.ok(!tree.includes('punchlist-templates/src/h.js'), tree.join(','));
  // The snapshot still drops the private-plane doc that public held, and says so.
  assert.ok(!tree.includes('docs/2026-01-01-design.md'), tree.join(','));
  assert.match(r.stdout, /^this bundle removes the 1 private-plane path\(s\) that public still holds$/m);
});

test('publish.sh: the bundles chain across the carry, and every one keeps public\'s edit', () => {
  const { repo, terms, pub, publicTip, c1, c2, c3 } = carryRepo();
  let r = publish(repo, terms, ['v0.1.0', '--at', c1, '--message', messageFile('One.\n'), '--no-tag'], { input: 'y\n' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const b1 = run(pub, 'git', ['rev-parse', 'master']).stdout.trim();
  assert.strictEqual(run(pub, 'git', ['rev-parse', `${b1}^`]).stdout.trim(), publicTip);
  assertNoRevert(pub, publicTip, b1);

  // B2: public/master is B1, which no private commit contains. It matches the bundle of c1 (the
  // snapshot and its carry), so B2 builds on it and carries the edit too.
  r = publish(repo, terms, ['v0.1.0', '--at', c2, '--message', messageFile('Two.\n'), '--no-tag'], { input: 'y\n' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`bundle of private ${c1.slice(0, 7)}; this bundle builds on it`));
  const b2 = run(pub, 'git', ['rev-parse', 'master']).stdout.trim();
  assert.strictEqual(run(pub, 'git', ['rev-parse', `${b2}^`]).stdout.trim(), b1);
  assertNoRevert(pub, b1, b2);
  assert.ok(treeOf(pub, b2).includes('punchlist-templates/src/h.js'));

  // B3, after the merge: nothing left to carry, and the snapshot has public's version itself.
  r = publish(repo, terms, ['v0.1.0', '--at', c3, '--message', messageFile('Three.\n')], { input: 'y\n' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /carries public's own edits/);
  const b3 = run(pub, 'git', ['rev-parse', 'master']).stdout.trim();
  assert.strictEqual(run(pub, 'git', ['rev-parse', `${b3}^`]).stdout.trim(), b2);
  assertNoRevert(pub, b2, b3);
  assert.strictEqual(run(pub, 'git', ['tag', '--list']).stdout.trim(), 'v0.1.0');
});

test('publish.sh: a bundle at or after the reconcile merge still publishes on ancestry', () => {
  const { repo, terms, publicTip, merge, c3 } = carryRepo();
  for (const at of [merge, c3]) {
    const r = publish(repo, terms, ['v0.1.0', '--at', at, '--message', messageFile('Late.\n'), '--no-tag', '--dry-run']);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /carries public's own edits|this bundle builds on it/);
    const branch = publishBranch(repo);
    assertNoRevert(repo, publicTip, branch);
    run(repo, 'git', ['branch', '-q', '-D', branch]);
  }
});

test('publish.sh refuses a bundle whose carried path private changes before the merge, naming the path and both commits', () => {
  const { repo, terms, publicTip, c1, c2, merge } = carryRepo({ privateChange: true });
  let r = publish(repo, terms, ['v0.1.0', '--at', c1, '--message', messageFile('One.\n'), '--no-tag', '--dry-run']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`^ {2}public/views\\.js: changed in ${c2.slice(0, 7)}, taken from public in ${merge.slice(0, 7)}$`, 'm'));
  assert.match(r.stdout, /Publish with --at at or after the private commit/);
  assert.strictEqual(publishBranch(repo), '');
  // At the private commit itself, the merge is the only change to the path after it: the carry holds.
  r = publish(repo, terms, ['v0.1.0', '--at', c2, '--message', messageFile('Two.\n'), '--no-tag', '--dry-run']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assertNoRevert(repo, publicTip, publishBranch(repo));
});

test('publish.sh refuses a bundle that would revert public\'s edit, even when no merge carries it', () => {
  // Private took the edit as a plain commit, and the merge took nothing. There is nothing to carry,
  // so the snapshot at c1 has the old views.js, and no private state with the carry gives public's
  // tree. The run refuses rather than revert the edit.
  const { repo, terms, c1 } = carryRepo({ cherryPick: true });
  const r = publish(repo, terms, ['v0.1.0', '--at', c1, '--message', messageFile('One.\n'), '--no-tag', '--dry-run']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /private took public's edits outside a merge \(a cherry-pick\)/i);
  assert.strictEqual(publishBranch(repo), '');
  assert.strictEqual(run(repo, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'master');
});

test('publish.sh carries an edit that a side branch reconciled, and not the side branch\'s own work', () => {
  const { repo, terms, publicTip, c1 } = carryRepo({ sideBranch: true });
  const r = publish(repo, terms, ['v0.1.0', '--at', c1, '--message', messageFile('One.\n'), '--no-tag', '--dry-run']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const branch = publishBranch(repo);
  assertNoRevert(repo, publicTip, branch);
  assert.ok(!treeOf(repo, branch).includes('punchlist-templates/src/side.js'), treeOf(repo, branch).join(','));
});

test('publish.sh carries the edits of two reconcile merges, a new path and a deleted one included', () => {
  const { repo, terms, pub } = publishRepo(['zqxtermword']);
  const base = commitFiles(repo, { 'public/views.js': VIEWS_BASE, 'public/old.js': '// old\n' }, 'base');
  const root = run(repo, 'git', ['commit-tree', `${base}^{tree}`, '-m', 'rewritten']).stdout.trim();
  // Public's first edit, which private merges; then its second edit, which private merges later.
  run(repo, 'git', ['checkout', '-q', '-b', 'on-public', root]);
  fs.writeFileSync(path.join(repo, 'public', 'views.js'), VIEWS_PUBLIC);
  run(repo, 'git', ['commit', '-q', '-am', 'edit one']);
  const edit1 = run(repo, 'git', ['rev-parse', 'HEAD']).stdout.trim();
  fs.writeFileSync(path.join(repo, 'public', 'new.js'), '// new on public\n');
  run(repo, 'git', ['rm', '-q', 'public/old.js']);
  run(repo, 'git', ['add', 'public/new.js']);
  run(repo, 'git', ['commit', '-q', '-m', 'edit two']);
  run(repo, 'git', ['push', '-q', '-f', 'public', 'on-public:master']);
  run(repo, 'git', ['checkout', '-q', 'master']);
  run(repo, 'git', ['fetch', '-q', 'public']);
  const publicTip = run(repo, 'git', ['rev-parse', 'public/master']).stdout.trim();

  const c1 = commitFiles(repo, { 'punchlist-templates/src/g.js': '// c1\n' }, 'c1');
  run(repo, 'git', ['merge', '-q', '-s', 'ours', '--no-commit', '--allow-unrelated-histories', edit1]);
  run(repo, 'git', ['checkout', edit1, '--', 'public/views.js']);
  run(repo, 'git', ['commit', '-q', '-m', 'merge public edit one']);
  commitFiles(repo, { 'punchlist-templates/src/h.js': '// c2\n' }, 'c2');
  run(repo, 'git', ['merge', '-q', '-s', 'ours', '--no-commit', 'public/master']);
  run(repo, 'git', ['checkout', 'public/master', '--', 'public/new.js']);
  run(repo, 'git', ['rm', '-q', 'public/old.js']);
  run(repo, 'git', ['commit', '-q', '-m', 'merge public edit two']);
  run(repo, 'git', ['push', '-q', 'origin', 'master']);
  run(repo, 'git', ['branch', '-q', '-D', 'on-public']);

  const r = publish(repo, terms, ['v0.1.0', '--at', c1, '--message', messageFile('One.\n'), '--no-tag', '--dry-run']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const branch = publishBranch(repo);
  assertNoRevert(repo, publicTip, branch);
  const tree = treeOf(repo, branch);
  assert.strictEqual(show(repo, branch, 'public/new.js'), '// new on public\n');
  assert.ok(!tree.includes('public/old.js'), tree.join(','));
  assert.ok(!tree.includes('punchlist-templates/src/h.js'), tree.join(','));
  assert.deepStrictEqual(run(repo, 'git', ['diff', '--name-only', publicTip, branch]).stdout.trim().split('\n'), ['punchlist-templates/src/g.js']);
});

test('publish.sh refuses to carry an edit that public made to a private-plane path', () => {
  // The snapshot drops every private-plane path, so carrying one would still delete it on public.
  const { repo, terms } = publishRepo(['zqxtermword']);
  const base = commitFiles(repo, { 'public/views.js': VIEWS_BASE }, 'base');
  const root = run(repo, 'git', ['commit-tree', `${base}^{tree}`, '-m', 'rewritten']).stdout.trim();
  run(repo, 'git', ['checkout', '-q', '-b', 'on-public', root]);
  fs.mkdirSync(path.join(repo, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.github', 'workflows', 'ui.yml'), 'name: ui\n');
  run(repo, 'git', ['add', '.github']);
  run(repo, 'git', ['commit', '-q', '-m', 'workflow on public']);
  run(repo, 'git', ['push', '-q', '-f', 'public', 'on-public:master']);
  run(repo, 'git', ['checkout', '-q', 'master']);
  run(repo, 'git', ['fetch', '-q', 'public']);
  const c1 = commitFiles(repo, { 'punchlist-templates/src/g.js': '// c1\n' }, 'c1');
  run(repo, 'git', ['merge', '-q', '--allow-unrelated-histories', '-X', 'ours', '-m', 'merge public', 'public/master']);
  run(repo, 'git', ['push', '-q', 'origin', 'master']);
  const r = publish(repo, terms, ['v0.1.0', '--at', c1, '--message', messageFile('One.\n'), '--no-tag', '--dry-run']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /took public.s edits to private-plane paths[^\n]*\n {2}\.github\/workflows\/ui\.yml$/m);
  assert.strictEqual(publishBranch(repo), '');
});

test('publish.sh refuses a cut older than the private state that a merged public is based on', () => {
  // public is the tree at base plus its edit. A bundle cut before base would roll public back.
  const { repo, terms, before } = carryRepo();
  const r = publish(repo, terms, ['v0.1.0', '--at', before, '--message', messageFile('Old.\n'), '--no-tag', '--dry-run']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Publish at or after the merge of public\/master\. The usual causes: [^\n]*older than public's private base/);
  assert.strictEqual(publishBranch(repo), '');
});

test('publish.sh does not carry a private deletion that the reconcile merge made', () => {
  // The merge deletes two files that c1 added and public never had: one publishable, one private-plane.
  const removed = ['punchlist-templates/src/gone.js', 'docs/2026-02-02-note.md'];
  const { repo, terms, publicTip, c1 } = carryRepo({ mergeRemoves: removed });
  const r = publish(repo, terms, ['v0.1.0', '--at', c1, '--message', messageFile('One.\n'), '--no-tag', '--dry-run']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /carries public's own edits[^\n]*\n {2}public\/views\.js\n(?! )/);
  const branch = publishBranch(repo);
  assertNoRevert(repo, publicTip, branch);
  assert.ok(treeOf(repo, branch).includes('punchlist-templates/src/gone.js'), treeOf(repo, branch).join(','));
});

test('publish.sh carries public\'s deletion of a private-plane path without refusing it', () => {
  // Every bundle drops the path anyway, so public loses nothing.
  const { repo, terms, publicTip, c1 } = carryRepo({ publicDropsDoc: true });
  const r = publish(repo, terms, ['v0.1.0', '--at', c1, '--message', messageFile('One.\n'), '--no-tag', '--dry-run']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const branch = publishBranch(repo);
  assertNoRevert(repo, publicTip, branch);
  assert.ok(!treeOf(repo, branch).includes('docs/2026-01-01-design.md'));
});

test('publish.sh accepts a cut where private changed a file that it later changes back', () => {
  // Public never edited f.js, so the bundle at c1 has private's version and nothing is a revert.
  const { repo, terms, publicTip, c1 } = carryRepo({ flipFlop: true });
  const r = publish(repo, terms, ['v0.1.0', '--at', c1, '--message', messageFile('One.\n'), '--no-tag', '--dry-run']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const branch = publishBranch(repo);
  assert.strictEqual(show(repo, branch, 'punchlist-templates/src/f.js'), '// f, for a while\n');
  assertNoRevert(repo, publicTip, branch);
});

test('install-hooks writes an executable pre-commit whose path matches where the scripts actually live', () => {
  const { repo } = tmpRepoWithTerms(['acmecorp']);
  installHooks(repo);
  const hookPath = path.join(repo, '.git', 'hooks', 'pre-commit');
  const hook = fs.readFileSync(hookPath, 'utf8');
  assert.match(hook, /scripts\/denylist-scan\.sh/);
  assert.ok(fs.statSync(hookPath).mode & 0o111);
  fs.writeFileSync(hookPath, '#!/bin/sh\necho mine\n');
  assert.strictEqual(installHooks(repo).status, 1);
});
