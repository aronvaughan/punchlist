'use strict';
// deps — the external tools a project needs, whether they are on this machine, and how to put
// them there.
//
// The project names what it needs in `config.deps` (a list of ids). This file knows, for each id,
// how to prove it is present and how to install it. `plt doctor` reports a missing one; `plt deps
// install` installs it. So a project moved to a new machine says what it needs and gets it, and
// nothing is assumed to arrive from some other install (claude-config, a KB's installer, a
// teammate's dotfiles).
//
// Presence is the test, not provenance: a tool that resolves on PATH passes however it got there.
// The install recipes run only for a tool that does not resolve.
const { spawnSync } = require('child_process');

const TIMEOUT_MS = 5000;

// Each recipe is tried in order; the first whose `needs` binary resolves is the one used. A recipe
// with no `needs` always applies. `os` is a process.platform list; absent means every platform.
const DEPS = {
  gitnexus: {
    why: 'code-graph index and MCP server — the spine reindexes it after the merge gate',
    bin: 'gitnexus',
    version: ['--version'],
    install: [
      // Pinned to the version the claude-config MCP registry launches, so the CLI and the server agree.
      { needs: 'npm', run: 'npm install -g gitnexus@1.6.9' },
    ],
  },
  herdr: {
    why: 'terminal runtime the effort panes live on — the windows.* driver',
    bin: 'herdr',
    version: null,
    install: [
      { os: ['darwin', 'linux'], needs: 'brew', run: 'brew install herdr' },
      { os: ['darwin', 'linux'], needs: 'mise', run: 'mise use -g herdr' },
      { os: ['darwin', 'linux'], needs: 'curl', run: 'curl -fsSL https://herdr.dev/install.sh | sh' },
      { os: ['win32'], run: 'powershell -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"' },
    ],
  },
};

function defaultExec(cmd, args, { timeoutMs = TIMEOUT_MS } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs });
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT') || (r.status === null && r.signal === 'SIGTERM');
  return { code: r.status === undefined ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || '', timedOut, error: r.error || null };
}

function firstLine(s) { return String(s || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || ''; }

// resolves(bin) -> absolute path or null. `command -v` so a shell builtin PATH lookup decides, the
// same one an installed hook or a pane would get.
function resolveBin(bin, exec) {
  const r = exec('sh', ['-c', `command -v ${bin}`], { timeoutMs: TIMEOUT_MS });
  if (r.timedOut || r.code !== 0) return null;
  return firstLine(r.stdout) || null;
}

// declared(config) -> {ids, unknown}. `config.deps` is a list of ids; anything else is treated as
// declaring nothing.
function declared(config) {
  const raw = config && Array.isArray(config.deps) ? config.deps.map(String) : [];
  return { ids: raw.filter((id) => DEPS[id]), unknown: raw.filter((id) => !DEPS[id]) };
}

// checkDep(id) -> {id, present, path, version, detail}
function checkDep(id, { exec = defaultExec } = {}) {
  const dep = DEPS[id];
  const where = resolveBin(dep.bin, exec);
  if (!where) return { id, present: false, path: null, version: null, detail: `${dep.bin} is not on PATH` };
  let version = null;
  if (dep.version) {
    const v = exec(dep.bin, dep.version, { timeoutMs: TIMEOUT_MS });
    if (!v.timedOut && v.code === 0) version = firstLine(v.stdout) || null;
  }
  return { id, present: true, path: where, version, detail: version ? `${where} (${version})` : where };
}

// recipeFor(id) -> the install recipe this machine would use, or null.
function recipeFor(id, { platform = process.platform, exec = defaultExec } = {}) {
  for (const r of DEPS[id].install) {
    if (r.os && !r.os.includes(platform)) continue;
    if (r.needs && !resolveBin(r.needs, exec)) continue;
    return r;
  }
  return null;
}

// ---- doctor check ------------------------------------------------------------

// One doctor check covers every declared dep: fail lists what is missing and points at the installer.
function doctorCheck(ctx) {
  const { ids, unknown } = declared(ctx.config);
  if (unknown.length) {
    return { state: 'fail', detail: `config.deps names unknown tools: ${unknown.join(', ')} (known: ${Object.keys(DEPS).join(', ')})`, fix: `plt config --project ${ctx.projectDir} deps` };
  }
  if (!ids.length) return { state: 'skip', detail: 'config.deps is empty', fix: null };
  const results = ids.map((id) => checkDep(id, { exec: ctx.exec }));
  const missing = results.filter((r) => !r.present).map((r) => r.id);
  if (missing.length) {
    return { state: 'fail', detail: `missing: ${missing.join(', ')}`, fix: `plt deps install --project ${ctx.projectDir}` };
  }
  return { state: 'pass', detail: results.map((r) => `${r.id} ${r.detail}`).join('; '), fix: null };
}

// ---- CLI ---------------------------------------------------------------------

const USAGE = 'plt deps [status|install] [<id>...] [--project <dir>] [--dry-run] [--json]';

function loadProjectConfig(project) {
  // Lazy: doctor requires this module, and `./doctor` requires `./spine` — keep the CLI's config
  // resolution identical to doctor's without a require cycle at load time.
  const doctor = require('./doctor');
  const spine = require('./spine');
  const projectDir = doctor.resolveProjectDir(project);
  const processDir = spine.findProcessDir(projectDir);
  return { projectDir, config: processDir ? (spine.loadConfig(processDir) || {}) : {} };
}

function depsHandler(args, opts = {}) {
  const write = (opts.io && opts.io.write) || ((t) => process.stdout.write(t));
  const exec = opts.exec || defaultExec;
  const platform = opts.platform || process.platform;
  // The installer inherits stdio: brew, npm and curl talk to the terminal, and a prompt (sudo, a
  // brew tap confirmation) must reach the human rather than hang.
  const run = opts.run || ((cmd) => spawnSync('sh', ['-c', cmd], { stdio: 'inherit' }).status);
  let verb = 'status';
  let project = null;
  let dryRun = false;
  let json = false;
  const only = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--project') project = args[++i];
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--json') json = true;
    else if (a === '--help' || a === '-h') { write(USAGE + '\n'); return 0; }
    else if (a === 'status' || a === 'install') verb = a;
    else only.push(a);
  }
  const { projectDir, config } = opts.config ? { projectDir: project || '.', config: opts.config } : loadProjectConfig(project);
  const { ids: declaredIds, unknown } = declared(config);
  const bad = only.filter((id) => !DEPS[id]);
  if (bad.length || unknown.length) {
    write(`deps: unknown tool(s): ${[...bad, ...unknown].join(', ')} (known: ${Object.keys(DEPS).join(', ')})\n`);
    return 2;
  }
  // Named ids win over config, so `plt deps install herdr` works before the project declares it.
  const ids = only.length ? only : declaredIds;
  if (!ids.length) { write(`deps: ${projectDir} declares no deps (config.deps is empty)\n`); return 0; }

  const rows = ids.map((id) => checkDep(id, { exec }));
  if (verb === 'status') {
    if (json) write(JSON.stringify(rows, null, 2) + '\n');
    else write(rows.map((r) => `${r.present ? '✓' : '✗'} ${r.id}  ${r.detail}`).join('\n') + '\n');
    return rows.every((r) => r.present) ? 0 : 1;
  }

  let failed = 0;
  for (const r of rows) {
    if (r.present) { write(`✓ ${r.id}  already present: ${r.detail}\n`); continue; }
    const recipe = recipeFor(r.id, { platform, exec });
    if (!recipe) {
      write(`✗ ${r.id}  no install recipe for ${platform} on this machine (tried: ${DEPS[r.id].install.map((x) => x.run).join(' | ')})\n`);
      failed++;
      continue;
    }
    if (dryRun) { write(`· ${r.id}  would run: ${recipe.run}\n`); continue; }
    write(`→ ${r.id}  ${recipe.run}\n`);
    const code = run(recipe.run);
    // Re-check rather than trust the exit code: an installer can exit 0 and leave the binary in a
    // directory that is not on PATH, which is the case worth reporting.
    const after = checkDep(r.id, { exec });
    if (after.present) write(`✓ ${r.id}  installed: ${after.detail}\n`);
    else { write(`✗ ${r.id}  installer exited ${code} and ${after.detail}\n`); failed++; }
  }
  return failed ? 1 : 0;
}

function cli(args, opts = {}) {
  const rest = args[0] === 'deps' ? args.slice(1) : args;
  return depsHandler(rest, opts);
}

const commands = [{ name: 'deps', usage: USAGE, handler: depsHandler }];

module.exports = { DEPS, declared, checkDep, recipeFor, doctorCheck, depsHandler, cli, commands, USAGE };
