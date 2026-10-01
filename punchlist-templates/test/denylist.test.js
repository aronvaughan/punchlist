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
test('publish.sh --dry-run leaves .github/workflows out of the public squash', { skip: spawnSync('sh', ['-c', 'command -v gitleaks']).status !== 0 }, () => {
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

  const r = run(repo, path.join(repo, 'scripts', 'publish.sh'), ['v0.0.1', '--dry-run'], { env: { ...process.env, LEAK_TERMS: terms } });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const branch = run(repo, 'git', ['branch', '--list', 'publish/*', '--format=%(refname:short)']).stdout.trim();
  const tree = run(repo, 'git', ['ls-tree', '-r', '--name-only', branch]).stdout.split('\n');
  assert.ok(tree.includes('punchlist-templates/src/d.js'), tree.join(','));
  assert.ok(!tree.some((f) => f.startsWith('.github/')), tree.join(','));
  // The private repo keeps them, and the checkout is back on a clean master.
  assert.ok(run(repo, 'git', ['ls-tree', '-r', '--name-only', 'master']).stdout.includes('.github/workflows/ci.yml'));
  assert.strictEqual(run(repo, 'git', ['status', '--porcelain']).stdout, '');
});

test('publish.sh --dry-run names the file and line of a denylist hit, never the word or the line', { skip: spawnSync('sh', ['-c', 'command -v gitleaks']).status !== 0 }, () => {
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

  const r = run(repo, path.join(repo, 'scripts', 'publish.sh'), ['v0.0.2', '--dry-run'], { env: { ...process.env, LEAK_TERMS: terms } });
  const out = r.stdout + r.stderr;
  assert.strictEqual(r.status, 1, out);
  assert.match(out, /^ {2}punchlist-templates\/src\/e\.js:2: denylisted string$/m);
  assert.match(out, /^ {2}docs\/releases\/v0\.0\.2\.md:3: denylisted string$/m);
  assert.doesNotMatch(out, /zqxtermword|built for|shipped to/i);
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
