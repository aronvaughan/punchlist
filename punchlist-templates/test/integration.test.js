'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const integration = require('../lib/integration');
const PLT = path.join(__dirname, '..', 'bin', 'plt');
const SHIPPED = path.join(__dirname, '..', 'integrations', 'claude');
const V = integration.shippedVersion(SHIPPED);   // the header stamps whatever spine_common.py ships

const HOOK_FILES = ['spine_common.py', 'spine-receipt.py', 'spine-gate.py', 'spine-guard.py', 'spine-prime.py', 'spine-stop.py'];
const AGENT_FILES = ['writing-adversary.md'];
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact'];
const FOREIGN = 'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/other-gate.py"';

// A temp project with a settings.json that already carries a non-spine PreToolUse Bash hook.
function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: FOREIGN }] }] },
    other: { keep: true },
  }, null, 2) + '\n');
  execFileSync('git', ['-C', dir, 'init', '-q']);
  return dir;
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const commandsOf = (settings, event) => (settings.hooks[event] || []).flatMap((g) => g.hooks.map((h) => h.command));
function plt(args, cwd, env = {}) {
  // Pin PLT_PROCESS_DIR: a session env pointing at a real project must not leak into the test.
  const r = spawnSync('node', [PLT, ...args], { cwd, encoding: 'utf8', env: { ...process.env, PLT_PROCESS_DIR: path.join(cwd, 'process'), ...env } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('install claude: files, headers, merged settings, permissions; status reports installed', () => {
  const dir = tmpProject();
  const res = integration.installClaude(dir, { shippedDir: SHIPPED });
  assert.ok(res.installed.length >= 7, 'reports installed files');

  for (const f of HOOK_FILES) {
    const body = fs.readFileSync(path.join(dir, '.claude', 'hooks', f), 'utf8');
    const lines = body.split('\n');
    assert.strictEqual(lines[0], '#!/usr/bin/env python3', f + ' keeps its shebang first');
    assert.strictEqual(lines[1], `# installed by plt integration claude v${V} — reinstalling overwrites`, f + ' header');
  }
  for (const f of AGENT_FILES) {
    const body = fs.readFileSync(path.join(dir, '.claude', 'agents', f), 'utf8');
    assert.ok(body.startsWith('---\n'), f + ' keeps its frontmatter first');
    const afterFm = body.indexOf('\n---\n') + 5;
    assert.ok(body.slice(afterFm).startsWith(`<!-- installed by plt integration claude v${V} — reinstalling overwrites -->\n`), f + ' header after frontmatter');
  }

  const settings = readJson(path.join(dir, '.claude', 'settings.json'));
  assert.deepStrictEqual(settings.other, { keep: true }, 'unrelated settings keys survive');
  for (const ev of EVENTS) assert.ok(Array.isArray(settings.hooks[ev]) && settings.hooks[ev].length, 'event wired: ' + ev);
  const pre = commandsOf(settings, 'PreToolUse');
  assert.ok(pre.includes(FOREIGN), 'the non-spine PreToolUse hook is still there');
  assert.ok(pre.some((c) => c.includes('spine-gate.py')), 'spine gate added');
  assert.ok(pre.some((c) => c.includes('spine-guard.py')), 'spine guard added');
  // The gate joins the existing Bash matcher group rather than opening a second one.
  const bashGroups = settings.hooks.PreToolUse.filter((g) => g.matcher === 'Bash');
  assert.strictEqual(bashGroups.length, 1, 'one Bash matcher group');

  const local = readJson(path.join(dir, '.claude', 'settings.local.json'));
  assert.ok(local.permissions.ask.includes('Bash(plt gate approve *)'));
  assert.ok(local.permissions.ask.includes('Bash(node * gate approve *)'));
  assert.ok(local.permissions.allow.includes('Bash(plt gate check *)'));
  assert.ok(local.permissions.allow.includes('Bash(plt prime *)'));
  assert.ok(!local.permissions.allow.some((r) => /gate approve/.test(r)), 'gate approve is never allowed silently');

  const st = integration.statusClaude(dir, { shippedDir: SHIPPED });
  assert.strictEqual(st.ok, true);
  for (const f of [...HOOK_FILES, ...AGENT_FILES]) {
    const row = st.files.find((r) => r.file.endsWith(f));
    assert.ok(row, 'status row for ' + f);
    assert.strictEqual(row.state, 'installed', f + ' installed');
    assert.strictEqual(row.installed, V);
  }
  assert.strictEqual(st.settings.ok, true);
});

test('status: modified, stale and missing files; settings missing an event', () => {
  const dir = tmpProject();
  integration.installClaude(dir, { shippedDir: SHIPPED });

  const guard = path.join(dir, '.claude', 'hooks', 'spine-guard.py');
  fs.appendFileSync(guard, '\n# local edit\n');
  let st = integration.statusClaude(dir, { shippedDir: SHIPPED });
  assert.strictEqual(st.ok, false);
  assert.strictEqual(st.files.find((r) => r.file.endsWith('spine-guard.py')).state, 'modified');

  const stop = path.join(dir, '.claude', 'hooks', 'spine-stop.py');
  fs.writeFileSync(stop, fs.readFileSync(stop, 'utf8').replace(`claude v${V} —`, 'claude v0 —'));
  st = integration.statusClaude(dir, { shippedDir: SHIPPED });
  const stopRow = st.files.find((r) => r.file.endsWith('spine-stop.py'));
  assert.strictEqual(stopRow.state, 'stale');
  assert.strictEqual(stopRow.installed, 0);
  assert.strictEqual(stopRow.shipped, V);

  fs.unlinkSync(path.join(dir, '.claude', 'agents', 'writing-adversary.md'));
  st = integration.statusClaude(dir, { shippedDir: SHIPPED });
  assert.strictEqual(st.files.find((r) => r.file.endsWith('writing-adversary.md')).state, 'missing');

  const sf = path.join(dir, '.claude', 'settings.json');
  const settings = readJson(sf); delete settings.hooks.Stop; fs.writeFileSync(sf, JSON.stringify(settings));
  st = integration.statusClaude(dir, { shippedDir: SHIPPED });
  assert.strictEqual(st.settings.ok, false);
  assert.deepStrictEqual(st.settings.missing, ['Stop']);
});

test('install is idempotent: a second run is byte-identical, no duplicate hooks or permissions', () => {
  const dir = tmpProject();
  integration.installClaude(dir, { shippedDir: SHIPPED });
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'first install']);
  const second = integration.installClaude(dir, { shippedDir: SHIPPED });
  assert.deepStrictEqual(second.changed, [], 'second install changes nothing');
  const diff = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.strictEqual(diff, '', 'git sees no change after the second install');

  const settings = readJson(path.join(dir, '.claude', 'settings.json'));
  const pre = commandsOf(settings, 'PreToolUse');
  assert.strictEqual(pre.filter((c) => c.includes('spine-gate.py')).length, 1, 'gate wired once');
  assert.strictEqual(pre.filter((c) => c === FOREIGN).length, 1, 'foreign hook once');
  for (const ev of EVENTS) {
    const cmds = commandsOf(settings, ev);
    assert.strictEqual(new Set(cmds).size, cmds.length, 'no duplicate commands in ' + ev);
  }
  const local = readJson(path.join(dir, '.claude', 'settings.local.json'));
  for (const k of ['ask', 'allow']) assert.strictEqual(new Set(local.permissions[k]).size, local.permissions[k].length, 'no duplicate ' + k);
});

test('cli: plt integration install|status claude --project <dir>', () => {
  const dir = tmpProject();
  let r = plt(['integration', 'install', 'claude', '--project', dir], os.tmpdir());
  assert.strictEqual(r.code, 0, r.out);
  r = plt(['integration', 'status', 'claude', '--project', dir], os.tmpdir());
  assert.strictEqual(r.code, 0, r.out);
  const lines = r.out.trim().split('\n');
  for (const f of [...HOOK_FILES, ...AGENT_FILES]) assert.ok(lines.some((l) => l.includes(f) && new RegExp(`installed v${V}`).test(l)), 'line for ' + f + '\n' + r.out);
  assert.ok(lines.some((l) => /^settings: ok/.test(l)), 'settings line');

  fs.appendFileSync(path.join(dir, '.claude', 'hooks', 'spine-receipt.py'), '# edit\n');
  r = plt(['integration', 'status', 'claude', '--project', dir], os.tmpdir());
  assert.strictEqual(r.code, 1);
  assert.ok(r.out.split('\n').some((l) => l.includes('spine-receipt.py') && /modified/.test(l)), r.out);

  r = plt(['integration', 'status', 'nope', '--project', dir], os.tmpdir());
  assert.notStrictEqual(r.code, 0, 'unknown integration name fails');
});

// The hooks read every project value through `plt config` — the merged process/config, by dotted path.
test('cli: plt config prints the merged config by dotted path; exit 1 on a missing key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  fs.cpSync(path.join(__dirname, 'fixtures', 'spine'), path.join(root, 'process'), { recursive: true });
  let r = plt(['config', 'models.review_model'], root);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(JSON.parse(r.out), 'fable');
  r = plt(['config'], root);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(JSON.parse(r.out).review.panel_agents, ['sprout-reviewer']);
  r = plt(['config', 'no.such.key'], root);
  assert.strictEqual(r.code, 1);
});

// --- settings merge: a command already wired under another matcher group is not added again.
test('mergeHooks: dedupes a spine command across every matcher group of the event', () => {
  const gate = 'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/spine-gate.py"';
  const settings = { PreToolUse: [{ matcher: 'Bash|Edit', hooks: [{ type: 'command', command: gate }] }] };
  const shipped = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: gate, timeout: 30 }] }] };
  const out = integration.mergeHooks(settings, shipped);
  assert.strictEqual(out.PreToolUse.length, 1, 'no second group opened');
  assert.strictEqual(out.PreToolUse[0].hooks.length, 1, 'command wired once');
});

test('status: a gate-approve rule in allow is a violation (exit 1); CRLF and a trailing newline are not "modified"', () => {
  const dir = tmpProject();
  integration.installClaude(dir, { shippedDir: SHIPPED });
  const lf = path.join(dir, '.claude', 'settings.local.json');
  const local = readJson(lf); local.permissions.allow.push('Bash(plt gate approve *)'); fs.writeFileSync(lf, JSON.stringify(local));
  let st = integration.statusClaude(dir, { shippedDir: SHIPPED });
  assert.strictEqual(st.ok, false);
  assert.deepStrictEqual(st.permissions.violations, ['Bash(plt gate approve *) present in allow']);
  assert.ok(integration.renderStatus(st).includes('permissions: violation — Bash(plt gate approve *) present in allow'));
  let r = plt(['integration', 'status', 'claude', '--project', dir], os.tmpdir());
  assert.strictEqual(r.code, 1);

  local.permissions.allow.pop(); fs.writeFileSync(lf, JSON.stringify(local));
  const guard = path.join(dir, '.claude', 'hooks', 'spine-guard.py');
  fs.writeFileSync(guard, fs.readFileSync(guard, 'utf8').replace(/\n/g, '\r\n'));                       // CRLF
  const agent = path.join(dir, '.claude', 'agents', 'writing-adversary.md');
  fs.writeFileSync(agent, fs.readFileSync(agent, 'utf8').replace(/\n/g, '\r\n').replace(/\r\n$/, ''));   // CRLF, no final newline
  st = integration.statusClaude(dir, { shippedDir: SHIPPED });
  assert.strictEqual(st.files.find((f) => f.file.endsWith('spine-guard.py')).state, 'installed');
  assert.strictEqual(st.files.find((f) => f.file.endsWith('writing-adversary.md')).state, 'installed');
  assert.strictEqual(st.ok, true);
});

// --- the shipped gate hook, run for real against a TEMP project (never a live one): when the run
// has a state.yaml and `plt config` is unavailable, the gate denies instead of guessing a step map.
function gateFixture() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'gateproj-'));
  fs.cpSync(path.join(__dirname, 'fixtures', 'spine'), path.join(project, 'process'), { recursive: true });
  const product = fs.mkdtempSync(path.join(os.tmpdir(), 'gateprod-'));
  execFileSync('git', ['-C', product, 'init', '-q', '-b', 'feat/XY-1-thing']);
  const stub = path.join(project, 'plt-stub.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nif [ "$1" = config ]; then echo "unknown command: config"; exit 2; fi\nexit 0\n', { mode: 0o755 });
  return { project, product, stub };
}
function runGate({ project, product, stub }, command) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: project, PLT_BIN: stub, PYTHONDONTWRITEBYTECODE: '1' };
  delete env.PLT_RUN; delete env.CLAUDE_SESSION_ID;
  const r = spawnSync('python3', [path.join(SHIPPED, 'spine-gate.py')], {
    cwd: product, env, encoding: 'utf8',
    input: JSON.stringify({ tool_name: 'Bash', cwd: product, tool_input: { command } }),
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('spine-gate.py: config unavailable + state.yaml present → deny "config unavailable"; no state → silent allow', () => {
  const fx = gateFixture();
  const cmd = `git -C ${fx.product} commit -m x`;
  let r = runGate(fx, cmd);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, '', 'no state.yaml → silent allow');

  fs.mkdirSync(path.join(fx.project, 'process', 'runs', 'XY-1'), { recursive: true });
  fs.writeFileSync(path.join(fx.project, 'process', 'runs', 'XY-1', 'state.yaml'), `run: XY-1\nrepo_dir: ${fx.product}\n`);
  r = runGate(fx, cmd);
  assert.strictEqual(r.code, 0, r.err);
  const obj = JSON.parse(r.out);
  assert.strictEqual(obj.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(obj.hookSpecificOutput.permissionDecisionReason, /^spine gate: XY-1 — config unavailable — unknown command: config$/);
});

test('spine-gate.py: no process/config above cwd and no CLAUDE_PROJECT_DIR → exit 0, nothing claimed', () => {
  const fx = gateFixture();
  const env = { ...process.env, PLT_BIN: fx.stub, PYTHONDONTWRITEBYTECODE: '1' };
  delete env.PLT_RUN; delete env.CLAUDE_PROJECT_DIR; delete env.CLAUDE_SESSION_ID;
  const r = spawnSync('python3', [path.join(SHIPPED, 'spine-gate.py')], {
    cwd: fx.product, env, encoding: 'utf8',
    input: JSON.stringify({ tool_name: 'Bash', cwd: fx.product, tool_input: { command: `git -C ${fx.product} commit -m x` } }),
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
});
