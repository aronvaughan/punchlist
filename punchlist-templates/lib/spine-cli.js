'use strict';
const fs = require('fs');
const path = require('path');
const spine = require('./spine');
const effort = require('./effort');
const facts = require('./facts');

function opts(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { const k = args[i].slice(2); const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true; o[k] = v; }
    else o._.push(args[i]);
  }
  return o;
}
function processDir() {
  const p = process.env.PLT_PROCESS_DIR || spine.findProcessDir(process.cwd());
  if (!p) throw new Error('no process/config directory found above ' + process.cwd() + ' (set PLT_PROCESS_DIR)');
  return p;
}
function runIdFrom(o, repo) {
  if (o.run) return o.run;
  const branch = spine.git(repo || process.cwd(), ['branch', '--show-current']).trim();
  const m = branch.match(/[A-Z][A-Z0-9]+-\d+/);
  if (!m) throw new Error('pass --run; branch name carries no card key: ' + branch);
  return m[0];
}
const out = (v) => { process.stdout.write(JSON.stringify(v, null, 2) + '\n'); return 0; };

exports.run = async (args) => {
  const o = opts(args); const p = processDir();
  if (o._[0] === 'recompile') return out(spine.recompileRun(p, o._[1]));
  if (o._[0] === 'close') return out(spine.closeRun(p, o._[1], { by: o.by || 'agent' }));
  if (o._[0] === 'discard') return out(spine.discardRun(p, o._[1], { by: o.by, reason: o.reason, replacedBy: typeof o['replaced-by'] === 'string' ? o['replaced-by'] : undefined }));
  if (o._[0] === 'poll') {
    // Facts come from the PR named by the run's receipts: `gh pr view <n> --json mergeStateStatus,reviewDecision,state,…`.
    // `reviews` carries each review's state and commit — spine.reviewFacts derives the review-pr facts
    // (authorRepliedSinceOurReview, headMovedSinceOurReview, ourApprovalStanding, …) from them.
    const runId = o._[1];
    const events = spine.readEvents(p, runId);
    const prEv = events.filter((e) => e.ref && /https?:\/\/\S+\/pull\/\d+/.test(String(e.ref))).pop();
    if (!prEv) throw new Error(`run ${runId} has no PR receipt to poll`);
    const m = String(prEv.ref).match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    // Every gh call goes through facts.defaultGh — the one bounded runner: `PLT_GH` names the binary
    // (tests point it at a stub), the call is capped at 30s (`PLT_GH_TIMEOUT_MS` overrides), and a
    // timeout becomes a clear `gh timed out after <n>ms` error instead of a poll that hangs forever.
    const { execFileSync } = require('child_process');
    const gh = facts.defaultGh;
    const raw = JSON.parse(gh(['pr', 'view', m[2], '--repo', m[1], '--json', 'mergeStateStatus,reviewDecision,state,headRefOid,author,reviews,comments,isDraft,statusCheckRollup,reviewRequests']));
    // Review-thread replies are not in `gh pr view`; the REST list is the only place an author's inline reply shows up.
    let reviewComments = [];
    try { reviewComments = JSON.parse(gh(['api', '--paginate', `repos/${m[1]}/pulls/${m[2]}/comments`])); } catch (e) { reviewComments = []; }
    let ours = process.env.PLT_GH_LOGIN || '';
    if (!ours) { try { ours = gh(['api', 'user', '--jq', '.login']).trim(); } catch (e) { ours = ''; } }
    // `derived` needs threadsUnresolved, so it is computed after the thread query below.
    // Unresolved review threads are not in `gh pr view` — the GraphQL list is the only source.
    // A failure here leaves `threadsUnresolved` null rather than failing the poll: a fact we could
    // not read must not look like "zero unresolved".
    let threadsUnresolved = null;
    try {
      const [owner, name] = m[1].split('/');
      const resp = JSON.parse(gh(['api', 'graphql', '-f', `query=${facts.THREADS_QUERY}`,
        '-F', `owner=${owner}`, '-F', `repo=${name}`, '-F', `number=${m[2]}`]));
      threadsUnresolved = facts.threadsUnresolvedFrom(resp);
    } catch (e) { threadsUnresolved = null; }
    const derived = spine.reviewFacts({ ours, prAuthor: raw.author && raw.author.login, reviews: raw.reviews,
      comments: raw.comments, reviewComments, headRefOid: raw.headRefOid,
      reviewRequests: raw.reviewRequests || [], threadsUnresolved });
    const tally = facts.checkTally(raw.statusCheckRollup);
    const pollFacts = { mergeStateStatus: raw.mergeStateStatus, reviewDecision: raw.reviewDecision, state: raw.state,
      headRefOid: raw.headRefOid, prClosed: raw.state !== 'OPEN',
      // The three facts `prFacts` has always produced and the poll used to drop on the floor, so
      // an `arm_on` on any of them could never fire. `checks` stays a tally for renderers;
      // `checksGreen` is the armable scalar (null when there are no checks to judge).
      isDraft: Boolean(raw.isDraft), checks: tally, threadsUnresolved,
      checksGreen: tally.total === 0 ? null : (tally.fail === 0 && tally.pending === 0),
      ...derived };
    // Landing actions: the jira transition runs through config.jira.script from the process dir's parent (the umbrella).
    const cfg = spine.loadConfig(p, runId);
    const jira = (card, status) => {
      const script = cfg.jira && cfg.jira.script;
      if (!script) throw new Error('config.jira.script is not set');
      const cwd = require('path').dirname(p);
      execFileSync('python3', [script, 'transition', card, '--to', status], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    };
    return out({ facts: pollFacts, ...spine.pollRun(p, runId, pollFacts, { jira }) });
  }
  if (o._[0] !== 'launch') throw new Error('usage: plt run launch <id> --cycle <name> [--repo dir] [--owner who] [--estimate n] | plt run recompile <id> | plt run discard <id> --by <owner> --reason <why> [--replaced-by <card>] | plt run close <id> [--by who]');
  const estimate = o.estimate !== undefined ? Number(o.estimate) : undefined;
  if (estimate !== undefined && !Number.isFinite(estimate)) throw new Error('estimate must be a number');
  return out(spine.launchRun(p, { runId: o._[1], cycle: o.cycle, repoDir: path.resolve(o.repo || process.cwd()), owner: o.owner, estimate }));
};
exports.step = async (args) => {
  const o = opts(args); const p = processDir(); const [sub, id] = o._;
  const run = runIdFrom(o);
  if (!spine.readState(p, run)) { process.stderr.write(`no run ${run} under ${p}/runs\n`); return 1; }
  const takeOver = !!o['take-over'];
  if (sub === 'start') return out(spine.stepStart(p, run, id, { session: process.env.CLAUDE_SESSION_ID, takeOver }));
  if (sub === 'unstart') return out(spine.stepUnstart(p, run, id, { reason: o.reason, by: o.by }));
  if (sub === 'finish') return out(spine.stepFinish(p, run, id, { outcome: o.outcome, noExtrapolations: !!o['no-extrapolations'],
    extrapolations: o.extrapolation ? [JSON.parse(o.extrapolation)] : [], takeOver }));
  throw new Error('usage: plt step start|unstart|finish <id> --run <run> [--outcome o] [--no-extrapolations] [--extrapolation json] [--take-over]');
};
const RECEIPT_USAGE = 'usage: plt receipt --kind <kind> --name <name> [--run <run>] [--step <id>] [--ref x] [--verdict pass|fail] [--result r] [--files a,b] [--actor who] [--take-over]';
exports.receipt = async (args) => {
  const o = opts(args);
  if (typeof o.kind !== 'string' || !o.kind || typeof o.name !== 'string' || !o.name) { process.stderr.write(RECEIPT_USAGE + '\n'); return 2; }
  const p = processDir(); const run = runIdFrom(o);
  const st = spine.readState(p, run);
  if (!st) { process.stderr.write(`no run ${run} under ${p}/runs\n`); return 1; }
  const step = o.step || st.current_step;
  if (!step) { process.stderr.write('pass --step\n'); return 1; }
  const pin = spine.computePin(st.repo_dir);
  if (pin.refused) { process.stderr.write('receipt not recorded: unpinnable tree (' + pin.refused.join(', ') + ')\n'); return 1; }
  return out(spine.recordReceipt(p, run, { step, kind: o.kind, name: o.name, pin,
    session: o.session || process.env.CLAUDE_SESSION_ID, actor: o.actor, verdict: o.verdict, ref: o.ref, result: o.result,
    files: o.files ? String(o.files).split(',').map((f) => f.trim()).filter(Boolean) : undefined, takeOver: !!o['take-over'] }));
};
exports.gate = async (args) => {
  const o = opts(args); const p = processDir(); const [sub, run, step] = o._;
  if (sub === 'check') {
    const g = spine.gateCheck(p, run, step);
    out(g);
    if (g.banner && g.banner.length) {
      process.stdout.write('banner:\n' + g.banner.map((b) => `  ${b.kind}:${b.name} ${b.state}`).join('\n') + '\n');
    }
    return g.ok ? 0 : 1;
  }
  if (sub === 'approve') return out(spine.gateApprove(p, run, step, { by: o.by, takeOver: !!o['take-over'] }));
  if (sub === 'revoke') return out(spine.gateRevoke(p, run, step, { by: o.by, eventId: o.event, reason: o.reason }));
  throw new Error('usage: plt gate check|approve|revoke <run> <step> [--by who] [--event id --reason text] [--take-over]');
};
exports.handoff = async (args) => {
  const o = opts(args); const p = processDir(); const run = o._[0] || runIdFrom(o);
  process.stdout.write(spine.writeHandoff(p, run, { goal: o.goal, next: o.next,
    verified: o.verified ? String(o.verified).split('|') : [], questions: o.questions ? String(o.questions).split('|') : [],
    takeOver: !!o['take-over'] }));
  return 0;
};
exports.banners = async (args) => {
  const o = opts(args); const p = processDir();
  let run; try { run = runIdFrom(o); } catch (e) { return 0; }
  if (!spine.readState(p, run)) return 0;
  const b = spine.renderBanners(p, run);
  if (b.length) process.stdout.write(b.join('\n\n') + '\n');
  return 0;
};

exports.prime = async (args) => {
  const o = opts(args); const p = processDir();
  let run; try { run = runIdFrom(o); } catch (e) { process.stdout.write('(no active run: ' + e.message + ')\n'); return 0; }
  const st = spine.readState(p, run);
  if (!st) { process.stdout.write(`(no run ${run} under ${p}/runs)\n`); return 0; }
  if (o.next) { process.stdout.write(`NEXT: ${spine.nextCommand(st, formulaOf(p, st))}\n`); return 0; }
  if (o['menu-only']) {
    const events = spine.readEvents(p, run);
    process.stdout.write(spine.renderMenu(st, events, effectiveMenuWords(p, o)) + '\n');
    return 0;
  }
  process.stdout.write(spine.renderPrime(p, run, { menu: !o['no-menu'] }) + '\n'); return 0;
};
// The run's formula for nextCommand (manual steps are proposed as their gate / banner, never as
// `plt step start`); null for an ad-hoc state with no cycle, or one whose formula no longer loads.
function formulaOf(p, st) {
  if (!st || !st.cycle) return null;
  try { return spine.runFormula(p, st); } catch (e) { return null; }
}
// The effective menu word set for a run: config.menu.words (an overlay may rename a word;
// ids and commands never) over DEFAULT_MENU_WORDS. Falls back to the defaults when there is
// no active run (a bare parse/near-miss check outside any run context).
function effectiveMenuWords(p, o) {
  try { const run = runIdFrom(o); const config = spine.loadConfig(p, run); if (config.menu && config.menu.words) return config.menu.words; }
  catch (e) { /* no active run — default words */ }
  return spine.DEFAULT_MENU_WORDS;
}
// `plt menu parse --text "..."` — used by the UserPromptSubmit hook to tag menu phrases without
// re-implementing parseMenuPhrase in Python. `plt menu words` prints the effective word map (for
// the hook's near-miss check); `plt menu json` prints {mode, phrases} for the current run.
exports.menu = async (args) => {
  const o = opts(args); const p = processDir();
  if (o._[0] === 'parse') return out(spine.parseMenuPhrase(o.text || '', effectiveMenuWords(p, o)));
  if (o._[0] === 'words') return out(effectiveMenuWords(p, o));
  if (o._[0] === 'json') {
    let run; try { run = runIdFrom(o); } catch (e) { return out({ mode: null, phrases: [] }); }
    const st = spine.readState(p, run);
    if (!st) return out({ mode: null, phrases: [] });
    const events = spine.readEvents(p, run);
    return out(spine.menuFor(st, events));
  }
  throw new Error('usage: plt menu parse --text "<prompt>" | plt menu words [--run <run>] | plt menu json [--run <run>]');
};
// `plt config [key.path] [--run <run>]` — the merged process/config/*.yaml (plus the run's input
// vars) as JSON, or one value by dotted path. The installed hooks and agents read every
// project-specific value through this (gates.commands, denylist_file, writing.style_skills, …)
// so the shipped scripts carry no project literals. Exit 1 when the path has no value.
exports.config = async (args) => {
  const o = opts(args); const p = processDir();
  let v = spine.loadConfig(p, o.run);
  const keyPath = o._[0] || '';
  for (const k of keyPath.split('.').filter(Boolean)) v = v !== null && typeof v === 'object' ? v[k] : undefined;
  if (v === undefined) { process.stderr.write(`config: no value at ${keyPath}\n`); return 1; }
  return out(v);
};
exports.pin = async (args) => { const o = opts(args); return out(spine.computePin(path.resolve(o.repo || process.cwd()))); };
// `plt facts [--run <id>] [--json]` — the GitHub collector (lib/facts.js): every in-flight run
// naming a PR (or just --run), fetched once and recorded as idempotent gh receipts + a
// review-activity cursor. Never arms/disarms steps or lands a merge — that stays `plt run poll`.
exports.facts = async (args) => {
  const o = opts(args); const p = processDir();
  const results = facts.collect(p, o.run ? { runId: o.run } : {});
  if (o.json) return out(results);
  if (!results.length) { process.stdout.write((o.run ? `${o.run}` : 'facts') + ': no in-flight run with a PR\n'); return 0; }
  for (const r of results) {
    if (r.error) { process.stderr.write(`${r.run}: pr ${r.pr} failed — ${r.error}\n`); continue; }
    process.stdout.write(`${r.run}: recorded ${r.recorded.length ? r.recorded.join(',') : '-'} · skipped ${r.skipped.length ? r.skipped.join(',') : '-'} · activity ${r.activity}\n`);
  }
  // The explicit verb reports a failing run as a failure; `plt watch` only logs it (see watchOnce).
  return results.some((r) => r.error) ? 1 : 0;
};
// `plt render index|run <id>|all [--out <dir>] [--published <id|index> <url>] [--run <id>]` — the effort
// index and run status pages from state (lib/render.js), written to process/build/ with publish.json
// naming the pages whose content changed since the last render. `--published <key> <url>` is the
// publishing session's hand-back: it stores the url on the manifest and records the `run-<id>` /
// `effort-index` artifact receipt (the latter on --run, or the branch's run, when there is one).
exports.render = async (args) => {
  // `--published` takes two values; pull them out before the generic parser sees them.
  const i = args.indexOf('--published');
  let published = null;
  if (i >= 0) { published = { key: args[i + 1], url: args[i + 2] }; args = [...args.slice(0, i), ...args.slice(i + 3)]; }
  const o = opts(args); const p = processDir();
  const render = require('./render');
  const out = typeof o.out === 'string' ? path.resolve(o.out) : undefined;
  const [what, id] = o._;
  if (what && !['index', 'run', 'all'].includes(what)) throw new Error('usage: plt render index|run <id>|all [--out <dir>] [--published <id|index> <url>]');
  if (what === 'run' && !id) throw new Error('plt render run: pass the run id');
  if (what) {
    const cfg = spine.loadConfig(p);
    const pages = what === 'all' ? render.renderAll(p, cfg) : what === 'index' ? { index: render.renderIndex(p, cfg) } : { runs: { [id]: render.renderRun(p, id, cfg) } };
    const w = render.writeBuild(p, pages, { out });
    for (const f of w.written) process.stdout.write(`wrote ${f.path}\n`);
  }
  if (published) {
    if (!published.key || !published.url || String(published.url).startsWith('--')) throw new Error('usage: --published <id|index> <url>');
    let runId = o.run;
    if (!runId && published.key === 'index') { try { runId = runIdFrom(o); } catch (e) { runId = undefined; } }
    const r = render.recordPublished(p, published.key, published.url, { out, runId });
    const rc = r.receipt ? (r.receipt.recorded ? `receipt ${r.name} recorded on ${r.receipt.run}` : `receipt ${r.name} not recorded on ${r.receipt.run} (${r.receipt.why})`) : `no run to carry the ${r.name} receipt`;
    process.stdout.write(`published ${r.name} → ${r.url} · ${rc}\n`);
  }
  const m = render.publishManifest(p, { out });
  process.stdout.write(`changed: ${m.changed.length ? m.changed.join(' ') : 'none'}\n`);
  return 0;
};
// PLT_EXEC, when set, is prepended to every command as the executor — e.g. `PLT_EXEC=echo` makes
// every worktree/setup/window command a no-op print instead of running it for real.
function execWithPltExec() {
  const prefix = process.env.PLT_EXEC;
  return (cmd, opts) => {
    const { execSync } = require('child_process');
    return execSync(prefix ? `${prefix} ${cmd}` : cmd, { encoding: 'utf8', cwd: opts && opts.cwd });
  };
}

const EFFORT_USAGE = 'usage: plt effort plan <slug> [--json] | plt effort launch <slug> [--parallel] [--dry-run] [--only ID,ID] [--owner who] [--json]';
exports.effort = async (args) => {
  const o = opts(args); const p = processDir(); const [sub, slug] = o._;
  if (['plan', 'launch'].includes(sub) && !slug) { process.stderr.write(EFFORT_USAGE + '\n'); return 2; }
  if (sub === 'plan') {
    const plan = effort.planWave(p, slug);
    if (o.json) return out(plan);
    process.stdout.write(`wave: ${plan.wave.map((c) => c.id).join(' ')}\n`);
    for (const e of plan.excluded) process.stdout.write(`excluded: ${e.card} — ${e.why}\n`);
    process.stdout.write(`running: ${plan.running.length ? plan.running.join(' ') : 'none'}\n`);
    return 0;
  }
  if (sub === 'launch') {
    const dryRun = !!o['dry-run'];
    const only = o.only ? String(o.only).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const launchOpts = { dryRun, exec: execWithPltExec(), owner: typeof o.owner === 'string' ? o.owner : undefined };
    if (only) {
      launchOpts.only = only;
    } else if (!o.parallel) {
      const { wave } = effort.planWave(p, slug);
      launchOpts.only = wave.length ? [wave[0].id] : [];
    }
    const result = effort.launchWave(p, slug, launchOpts);
    if (o.json) return out(result);
    for (const l of result.launched) process.stdout.write(`launched: ${l.card}${l.branch ? ` (${l.branch})` : ''} → ${l.path}\n`);
    for (const s of result.skipped) process.stdout.write(`skipped: ${s.card} — ${s.error}\n`);
    return result.skipped.length ? 1 : 0;
  }
  process.stderr.write(EFFORT_USAGE + '\n'); return 2;
};

// `plt watch [--once]` — facts -> render all -> notify. Catch-up is `process/build/watch.json`,
// a { <run>: <nextCommand string> } snapshot from the last collect: a run seen for the first time
// only records its baseline (nothing to compare against yet — never notifies on it); a run whose
// nextCommand differs from that baseline fires `windows.notify` once and moves the baseline
// forward, so re-running `--once` on an unchanged run stays silent. A closed run is dropped from
// the snapshot on the pass that sees it closed (after its last notify, if its next command changed)
// and is never baselined again; a run whose directory is gone is dropped too. Without `--once` this
// loops forever on `timers.watch.every` — `--once` is what the installed timer actually runs.
function watchFile(p) { return path.join(p, 'build', 'watch.json'); }
function readWatchState(p) {
  const f = watchFile(p);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; }
}
function writeWatchState(p, st) {
  fs.mkdirSync(path.dirname(watchFile(p)), { recursive: true });
  fs.writeFileSync(watchFile(p), JSON.stringify(st, null, 2) + '\n');
}

// One collect+render+notify pass. Returns one entry per run under process/runs with {run, notified,
// why?, error?} — a run notified: false either had no prior baseline (first sighting), had an
// unchanged nextCommand, has no windows.notify configured, or (only when the template actually
// references {tab_id}/{pane_id}/{label}) has no inputs.window to fill them from (logged, never
// fatal — a run launched before `effort launch` started recording `inputs.window`, or one with no
// window at all, must not crash the whole pass).
function watchOnce(p) {
  // A run whose PR could not be fetched is logged and skipped — never allowed to abort the pass
  // before render and notify (facts.collect records it as {run, pr, error}).
  for (const f of facts.collect(p)) {
    if (f.error) process.stderr.write(`watch: ${f.run} — facts for pr ${f.pr} failed: ${f.error}\n`);
  }
  const render = require('./render');
  const cfg = spine.loadConfig(p);
  render.writeBuild(p, render.renderAll(p, cfg));
  render.publishManifest(p);

  const notifyTpl = cfg.windows && cfg.windows.notify;
  const usesWindowVars = Boolean(notifyTpl) && /\{(tab_id|pane_id|label)\}/.test(notifyTpl);
  const watchState = readWatchState(p);
  const runsDir = path.join(p, 'runs');
  const ids = fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : [];
  const run = execWithPltExec();
  const results = [];
  const open = new Set();
  for (const id of ids) {
    const st = spine.readState(p, id);
    if (!st) continue;
    const had = Object.prototype.hasOwnProperty.call(watchState, id);
    if (st.status === 'closed' && !had) continue;
    if (st.status !== 'closed') open.add(id);
    const next = spine.nextCommand(st, formulaOf(p, st));
    const old = watchState[id];
    watchState[id] = next;
    if (!had) { results.push({ run: id, notified: false, why: 'baseline' }); continue; }
    if (old === next) continue;
    if (!notifyTpl) { results.push({ run: id, notified: false, why: 'no windows.notify' }); continue; }
    const inputs = spine.readInputs(p, id);
    const win = inputs.window || {};
    if (usesWindowVars && win.pane_id === undefined && win.tab_id === undefined) {
      process.stderr.write(`watch: ${id} — next changed but has no inputs.window and windows.notify needs one; skipped\n`);
      results.push({ run: id, notified: false, why: 'no inputs.window' });
      continue;
    }
    const text = `${id}: ${old} → ${next}`;
    // {text}/{next}/{label} are free text (an outcome placeholder like `<outcome>` is a shell
    // redirection char, an old/new command can carry spaces) — pre-quote them with effort.js's
    // `q()` so a template author writes a terminal multiplexer's notify command
    // (`mux notify {text} --body {next}`) bare, never `'{text}'`. {run}/{tab_id}/{pane_id} are
    // simple tokens (card ids, pane/tab ids) and stay unquoted so a template can still splice them
    // into a larger word if it wants to.
    const vars = { run: id, text: effort.q(text), next: effort.q(next) };
    if (win.tab_id !== undefined) vars.tab_id = win.tab_id;
    if (win.pane_id !== undefined) vars.pane_id = win.pane_id;
    if (win.label !== undefined) vars.label = effort.q(win.label);
    const cmd = effort.renderTemplate(notifyTpl, vars);
    try { run(cmd); results.push({ run: id, notified: true, text }); }
    catch (e) { process.stderr.write(`watch: notify failed for ${id}: ${e.message}\n`); results.push({ run: id, notified: false, error: e.message }); }
  }
  for (const id of Object.keys(watchState)) if (!open.has(id)) delete watchState[id];
  writeWatchState(p, watchState);
  return results;
}

// `plt digest launch --for <date> [--weekly] [--owner who]` — idempotent: a DIGEST run already
// closed for that date/week is a no-op (exit 0). `plt digest collect --for <date> [--weekly]
// [--out f]` writes process/digests/<date>[-weekly].json. `plt digest standup --for <date>` prints
// Preparing/Ready/Blockers as Slack bullets from the same collect data plus live run state.
function digestRunId(forDate, weekly) {
  const digest = require('./digest');
  return weekly ? `DIGEST-${digest.isoWeekLabel(forDate).replace('-', '')}` : `DIGEST-${forDate.replace(/-/g, '')}`;
}
const DIGEST_USAGE = 'usage: plt digest collect --for <date> [--weekly] [--out f] | plt digest standup --for <date> | plt digest launch --for <date> [--weekly] [--owner who]\n' +
  '  run ids: DIGEST-<yyyymmdd> (daily) / DIGEST-<yyyy>W<ww> (weekly, ISO week); the window is UTC midnight to midnight.';
exports.digest = async (args) => {
  const o = opts(args); const p = processDir();
  const digest = require('./digest');
  const sub = o._[0];
  if (!o.for) { process.stderr.write(DIGEST_USAGE + '\n'); return 2; }
  const forDate = String(o.for);
  if (sub === 'launch') {
    const runId = digestRunId(forDate, !!o.weekly);
    const existing = spine.readState(p, runId);
    if (existing && existing.status === 'closed') { process.stdout.write(`${runId}: already closed — no-op\n`); return 0; }
    return out(spine.launchRun(p, { runId, cycle: 'digest', repoDir: path.resolve(o.repo || path.dirname(p)), owner: o.owner }));
  }
  if (sub === 'collect') {
    const data = o.weekly ? digest.collectWeekly(p, forDate) : digest.collectDigest(p, digest.dayWindow(forDate));
    const outFile = o.out ? path.resolve(o.out) : path.join(p, 'digests', `${forDate}${o.weekly ? '-weekly' : ''}.json`);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(data, null, 2) + '\n');
    process.stdout.write(`wrote ${outFile}\n`);
    return 0;
  }
  if (sub === 'standup') {
    const s = digest.computeStandup(p, forDate);
    process.stdout.write(digest.renderStandup(s) + '\n');
    return 0;
  }
  process.stderr.write(DIGEST_USAGE + '\n'); return 2;
};

// `plt sync [--since <iso>] [--json]` — "what moved since the last session". Runs `facts.collect`
// once (best-effort: a gh/auth hiccup must not crash a SessionStart hook), then compares every
// run's `nextCommand` against process/build/sync.json's last snapshot (separate from watch.json —
// see lib/spine.js#syncSince). Idempotent: an unchanged second call prints `nothing moved`; the
// first-ever call seeds silently, same rule as `plt watch`'s first pass.
exports.sync = async (args) => {
  const o = opts(args); const p = processDir();
  try { facts.collect(p); } catch (e) { process.stderr.write(`sync: facts.collect failed (${e.message}) — comparing state as-is\n`); }
  const r = spine.syncSince(p, { since: typeof o.since === 'string' ? o.since : undefined });
  if (o.json) return out(r);
  if (r.seeded) { process.stdout.write(`sync: seeded ${r.total} run(s) — first sync, nothing to compare yet\n`); return 0; }
  if (!r.moved.length) { process.stdout.write('nothing moved\n'); return 0; }
  for (const m of r.moved) process.stdout.write(`${m.run}: ${m.from} → ${m.to}\n`);
  process.stdout.write(`since ${r.since || 'unknown'}: ${r.moved.length} moved, ${r.unchanged} unchanged\n`);
  return 0;
};

// `plt mine [--effort <slug>] [--since <iso>] [--out <file>] [--json]` — deterministic aggregation
// (see lib/spine.js#mine) written to process/suggestions.md (private side; --out overrides).
// Never edits formulas or config; acting on a row is a human decision.
exports.mine = async (args) => {
  const o = opts(args); const p = processDir();
  const m = spine.mine(p, { effort: typeof o.effort === 'string' ? o.effort : undefined, since: typeof o.since === 'string' ? o.since : undefined });
  const outFile = typeof o.out === 'string' ? path.resolve(o.out) : path.join(p, 'suggestions.md');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, spine.renderMine(m));
  if (o.json) return out(m);
  process.stdout.write(`wrote ${outFile}\n`);
  return 0;
};

exports.watch = async (args) => {
  const o = opts(args); const p = processDir();
  if (o.once) {
    const results = watchOnce(p);
    for (const r of results) if (r.notified) process.stdout.write(`watch: notified ${r.run} — ${r.text}\n`);
    if (!results.some((r) => r.notified)) process.stdout.write('watch: no change to notify\n');
    return 0;
  }
  const timers = require('./timers');
  const cfg = spine.loadConfig(p);
  const ms = timers.everySeconds(cfg.timers && cfg.timers.watch && cfg.timers.watch.every) * 1000;
  for (;;) {
    watchOnce(p);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
};

// ---- CLI registry ----------------------------------------------------------
// The verbs this module owns, in the shape lib/registry.js discovers (see that file for the
// descriptor contract). `bin/plt` no longer names any of them: it scans lib/*.js.
// `render` is NOT here — bin/plt owns that verb and calls exports.render for the
// index/run/all forms only.
//
// Each handler takes the argv tokens after the verb and returns the exit code. They are the
// same async functions exported above, so nothing about a verb's behaviour changes.
exports.commands = [
  { name: 'run', usage: 'plt run launch|recompile|discard|close|poll <id> [...]', handler: (argv) => exports.run(argv) },
  { name: 'step', usage: 'plt step start|finish <id> --run <run> [--take-over]', handler: (argv) => exports.step(argv) },
  { name: 'receipt', usage: 'plt receipt --kind <k> --name <n> [--run <run>] [--step <id>] [...]', handler: (argv) => exports.receipt(argv) },
  { name: 'gate', usage: 'plt gate check|approve <run> <step> [--take-over]', handler: (argv) => exports.gate(argv) },
  { name: 'handoff', usage: 'plt handoff <run> --goal ... --next ...', handler: (argv) => exports.handoff(argv) },
  { name: 'prime', usage: 'plt prime [--run <run>] [--no-menu|--next|--menu-only]', handler: (argv) => exports.prime(argv) },
  { name: 'menu', usage: 'plt menu parse --text "<prompt>" | plt menu words|json [--run <run>]', handler: (argv) => exports.menu(argv) },
  { name: 'banners', usage: 'plt banners [--run <run>]', handler: (argv) => exports.banners(argv) },
  { name: 'pin', usage: 'plt pin [--repo <dir>]', handler: (argv) => exports.pin(argv) },
  { name: 'effort', usage: 'plt effort plan|launch <slug> [--parallel] [--dry-run] [--only ID,ID] [--owner who] [--json]', handler: (argv) => exports.effort(argv) },
  { name: 'config', usage: 'plt config [key.path] [--run <run>]', handler: (argv) => exports.config(argv) },
  { name: 'facts', usage: 'plt facts [--run <id>] [--json]', handler: (argv) => exports.facts(argv) },
  { name: 'watch', usage: 'plt watch [--once]', handler: (argv) => exports.watch(argv) },
  { name: 'sync', usage: 'plt sync [--since <iso>] [--json]', handler: (argv) => exports.sync(argv) },
  { name: 'mine', usage: 'plt mine [--effort <slug>] [--since <iso>] [--out <file>] [--json]', handler: (argv) => exports.mine(argv) },
  { name: 'digest', usage: 'plt digest launch|collect|standup --for <date> [--weekly] [...]', handler: (argv) => exports.digest(argv) },
];
