'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const publish = require('../lib/publish');
const PLT = path.join(__dirname, '..', 'bin', 'plt');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// A process dir with a hand-written build/: the pages and publish.json exactly as `plt render` leaves them.
function tmpBuild(pages, manifest) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-')), 'process');
  const b = path.join(p, 'build');
  fs.mkdirSync(b, { recursive: true });
  for (const [file, html] of Object.entries(pages)) fs.writeFileSync(path.join(b, file), html);
  if (manifest) fs.writeFileSync(path.join(b, 'publish.json'), JSON.stringify(manifest, null, 2) + '\n');
  return p;
}
const manifestOf = (p) => JSON.parse(fs.readFileSync(path.join(p, 'build', 'publish.json'), 'utf8'));
function plt(args, p) {
  const env = { ...process.env, PLT_PROCESS_DIR: p };
  delete env.PLT_BIN; delete env.PUNCHLIST_TEMPLATES_DIR;
  return execFileSync('node', [PLT, ...args], { encoding: 'utf8', env });
}

test('pendingPublishes: a rendered page with no publish recorded is pending, with no last-published sha', () => {
  const p = tmpBuild({ 'index.html': '<p>index</p>' }, { index: { sha: sha('<p>index</p>'), changed: true }, runs: {} });
  assert.deepStrictEqual(publish.pendingPublishes(p), [
    { target: 'index', path: path.join(p, 'build', 'index.html'), sha: sha('<p>index</p>'), lastPublishedSha: null },
  ]);
});

test('pendingPublishes: a page whose bytes match the recorded publish is not pending; one that moved on is', () => {
  const p = tmpBuild(
    { 'index.html': 'idx v1', 'run-TRK-1.html': 'run v2', 'run-TRK-2.html': 'run2 v1' },
    {
      index: { sha: sha('idx v1'), url: 'https://pages.example/index', published_sha: sha('idx v1'), changed: false },
      runs: {
        'TRK-1': { sha: sha('run v2'), url: 'https://pages.example/run-TRK-1', published_sha: sha('run v1'), changed: true },
        'TRK-2': { sha: sha('run2 v1'), changed: true },
      },
    });
  const pending = publish.pendingPublishes(p);
  assert.deepStrictEqual(pending.map((x) => x.target), ['TRK-1', 'TRK-2']);
  assert.strictEqual(pending[0].lastPublishedSha, sha('run v1'));
  assert.strictEqual(pending[0].sha, sha('run v2'));
  assert.strictEqual(pending[0].path, path.join(p, 'build', 'run-TRK-1.html'));
});

test('pendingPublishes: the bytes on disk decide, not a stale manifest sha; no build dir is nothing pending', () => {
  // Rendered again after the publish, without publishManifest running: the manifest still says published.
  const p = tmpBuild({ 'index.html': 'idx v2' }, { index: { sha: sha('idx v1'), published_sha: sha('idx v1'), url: 'u', changed: false }, runs: {} });
  assert.deepStrictEqual(publish.pendingPublishes(p).map((x) => x.target), ['index']);
  const empty = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-')), 'process');
  assert.deepStrictEqual(publish.pendingPublishes(empty), []);
});

test('recordPublished: round-trips through publish.json without disturbing other targets', () => {
  const before = {
    index: { sha: sha('idx'), changed: true },
    runs: {
      'TRK-1': { sha: sha('run1'), changed: true },
      'TRK-2': { sha: sha('run2'), url: 'https://pages.example/run-TRK-2', published_sha: sha('run2'), changed: false },
    },
  };
  const p = tmpBuild({ 'index.html': 'idx', 'run-TRK-1.html': 'run1', 'run-TRK-2.html': 'run2' }, before);
  assert.strictEqual(publish.recordPublished(p, 'TRK-1', { sha: sha('run1'), url: 'https://pages.example/run-TRK-1' }), undefined);
  const after = manifestOf(p);
  assert.deepStrictEqual(after.runs['TRK-1'], { sha: sha('run1'), url: 'https://pages.example/run-TRK-1', published_sha: sha('run1'), changed: false });
  assert.deepStrictEqual(after.index, before.index, 'index untouched');
  assert.deepStrictEqual(after.runs['TRK-2'], before.runs['TRK-2'], 'TRK-2 untouched');
  assert.deepStrictEqual(publish.pendingPublishes(p).map((x) => x.target), ['index']);

  publish.recordPublished(p, 'index', { sha: sha('idx'), url: 'https://pages.example/index' });
  assert.strictEqual(manifestOf(p).index.url, 'https://pages.example/index');
  assert.deepStrictEqual(publish.pendingPublishes(p), []);
});

test('recordPublished: the sha recorded is the one published, so a page re-rendered since stays pending', () => {
  const p = tmpBuild({ 'index.html': 'idx v2' }, { index: { sha: sha('idx v2'), changed: true }, runs: {} });
  publish.recordPublished(p, 'index', { sha: sha('idx v1'), url: 'https://pages.example/index' });
  const e = manifestOf(p).index;
  assert.strictEqual(e.published_sha, sha('idx v1'));
  assert.strictEqual(e.changed, true, 'the manifest agrees the page is still behind');
  assert.deepStrictEqual(publish.pendingPublishes(p).map((x) => x.lastPublishedSha), [sha('idx v1')]);
});

test('recordPublished: refuses a missing target, sha or url', () => {
  const p = tmpBuild({ 'index.html': 'idx' }, null);
  assert.throws(() => publish.recordPublished(p, '', { sha: sha('idx'), url: 'u' }), /target/);
  assert.throws(() => publish.recordPublished(p, 'index', { url: 'u' }), /sha/);
  assert.throws(() => publish.recordPublished(p, 'index', { sha: sha('idx') }), /url/);
  assert.ok(!fs.existsSync(path.join(p, 'build', 'publish.json')), 'a refused record writes nothing');
});

test('plt publish: a page with a url prints the update call first, labels a missing record honestly, and publishes nothing', () => {
  const p = tmpBuild(
    { 'index.html': 'idx v2', 'run-TRK-1.html': 'run1', 'run-TRK-2.html': 'run2' },
    {
      index: { sha: sha('idx v2'), url: 'https://pages.example/index', published_sha: sha('idx v1'), changed: true },
      runs: {
        'TRK-1': { sha: sha('run1'), changed: true },
        'TRK-2': { sha: sha('run2'), url: 'https://pages.example/run-TRK-2', changed: true },
      },
    });
  const before = fs.readFileSync(path.join(p, 'build', 'publish.json'), 'utf8');
  const outp = plt(['publish'], p);
  const idx = path.join(p, 'build', 'index.html');
  const run1 = path.join(p, 'build', 'run-TRK-1.html');
  const run2 = path.join(p, 'build', 'run-TRK-2.html');
  assert.ok(outp.startsWith('3 pages to publish.'), outp);
  assert.ok(outp.includes(`Artifact ${JSON.stringify({ file_path: idx, url: 'https://pages.example/index' })}`), outp);
  assert.ok(outp.includes('plt render --published index https://pages.example/index'), outp);
  assert.ok(!outp.includes('never published') && !outp.includes('<url>'), outp);

  // A url with no publish recorded (the --record state): the update call is the first call printed.
  const b2 = outp.slice(outp.indexOf('\nTRK-2:'));
  assert.ok(b2.includes('no publish recorded'), b2);
  assert.ok(b2.indexOf(`Artifact ${JSON.stringify({ file_path: run2, url: 'https://pages.example/run-TRK-2' })}`) > 0, b2);
  assert.ok(b2.includes('read the artifact first'), b2);
  assert.ok(!b2.includes('icon'), 'no create call when a url is known (TRK-2 is the last block)');

  // No url at all: the record-an-existing-url step comes before the create call, which is labelled.
  const b1 = outp.slice(outp.indexOf('\nTRK-1:'), outp.indexOf('\nTRK-2:'));
  assert.ok(b1.includes('no publish recorded'), b1);
  const rec = b1.indexOf('plt publish --record TRK-1 --url');
  const create = b1.indexOf(`Artifact ${JSON.stringify({ file_path: run1, icon: 'list' })}`);
  assert.ok(rec > 0 && create > rec, b1);
  assert.ok(b1.slice(0, create).includes('only if no artifact exists for this page yet'), b1);
  assert.strictEqual(fs.readFileSync(path.join(p, 'build', 'publish.json'), 'utf8'), before, 'plt publish writes nothing');

  const one = plt(['publish', 'TRK-1'], p);
  assert.ok(one.includes(run1) && !one.includes(idx), one);
  const json = JSON.parse(plt(['publish', 'TRK-2', '--json'], p));
  assert.deepStrictEqual(json, [{ target: 'TRK-2', path: run2, sha: sha('run2'), lastPublishedSha: null }]);
});

test('plt publish --record: stores an existing url without marking the bytes published; recordPublished then clears it', () => {
  const p = tmpBuild({ 'index.html': 'idx', 'run-TRK-1.html': 'run1' }, { index: { sha: sha('idx'), changed: true }, runs: { 'TRK-1': { sha: sha('run1'), changed: true } } });
  const r = plt(['publish', '--record', 'index', '--url', 'https://pages.example/index'], p);
  assert.ok(r.includes('https://pages.example/index'), r);
  const e = manifestOf(p).index;
  assert.strictEqual(e.url, 'https://pages.example/index');
  assert.strictEqual(e.published_sha, null);
  assert.deepStrictEqual(manifestOf(p).runs['TRK-1'], { sha: sha('run1'), changed: true }, 'other targets untouched');
  assert.deepStrictEqual(publish.pendingPublishes(p).map((x) => x.target), ['index', 'TRK-1'], 'still pending');
  assert.ok(plt(['publish', 'index'], p).includes(`Artifact ${JSON.stringify({ file_path: path.join(p, 'build', 'index.html'), url: 'https://pages.example/index' })}`));

  publish.recordPublished(p, 'index', { sha: sha('idx'), url: 'https://pages.example/index' });
  assert.deepStrictEqual(publish.pendingPublishes(p).map((x) => x.target), ['TRK-1']);

  assert.throws(() => plt(['publish', '--record', 'index'], p), /--url/);
  assert.throws(() => plt(['publish', '--record', 'TRK-9', '--url', 'https://pages.example/x'], p), /no rendered page for TRK-9/);
});

test('plt publish: says so when nothing is pending; an unknown target is an error', () => {
  const p = tmpBuild({ 'index.html': 'idx' }, { index: { sha: sha('idx'), url: 'https://pages.example/index', published_sha: sha('idx'), changed: false }, runs: {} });
  assert.ok(plt(['publish'], p).includes('nothing to publish'));
  assert.ok(plt(['publish', 'index'], p).includes('index: published, up to date — https://pages.example/index'));
  assert.throws(() => plt(['publish', 'TRK-9'], p), /no rendered page for TRK-9/);
  const json = JSON.parse(plt(['publish', '--json'], p));
  assert.deepStrictEqual(json, []);
  // A hand-edited entry with a published sha but no url never prints `undefined`.
  const q = tmpBuild({ 'index.html': 'idx' }, { index: { sha: sha('idx'), published_sha: sha('idx'), changed: false }, runs: {} });
  const up = plt(['publish', 'index'], q);
  assert.ok(up.includes('index: published, up to date') && !up.includes('undefined'), up);
  assert.ok(plt(['publish', '-h'], q).includes('plt publish'));
});

// ---- plan 4 Task 7: plt render names the publish; one writer of published_sha; shared helpers ----

const FIX = path.join(__dirname, 'fixtures', 'spine');
function fixtureProject() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-render-')), 'process');
  fs.cpSync(FIX, p, { recursive: true });
  return p;
}

test('plt render names the next command: plt publish <target> for one pending page, plt publish for several', () => {
  const p = fixtureProject();
  const one = plt(['render', 'index'], p);
  assert.match(one, /^changed: index\nnext: plt publish index\n$/m);
  const spine = require('../lib/spine');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  spine.launchRun(p, { runId: 'TRK-50', cycle: 'spike', repoDir: repo });
  assert.match(plt(['render', 'all'], p), /\nnext: plt publish\n$/);
  // Once every page matches its recorded publish, nothing is named.
  const pages = publish.pendingPublishes(p);
  for (const x of pages) publish.recordPublished(p, x.target, { sha: x.sha, url: `https://pages.example/${x.target}` });
  assert.doesNotMatch(plt(['render', 'index'], p), /next: plt publish/);
});

test('render.recordPublished records the sha of the page on disk, through publish.recordPublished', () => {
  const p = fixtureProject();
  const render = require('../lib/render');
  // writeBuild without publishManifest: the manifest has no sha for the page yet.
  render.writeBuild(p, { index: '<p>fresh</p>' });
  render.recordPublished(p, 'index', 'https://pages.example/idx');
  const e = manifestOf(p).index;
  assert.strictEqual(e.published_sha, sha('<p>fresh</p>'));
  assert.strictEqual(e.url, 'https://pages.example/idx');
  assert.deepStrictEqual(publish.pendingPublishes(p), [], 'the page just published is not pending');
});

test('the build-dir and argument helpers have one definition each', () => {
  const render = require('../lib/render');
  const fsck = require('../lib/fsck');
  for (const k of ['buildDir', 'pageFile', 'readManifest', 'writeManifest']) assert.strictEqual(typeof render[k], 'function', k);
  for (const k of ['parseArgs', 'resolveProcessDir']) assert.strictEqual(typeof fsck[k], 'function', k);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'publish.js'), 'utf8');
  assert.doesNotMatch(src, /function (readManifest|writeManifest|parseArgs|resolveProcessDir)\b|const (buildDir|pageFile) =/);
});

// ---- final review F-5: --published records the page the human published, not a fresh render ----

test('plt render <target> --published records the sha of the page already on disk, and a newer render stays pending', () => {
  const p = fixtureProject();
  plt(['render', 'index'], p);
  const published = fs.readFileSync(path.join(p, 'build', 'index.html'), 'utf8');
  // The state moves on after the human published: a new run appears on the board.
  const spine = require('../lib/spine');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  spine.launchRun(p, { runId: 'TRK-51', cycle: 'spike', repoDir: repo });
  fs.writeFileSync(path.join(p, 'runs', 'TRK-51', 'inputs.yaml'), 'card: TRK-10\neffort: greenhouse\n');
  plt(['render', 'index', '--published', 'index', 'https://pages.example/idx'], p);
  const e = manifestOf(p).index;
  assert.strictEqual(e.published_sha, sha(published), 'the recorded sha is the page the human published');
  assert.notStrictEqual(sha(fs.readFileSync(path.join(p, 'build', 'index.html'), 'utf8')), sha(published), 'the render after it is newer');
  assert.deepStrictEqual(publish.pendingPublishes(p).map((x) => x.target), ['index'], 'so the index is pending');
});
