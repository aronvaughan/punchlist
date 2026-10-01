'use strict';
// publish — which rendered pages are behind the published ones, and the record of a publish.
//
// `plt render` writes `<processDir>/build/{index.html,run-<id>.html}` and `build/publish.json`
// ({ index: entry, runs: { <id>: entry } }, entry = { sha, url?, published_sha?, changed }), then
// stops. Publishing is a separate act, so the published artifact lags whatever the last publishing
// session left. This module answers "what is behind" from the bytes on disk against the sha last
// recorded as published, without reading any artifact.
//
// `plt publish` never publishes. Publishing reaches people, so it stays a deliberate act by the
// agent driving the session: the verb prints what is pending, the exact Artifact call to make, and
// the hand-back that records the publish afterwards.
//
// A target is 'index' or a run id — the same keys lib/render.js uses in publish.json.
const fs = require('fs');
const path = require('path');

const { sha256, buildDir, pageFile, readManifest, writeManifest } = require('./render');
const { parseArgs, resolveProcessDir } = require('./fsck');
const entryOf = (m, target) => (target === 'index' ? m.index : m.runs[target]) || null;

// renderedTargets(dir) → ['index', <run id>…] — every page on disk in the build dir, index first.
function renderedTargets(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir);
  const runs = files.map((f) => (f.match(/^run-(.+)\.html$/) || [])[1]).filter(Boolean).sort();
  return [...(files.includes('index.html') ? ['index'] : []), ...runs];
}

// pendingPublishes(processDir, {out}) → [{target, path, sha, lastPublishedSha}] — every rendered page
// whose bytes differ from the last publish recorded for it. A page with no publish recorded has
// lastPublishedSha null. The page on disk decides: a render that did not refresh publish.json
// still counts.
function pendingPublishes(processDir, { out } = {}) {
  const dir = buildDir(processDir, out);
  const m = readManifest(dir);
  const pending = [];
  for (const target of renderedTargets(dir)) {
    const p = path.join(dir, pageFile(target));
    const sha = sha256(fs.readFileSync(p, 'utf8'));
    const e = entryOf(m, target);
    const lastPublishedSha = (e && e.published_sha) || null;
    if (sha !== lastPublishedSha) pending.push({ target, path: p, sha, lastPublishedSha });
  }
  return pending;
}

// recordPublished(processDir, target, {sha, url}, {out}) → void — writes the published sha and url
// onto the target's publish.json entry, leaving every other entry as it was. `sha` is the sha of the
// bytes that were published, so a page rendered again since then stays pending. This records the
// manifest only; `plt render --published` also records the artifact receipt on the run.
function recordPublished(processDir, target, { sha, url } = {}, { out } = {}) {
  if (!target) throw new Error('recordPublished: pass the target (index or a run id)');
  if (!sha) throw new Error(`recordPublished ${target}: pass the sha that was published`);
  if (!url) throw new Error(`recordPublished ${target}: pass the published url`);
  const dir = buildDir(processDir, out);
  const m = readManifest(dir);
  const old = entryOf(m, target) || {};
  const current = old.sha || sha;
  const e = { ...old, sha: current, url, published_sha: sha, changed: current !== sha };
  if (target === 'index') m.index = e; else m.runs[target] = e;
  writeManifest(dir, m);
}

// recordUrl(processDir, target, url, {out}) → void — stores the url of an artifact that already
// exists for the target, with `published_sha: null`: the bytes it holds are unknown, so the page
// stays pending until it is republished and recorded with recordPublished (or `plt render
// --published`). Every other entry stays as it was.
function recordUrl(processDir, target, url, { out } = {}) {
  if (!target) throw new Error('recordUrl: pass the target (index or a run id)');
  if (!url) throw new Error(`recordUrl ${target}: pass the artifact url`);
  const dir = buildDir(processDir, out);
  const m = readManifest(dir);
  const old = entryOf(m, target) || {};
  const e = { ...old, url, published_sha: null, changed: true };
  if (target === 'index') m.index = e; else m.runs[target] = e;
  writeManifest(dir, m);
}

// ---- CLI -------------------------------------------------------------------

const USAGE = 'plt publish [<index|run id>] [--out <dir>] [--project <dir>] [--json] | plt publish --record <index|run id> --url <url>';

const artifact = (args) => `Artifact ${JSON.stringify(args)}`;

// The calls for one pending page. With a url on record, the update in place is the call. With none,
// an artifact may still exist (publishes made before anyone recorded them), so the first step is to
// record its url; the create call comes last, labelled for the case where none exists.
function pageCalls(page, url) {
  if (url) {
    return [
      `  ${artifact({ file_path: page.path, url })}   (update in place — read the artifact first)`,
      `  then: plt render --published ${page.target} ${url}`,
    ];
  }
  return [
    `  no artifact url on record. If one already exists for this page, record its url and run plt publish again for the update call: plt publish --record ${page.target} --url followed by that url`,
    `  only if no artifact exists for this page yet: ${artifact({ file_path: page.path, icon: 'list' })}   (icon "list" is a default)`,
    `  then: plt render --published ${page.target} followed by the url that call returns`,
  ];
}

function publishHandler(args, ctx = {}) {
  const o = parseArgs(args.filter((a) => a !== '-h'));
  if (args.includes('-h')) o.help = true;
  if (o.help) { process.stdout.write(USAGE + '\n'); return 0; }
  const processDir = resolveProcessDir(o.project, (ctx && ctx.env) || process.env);
  const out = typeof o.out === 'string' ? path.resolve(o.out) : undefined;
  const dir = buildDir(processDir, out);
  const target = o.record !== undefined ? o.record : o._[0];
  if (o.record === true) throw new Error(`usage: ${USAGE}`);
  if (target && !renderedTargets(dir).includes(target)) {
    throw new Error(`no rendered page for ${target} in ${dir} — run plt render ${target === 'index' ? 'index' : `run ${target}`} first`);
  }
  if (o.record !== undefined) {
    if (typeof o.url !== 'string') throw new Error(`plt publish --record ${target}: pass --url with the existing artifact's url`);
    recordUrl(processDir, target, o.url, { out });
    process.stdout.write(`${target}: recorded ${o.url} as its artifact; no publish recorded, so it stays pending until republished\n`);
    return 0;
  }
  const m = readManifest(dir);
  const pending = pendingPublishes(processDir, { out }).filter((x) => !target || x.target === target);
  if (o.json) { process.stdout.write(JSON.stringify(pending, null, 2) + '\n'); return 0; }
  if (!pending.length) {
    const e = (target && entryOf(m, target)) || {};
    process.stdout.write(target ? `${target}: published, up to date${e.url ? ` — ${e.url}` : ''}\n` : 'nothing to publish: every rendered page matches its last publish\n');
    return 0;
  }
  process.stdout.write(`${pending.length} page${pending.length === 1 ? '' : 's'} to publish. plt publish does not publish — make each call, then record it:\n`);
  for (const page of pending) {
    const e = entryOf(m, page.target) || {};
    const last = page.lastPublishedSha ? `last published ${page.lastPublishedSha.slice(0, 12)}` : 'no publish recorded';
    process.stdout.write(`\n${page.target}: ${page.path} (sha ${page.sha.slice(0, 12)}, ${last})\n`);
    for (const line of pageCalls(page, e.url)) process.stdout.write(line + '\n');
  }
  return 0;
}

const commands = [{ name: 'publish', usage: USAGE, handler: publishHandler }];

module.exports = { pendingPublishes, recordPublished, recordUrl, publishHandler, commands, USAGE };
