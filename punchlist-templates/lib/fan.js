'use strict';
// fan — the dispatchable wave over a PLAN's tasks, the same computation `plt effort plan`
// runs over an effort's cards. A plan block carries the two facts the scheduler needs in
// prose: `**Files:**` lists what the task writes (its `touches`), and an `**Interfaces:**`
// `Consumes:` bullet naming another task is its `after`. Dependencies are DECLARED, never
// inferred: a `Task N` string anywhere else in the block creates no edge, and nothing
// past the Interfaces section is read at all.
const fs = require('fs');
const path = require('path');
const effort = require('./effort');

const TASK_HEAD = /^### Task (\d+): (.*)$/;

// The text of the `**Interfaces:**` section, and nothing else — the exact substring the
// `Consumes:` scan is allowed to read. It ends at the first step, the next task, or a
// `**Files:**` heading, whichever comes first, so a `Consumes:`-shaped line inside a step is
// out of reach.
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
// declares at least one file, and its file contention (if any) has been resolved.
//
// CONTENTION IS A HELD DECISION, NOT A VERDICT. A task that shares a file with a
// lower-numbered open task is still held — the safe default survives — but the hold now
// carries what a human needs to overturn it: WHICH task it overlaps and WHICH path. Two ways
// out, and they are the only two:
//
//   unblock  accept the rebase risk; the task joins the wave now, in parallel with the task
//            it overlaps. Recorded, so the index can show who accepted it.
//   hold     wait for the lower ("first in") task to close, then join automatically. This is
//            the old behaviour, kept as the default and made explicit.
//
// `after` is untouched and still orders strictly. A dependency has NO unblock, because the
// work genuinely is not ready — offering one would teach people to click past real
// dependencies, which is the failure this whole mechanism exists to avoid.
//
// The fan stays a pure function of one plan plus the decisions it is handed. It does not read
// other efforts, other runs, or anything global: that would be a cross-effort lock, which is
// deliberately not built, arriving here wearing a different hat.
// clearedIds — the task numbers a human has cleared to run contended.
//
// `Array.from(unblocked, Number)` was wrong in the one way that matters: it iterates a
// STRING BY CHARACTER. `unblocked: '12'` — the exact shape a `--unblock 12` flag or a JSON
// field produces — became [1, 2], so task 2 was dispatched onto a contended file with no
// human decision behind it while task 12, the one actually cleared, stayed held. A scalar
// number was silently a no-op for the same reason. Coercing whatever arrives is the wrong
// instinct here: the cost of guessing wrong is dispatching work nobody approved, so an
// input this code cannot read is refused by name.
function clearedIds(unblocked) {
  if (unblocked === undefined || unblocked === null) return new Set();
  const list = typeof unblocked === 'string' ? unblocked.split(',')
    : (typeof unblocked[Symbol.iterator] === 'function' ? Array.from(unblocked) : null);
  if (list === null) {
    throw new Error(`unblocked must be a list of task numbers (got ${typeof unblocked} ${JSON.stringify(unblocked)})`);
  }
  const out = new Set();
  for (const raw of list) {
    // An id this code cannot read is refused rather than dropped: silently ignoring
    // `--unblock 4,fiive` would hold task 5 while the human believes they cleared it.
    // `Number()` did not keep that promise — Number([true]) is 1, Number('1e2') is 100,
    // Number('0x4') is 4, Number([[4]]) is 4 — so the accepted shapes are stated instead
    // of coerced: a number that is already a positive integer, or a string of its digits.
    const s = typeof raw === 'string' ? raw.trim() : raw;
    const n = typeof s === 'number' ? s : (typeof s === 'string' && /^[0-9]+$/.test(s) ? Number(s) : NaN);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`unblocked: ${JSON.stringify(raw)} is not a task number`);
    }
    out.add(n);
  }
  return out;
}

// unblocked: task numbers a human has said may run contended — an array, a Set, any
// iterable, or a comma-separated string. Passed in rather than read from disk, so the fan
// stays pure and one caller owns where the decision lives.
function planWaveTasks(planPath, ledgerPath, opts = {}) {
  const cleared = clearedIds((opts || {}).unblocked);
  const tasks = parsePlanTasks(planPath);
  const done = readLedgerDone(ledgerPath);
  // A missing ledger and a ledger recording nothing both read as `[]`. Telling them apart is the
  // whole of G-13: `plt fan` reported every finished task of a landed plan as "not complete"
  // because it was reading a path that did not exist, and said nothing about it.
  const ledger = { path: ledgerPath, found: fs.existsSync(ledgerPath) };
  const open = tasks.filter((t) => !done.includes(t.n));
  const wave = []; const excluded = [];
  for (const t of open) {
    const why = [];
    for (const dep of t.after) if (!done.includes(dep)) why.push(`after Task ${dep} (not complete)`);
    if (!t.files.length) why.push('no declared files');

    // EVERY overlap, not the first. The old `break` recorded one and the unblock then
    // cleared them all, so the consent recorded did not match the risk taken: a task
    // colliding with two others was presented as colliding with one, and the wave row —
    // whose whole job is to say why two cards are touching a file — named the wrong pair.
    // `with`/`path` stay as the lowest-numbered overlap so existing readers keep working;
    // `all` carries the rest, and a human sees what they are actually accepting.
    const overlaps = [];
    for (const other of open) {
      if (other.n >= t.n) continue;
      const shared = t.files.find((f) => effort.touchesOverlap([f], other.files));
      if (shared) overlaps.push({ with: other.n, path: shared });
    }
    overlaps.sort((a, b) => a.with - b.with);
    // No `count` beside `all`: two fields that must agree are one more thing to get out
    // of step, and a reader who trusts the stale one is told a card collides with a
    // number of tasks the list beside it does not match. The tally is `all.length`.
    const contended = overlaps.length ? { ...overlaps[0], all: overlaps } : null;
    // An unblock clears CONTENTION ONLY. A task held by both a dependency and an overlap
    // stays held by the dependency — the most important case here, and the one most easily
    // got wrong, because an unblock that silently satisfied `after` would dispatch work
    // whose inputs do not exist yet.
    if (contended && !cleared.has(t.n)) {
      why.push(overlaps.map((o) => `shares ${o.path} with Task ${o.with}`).join('; '));
    }

    if (why.length) {
      const row = { n: t.n, why: why.join('; ') };
      if (contended) row.contended = { ...contended, unblocked: cleared.has(t.n) };
      excluded.push(row);
    } else {
      const row = { n: t.n, title: t.title };
      // A task that ran BECAUSE someone accepted the risk carries that fact into the wave,
      // so the board can say why two cards are touching one file rather than looking broken.
      if (contended) row.contended = { ...contended, unblocked: true };
      wave.push(row);
    }
  }
  return { wave, excluded, done, ledger };
}

function formatWave(plan) {
  const head = plan.wave.length ? 'wave: ' + plan.wave.map((t) => 'T' + t.n).join(' ') : 'wave: (none)';
  // A wave computed against a ledger that is not there is not a wave, it is a guess. Say so on the
  // line above it, every time, rather than letting the reader assume the tool checked.
  const warn = plan.ledger && !plan.ledger.found
    ? [`NO LEDGER at ${plan.ledger.path} — every task is treated as incomplete. Name the real one with`,
       '  a `**Ledger:** <path>` line in the plan, or pass --ledger. This wave is not to be trusted.']
    : [];
  const rows = [...plan.excluded].sort((a, b) => a.n - b.n).map((e) => `excluded: T${e.n} — ${e.why}`);
  return [...warn, head, ...rows].join('\n');
}

// The ledger a plan is executed against. A plan may NAME it — `**Ledger:** <path>` anywhere in the
// file — because the directory does not always match the plan's basename: a ledger under
// `my-plan/` can belong to a plan whose file is `my-plan-with-a-longer-title.md`. The basename default
// stays as the convention for plans that do not say.
function ledgerFromPlan(planPath) {
  let text;
  try { text = fs.readFileSync(planPath, 'utf8'); } catch (e) { return null; }
  const m = text.match(/^\s*(?:[-*]\s*)?\*\*Ledger:\*\*\s*`?([^`\n]+?)`?\s*$/m);
  if (!m) return null;
  const named = m[1].trim();
  return path.isAbsolute(named) ? named : path.resolve(process.cwd(), named);
}

function defaultLedger(planPath) {
  const named = ledgerFromPlan(planPath);
  if (named) return named;
  const slug = path.basename(planPath).replace(/\.md$/, '');
  return path.resolve(process.cwd(), '.superpowers', 'sdd', slug, 'progress.md');
}

// The usage line, written once. The registry entry below and every argument error quote
// THIS constant: two copies of a usage string drift, and bin/plt's own help is already
// proof of it — it still omits --unblock.
const FAN_USAGE = 'plt fan <plan-file> [--ledger <path>] [--json] [--unblock 4,7]';

// plt fan <plan-file> [--ledger <path>] [--json] [--unblock 4,7] — read-only. Exit 2 names
// the unreadable file. `--unblock` accepts the rebase risk for those tasks: they join the
// wave contended, and the wave row says so.
//
// WHERE THE ARGUMENT CHECKS LIVE, and why it is not the parser. The first version of these
// guards asked, in the parse loop, "is there a next argument?" — and that question has
// more ways past it than it has answers. `--ledger ""`, which is what `--ledger "$LEDGER"`
// produces with the variable unset, IS a next argument, so it sailed through; `ledger ||
// defaultLedger(planPath)` then read the empty string as "not given" and computed the
// whole wave against the guessed ledger at exit 0, with no warning, and in --json mode not
// even the NO LEDGER line when that guessed path happened to exist. The parser had checked
// something adjacent to what mattered.
//
// So the parser now RECORDS what was typed and judges none of it, and one chokepoint below
// decides whether each recorded value is usable. A fourth reader of `ledger` cannot walk
// past a check that sits on the only path to the value.
function fanHandler(args) {
  const rest = []; let ledger = null; let json = false; let unblock = null;
  let sawUnblock = false; let sawLedger = false;
  // A value-taking flag takes the next argument only when there is one AND it is not
  // itself a flag. Without that second half `--ledger --json` ate the --json as a path —
  // a text wave at exit 0 with the operator's --json silently gone — and
  // `--ledger --unblock 2` left the 2 orphaned, to be blamed later as a stray argument.
  // A path that really does start with a dash is still reachable as `./-name`.
  const hasValue = (i) => i + 1 < args.length && !/^-/.test(args[i + 1]);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ledger') {
      // Given twice, the first path was dropped without a word. A wave read against the
      // wrong completion record is G-13, the defect this flag was added to fix: a landed
      // plan reported every finished task as still open and said nothing about why.
      if (sawLedger) { process.stderr.write(`plt fan: --ledger given twice; name one ledger, as --ledger <path>\n`); return 2; }
      sawLedger = true;
      if (hasValue(i)) ledger = args[++i];
    }
    else if (args[i] === '--json') json = true;
    else if (args[i] === '--unblock') {
      // Given twice, the last one used to win and the first was dropped without a word.
      // What gets dropped is a human decision, so the task named first stayed held while
      // the operator had written, in the same command, that it could run.
      if (sawUnblock) { process.stderr.write(`plt fan: --unblock given twice; clear every task in one flag, as --unblock 4,7\n`); return 2; }
      sawUnblock = true;
      if (hasValue(i)) unblock = args[++i];
    }
    else rest.push(args[i]);
  }

  // THE CHOKEPOINT. Every flag that takes a value is judged here, on the value itself
  // rather than on the shape of the command line that produced it — so a missing value, a
  // value eaten by the next flag, and an empty string from an unset shell variable all
  // arrive as the same fact and get the same refusal. These run BEFORE the stray check,
  // so a flag that went without its value is named ahead of the token standing next to it.
  if (sawLedger && !String(ledger ?? '').trim()) {
    process.stderr.write(`plt fan: --ledger needs a path, as --ledger <path>\n`); return 2;
  }
  if (sawUnblock && !String(unblock ?? '').trim()) {
    process.stderr.write(`plt fan: --unblock needs task numbers, as --unblock 4,7\n`); return 2;
  }

  // One plan path is the whole contract, so anything left over is a mistyped flag or a
  // shell accident — zsh does not split an UNQUOTED PARAMETER EXPANSION, so a variable
  // holding `--ledger x --ledger y` arrives as one argument rather than four. (Typed
  // words it splits normally; it is expansion that differs from sh.) Collected into
  // `rest` and dropped in silence, that printed an ordinary wave at exit 0 while an
  // argument the operator typed went unread.
  //
  // Name the argument that was NOT understood. A leftover still wearing a leading dash is
  // an unrecognised flag and is always the culprit, whichever side of the plan path it was
  // typed; blaming the positional there would point the operator at the one argument they
  // got right.
  const stray = rest.find((a) => /^-/.test(a)) ?? (rest.length > 1 ? rest[1] : null);
  if (stray !== null) {
    process.stderr.write(`plt fan: unexpected argument ${JSON.stringify(stray)}; ${FAN_USAGE}\n`);
    return 2;
  }
  const planPath = rest[0];
  if (!planPath) { process.stderr.write('plt fan: cannot read <plan-file>\n'); return 2; }
  // `ledger || defaultLedger(planPath)` was the second half of the high: `||` cannot tell
  // "not given" from "given as empty". `sawLedger` is the only thing that records whether
  // the operator named a ledger, so it is the only thing consulted.
  const ledgerPath = sawLedger ? ledger : defaultLedger(planPath);
  let plan;
  try { plan = planWaveTasks(planPath, ledgerPath, { unblocked: unblock }); }
  catch (e) {
    process.stderr.write(e.code ? `plt fan: cannot read ${path.resolve(planPath)}\n` : `plt fan: ${e.message}\n`);
    return 2;
  }
  process.stdout.write((json ? JSON.stringify(plan, null, 2) : formatWave(plan)) + '\n');
  return 0;
}

const commands = [{ name: 'fan', usage: FAN_USAGE, handler: fanHandler }];

module.exports = { clearedIds, parsePlanTasks, defaultLedger, ledgerFromPlan, readInterfacesBlock, readFilesBlock, readLedgerDone, planWaveTasks, formatWave, fanHandler, commands };
