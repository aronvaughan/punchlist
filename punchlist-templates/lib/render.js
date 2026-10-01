'use strict';
// render — the effort index and the per-run status pages, rendered from state alone: efforts/*.yaml,
// runs/*/{state.yaml,inputs.yaml,events.jsonl,HANDOFF.md} and the `state.facts` snapshot `plt facts`
// keeps. Nothing here shells out to gh; a run whose facts were never collected says so in words.
//
// Pages are deterministic for a given state (the eyebrow stamps the newest event, not the clock),
// so `writeBuild` + `publishManifest` can tell a changed page from an unchanged one by sha alone.
// Output goes to `<processDir>/build/{index.html,run-<id>.html}` and the manifest to
// `<processDir>/build/publish.json`; ignore `process/build/*` except `publish.json` in the
// project's .gitignore — the pages are derived, the manifest carries the published urls.
//
// Every project literal comes from config.links:
//   card       — url template for a card run, `{card}` substituted (`https://tracker.example/{card}`)
//   pr_repo    — `owner/name` for PR urls built from a bare number
//   repo_blob  — optional url template for an effort's relative links, `{path}` substituted
//   board      — optional url of the curated narrative board, named in the index footer
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const spine = require('./spine');
const effort = require('./effort');
const yaml = require('./yaml');
const readYaml = (f) => { try { return yaml.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const isUrl = (v) => /^https?:/.test(String(v || ''));
const short = (v) => String(v || '').slice(0, 10);
const stamp = (ts, from = 0) => (ts ? String(ts).slice(from, 16).replace('T', ' ') : '');

const CSS_TOKENS = `:root{--paper:#f2f3ef;--surface:#fff;--surface-2:#e9ebe5;--rule:#c9cdc4;--rule-soft:#dfe2db;--ink:#1b2027;--ink-2:#4a525c;--ink-3:#7a828c;--cycle:#2f5d8a;--cycle-soft:#e3ecf4;--gate:#c4571a;--gate-soft:#f8e6da;--ok:#2e7d4f;--ok-soft:#dff0e4;--warn:#9a6a08;--warn-soft:#f6ecd0;--bad:#b3372c;--bad-soft:#fbe8e6;--disp:"Archivo",-apple-system,BlinkMacSystemFont,sans-serif;--body:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#15181c;--surface:#1c2025;--surface-2:#242930;--rule:#3a414a;--rule-soft:#2c323a;--ink:#e6e8e3;--ink-2:#b2b8bf;--ink-3:#7f878f;--cycle:#7fb0dc;--cycle-soft:#1d2d3d;--gate:#e58a55;--gate-soft:#3a2418;--ok:#6fc48f;--ok-soft:#173224;--warn:#dcb45a;--warn-soft:#33290f;--bad:#f0796c;--bad-soft:#331714}}
:root[data-theme="dark"]{--paper:#15181c;--surface:#1c2025;--surface-2:#242930;--rule:#3a414a;--rule-soft:#2c323a;--ink:#e6e8e3;--ink-2:#b2b8bf;--ink-3:#7f878f;--cycle:#7fb0dc;--cycle-soft:#1d2d3d;--gate:#e58a55;--gate-soft:#3a2418;--ok:#6fc48f;--ok-soft:#173224;--warn:#dcb45a;--warn-soft:#33290f;--bad:#f0796c;--bad-soft:#331714}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--body);font-size:15px;line-height:1.55}`;

// ---- links from config ----
function links(cfg) {
  const l = (cfg && cfg.links) || {};
  return {
    card: (id) => (l.card ? String(l.card).replace('{card}', encodeURIComponent(id)) : null),
    pr: (num) => (l.pr_repo ? `https://github.com/${l.pr_repo}/pull/${num}` : null),
    prRepo: l.pr_repo || null,
    blob: (p) => (l.repo_blob ? String(l.repo_blob).replace('{path}', p) : null),
    board: l.board || null,
  };
}
const cardAnchor = (L, id) => { const u = L.card(id); return u ? `<a href="${esc(u)}">${esc(id)}</a>` : esc(id); };
const firstHuman = (cfg) => (cfg && cfg.actors && Array.isArray(cfg.actors.humans) && cfg.actors.humans[0]) || '<you>';

// ---- shared per-run reading ----
const runIds = spine.runIds;   // one definition, in lib/spine.js beside readState/readEvents
function currentStep(st) {
  const order = Object.keys(st.steps || {});
  // A blocked step wins: its question is what a person must see, even while another step is current.
  return spine.blockedStep(st) || st.current_step || order.find((s) => ['in_review', 'ready', 'in_progress', 'blocked'].includes(st.steps[s].status)) || null;
}
// The repo a run's PR lives in: `inputs.repo`, else the owner/name inside `inputs.pr`, else the
// config default. A process can watch several repos, so `config.links.pr_repo` is a fallback and
// never the answer when the run says which repo it is about (the same rule as facts.findPrRepo).
function repoOf(inputs, L) {
  if (inputs.repo && /^[^/\s]+\/[^/\s]+$/.test(String(inputs.repo))) return String(inputs.repo);
  const m = String(inputs.pr || '').match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/);
  return m ? m[1] : (L.prRepo || null);
}

// The PR a run names: the latest receipt whose ref is a PR url wins (it carries the url itself),
// UNLESS that url is from a different repo than the run declares — a receipt collected against the
// wrong repo is exactly the poison `facts.collect` used to write when one config default served
// every run (a run on repo B collecting repo A's PR of the same number), and the board must not
// repeat it. Else `inputs.pr` as a url or a bare number, built against the run's own repo.
function prOf(events, inputs, L) {
  const repo = repoOf(inputs, L);
  const ours = (ref) => !repo || !isUrl(ref) || String(ref).includes(`/${repo}/pull/`);
  const build = (num) => (repo ? `https://github.com/${repo}/pull/${num}` : L.pr(num));
  const ev = events.filter((e) => e.ref && /pull\/\d+/.test(String(e.ref)) && ours(e.ref)).pop();
  if (ev) { const ref = String(ev.ref); const m = ref.match(/pull\/(\d+)/); return { number: Number(m[1]), url: isUrl(ref) ? ref.replace(/(pull\/\d+).*$/, '$1') : build(m[1]) }; }
  if (inputs.pr) {
    const s = String(inputs.pr);
    const m = s.match(/pull\/(\d+)/) || s.match(/^(\d+)$/);
    if (m) return { number: Number(m[1]), url: isUrl(s) ? s : build(m[1]) };
  }
  if (inputs.pr_number) return { number: Number(inputs.pr_number), url: build(inputs.pr_number) };
  return null;
}
// The facts a page shows, all from state: the `plt facts` snapshot first; else the last `plt run poll`
// snapshot (state.poll.facts — same GitHub fields under gh's names, no check tally); else, for a run
// whose merge step landed (a passing `merged` receipt), MERGED and nothing more. Null means never
// collected, and the page says so.
function factsOf(st, events) {
  if (st.facts) return st.facts;
  const p = st.poll && st.poll.facts;
  if (p && (p.state || p.mergeStateStatus || p.reviewDecision)) {
    return { at: st.poll.at || null, headSha: p.headRefOid || null, state: p.state || null, isDraft: Boolean(p.isDraft),
      reviewDecision: p.reviewDecision || null, mergeStateStatus: p.mergeStateStatus || null, checks: null, threadsUnresolved: null, source: 'poll' };
  }
  if (events.some((e) => e.kind === 'gh' && e.name === 'merged' && e.result === 'pass')) {
    return { at: null, headSha: null, state: 'MERGED', isDraft: false, reviewDecision: null, mergeStateStatus: null, checks: null, threadsUnresolved: null, source: 'receipt' };
  }
  return null;
}
const latestArtifacts = (events) => {
  const out = {};
  for (const e of events) if (e.kind === 'artifact' && e.ref && isUrl(e.ref)) out[e.name] = e.ref;
  return out;
};

function loadRun(processDir, id, cfg, L) {
  const st = spine.readState(processDir, id);
  const inputs = spine.readInputs(processDir, id);
  const events = spine.readEvents(processDir, id);
  const order = Object.keys(st.steps || {});
  const cur = currentStep(st);
  // A run closed through the discard exit reads `discarded` — a dropped card, not a finished one.
  const status = st.status === 'closed' ? (st.closed_as === 'discarded' ? 'discarded' : 'closed')
    : st.exit ? (cur ? st.steps[cur].status : 'pending')
      : cur ? st.steps[cur].status : (order.every((s) => st.steps[s].status === 'done') ? 'done' : 'pending');
  // A ready step whose requirements carry a human gate is the owner's to start — waiting on a person too.
  // A loop step (`repeat_until`) between rounds has nothing to approve until the next one arrives:
  // it waits, not "needs you". spine.betweenRounds is the one predicate nextCommand and the menu use too.
  const betweenRounds = status === 'ready' && Boolean(cur) && spine.betweenRounds(st, events, cur);
  const ownerReady = !betweenRounds && status === 'ready' && cur && (st.steps[cur].receipts_required || []).some((r) => r.kind === 'gate');
  // Waiting on others: nothing is ready or in flight, the run is not complete, and what remains is armed
  // by live facts (`arm_on`) — the author's reply, a moved head, the PR landing. Not anyone's step here.
  let formula = null;
  try { formula = st.cycle ? spine.loadFormula(processDir, st.cycle) : null; } catch (e) { formula = null; }
  const armed = formula ? formula.steps.filter((d) => d.arm_on && st.steps[d.id] && st.steps[d.id].status === 'pending') : [];
  const curDef = formula && cur ? formula.steps.find((d) => d.id === cur) : null;
  const waiting = betweenRounds ? [(curDef && curDef.waiting) || `the next ${cur}`]
    : !cur && status === 'pending' && armed.length ? armed.map((d) => d.waiting || d.id) : null;
  // Poll-derived facts (state.poll.facts, from `plt run poll`): our approval on a PR we reviewed is a fact
  // GitHub can withdraw, never a status — a waiting run whose approval stands gets its own lane, and a
  // dismissed approval is named on the row so the re-arming of re-review reads as what it is.
  const live = (st.poll && st.poll.facts) || {};
  const approved = Boolean(waiting && live.ourApprovalStanding);
  const dismissed = Boolean(live.ourApprovalDismissed && st.cycle === 'review-pr' && !['closed', 'discarded'].includes(status));
  // NEW ACTIVITY on a review we have already posted. `reviewFacts` derives these on every poll;
  // until now they only fed the `waiting` phrasing, so a reply or a push looked the same as silence
  // on the board. They are the one thing on a review row the owner must actually see.
  const posted = Boolean(events.find((e) => e.kind === 'gh' && e.name === 'review-posted'));
  const activity = (posted && !['closed', 'discarded'].includes(status)) ? [
    live.authorRepliedSinceOurReview ? 'replied' : null,
    live.headMovedSinceOurReview ? 'pushed' : null,
    live.ourApprovalDismissed ? 'approval dismissed' : null,
    live.prClosed ? 'PR closed' : null,
  ].filter(Boolean) : [];
  const lane = status === 'in_review' || status === 'blocked' || ownerReady ? 'human'
    : status === 'done' || status === 'closed' || status === 'discarded' ? 'done'
      : status === 'in_progress' ? 'flight' : approved ? 'approved' : waiting ? 'waiting' : 'ready';
  const me = firstHuman(cfg);
  const discardEv = events.find((e) => e.what === 'discarded') || {};
  const next = betweenRounds ? `nothing for you — waiting on ${waiting.join(', or ')}`
    : status === 'in_review' ? `plt gate approve ${id} ${cur} --by human:${me}`
    : status === 'in_progress' ? `plt step finish ${cur} --run ${id} --outcome <outcome>`
      : status === 'ready' ? (ownerReady ? `plt gate approve ${id} ${cur} --by human:${me}  (review the page first)` : `plt step start ${cur} --run ${id}`)
        : status === 'blocked' ? `answer the question on ${cur}${spine.openQuestion(events, cur) ? `: ${spine.openQuestion(events, cur)}` : ''}`
          : status === 'closed' ? 'closed'
            : status === 'discarded' ? `discarded — ${discardEv.reason || 'no reason recorded'}${discardEv.replaced_by ? ' · replaced by ' + discardEv.replaced_by : ''}`
              : approved ? `Approved by us on ${String(live.ourApprovalSha || '').slice(0, 7) || '?'}${live.ourApprovalOnHead === false ? ' (head has moved)' : ''} · waiting on the author to merge`
                : waiting ? `nothing for you — waiting on ${waiting.join(', or ')}` : 'run complete';
  const rr = st.steps['re-review'];
  const dismissedNote = dismissed ? `approval dismissed by a new push — ${rr && rr.status === 'ready' ? 're-review armed' : rr && rr.status === 'in_progress' ? 're-review in progress' : 'waiting on the poll to arm re-review'}` : null;
  const done = order.filter((s) => ['done', 'skipped'].includes(st.steps[s].status)).length;
  const pr = prOf(events, inputs, L);
  const facts = factsOf(st, events);
  const artifacts = latestArtifacts(events);
  const ourReview = events.filter((e) => e.kind === 'gh' && e.name === 'review-posted' && e.result === 'pass').pop();
  return { id, st, inputs, events, cur, status, lane, activity, pollAt: (st.poll && st.poll.at) || null, next, done, total: order.length, last: events[events.length - 1], pr, facts, artifacts, ourReview, waiting, approved, dismissedNote,
    gates: events.filter((e) => e.kind === 'gate').length, reprompts: events.filter((e) => e.kind === 'reprompt').length,
    extrapolations: events.filter((e) => e.kind === 'extrapolation' && e.missing && e.missing.scope !== 'none').length,
    outOfBand: events.filter((e) => e.out_of_band === true).length };
}

// ---- the effort index ----
const laneOrder = ['human', 'flight', 'ready', 'waiting', 'approved', 'done'];
const pill = (lane) => ({ human: 'human', flight: 'wip', ready: 'ready', waiting: 'wait', approved: 'ok', done: 'ok' })[lane];
const PAGE_LINKS = [['dispatch-brief', 'brief'], ['pre-pr-summary', 'pre-PR'], ['review-outbound', 'review'], ['fix-summary', 'fix'], ['review-response', 'replies']];

function renderIndex(processDir, cfg) {
  cfg = cfg || spine.loadConfig(processDir);
  const L = links(cfg);
  const effortsDir = path.join(processDir, 'efforts');
  const efforts = fs.existsSync(effortsDir) ? fs.readdirSync(effortsDir).filter((f) => f.endsWith('.yaml')).sort()
    .map((f) => readYaml(path.join(effortsDir, f))).filter(Boolean) : [];
  const ids = runIds(processDir);
  const runs = Object.fromEntries(ids.map((id) => [id, loadRun(processDir, id, cfg, L)]));
  const runPage = (r) => r.artifacts['run-' + r.id] || null;
  const runLink = (r) => (isUrl(r.inputs.pr) ? String(r.inputs.pr) : L.card(r.id));
  const prCell = (r) => {
    if (!r.pr) return '—';
    const f = r.facts;
    const head = r.pr.url ? `<a href="${esc(r.pr.url)}">#${r.pr.number}</a>` : `#${r.pr.number}`;
    const state = f ? esc(f.state === 'MERGED' ? 'MERGED' : (f.reviewDecision || f.state || '')) : 'not collected yet';
    const conflict = f && f.mergeStateStatus === 'DIRTY' ? ' <span class="pill bad">🔀 conflict</span>' : '';
    // Only link it when the receipt carries a url. A `review-posted` receipt whose ref is a bare
    // sha would otherwise render as a relative href and 404 on the board.
    const ours = r.ourReview ? (isUrl(r.ourReview.ref)
      ? ` · <a href="${esc(r.ourReview.ref)}">our review posted</a>`
      : ' · <span class="muted">our review posted</span>') : '';
    const act = (r.activity && r.activity.length)
      ? ` <span class="pill act">⚡ ${esc(r.activity.join(' · '))}</span>` : '';
    return `${head} ${state}${conflict}${act}${ours}`;
  };
  const runRow = (r) => `<tr class="${r.lane === 'done' ? 'done' : ''}"><td>${runLink(r) ? `<a href="${esc(runLink(r))}">${esc(r.id)}</a>` : esc(r.id)}<br><span class="muted">${esc(r.inputs.title || '')}</span></td>
<td>${runPage(r) ? `<a href="${esc(runPage(r))}">status page</a>` : '<span class="muted">not published</span>'}</td>
<td><span class="pill ${pill(r.lane)}">${esc(r.approved ? 'approved' : r.waiting ? 'waiting' : r.status)}</span> · ${esc(r.approved ? 'by us · author to merge' : r.waiting ? 'on others' : (r.st.exit && r.status !== 'discarded' ? `${r.st.exit}:${r.cur || '—'}` : (r.cur || '—')))}${r.dismissedNote ? `<br><span class="pill bad">dismissed</span> <span class="muted">${esc(r.dismissedNote)}</span>` : ''}</td><td class="num">${r.done}/${r.total}</td>
<td>${prCell(r)}</td>
<td class="mono">${esc(r.next)}</td>
<td>${PAGE_LINKS.filter(([k]) => r.artifacts[k]).map(([k, label]) => `<a href="${esc(r.artifacts[k])}">${label}</a>`).join(' · ') || '—'}</td>
<td class="num">${r.gates}g · ${r.reprompts}r · ${r.extrapolations}x${r.outOfBand ? ` · ${r.outOfBand}o` : ''}</td>
<td class="mono">${r.last ? esc(stamp(r.last.ts, 5)) : ''}</td></tr>`;

  const waveLine = (slug) => {
    let w; try { w = effort.planWave(processDir, slug); } catch (e) { w = null; }
    if (!w) return '<p class="muted"><b>Wave:</b> overlap: n/a</p>';
    return `<p class="muted"><b>Wave:</b> ${w.wave.length ? w.wave.map((c) => cardAnchor(L, c.id)).join(' ') : 'none'}${w.excluded.length ? ` · excluded: ${w.excluded.map((x) => `${esc(x.card)} (${esc(x.why)})`).join(' · ')}` : ''}${w.running.length ? ` · running: ${w.running.map(esc).join(' ')}` : ''}</p>`;
  };
  const effortLink = (k, v) => {
    const u = isUrl(v) ? String(v) : L.blob(String(v));
    return u ? `<a href="${esc(u)}">${esc(k)}</a>` : `${esc(k)}: <code>${esc(v)}</code>`;
  };
  const effortBlock = (e) => {
    const cardIds = (e.cards || []).map((c) => (typeof c === 'string' ? c : c.id));
    // A dropped card stays on the board with its run: `dropped:` entries are ids or { id, reason, replaced_by }.
    const droppedIds = (e.dropped || []).map((d) => (typeof d === 'string' ? d : d && d.id)).filter(Boolean);
    const its = [...cardIds, ...droppedIds.filter((d) => !cardIds.includes(d))].map((c) => runs[c]).filter(Boolean);
    const unlaunched = cardIds.filter((c) => !runs[c]);
    const open = (e.decisions || []).filter((d) => d.status !== 'settled');
    return `<h2>${esc(e.title || e.slug)} <span class="muted">· ${e.epic && e.epic !== 'none' ? `${cardAnchor(L, e.epic)} · ` : ''}${its.length} run${its.length === 1 ? '' : 's'} · ${unlaunched.length} card${unlaunched.length === 1 ? '' : 's'} not launched</span></h2>
${(() => {
  // Live runs stay open; finished ones (the `done` lane — closed, merged, discarded) fold into a
  // collapsed block, so the page opens on what is still moving. Nothing is hidden: the count and the
  // per-status tally are in the summary, and one click shows the rows.
  const sorted = its.sort((a, b) => laneOrder.indexOf(a.lane) - laneOrder.indexOf(b.lane));
  const live = sorted.filter((r) => r.lane !== 'done'), finished = sorted.filter((r) => r.lane === 'done');
  const table = (rows) => `<div class="tw"><table><tr><th>Run</th><th>Run status</th><th>Step</th><th>Done</th><th>PR</th><th>Next</th><th>Pages</th><th>gates·re-prompts·extrap.</th><th>Last</th></tr>${rows.map(runRow).join('')}</table></div>`;
  const tally = (rows) => { const t = {}; for (const r of rows) t[r.status] = (t[r.status] || 0) + 1; return Object.entries(t).map(([k, v]) => `${v} ${k}`).join(' · '); };
  return (live.length ? table(live) : '')
    + (finished.length ? `<details class="doneblock"><summary>${finished.length} finished — ${esc(tally(finished))}</summary>${table(finished)}</details>` : '');
})()}
${waveLine(e.slug)}
${unlaunched.length ? `<p class="muted">Not launched: ${unlaunched.map((c) => cardAnchor(L, c)).join(' · ')}</p>` : ''}
${open.length ? `<p class="muted"><b>Decisions open:</b> ${open.map((d) => `${esc(d.id)} — ${esc(d.question)}${d.status === 'recorded-wrong' ? ' <span class="pill bad">recorded wrong</span>' : ''}`).join('<br>')}</p>` : ''}
${e.links ? `<p class="muted">${Object.entries(e.links).map(([k, v]) => effortLink(k, v)).join(' · ')}</p>` : ''}`;
  };
  const all = Object.values(runs);
  const human = all.filter((r) => r.lane === 'human');
  const newest = all.map((r) => r.last && r.last.ts).filter(Boolean).sort().pop();
  const org = cfg.org ? String(cfg.org).charAt(0).toUpperCase() + String(cfg.org).slice(1) + ' ' : '';
  const title = `${org}Effort Index`;
  return `<title>${esc(title)}</title>
<style>
${CSS_TOKENS}
.wrap{max-width:1080px;margin:0 auto;padding-block:36px 80px;padding-inline:20px}a{color:var(--cycle)}
.eyebrow{font-family:var(--mono);font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);margin:0 0 8px}
h1{font-family:var(--disp);font-size:30px;font-weight:700;margin:0 0 6px;letter-spacing:-.015em}h2{font-family:var(--disp);font-size:18px;font-weight:600;margin:34px 0 10px;padding-top:12px;border-top:1px solid var(--rule)}
.muted{color:var(--ink-2);font-size:13px}
.human{margin:18px 0;padding:14px 16px;border-radius:8px;background:var(--gate-soft);border-left:4px solid var(--gate);font-size:14.5px}.human code{font-family:var(--mono);font-size:13px}
.calm{margin:18px 0;padding:14px 16px;border-radius:8px;background:var(--ok-soft);border-left:4px solid var(--ok);font-size:14.5px}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13.5px}tr.done td{opacity:.45}tr.done td a{color:var(--ink-2)}tr.done:hover td{opacity:.9}th{text-align:left;font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);padding:8px 10px;border-bottom:1px solid var(--rule);background:var(--surface-2)}td{padding:8px 10px;border-bottom:1px solid var(--rule-soft);vertical-align:top}td.num,.mono{font-family:var(--mono);font-size:12.5px;font-variant-numeric:tabular-nums}
.pill{display:inline-block;font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:4px}.ok{background:var(--ok-soft);color:var(--ok)}.human{background:var(--gate-soft);color:var(--gate)}.wip{background:var(--cycle-soft);color:var(--cycle)}.ready{background:var(--warn-soft);color:var(--warn)}.wait{background:var(--surface-2);color:var(--ink-3)}.bad{background:var(--bad-soft);color:var(--bad)}.act{background:var(--gate-soft);color:var(--gate);font-weight:700}
.pill.human{margin:0;padding:2px 7px;border:0;font-size:10px}
details.doneblock{margin-top:10px}details.doneblock>summary{cursor:pointer;font-family:var(--mono);font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-3);padding:7px 10px;background:var(--surface-2);border:1px solid var(--rule);border-radius:7px;list-style:none}details.doneblock>summary::-webkit-details-marker{display:none}details.doneblock>summary::before{content:"\u25b8 ";color:var(--ink-3)}details.doneblock[open]>summary::before{content:"\u25be "}details.doneblock>summary:hover{color:var(--ink-2);border-color:var(--ink-3)}details.doneblock[open]>summary{border-bottom-left-radius:0;border-bottom-right-radius:0}details.doneblock .tw{border-top:0}details.doneblock tr.done td{opacity:.6}
.foot{margin-top:36px;padding-top:12px;border-top:1px solid var(--rule);font-size:12.5px;color:var(--ink-3)}
</style>
<div class="wrap">
<p class="eyebrow">Effort index · process spine · ${efforts.length} efforts · ${ids.length} runs · state as of ${newest ? esc(stamp(newest)) + 'Z' : 'no events'}</p>
<h1>${esc(title)}</h1>
${human.length ? `<div class="human"><b>Needs you (${human.length}):</b> ${human.map((r) => `${runPage(r) ? `<a href="${esc(runPage(r))}">${esc(r.id)}</a>` : esc(r.id)} — <code>${esc(r.next)}</code>`).join('<br>')}</div>` : `<div class="calm"><b>Nothing waiting on you.</b> ${all.filter((r) => r.lane === 'flight').map((r) => `${esc(r.id)} is at ${esc(r.cur)}`).join(' · ') || 'No runs in flight.'}</div>`}
${efforts.map(effortBlock).join('')}
<p class="foot">Rendered by <code>plt render index</code> from <code>process/efforts/*.yaml</code>, <code>process/runs/*/state.yaml</code>, <code>events.jsonl</code> and the facts snapshot <code>plt facts</code> keeps on each run. Counters: g = human gate events, r = re-prompts recorded, x = extrapolations, o = receipts recorded out of band.${L.board ? ` The curated <a href="${esc(L.board)}">board</a> remains the narrative.` : ''}</p>
</div>
`;
}

// ---- the run page ----
function overlapCell(processDir, runId, st) {
  if (st.status === 'closed') return 'n/a (closed)';
  try {
    const pin = st.repo_dir && fs.existsSync(st.repo_dir) ? spine.computePin(st.repo_dir) : null;
    const oc = effort.overlapCheck(processDir, runId, pin && !pin.refused ? { pin } : {});
    const parts = oc.shared.length ? oc.shared.map((s) => `${s.files.length} file${s.files.length === 1 ? '' : 's'} shared with ${s.run}`) : ['clear'];
    if (!oc.baseFresh) parts.push('base stale');
    return parts.join(' · ');
  } catch (e) { return 'n/a'; }
}

function renderRun(processDir, runId, cfg) {
  cfg = cfg || spine.loadConfig(processDir, runId);
  const L = links(cfg);
  const st = spine.readState(processDir, runId);
  if (!st) throw new Error(`no run ${runId} under ${processDir}/runs`);
  const inputs = spine.readInputs(processDir, runId);
  const events = spine.readEvents(processDir, runId);
  const handoffFile = path.join(processDir, 'runs', runId, 'HANDOFF.md');
  const handoff = fs.existsSync(handoffFile) ? fs.readFileSync(handoffFile, 'utf8') : '';
  const pr = prOf(events, inputs, L);
  const f = factsOf(st, events);
  const overlap = overlapCell(processDir, runId, st);
  const stepOrder = Object.keys(st.steps || {});
  const cur = currentStep(st);
  const me = firstHuman(cfg);
  const ownerReady = cur && st.steps[cur].status === 'ready' && (st.steps[cur].receipts_required || []).some((r) => r.kind === 'gate');
  const nextCmd = (() => {
    if (st.status === 'closed') return `closed ${stamp(st.closed)}`;
    if (cur && st.steps[cur].status === 'blocked') return `plt answer ${runId} ${cur} --text <answer> --by human:${me}  — ${spine.openQuestion(events, cur) || 'the question'}`;
    if (cur && st.steps[cur].status === 'in_review') return `plt gate approve ${runId} ${cur} --by human:${me}`;
    if (cur && st.steps[cur].status === 'in_progress') return `plt step finish ${cur} --run ${runId} --outcome <outcome>`;
    if (cur && spine.betweenRounds(st, events, cur)) return `nothing for you — waiting on the next ${cur}`;
    if (cur && st.steps[cur].status === 'ready') return ownerReady ? `plt gate approve ${runId} ${cur} --by human:${me}  (review the page first)` : `plt step start ${cur} --run ${runId}`;
    return stepOrder.every((s) => st.steps[s].status === 'done') ? 'run complete' : '—';
  })();
  const humanNeeded = Boolean(cur && (st.steps[cur].status === 'in_review' || ownerReady));
  const gates = events.filter((e) => e.kind === 'gate');
  const adversarial = events.filter((e) => e.kind === 'agent');
  const extrapolations = events.filter((e) => e.kind === 'extrapolation' && e.missing && e.missing.scope !== 'none');
  const reprompts = events.filter((e) => e.kind === 'reprompt');
  const outOfBand = events.filter((e) => e.out_of_band === true).length;
  const lastEvent = events[events.length - 1];
  const artifactList = (name) => { const seen = new Set(); return events.filter((e) => e.kind === 'artifact' && e.name === name && e.ref && isUrl(e.ref)).filter((e) => !seen.has(e.ref) && seen.add(e.ref)); };
  const latest = (name) => artifactList(name).pop();
  const rounds = (name, label) => { const u = artifactList(name); return u.length ? u.map((e, i) => `<a href="${esc(e.ref)}">${label} ${i + 1}</a> · ${esc(stamp(e.ts, 5))}`).join(' · ') : 'none'; };
  const stepRow = (id) => {
    const s = st.steps[id]; const reqs = s.receipts_required || [];
    // A receipt recorded out of band is shown apart, never as seen: the spine did not collect it.
    const seen = reqs.filter((r) => events.some((e) => e.step === id && e.kind === r.kind && e.name === r.name && !e.out_of_band)).length;
    const oob = events.filter((e) => e.step === id && e.out_of_band === true).length;
    const cls = s.status === 'done' ? 'ok' : s.status === 'in_review' ? 'human' : s.status === 'in_progress' ? 'wip' : s.status === 'blocked' ? 'bad' : 'mute';
    return `<tr class="${id === cur ? 'cur' : ''}"><td>${esc(id)}</td><td><span class="pill ${cls}">${esc(s.status)}</span></td><td class="num">${seen}/${reqs.length}${oob ? ` (+${oob} out of band)` : ''}</td><td>${esc(s.outcome || '')}</td><td class="mono">${esc(stamp(s.started))}</td><td class="mono">${esc(stamp(s.finished))}</td></tr>`;
  };
  const NOT_YET = 'not collected yet';
  const prHead = pr ? (pr.url ? `<a href="${esc(pr.url)}">#${pr.number}</a>` : `#${pr.number}`) : null;
  const prCell = !pr ? 'not yet opened' : !f ? `${prHead} · ${NOT_YET}` : `${prHead} · ${esc(f.state || '?')}${f.isDraft ? ' (draft)' : ''} · ${esc(f.reviewDecision || 'no decision')}`;
  const checksCell = !pr ? '—' : !f ? NOT_YET : f.checks ? `${f.checks.pass} ok · ${f.checks.fail} failing · ${f.checks.pending} pending of ${f.checks.total}` : NOT_YET;
  const mergeCell = !pr ? '—' : !f ? NOT_YET
    : `${f.mergeStateStatus === 'DIRTY' ? '<span class="pill bad">🔀 CONFLICT</span> main moved under the PR — the resync step merges it back' : f.mergeStateStatus ? esc(f.mergeStateStatus) : '—'}${f.headSha ? ` · head ${esc(short(f.headSha))}` : ''}${f.threadsUnresolved ? ` · ${f.threadsUnresolved} thread${f.threadsUnresolved === 1 ? '' : 's'} unresolved` : ''}`;
  const cardLink = isUrl(inputs.pr) ? String(inputs.pr) : L.card(runId);
  const factsAt = f && f.at ? ` · facts as of ${esc(stamp(f.at))}Z${f.source === 'poll' ? ' (poll)' : ''}` : '';
  return `<title>${esc(runId)} Run Status</title>
<style>
${CSS_TOKENS}
.wrap{max-width:960px;margin:0 auto;padding-block:36px 80px;padding-inline:20px}a{color:var(--cycle)}
.eyebrow{font-family:var(--mono);font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);margin:0 0 8px}
h1{font-family:var(--disp);font-size:30px;font-weight:700;margin:0 0 6px;letter-spacing:-.015em}h2{font-family:var(--disp);font-size:18px;font-weight:600;margin:36px 0 10px;padding-top:12px;border-top:1px solid var(--rule)}
.next{margin:18px 0;padding:14px 16px;border-radius:8px;background:${humanNeeded ? 'var(--gate-soft)' : 'var(--cycle-soft)'};border-left:4px solid ${humanNeeded ? 'var(--gate)' : 'var(--cycle)'};font-size:14.5px}.next code{font-family:var(--mono);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);border-radius:8px;overflow:hidden;margin:16px 0}
.grid div{background:var(--surface);padding:11px 13px}.grid dt{font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);margin:0 0 3px}.grid dd{margin:0;font-size:14px;word-break:break-word}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13.5px}th{text-align:left;font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);padding:8px 10px;border-bottom:1px solid var(--rule);background:var(--surface-2)}td{padding:8px 10px;border-bottom:1px solid var(--rule-soft);vertical-align:top}tr.cur td{background:var(--surface)}td.num,.mono{font-family:var(--mono);font-size:12.5px;font-variant-numeric:tabular-nums}
.pill{display:inline-block;font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:4px}.ok{background:var(--ok-soft);color:var(--ok)}.human{background:var(--gate-soft);color:var(--gate)}.wip{background:var(--cycle-soft);color:var(--cycle)}.bad{background:var(--bad-soft);color:var(--bad)}.mute{background:var(--surface-2);color:var(--ink-2)}.warn{background:var(--warn-soft);color:var(--warn)}
pre{font-family:var(--mono);font-size:12.5px;background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:12px 14px;overflow-x:auto;white-space:pre-wrap}
.foot{margin-top:36px;padding-top:12px;border-top:1px solid var(--rule);font-size:12.5px;color:var(--ink-3)}
</style>
<div class="wrap">
<p class="eyebrow">Run status · ${esc(st.cycle)} v${esc(st.formula_version)} · effort ${esc(inputs.effort || '')} · state as of ${lastEvent ? esc(stamp(lastEvent.ts)) + 'Z' : 'no events'}${factsAt}</p>
<h1>${esc(runId)} — ${esc(inputs.title || '')}</h1>
<div class="next"><b>${humanNeeded ? 'Needs you' : 'Next'}:</b> <code>${esc(nextCmd)}</code>${cur ? ` · step <b>${esc(cur)}</b> is <b>${esc(st.steps[cur].status)}</b>` : ''}</div>
<dl class="grid">
<div><dt>Card</dt><dd>${cardLink ? `<a href="${esc(cardLink)}">${esc(runId)}</a>` : esc(runId)} · owner ${esc(st.owner)}</dd></div>
<div><dt>Pull request</dt><dd>${prCell}</dd></div>
<div><dt>Checks</dt><dd>${checksCell}</dd></div>
<div><dt>Merge state</dt><dd>${mergeCell}</dd></div>
<div><dt>Dispatch brief</dt><dd>${(() => { const a = latest('dispatch-brief'); return a ? `<a href="${esc(a.ref)}">dispatch brief</a> · scope` : 'not yet published'; })()}</dd></div>
<div><dt>Pre-PR artifact</dt><dd>${(() => { const a = latest('pre-pr-summary'); return a ? `<a href="${esc(a.ref)}">pre-PR summary</a>` : 'not yet published'; })()}</dd></div>
<div><dt>Review responses</dt><dd>${rounds('review-response', 'round')}</dd></div>
<div><dt>Follow-on fix pages</dt><dd>${rounds('fix-summary', 'fix')}</dd></div>
<div><dt>Launched at</dt><dd class="mono">${esc(st.pin ? st.pin.kind + ':' + short(st.pin.value) : 'unpinned')} · estimate ${esc(st.estimate ? st.estimate.value + ' ' + st.estimate.unit : '—')}</dd></div>
<div><dt>Overlap</dt><dd>${overlap === 'clear' ? '<span class="pill ok">clear</span>' : /^n\/a/.test(overlap) ? esc(overlap) : `<span class="pill bad">${esc(overlap)}</span>`}</dd></div>
<div><dt>Gates</dt><dd>${gates.length ? gates.map((g) => `${esc(g.name)} by ${esc(g.by)} @ ${esc(short(g.pin && g.pin.value))}`).join('<br>') : 'none yet'}</dd></div>
<div><dt>Adversarial</dt><dd>${adversarial.length ? adversarial.map((a) => `${esc(a.name)}: <span class="pill ${a.verdict === 'pass' ? 'ok' : 'warn'}">${esc(a.verdict || 'n/a')}</span>`).join('<br>') : 'none'}</dd></div>
<div><dt>Signals</dt><dd>${extrapolations.length} extrapolation${extrapolations.length === 1 ? '' : 's'} · ${reprompts.length} re-prompt${reprompts.length === 1 ? '' : 's'}${outOfBand ? ` · ${outOfBand} receipt${outOfBand === 1 ? '' : 's'} out of band` : ''} · ${events.length} events</dd></div>
<div><dt>Last event</dt><dd class="mono">${esc(lastEvent ? stamp(lastEvent.ts) + ' ' + lastEvent.kind + (lastEvent.what ? ' ' + lastEvent.what : '') + (lastEvent.step ? ' · ' + lastEvent.step : '') : '—')}</dd></div>
</dl>
<h2>Steps</h2>
<div class="tw"><table><tr><th>Step</th><th>Status</th><th>Receipts</th><th>Outcome</th><th>Started</th><th>Finished</th></tr>${stepOrder.map(stepRow).join('')}</table></div>
${extrapolations.length ? `<h2>Extrapolations (schema tuning backlog)</h2><div class="tw"><table><tr><th>Step</th><th>Missing</th><th>Assumed</th></tr>${extrapolations.map((e) => `<tr><td>${esc(e.step)}</td><td>${esc(e.missing.scope)}:${esc(e.missing.key)}</td><td>${esc(spine.assumedText(e.assumed) || '—')}</td></tr>`).join('')}</table></div>` : ''}
<h2>Handoff</h2>
<pre>${esc(handoff.replace(/^---[\s\S]*?---\n/, '').trim() || 'none written')}</pre>
<p class="foot">Rendered by <code>plt render run ${esc(runId)}</code> from <code>process/runs/${esc(runId)}/state.yaml</code>, <code>events.jsonl</code>, <code>HANDOFF.md</code> and the facts snapshot <code>plt facts</code> keeps on the run. No hand-written state on this page.</p>
</div>
`;
}

// ---- build dir + manifest ----
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const buildDir = (processDir, out) => out || path.join(processDir, 'build');
const pageFile = (key) => (key === 'index' ? 'index.html' : `run-${key}.html`);

// renderAll(processDir, cfg) → { index: html, runs: { <id>: html } } — the page set writeBuild takes.
function renderAll(processDir, cfg) {
  cfg = cfg || spine.loadConfig(processDir);
  const runs = {};
  for (const id of runIds(processDir)) runs[id] = renderRun(processDir, id, cfg);
  return { index: renderIndex(processDir, cfg), runs };
}

// writeBuild(processDir, pages, {out}) — pages is { index?: html, runs?: { <id>: html } }; each present
// page is written to <out>/index.html or <out>/run-<id>.html. Returns { written: [{ key, path, sha256 }] }.
function writeBuild(processDir, pages, { out } = {}) {
  const dir = buildDir(processDir, out);
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const put = (key, html) => { const p = path.join(dir, pageFile(key)); fs.writeFileSync(p, html); written.push({ key, path: p, sha256: sha256(html) }); };
  if (pages.index) put('index', pages.index);
  for (const [id, html] of Object.entries(pages.runs || {})) put(id, html);
  return { written };
}

function readManifest(dir) {
  const f = path.join(dir, 'publish.json');
  if (!fs.existsSync(f)) return { index: null, runs: {} };
  try { const m = JSON.parse(fs.readFileSync(f, 'utf8')); return { index: m.index || null, runs: m.runs || {} }; } catch (e) { return { index: null, runs: {} }; }
}
// Temp file + rename, so a reader never sees half a manifest. The one manifest writer:
// lib/publish.js writes through it too.
function writeManifest(dir, m) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'publish.json');
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
  fs.renameSync(tmp, f);
}

// publishManifest(processDir, {out}) — hashes every page in the build dir against the previous manifest.
// An entry is { sha, url?, published_sha?, changed }: `changed` is true when the page is new, when its
// sha differs from the last manifest, or — once `--published` has recorded a url — when it differs
// from the sha that was published (so a page that changed and was rendered twice stays listed until
// it is republished). `url`/`published_sha` are carried forward untouched. Returns the manifest plus
// `changed`: the keys ('index' or a run id) whose page the owner should republish.
function publishManifest(processDir, { out } = {}) {
  const dir = buildDir(processDir, out);
  const prev = readManifest(dir);
  const entry = (key, old) => {
    const f = path.join(dir, pageFile(key));
    if (!fs.existsSync(f)) return old;   // never rendered here — keep what we know
    const sha = sha256(fs.readFileSync(f, 'utf8'));
    const e = { sha, changed: !old || old.sha !== sha || (Boolean(old.published_sha) && old.published_sha !== sha) };
    if (old && old.url) e.url = old.url;
    if (old && old.published_sha) e.published_sha = old.published_sha;
    return e;
  };
  const m = { index: entry('index', prev.index), runs: {} };
  const ids = new Set([...Object.keys(prev.runs), ...fs.readdirSync(dir).map((f) => (f.match(/^run-(.+)\.html$/) || [])[1]).filter(Boolean)]);
  for (const id of [...ids].sort()) m.runs[id] = entry(id, prev.runs[id]);
  const changed = [...(m.index && m.index.changed ? ['index'] : []), ...Object.keys(m.runs).filter((id) => m.runs[id] && m.runs[id].changed)];
  writeManifest(dir, m);
  return { ...m, changed };
}

// recordPublished(processDir, key, url, {out, runId}) — the publishing session's hand-back: stores the
// url and the published sha on the manifest entry, clears its `changed`, and records the artifact receipt (`run-<id>` on that
// run; `effort-index` on `runId` when one is given) unless the same receipt/url is already the latest.
// A refused pin (dirty repo_dir) keeps the manifest write and reports the receipt as not recorded.
function recordPublished(processDir, key, url, { out, runId } = {}) {
  if (!key || !url) throw new Error('usage: --published <id|index> <url>');
  const dir = buildDir(processDir, out);
  const name = key === 'index' ? 'effort-index' : `run-${key}`;
  // The sha published is the sha of the page on disk — the bytes the publishing session just sent —
  // not the manifest's, which is stale when a caller wrote the page without publishManifest.
  // publish.recordPublished is the one writer of `published_sha`. With no page on disk the bytes are
  // unknown, so only the url is recorded and the page stays pending (publish.recordUrl).
  const publish = require('./publish');   // lazy: publish.js requires this module at load
  const page = path.join(dir, pageFile(key));
  if (fs.existsSync(page)) publish.recordPublished(processDir, key, { sha: sha256(fs.readFileSync(page, 'utf8')), url }, { out });
  else publish.recordUrl(processDir, key, url, { out });
  const receiptRun = key === 'index' ? runId : key;
  let receipt = null;
  if (receiptRun && spine.readState(processDir, receiptRun)) {
    const st = spine.readState(processDir, receiptRun);
    const last = spine.readEvents(processDir, receiptRun).filter((ev) => ev.kind === 'artifact' && ev.name === name).pop();
    if (last && last.ref === url) receipt = { run: receiptRun, name, recorded: false, why: 'already recorded' };
    else {
      let pin = null;
      try { pin = st.repo_dir && fs.existsSync(st.repo_dir) ? spine.computePin(st.repo_dir) : st.pin; } catch (err) { pin = st.pin; }
      if (!pin || pin.refused) pin = st.pin;
      if (!pin || pin.refused) receipt = { run: receiptRun, name, recorded: false, why: 'unpinnable tree and no launch pin' };
      else {
        const step = st.current_step || currentStep(st) || null;
        spine.recordReceipt(processDir, receiptRun, { step, kind: 'artifact', name, ref: url, pin, actor: 'human' });
        receipt = { run: receiptRun, name, recorded: true };
      }
    }
  }
  return { key, url, name, receipt };
}

module.exports = { renderIndex, renderRun, renderAll, writeBuild, publishManifest, recordPublished, links,
  sha256, buildDir, pageFile, readManifest, writeManifest };
