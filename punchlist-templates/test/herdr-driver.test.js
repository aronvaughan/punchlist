'use strict';
// The herdr driver behind `windows.*`.
// No test talks to a real herdr. A fake `herdr` (HERDR_BIN) records every call. It answers with the
// shapes herdr 0.9.3 prints from `herdr api schema --json`: `{result: {workspaces}}` and
// `{result: {workspace, tab, root_pane}}`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const effort = require('../lib/effort');
const spine = require('../lib/spine');
const yaml = require('../lib/yaml');

const WINDOW = path.join(__dirname, '..', 'scripts', 'herdr', 'herdr-window.sh');
const STATE = path.join(__dirname, '..', 'scripts', 'herdr', 'pane-state.sh');
const FIX = path.join(__dirname, 'fixtures', 'spine');

// ---- the fake herdr ----------------------------------------------------------

const FAKE = `#!/usr/bin/env node
const fs = require('fs');
const st = JSON.parse(fs.readFileSync(process.env.FAKE_HERDR_STATE, 'utf8'));
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(a) + '\\n');
if (process.env.FAKE_HERDR_FAIL) { process.stderr.write('error: herdr server is not running\\n'); process.exit(1); }
if (process.env.FAKE_HERDR_WARN) process.stderr.write('warning: a newer herdr is available\\n');
if (a[0] === 'workspace' && a[1] === 'list' && process.env.FAKE_HERDR_LIST) { process.stdout.write(process.env.FAKE_HERDR_LIST); process.exit(0); }
if (process.env.FAKE_HERDR_LATIN1) { process.stderr.write(Buffer.concat([Buffer.from('error: caf'), Buffer.from([0xe9]), Buffer.from(' broke\\n' + 'x'.repeat(2000) + '\\n')])); process.exit(1); }
if (process.env.FAKE_HERDR_EMPTY === a[0] + ' ' + a[1]) { process.stdout.write(JSON.stringify({ id: 'cli', result: {} })); process.exit(0); }
if (process.env.FAKE_HERDR_STDOUT_FAIL === a[0] + ' ' + a[1]) { process.stdout.write(JSON.stringify({ id: 'cli', error: { code: 'workspace_not_found' } }) + '\\n'); process.exit(1); }
const flag = (n) => { const i = a.indexOf(n); return i < 0 ? null : a[i + 1]; };
const out = (result) => { fs.writeFileSync(process.env.FAKE_HERDR_STATE, JSON.stringify(st)); process.stdout.write(JSON.stringify({ id: 'cli', result }) + '\\n'); };
const [grp, cmd] = a;
if (grp === 'workspace' && cmd === 'list') out({ type: 'workspace_list', workspaces: st.workspaces });
else if (grp === 'workspace' && cmd === 'create') {
  const id = 'w' + (st.workspaces.length + 1); st.tabs[id] = 1;
  st.workspaces.push({ workspace_id: id, label: flag('--label') });
  out({ type: 'workspace_created', workspace: { workspace_id: id, label: flag('--label') }, tab: { tab_id: id + ':t1' }, root_pane: { pane_id: id + ':p1' } });
} else if (grp === 'tab' && cmd === 'create') {
  const ws = flag('--workspace'); const n = ++st.tabs[ws];
  out({ type: 'tab_created', tab: { tab_id: ws + ':t' + n, workspace_id: ws, label: flag('--label') }, root_pane: { pane_id: ws + ':p' + n, workspace_id: ws } });
} else out({ type: 'ok' });
`;

function fakeHerdr({ workspaces = [], fail = false, warn = false, list = null, empty = null, stdoutFail = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-fake-'));
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(bin, FAKE, { mode: 0o755 });
  const state = path.join(dir, 'state.json');
  const tabs = {}; for (const w of workspaces) tabs[w.workspace_id] = 1;
  fs.writeFileSync(state, JSON.stringify({ workspaces, tabs }));
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(log, '');
  const env = { ...process.env, HERDR_BIN: bin, FAKE_HERDR_STATE: state, FAKE_HERDR_LOG: log };
  if (fail) env.FAKE_HERDR_FAIL = '1';
  if (warn) env.FAKE_HERDR_WARN = '1';
  if (list !== null) env.FAKE_HERDR_LIST = list;
  if (empty) env.FAKE_HERDR_EMPTY = empty;
  if (stdoutFail) env.FAKE_HERDR_STDOUT_FAIL = stdoutFail;
  return { env, calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

function run(script, args, env) {
  const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', env });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---- pane-state.sh: the state map ------------------------------------------------

// Every step state lib/spine.js writes. `done` and `skipped` report as `idle`: herdr's
// pane.report_agent accepts only idle|working|blocked|unknown.
const STATE_MAP = {
  pending: 'idle ○', ready: 'idle ◔', in_progress: 'working ●', in_review: 'working ◑',
  blocked: 'blocked ⚠', done: 'idle ✓', skipped: 'idle ⊘', repeated: 'working ↻',
};

test('pane-state: the map is total over the spine step states, and every herdr state is one report_agent accepts', () => {
  for (const [state, want] of Object.entries(STATE_MAP)) {
    const r = run(STATE, [state], process.env);
    assert.strictEqual(r.code, 0, `${state}: ${r.stderr}`);
    assert.strictEqual(r.stdout.trim(), want, state);
    assert.ok(['idle', 'working', 'blocked', 'unknown'].includes(want.split(' ')[0]), `${state} maps to a state herdr refuses`);
  }
});

test('pane-state: an unknown step state is exit 2, not a guess', () => {
  const r = run(STATE, ['finished'], process.env);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /unknown step state: finished/);
});

test('pane-state report: a done step reports idle on the pane, with the icon and the step in the message', () => {
  const h = fakeHerdr();
  const r = run(STATE, ['report', '--pane', 'w1:p2', '--state', 'done', '--step', 'build', '--run', 'T8'], h.env);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(h.calls(), [['pane', 'report-agent', 'w1:p2', '--source', 'plt', '--agent', 'plt', '--state', 'idle', '--message', '✓ T8 build']]);
});

// ---- herdr-window.sh open ----------------------------------------------------------

test('open: the first card of an effort creates the workspace, then a tab for the card, and names the pane <effort>/<card>', () => {
  const h = fakeHerdr();
  const cwd = path.join(os.tmpdir(), 'a dir with spaces');
  const r = run(WINDOW, ['open', '--effort', 'greenhouse', '--card', 'TRK-10', '--cwd', cwd], h.env);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(h.calls(), [
    ['workspace', 'list'],
    ['workspace', 'create', '--label', 'greenhouse', '--cwd', cwd, '--no-focus'],
    ['tab', 'create', '--workspace', 'w1', '--label', 'TRK-10', '--cwd', cwd, '--no-focus'],
    ['pane', 'rename', 'w1:p2', 'greenhouse/TRK-10'],
  ]);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.root_pane.pane_id, 'w1:p2');
  assert.strictEqual(out.tab.tab_id, 'w1:t2');
  assert.deepStrictEqual(out.workspace, { workspace_id: 'w1', label: 'greenhouse' });
  assert.strictEqual(out.root_pane.label, 'greenhouse/TRK-10');
});

test('open: a card whose effort already has a workspace joins it and creates none', () => {
  const h = fakeHerdr({ workspaces: [{ workspace_id: 'w1', label: 'other' }, { workspace_id: 'w2', label: 'greenhouse' }] });
  const r = run(WINDOW, ['open', '--effort', 'greenhouse', '--card', 'TRK-12'], h.env);
  assert.strictEqual(r.code, 0, r.stderr);
  const calls = h.calls();
  assert.ok(!calls.some((c) => c[0] === 'workspace' && c[1] === 'create'), JSON.stringify(calls));
  assert.deepStrictEqual(calls[1], ['tab', 'create', '--workspace', 'w2', '--label', 'TRK-12', '--no-focus']);
  assert.strictEqual(JSON.parse(r.stdout).root_pane.pane_id, 'w2:p2');
});

test('open: a name is data, never code — a quote in it cannot reach the JSON reader', () => {
  const h = fakeHerdr();
  const card = `x"); process.exit(9); ("`;
  const r = run(WINDOW, ['open', '--effort', 'greenhouse', '--card', card], h.env);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).root_pane.label, `greenhouse/${card}`);
  assert.deepStrictEqual(h.calls()[3], ['pane', 'rename', 'w1:p2', `greenhouse/${card}`]);
});

test('open: the effort workspace opens in --workspace-cwd, the card tab in --cwd', () => {
  const h = fakeHerdr();
  const r = run(WINDOW, ['open', '--effort', 'greenhouse', '--card', 'TRK-10', '--cwd', '/wt/TRK-10', '--workspace-cwd', '/umbrella'], h.env);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(h.calls()[1], ['workspace', 'create', '--label', 'greenhouse', '--cwd', '/umbrella', '--no-focus']);
  assert.deepStrictEqual(h.calls()[2].slice(6, 8), ['--cwd', '/wt/TRK-10']);
});

// A broken answer to `workspace list` must stop the driver. Treating it as "no workspace yet"
// creates a second workspace for the effort, which is the invariant open exists to keep.
for (const [what, list, msg] of [
  ['not JSON', 'Welcome to herdr', /herdr did not print JSON/],
  ['an {error}', JSON.stringify({ id: 'cli', error: { code: 'bad_request' } }), /herdr error: .*bad_request/],
]) {
  test(`open: a workspace list answer that is ${what} stops the driver and creates nothing`, () => {
    const h = fakeHerdr({ list });
    const r = run(WINDOW, ['open', '--effort', 'greenhouse', '--card', 'TRK-10'], h.env);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, msg);
    assert.deepStrictEqual(h.calls(), [['workspace', 'list']]);
    assert.strictEqual(r.stdout, '');
  });
}

test('open: a create answer with no id stops the driver, naming what was missing', () => {
  for (const [empty, msg] of [['workspace create', /workspace create returned no workspace_id/], ['tab create', /tab create returned no root pane/]]) {
    const h = fakeHerdr({ empty });
    const r = run(WINDOW, ['open', '--effort', 'greenhouse', '--card', 'TRK-10'], h.env);
    assert.strictEqual(r.code, 1, empty);
    assert.match(r.stderr, msg);
    assert.strictEqual(r.stdout, '');
  }
});

test('open: a failing call whose reason is on stdout still names the reason', () => {
  const h = fakeHerdr({ stdoutFail: 'tab create' });
  const r = run(WINDOW, ['open', '--effort', 'greenhouse', '--card', 'TRK-10'], h.env);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /herdr tab create failed: .*workspace_not_found/);
});

test('open: a warning herdr writes to stderr on a successful call does not reach the JSON reader', () => {
  const h = fakeHerdr({ warn: true });
  const r = run(WINDOW, ['open', '--effort', 'greenhouse', '--card', 'TRK-10'], h.env);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).root_pane.pane_id, 'w1:p2');
});

test('usage errors are exit 2 with the missing argument named', () => {
  const cases = [
    [WINDOW, ['open', '--effort', 'e'], /open needs --effort and --card/],
    [WINDOW, ['open', '--effort', 'e', '--card', 'c', '--label', 'x'], /open: unknown argument: --label/],
    [WINDOW, ['seed', '--pane', 'w1:p1'], /seed needs --pane and --run/],
    [WINDOW, ['notify', '--next', 'x'], /notify needs --text/],
    [WINDOW, ['launch'], /usage: herdr-window.sh open\|seed\|notify/],
    [STATE, ['report', '--state', 'done'], /report needs --pane and --state/],
    [STATE, ['report', '--pane', 'w1:p1', '--state', 'finished'], /unknown step state: finished/],
    [STATE, [], /usage: pane-state.sh/],
  ];
  for (const [script, args, msg] of cases) {
    const r = run(script, args, { ...process.env, HERDR_BIN: '/nonexistent/herdr' });
    assert.strictEqual(r.code, 2, `${path.basename(script)} ${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, msg);
  }
});

test('pane-state report: no herdr on PATH is exit 1 naming the installer', () => {
  const r = run(STATE, ['report', '--pane', 'w1:p1', '--state', 'done'], { ...process.env, HERDR_BIN: '/nonexistent/herdr' });
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /herdr is not on PATH \(plt deps install herdr\)/);
});

test('open: no herdr on PATH is one line naming the installer, and a non-zero exit', () => {
  const r = run(WINDOW, ['open', '--effort', 'e', '--card', 'c'], { ...process.env, HERDR_BIN: '/nonexistent/herdr' });
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /herdr is not on PATH \(plt deps install herdr\)/);
});

test('open: a herdr call that fails stops the driver with herdr\'s own message', () => {
  const h = fakeHerdr({ fail: true });
  const r = run(WINDOW, ['open', '--effort', 'e', '--card', 'c'], h.env);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /herdr workspace list failed: error: herdr server is not running/);
  assert.strictEqual(r.stdout, '');
});

// ---- seed and notify ------------------------------------------------------------

test('seed: runs prime in the pane with PLT_WINDOW set to that pane, from the card\'s directory', () => {
  const h = fakeHerdr();
  const r = run(WINDOW, ['seed', '--pane', 'w1:p2', '--run', 'TRK-10', '--cwd', '/tmp/a b'], h.env);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(h.calls(), [['pane', 'run', 'w1:p2', 'cd /tmp/a\\ b && export PLT_WINDOW=w1:p2 && plt prime --run TRK-10']]);
});

// Found by a live run against herdr 0.9.3. The pane sits in the card's worktree, and plt resolves
// process/runs from its cwd. The runs live in the canonical checkout, so prime printed
// "no run <card>". The seed must carry the process dir.
test('seed: --process-dir exports PLT_PROCESS_DIR, so prime finds the run from inside a worktree', () => {
  const h = fakeHerdr();
  const r = run(WINDOW, ['seed', '--pane', 'w1:p2', '--run', 'TRK-10', '--cwd', '/wt/TRK-10', '--process-dir', '/canon/my process'], h.env);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(h.calls(), [['pane', 'run', 'w1:p2', 'cd /wt/TRK-10 && export PLT_PROCESS_DIR=/canon/my\\ process PLT_WINDOW=w1:p2 && plt prime --run TRK-10']]);
});

test('notify: the change is the title and the next command the body', () => {
  const h = fakeHerdr();
  const r = run(WINDOW, ['notify', '--text', 'TRK-10: a → b', '--next', 'plt step start review --run TRK-10'], h.env);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(h.calls(), [['notification', 'show', 'TRK-10: a → b', '--body', 'plt step start review --run TRK-10']]);
});

// ---- through the real launchWave ------------------------------------------------

// The canonical checkout launchWave branches worktrees off (see test/effort.test.js).
function tmpCanonical() {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-origin-'));
  execFileSync('git', ['-C', origin, 'init', '-q', '--bare']);
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-seed-'));
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 't']]) execFileSync('git', ['-C', seed, ...a]);
  fs.writeFileSync(path.join(seed, 'seed.txt'), 'seed\n');
  for (const a of [['add', 'seed.txt'], ['commit', '-qm', 'init'], ['remote', 'add', 'origin', origin], ['push', '-q', 'origin', 'main']]) execFileSync('git', ['-C', seed, ...a]);
  execFileSync('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const canon = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-canon-'));
  execFileSync('git', ['clone', '-q', origin, canon]);
  return canon;
}

test('launchWave with the driver as windows.*: one workspace for the effort, a pane per card, recorded in inputs.window', () => {
  const h = fakeHerdr();
  // A space in the umbrella: the templates carry {path}/{umbrella}/{process_dir} bare, and
  // launchWave must quote them or `--cwd` splits into two arguments.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd spine-'));
  const p = path.join(root, 'process');
  fs.cpSync(FIX, p, { recursive: true });
  fs.writeFileSync(path.join(p, 'config', 'zz-herdr-test.yaml'), yaml.stringify({
    worktree: { canonical: tmpCanonical(), repo: 'greenhouse-app' },
    windows: {
      // The shipped samples verbatim: {templates} is filled in by plt, so config carries no path.
      command: 'bash {templates}/scripts/herdr/herdr-window.sh open --effort {effort} --card {card} --cwd {path} --workspace-cwd {umbrella}',
      open: 'bash {templates}/scripts/herdr/herdr-window.sh seed --pane {pane_id} --run {card} --cwd {path} --process-dir {process_dir}',
    },
  }));
  const exec = (cmd, opts) => execFileSync('sh', ['-c', cmd], { encoding: 'utf8', cwd: opts && opts.cwd, env: h.env });
  const result = effort.launchWave(p, 'greenhouse', { exec });

  assert.deepStrictEqual(result.skipped, []);
  assert.ok(result.launched.every((l) => l.window && !l.window.error), JSON.stringify(result.launched.map((l) => l.window)));
  const calls = h.calls();
  assert.ok(!JSON.stringify(calls).includes('{path}'), 'no template token reaches herdr — a spike card has a {path} too');
  // TRK-13 is the fixture's spike: no worktree, so its window opens in the canonical checkout.
  const spikeTab = calls.find((c) => c[0] === 'tab' && c.includes('TRK-13'));
  assert.strictEqual(spikeTab[spikeTab.indexOf('--cwd') + 1], spine.readInputs(p, 'TRK-13').repo_dir);
  assert.deepStrictEqual(calls.find((c) => c[0] === 'workspace' && c[1] === 'create').slice(4, 6), ['--cwd', root]);
  assert.strictEqual(calls.filter((c) => c[0] === 'workspace' && c[1] === 'create').length, 1, 'one workspace for the whole wave');
  assert.deepStrictEqual(calls.find((c) => c[1] === 'create' && c[0] === 'workspace').slice(2, 4), ['--label', 'greenhouse']);
  for (const card of result.launched.map((l) => l.card)) {
    const win = spine.readInputs(p, card).window;
    assert.match(String(win.pane_id), /^w1:p\d+$/, `${card} records the pane the driver opened`);
    assert.strictEqual(win.label, `greenhouse/${card}`, `${card} records the pane's herdr name, not a second one`);
    assert.ok(calls.some((c) => c[0] === 'pane' && c[1] === 'rename' && c[3] === `greenhouse/${card}`), `${card} pane is named`);
    assert.ok(calls.some((c) => c[0] === 'pane' && c[1] === 'run' && c[2] === win.pane_id && c[3].includes(`PLT_WINDOW=${win.pane_id}`) && c[3].includes(`PLT_PROCESS_DIR=${p.replace(/ /g, '\\ ')} `)), `${card} pane is seeded with the process dir`);
  }
});

// The driver's one stderr line is only useful if a person sees it. launchWave records the window
// failure without failing the launch (the run and worktree exist); `plt effort launch` must print it.
test('plt effort launch prints a window that failed to open, naming the card and the driver\'s message', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-cli-'));
  const p = path.join(root, 'process');
  fs.cpSync(FIX, p, { recursive: true });
  fs.writeFileSync(path.join(p, 'config', 'zz-herdr-test.yaml'), yaml.stringify({
    worktree: { canonical: tmpCanonical(), repo: 'greenhouse-app' },
    windows: { command: `bash ${WINDOW} open --effort {effort} --card {card} --cwd {path}` },
  }));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'plt'), 'effort', 'launch', 'greenhouse', '--only', 'TRK-10'],
    { encoding: 'utf8', env: { ...process.env, PLT_PROCESS_DIR: p, HERDR_BIN: '/nonexistent/herdr' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^launched: TRK-10/m);
  assert.match(r.stderr, /^window: TRK-10 — no window opened: herdr-window: herdr is not on PATH \(plt deps install herdr\)$/m);
});

test('open: a temp directory that cannot be written stops the driver, naming the directory', () => {
  const h = fakeHerdr();
  const r = run(WINDOW, ['open', '--effort', 'greenhouse', '--card', 'TRK-10'], { ...h.env, TMPDIR: '/nonexistent/tmp' });
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /cannot create a temp file in \/nonexistent\/tmp/);
  assert.strictEqual(r.stdout, '');
});

test('a failure message survives a non-UTF-8 byte and a huge answer: whole, one line, capped', () => {
  const h = fakeHerdr();
  const r = run(WINDOW, ['open', '--effort', 'greenhouse', '--card', 'TRK-10'], { ...h.env, FAKE_HERDR_LATIN1: '1', LANG: 'en_US.UTF-8' });
  assert.strictEqual(r.code, 1);
  assert.doesNotMatch(r.stderr, /Illegal byte sequence/);
  const line = r.stderr.split('\n').find((l) => l.startsWith('herdr-window: herdr workspace list failed: error: caf'));
  assert.ok(line, r.stderr);
  assert.match(line, / broke x+$/);
  assert.ok(Buffer.byteLength(line, 'latin1') < 500, `capped: ${line.length}`);
});

// plt watch fills {templates} too, so the shipped notify sample runs as written.
test('plt watch runs the shipped notify sample: {templates} resolves and the driver shows the change', () => {
  const h = fakeHerdr();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-watch-'));
  const p = path.join(root, 'process');
  fs.cpSync(FIX, p, { recursive: true });
  fs.writeFileSync(path.join(p, 'config', 'zz-herdr-test.yaml'), yaml.stringify({
    windows: { notify: 'bash {templates}/scripts/herdr/herdr-window.sh notify --text {text} --next {next}' },
  }));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-repo-'));
  for (const a of [['init', '-q'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 't']]) execFileSync('git', ['-C', repo, ...a]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  for (const a of [['add', 'a.txt'], ['commit', '-qm', 'init']]) execFileSync('git', ['-C', repo, ...a]);
  spine.launchRun(p, { runId: 'TRK-70', cycle: 'build-and-ship', repoDir: repo, owner: 'agent' });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-70', 'inputs.yaml'), yaml.stringify({ card: 'TRK-70', window: { tab_id: 'w1:t2', pane_id: 'w1:p2', label: 'greenhouse/TRK-70' } }));
  fs.mkdirSync(path.join(p, 'build'), { recursive: true });
  fs.writeFileSync(path.join(p, 'build', 'watch.json'), JSON.stringify({ 'TRK-70': 'plt old' }));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'plt'), 'watch', '--once'], { encoding: 'utf8', env: { ...h.env, PLT_PROCESS_DIR: p } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(h.calls(), [['notification', 'show', 'TRK-70: plt old → plt step start scope --run TRK-70', '--body', 'plt step start scope --run TRK-70']]);
});

// ---- the effort cycle compiles without a tools.herdr key ---------------------
// The driver retired `tools.herdr`: herdr is declared in `deps` and panes open through
// `windows.*`. The effort pack still named `{{config.tools.herdr}}` on three steps, and
// resolveRef throws on a missing key, so `plt run launch --cycle effort` failed on every
// project that followed the ADR. The same compile also needs `review.effort_agents`, which
// the shipped defaults did not declare.

test('every step of the shipped effort pack compiles against this project\'s config, which has no tools.herdr', () => {
  const { parseWorkflow } = require('../bin/plt');
  const wf = parseWorkflow(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'packs', 'core', 'effort.md'), 'utf8'));
  const config = spine.loadConfig(path.join(__dirname, '..', 'process'));
  assert.strictEqual((config.tools || {}).herdr, undefined, 'this project follows the ADR: no tools.herdr');
  for (const s of wf.steps) {
    assert.doesNotThrow(() => spine.compileRequirements(s, config), `step ${s.id}`);
  }
});

// ---- overlapCheck measures from the configured worktree.base -----------------
// Found on this card's own pre-pr: the repo has no `origin/main`, so branchBase fell back to the
// launch pin. After the card merged master, every file master gained counted as the card's, and
// the overlap check held it against siblings it never touched. `worktree.base` (here `master`)
// names the branch a card merges into, so the merge-base with it is the card's true base.

function git(dir, ...args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim(); }

test('overlapCheck: after the card merges master, a file master brought in is not the card\'s', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-'));
  fs.cpSync(FIX, path.join(root, 'process'), { recursive: true });
  const p = path.join(root, 'process');
  fs.writeFileSync(path.join(p, 'config', 'zz-base.yaml'), yaml.stringify({ worktree: { base: 'master' } }));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'r.txt'), 'one\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  const a = path.join(root, 'a'); const b = path.join(root, 'b');
  git(repo, 'worktree', 'add', '-q', '-b', 'card-a', a, 'master');
  spine.launchRun(p, { runId: 'TRK-20', cycle: 'build-and-ship', repoDir: a, owner: 'o', estimate: 1 });
  fs.writeFileSync(path.join(a, 'a.txt'), 'a\n'); git(a, 'add', '-A'); git(a, 'commit', '-qm', 'a: own work');
  // master moves on r.txt, and card A merges it, as T8 merged master.
  fs.writeFileSync(path.join(repo, 'r.txt'), 'two\n'); git(repo, 'commit', '-qam', 'master: r');
  git(a, 'merge', '-q', '--no-edit', 'master');
  // Card B starts from the new master and edits r.txt, uncommitted.
  git(repo, 'worktree', 'add', '-q', '-b', 'card-b', b, 'master');
  spine.launchRun(p, { runId: 'TRK-21', cycle: 'build-and-ship', repoDir: b, owner: 'o', estimate: 1 });
  fs.writeFileSync(path.join(b, 'r.txt'), 'three\n');
  for (const id of ['TRK-20', 'TRK-21']) fs.writeFileSync(path.join(p, 'runs', id, 'inputs.yaml'), yaml.stringify({ effort: 'greenhouse' }));
  const r = effort.overlapCheck(p, 'TRK-20', { repoDir: a });
  assert.deepStrictEqual(r.shared, []);
  assert.strictEqual(r.ok, true);
  // A real overlap still blocks: card A now edits r.txt itself.
  fs.writeFileSync(path.join(a, 'r.txt'), 'mine\n');
  assert.deepStrictEqual(effort.overlapCheck(p, 'TRK-20', { repoDir: a }).shared, [{ run: 'TRK-21', files: ['r.txt'] }]);
});

test('branchBase: the configured base wins over the launch pin, and an unresolvable one falls through', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'x.txt'), '1\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  const root = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'card');
  fs.writeFileSync(path.join(repo, 'y.txt'), '1\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'card');
  const pin = { kind: 'sha', value: 'cafef00d' };
  assert.strictEqual(effort.branchBase(repo, pin, 'master'), root);
  assert.strictEqual(effort.branchBase(repo, pin, 'no-such-branch'), 'cafef00d');
  // A base that resolves but shares no history with HEAD falls through to the pin, too.
  git(repo, 'checkout', '-q', '--orphan', 'unrelated'); git(repo, 'commit', '-qm', 'orphan');
  git(repo, 'checkout', '-q', 'card');
  assert.strictEqual(effort.branchBase(repo, pin, 'unrelated'), 'cafef00d');
  assert.strictEqual(effort.branchBase(repo, pin), 'cafef00d');
});

test('overlapCheck: a config it cannot read stops the check and names the config directory', () => {
  // Falling back to the launch pin would bring back the false overlaps, so the check must stop.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-'));
  fs.cpSync(FIX, path.join(root, 'process'), { recursive: true });
  const p = path.join(root, 'process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'r.txt'), 'one\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  spine.launchRun(p, { runId: 'TRK-30', cycle: 'build-and-ship', repoDir: repo, owner: 'o', estimate: 1 });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-30', 'inputs.yaml'), yaml.stringify({ effort: 'greenhouse' }));
  fs.writeFileSync(path.join(p, 'config', 'zz-broken.yaml'), 'worktree:\n  base: [\n');
  assert.throws(() => effort.overlapCheck(p, 'TRK-30', { repoDir: repo }),
    (e) => e.message.startsWith(`overlapCheck: cannot read the config in ${path.join(p, 'config')}: `) && /line \d+/.test(e.message));
});
