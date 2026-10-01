'use strict';
// private-citations.test.js — no file that publishes may cite a private-plane path.
//
// publish.sh drops the private-plane paths from every public snapshot. A publishable file
// that links to one of them ships a dead link and names a document the public cannot read.
// This test reads the same patterns publish.sh reads (scripts/denylist-patterns.sh). It lists
// the publishable files the same way: ALLOW, less PRIVATE_ALLOW, plus PRIVATE_EXCEPT. It fails
// on any path in them that resolves to a private-plane path.
//
// A path token is resolved three ways:
//   - from the repo root;
//   - from the file's own directory, when the token starts with ./ or ../ or is a markdown
//     link target;
//   - from punchlist-templates/, when it starts with docs/ (both projects keep a docs/).
// Each `/`-separated suffix of a token is tried too, so a GitHub URL or a ../../docs/ link
// is caught. A sentence's closing punctuation is not part of a path. A dated document named
// with no directory (2026-01-01-x.md) is tried beside the file, in docs/ and in
// punchlist-templates/docs/. A bare process/… path is a spine convention of any project,
// not a citation; it is flagged only when spelled punchlist-templates/process/….
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PATTERNS = path.join(REPO_ROOT, 'scripts', 'denylist-patterns.sh');

// Scripts and tests that DEFINE the private plane or test it. They name its paths as
// patterns and fixtures, never as a document to read, so they are not scanned.
const DEFINES_THE_PLANE = new Set([
  'scripts/denylist-patterns.sh',
  'scripts/publish.sh',
  'scripts/denylist-scan.sh',
  'punchlist-templates/test/denylist.test.js',
  'punchlist-templates/test/private-citations.test.js',
]);

// Tokens a file NAMES without citing a document to read. Each entry is file → the exact
// tokens; any other private-plane path in the same file still fails.
const NAMED_NOT_CITED = {
  // Reads this project's own spine config, and skips when it is absent (the public tree).
  'punchlist-templates/test/effort-cycle-default.test.js': ['../process/config/punchlist.yaml'],
  // States which directories a publish keeps private.
  'docs/releases/README.md': ['punchlist-templates/process/', 'punchlist-templates/docs/plans/'],
};

function loadPatterns() {
  const r = spawnSync('bash', ['-c',
    'source "$1" && printf "%s\\0%s\\0%s" "$ALLOW" "$PRIVATE_ALLOW" "$PRIVATE_EXCEPT"', '_', PATTERNS],
    { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `sourcing denylist-patterns.sh failed: ${r.stderr}`);
  const [allow, priv, except] = r.stdout.split('\0');
  assert.ok(allow && priv, 'ALLOW and PRIVATE_ALLOW must be set');
  // The scripts match these with grep -E; this test compiles them as JS. The two agree on
  // today's syntax. A POSIX bracket class would compile in JS and match the wrong set.
  for (const p of [allow, priv, except]) assert.ok(!p.includes('[[:'), `POSIX class in a pattern: ${p}`);
  return {
    allow: new RegExp(allow),
    priv: new RegExp(priv),
    except: except ? new RegExp(except) : null, // publish.sh reads an empty pattern as "none"
  };
}

function isPrivate(p, pat) {
  return pat.priv.test(p) && !(pat.except && pat.except.test(p));
}

const TOKEN = /(?:\.{1,2}\/)*[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]*)+/g;
const DATED_NAME = /(?<![A-Za-z0-9_\/.-])[0-9]{4}-[0-9]{2}-[0-9]{2}-[A-Za-z0-9_.-]*\.md\b/g;
const LINK_TARGET = /\]\(([^)\s#]+)|\b(?:href|src)="([^"#]+)"/g;
const trimPunct = (t) => t.replace(/[.,:;]+$/, '');

// candidates(file, token, isLink) -> the repo-relative paths a token could mean.
function candidates(file, token, isLink) {
  const out = new Set();
  const add = (p) => {
    const n = path.posix.normalize(p).replace(/^\.\//, '');
    if (!n.startsWith('..')) out.add(n);
  };
  const parts = token.split('/');
  for (let i = 0; i < parts.length; i++) {
    const t = parts.slice(i).join('/');
    if (!t || t.startsWith('/')) continue;
    add(t);
    if (t.startsWith('docs/')) add(`punchlist-templates/${t}`);
  }
  if (isLink || token.startsWith('./') || token.startsWith('../') || !token.includes('/')) {
    add(path.posix.join(path.posix.dirname(file), token));
  }
  if (!token.includes('/')) {
    add(`docs/${token}`);
    add(`punchlist-templates/docs/${token}`);
  }
  return [...out];
}

// scan(file, text, pat) -> [{ line, token, resolves }]
function scan(file, text, pat) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    const links = new Set([...line.matchAll(LINK_TARGET)].map((m) => trimPunct(m[1] || m[2])));
    const tokens = new Set([...(line.match(TOKEN) || []), ...(line.match(DATED_NAME) || []), ...links].map(trimPunct));
    for (const token of tokens) {
      const bad = candidates(file, token, links.has(token)).find((c) => isPrivate(c, pat));
      if (bad) hits.push({ line: i + 1, token, resolves: bad });
    }
  });
  return hits;
}

function publishableFiles(pat) {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split('\0').filter(Boolean)
    .filter((f) => pat.allow.test(f) && !isPrivate(f, pat));
}

test('the scanner catches each shape of citation to a private-plane path', (t) => {
  if (!fs.existsSync(PATTERNS)) return t.skip('scripts/denylist-patterns.sh is not in this tree');
  const pat = loadPatterns();
  const cases = [
    ['README.md', 'See [the design](docs/2026-01-01-design.md).'],
    ['punchlist-templates/README.md', 'Full contract: [prd](docs/2026-01-01-prd.md).'],
    ['punchlist-templates/lib/x.js', '// tracked in docs/plans/2026-01-01-plan.md'],
    ['src/x.js', '// see ../docs/2026-01-01-notes.md'],
    ['bin/x', '// https://github.com/o/r/blob/master/docs/2026-01-01-adr.md'],
    ['punchlist-templates/lib/x.js', "read('punchlist-templates/process/efforts/e.yaml')"],
    ['README.md', 'The full design is in docs/2026-01-01-design.md.'],
    ['README.md', 'CI runs from .github/workflows/ci.yml, at the root.'],
    ['punchlist-templates/README.md', '<a href="process/efforts/e.yaml">the effort</a>'],
    ['docs/macos-setup.md', 'see 2026-01-01-kb.md for the rationale'],
    ['docs/releases/README.md', 'Background: [design](../2026-01-01-design.md).'],
  ];
  for (const [file, text] of cases) {
    assert.strictEqual(scan(file, text, pat).length, 1, `${file}: ${text}`);
  }
});

test('the scanner passes public paths and spine conventions', (t) => {
  if (!fs.existsSync(PATTERNS)) return t.skip('scripts/denylist-patterns.sh is not in this tree');
  const pat = loadPatterns();
  const cases = [
    ['README.md', 'See [macOS setup](docs/macos-setup.md) and [notes](docs/releases/).'],
    ['punchlist-templates/README.md', 'Config lives at `process/config/punchlist.yaml`.'],
    ['punchlist-templates/lib/x.js', "// base: punchlist-templates/process/config/defaults.yaml"],
    ['punchlist-templates/README.md', 'bin/plt fan plans/greenhouse-plan.md'],
    ['README.md', 'Release notes are in docs/releases/v1.1.0.md.'],
  ];
  for (const [file, text] of cases) {
    assert.deepStrictEqual(scan(file, text, pat), [], `${file}: ${text}`);
  }
});

test('every NAMED_NOT_CITED token still occurs in its file', () => {
  // A stale entry would quietly allow a later citation that happens to reuse the token.
  for (const [f, tokens] of Object.entries(NAMED_NOT_CITED)) {
    const text = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
    for (const tok of tokens) assert.ok(text.includes(tok), `${f} no longer names ${tok}: drop it from NAMED_NOT_CITED`);
  }
});

test('no publishable file cites a private-plane path', (t) => {
  if (!fs.existsSync(PATTERNS)) return t.skip('scripts/denylist-patterns.sh is not in this tree');
  const pat = loadPatterns();
  const files = publishableFiles(pat);
  if (!files) return t.skip('not a git checkout');
  // An empty list would pass with nothing scanned, which happens when REPO_ROOT is
  // untracked inside another repo.
  assert.ok(files.includes('package.json'), 'git ls-files did not list this repo\'s own files');
  const found = [];
  for (const f of files) {
    if (DEFINES_THE_PLANE.has(f)) continue;
    let text;
    try { text = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') continue; // deleted in the working tree, not yet committed
      found.push(`${f} — unreadable, so not scanned: ${e.code}`);
      continue;
    }
    if (text.includes('\0')) continue; // binary
    const named = NAMED_NOT_CITED[f] || [];
    for (const h of scan(f, text, pat)) if (!named.includes(h.token)) found.push(`${f}:${h.line} — ${h.token} (→ ${h.resolves})`);
  }
  assert.deepStrictEqual(found, [], `publishable files cite private-plane paths:\n  ${found.join('\n  ')}`);
});
