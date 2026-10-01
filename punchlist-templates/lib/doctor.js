'use strict';
// doctor — one command that proves the framework is whole HERE: on this machine, against this
// project's own config, cycles, hooks, timers and denylist.
//
// The rule every check obeys: report what it PROVED, never what it assumes. This command exists
// because a timer reported "(loaded)" for six days while `runs = 0` — loaded is not running, and a
// check that reads a state file and calls it proof is how that happens. So `gh` shells out to
// `gh auth status` rather than testing whether a config key is set: the cheap check passes on a
// machine where gh is installed but unauthenticated, which is exactly the case worth catching.
// A shell-out is given 5 seconds and a timeout reports `skip`, never `fail` — a doctor that cries
// wolf gets ignored.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const spine = require('./spine');
const timersMod = require('./timers');
const integrationMod = require('./integration');

const REPO = path.resolve(__dirname, '..');
const PKG_VERSION = require('../package.json').version;
const TIMEOUT_MS = 5000;

// ---- optional modules ------------------------------------------------------
//
// `schemas` and `fsck` land in their own tasks. Until one is on disk, `require` throws and its check
// reports `skip` with `<module> not shipped yet` — never `fail`, because a missing validator is not
// evidence that a file is wrong. The require is lazy (inside the call, cached once) so loading
// doctor never depends on either, and neither task has to come back and edit this file.
const optional = {};
function optionalModule(request) {
  if (!(request in optional)) {
    try { optional[request] = require(request); } catch (e) { optional[request] = null; }
  }
  return optional[request];
}

// ---- shelling out ----------------------------------------------------------
//
// exec(cmd, args, {timeoutMs}) -> {code, stdout, stderr, timedOut, error}. Injected so a test reads
// a stand-in instead of the machine.
function defaultExec(cmd, args, { timeoutMs = TIMEOUT_MS } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs });
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT') || (r.status === null && r.signal === 'SIGTERM');
  return { code: r.status === undefined ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || '', timedOut, error: r.error || null };
}

// ---- check results ---------------------------------------------------------

function pass(detail) { return { state: 'pass', detail, fix: null }; }
function fail(detail, fix) { return { state: 'fail', detail, fix }; }
function skip(detail) { return { state: 'skip', detail, fix: null }; }

function expandHome(p, home) {
  return String(p)
    .replace(/^~(?=[/\\]|$)/, home)
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME/g, home);
}
// A relative path in config is relative to the PROJECT, never to whatever directory the command was
// typed in — `jira.script: .claude/skills/…` must resolve the same from any cwd.
function resolveConfigPath(raw, ctx) { return path.resolve(ctx.projectDir, expandHome(raw, ctx.home)); }
function firstLine(s) { return String(s || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || ''; }
function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

// ---- the checks ------------------------------------------------------------
//
// Each is `(ctx) => {state, detail, fix}`; `runDoctor` adds the id and title and catches throws.
// ctx = {projectDir, processDir, config, configError, platform, home, exec, env, deps}.

const CHECKS = [
  {
    id: 'plt-resolvable',
    title: "plt is on PATH at this checkout's version",
    fix: () => `ln -sf ${path.join(REPO, 'bin', 'plt')} ~/.local/bin/plt`,
    run(ctx) {
      const which = ctx.exec('sh', ['-c', 'command -v plt'], { timeoutMs: TIMEOUT_MS });
      if (which.timedOut) return skip(`command -v plt did not answer in 5s`);
      if (which.code !== 0 || !firstLine(which.stdout)) return fail('plt does not resolve on PATH', this.fix());
      const resolved = firstLine(which.stdout);
      const v = ctx.exec('plt', ['--version'], { timeoutMs: TIMEOUT_MS });
      if (v.timedOut) return skip('plt --version did not answer in 5s');
      if (v.code !== 0) return fail(`${resolved} --version exited ${v.code}${firstLine(v.stderr) ? ': ' + firstLine(v.stderr) : ''}`, this.fix());
      const got = firstLine(v.stdout);
      if (got !== PKG_VERSION) return fail(`${resolved} reports version ${got || '(nothing)'}; ${path.join(REPO, 'package.json')} says ${PKG_VERSION}`, this.fix());
      return pass(`${resolved} is version ${got}`);
    },
  },
  {
    id: 'process-dir',
    title: 'process/ holds config, cycles and runs',
    run(ctx) {
      const want = path.join(ctx.projectDir, 'process');
      const fixCmd = `mkdir -p ${path.join(want, 'config')} ${path.join(want, 'cycles')} ${path.join(want, 'runs')}`;
      if (!ctx.processDir) return fail(`no process/config directory at or above ${ctx.projectDir}`, fixCmd);
      const missing = ['config', 'cycles', 'runs'].filter((d) => !fs.existsSync(path.join(ctx.processDir, d)));
      if (missing.length) return fail(`${ctx.processDir} is missing ${missing.join(', ')}`, `mkdir -p ${missing.map((d) => path.join(ctx.processDir, d)).join(' ')}`);
      return pass(`${ctx.processDir} holds config, cycles and runs`);
    },
  },
  {
    id: 'config-layering',
    title: 'every config file parses on its own, and the merge resolves',
    run(ctx) {
      if (!ctx.processDir) return fail('no process directory to read config from', `plt doctor --project ${ctx.projectDir}`);
      const yaml = require('./yaml');
      const cfgDir = path.join(ctx.processDir, 'config');
      const files = fs.existsSync(cfgDir) ? fs.readdirSync(cfgDir).filter((f) => f.endsWith('.yaml')).sort() : [];
      if (!files.length) return fail(`no *.yaml under ${cfgDir}`, `plt config --project ${ctx.projectDir}`);
      for (const f of files) {
        try { yaml.parse(fs.readFileSync(path.join(cfgDir, f), 'utf8')); }
        catch (e) { return fail(`${path.join(cfgDir, f)}: ${e.message}`, `plt config --project ${ctx.projectDir}`); }
      }
      if (ctx.configError) return fail(`${cfgDir}: ${ctx.configError}`, `plt config --project ${ctx.projectDir}`);
      return pass(`${plural(files.length, 'file', 'files')} parsed and merged`);
    },
  },
  {
    id: 'formulas-validate',
    title: "every cycle compiles against THIS project's config",
    run(ctx) {
      if (!ctx.processDir) return fail('no process directory to read cycles from', `plt doctor --project ${ctx.projectDir}`);
      const dir = path.join(ctx.processDir, 'cycles');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
      if (!files.length) return fail(`no *.md under ${dir}`, `plt doctor --project ${ctx.projectDir} --json`);
      let steps = 0;
      for (const f of files) {
        const file = path.join(dir, f);
        let wf;
        try { wf = spine.loadFormula(ctx.processDir, f.replace(/\.md$/, '')); }
        catch (e) { return fail(`${file}: ${e.message}`, `plt doctor --project ${ctx.projectDir} --json`); }
        for (const step of wf.steps || []) {
          try { spine.compileRequirements(step, ctx.config); steps++; }
          catch (e) { return fail(`${file}: step ${step.id}: ${e.message}`, `plt doctor --project ${ctx.projectDir} --json`); }
        }
      }
      return pass(`${plural(files.length, 'cycle', 'cycles')}, ${plural(steps, 'step', 'steps')} compiled`);
    },
  },
  {
    id: 'schemas',
    title: 'run state, inputs and events match the shipped schemas',
    run(ctx) {
      const m = optionalModule('./schemas');
      if (!m || typeof m.validateFile !== 'function') return skip('lib/schemas.js not shipped yet');
      if (!ctx.processDir) return skip('no process directory to read runs from');
      const runsDir = path.join(ctx.processDir, 'runs');
      const runs = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).sort() : [];
      const bad = [];
      let checked = 0;
      let legacy = 0;   // W_EVENT_LEGACY: pre-writer-fix events in an append-only ledger — a warning, not a fail
      for (const run of runs) {
        // These MUST be schema kinds (singular `event`), not the files' plural names. An unknown
        // kind makes validateFile throw, and this check reported the throw as a rejected file — so
        // every ledger read as broken while not one was ever validated. test/doctor.test.js pins
        // this list against schemas.KINDS so the two cannot drift apart again.
        for (const [kind, name] of [['state', 'state.yaml'], ['inputs', 'inputs.yaml'], ['event', 'events.jsonl']]) {
          const file = path.join(runsDir, run, name);
          if (!fs.existsSync(file)) continue;
          checked++;
          let r;
          try { r = m.validateFile(kind, file); }
          catch (e) { bad.push(`${file}: validator failed: ${e.message}`); continue; }
          legacy += ((r && r.warnings) || []).length;
          if (r && r.ok === false) bad.push(`${file}: ${(r.errors || []).slice(0, 3).map((x) => `${x.path || '/'} ${x.message}`).join('; ')}${(r.errors || []).length > 3 ? ` (+${r.errors.length - 3} more)` : ''}`);
        }
      }
      if (!checked) return pass(`no run files under ${runsDir}`);
      if (bad.length) return fail(`${plural(bad.length, 'file', 'files')} of ${checked} rejected — ${bad[0]}`, `plt fsck --all --project ${ctx.projectDir}`);
      const note = legacy ? ` (${legacy} W_EVENT_LEGACY: events written before the writer fix, kept as written)` : '';
      return pass(`${plural(checked, 'file', 'files')} across ${plural(runs.length, 'run', 'runs')} validated${note}`);
    },
  },
  {
    id: 'hooks-installed',
    title: 'the Claude hooks, agent and settings are installed at the shipped version',
    run(ctx) {
      const st = ctx.deps.statusClaude(ctx.projectDir);
      const fixCmd = `plt integration install claude --project ${ctx.projectDir}`;
      const bad = (st.files || []).filter((r) => r.state !== 'installed');
      if (bad.length) return fail(`${bad.map((r) => `${r.file} is ${r.state}`).join(', ')} (shipped v${st.version})`, fixCmd);
      if (!st.settings.ok) return fail(`.claude/settings.json is missing hooks for ${(st.settings.missing || []).join(', ')}`, fixCmd);
      if (st.permissions && !st.permissions.ok) {
        const parts = [];
        if ((st.permissions.violations || []).length) parts.push(st.permissions.violations.join('; '));
        if ((st.permissions.missing || []).length) parts.push(`missing ${st.permissions.missing.join('; ')}`);
        return fail(`.claude/settings.local.json permissions: ${parts.join(' | ')}`, fixCmd);
      }
      return pass(`${plural((st.files || []).length, 'file', 'files')} at v${st.version}, settings and permissions ok`);
    },
  },
  {
    id: 'timers-running',
    title: 'the watch timer is loaded AND has actually run',
    run(ctx) {
      const st = ctx.deps.timerStatus(ctx.projectDir, ctx.config, { platform: ctx.platform, home: ctx.home });
      const fixCmd = `plt integration install timers --project ${ctx.projectDir} --load`;
      // `loaded` is not `running`. The reason this whole command exists: a timer reported "(loaded)"
      // for six days while runs = 0, so the detail always names the run count it read.
      if (!st.ok) return fail(`${st.reason || 'not ok'} (installed: ${!!st.installed}, loaded: ${!!st.loaded}, runs: ${st.runs === null || st.runs === undefined ? 'unknown' : st.runs}, last exit: ${st.lastExit === null || st.lastExit === undefined ? 'unknown' : st.lastExit})`, fixCmd);
      return pass(`loaded, ${plural(st.runs, 'run', 'runs')}, last exit ${st.lastExit}`);
    },
  },
  {
    id: 'denylist-file',
    title: 'the denylist file exists, is non-empty and is mode 600',
    run(ctx) {
      const raw = ctx.config && ctx.config.denylist_file;
      const fixFor = (p) => `install -m 600 /dev/null ${p} && $EDITOR ${p}`;
      if (!raw) return fail('config.denylist_file is not set', fixFor('<path>'));
      const file = resolveConfigPath(raw, ctx);
      let st;
      try { st = fs.statSync(file); }
      catch (e) { return fail(`${file}: no such file`, fixFor(file)); }
      const mode = (st.mode & 0o777).toString(8);
      if (mode !== '600') return fail(`mode is ${mode}, want 600`, `chmod 600 ${file}`);
      if (st.size === 0) return fail(`${file} is empty`, fixFor(file));
      return pass(`${file}, ${st.size} bytes, mode 600`);
    },
  },
  {
    id: 'gh',
    title: 'gh is authenticated for the PR repo',
    run(ctx) {
      const repo = ctx.config && ctx.config.links && ctx.config.links.pr_repo;
      if (!repo) return fail('config.links.pr_repo is not set', `plt config --project ${ctx.projectDir} links`);
      // The shell-out is the point: a config key says nothing about whether gh can talk to GitHub.
      const r = ctx.exec('gh', ['auth', 'status'], { timeoutMs: TIMEOUT_MS });
      if (r.timedOut) return skip('gh auth status did not answer in 5s');
      if (r.error && r.error.code === 'ENOENT') return fail('gh is not on PATH', 'gh auth login');
      if (r.code !== 0) return fail(`gh auth status exited ${r.code}: ${firstLine(r.stderr) || firstLine(r.stdout) || '(no output)'}`, 'gh auth login');
      return pass(`gh auth status ok for ${repo}`);
    },
  },
  {
    id: 'tracker',
    title: 'the tracker script named in config exists',
    run(ctx) {
      const jira = ctx.config && ctx.config.jira;
      if (!jira) return skip('config.jira is not set');
      if (!jira.script) return skip(`config.jira.script is not set (kind: ${jira.kind || 'unset'})`);
      const file = resolveConfigPath(jira.script, ctx);
      if (!fs.existsSync(file)) return fail(`config.jira.script names ${file}, which does not exist`, `ls ${file}`);
      return pass(file);
    },
  },
  {
    id: 'runs-consistent',
    title: "every run's ledger, state, formula and receipts agree",
    run(ctx) {
      const m = optionalModule('./fsck');
      if (!m || typeof m.fsckAll !== 'function') return skip('lib/fsck.js not shipped yet');
      if (!ctx.processDir) return skip('no process directory to read runs from');
      const r = m.fsckAll(ctx.processDir);
      const runs = (r && r.runs) || [];
      if (r && r.ok === false) {
        const bad = runs.filter((x) => !x.ok);
        const first = bad[0] && (bad[0].findings || [])[0];
        return fail(`${plural(bad.length, 'run', 'runs')} of ${runs.length} inconsistent — ${bad[0] ? bad[0].run : '?'}: ${first ? `${first.code} ${first.detail}` : 'see plt fsck'}`, `plt fsck --all --fix --project ${ctx.projectDir}`);
      }
      return pass(`${plural(runs.length, 'run', 'runs')} consistent`);
    },
  },
];

// ---- runDoctor -------------------------------------------------------------

function runDoctor(projectDir, { platform = process.platform, home = require('os').homedir(), exec = defaultExec, env = process.env, deps = {} } = {}) {
  projectDir = path.resolve(projectDir);
  const processDir = fs.existsSync(path.join(projectDir, 'process', 'config'))
    ? path.join(projectDir, 'process')
    : spine.findProcessDir(projectDir);
  let config = {};
  let configError = null;
  if (processDir) {
    try { config = spine.loadConfig(processDir) || {}; } catch (e) { configError = e.message; }
  }
  const ctx = {
    projectDir,
    processDir,
    config,
    configError,
    platform,
    home,
    exec,
    env,
    deps: {
      statusClaude: deps.statusClaude || ((dir) => integrationMod.statusClaude(dir)),
      timerStatus: deps.timerStatus || ((dir, cfg, o) => timersMod.timerStatus(dir, cfg, o)),
    },
  };
  const checks = CHECKS.map((c) => {
    let r;
    try { r = c.run(ctx); }
    catch (e) { r = fail(String(e && e.message ? e.message : e), typeof c.fix === 'function' ? c.fix(ctx) : null); }
    return { id: c.id, title: c.title, state: r.state, detail: r.detail, fix: r.state === 'fail' ? (r.fix || null) : null };
  });
  return { ok: checks.every((c) => c.state !== 'fail'), checks };
}

// ---- formatDoctor ----------------------------------------------------------

function formatDoctor(result) {
  const lines = result.checks.map((c) => {
    if (c.state === 'pass') return `✓ ${c.id}  ${c.title}`;
    if (c.state === 'skip') return `· ${c.id}  ${c.title} (skipped: ${c.detail})`;
    return `✗ ${c.id}  ${c.title} — ${c.detail}`;
  });
  const failed = result.checks.filter((c) => c.state === 'fail');
  if (!failed.length) return lines.join('\n');
  return [...lines, '', 'Fix, in order:', ...failed.map((c, i) => `  ${i + 1}. ${c.fix || `(no command — see ${c.id} above)`}`)].join('\n');
}

// ---- CLI -------------------------------------------------------------------

const USAGE = 'plt doctor [--project <dir>] [--json]';

// With no --project, the project is `config.doctor.project` from the merged config, else the
// directory `findProcessDir(process.cwd())` found the process/ in.
function resolveProjectDir(project) {
  if (typeof project === 'string' && project) return path.resolve(project);
  const processDir = process.env.PLT_PROCESS_DIR || spine.findProcessDir(process.cwd());
  if (!processDir) throw new Error(`no process/config directory found above ${process.cwd()} (pass --project <dir>)`);
  let cfg = {};
  try { cfg = spine.loadConfig(processDir) || {}; } catch (e) { cfg = {}; }
  if (cfg.doctor && cfg.doctor.project) return path.resolve(expandHome(cfg.doctor.project, require('os').homedir()));
  return path.dirname(processDir);
}

function doctorHandler(args, opts = {}) {
  let project = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project') project = args[++i];
    else if (args[i] === '--json') json = true;
    else if (args[i] === '--help' || args[i] === '-h') { (opts.io && opts.io.write || ((t) => process.stdout.write(t)))(USAGE + '\n'); return 0; }
  }
  const write = (opts.io && opts.io.write) || ((t) => process.stdout.write(t));
  const result = runDoctor(resolveProjectDir(project), opts);
  write((json ? JSON.stringify(result, null, 2) : formatDoctor(result)) + '\n');
  return result.ok ? 0 : 1;
}

// `plt doctor …` — accepts the verb in front, so a test drives the same entry point the registry does.
function cli(args, opts = {}) {
  const rest = args[0] === 'doctor' ? args.slice(1) : args;
  return doctorHandler(rest, opts);
}

const commands = [{ name: 'doctor', usage: USAGE, handler: doctorHandler }];

module.exports = { CHECKS, runDoctor, formatDoctor, doctorHandler, cli, commands, USAGE, defaultExec };
