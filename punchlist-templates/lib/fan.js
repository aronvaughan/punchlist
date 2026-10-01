'use strict';
// fan — the dispatchable wave over a PLAN's tasks, the same computation `plt effort plan`
// runs over an effort's cards. A plan block carries the two facts the scheduler needs in
// prose: `**Files:**` lists what the task writes (its `touches`), and an `**Interfaces:**`
// `Consumes:` bullet naming another task is its `after`. Dependencies are DECLARED, never
// inferred: a `Task N` string anywhere else in the block creates no edge (R1), and nothing
// past the Interfaces section is read at all (R2).
const fs = require('fs');
const path = require('path');
const effort = require('./effort');

const TASK_HEAD = /^### Task (\d+): (.*)$/;

// The text of the `**Interfaces:**` section, and nothing else — the exact substring the
// `Consumes:` scan (R1) is allowed to read. It ends at the first step, the next task, or a
// `**Files:**` heading, whichever comes first, so a `Consumes:`-shaped line inside a step is
// out of reach (R2).
function readInterfacesBlock(taskText) {
  const lines = String(taskText).split('\n');
  const start = lines.findIndex((l) => /^\s*\*\*Interfaces:\*\*/.test(l));
  if (start === -1) return '';
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*- \[[ xX]\] \*\*Step/.test(line) || /^### /.test(line) || /^\s*\*\*Files:\*\*/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

// The bullet list under `**Files:**`, up to the next `**` heading or the next task.
function readFilesBlock(taskText) {
  const lines = String(taskText).split('\n');
  const start = lines.findIndex((l) => /^\s*\*\*Files:\*\*/.test(l));
  if (start === -1) return '';
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\*\*/.test(line) || /^### /.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

// One bullet → the paths it declares. The role prefix and the backticks go; a comma splits;
// a token with a glob or a parenthetical keeps its literal head (`lib/cli.js (validator)` →
// `lib/cli.js`, `test/gh/*.json` → `test/gh`); a token with neither `/` nor `.` is prose.
function bulletPaths(bullet) {
  const text = bullet.replace(/^\s*-\s+/, '').replace(/^(Create|Modify|Delete|Test|Umbrella):\s*/i, '').replace(/`/g, '');
  const out = [];
  for (const raw of text.split(',')) {
    let tok = raw.trim();
    const cut = tok.search(/[*(]/);
    if (cut !== -1) tok = tok.slice(0, cut);
    tok = tok.trim().replace(/\/+$/, '');
    if (!tok) continue;
    if (!tok.includes('/') && !tok.includes('.')) continue;
    out.push(tok);
  }
  return out;
}

// A `### Task N` heading inside a fenced code block is an example (a plan can quote a fixture
// plan), never a task of this plan. A task number declared twice is an error naming both lines:
// merging or listing both would put a wrong task in the wave.
// A fence closes only on a run of the same character at least as long as the one that opened
// it (CommonMark), so a ```js block quoted inside a ````markdown block does not end it.
const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

function parsePlanTasks(planPath) {
  const text = fs.readFileSync(planPath, 'utf8');
  const lines = text.split('\n');
  const starts = [];
  const seen = new Map();
  let fence = null;
  lines.forEach((l, i) => {
    const f = l.match(FENCE);
    if (f && !fence) { fence = f[1]; return; }
    if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) { fence = null; return; }
    if (fence) return;
    const m = l.match(TASK_HEAD);
    if (!m) return;
    const n = Number(m[1]);
    if (seen.has(n)) throw new Error(`${path.resolve(planPath)} declares Task ${n} twice, at lines ${seen.get(n) + 1} and ${i + 1}`);
    seen.set(n, i);
    starts.push(i);
  });
  return starts.map((start, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
    const block = lines.slice(start, end).join('\n');
    const head = lines[start].match(TASK_HEAD);
    const n = Number(head[1]);
    const files = [];
    for (const line of readFilesBlock(block).split('\n')) {
      if (!/^\s*-\s+/.test(line)) continue;
      for (const p of bulletPaths(line)) if (!files.includes(p)) files.push(p);
    }
    const after = [];
    for (const line of readInterfacesBlock(block).split('\n')) {
      const b = line.replace(/^\s*/, '').replace(/^-\s*/, '');
      if (!b.startsWith('Consumes:')) continue;
      for (const m of b.matchAll(/Task (\d+)/g)) {
        const dep = Number(m[1]);
        if (dep !== n && !after.includes(dep)) after.push(dep);
      }
    }
    return { n, title: head[2].trim(), files, after };
  });
}

// The SDD ledger's completion lines, `Task N: complete` with or without a list dash. An absent
// ledger means nothing is complete.
function readLedgerDone(ledgerPath) {
  let text;
  try { text = fs.readFileSync(ledgerPath, 'utf8'); } catch (e) { return []; }
  const done = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:-\s*)?Task (\d+): complete\b/);
    if (m && !done.includes(Number(m[1]))) done.push(Number(m[1]));
  }
  return done;
}

// A task joins the wave when it is not complete, every declared dependency IS complete, it
// declares at least one file, and no lower-numbered open task claims a file it claims — the
// lower number wins the file, the higher one waits for the next wave. Reasons accumulate.
function planWaveTasks(planPath, ledgerPath) {
  const tasks = parsePlanTasks(planPath);
  const done = readLedgerDone(ledgerPath);
  const open = tasks.filter((t) => !done.includes(t.n));
  const wave = []; const excluded = [];
  for (const t of open) {
    const why = [];
    for (const dep of t.after) if (!done.includes(dep)) why.push(`after Task ${dep} (not complete)`);
    if (!t.files.length) why.push('no declared files');
    for (const other of open) {
      if (other.n >= t.n) continue;
      const shared = t.files.find((f) => effort.touchesOverlap([f], other.files));
      if (shared) { why.push(`shares ${shared} with Task ${other.n}`); break; }
    }
    if (why.length) excluded.push({ n: t.n, why: why.join('; ') });
    else wave.push({ n: t.n, title: t.title });
  }
  return { wave, excluded, done };
}

function formatWave(plan) {
  const head = plan.wave.length ? 'wave: ' + plan.wave.map((t) => 'T' + t.n).join(' ') : 'wave: (none)';
  const rows = [...plan.excluded].sort((a, b) => a.n - b.n).map((e) => `excluded: T${e.n} — ${e.why}`);
  return [head, ...rows].join('\n');
}

function defaultLedger(planPath) {
  const slug = path.basename(planPath).replace(/\.md$/, '');
  return path.resolve(process.cwd(), '.superpowers', 'sdd', slug, 'progress.md');
}

// plt fan <plan-file> [--ledger <path>] [--json] — read-only. Exit 2 names the unreadable file.
function fanHandler(args) {
  const rest = []; let ledger = null; let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ledger') ledger = args[++i];
    else if (args[i] === '--json') json = true;
    else rest.push(args[i]);
  }
  const planPath = rest[0];
  if (!planPath) { process.stderr.write('plt fan: cannot read <plan-file>\n'); return 2; }
  let plan;
  try { plan = planWaveTasks(planPath, ledger || defaultLedger(planPath)); }
  catch (e) {
    process.stderr.write(e.code ? `plt fan: cannot read ${path.resolve(planPath)}\n` : `plt fan: ${e.message}\n`);
    return 2;
  }
  process.stdout.write((json ? JSON.stringify(plan, null, 2) : formatWave(plan)) + '\n');
  return 0;
}

const commands = [{ name: 'fan', usage: 'plt fan <plan-file> [--ledger <path>] [--json]', handler: fanHandler }];

module.exports = { parsePlanTasks, readInterfacesBlock, readFilesBlock, readLedgerDone, planWaveTasks, formatWave, fanHandler, commands };
