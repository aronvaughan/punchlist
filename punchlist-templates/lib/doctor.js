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
const depsMod = require('./deps');

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

// ---- timer freshness -------------------------------------------------------

const STALE_FACTOR = 3;
// launchd gives an ISO time (the log's mtime); systemd gives `Wed 2026-09-30 11:30:01 CDT`, which
// Date.parse rejects for the zone abbreviation. The unit and the doctor run on one machine, so the
// systemd form is read as local time. Anything else is unknown, and unknown never fails the check.
function parseRunTime(v) {
  if (!v) return null;
  const direct = Date.parse(v);
  if (!Number.isNaN(direct)) return direct;
  const m = String(v).match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!m) return null;
  const local = Date.parse(`${m[1]}T${m[2]}`);
  return Number.isNaN(local) ? null : local;
}
function human(sec) {
  if (sec < 120) return `${sec}s`;
  if (sec < 7200) return `${Math.round(sec / 60)}m`;
  if (sec < 172800) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

// ---- state field / schema drift -------------------------------------------
//
// `landed_out_of_band` shipped in spine.closeRun and the state schema did not name it, so the state
// a live run wrote would not validate against its own schema (fixed in 8c2a092, spotted by eye an
// hour later). Nothing in the cycle caught it. The `schemas` check WOULD have caught it — but only
// once some run on some machine had actually closed with `--landed`, which is a rare path. This
// check needs no run: it reads lib/*.js and asks whether every field assigned onto a run state
// object is a field the schema names. It fires the moment the writer is added.
//
// It is a text scan, not a parse, and the list below is measured, not assumed — test/state-schema-
// drift.test.js holds one case per line of it, so the day the scanner grows, the test that pins the
// hole fails and this comment has to be rewritten. That is deliberate: this check exists because a
// guard looked present and reported nothing, and a guard that misdescribes its own holes is the
// same failure one level up.
//
//   COVERED — `<v>.<field> <op>= …`, where `<op>=` is `=` or any compound assignment (`+=`, `??=`,
//   `||=`, `&&=`, `-=`, `*=`, `/=`, `%=`, `**=`, `&=`, `|=`, `^=`, `<<=`, `>>=`, `>>>=`), and `<v>`
//   is `st`, `state`, or any identifier the same file assigns from `readState(` — declared
//   (`const st2 = spine.readState(…)`) or bare (`cur = readState(…)`). That is the form the defect
//   took and the form every rare-path write takes.
//
//   NOT COVERED — six forms, each pinned by a test:
//     1. the object literal launchRun hands to writeState: its keys are never assigned, and some
//        are shorthand (`cycle,`), so there is no `<v>.<field> =` to match.
//     2. computed writes — `st[key] = v`.
//     3. `Object.assign(st, {…})`.
//     4. spreads — `{ ...st, field: v }`.
//     5. state reached under any other name: a parameter (`function landRun(run) { run.x = … }`),
//        a loop variable (`for (const s of states) s.x = …`), a destructuring target.
//     6. anything outside lib/*.js, and nested keys under `steps.*` (the schema leaves those open).
//   Of these, (1) is the mild one: every run exercises launchRun, so a stray key there is rejected
//   by the `schemas` check on the first run any project launches. (5) is the sharp one — rename the
//   variable and this check goes quiet, with no signal that it did.
//
//   FALSE POSITIVES — a field named in a comment or a string in the `<v>.<field> =` shape is counted
//   as a write, and can even be the FIRST location the failure prints. Loud and wrong in the safe
//   direction; a silent miss is not, which is why there is no comment/string stripper here. A
//   hand-rolled one was tried and swallowed real code (it lost `st.exit` at spine.js:715).
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`); }
const STATE_VARS = ['st', 'state'];
// `=` but not `==`/`===`, plus every compound assignment. `!==`, `>=` and `<=` do not match: their
// leading character is not one of these operators, and a bare `=` cannot follow `!`, `>` or `<`.
const ASSIGN = String.raw`\s*(?:\|\||&&|\?\?|\*\*|>>>|>>|<<|[-+*/%&|^])?=(?!=)`;

// scanStateFieldWrites({libDir, schemaFile}) -> {declared, writes, undeclared, files}
// `writes` is [{field, where:[ 'file:line', … ]}] sorted by field; `undeclared` is the subset the
// schema does not name. Roots are injectable so a test can point it at a fixture and watch it fire.
function scanStateFieldWrites({ libDir = path.join(REPO, 'lib'), schemaFile = path.join(REPO, 'schemas', 'state.schema.json') } = {}) {
  const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
  const declared = Object.keys(schema.properties || {}).sort();
  const files = fs.readdirSync(libDir).filter((f) => f.endsWith('.js')).sort();
  const found = new Map();
  for (const f of files) {
    const src = fs.readFileSync(path.join(libDir, f), 'utf8');
    const lineAt = (i) => src.slice(0, i).split('\n').length;
    const vars = new Set(STATE_VARS);
    for (const m of src.matchAll(/(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\.)?readState\s*\(/g)) vars.add(m[1]);
    const re = new RegExp(`\\b(?:${[...vars].map(escapeRe).join('|')})\\.([A-Za-z_$][\\w$]*)${ASSIGN}`, 'g');
    for (const m of src.matchAll(re)) {
      if (!found.has(m[1])) found.set(m[1], []);
      found.get(m[1]).push(`${f}:${lineAt(m.index)}`);
    }
  }
  const writes = [...found.keys()].sort().map((field) => ({ field, where: found.get(field) }));
  return { declared, writes, undeclared: writes.filter((w) => !declared.includes(w.field)), files };
}

// ---- the checks ------------------------------------------------------------
//
// Each is `(ctx) => {state, detail, fix}`; `runDoctor` adds the id and title and catches throws.
// ctx = {projectDir, processDir, config, configError, platform, home, exec, env, now, deps}.

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
    id: 'state-fields-declared',
    title: 'every field assigned onto a run state in lib/ is named in the state schema',
    // Proves a field/schema pair, not a run. It reads source, so it fires the moment a writer is
    // added — before any run has taken the path that writes the field. See scanStateFieldWrites
    // for what the scan does and does not see; in particular the launchRun object literal is not
    // scanned, and nothing outside lib/*.js is.
    run(ctx) {
      let scan;
      try { scan = scanStateFieldWrites(); }
      catch (e) { return skip(`could not scan lib/ against the state schema: ${e.message}`); }
      if (!scan.writes.length) return skip(`no state field assignments found under ${path.join(REPO, 'lib')}`);
      if (scan.undeclared.length) {
        const first = scan.undeclared[0];
        const more = scan.undeclared.length > 1 ? ` (+${scan.undeclared.length - 1} more: ${scan.undeclared.slice(1).map((u) => u.field).join(', ')})` : '';
        return fail(
          `${plural(scan.undeclared.length, 'field', 'fields')} written into run state but not named in schemas/state.schema.json — \`${first.field}\` at ${first.where.join(', ')}${more}`,
          `$EDITOR ${path.join(REPO, 'schemas', 'state.schema.json')}   # add properties.${first.field}`,
        );
      }
      return pass(`${plural(scan.writes.length, 'field', 'fields')} assigned across ${plural(scan.files.length, 'lib file', 'lib files')}, all declared`);
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
    title: 'the watch timer is loaded, has run, and ran within the last three intervals',
    run(ctx) {
      const st = ctx.deps.timerStatus(ctx.projectDir, ctx.config, { platform: ctx.platform, home: ctx.home });
      const fixCmd = `plt integration install timers --project ${ctx.projectDir} --load`;
      // `loaded` is not `running`. The reason this whole command exists: a timer reported "(loaded)"
      // for six days while runs = 0, so the detail always names the run count it read.
      if (!st.ok) return fail(`${st.reason || 'not ok'} (installed: ${!!st.installed}, loaded: ${!!st.loaded}, runs: ${st.runs === null || st.runs === undefined ? 'unknown' : st.runs}, last exit: ${st.lastExit === null || st.lastExit === undefined ? 'unknown' : st.lastExit})`, fixCmd);
      const summary = `loaded, ${plural(st.runs, 'run', 'runs')}, last exit ${st.lastExit}`;
      // `has run` is not `is running` either. A `watch --once` that hangs keeps launchd from starting
      // another, so the run count freezes and the last exit stays the old 0; a systemd timer reports
      // at most one run. Only the time of the last run tells a live timer from one that stopped.
      // Stale is more than STALE_FACTOR intervals: one missed tick (a sleeping laptop) is not a fault.
      const every = timersMod.everySeconds((ctx.config.timers && ctx.config.timers.watch && ctx.config.timers.watch.every) || '10m');
      const at = parseRunTime(st.lastRun);
      if (at === null) return pass(`${summary}, last run time unknown`);
      const ago = Math.round((ctx.now() - at) / 1000);
      if (ago > every * STALE_FACTOR) return fail(`last ran ${human(ago)} ago, expected every ${human(every)} (${summary})`, fixCmd);
      return pass(`${summary}, last ran ${human(Math.max(ago, 0))} ago`);
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
    id: 'deps',
    title: 'every tool named in config.deps resolves on PATH',
    // The check and the installer share one manifest (lib/deps.js), so a fail's fix is the command
    // that installs exactly what is missing — however the tool arrives, presence is what passes.
    run(ctx) { return depsMod.doctorCheck(ctx); },
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

function runDoctor(projectDir, { platform = process.platform, home = require('os').homedir(), exec = defaultExec, env = process.env, deps = {}, now = Date.now } = {}) {
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
    now,
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

module.exports = { CHECKS, scanStateFieldWrites, runDoctor, formatDoctor, doctorHandler, resolveProjectDir, cli, commands, USAGE, defaultExec };
