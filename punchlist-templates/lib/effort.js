'use strict';
// effort — a card's conflict surface (touches, after) and the parallel wave it can plan.
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const yaml = require('./yaml');
const spine = require('./spine');

// The cycle a card runs when it does not name one. `build-and-ship` was hardcoded here,
// which made "does this project use pull requests?" a question only editable by patching
// the library. It is a project fact, so it lives in project config — and it is an
// OVERRIDE, never a requirement: a project that sets nothing keeps the old default, so no
// existing effort changes behaviour.
//
// This is config picking a PACK, not config changing control flow. A `review.mode` flag
// that skipped open-pr/pr-loop/resync/reply/merge would put branching in config, which
// the spine keeps in the formula; `build-and-commit` declares that shape instead.
const CYCLE_FALLBACK = 'build-and-ship';
function defaultCycle(processDir) {
  {
    const cfg = spine.loadConfig(processDir);
    const v = cfg && cfg.cycles && cfg.cycles.default;
    return typeof v === 'string' && v.trim() ? v.trim() : CYCLE_FALLBACK;
  }
  // No catch. Swallowing a config error here made `plt effort plan` report
  // build-and-ship for every card while `launchWave` - which reloads config unguarded -
  // threw the YAML error, so the two disagreed and the quieter one was wrong. A project
  // whose config will not parse has a problem worth stopping for, at the first command
  // that reads it rather than the second.
}

function readEffort(processDir, slug) {
  const f = path.join(processDir, 'efforts', `${slug}.yaml`);
  if (!fs.existsSync(f)) throw new Error(`no effort ${slug} (expected ${f})`);
  const e = yaml.parse(fs.readFileSync(f, 'utf8'));
  return { ...e, cards: normalizeCards(e.cards || [], defaultCycle(processDir)) };
}

// A card id names a run directory, a branch and a worktree path, and is interpolated into git
// commands — so it is refused unless it is a plain identifier (letters, digits, `.`, `_`, `-`;
// no leading `.`/`-`, no whitespace, no shell metacharacters).
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function normalizeCards(cards, defaultCycle = CYCLE_FALLBACK) {
  return cards.map((c) => (typeof c === 'string' ? { id: c } : c)).map((c) => {
    if (typeof c.id !== 'string' || !SAFE_ID.test(c.id)) throw new Error(`effort card id "${c.id}" is not a safe identifier`);
    return {
      cycle: defaultCycle, touches: [], after: [], ...c,
      touches: [...(c.touches || [])].map((t) => t.replace(/\/+$/, '')),
      after: [...(c.after || [])],
    };
  });
}

// q(s) — single-quote a value for `sh`, so a path with a space (or anything else the shell would
// read) reaches git as one argument. Used wherever a substituted VALUE is spliced into a command
// this module builds, and to the free-text values (paths, refs, config strings) substituted into
// the user's `windows.*` templates, so those templates leave the tokens bare.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// This checkout: `{templates}` in a windows.* template (see launchWave, and watchOnce in spine-cli.js).
const TEMPLATES_DIR = path.resolve(__dirname, '..');
// The windows.* values that arrive shell-quoted. Ids stay bare.
const WINDOW_QUOTED = ['path', 'branch', 'base', 'umbrella', 'process_dir', 'repo', 'root', 'templates'];

const segs = (p) => p.split('/').filter(Boolean);
function prefixOf(a, b) { const x = segs(a), y = segs(b); return x.length <= y.length && x.every((s, i) => s === y[i]); }
function touchesOverlap(a, b) { return a.some((p) => b.some((q) => prefixOf(p, q) || prefixOf(q, p))); }
// CONTAINMENT, one-directional: is `file` inside one of `declared`? `touchesOverlap` answers a
// different question — "do these two declarations collide" — and is symmetric because collision
// is. Used as a containment test it also returns true when the FILE is an ancestor of a declared
// path, so a change that escapes the declaration reads as inside it, and the drift check
// under-reports the very thing it exists to report. Narrow in practice, because `git diff` names
// files rather than directories, and not narrow for a submodule entry or a declaration naming a
// path that is not a file. The guard is cheap; being wrong in the lenient direction is not.
function coversPath(declared, file) { return declared.some((d) => prefixOf(d, file)); }
// The paths two touches lists both cover: for each overlapping pair, the deeper of the two (the
// wider one contains it). `packages/resolvers` against `packages/resolvers/test` shares the latter.
function sharedTouches(a, b) {
  const out = [];
  for (const p of a) for (const q of b) {
    const shared = prefixOf(p, q) ? q : prefixOf(q, p) ? p : null;
    if (shared && !out.includes(shared)) out.push(shared);
  }
  return out;
}

function runStatus(processDir, id) {
  const st = spine.readState(processDir, id);
  if (!st) return 'absent';
  if (st.status === 'closed') return st.closed_as === 'discarded' ? 'discarded' : 'closed';
  return st.steps ? 'running' : 'absent';
}

// Cards the effort file lists under `dropped:` — a bare id, or `{ id, reason, replaced_by }`.
// The `record` step of the discard exit is gated on this list, and the planner never schedules
// a dropped card or counts it as a satisfied dependency.
function droppedIds(processDir, slug) {
  const e = readEffort(processDir, slug);
  return (e.dropped || []).map((d) => (typeof d === 'string' ? d : d && d.id)).filter(Boolean);
}

function planWave(processDir, slug) {
  const e = readEffort(processDir, slug);
  const ids = new Set(e.cards.map((c) => c.id));
  const dropped = new Set(droppedIds(processDir, slug));
  const running = e.cards.filter((c) => runStatus(processDir, c.id) === 'running');
  const wave = []; const excluded = [];
  for (const c of e.cards) {
    if (dropped.has(c.id)) { excluded.push({ card: c.id, why: 'dropped' }); continue; }
    const status = runStatus(processDir, c.id);
    if (status !== 'absent') { excluded.push({ card: c.id, why: `already ${status}` }); continue; }
    const why = [];
    for (const dep of c.after) {
      if (dropped.has(dep) || runStatus(processDir, dep) === 'discarded') why.push(`after ${dep}, which was dropped — re-point the dependency`);
      else if (!ids.has(dep)) why.push(`${dep} is not a card of this effort (external dependency)`);
      else if (runStatus(processDir, dep) !== 'closed') why.push(`after ${dep} (not closed)`);
    }
    for (const other of [...running, ...wave]) {
      if (touchesOverlap(c.touches, other.touches)) {
        why.push(`touches ${sharedTouches(c.touches, other.touches).join(', ')} — shared with ${other.id}`);
      }
    }
    if (why.length) excluded.push({ card: c.id, why: why.join('; ') }); else wave.push(c);
  }
  return { wave, excluded, running: running.map((r) => r.id) };
}

// Files changed on this branch relative to baseRef — worktree diff and staged-only diff,
// de-duplicated, so a staged-only tree (pin kind 'tree') still counts its changes.
function diffPaths(repoDir, baseRef) {
  const out = new Set();
  for (const args of [['diff', '--name-only', baseRef], ['diff', '--name-only', '--cached', baseRef]]) {
    for (const f of spine.git(repoDir, args).split('\n')) if (f.trim()) out.add(f.trim());
  }
  return [...out].sort();
}

// liveChanges(repoDir, baseRef) — the files a run has changed that main does NOT already carry.
// A squash-merged branch is never an ancestor of origin/main, so its diff from the merge-base
// keeps every file it ever touched; measured this way a merged run collided with every sibling
// forever, and a child stacked on it inherited the whole set. A file that is identical in HEAD
// (or the index) and origin/main has landed — it is nobody's live change. Without an origin/main
// ref this is just the branch diff. Freshness of origin/main is the caller's job (fetch first).
function liveChanges(repoDir, baseRef) {
  const changed = diffPaths(repoDir, baseRef);
  if (!hasOriginMain(repoDir)) return changed;
  const stillDiffers = new Set(diffPaths(repoDir, 'origin/main'));
  return changed.filter((f) => stillDiffers.has(f));
}

// Other runs in the SAME (truthy) effort that are still open (merge not done) and not this run —
// the pool `overlapCheck` compares diffs against. A run that never launched, has already closed,
// or (like this one, absent a slug) has no effort of its own never matches — two effort-less runs
// must not collide with each other just because both are falsy. Each carries its LAUNCH pin so
// the caller can derive that run's branch base live (see `branchBase`) — never a stored base.
function inflightRuns(processDir, effortSlug, exceptRun) {
  const runsDir = path.join(processDir, 'runs');
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir).filter((id) => id !== exceptRun).map((id) => {
    const st = spine.readState(processDir, id); const inputs = spine.readInputs(processDir, id);
    return st && st.steps && st.status !== 'closed' && inputs && inputs.effort && inputs.effort === effortSlug && st.steps.merge && st.steps.merge.status !== 'done'
      ? { id, repoDir: st.repo_dir, pin: st.pin || null } : null;
  }).filter(Boolean);
}

// Whether `origin/main` actually resolves in this repo — false for no remote, an unfetched clone,
// or a repo whose default branch isn't `main`. liveChanges' landed-file filter and overlapCheck's
// staleness half depend on it; branchBase tries it after the configured base.
function hasOriginMain(repoDir) {
  try { spine.git(repoDir, ['rev-parse', '--verify', '--quiet', 'origin/main']); return true; } catch { return false; }
}

// branchBase(repoDir, launchPin, baseRef) — the commit a run's changes are measured FROM, for the
// overlap and touches-drift diffs. Never the launch pin itself: a tree pin's base_sha is the
// branch HEAD at launch, so a diff from it sees only what is staged and misses every commit the
// branch made since. Order: (1) `baseRef` (the configured `worktree.base`) resolves → the
// merge-base of HEAD and it; (2) `origin/main` resolves → the merge-base of HEAD and origin/main;
// (3) neither → the launch pin's commit (base_sha for a tree pin, value for a sha pin) —
// "everything since launch"; (4) no pin either → HEAD (only the staged tree counts). (1) comes
// first because the pin goes stale once the branch merges its base: every file the base gained
// would count as the run's own.
function branchBase(repoDir, launchPin, baseRef) {
  for (const ref of [baseRef, 'origin/main']) {
    if (!ref) continue;
    try { spine.git(repoDir, ['rev-parse', '--verify', '--quiet', ref]); } catch { continue; }
    try { return spine.git(repoDir, ['merge-base', 'HEAD', ref]).trim(); } catch { /* unrelated histories: fall through */ }
  }
  const pinSha = launchPin && (launchPin.kind === 'tree' ? launchPin.base_sha : launchPin.value);
  if (pinSha) return pinSha;
  return spine.git(repoDir, ['rev-parse', 'HEAD']).trim();
}

// Live conflict check for a run against its effort's other in-flight runs: which changed files
// they share, and whether this run's pinned base has fallen behind origin/main. Both diffs run
// from `branchBase` with the configured `worktree.base` — this run's from its own repo, each
// sibling's computed live from that sibling's `repo_dir` — so committed branch work counts, with or
// without a remote, and a base the run has merged does not count as its own. Two checks still use
// `origin/main` only: liveChanges' landed-file filter and the staleness half below. So with a
// local base and no remote, a sibling fast-forwarded into the base shows no live files, and this
// run is not told that the base moved under a file it shares. Base freshness is ANCESTRY (`git merge-base --is-ancestor origin/main <head>`),
// never SHA equality — a branch that has committed past origin/main is still fresh as long as
// origin/main is still one of its ancestors. `head` is the LIVE pin's commit: base_sha for a tree
// pin, value for a sha pin; the caller (gateCheck) passes its freshly computed pin — given none
// (a direct call, the umbrella renderer), this pins the tree itself and uses the recorded
// `state.pin` only when the tree is unpinnable. An effort-less run (no `inputs.effort`, and none passed in) cannot collide
// with anything and its base can't go stale relative to a wave it isn't part of — trivially
// ok/fresh. A repo with no resolvable `origin/main` (no remote, an unfetched clone, a non-`main`
// default branch) can't be checked for staleness — fresh by definition — but its overlap half
// still runs, from the configured base or, failing that, the launch pin.
function overlapCheck(processDir, runId, { repoDir, pin, effortSlug } = {}) {
  const st = spine.readState(processDir, runId);
  const repo = repoDir || st.repo_dir;
  const slug = effortSlug !== undefined ? effortSlug : spine.readInputs(processDir, runId).effort;
  if (!slug) return { ok: true, shared: [], baseFresh: true, mainSha: null };
  // No live pin given (a renderer, a direct call): pin the tree now; only an unpinnable tree
  // falls back to the recorded launch pin — which, after a rebase, would read stale forever.
  let myPin = pin;
  if (!myPin) { const live = spine.computePin(repo); myPin = live.refused ? st.pin : live; }

  // One base for this run and its siblings: they share the effort, so they share its config. A
  // config that cannot be read throws: falling back to the launch pin in silence would bring back
  // the false overlaps this base exists to remove. The YAML error carries a line but no file, so
  // the rethrow names the config directory.
  let baseRef;
  try { baseRef = ((spine.loadConfig(processDir) || {}).worktree || {}).base; }
  catch (e) { throw new Error(`overlapCheck: cannot read the config in ${path.join(processDir, 'config')}: ${e.message}`); }
  const mine = new Set(liveChanges(repo, branchBase(repo, st.pin, baseRef)));
  const shared = [];
  for (const other of inflightRuns(processDir, slug, runId)) {
    if (!other.repoDir || !fs.existsSync(other.repoDir)) continue;   // a run whose worktree is gone cannot collide
    let theirs;
    try { theirs = liveChanges(other.repoDir, branchBase(other.repoDir, other.pin, baseRef)); } catch { continue; }   // no comparable base: cannot collide
    const files = theirs.filter((f) => mine.has(f));
    if (files.length) shared.push({ run: other.id, files });
  }

  let mainSha = null, baseFresh = true;
  const head = myPin && (myPin.kind === 'tree' ? myPin.base_sha : myPin.value);
  // A run whose PR has merged (a passing `gh merged` receipt on its merge step) is as fresh as it
  // will ever be: main now carries it, and "rebase, then re-pin" has nothing left to rebase.
  const merged = spine.readEvents(processDir, runId).some((e) => e.kind === 'gh' && e.name === 'merged' && e.result === 'pass' && e.step === 'merge');
  if (!merged && hasOriginMain(repo) && head) {
    mainSha = spine.git(repo, ['rev-parse', 'origin/main']).trim();
    try { spine.git(repo, ['merge-base', '--is-ancestor', 'origin/main', head]); baseFresh = true; }
    catch { baseFresh = false; }
  }
  return { ok: shared.length === 0, shared, baseFresh, mainSha };
}

// kebab(title) — the card title's first three words, lowercased and hyphenated, for a worktree/
// branch slug. Punctuation inside a word is dropped but a word's own hyphens survive. A titleless
// card (a bare-id entry) yields the empty string; launchWave then drops the `-{slug}` tail.
function kebab(title) {
  return String(title || '').trim().split(/\s+/).filter(Boolean).slice(0, 3)
    .map((w) => w.toLowerCase().replace(/[^a-z0-9-]/g, ''))
    .filter(Boolean).join('-');
}

// pascalSummary(title) — the same first-three-words window as kebab, PascalCased with no
// separator, for the `{card}-{Summary}` window label (`TRK-10-RenameTheSampler`).
function pascalSummary(title) {
  return String(title || '').trim().split(/\s+/).filter(Boolean).slice(0, 3)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

// Substitutes `{name}` tokens from `vars`; a token with no matching var is left as-is (so a
// template referencing a not-yet-known placeholder, e.g. `{pane_id}` before the window command
// has run, degrades visibly instead of silently vanishing).
function renderTemplate(tmpl, vars) {
  return String(tmpl || '').replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m));
}

// With an empty slug a `{card}-{slug}` template renders `TRK-14-`; drop that dangling `-` at the
// end of the string or of any path segment.
function dropEmptySlug(rendered, slug) {
  return slug ? rendered : rendered.replace(/-+(?=\/|$)/g, '');
}

function resolveFromUmbrella(umbrella, p) {
  return path.isAbsolute(p) ? p : path.resolve(umbrella, p || '');
}

// launchWave — one worktree, one run and one window per card in an effort's plannable wave.
// Per card, in order: (1) a `cycle: spike` card gets no worktree, its `repo_dir` is the canonical
// checkout; (2) `git worktree add` off the canonical checkout; (3) each `worktree.setup` command,
// run inside the new worktree; (4) `spine.launchRun` + `runs/<card>/inputs.yaml`; (5) the
// `windows.command` (its stdout parsed for `{pane_id}`/`{tab_id}` when it's JSON), then
// `windows.open`. `--dry-run` prints every command and performs no step (4)/(5) side effect. A
// failure in step (2) or (3) skips that card (`{card, error}`) and the wave continues; a step (4)
// failure is NOT caught — a half-launched run must not read as merely skipped. A step (5) failure
// (a flaky window tool) IS caught per card: the worktree/run/inputs.yaml already exist on disk by
// then, so the card still counts as `launched`, with `window: { error: <message> }` instead of
// pane/tab ids, and the wave continues to the next card. Before any of that, the card's cycle is
// resolved (`spine.loadFormula`): an unknown cycle skips the card up front, worktree-free.
function launchWave(processDir, slug, { dryRun = false, only, exec, owner } = {}) {
  const cfg = spine.loadConfig(processDir);
  const wt = cfg.worktree || {};
  const windows = cfg.windows || {};
  const run = exec || ((cmd, opts) => execSync(cmd, { encoding: 'utf8', cwd: opts && opts.cwd }));
  const umbrella = path.dirname(processDir);
  const { wave } = planWave(processDir, slug);
  const cards = only ? wave.filter((c) => only.includes(c.id)) : wave;
  // The run's owner: --owner if given, else the first configured human, else nobody.
  const runOwner = owner || (cfg.actors && Array.isArray(cfg.actors.humans) && cfg.actors.humans[0]) || null;

  const launched = []; const skipped = [];
  // A --only id that is not in the wave (excluded, unknown) is reported, never silently dropped.
  for (const id of only || []) if (!wave.some((c) => c.id === id)) skipped.push({ card: id, error: 'not in the wave' });
  for (const card of cards) {
    const isSpike = card.cycle === 'spike';
    // A titleless (bare-id) card has no slug: the `-{slug}` tail of the branch/path templates is
    // dropped below, so it lands on `feat/{card}` rather than `feat/{card}-{card lowercased}`.
    const cardSlug = kebab(card.title);
    const Summary = pascalSummary(card.title || card.id);
    // `effort` is the effort's slug. `slug` is the card's title in kebab case, and a window driver
    // needs the effort's name: each effort gets one workspace.
    // `process_dir` is where the runs live. A window seeded in a worktree cannot find them from its cwd.
    // `templates` is this checkout, so a windows.* template names a shipped driver without a path in
    // config. A path in config would put a home directory into a file that can be published.
    const vars = { card: card.id, slug: cardSlug, Summary, repo: wt.repo || '', root: wt.root || '', umbrella, cycle: card.cycle, effort: slug, process_dir: processDir, templates: TEMPLATES_DIR };
    const canonical = resolveFromUmbrella(umbrella, wt.canonical || '');

    let repoDir; let branch;
    try {
      // An unknown cycle would only surface at launchRun, after the worktree exists — resolve the
      // formula first so a misnamed cycle skips the card without leaving an orphan worktree.
      spine.loadFormula(processDir, card.cycle);
      if (isSpike) {
        repoDir = canonical;
        // A spike works in the canonical checkout, so that is its {path}. Without it the token stays
        // literal and `--cwd {path}` opens on the string "{path}".
        vars.path = canonical;
      } else {
        branch = dropEmptySlug(renderTemplate(wt.branch, vars), cardSlug);
        vars.branch = branch;
        const relPath = dropEmptySlug(renderTemplate(wt.path, vars), cardSlug);
        const absPath = resolveFromUmbrella(umbrella, relPath);
        vars.path = absPath;
        const base = renderTemplate(wt.base, vars);
        vars.base = base;
        const addCmd = `git -C ${q(canonical)} worktree add ${q(absPath)} -b ${q(branch)} ${q(base)}`;
        if (dryRun) { console.log(addCmd); } else { run(addCmd); }
        // Setup commands are shell lines the config owns; the VALUES we splice into them
        // (paths, refs) are quoted so a space in a worktree root cannot split an argument.
        const shellVars = { ...vars, path: q(absPath), branch: q(branch), umbrella: q(umbrella), base: q(base) };
        for (const setup of (wt.setup || [])) {
          const cmd = renderTemplate(setup, shellVars);
          if (dryRun) console.log(cmd); else run(cmd, { cwd: absPath });
        }
        repoDir = absPath;
      }
    } catch (e) {
      skipped.push({ card: card.id, error: e.message });
      continue;
    }

    let runResult = null; let windowResult = null;
    if (!dryRun) {
      runResult = spine.launchRun(processDir, { runId: card.id, cycle: card.cycle, repoDir, owner: runOwner, estimate: card.estimate });
    }

    if (windows.command) {
      // The same rule as worktree.setup: quote the free-text values (paths, refs, config strings).
      // Otherwise a space in the umbrella splits `--cwd {path}` into two arguments.
      // Ids (card, effort, slug, cycle, pane_id, tab_id) stay bare, as `plt watch` leaves them.
      const winVars = () => {
        const w = { ...vars };
        for (const k of WINDOW_QUOTED) if (w[k] !== undefined) w[k] = q(w[k]);
        return w;
      };
      const cmd = renderTemplate(windows.command, winVars());
      if (dryRun) {
        console.log(cmd);
        if (windows.open) console.log(renderTemplate(windows.open, winVars()));   // {pane_id}/{tab_id} stay literal: nothing ran
      } else {
        try {
          const stdout = run(cmd);
          let paneId, tabId, paneLabel;
          try {
            const raw = JSON.parse(stdout);
            const parsed = (raw && raw.result) || raw;   // some window tools wrap the payload under `result`
            paneId = parsed && parsed.root_pane && parsed.root_pane.pane_id;
            tabId = parsed && parsed.tab && parsed.tab.tab_id;
            paneLabel = parsed && parsed.root_pane && parsed.root_pane.label;
          } catch { /* not JSON: no pane/tab to expose */ }
          if (paneId !== undefined) vars.pane_id = paneId;
          if (tabId !== undefined) vars.tab_id = tabId;
          if (windows.open) run(renderTemplate(windows.open, winVars()));
          windowResult = { pane_id: paneId, tab_id: tabId, label: paneLabel };
        } catch (e) {
          windowResult = { error: e.message };
        }
      }
    }

    if (!dryRun) {
      const inputs = { title: card.title, card: card.id, effort: slug };
      if (!isSpike) inputs.branch = branch;
      inputs.repo_dir = repoDir;
      inputs.touches = card.touches;
      inputs.merge = 'auto';
      // A window that actually opened (no error, a real pane id) is persisted so `plt watch` can
      // notify into it later. The label is the one the window tool gave the pane, so {label} in a
      // notify template names the pane agents see. A tool that returns none gets the
      // `{card}-{Summary}` name `pascalSummary` was built for (`TRK-10-RenameTheSampler`).
      if (windowResult && !windowResult.error && windowResult.pane_id !== undefined) {
        const label = typeof windowResult.label === 'string' && windowResult.label ? windowResult.label : `${card.id}${Summary ? '-' + Summary : ''}`;
        inputs.window = { tab_id: windowResult.tab_id, pane_id: windowResult.pane_id, label };
      }
      fs.mkdirSync(path.join(processDir, 'runs', card.id), { recursive: true });
      fs.writeFileSync(path.join(processDir, 'runs', card.id, 'inputs.yaml'), yaml.stringify(inputs));
    }

    launched.push({ card: card.id, branch, path: repoDir, run: runResult, window: windowResult });
  }
  return { launched, skipped };
}

module.exports = { CYCLE_FALLBACK, defaultCycle,
  readEffort, normalizeCards, touchesOverlap, planWave, droppedIds, runStatus, diffPaths, inflightRuns, branchBase, overlapCheck,
  kebab, pascalSummary, launchWave, renderTemplate, q, TEMPLATES_DIR, coversPath,
};
