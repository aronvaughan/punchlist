'use strict';
// facts — one GitHub collector recording facts as idempotent receipts on every in-flight run that
// names a PR (D-020: watching is a collector, not a cycle, unlike `plt run poll`'s live-arming of
// `arm_on`/`land_on` steps). `prFacts` is pure given an injected `gh`; `recordFacts` is the only
// place that writes — gh receipts (idempotent per {name, head sha}), a `review-activity` event past
// the run's cursor, and a `state.facts` snapshot so renderers never call gh themselves.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const spine = require('./spine');

// Every gh call is bounded. The watch timer will not start a second copy while one is still
// running, so a single hung `gh` (a stalled proxy, a network black hole) stops the timer
// permanently and silently — a timeout turns that into one per-run error the pass reports and
// moves past. PLT_GH_TIMEOUT_MS overrides the 30s default (tests, and a slow network).
const GH_TIMEOUT_MS = 30000;
function ghTimeoutMs() {
  const n = Number(process.env.PLT_GH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : GH_TIMEOUT_MS;
}

function defaultGh(args) {
  const timeout = ghTimeoutMs();
  try {
    return execFileSync(process.env.PLT_GH || 'gh', args, { encoding: 'utf8', timeout });
  } catch (err) {
    // execFileSync reports a timeout by killing the child: `code: 'ETIMEDOUT'`, or a kill signal.
    if (err && (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM')) {
      throw new Error(`gh timed out after ${timeout}ms: ${args.join(' ')}`);
    }
    throw err;
  }
}

// `gh pr view --json statusCheckRollup` mixes two GraphQL shapes: a CheckRun (status/conclusion)
// and a StatusContext (state). Pending covers a CheckRun still running and a StatusContext still
// PENDING/EXPECTED; everything else is pass/fail by its conclusion or state.
function checkTally(rollup) {
  const items = Array.isArray(rollup) ? rollup : [];
  let pass = 0, fail = 0, pending = 0;
  for (const c of items) {
    if (c && c.status !== undefined) {
      if (c.status !== 'COMPLETED') { pending++; continue; }
      if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion)) pass++; else fail++;
    } else {
      const state = c && c.state;
      if (['PENDING', 'EXPECTED'].includes(state)) pending++;
      else if (state === 'SUCCESS') pass++;
      else fail++;
    }
  }
  return { total: items.length, pass, fail, pending };
}

function threadsUnresolvedFrom(resp) {
  const nodes = resp && resp.data && resp.data.repository && resp.data.repository.pullRequest &&
    resp.data.repository.pullRequest.reviewThreads && resp.data.repository.pullRequest.reviewThreads.nodes;
  return Array.isArray(nodes) ? nodes.filter((n) => n && !n.isResolved).length : 0;
}

const THREADS_QUERY = 'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){' +
  'pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}';

// prFacts(gh, repo, number) — one `gh pr view --json ...` plus one `gh api graphql` for unresolved
// review threads (not carried by `pr view`). `gh` is `(args: string[]) => string`; PLT_GH names a
// replacement executable for `defaultGh`.
function prFacts(gh, repo, number) {
  const view = JSON.parse(gh(['pr', 'view', String(number), '--repo', repo, '--json',
    'number,url,state,isDraft,headRefOid,reviewDecision,mergeStateStatus,statusCheckRollup,reviews,comments']));
  const [owner, name] = String(repo).split('/');
  const threads = JSON.parse(gh(['api', 'graphql', '-f', `query=${THREADS_QUERY}`,
    '-F', `owner=${owner}`, '-F', `repo=${name}`, '-F', `number=${number}`]));
  return {
    number: view.number, url: view.url, state: view.state, isDraft: Boolean(view.isDraft),
    headSha: view.headRefOid, reviewDecision: view.reviewDecision || null, mergeStateStatus: view.mergeStateStatus || null,
    checks: checkTally(view.statusCheckRollup), threadsUnresolved: threadsUnresolvedFrom(threads),
    // `commitOid` (from `reviews[].commit.oid`, already part of the `reviews` object `gh pr view`
    // returns — no separate `--json` field exists for it) is what tells an APPROVED review from
    // the current head apart from a stale one branch protection never dismissed.
    reviews: (view.reviews || []).map((r) => ({ id: r.id, author: r.author && r.author.login, state: r.state,
      submittedAt: r.submittedAt, commitOid: r.commit && (r.commit.oid || r.commit) })),
    comments: (view.comments || []).map((c) => ({ id: c.id, author: c.author && c.author.login, createdAt: c.createdAt })),
  };
}

// The names `recordFacts` may record from live data (see also `pr-facts`, handled separately since
// it doesn't depend on any of these fields being true). `approved_on_head` requires not just
// `reviewDecision: APPROVED` but an APPROVED review whose `commitOid` is the CURRENT head — GitHub
// leaves a stale approval on an old commit recorded unless branch protection dismisses it, and a
// receipt keyed only by "APPROVED decision" would otherwise carry that old approval onto a new
// head. `review-posted` matches the PR's reviewer logins against `config.actors.github_logins`
// (real GitHub logins — a person's display name in `actors.humans` is not one and may never match);
// `github_logins` absent or empty falls back to `humans[0]`, which is what may happen to work today
// only when a human's login and display name are spelled the same.
// `review_approved` is the documented alias of `approved_on_head`: it is the name `pr-loop`'s
// external gate waits on. Both are emitted, so a formula spelled either way is satisfied.
function candidateNames(f, cfg) {
  const names = [];
  if (f.checks && f.checks.total > 0 && f.checks.fail === 0 && f.checks.pending === 0) names.push('checks-green');
  if (f.reviewDecision === 'APPROVED' && Array.isArray(f.reviews) &&
      f.reviews.some((r) => r.state === 'APPROVED' && r.commitOid === f.headSha)) names.push('approved_on_head', 'review_approved');
  if (f.threadsUnresolved === 0) names.push('threads_resolved');
  if (f.state === 'MERGED') names.push('merged');
  if (f.state !== 'OPEN') names.push('pr_closed');
  const actors = cfg && cfg.actors;
  const logins = actors && Array.isArray(actors.github_logins) && actors.github_logins.length ? actors.github_logins
    : (actors && Array.isArray(actors.humans) && actors.humans.length ? [actors.humans[0]] : []);
  if (logins.length && Array.isArray(f.reviews) && f.reviews.some((r) => logins.includes(r.author))) names.push('review-posted');
  return names;
}

// Every name `candidateNames` can emit, in its order. The validator's `verify.gh` allowlist reads
// this list instead of keeping its own copy, so the collector and the validator cannot disagree.
// `pr-facts` is not here: `recordFacts` records it on its own path, outside `candidateNames`.
const GH_FACT_NAMES = Object.freeze([
  'checks-green', 'approved_on_head', 'review_approved', 'threads_resolved', 'merged', 'pr_closed', 'review-posted',
]);

// Every non-done step whose compiled `receipts_required` declares a `gh` requirement matching
// `name`, normalised (`-`/`_` as one character): the same live fact (e.g. checks all green) can
// satisfy `open-pr`'s `checks-green` and `merge`'s `checks_green` at once, and each gets its OWN
// receipt spelled the way its own requirement names it — never the fact's canonical spelling. No
// match (this cycle never asks for it, or every step that did is already done) means nothing here.
function stepsFor(state, name) {
  const out = [];
  for (const [id, s] of Object.entries(state.steps)) {
    if (s.status === 'done') continue;
    for (const r of s.receipts_required || []) {
      if (r.kind === 'gh' && spine.normalizeGhName(r.name) === spine.normalizeGhName(name)) out.push({ stepId: id, name: r.name });
    }
  }
  return out;
}

// The step whose banner/gate is "current" for review-activity's `step` field: the in-flight one,
// else the next one waiting on the owner or ready to start, else none (a closed-out run).
function currentPrStep(state) {
  if (state.current_step) return state.current_step;
  const entry = Object.entries(state.steps).find(([, s]) => ['in_review', 'ready'].includes(s.status));
  return entry ? entry[0] : null;
}

// A same-name/step/result:pass receipt already counts as recorded when its ref is this exact head
// (facts's own idempotence key) OR names this PR's number some other way — `plt run poll`'s
// landing sequence (lib/spine.js#landRun) records the SAME gh names (merged, approved_on_head, …)
// with `ref: <PR url>` instead of a head sha, and a poll-landed receipt must count here too or a
// merged run keeps getting a second `merged` receipt from `plt facts` forever.
function alreadyRecorded(events, stepId, name, ref, prNumber) {
  return events.some((e) => {
    if (e.kind !== 'gh' || e.step !== stepId || e.name !== name || e.result !== 'pass') return false;
    if (e.ref === ref) return true;
    if (prNumber == null || typeof e.ref !== 'string') return false;
    const m = e.ref.match(/pull\/(\d+)(?:[^0-9]|$)/);
    return Boolean(m) && Number(m[1]) === Number(prNumber);
  });
}

// recordFacts(processDir, runId, facts) — the only writer. Records every gh fact whose criterion
// holds onto every non-done step declaring it (skipping one already recorded, pass, at this head —
// see `alreadyRecorded`), records `pr-facts` once ever on any step that needs it (not head-scoped:
// it means "we successfully looked this PR up", never re-verified per head), emits at most one
// `review-activity` event for reviews/comments genuinely new since the LAST collect (never on the
// very first one — nothing is "new" the first time a run starts watching a PR), and always
// refreshes the `state.facts` snapshot so renderers never call gh. A refused pin (dirty repo_dir)
// blocks only the gh receipts, which need a real pin to satisfy `gateCheck` later — activity and
// the snapshot do not.
function recordFacts(processDir, runId, facts) {
  const st = spine.readState(processDir, runId);
  const recorded = [], skipped = [];
  if (!st || !st.steps) return { recorded, skipped, activity: 0 };

  // Cursor is a timestamp, not an id (ids aren't comparable across reviews and comments); ties on
  // the exact same second are tracked by id (`cursor_ids`) so a same-second item that only shows up
  // in a LATER collect (a second review posted the same second as one already seen) is not silently
  // dropped by a strict `>`. `hadFacts` is false only on the very first collect for this run ever —
  // that one seeds the cursor at the newest item quietly; nothing existing is "new activity".
  const hadFacts = Boolean(st.facts);
  const oldCursor = (st.facts && st.facts.cursor) || null;
  const oldCursorIds = new Set((st.facts && st.facts.cursor_ids) || []);
  const items = [
    ...(facts.reviews || []).filter((r) => r.submittedAt).map((r) => ({ id: r.id, ts: r.submittedAt })),
    ...(facts.comments || []).filter((c) => c.createdAt).map((c) => ({ id: c.id, ts: c.createdAt })),
  ];
  const fresh = items.filter((x) => !oldCursor || x.ts > oldCursor || (x.ts === oldCursor && !oldCursorIds.has(x.id)));
  let cursor = oldCursor, cursorIds = [...oldCursorIds], activity = 0;
  if (items.length) {
    cursor = items.reduce((m, x) => (!m || x.ts > m ? x.ts : m), oldCursor);
    cursorIds = items.filter((x) => x.ts === cursor).map((x) => x.id);
  }
  if (hadFacts && fresh.length) {
    spine.appendEvent(processDir, runId, { kind: 'review-activity', step: currentPrStep(st),
      count: fresh.length, ids: fresh.map((x) => x.id), actor: 'facts' });
    activity = fresh.length;
  }

  const ref = facts.headSha || null;
  let pin = null;
  try { pin = spine.computePin(st.repo_dir); } catch (err) { pin = null; }
  if (pin && !pin.refused) {
    const cfg = spine.loadConfig(processDir, runId);
    const events = spine.readEvents(processDir, runId);
    const record = (stepId, name, recordRef) => {
      const ev = spine.recordReceipt(processDir, runId, { step: stepId, kind: 'gh', name, result: 'pass', ref: recordRef, pin, actor: 'facts', [spine.FACTS_COLLECTOR]: true });
      events.push(ev);
      recorded.push(name);
    };
    if (ref) {
      for (const canonical of candidateNames(facts, cfg)) {
        for (const { stepId, name } of stepsFor(st, canonical)) {
          if (alreadyRecorded(events, stepId, name, ref, facts.number)) { skipped.push(name); continue; }
          record(stepId, name, ref);
        }
      }
    }
    // `pr-facts` (e.g. review-pr's `intake` step): satisfied once we've successfully fetched this
    // PR at all — idempotent by step+name+pass alone, no ref/head comparison, since it never needs
    // re-verifying as the head moves.
    const prRef = facts.url || (facts.number != null ? `#${facts.number}` : ref);
    for (const { stepId, name } of stepsFor(st, 'pr-facts')) {
      if (events.some((e) => e.kind === 'gh' && e.step === stepId && e.name === name && e.result === 'pass')) { skipped.push(name); continue; }
      record(stepId, name, prRef);
    }
  }

  const st2 = spine.readState(processDir, runId);
  st2.facts = { at: new Date().toISOString(), headSha: facts.headSha || null, state: facts.state || null,
    isDraft: Boolean(facts.isDraft), reviewDecision: facts.reviewDecision || null, mergeStateStatus: facts.mergeStateStatus || null,
    checks: facts.checks || null, threadsUnresolved: facts.threadsUnresolved, cursor, cursor_ids: cursorIds };
  spine.writeState(processDir, runId, st2);

  return { recorded, skipped, activity };
}

// A run's PR number: inputs.pr_number, else a `pull/<n>` match in inputs.pr, else the latest
// receipt ref naming a PR (mirrors how spine.js/landRun find the run's PR).
// The repo a run's PR lives in. `config.links.pr_repo` is the default, not the answer: a process
// can watch several repos (a service repo and a shared-library repo can carry cards of one effort),
// and a run resolved against the wrong repo does not fail — it silently reads a DIFFERENT pull
// request with the same number and records ITS facts (a library run's PR #4 can collect a passing
// `pr_closed` from the service repo's #4). Per-run `inputs.repo` wins, then the owner/name in the
// `pr` URL, then the config default.
function findPrRepo(processDir, runId, cfg) {
  const inputs = spine.readInputs(processDir, runId);
  if (inputs.repo && /^[^/\s]+\/[^/\s]+$/.test(String(inputs.repo))) return String(inputs.repo);
  const m = String(inputs.pr || '').match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/);
  if (m) return m[1];
  return (cfg && cfg.links && cfg.links.pr_repo) || null;
}

function findPrNumber(processDir, runId) {
  const inputs = spine.readInputs(processDir, runId);
  if (inputs.pr_number) return Number(inputs.pr_number);
  if (inputs.pr) {
    const m = String(inputs.pr).match(/pull\/(\d+)/) || String(inputs.pr).match(/^(\d+)$/);
    if (m) return Number(m[1]);
  }
  const ev = spine.readEvents(processDir, runId).filter((e) => e.ref && /pull\/\d+/.test(String(e.ref))).pop();
  return ev ? Number(String(ev.ref).match(/pull\/(\d+)/)[1]) : null;
}

// collect(processDir, {gh, runId}) — every in-flight run naming a PR (or just `runId`, for the
// CLI's --run), fetches its facts and runs them through recordFacts.
//
// A run that fails (404 on a deleted or private PR, an expired token, a hung gh) is RECORDED as
// `{run, pr, error}` and the pass continues. One unreachable PR used to propagate out of here and
// abort `watchOnce` before render AND notify, for every other run — an unattended pass must not be
// hostage to the worst PR in the set. `plt facts`, the explicit verb, still exits non-zero on any
// error; `plt watch` logs and carries on.
function collect(processDir, { gh, runId } = {}) {
  const ghFn = gh || defaultGh;
  const runsDir = path.join(processDir, 'runs');
  if (!fs.existsSync(runsDir)) return [];
  const ids = runId ? [runId] : fs.readdirSync(runsDir);
  const cfg = spine.loadConfig(processDir);
  const out = [];
  for (const id of ids) {
    const st = spine.readState(processDir, id);
    if (!st || !st.steps || st.status === 'closed') continue;
    const pr = findPrNumber(processDir, id);
    if (!pr) continue;
    const repo = findPrRepo(processDir, id, cfg);
    if (!repo) throw new Error(`run ${id}: no repo — set \`repo\` in its inputs, a full PR URL in \`pr\`, or config.links.pr_repo`);
    try {
      const pfacts = prFacts(ghFn, repo, pr);
      // The PR the facts came from, so a receipt can never be traced to the wrong repo.
      if (pfacts.url && !String(pfacts.url).includes(`/${repo}/`)) throw new Error(`run ${id}: ${repo}#${pr} resolved to ${pfacts.url}`);
      const { recorded, skipped, activity } = recordFacts(processDir, id, pfacts);
      out.push({ run: id, pr, repo, recorded, skipped, activity });
    } catch (err) {
      out.push({ run: id, pr, repo, error: err && err.message ? err.message : String(err) });
    }
  }
  return out;
}

module.exports = { GH_FACT_NAMES, candidateNames, defaultGh, prFacts, findPrRepo, checkTally, threadsUnresolvedFrom, THREADS_QUERY, recordFacts, collect, findPrNumber };
