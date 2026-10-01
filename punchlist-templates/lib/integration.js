'use strict';
// integration — install the spine's editor/agent integrations into a project and report their state.
//
// `claude`: the Claude Code hooks (integrations/claude/*.py), the framework agents
// (integrations/claude/agents/*.md), the hook wiring and the permission rules (hooks.json).
// Every installed file carries a managed header stamped with the shipped VERSION (read from
// spine_common.py, the single source); `status` compares header version and body hash.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const spine = require('./spine');
const timers = require('./timers');

const DEFAULT_SHIPPED = path.resolve(__dirname, '..', 'integrations', 'claude');
const HEADER_RE = /installed by plt integration claude v(\d+) — reinstalling overwrites/;

function shippedVersion(shippedDir) {
  const src = fs.readFileSync(path.join(shippedDir, 'spine_common.py'), 'utf8');
  const m = src.match(/^VERSION\s*=\s*(\d+)\s*$/m);
  if (!m) throw new Error('integrations/claude/spine_common.py has no VERSION = <n> line');
  return Number(m[1]);
}

// Body hash for the modified check: CRLF-normalised, one trailing newline stripped, so a
// checkout that rewrote line endings or an editor that added a final newline is not "modified".
const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\n$/, '');
const sha = (s) => crypto.createHash('sha256').update(norm(s)).digest('hex');

// Managed header placement: hooks (python) after the shebang line; agents (markdown) after the
// frontmatter block. `split` returns {head, body} for a file's on-disk content — the header, if
// present, is stripped from `body` and its version returned — so shipped and installed bodies
// compare like for like.
function splitHook(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let head = '';
  if (lines[0] && lines[0].startsWith('#!')) head = lines.shift() + '\n';
  let installed = null;
  if (lines[0] && HEADER_RE.test(lines[0]) && lines[0].startsWith('#')) { installed = Number(lines[0].match(HEADER_RE)[1]); lines.shift(); }
  return { head, body: lines.join('\n'), installed };
}
function splitAgent(text) {
  text = text.replace(/\r\n/g, '\n');
  let head = '';
  let rest = text;
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---\n', 4);
    if (end !== -1) { head = text.slice(0, end + 5); rest = text.slice(end + 5); }
  }
  let installed = null;
  const first = rest.split('\n')[0] || '';
  if (first.startsWith('<!--') && HEADER_RE.test(first)) { installed = Number(first.match(HEADER_RE)[1]); rest = rest.slice(first.length + 1); }
  return { head, body: rest, installed };
}
const hookHeader = (v) => `# installed by plt integration claude v${v} — reinstalling overwrites\n`;
const agentHeader = (v) => `<!-- installed by plt integration claude v${v} — reinstalling overwrites -->\n`;

function managedFiles(shippedDir) {
  const hooks = fs.readdirSync(shippedDir).filter((f) => f.endsWith('.py')).sort()
    .map((f) => ({ kind: 'hook', name: f, src: path.join(shippedDir, f), rel: path.join('.claude', 'hooks', f), split: splitHook, header: hookHeader }));
  const agentsDir = path.join(shippedDir, 'agents');
  const agents = fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')).sort()
    .map((f) => ({ kind: 'agent', name: f, src: path.join(agentsDir, f), rel: path.join('.claude', 'agents', f), split: splitAgent, header: agentHeader })) : [];
  return [...hooks, ...agents];
}

function rendered(file, version) {
  const s = file.split(fs.readFileSync(file.src, 'utf8'));
  return s.head + file.header(version) + s.body;
}

const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
function writeJsonIfChanged(f, obj, changed) {
  const next = JSON.stringify(obj, null, 2) + '\n';
  const prev = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  if (prev === next) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, next);
  changed.push(path.relative(path.dirname(path.dirname(f)), f));
}

// Merge the shipped hook groups into a project's settings.hooks. A command already wired
// anywhere in the event — under ANY matcher group — is not added again; a new command joins
// the existing group with the same matcher, or opens a new group. Nothing is ever removed.
const eventCommands = (groups) => new Set(groups.flatMap((g) => (Array.isArray(g.hooks) ? g.hooks : []).map((h) => h.command)));
function mergeHooks(settingsHooks, shippedHooks) {
  const out = settingsHooks && typeof settingsHooks === 'object' ? settingsHooks : {};
  for (const [event, groups] of Object.entries(shippedHooks)) {
    if (!Array.isArray(out[event])) out[event] = [];
    for (const g of groups) {
      const wired = eventCommands(out[event]);
      const missing = g.hooks.filter((h) => !wired.has(h.command));
      if (!missing.length) continue;
      const existing = out[event].find((x) => (x.matcher || '') === (g.matcher || ''));
      if (!existing) { out[event].push({ ...JSON.parse(JSON.stringify(g)), hooks: missing.map((h) => ({ ...h })) }); continue; }
      if (!Array.isArray(existing.hooks)) existing.hooks = [];
      for (const h of missing) existing.hooks.push({ ...h });
    }
  }
  return out;
}

function mergePermissions(local, shipped) {
  const out = local && typeof local === 'object' ? local : {};
  if (!out.permissions || typeof out.permissions !== 'object') out.permissions = {};
  for (const key of ['ask', 'allow']) {
    if (!Array.isArray(shipped[key]) || !shipped[key].length) continue;
    if (!Array.isArray(out.permissions[key])) out.permissions[key] = [];
    for (const rule of shipped[key]) if (!out.permissions[key].includes(rule)) out.permissions[key].push(rule);
  }
  return out;
}

function installClaude(projectDir, { shippedDir = DEFAULT_SHIPPED } = {}) {
  projectDir = path.resolve(projectDir);
  const version = shippedVersion(shippedDir);
  const installed = []; const changed = [];
  for (const f of managedFiles(shippedDir)) {
    const dest = path.join(projectDir, f.rel);
    const next = rendered(f, version);
    const prev = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
    installed.push(f.rel);
    if (prev === next) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, next, { mode: f.kind === 'hook' ? 0o755 : 0o644 });
    changed.push(f.rel);
  }
  const shipped = JSON.parse(fs.readFileSync(path.join(shippedDir, 'hooks.json'), 'utf8'));
  const settingsFile = path.join(projectDir, '.claude', 'settings.json');
  const settings = readJson(settingsFile) || {};
  settings.hooks = mergeHooks(settings.hooks, shipped.hooks || {});
  writeJsonIfChanged(settingsFile, settings, changed);
  const localFile = path.join(projectDir, '.claude', 'settings.local.json');
  writeJsonIfChanged(localFile, mergePermissions(readJson(localFile), shipped), changed);
  return { version, installed, changed };
}

function statusClaude(projectDir, { shippedDir = DEFAULT_SHIPPED } = {}) {
  projectDir = path.resolve(projectDir);
  const version = shippedVersion(shippedDir);
  const files = [];
  for (const f of managedFiles(shippedDir)) {
    const dest = path.join(projectDir, f.rel);
    const row = { file: f.rel, shipped: version, installed: null, state: 'missing' };
    if (fs.existsSync(dest)) {
      const have = f.split(fs.readFileSync(dest, 'utf8'));
      const want = f.split(fs.readFileSync(f.src, 'utf8'));
      row.installed = have.installed;
      if (have.installed === null) row.state = 'unmanaged';
      else if (have.installed !== version) row.state = 'stale';
      else row.state = sha(have.head + have.body) === sha(want.head + want.body) ? 'installed' : 'modified';
    }
    files.push(row);
  }
  const shipped = JSON.parse(fs.readFileSync(path.join(shippedDir, 'hooks.json'), 'utf8'));
  const settings = readJson(path.join(projectDir, '.claude', 'settings.json'));
  const missing = [];
  for (const [event, groups] of Object.entries(shipped.hooks || {})) {
    const present = new Set(((settings && settings.hooks && settings.hooks[event]) || []).flatMap((g) => (g.hooks || []).map((h) => h.command)));
    if (!groups.every((g) => g.hooks.every((h) => present.has(h.command)))) missing.push(event);
  }
  const local = readJson(path.join(projectDir, '.claude', 'settings.local.json'));
  const perms = (local && local.permissions) || {};
  const missingRules = [];
  for (const key of ['ask', 'allow']) for (const rule of shipped[key] || []) if (!Array.isArray(perms[key]) || !perms[key].includes(rule)) missingRules.push(`${key}: ${rule}`);
  // An ask rule that also appears in allow is a violation: the human gate would pass without a prompt.
  const violations = (shipped.ask || []).filter((rule) => Array.isArray(perms.allow) && perms.allow.includes(rule)).map((rule) => `${rule} present in allow`);
  const permsOk = missingRules.length === 0 && violations.length === 0;
  const ok = files.every((r) => r.state === 'installed') && missing.length === 0 && permsOk;
  return { version, files, settings: { ok: missing.length === 0, missing }, permissions: { ok: permsOk, missing: missingRules, violations }, ok };
}

function renderStatus(st) {
  const lines = st.files.map((r) => {
    if (r.state === 'installed') return `${r.file}: installed v${r.installed}`;
    if (r.state === 'stale') return `${r.file}: stale (installed v${r.installed}, shipped v${r.shipped})`;
    if (r.state === 'modified') return `${r.file}: modified (v${r.installed}; content differs from shipped)`;
    if (r.state === 'unmanaged') return `${r.file}: unmanaged (no managed header; shipped v${r.shipped})`;
    return `${r.file}: missing`;
  });
  lines.push(st.settings.ok ? 'settings: ok' : `settings: missing ${st.settings.missing.join(', ')}`);
  if (st.permissions.ok) lines.push('permissions: ok');
  else {
    const parts = [];
    if (st.permissions.violations.length) parts.push(`violation — ${st.permissions.violations.join('; ')}`);
    if (st.permissions.missing.length) parts.push(`missing ${st.permissions.missing.join('; ')}`);
    lines.push('permissions: ' + parts.join(' | '));
  }
  return lines.join('\n') + '\n';
}

// `timers`: install/status wrap lib/timers.js (launchd/systemd) — a different shape from `claude`
// (no shipped-file diffing), so each side returns a `line` the CLI prints verbatim instead of
// going through `renderStatus`. `--load` is the only flag `install timers` reads; every other
// integration ignores unrecognized opts.
function installTimersIntegration(projectDir, opts = {}) {
  const processDir = path.join(projectDir, 'process');
  const cfg = spine.loadConfig(processDir);
  const r = timers.installTimers(projectDir, cfg, { load: !!opts.load });
  const note = !opts.load ? ' (not loaded — pass --load)' : r.kickstarted ? ' (loaded, kickstarted)' : ' (loaded)';
  return { ...r, line: `${r.kind} timer installed at ${r.path}${note}` };
}
function statusTimersIntegration(projectDir) {
  const processDir = path.join(projectDir, 'process');
  const cfg = spine.loadConfig(processDir);
  const st = timers.timerStatus(projectDir, cfg);
  if (!st.installed) return { ok: false, line: 'not installed' };
  const runs = st.runs === null ? '?' : st.runs;
  const lastExit = st.lastExit === null ? '?' : st.lastExit;
  const lastRun = st.lastRun === null ? '?' : st.lastRun;
  const line = `installed ${st.path} (${st.loaded ? 'loaded' : 'not loaded'}) runs=${runs} last-exit=${lastExit} last-run=${lastRun}`;
  return { ok: st.ok, line };
}

const INTEGRATIONS = {
  claude: { install: installClaude, status: statusClaude },
  timers: { install: installTimersIntegration, status: statusTimersIntegration },
};

function cli(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { const k = args[i].slice(2); const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true; o[k] = v; }
    else o._.push(args[i]);
  }
  const [sub, name] = o._;
  const usage = 'usage: plt integration install|status <name> [--project <dir>] [--load]   (names: ' + Object.keys(INTEGRATIONS).join(', ') + ')\n';
  if (!['install', 'status'].includes(sub) || !name) { process.stderr.write(usage); return 2; }
  const integ = INTEGRATIONS[name];
  if (!integ) { process.stderr.write(`unknown integration: ${name}\n` + usage); return 2; }
  const projectDir = path.resolve(typeof o.project === 'string' ? o.project : process.cwd());
  if (sub === 'install') {
    const r = integ.install(projectDir, o);
    if (r.line) { process.stdout.write(r.line + '\n'); return 0; }
    process.stdout.write(`${name} v${r.version} installed into ${projectDir} — ${r.changed.length ? 'changed: ' + r.changed.join(', ') : 'no changes'}\n`);
    return 0;
  }
  const st = integ.status(projectDir, o);
  if (st.line) { process.stdout.write(st.line + '\n'); return st.ok ? 0 : 1; }
  process.stdout.write(renderStatus(st));
  return st.ok ? 0 : 1;
}

module.exports = { installClaude, statusClaude, renderStatus, mergeHooks, mergePermissions, shippedVersion, cli };
