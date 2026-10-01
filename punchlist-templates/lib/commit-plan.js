'use strict';
// commit-plan — the `commit-plan` artifact and the `reconcile` step that checks the
// commits a card actually made against the plan a human read.
//
// A card's PR (or, on build-and-commit, its fast-forward) carries ONE COMMIT PER LOGICAL
// SEGMENT. A segment is one entry of the card's `commit-plan`, written at dispatch as an
// `artifact:` requirement. This module holds three separable things, deliberately kept
// apart so each can be wrong on its own and be caught:
//
//   1. parseCommitPlan  — the artifact's machine-readable form (a table) -> entries.
//   2. planGate         — WHETHER the plan needs a human: gated only when an entry's
//                         files intersect a LOWER OPEN card's `touches`.
//   3. reconcile        — commits vs plan, plus `commit ⊆ touches`, plus the two
//                         escalations that make a banner into a hard gate.
//
// NOT YET WIRED: the CLI verbs `plt card recommit` / `plt card replan` do not exist.
// Everything they need is exported: `replanFromCommits` rewrites the plan from git
// (replan) and `planDiff` produces the plan-diff to record; `reconcile().mode` tells the
// CLI whether it may proceed with a banner or must stop at a hard gate. Wiring them is
// one call site in bin/plt.

// ---------------------------------------------------------------- path containment

// Path segments, with `.` dropped and `..` resolved. Without this, `./lib/x.js` and
// `lib/./x.js` are not the same path as `lib/x.js` — and worse, `lib/../bin/plt` reads as
// two segments under `lib` and so passes a containment check on `lib`. A path spelling is
// not a permission: a card that declared `lib` has not declared `bin/plt` however the
// commit spells it. A `..` that climbs past the root leaves the marker `..`, which can
// never equal a declared segment, so such a path is inside nothing.
function segs(p) {
  const out = [];
  for (const part of String(p).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else out.push('..'); continue; }
    out.push(part);
  }
  return out;
}

const covers = (touch, file) => {
  const x = segs(touch), y = segs(file);
  return x.length > 0 && x.length <= y.length && x.every((s, i) => s === y[i]);
};

// `touch` contains `file`: every segment of the touch is a leading segment of the file.
// Segment-wise, never string-wise — `lib/commit-plan.js` must not be read as covering
// `lib/commit-plan.js.orig`, and a string `startsWith` says it does.
//
// ONE-DIRECTIONAL, unlike effort.touchesOverlap. That function answers "do these two
// declarations collide", which is symmetric; this one answers "is this changed file
// inside what the card declared", which is not. A card declaring `lib/commit-plan.js`
// has NOT declared the whole of `lib`, and a symmetric test would let a commit that
// rewrote `lib` pass the containment check that exists to catch exactly that.
//
// DUPLICATION, KNOWN AND DEFERRED: `lib/effort.js` holds the sibling rule (`prefixOf`,
// `touchesOverlap`, `sharedTouches`), and two copies of a containment rule in a gate
// module can drift apart. When `lib/effort.js` exports a one-directional `coversPath`,
// `covers` and `sharedPaths` below collapse into calls to it — keeping the
// one-directional and segment-normalising behaviour these tests pin.
function inside(file, touches) {
  return (touches || []).some((t) => covers(t, file));
}

// The declared paths a set of files intersects — used to say WHICH path two cards share,
// because "this plan is gated" with no path named is a decision nobody can check.
function sharedPaths(files, touches) {
  const out = [];
  for (const f of files || []) {
    for (const t of touches || []) {
      const hit = covers(t, f) ? f : covers(f, t) ? t : null;
      if (hit && !out.includes(hit)) out.push(hit);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the artifact

const COMMIT_PLAN_ARTIFACT = 'commit-plan';

// A markdown table row -> its cells. Splits on UNESCAPED pipes only: a `\|` inside a cell
// is a literal pipe, and splitting on it silently shifts every cell after it one column
// left. That put a subject fragment in the `files` column and the real files nowhere —
// an entry that lost its files, reported as a clean parse.
function cellsOf(line) {
  return line.trim().replace(/^\|/, '').replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

const SHA_RE = /^[0-9a-f]{4,40}$/i;
const NOT_YET = new Set(['', '-', '—', '–']);

// The artifact's machine-readable half is one markdown table: `#`, `commit`, `files`,
// and an optional `sha` filled in once the commit exists. Everything else on the page is
// prose for the human.
//
// THE RULE THIS PARSER IS BUILT ON: a page this module cannot understand produces an
// ERROR, never an empty success. `{ entries: [], errors: [] }` is the worst answer it
// could give, because `planGate([])` is then "not gated" and the dispatch gate is off
// with nobody told. So: no plan table at all is an error; a plan table with no rows is an
// error; a row whose cell count does not match the header is an error; an entry number
// that is not a plain integer is an error; a `sha` cell that is not a sha is an error; and
// a row with no files is an error, because an entry declaring nothing intersects nobody
// and would switch this card's gate off by itself.
function parseCommitPlan(text) {
  const lines = String(text || '').split('\n');
  const entries = [];
  const errors = [];
  let cols = null;
  let tableAt = 0;
  let rows = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*\|/.test(line)) { cols = null; continue; }
    const cells = cellsOf(line);
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;       // the header rule
    if (cols === null) {
      const head = cells.map((c) => c.toLowerCase().replace(/[^a-z#]/g, ''));
      // Only a table with BOTH a numbering column and a files column is the plan table.
      // A page may hold other tables (a gate table, a findings table); reading one of
      // those as the plan is how a card reconciles against rows nobody wrote as commits.
      if (head.includes('#') && head.includes('files')) { cols = head; tableAt = i + 1; }
      else cols = undefined;
      continue;
    }
    if (cols === undefined) continue;
    rows++;
    if (cells.length !== cols.length) {
      errors.push({ line: i + 1, msg: `commit-plan row has ${cells.length} cells, the header has ${cols.length} — escape a literal pipe as \\|: ${line.trim()}` });
      continue;
    }
    const at = (name) => { const k = cols.indexOf(name); return k < 0 ? '' : (cells[k] || ''); };
    // A plain integer, not "digits found somewhere in the cell". `T6-1` stripped to digits
    // is entry 61, which sorts to the end and reports every real entry as a gap.
    const nRaw = at('#').replace(/\.$/, '').trim();
    const n = Number(nRaw);
    if (!/^\d+$/.test(nRaw) || !Number.isInteger(n) || n <= 0) {
      errors.push({ line: i + 1, msg: `commit-plan row has no entry number (want a positive integer, got ${JSON.stringify(at('#'))}): ${line.trim()}` });
      continue;
    }
    const files = at('files').split(/[,;]|\s+/).map((f) => f.replace(/`/g, '').trim()).filter(Boolean);
    if (!files.length) {
      errors.push({ line: i + 1, msg: `commit-plan entry ${n} declares no files — an entry with no files can never be gated` });
      continue;
    }
    const sha = at('sha').replace(/`/g, '').trim();
    const entry = { n, subject: at('commit').replace(/`/g, '').trim(), files };
    // `pending`, `tbd`, `wip` in a sha column are not shas. Kept as one, the reconcile
    // sha check compares HEAD against a word and reports a rewritten commit on every card
    // that filled the column in honestly.
    if (!NOT_YET.has(sha)) {
      if (SHA_RE.test(sha)) entry.sha = sha;
      else errors.push({ line: i + 1, msg: `commit-plan entry ${n}: ${JSON.stringify(sha)} is not a sha — leave the cell empty or write —` });
    }
    entries.push(entry);
  }
  if (!tableAt) {
    errors.push({ line: 1, msg: 'no commit-plan table on this page (want a markdown table with `#` and `files` columns) — a page with no plan cannot be shown to be safe' });
  } else if (!rows) {
    errors.push({ line: tableAt, msg: 'the commit-plan table has no entries — a card lands at least one commit' });
  }
  entries.sort((a, b) => a.n - b.n);
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].n !== i + 1) {
      errors.push({ line: 1, msg: `commit-plan entries must be numbered 1..n with no gaps (got ${entries.map((e) => e.n).join(', ')})` });
      break;
    }
  }
  return { entries, errors };
}

// ---------------------------------------------------------------- the gate

// A card is still "open" until its run is closed, discarded or dropped. Anything else —
// running, in review, not yet launched (`absent`) — is open, because the file it declared
// can still move under this card's feet. `absent` is the case worth naming: a card that
// has not started is the MOST likely to rewrite the shared file, and treating "no run
// state yet" as closed is how the gate silently stops asking.
// `effort.runStatus` returns exactly four words: absent | running | closed | discarded.
// The first version of this set also held 'dropped' and 'merged', which it NEVER returns
// — so the two statuses that read as finished were spelled in a vocabulary nothing writes,
// while a genuinely dropped card (effort.droppedIds, a separate list on the effort file)
// arrived with some other status and gated every card above it forever. Dropped is a flag
// on the card here, not a status, because that is how the effort file records it.
const CLOSED_STATUSES = new Set(['closed', 'discarded']);
const isClosed = (c) => CLOSED_STATUSES.has(c.status) || c.dropped === true;

// The cards that can gate this one: earlier in the effort's order (the fan's "first in"
// rule — the lower card owns the file) and not finished.
//
// `cards` is the effort's card list in order: [{ id, touches, status }]. Order comes from
// the array, not from parsing digits out of ids: `T9` and `T10` sort wrong as strings and
// `T6a` has no number at all, and a mis-ordered pair gates the wrong card of the two.
function lowerOpenCards(cards, cardId) {
  const list = Array.isArray(cards) ? cards : [];
  const mine = list.findIndex((c) => c && c.id === cardId);
  if (mine < 0) throw new Error(`commit-plan: card ${JSON.stringify(cardId)} is not in the effort's card list`);
  return list.slice(0, mine).filter((c) => c && !isClosed(c));
}

// planGate(entries, lower) -> { gated, reasons }
// Gated ONLY when an entry's files intersect a lower open card's `touches`. That is
// why the gate is cheap: the fan already knows this, and a card whose
// commits collide with nobody needs no human to order them.
//
// `reasons` names the entry, the other card and the shared path, because the decision the
// human makes is about ORDER ("put the shared-file commit last"), which they cannot make
// from a bare boolean.
function planGate(entries, lower) {
  // AN EMPTY PLAN IS NOT A SAFE PLAN. `{ gated: false }` here is the single most expensive
  // answer this module can give: it is what a page with no table, an unreadable table, or
  // a parse that failed all reduce to, and it switches the dispatch gate off with nobody
  // told. Absence of evidence is not evidence of absence, so an empty plan is gated and
  // says it does not know. `unknown` lets reconcile tell "gated because it collides" apart
  // from "gated because it cannot be read" — the second must not count as a gate FLIP.
  if (!entries || entries.length === 0) {
    return { gated: true, unknown: true,
      reasons: [{ kind: 'no-entries', detail: 'no commit-plan entries — a plan that cannot be read cannot be shown to collide with nothing' }] };
  }
  const reasons = [];
  for (const e of entries || []) {
    for (const other of lower || []) {
      const shared = sharedPaths(e.files, other.touches);
      if (shared.length) reasons.push({ entry: e.n, with: other.id, paths: shared });
    }
  }
  return { gated: reasons.length > 0, unknown: false, reasons };
}

// ---------------------------------------------------------------- reconcile

// The reconcile step, exported as data so a formula file splices in exactly this and
// nothing drifts between this module and the yaml.
const reconcileStep = Object.freeze({
  id: 'reconcile',
  assignee: 'agent',
  title: 'Reconcile the commits against the approved commit-plan for {card}',
  needs: ['commit-plan'],
  outcomes: ['matches', 'diverged'],
});

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// planDiff(before, after) -> [{ n, kind, ... }]
// kind: added | removed | files | subject. Not `order`: a reordering shows up as the
// `files` change it is, at each position that moved, which names the two commits actually
// affected. A single `order` row would say less and would have to be believed.
// Recorded when the plan is rewritten
// from git, so "plan changed" on the pre-pr summary can say WHAT changed.
function planDiff(before, after) {
  const a = before || [], b = after || [];
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (!x) { out.push({ n: y.n, kind: 'added', subject: y.subject, files: y.files }); continue; }
    if (!y) { out.push({ n: x.n, kind: 'removed', subject: x.subject, files: x.files }); continue; }
    const fx = [...x.files].sort().join(' '), fy = [...y.files].sort().join(' ');
    if (fx !== fy) out.push({ n: y.n, kind: 'files', from: x.files, to: y.files });
    else if (norm(x.subject) !== norm(y.subject)) out.push({ n: y.n, kind: 'subject', from: x.subject, to: y.subject });
  }
  return out;
}

// The plan git actually produced: one entry per commit, in `git rev-list --reverse` order.
function replanFromCommits(commits) {
  return (commits || []).map((c, i) => ({ n: i + 1, subject: norm(c.subject), files: [...(c.files || [])].sort(), sha: c.sha }));
}

// reconcile({ entries, commits, touches, lower, gatedBefore }) ->
//   { outcome: 'matches'|'diverged', mode: 'banner'|'hard', reasons, diff, replanned, gate }
//
// `commits` are base..HEAD in APPLY order (oldest first) — see commitsBetween.
//
// Divergence is a BANNER by default: the plan is rewritten from git, the plan-diff is
// recorded, and pre-pr-summary notes "plan changed". Rewriting a plan after the fact is
// normal work; holding a card for it would make the artifact a tax.
//
// It escalates to HARD in exactly two cases, and both are the same thing: someone already
// ruled on the old plan and the new one is outside what they ruled on.
//   (a) a commit exceeded the card's `touches` — the card went outside its declared scope,
//       which no plan can authorise because the touches are what the effort deconflicted on;
//   (b) the re-plan would flip the gate false->true — the old plan needed no human because
//       it collided with nobody, the new one collides, and nobody has looked at it.
// The reverse flip (true->false) is NOT hard: a plan that stopped colliding has strictly
// less to rule on than the one already approved.
function reconcile({ entries = [], commits = [], touches = [], lower = [], gatedBefore = null } = {}) {
  const reasons = [];

  // (a) containment. Checked against EVERY commit, including ones that match the plan:
  // a plan can itself name a file outside the card's touches, and then matching it is
  // precisely the wrong outcome. This is why the check is on commits ⊆ touches and not
  // on commits ⊆ plan ⊆ touches.
  const over = [];
  const undeclared = !(touches || []).length && (commits || []).length > 0;
  if (!undeclared) {
    for (const c of commits) {
      const outsiders = (c.files || []).filter((f) => !inside(f, touches));
      if (outsiders.length) over.push({ sha: c.sha, subject: c.subject, files: outsiders });
    }
  }
  // DECLARING NOTHING IS "NOT DECLARED", NOT "NOTHING IS OUT OF SCOPE". `effort.js`
  // defaults every card to `touches: []`, so skipping the containment check on an empty
  // list switched the escalation off for precisely the cards most likely to need it: a
  // card that never said what it would touch could commit anywhere and reconcile called it
  // a banner. It cannot be checked, so it is not passed quietly — it is raised, loudly, as
  // the one thing the author can fix in a line: declare the card's touches.
  if (undeclared) {
    reasons.push({ kind: 'touches-undeclared',
      detail: `${commits.length} commit(s) and no declared touches — nothing to check them against; declare the card's touches` });
  }
  for (const o of over) {
    reasons.push({ kind: 'over-touches', sha: o.sha, files: o.files,
      detail: `${o.files.join(', ')} outside declared touches ${touches.join(', ')}` });
  }

  // fidelity: the commits against the plan, in order.
  const replanned = replanFromCommits(commits);
  const diff = planDiff(entries, replanned);
  for (const d of diff) reasons.push({ kind: `plan-${d.kind}`, entry: d.n, detail: describeDiff(d) });

  // A plan entry that already carries a sha must still be that sha. `recommit` replays to
  // the approved plan, so a shifted sha under an unchanged subject and file list is a
  // rewritten commit, which the file comparison above cannot see.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], c = commits[i];
    if (!e.sha || !c || !c.sha) continue;
    if (!String(c.sha).startsWith(e.sha) && !String(e.sha).startsWith(c.sha)) {
      reasons.push({ kind: 'plan-sha', entry: e.n, detail: `entry ${e.n} was ${e.sha}, HEAD has ${c.sha}` });
    }
  }

  // (b) the gate flip.
  const after = planGate(replanned, lower);
  const before = gatedBefore === null || gatedBefore === undefined
    ? planGate(entries, lower).gated : Boolean(gatedBefore);
  // An `unknown` gate (an unreadable or empty re-plan) is NOT a flip. It is already
  // reported as a parse error and as `plan-removed` divergence; counting it as a flip
  // would spend the hard escalation on a page that is merely unreadable, and the two need
  // different fixes — fix the page, versus have a human rule on a new collision.
  const flipped = after.gated && !after.unknown && !before;
  if (flipped) {
    reasons.push({ kind: 'gate-flip', detail: after.reasons.map((r) => `entry ${r.entry} shares ${r.paths.join(', ')} with ${r.with}`).join('; ') });
  }

  const outcome = reasons.length ? 'diverged' : 'matches';
  const mode = (over.length || flipped || undeclared) ? 'hard' : 'banner';
  return { outcome, mode, reasons, diff, replanned, over, undeclared,
    gate: { before, after: after.gated, flipped, reasons: after.reasons } };
}

function describeDiff(d) {
  if (d.kind === 'added') return `commit ${d.n} (${d.subject}) is not in the plan`;
  if (d.kind === 'removed') return `planned commit ${d.n} (${d.subject}) was never made`;
  if (d.kind === 'files') return `commit ${d.n}: planned ${d.from.join(', ')}, made ${d.to.join(', ')}`;
  return `commit ${d.n}: subject changed from "${d.from}" to "${d.to}"`;
}

// ---------------------------------------------------------------- git

// commitsBetween(repoDir, base, head, { upstream }) -> [{ sha, subject, files }] OLDEST FIRST.
//
// `--topo-order` before `--reverse`: the default is reverse-CHRONOLOGICAL, and two commits
// made in the same second (a scripted replay, a rebase that rewrites dates) then come back
// in whichever order the clock happened to record — which reads as a reordered plan on a
// card that did nothing wrong. Topological order puts a parent before its child whatever
// the timestamps say.
//
// `--no-merges`: a merge commit is not one of the card's logical segments.
// `--no-renames`: a rename reports BOTH paths, so a rename OUT of the card's touches is
// seen as the scope escape it is instead of hiding behind one path.
//
// `--not <upstream>` is the one that took an argument to settle. A card that merges the
// base branch to stay current pulls the base branch's own commits into `base..HEAD`, and
// reconcile then reports main's files as this card's — a HARD gate naming a file the card
// never touched. How real that is depends on the base:
//
//   * `effort.branchBase` normally returns a LIVE `merge-base HEAD origin/main`. After the
//     merge, that merge-base IS origin/main's tip, so the merged commits are already out of
//     range and nothing is wrong. Verified in a scratch repo.
//   * branchBase FALLS BACK to the launch pin's sha (no remote, an unfetched clone, a repo
//     whose default branch is not `main`). That base is fixed, the merged commits are in
//     range, and the false hard gate is real. Also verified.
//
// `--first-parent` was proposed as the fix and is REFUSED, with evidence: in a scratch repo
// a card that did its work on a side branch and merged it with `--no-ff` reports ONE commit
// under `--no-merges` and ZERO under `--first-parent`. It converts a visible false gate into
// a silent scope escape — the exact failure this module exists to catch, and the worse of the
// two by the rule this file is built on. `--not <upstream>` is narrower and says what is
// meant: exclude the commits the BASE BRANCH already owns, keep everything this card is
// answerable for, side-branch work included. It is silently skipped when the ref does not
// resolve, because an unfetched clone must still reconcile.
function commitsBetween(repoDir, base, head = 'HEAD', { upstream = 'origin/main' } = {}) {
  const spine = require('./spine');
  const SEP = '\u001e';
  let exclude = [];
  if (upstream) {
    try { spine.git(repoDir, ['rev-parse', '--verify', '--quiet', `${upstream}^{commit}`]); exclude = ['--not', upstream]; } catch { /* no such ref: nothing to exclude */ }
  }
  // %x1e is git's own escape for the record separator byte. Passing a literal NUL in the
  // argv is not an option: node refuses an argument containing one.
  const raw = spine.git(repoDir, ['log', '--topo-order', '--reverse', '--no-merges', '--no-renames',
    '--format=%x1e%H %s', '--name-only', `${base}..${head}`, ...exclude]);
  const out = [];
  for (const chunk of String(raw).split(SEP)) {
    if (!chunk.trim()) continue;
    const [head0, ...rest] = chunk.split('\n');
    const m = head0.match(/^([0-9a-f]{7,40})\s?(.*)$/);
    if (!m) continue;
    out.push({ sha: m[1], subject: m[2].trim(), files: rest.map((s) => s.trim()).filter(Boolean) });
  }
  return out;
}

module.exports = {
  COMMIT_PLAN_ARTIFACT,
  reconcileStep,
  parseCommitPlan,
  inside,
  sharedPaths,
  lowerOpenCards,
  planGate,
  planDiff,
  replanFromCommits,
  reconcile,
  commitsBetween,
};
