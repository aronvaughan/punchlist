'use strict';
// harvest — a mined suggestion becomes a reviewable diff on its own branch.
//
// `plt mine` writes process/suggestions.md; a human reads it and decides which row is worth
// acting on. `plt harvest <id>` turns exactly one row into one bounded edit on a new branch, in
// the repo the row's target belongs to, and prints the diff plus the `gh pr create` command.
//
// It STOPS AT THE BRANCH. It never merges, never pushes, never opens a PR, and never touches any
// branch but the new one — the spec requires a human merge, and an auto-opened PR would be the
// first thing here to reach a remote with nobody having seen the diff.
//
// The edit is mechanical: it only ever writes the value the row already names after `proposed: `.
// A row with no proposed value is refused. harvest never invents a change.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('./yaml');
const repoWindow = require('./repo-window');

// ------------------------------------------------------------------ suggestions table

const COLUMNS = ['id', 'signal', 'count', 'runs', 'target', 'detail'];

// `formula:<cycle>:<step>:<key>`, `template:<pack>/<name>:<slot>`, `config:<dotted.path>`.
// Anything else — `(none)`, a typo, an empty cell — parses to null and is never harvestable.
function parseTarget(cell) {
  const t = String(cell || '').trim();
  let m = t.match(/^config:([A-Za-z0-9_.-]+)$/);
  if (m) return { kind: 'config', path: m[1] };
  m = t.match(/^formula:([^:\s]+):([^:\s]+):([^:\s]+)$/);
  if (m) return { kind: 'formula', cycle: m[1], step: m[2], key: m[3] };
  m = t.match(/^template:([^/\s]+)\/([^:\s]+):([^:\s]+)$/);
  if (m) return { kind: 'template', pack: m[1], name: m[2], slot: m[3] };
  return null;
}

function splitRow(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

// Reads the one markdown table whose header carries every column plt mine promises. Other tables
// in the file (and any prose around them) are ignored.
function readSuggestions(processDir) {
  const file = path.join(processDir, 'suggestions.md');
  if (!fs.existsSync(file)) throw new Error(`no suggestions file at ${file} — run \`plt mine\` first`);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    const head = splitRow(lines[i]).map((h) => h.toLowerCase());
    if (!COLUMNS.every((c) => head.includes(c))) continue;
    const at = Object.fromEntries(COLUMNS.map((c) => [c, head.indexOf(c)]));
    let j = i + 1;
    if (lines[j] && /^\s*\|[\s|:-]+$/.test(lines[j])) j++;        // the --- separator row
    for (; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      const cells = splitRow(lines[j]);
      const id = cells[at.id];
      if (!id) continue;
      const runs = String(cells[at.runs] || '').split(',').map((r) => r.trim()).filter(Boolean);
      const count = Number(cells[at.count]);
      rows.push({
        id,
        signal: cells[at.signal] || '',
        count: Number.isFinite(count) ? count : null,
        runs,
        target: parseTarget(cells[at.target]),
        detail: cells[at.detail] || '',
      });
    }
    return rows;
  }
  return rows;
}

function rowOf(processDir, id) {
  const row = readSuggestions(processDir).find((r) => r.id === id);
  if (!row) throw new Error(`harvest ${id}: no such row in ${path.join(processDir, 'suggestions.md')}`);
  return row;
}

// The one value harvest is allowed to write. No `proposed: ` prefix, no change.
function proposedValue(row) {
  const m = String(row.detail).match(/^proposed:\s*(.+)$/);
  if (!m || !m[1].trim()) {
    throw new Error(`harvest ${row.id}: the row names no proposed value; edit process/suggestions.md first`);
  }
  return m[1].trim();
}

function kebab(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ------------------------------------------------------------------ which plane, which file

function hasPath(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return false;
    cur = cur[part];
  }
  return true;
}

// Overlay first, pack second — the same order the runtime resolves a formula or a template in.
// An overlay lives in the umbrella (private); a core pack file lives in the templates checkout
// (public). A config key the shipped defaults already carry is public; every other key is private.
function resolveTarget(processDir, target, { repoDir, templatesDir }) {
  if (target.kind === 'config') {
    const publicDefaults = path.join(templatesDir, 'config', 'defaults.yaml');
    if (fs.existsSync(publicDefaults) && hasPath(yaml.parse(fs.readFileSync(publicDefaults, 'utf8')) || {}, target.path)) {
      return { plane: 'public', repo: templatesDir, file: publicDefaults };
    }
    return { plane: 'private', repo: repoDir, file: privateConfigFile(processDir, target.path) };
  }
  if (target.kind === 'formula') {
    const overlay = path.join(processDir, 'cycles', `${target.cycle}.md`);
    if (fs.existsSync(overlay)) return { plane: 'private', repo: repoDir, file: overlay };
    const pack = path.join(templatesDir, 'workflows', 'packs', 'core', `${target.cycle}.md`);
    if (fs.existsSync(pack)) return { plane: 'public', repo: templatesDir, file: pack };
    throw new Error(`harvest: no formula ${target.cycle} at ${overlay} or ${pack}`);
  }
  const overlay = path.join(processDir, 'templates', `${target.name}.md`);
  if (fs.existsSync(overlay)) return { plane: 'private', repo: repoDir, file: overlay };
  const pack = path.join(templatesDir, 'templates', 'packs', target.pack, `${target.name}.md`);
  if (fs.existsSync(pack)) return { plane: 'public', repo: templatesDir, file: pack };
  throw new Error(`harvest: no template ${target.pack}/${target.name} at ${overlay} or ${pack}`);
}

// The private config file a key belongs in: the org file that already carries the key, else the
// single org file. Two candidates and no match is ambiguous — a human names the file.
function privateConfigFile(processDir, dotted) {
  const dir = path.join(processDir, 'config');
  const orgs = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') && f !== 'defaults.yaml' && f !== 'estimation.yaml').sort()
    : [];
  if (!orgs.length) throw new Error(`harvest: no org config under ${dir} to write ${dotted} into`);
  const carrying = orgs.filter((f) => hasPath(yaml.parse(fs.readFileSync(path.join(dir, f), 'utf8')) || {}, dotted));
  if (carrying.length === 1) return path.join(dir, carrying[0]);
  if (orgs.length === 1) return path.join(dir, orgs[0]);
  throw new Error(`harvest: ${dotted} is ambiguous — it could go in ${orgs.join(' or ')} under ${dir}; set it by hand`);
}

// ------------------------------------------------------------------ the bounded edits

const indentOf = (line) => line.match(/^ */)[0].length;

// One line changed: `<key>: <literal>`, in place, comments and order untouched. A key the file does
// not carry yet is inserted at the end of the deepest block that does exist.
function setYamlPath(text, dotted, literal) {
  const parts = dotted.split('.');
  const lines = text.split('\n');
  let start = 0;
  let end = lines.length;
  let indent = 0;
  for (let d = 0; d < parts.length; d++) {
    const key = parts[d];
    let found = -1;
    for (let i = start; i < end; i++) {
      if (indentOf(lines[i]) === indent && new RegExp(`^ {${indent}}${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`).test(lines[i])) { found = i; break; }
    }
    if (found === -1) {
      const block = parts.slice(d).reverse().reduce(
        (inner, k, n) => [`${' '.repeat(indent + (parts.length - d - 1 - n) * 2)}${k}:${inner.length ? '' : ` ${literal}`}`, ...inner],
        [],
      );
      let at = end;
      while (at > start && lines[at - 1].trim() === '') at--;
      lines.splice(at, 0, ...block);
      return lines.join('\n');
    }
    if (d === parts.length - 1) {
      lines[found] = `${' '.repeat(indent)}${key}: ${literal}`;
      return lines.join('\n');
    }
    start = found + 1;
    let e = start;
    while (e < end && (lines[e].trim() === '' || indentOf(lines[e]) > indent)) e++;
    end = e;
    indent += 2;
  }
  return lines.join('\n');
}

// `formula:<cycle>:<step>:<key>` — the one key of the one step, inside the `steps:` block of the
// cycle file. A step the formula does not have is refused rather than appended.
function setFormulaStepKey(text, step, key, literal) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^\\s*-\\s+id:\\s*${step}\\s*$`).test(l));
  if (at === -1) throw new Error(`harvest: the formula has no step \`${step}\``);
  const dash = indentOf(lines[at]);
  let end = at + 1;
  while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > dash)) end++;
  const keyIndent = dash + 2;
  for (let i = at + 1; i < end; i++) {
    if (indentOf(lines[i]) === keyIndent && new RegExp(`^ {${keyIndent}}${key}:`).test(lines[i])) {
      lines[i] = `${' '.repeat(keyIndent)}${key}: ${literal}`;
      return lines.join('\n');
    }
  }
  lines.splice(at + 1, 0, `${' '.repeat(keyIndent)}${key}: ${literal}`);
  return lines.join('\n');
}

// `template:<pack>/<name>:<slot>` — one comment line immediately above the slot marker. The slot
// body is never rewritten: a human reads the comment and decides what the slot should say.
function noteAboveSlot(text, slot, id, detail) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^\\s*<!--\\s*slot:${slot}\\b`).test(l));
  if (at === -1) throw new Error(`harvest: the template has no slot \`${slot}\``);
  const note = `<!-- harvest ${id}: ${detail} -->`;
  if (lines[at - 1] === note) return text;
  lines.splice(at, 0, note);
  return lines.join('\n');
}

function editFor(row, file) {
  const value = proposedValue(row);
  const before = fs.readFileSync(file, 'utf8');
  if (row.target.kind === 'config') return { before, after: setYamlPath(before, row.target.path, value) };
  if (row.target.kind === 'formula') return { before, after: setFormulaStepKey(before, row.target.step, row.target.key, value) };
  return { before, after: noteAboveSlot(before, row.target.slot, row.id, value) };
}

// ------------------------------------------------------------------ git

const defaultExec = (repoDir, args) => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function branchSha(exec, repo, branch) {
  try { return exec(repo, ['rev-parse', '--short', `refs/heads/${branch}`]).trim(); } catch (e) { return null; }
}

// harvestRow(processDir, id, {repoDir, templatesDir, exec, dryRun, window}) — one row, one branch, one
// bounded edit, one diff. Nothing is merged, nothing is pushed, and the repo is left on the branch
// it started on: the human checks out the harvest branch when they are ready to open the PR.
function harvestRow(processDir, id, opts = {}) {
  const { repoDir, templatesDir, dryRun = false } = opts;
  const exec = opts.exec || defaultExec;
  if (!repoDir || !templatesDir) throw new Error('harvestRow needs {repoDir, templatesDir}');

  const row = rowOf(processDir, id);
  // The proposed value is checked first: a row nobody has written a proposal on is refused by that
  // name, whatever its target cell says.
  proposedValue(row);
  if (!row.target) throw new Error(`harvest ${id}: the row names no target that parses; edit ${path.join(processDir, 'suggestions.md')} first`);

  const { plane, repo, file } = resolveTarget(processDir, row.target, { repoDir, templatesDir });
  const rel = path.relative(repo, file);
  const branch = `harvest/${id}-${kebab(row.signal)}`;
  const { before, after } = editFor(row, file);

  const existing = branchSha(exec, repo, branch);
  if (existing) {
    return {
      plane, repo, branch, files: [rel], changed: false, diff: '',
      message: `harvest ${id}: branch ${branch} already exists at ${existing} — nothing to do`,
    };
  }

  const base = exec(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();

  if (dryRun) {
    // No branch, no commit: write the edit, read the diff git itself computes, put the file back.
    try {
      fs.writeFileSync(file, after);
      const diff = exec(repo, ['diff', '--', rel]);
      return { plane, repo, branch, files: [rel], changed: false, diff, message: `harvest ${id}: dry run — no branch created` };
    } finally {
      fs.writeFileSync(file, before);
    }
  }

  // Two refusals before the branch. A repo claimed by another window (`plt repo claim`) is that
  // window's to change; a caller with no window (a plain shell) passes, as it passes the run guard.
  // And a dirty target: an uncommitted edit to the file harvest writes would ride into the harvest
  // commit under a chore(harvest) subject. Other dirty files are left alone — `git add` names only
  // the target, and the shared umbrella nearly always carries another window's uncommitted work.
  const mine = opts.window !== undefined ? opts.window : (process.env.PLT_WINDOW || null);
  if (mine) repoWindow.assertRepoWindow(repo, mine);
  const dirty = exec(repo, ['status', '--porcelain', '--untracked-files=no', '--', rel]).split('\n').filter(Boolean).map((l) => l.slice(3));
  if (dirty.length) {
    throw new Error(`harvest ${id}: ${repo} has uncommitted changes to ${dirty.join(', ')}; `
      + `commit or stash them first (git -C ${repo} stash push -m harvest-${id}), then re-run: plt harvest ${id}`);
  }

  exec(repo, ['checkout', '-b', branch]);
  try {
    fs.writeFileSync(file, after);
    exec(repo, ['add', rel]);
    exec(repo, ['commit', '-m', `chore(harvest): ${row.signal} — proposed from ${row.count} occurrence(s) in ${row.runs.join(', ')}`]);
    const diff = exec(repo, ['diff', `${base}..${branch}`]);
    return {
      plane, repo, branch, files: [rel], changed: true, diff,
      message: `harvest ${id}: branch ${branch} in ${repo} — review the diff, then open the PR by hand:\n`
        + `  cd ${repo} && git push -u origin ${branch} && gh pr create --base ${base} --head ${branch} --fill`,
    };
  } finally {
    // Back to where the human left the repo. Only the new branch was ever written to.
    exec(repo, ['checkout', base]);
  }
}

// ------------------------------------------------------------------ CHANGELOG

// Every harvested change is written down with what it is expected to do and when that is measured
// — otherwise nobody can tell later whether the change helped.
function bumpChangelog(processDir, o = {}) {
  const { target, expected, measureAt, id, repoDir, templatesDir } = o;
  if (!target) throw new Error('bump: pass --target <formula:…|template:…|config:…>');
  if (!expected) throw new Error('bump: pass --expected <what this change should do>');
  if (!measureAt) throw new Error('bump: pass --measure-at <date>');
  const now = o.now ? new Date(o.now) : new Date();
  const date = now.toISOString().slice(0, 10);

  let row = null;
  if (id) { try { row = rowOf(processDir, id); } catch (e) { row = null; } }
  const from = row
    ? `suggestion ${row.id} (${row.count} occurrence(s): ${row.runs.join(', ')})`
    : (id ? `suggestion ${id}` : 'a hand-written change');
  const change = row && /^proposed:/.test(row.detail)
    ? `${target} set to ${row.detail.replace(/^proposed:\s*/, '')}`
    : target;

  const entry = [
    `## ${date} — ${target}`,
    `- from: ${from}`,
    `- change: ${change}`,
    `- expected: ${expected}`,
    `- measure at: ${measureAt}`,
    '',
  ].join('\n');

  const file = path.join(processDir, 'CHANGELOG.md');
  const prior = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, prior ? `${entry}\n${prior.replace(/^\n+/, '')}` : entry);

  const parsed = parseTarget(target);
  let versioned = null;
  if (parsed && parsed.kind !== 'config' && repoDir && templatesDir) {
    versioned = bumpVersion(resolveTarget(processDir, parsed, { repoDir, templatesDir }).file);
  }
  return { file, entry, versioned };
}

// A formula or template whose behaviour changed is a new version — the frontmatter `version:` is
// what a run records, so a run launched after the change is distinguishable from one before it.
function bumpVersion(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^version:\s*(\d+)\s*$/m);
  if (!m) return null;
  const next = Number(m[1]) + 1;
  fs.writeFileSync(file, text.replace(/^version:\s*\d+\s*$/m, `version: ${next}`));
  return { file, version: next };
}

// ------------------------------------------------------------------ CLI

function opts(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { const k = args[i].slice(2); const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true; o[k] = v; }
    else o._.push(args[i]);
  }
  return o;
}

// The umbrella is the directory holding process/; the templates checkout is named by
// `harvest.templates_dir` in config, or by PUNCHLIST_TEMPLATES_DIR.
function dirsFor(processDir) {
  const repoDir = path.dirname(processDir);
  const spine = require('./spine');
  const cfg = spine.loadConfig(processDir);
  const named = (cfg.harvest && cfg.harvest.templates_dir) || process.env.PUNCHLIST_TEMPLATES_DIR;
  if (!named) throw new Error(`harvest: no templates checkout named — set \`harvest.templates_dir\` in ${path.join(processDir, 'config')} or PUNCHLIST_TEMPLATES_DIR`);
  return { repoDir, templatesDir: path.resolve(repoDir, named) };
}

function processDirOf() {
  const spine = require('./spine');
  const p = process.env.PLT_PROCESS_DIR || spine.findProcessDir(process.cwd());
  if (!p) throw new Error('no process/config directory found above ' + process.cwd() + ' (set PLT_PROCESS_DIR)');
  return p;
}

const HARVEST_USAGE = 'plt harvest <id> [--dry-run] [--json]';
const BUMP_USAGE = 'plt bump --target <t> --expected <text> --measure-at <date> [--id <suggestion-id>]';

async function harvestHandler(args) {
  const o = opts(args);
  const id = o._[0];
  if (!id) throw new Error(`usage: ${HARVEST_USAGE}`);
  const p = processDirOf();
  const r = harvestRow(p, id, { ...dirsFor(p), dryRun: Boolean(o['dry-run']) });
  if (o.json) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); return 0; }
  process.stdout.write(`${r.message}\n`);
  if (r.diff) process.stdout.write(`\n${r.diff}\n`);
  return 0;
}

async function bumpHandler(args) {
  const o = opts(args);
  const p = processDirOf();
  let dirs = {};
  try { dirs = dirsFor(p); } catch (e) { dirs = {}; }      // the version bump is optional; the entry is not
  const r = bumpChangelog(p, {
    target: typeof o.target === 'string' ? o.target : undefined,
    expected: typeof o.expected === 'string' ? o.expected : undefined,
    measureAt: typeof o['measure-at'] === 'string' ? o['measure-at'] : undefined,
    id: typeof o.id === 'string' ? o.id : undefined,
    ...dirs,
  });
  if (o.json) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); return 0; }
  process.stdout.write(`wrote ${r.file}\n\n${r.entry}`);
  if (r.versioned) process.stdout.write(`${r.versioned.file} is now version ${r.versioned.version}\n`);
  return 0;
}

const commands = [
  { name: 'harvest', usage: HARVEST_USAGE, handler: harvestHandler },
  { name: 'bump', usage: BUMP_USAGE, handler: bumpHandler },
];

module.exports = { readSuggestions, parseTarget, harvestRow, bumpChangelog, setYamlPath, commands };
