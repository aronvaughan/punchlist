'use strict';
// rebase — the merge-conflict OUTCOME and `plt card rebase <effort>/<n>`.
//
// A card's `merge` step declares `outcomes: [merged, conflict]` + `repeat_until: merged`, so a
// conflict is an OUTCOME and `on_fail` does not fire. What that outcome was missing is a RECORD:
// the step re-opened carrying nothing but the word `conflict`, so the next agent to pick the card
// up had to re-derive which repo, which branch, which paths and what to run. This module writes
// that record (`conflictRecord`) and implements the command it names.
//
// `plt card rebase <effort>/<n>` rebases the card's branch onto its base INSIDE the card's own
// worktree and re-checks the merge step's receipts against the new pin — a rebase rewrites every
// commit, so every receipt pinned to the old head is stale and the card must verify again.
//
// A rebase is destructive, so this module is a stack of refusals before it is a stack of commands:
//
//   R1  the target must be `<effort>/<card>` — no bare id, no path
//   R2  the run must exist under `<process>/runs`
//   R3  the run's own `inputs.effort` must NAME the effort given — an ABSENT input refuses too
//   R4  `state.repo_dir` must exist AND be the top level of a git worktree of its own
//   R4b the card must own a branch (`inputs.branch`) — a card with none (a `cycle: spike` card,
//       whose repo_dir is the CANONICAL checkout) has no branch to rebase and is refused
//   R5  the worktree must be CLEAN (the same rule `computePin` applies) — a rebase throws away
//       nothing a human has not committed
//   R6  no rebase may already be in progress — a half-finished rebase is a human's to finish
//       (checked BEFORE R5: a conflicted rebase leaves the tree dirty by construction)
//   R7  HEAD must be ON the card's own recorded branch — never detached, never a sibling's branch
//   R8  the base ref must resolve
//   R9  two CONFLICTED rebases is a HARD GATE: the third attempt is refused until a real person
//       passes --by (`agent` is not a person, and config.actors.humans is checked)
//
// Every guard is written as "the fact must be PRESENT and must match", never "if we happen to know
// the fact, check it". The second shape skips itself exactly when the run's inputs are incomplete,
// which is when it is most needed: `inputs.branch` is unset for a `cycle: spike` card (lib/effort.js
// sets it only `if (!isSpike)`) and that card's repo_dir is the canonical checkout, so an
// only-when-known branch check let `plt card rebase <effort>/<spike>` rebase whatever the main
// checkout had out.
//
// And two things it never does: it never pushes, and it never aborts a conflicted rebase. A
// conflicted rebase is left exactly as git left it, in the card's worktree, for a human to finish
// by hand — an auto-abort would discard the one artifact (the conflicted tree) that says what the
// conflict actually is. "Never pushes" is not provable by a spy over the injected runner (a spy
// sees only what is handed to it); test/rebase.test.js asserts it on the OUTCOME, by snapshotting
// every ref in the origin before and after and requiring it unchanged.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const spine = require('./spine');

const MAX_ATTEMPTS = 2;

// Stamped on every event this module writes, and the ONLY thing `attempts` matches on. Without it
// the hard-gate counter reads `kind: decision, name: rebase`, which `plt receipt --kind decision
// --name rebase --result rebased` reproduces exactly — so the agent could clear the gate raised
// against it by writing one receipt. `recordReceipt` writes a fixed key set and has no way to set
// this field, so a ledger line carrying it came from this file.
const WRITER = 'card-rebase';

// Every git call in this module goes through one runner so a caller (and a test) can see the whole
// command stream. `{ ok, out }` — never a throw, so a failing rebase is data rather than control flow.
function defaultExec(repoDir, args) {
  try {
    const out = execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: String(out || '') };
  } catch (e) {
    return { ok: false, out: String((e.stdout || '')) + String((e.stderr || '')) };
  }
}

// `<effort>/<card>`. Both halves are plain identifiers: the card names a run directory and a git
// branch, and the effort names a file, so anything with a path separator, a space or a shell
// metacharacter in it is refused here rather than interpolated somewhere later.
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function parseTarget(s) {
  const parts = String(s == null ? '' : s).split('/');
  if (parts.length !== 2 || !SAFE.test(parts[0]) || !SAFE.test(parts[1])) {
    throw new Error(`rebase target must be <effort>/<card>, got "${s}"`);
  }
  return { effort: parts[0], card: parts[1] };
}

function nextCommand(effort, card) { return `plt card rebase ${effort}/${card}`; }

// The unmerged paths of a rebase that stopped — git's own list, not a guess.
function unmergedPaths(repoDir, exec) {
  const r = exec(repoDir, ['diff', '--name-only', '--diff-filter=U']);
  return r.out.split('\n').map((s) => s.trim()).filter(Boolean).sort();
}

// The paths a rebase onto `base` COULD conflict on, for a record written before any rebase runs:
// files this branch changed since the merge-base that the base has also changed since then. A file
// only one side touched cannot conflict. Best-effort — an unresolvable base yields [].
function predictedConflictPaths(repoDir, base, exec) {
  const mb = exec(repoDir, ['merge-base', 'HEAD', base]);
  if (!mb.ok) return [];
  const at = mb.out.trim();
  const side = (ref) => {
    const r = exec(repoDir, ['diff', '--name-only', at, ref]);
    return r.ok ? r.out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  };
  const theirs = new Set(side(base));
  return side('HEAD').filter((f) => theirs.has(f)).sort();
}

function baseRef(processDir) {
  const cfg = spine.loadConfig(processDir);
  const b = cfg && cfg.worktree && cfg.worktree.base;
  return typeof b === 'string' && b.trim() ? b.trim() : 'origin/main';
}

// Resolve a target to the card's run, with R2/R3/R4 applied. `inputs.effort` is the authority on
// which effort a card belongs to: the command line is a claim, the run's own inputs are the fact.
function resolveCard(processDir, target, exec = defaultExec) {
  const { effort, card } = typeof target === 'string' ? parseTarget(target) : target;
  const st = spine.readState(processDir, card);
  if (!st) throw new Error(`no run ${card} under ${processDir}/runs`);                       // R2
  const inputs = spine.readInputs(processDir, card);
  // R3. Present AND matching. An absent `inputs.effort` used to pass: a run launched outside an
  // effort could then be driven by any `<anything>/<card>` target at all.
  if (!inputs.effort) throw new Error(`run ${card} has no inputs.effort — it was not launched as a card of an effort, so no effort owns it`);
  if (inputs.effort !== effort) {
    throw new Error(`card ${card} belongs to effort ${inputs.effort}, not ${effort} — refusing to touch another effort's card`);
  }
  const repo = st.repo_dir;
  if (!repo || !fs.existsSync(repo)) throw new Error(`run ${card} has no worktree on disk (repo_dir: ${repo || 'unset'})`);        // R4
  // R4. `fs.existsSync` proves a directory, not a worktree: a plain directory nested inside another
  // repo makes every `git -C` here operate on the ENCLOSING repo, silently. The top level git
  // reports must be this directory itself.
  const top = exec(repo, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new Error(`run ${card}: ${repo} is not a git worktree — ${top.out.trim()}`);
  if (fs.realpathSync(top.out.trim()) !== fs.realpathSync(repo)) {
    throw new Error(`run ${card}: ${repo} is not the top of a git worktree — it sits inside ${top.out.trim()}, so every git command here would drive that repo instead`);
  }
  // R4b. A card with no branch of its own is a `cycle: spike` card: lib/effort.js writes
  // `inputs.branch` only `if (!isSpike)`, and a spike's repo_dir is the canonical checkout. There is
  // nothing to rebase and the checkout is not ours to rewrite.
  if (!inputs.branch) {
    throw new Error(`card ${card} has no branch of its own (inputs.branch is unset — a spike card runs in the canonical checkout ${repo}, not a worktree); refusing to rebase a checkout this card does not own`);
  }
  return { effort, card, st, inputs, repo };
}

// conflictRecord(processDir, target, {paths, step}) — the `conflict` outcome's payload, and the
// event that carries it. It names the card, the effort, the repo, the branch, the conflicting
// paths and the exact next command, so the re-opened merge step is readable without re-deriving
// any of it. Recorded, never inferred: `paths` is what the caller measured; absent, it is
// predicted from the branch/base overlap.
function conflictRecord(processDir, target, { paths, step = 'merge', record = true, exec = defaultExec, by } = {}) {
  const { effort, card, inputs, repo } = resolveCard(processDir, target, exec);
  const base = baseRef(processDir);
  // A prediction made against a ref nobody fetched is a prediction about last week's main, which
  // reads exactly like "no conflict". Refresh first, best-effort: an offline machine still gets a
  // record, just one whose `paths` may be short — and the rebase itself re-measures from git.
  const remote = base.includes('/') ? base.split('/')[0] : null;
  if (remote && exec(repo, ['remote', 'get-url', remote]).ok) exec(repo, ['fetch', remote]);
  const rec = {
    card,
    effort,
    repo,
    branch: inputs.branch,
    base,
    paths: Array.isArray(paths) && paths.length ? [...paths].sort() : predictedConflictPaths(repo, base, exec),
    next: nextCommand(effort, card),
  };
  // `effort` is the RUN/EFFORT ledger discriminator in schemas/event.schema.json: a run line that
  // carries it is not a run line any more. The slug goes on `effort_slug` so the record can name
  // its effort without changing which ledger the reader thinks the line came from.
  if (record) {
    const { effort: slug, ...rest } = rec;
    spine.appendEvent(processDir, card, { kind: 'decision', step, name: 'merge-conflict', writer: WRITER,
      effort_slug: slug, ...rest, ...spine.actorFields(by) });
  }
  return rec;
}

function currentBranch(repoDir, exec) {
  const r = exec(repoDir, ['branch', '--show-current']);
  return r.ok ? r.out.trim() : '';
}

// R5. The same rule `spine.computePin` applies: any status line at all — modified, staged or
// untracked — is dirty. A rebase that runs over uncommitted work destroys it silently, and the
// cost of being wrong here is unrecoverable, so the bar is "nothing to lose", not "probably fine".
function dirtyPaths(repoDir, exec) {
  const r = exec(repoDir, ['status', '--porcelain', '--untracked-files=all']);
  if (!r.ok) throw new Error(`cannot read git status in ${repoDir}: ${r.out.trim()}`);
  return r.out.split('\n').filter(Boolean).map((l) => l.slice(3).trim());
}

// R6. A worktree's `.git` is a file, so the rebase state lives under the resolved git dir, not
// under `<repo>/.git`.
function rebaseInProgress(repoDir, exec) {
  const r = exec(repoDir, ['rev-parse', '--absolute-git-dir']);
  if (!r.ok) return false;
  const gitDir = r.out.trim();
  return ['rebase-merge', 'rebase-apply'].some((d) => fs.existsSync(path.join(gitDir, d)));
}

// The rebase attempts THIS MODULE recorded for this card, newest last. Matched on `writer`, which
// `plt receipt` cannot set — see WRITER.
function attempts(processDir, card) {
  return spine.readEvents(processDir, card).filter((e) => e.kind === 'decision' && e.name === 'rebase' && e.writer === WRITER);
}

// standingFailures(processDir, card, headNow) — how many conflicts stand unresolved.
//
// Counting rules, each one a case that got this wrong:
//   * only `result: 'conflict'` increments. `result: 'error'` (a rebase that never started) is
//     neither a conflict nor a success: a failing pre-rebase hook or a stale index.lock must not
//     push a card toward a hard gate it did not earn.
//   * only `result: 'rebased'` resets. Resetting on "anything that is not a conflict" let any
//     other decision line clear the count.
//   * a branch whose HEAD is no longer where the last conflict left it has been resolved BY HAND
//     (`git rebase --continue`, a manual merge). The gate was raised about a state that no longer
//     exists, so it does not stand. An ABORTED rebase returns HEAD to exactly where it was, so
//     aborting does not clear anything — which is the distinction that makes this safe.
function standingFailures(processDir, card, headNow) {
  const seen = attempts(processDir, card);
  let n = 0; let lastConflict = null;
  for (const e of seen) {
    if (e.result === 'conflict') { n += 1; lastConflict = e; }
    else if (e.result === 'rebased') { n = 0; lastConflict = null; }
  }
  if (n && headNow && lastConflict && lastConflict.from && lastConflict.from !== headNow) return 0;
  return n;
}

// rebaseCard(processDir, target, {exec, by, json}) -> a result object.
// Runs every refusal above, then `git fetch` (only when the base names a remote that exists) and
// `git rebase <base>`, in the card's own worktree. On success it re-checks the merge step's gate
// at the NEW pin and reports what the rewrite invalidated. On a conflict it records the outcome
// and STOPS, leaving the rebase in progress.
function rebaseCard(processDir, target, { exec = defaultExec, by } = {}) {
  const { effort, card, st, inputs, repo } = resolveCard(processDir, target, exec);
  const base = baseRef(processDir);
  const headNow = exec(repo, ['rev-parse', 'HEAD']).out.trim();
  const failures = standingFailures(processDir, card, headNow);

  // R9 — the hard gate. Two conflicted rebases is not a third attempt's problem to discover.
  // `--by` must name a PERSON: `spine.personOf` reads `agent` as nobody, and `assertHuman` holds it
  // to config.actors.humans where the project lists them. A gate any caller can pass by typing
  // `--by agent` is a comment, not a gate.
  if (failures >= MAX_ATTEMPTS) {
    const person = spine.personOf(by);
    if (!person) {
      throw new Error(`${card}: ${failures} rebases onto ${base} have conflicted — this is a hard gate. `
        + `A person must look at ${repo} and re-run with --by <person>; "${by == null ? 'nobody' : by}" is not a person.`);
    }
    spine.assertHuman(processDir, card, person);
  }

  // R5 before R6 would be wrong: a conflicted rebase leaves the tree dirty BY CONSTRUCTION, so the
  // dirty message would fire on every second call and hide the state the human actually has to deal
  // with. The more specific refusal goes first.
  if (rebaseInProgress(repo, exec)) {                                                          // R6
    throw new Error(`${card}: a rebase is already in progress in ${repo} — finish it (git rebase --continue) or abandon it (git rebase --abort) by hand`);
  }
  const dirty = dirtyPaths(repo, exec);                                                       // R5
  if (dirty.length) {
    throw new Error(`${card}: worktree ${repo} is dirty (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ` and ${dirty.length - 5} more` : ''}) `
      + '— commit or stash before a rebase; a rebase over uncommitted work destroys it');
  }
  const branch = currentBranch(repo, exec);                                                    // R7
  if (!branch) throw new Error(`${card}: ${repo} has a detached HEAD — check out ${inputs.branch || "the card's branch"} first`);
  // Not `inputs.branch && …`: R4b already proved the card has a branch, and leaving the
  // only-when-known form here would quietly re-open the hole the moment R4b moved or softened.
  if (branch !== inputs.branch) {
    throw new Error(`${card}: ${repo} is on ${branch}, but the card's branch is ${inputs.branch} — refusing to rebase a branch this card does not own`);
  }

  // Only fetch when the base actually names a remote this repo has; a fetch failure is fatal,
  // because rebasing onto a stale base is the defect this command exists to fix.
  const remote = base.includes('/') ? base.split('/')[0] : null;
  if (remote && exec(repo, ['remote', 'get-url', remote]).ok) {
    const f = exec(repo, ['fetch', remote]);
    if (!f.ok) throw new Error(`${card}: git fetch ${remote} failed — ${f.out.trim()}`);
  }
  if (!exec(repo, ['rev-parse', '--verify', '--quiet', base]).ok) {                            // R8
    throw new Error(`${card}: base ref ${base} does not resolve in ${repo} (config worktree.base)`);
  }

  const from = exec(repo, ['rev-parse', 'HEAD']).out.trim();
  const onto = exec(repo, ['rev-parse', base]).out.trim();
  // `--no-update-refs` is not tidiness. With `rebase.updateRefs=true` git rewrites EVERY local
  // branch that points into the range being rebased, and refs are shared across all worktrees of a
  // repo — so a card's rebase silently moved a sibling card's branch, in a worktree nobody was
  // looking at. This command owns exactly one branch (R7); it updates exactly one.
  const r = exec(repo, ['rebase', '--no-update-refs', base]);
  const attempt = attempts(processDir, card).length + 1;
  const common = { kind: 'decision', step: 'merge', name: 'rebase', writer: WRITER,
    card, effort_slug: effort, repo, branch, base, onto, attempt, from };

  if (!r.ok) {
    // A non-zero `git rebase` is not automatically a conflict. A failing `pre-rebase` hook, a stale
    // `index.lock`, an unreadable object: those never started, leave no unmerged paths and no rebase
    // in progress, and must not be dressed up as a conflict — reported as one they would say LEFT IN
    // PROGRESS about a tree nothing touched, and would count toward a hard gate the card did not
    // earn. git's own two facts decide which this is; git's stderr is carried either way.
    const paths = unmergedPaths(repo, exec);
    const stopped = paths.length > 0 || rebaseInProgress(repo, exec);
    if (!stopped) {
      spine.appendEvent(processDir, card, { ...common, result: 'error', error: r.out.trim().slice(0, 2000), ...spine.actorFields(by) });
      throw new Error(`${card}: git rebase ${branch} onto ${base} did not start — ${r.out.trim() || 'git failed with no output'}`);
    }
    // Deliberately NOT aborted. The conflicted tree is the evidence; a human finishes it.
    spine.appendEvent(processDir, card, { ...common, result: 'conflict', paths,
      git: r.out.trim().slice(0, 2000), next: nextCommand(effort, card), ...spine.actorFields(by) });
    const conflict = conflictRecord(processDir, { effort, card }, { paths, exec, by });
    // Counted at the head the conflict was raised AT (`from`), not at the live head: mid-rebase,
    // `rev-parse HEAD` is the base commit, which would read as "the human moved it" every time.
    const nowFailed = standingFailures(processDir, card, from);
    const hardGate = nowFailed >= MAX_ATTEMPTS;
    if (hardGate) {
      spine.appendEvent(processDir, card, { kind: 'escalation', step: 'merge', name: 'rebase-hard-gate', writer: WRITER,
        card, effort_slug: effort, repo, attempts: nowFailed, ...spine.actorFields(by),
        text: `${nowFailed} rebases of ${branch} onto ${base} have conflicted — a person must resolve ${repo} by hand` });
    }
    return { ok: false, card, effort, repo, branch, base, attempt, paths, conflict, git: r.out.trim(),
      hard_gate: hardGate, failures: nowFailed, next: nextCommand(effort, card),
      message: `rebase of ${branch} onto ${base} conflicted on ${paths.length} path(s); the rebase is LEFT IN PROGRESS in ${repo} — `
        + 'resolve, then `git rebase --continue` (or `git rebase --abort` to undo it)' };
  }

  const head = exec(repo, ['rev-parse', 'HEAD']).out.trim();
  spine.appendEvent(processDir, card, { ...common, result: 'rebased', head, ...spine.actorFields(by) });

  // Re-run the card's verification. A rebase rewrites every commit on the branch, so the pin every
  // receipt was taken at is gone: `gateCheck` at the new pin is exactly the list of what must be
  // proved again before the merge step can settle as `merged`.
  let verify;
  if (!st.steps || !st.steps.merge) {
    verify = { ok: false, error: `run ${card} has no merge step to re-verify` };
  } else {
    try {
      const g = spine.gateCheck(processDir, card, 'merge', repo);
      verify = { ok: g.ok, missing: g.missing, pin: g.pin };
    } catch (e) { verify = { ok: false, error: e.message }; }
  }
  return { ok: true, card, effort, repo, branch, base, attempt, from, head, verify, hard_gate: false, failures: 0,
    message: `rebased ${branch} ${from.slice(0, 8)} -> ${head.slice(0, 8)} onto ${base} ${onto.slice(0, 8)}` };
}

// ---- CLI -------------------------------------------------------------------------

// Flags that take NO value. Without this list the generic "next token that is not a flag is the
// value" rule makes `plt card rebase --json greenhouse/TRK-10` set `json` to the target and leave
// no positional at all — which reached parseTarget as undefined and crashed rather than running.
const BOOLEAN_FLAGS = new Set(['json']);
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const takesValue = !BOOLEAN_FLAGS.has(k) && argv[i + 1] && !argv[i + 1].startsWith('--');
      o[k] = takesValue ? argv[++i] : true;
    } else o._.push(argv[i]);
  }
  return o;
}

const USAGE = 'plt card rebase <effort>/<n> [--by <person>] [--json] | plt card conflict <effort>/<n> [--paths a,b] [--json]';

function processDirOf(ctx) {
  const env = (ctx && ctx.env) || process.env;
  const p = env.PLT_PROCESS_DIR || spine.findProcessDir((ctx && ctx.cwd) || process.cwd());
  if (!p) throw new Error('no process/config directory found (set PLT_PROCESS_DIR)');
  return p;
}

function cardHandler(argv, ctx = {}) {
  const o = parseArgs(argv);
  const sub = o._[0];
  const write = (t) => process.stdout.write(t);
  if (!sub || !['rebase', 'conflict'].includes(sub)) { process.stderr.write(USAGE + '\n'); return 2; }
  const p = processDirOf(ctx);
  try {
    if (sub === 'conflict') {
      const paths = typeof o.paths === 'string' ? o.paths.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const rec = conflictRecord(p, o._[1], { paths, by: typeof o.by === 'string' ? o.by : undefined });
      if (o.json) { write(JSON.stringify(rec, null, 2) + '\n'); return 0; }
      write(`${rec.card}: merge conflict in ${rec.repo} on ${rec.paths.length} path(s)${rec.paths.length ? ': ' + rec.paths.join(', ') : ''}\n`);
      write(`next: ${rec.next}\n`);
      return 0;
    }
    const r = rebaseCard(p, o._[1], { by: typeof o.by === 'string' ? o.by : undefined });
    if (o.json) { write(JSON.stringify(r, null, 2) + '\n'); return r.ok ? 0 : 1; }
    write(`${r.card}: ${r.message}\n`);
    if (r.ok && r.verify && !r.verify.ok) {
      const miss = (r.verify.missing || []).map((m) => `${m.kind}:${m.name}`).join(', ');
      write(`re-verify: ${(r.verify.missing || []).length} requirement(s) unproved at the new pin${miss ? ' — ' + miss : ''}\n`);
    }
    if (!r.ok) {
      write(`next: ${r.next}\n`);
      if (r.hard_gate) write(`HARD GATE: ${r.failures} rebases have conflicted — a person must resolve ${r.repo}; re-run with --by <person>\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    process.stderr.write(`plt card ${sub}: ${e.message}\n`);
    return 1;
  }
}

const commands = [{ name: 'card', usage: USAGE, handler: cardHandler }];

module.exports = { MAX_ATTEMPTS, WRITER, USAGE, BOOLEAN_FLAGS, parseTarget, nextCommand, predictedConflictPaths, unmergedPaths,
  baseRef, resolveCard, conflictRecord, dirtyPaths, rebaseInProgress, attempts, standingFailures,
  rebaseCard, cardHandler, defaultExec, commands };
