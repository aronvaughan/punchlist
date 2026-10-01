'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const repoWindow = require('../lib/repo-window');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'repo-window-'));
}

test('claimRepo claims an unclaimed repo and writes the owner file', () => {
  const repo = tmpdir();
  const r = repoWindow.claimRepo(repo, 'w1');
  assert.deepStrictEqual(r, { claimed: true, heldBy: null });
  assert.strictEqual(repoWindow.repoOwner(repo).window, 'w1');
});

test('claimRepo refuses a second window without --take-over', () => {
  const repo = tmpdir();
  repoWindow.claimRepo(repo, 'w1');
  assert.deepStrictEqual(repoWindow.claimRepo(repo, 'w2'), { claimed: false, heldBy: 'w1' });
});

test('--take-over reclaims and names who held it', () => {
  const repo = tmpdir();
  repoWindow.claimRepo(repo, 'w1');
  assert.deepStrictEqual(repoWindow.claimRepo(repo, 'w2', { takeOver: true }), { claimed: true, heldBy: 'w1' });
  assert.strictEqual(repoWindow.repoOwner(repo).window, 'w2');
});

test('assertRepoWindow throws for a mismatched window and passes for the owner', () => {
  const repo = tmpdir();
  repoWindow.claimRepo(repo, 'w1');
  assert.throws(() => repoWindow.assertRepoWindow(repo, 'w2'), /is being driven by window w1/);
  assert.doesNotThrow(() => repoWindow.assertRepoWindow(repo, 'w1'));
});

test('an unclaimed repo passes assertRepoWindow for any window', () => {
  const repo = tmpdir();
  assert.doesNotThrow(() => repoWindow.assertRepoWindow(repo, 'anything'));
});

test('assertRepoWindow message names the dir, the holder, and the fix command', () => {
  const repo = tmpdir();
  repoWindow.claimRepo(repo, 'w1');
  assert.throws(
    () => repoWindow.assertRepoWindow(repo, 'w2'),
    (err) => err instanceof Error
      && err.message.includes(repo)
      && err.message.includes('window w1')
      && err.message.includes('scripts/plt-worktree.sh')
      && err.message.includes('--take-over'),
  );
});

test('claimRepo already-ours re-claim reports its own previous window as heldBy', () => {
  const repo = tmpdir();
  repoWindow.claimRepo(repo, 'w1');
  assert.deepStrictEqual(repoWindow.claimRepo(repo, 'w1'), { claimed: true, heldBy: 'w1' });
});

test('repoOwner on a never-claimed repo returns nulls', () => {
  const repo = tmpdir();
  assert.deepStrictEqual(repoWindow.repoOwner(repo), { window: null, at: null });
});

// ---------------------------------------------------------------- repoHandler (CLI)

function runRepo(args, env = {}) {
  const out = { stdout: '', stderr: '', status: 0 };
  const origWrite = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (s) => { out.stdout += s; return true; };
  process.stderr.write = (s) => { out.stderr += s; return true; };
  const origEnv = { ...process.env };
  Object.assign(process.env, env);
  try {
    out.status = repoWindow.repoHandler(args);
  } finally {
    process.stdout.write = origWrite.out;
    process.stderr.write = origWrite.err;
    for (const k of Object.keys(process.env)) if (!(k in origEnv)) delete process.env[k];
    Object.assign(process.env, origEnv);
  }
  return out;
}

test('repoHandler status reports unclaimed then claimed', () => {
  const repo = tmpdir();
  const a = runRepo(['status', '--repo', repo]);
  assert.strictEqual(a.status, 0);
  assert.match(a.stdout, /unclaimed/);

  const b = runRepo(['claim', '--repo', repo], { PLT_WINDOW: 'w1' });
  assert.strictEqual(b.status, 0);

  const c = runRepo(['status', '--repo', repo]);
  assert.strictEqual(c.status, 0);
  assert.match(c.stdout, /w1/);
});

test('repoHandler release refuses another window without --take-over, then succeeds for the owner', () => {
  const repo = tmpdir();
  runRepo(['claim', '--repo', repo], { PLT_WINDOW: 'w1' });

  const refused = runRepo(['release', '--repo', repo], { PLT_WINDOW: 'w2' });
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr, /w1/);

  const released = runRepo(['release', '--repo', repo], { PLT_WINDOW: 'w1' });
  assert.strictEqual(released.status, 0);
  assert.strictEqual(repoWindow.repoOwner(repo).window, null);
});

test('repoWindow.commands exports the repo verb', () => {
  const entry = repoWindow.commands.find((c) => c.name === 'repo');
  assert.ok(entry, 'expected a "repo" command entry');
  assert.strictEqual(typeof entry.handler, 'function');
  assert.match(entry.usage, /plt repo claim\|status\|release/);
});

// ---------------------------------------------------------------- plt-worktree.sh
// Runs only against a throwaway repo under a temp dir — never this live checkout.

function makeThrowawayRepo() {
  const repo = tmpdir();
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'x@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'x']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  execFileSync('git', ['-C', repo, 'add', 'README.md']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'seed']);
  fs.mkdirSync(path.join(repo, 'scripts'));
  fs.copyFileSync(
    path.join(__dirname, '..', 'scripts', 'plt-worktree.sh'),
    path.join(repo, 'scripts', 'plt-worktree.sh'),
  );
  fs.chmodSync(path.join(repo, 'scripts', 'plt-worktree.sh'), 0o755);
  return repo;
}

function sh(script, args) {
  const r = require('child_process').spawnSync(script, args, { encoding: 'utf8' });
  return r;
}

test('plt-worktree.sh is idempotent', () => {
  const repo = makeThrowawayRepo();
  const script = path.join(repo, 'scripts', 'plt-worktree.sh');
  const a = sh(script, ['alpha']);
  const b = sh(script, ['alpha']);
  assert.strictEqual(a.status, 0, a.stderr);
  assert.strictEqual(b.status, 0, b.stderr);
  assert.strictEqual(a.stdout.trim().split('\n')[0], b.stdout.trim().split('\n')[0]);
  assert.match(a.stdout, /export PLT_WINDOW=alpha/);
});

// ---------------------------------------------------------------- claim and lock under the git dir
// The claim and its lock live in the checkout's own git dir (per worktree), where git never lists
// them — so a repo whose .gitignore does not mention them still pins clean once claimed.

function gitRepo() {
  const repo = tmpdir();
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'x@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'x']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');   // no .gitignore at all
  execFileSync('git', ['-C', repo, 'add', 'README.md']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'seed']);
  return repo;
}

test('a claimed repo with no .gitignore still pins: the claim lives in the git dir, not the tree', () => {
  const spine = require('../lib/spine');
  const repo = gitRepo();
  assert.deepStrictEqual(repoWindow.claimRepo(repo, 'w1'), { claimed: true, heldBy: null });
  assert.strictEqual(fs.existsSync(path.join(repo, '.plt-owner.json')), false);
  assert.strictEqual(fs.existsSync(path.join(repo, '.git', '.plt-owner.json')), true);
  assert.strictEqual(fs.existsSync(path.join(repo, '.git', '.plt.lock')), false);   // released
  const pin = spine.computePin(repo);
  assert.strictEqual(pin.refused, undefined, `pin refused: ${JSON.stringify(pin.refused)}`);
  assert.strictEqual(pin.kind, 'sha');
  assert.strictEqual(repoWindow.repoOwner(repo).window, 'w1');
});

test('each worktree has its own claim: claiming the main checkout leaves a linked worktree unclaimed', () => {
  const repo = gitRepo();
  const wt = path.join(tmpdir(), 'linked');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', wt, '-b', 'window/linked']);
  repoWindow.claimRepo(repo, 'w1');
  assert.strictEqual(repoWindow.repoOwner(wt).window, null);
  assert.deepStrictEqual(repoWindow.claimRepo(wt, 'w2'), { claimed: true, heldBy: null });
  assert.strictEqual(repoWindow.repoOwner(repo).window, 'w1');
  assert.strictEqual(repoWindow.repoOwner(wt).window, 'w2');
});
