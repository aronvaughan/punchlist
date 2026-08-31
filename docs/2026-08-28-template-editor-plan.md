# AI-assisted template editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the admin edit a reusable template definition from inside punchlist, conversationally, with the local `claude` CLI — validated by `plt` and committed (not pushed) to the `punchlist-templates` repo.

**Architecture:** Three admin-only, feature-gated endpoints on the existing Hono app read/AI-edit/save a template `.md`. All process work (`claude`, `plt`, `git`) goes through a single **injectable `run` executor** so tests stay hermetic (no real CLIs, no network). The chat is stateless server-side; the draft + thread live in the browser's `localStorage`. UI is a pencil beside the existing template picker that opens a drawer-scoped dialog.

**Tech Stack:** Node 26 + Hono, `node:sqlite`, `node:test`; vanilla ES-module front end with `wa-*` components + `md.js`. Zero new runtime deps.

**Design record:** `docs/2026-08-28-template-editor-design.md`. Deferred/v2 scope: task `01M15BR5N9QASBYAF5FZXFS38R`.

---

## File Structure

- `src/templates.js` **(create)** — pure/near-pure helpers: resolve a template name → path, the `<<<NOTE / <<<TEMPLATE` parser, the prompt builder, and the real `run` executor. Kept out of `api.js` so it's unit-testable and `api.js` doesn't grow.
- `src/api.js` **(modify)** — accept a `templateEditing` config in `buildApp`, compute the feature-gate, add the three routes, extend `GET /api/v1/config`.
- `public/tpleditor.js` **(create)** — the editor dialog (chat + live draft + localStorage + save).
- `public/detail.js` **(modify)** — add the pencil affordance to `templateEditor()`, gated by the config probe.
- `public/index.html` **(modify)** — add the `<wa-dialog id="tpl-editor-dialog">` shell.
- `test/templates.test.js` **(create)** — unit tests for the parser + name resolution.
- `test/api.test.js` **(modify)** — endpoint tests with a stub `run`.
- `test/ui-smoke.test.js` **(modify)** — pencil visibility + dialog open.

---

## Task 1: The `run` executor seam + template helpers module

**Files:**
- Create: `src/templates.js`
- Test: `test/templates.test.js`

- [ ] **Step 1: Write the failing test for `parseAiReply`**

```js
// test/templates.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAiReply } from '../src/templates.js';

test('parseAiReply: splits NOTE and TEMPLATE blocks', () => {
  const raw = [
    'preamble the parser must ignore',
    '<<<NOTE', 'Added a priority input.', 'NOTE',
    '<<<TEMPLATE', '---', 'name: coding-task', '---', '## Purpose', 'body', 'TEMPLATE',
  ].join('\n');
  const { note, draft } = parseAiReply(raw);
  assert.equal(note, 'Added a priority input.');
  assert.equal(draft, '---\nname: coding-task\n---\n## Purpose\nbody');
});

test('parseAiReply: missing TEMPLATE block throws', () => {
  assert.throws(() => parseAiReply('<<<NOTE\nhi\nNOTE'), /no template block/i);
});

test('parseAiReply: missing NOTE tolerated (empty note)', () => {
  const { note, draft } = parseAiReply('<<<TEMPLATE\n---\nname: x\n---\nbody\nTEMPLATE');
  assert.equal(note, '');
  assert.equal(draft, '---\nname: x\n---\nbody');
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --test test/templates.test.js`
Expected: FAIL — `parseAiReply` is not exported.

- [ ] **Step 3: Implement `src/templates.js` (parser + resolver + prompt + real run)**

```js
// src/templates.js — helpers for the AI-assisted template editor.
import { existsSync, readdirSync, realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

// Split the model's reply into a human note and the revised template markdown.
// Contract (see design doc): optional <<<NOTE..NOTE, required <<<TEMPLATE..TEMPLATE.
export function parseAiReply(raw) {
  const block = (tag) => {
    const m = raw.match(new RegExp(`<<<${tag}\\n([\\s\\S]*?)\\n${tag}(?:\\n|$)`));
    return m ? m[1] : null;
  };
  const draft = block('TEMPLATE');
  if (draft == null) throw new Error('AI reply had no template block');
  return { note: (block('NOTE') ?? '').trim(), draft: draft.replace(/\s+$/, '') };
}

// name -> absolute path of the resolved template file (authored wins over packs),
// or null. Only a-z0-9- names; the returned path is realpath-contained under
// <dir>/templates so a crafted name can never escape the repo.
export function resolveTemplatePath(dir, name) {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const root = join(dir, 'templates');
  const candidates = [join(root, 'authored', `${name}.md`)];
  const packs = join(root, 'packs');
  if (existsSync(packs)) {
    for (const p of readdirSync(packs)) candidates.push(join(packs, p, `${name}.md`));
  }
  const realRoot = realpathSync(root);
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    const real = realpathSync(c);
    if (real === realRoot || real.startsWith(realRoot + '/')) return real;
  }
  return null;
}

export function readTemplate(dir, name) {
  const p = resolveTemplatePath(dir, name);
  return p ? readFileSync(p, 'utf8') : null;
}

// The text-only editing prompt. The model gets NO tools; its only job is to
// return the revised markdown between the delimiters.
export function buildEditPrompt({ name, draft, messages }) {
  const thread = messages.map(m => `${m.role === 'user' ? 'OWNER' : 'YOU'}: ${m.content}`).join('\n\n');
  return [
    `You are editing the punchlist template "${name}". You transform markdown ONLY.`,
    'Do not use any tools. Do not run commands. Return your answer EXACTLY as:',
    '<<<NOTE', 'one sentence describing what you changed', 'NOTE',
    '<<<TEMPLATE', '...the FULL revised template markdown (frontmatter + body)...', 'TEMPLATE',
    '', 'CURRENT TEMPLATE:', draft, '', 'CONVERSATION:', thread,
  ].join('\n');
}

// Default executor: promisified execFile with a hard timeout and captured
// output. Injected as `run` in buildApp; tests pass a stub with the same shape.
// Returns { code, stdout, stderr }; never rejects on a non-zero exit.
export function makeRunner() {
  return ({ cmd, args, cwd, input, timeoutMs = 120000 }) => new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? (err ? String(err.message) : '') }));
    if (input != null) { child.stdin.end(input); }
  });
}
```

- [ ] **Step 4: Run the tests, verify pass**

Run: `node --test test/templates.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/templates.js test/templates.test.js
git commit -m "feat(templates): parser + name resolver + injectable run executor for the template editor"
```

---

## Task 2: Wire the feature-gate + config probe into `buildApp`

**Files:**
- Modify: `src/api.js` (`buildApp` signature ~184, `GET /api/v1/config` ~1269)
- Modify: `test/api.test.js` (`makeApp` ~16)

- [ ] **Step 1: Write the failing test**

```js
// in test/api.test.js — add near the config-probe tests.
test('config: template_editing reflects the feature gate', async () => {
  // default makeApp() wires no templateEditing -> feature off
  const off = await (makeApp().call)('GET', '/api/v1/config');
  assert.equal(off.json.template_editing, false);
  // a wired app with a stub runner + present dir -> on for the admin only
  const on = makeAppWithTemplates();           // helper added below
  assert.equal((await on.call('GET', '/api/v1/config')).json.template_editing, true);
  assert.equal((await on.call('GET', '/api/v1/config', { token: TOK_CLAUDE })).json.template_editing, false);
});
```

Add this helper beside `makeApp` in `test/api.test.js`:

```js
// A makeApp variant that wires a HERMETIC template-editing backend: a fake repo
// dir marked available, and a stub `run` that records calls and returns canned
// output keyed by the command. Individual tests override `runImpl`.
function makeAppWithTemplates(runImpl) {
  const { db, migrate } = open(':memory:');
  migrate();
  const calls = [];
  const run = async (spec) => { calls.push(spec); return (runImpl || (() => ({ code: 0, stdout: '', stderr: '' })))(spec); };
  const app = buildApp({
    db, tokens: { alex: TOK_ARON, claude: TOK_CLAUDE, hermes: TOK_HERMES, email: TOK_EMAIL },
    today: () => TODAY,
    templateEditing: { dir: '/fake/templates-repo', available: true, run },
  });
  const call = async (method, path, { body, token = TOK_ARON } = {}) => {
    const headers = {}; if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await app.fetch(new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  return { db, app, call, calls };
}
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --test test/api.test.js`
Expected: FAIL — `template_editing` is undefined; `templateEditing` config ignored.

- [ ] **Step 3: Implement the gate in `buildApp`**

In the `buildApp({ ... })` destructure (line 184-185), add `templateEditing` to the params. After the `DOC_ROOTS`/`HUMAN` block (~line 201), add:

```js
  // AI-assisted template editing (admin-only, feature-gated). Available only
  // when a templates repo dir is configured AND the `claude` binary is present.
  // Tests inject { dir, available, run } directly; production computes them.
  const TPL = resolveTemplateEditing(templateEditing);
```

Add this module-level helper near `resolveDocRoots` (~line 158):

```js
// Resolve the template-editing config. Accepts an explicit object (tests) or
// falls back to env + a one-time `claude --version` probe (production). Returns
// { dir, available, run }. `available` is the boot-time gate; routes re-check
// dir existence per request so a repo that disappears degrades to 404.
export function resolveTemplateEditing(cfg) {
  if (cfg) {
    const run = cfg.run || makeRunner();
    const dir = cfg.dir;
    const available = cfg.available !== undefined ? cfg.available
      : Boolean(dir && existsSync(join(dir, '.git')) && hasClaudeBinary());
    return { dir, available, run };
  }
  const dir = process.env.PUNCHLIST_TEMPLATES_DIR ||
    join(dirname(ROOT_DIR), 'punchlist-templates');
  const available = Boolean(dir && existsSync(join(dir, '.git')) && hasClaudeBinary());
  return { dir, available, run: makeRunner() };
}

let _hasClaude = null;
function hasClaudeBinary() {
  if (_hasClaude !== null) return _hasClaude;
  try { execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 5000 }); _hasClaude = true; }
  catch { _hasClaude = false; }
  return _hasClaude;
}
```

Add imports at the top of `api.js`: `execFileSync` from `node:child_process`, and `resolveTemplateEditing`'s deps — import `makeRunner`, `parseAiReply`, `resolveTemplatePath`, `readTemplate`, `buildEditPrompt` from `./templates.js`. (`existsSync`, `join`, `homedir` are already imported.)

Extend the config probe (~line 1269):

```js
  app.get('/api/v1/config', c => c.json({
    doc_linking: DOC_ROOTS.length > 0,
    template_editing: TPL.available && c.get('actor') === HUMAN,
    untrusted_actors: [...UNTRUSTED],
    max_doc_bytes: MAX_DOC,
    actor: c.get('actor'),
  }));
```

- [ ] **Step 4: Run the tests, verify pass**

Run: `node --test test/api.test.js`
Expected: PASS — off=false, on(admin)=true, on(claude)=false.

- [ ] **Step 5: Commit**

```bash
git add src/api.js test/api.test.js
git commit -m "feat(templates): feature-gate + config probe for template editing (admin-only)"
```

---

## Task 3: `GET /api/v1/templates/:name` — read a template for editing

**Files:**
- Modify: `src/api.js` (near the existing `GET /api/v1/templates` ~1509)
- Modify: `test/api.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('GET /templates/:name: admin reads resolved md; gating + traversal', async () => {
  const app = makeAppWithTemplates();
  // stub resolveTemplatePath via the run seam is not enough — read goes through
  // the fs, so this test uses a real temp repo:
  const { dir, cleanup } = realTemplatesRepo({ 'authored/demo.md': '---\nname: demo\n---\nbody' });
  const a = appWithDir(dir);                      // helper: buildApp with available:true, real fs
  const ok = await a.call('GET', '/api/v1/templates/demo');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.markdown, '---\nname: demo\n---\nbody');
  assert.equal(ok.json.name, 'demo');
  // non-admin -> 403
  assert.equal((await a.call('GET', '/api/v1/templates/demo', { token: TOK_CLAUDE })).status, 403);
  // unknown -> 404; traversal -> 404 (charset reject)
  assert.equal((await a.call('GET', '/api/v1/templates/missing')).status, 404);
  assert.equal((await a.call('GET', '/api/v1/templates/..%2f..%2fetc%2fpasswd')).status, 404);
  cleanup();
});
```

Add two small test helpers beside `makeAppWithTemplates`:

```js
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

function realTemplatesRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pl-tpl-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, 'templates', rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: dir });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// buildApp over a real templates dir, with an injectable run (default: real).
function appWithDir(dir, runImpl) {
  const { db, migrate } = open(':memory:'); migrate();
  const calls = [];
  const run = async (spec) => { calls.push(spec); return (runImpl || (() => ({ code: 0, stdout: '', stderr: '' })))(spec); };
  const app = buildApp({
    db, tokens: { alex: TOK_ARON, claude: TOK_CLAUDE, hermes: TOK_HERMES, email: TOK_EMAIL },
    today: () => TODAY, templateEditing: { dir, available: true, run },
  });
  const call = async (method, path, { body, token = TOK_ARON } = {}) => {
    const headers = {}; if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await app.fetch(new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  return { db, app, call, calls, dir };
}
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --test test/api.test.js`
Expected: FAIL — route not found (404 for the admin read too, and 403 assertion fails).

- [ ] **Step 3: Implement the route**

Add a small guard helper inside `buildApp` (near the other route helpers) and the route beside the existing templates list route (~1518):

```js
  // Admin + feature gate shared by every template-editing route. 404 (not 403)
  // when the feature is off, so its existence isn't advertised to non-admins.
  function requireTemplateEditing(c) {
    if (!TPL.available || !existsSync(join(TPL.dir, '.git'))) throw new ApiError(404, 'not found');
    if (c.get('actor') !== HUMAN) throw new ApiError(403, `only the admin (${HUMAN}) can edit templates`);
  }

  app.get('/api/v1/templates/:name', c => {
    requireTemplateEditing(c);
    const name = c.req.param('name');
    const markdown = readTemplate(TPL.dir, name);
    if (markdown == null) throw new ApiError(404, 'template not found');
    return c.json({ name, markdown });
  });
```

Note: the admin gate deliberately runs AFTER the feature gate, so a non-admin on a feature-off instance gets 404, and a non-admin on a feature-on instance gets 403 (proves the feature exists only to the admin).

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test test/api.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api.js test/api.test.js
git commit -m "feat(templates): GET /templates/:name reads the resolved template (admin, contained)"
```

---

## Task 4: `POST /api/v1/templates/:name/ai-edit` — one conversational turn

**Files:**
- Modify: `src/api.js`
- Modify: `test/api.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('POST /templates/:name/ai-edit: spawns claude text-only, returns note+draft', async () => {
  const reply = '<<<NOTE\nAdded a priority input.\nNOTE\n<<<TEMPLATE\n---\nname: demo\n---\nnew body\nTEMPLATE';
  const { dir, cleanup } = realTemplatesRepo({ 'authored/demo.md': '---\nname: demo\n---\nold' });
  const a = appWithDir(dir, (spec) => spec.cmd === 'claude' ? { code: 0, stdout: reply, stderr: '' } : { code: 0, stdout: '', stderr: '' });
  const r = await a.call('POST', '/api/v1/templates/demo/ai-edit', {
    body: { draft: '---\nname: demo\n---\nold', messages: [{ role: 'user', content: 'add a priority input' }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.reply, 'Added a priority input.');
  assert.match(r.json.draft, /new body/);
  // it invoked claude with -p and NO tool-enabling flags, in the repo dir
  const claudeCall = a.calls.find(s => s.cmd === 'claude');
  assert.ok(claudeCall.args.includes('-p'));
  assert.ok(claudeCall.args.includes('--no-session-persistence'));
  // non-admin 403
  assert.equal((await a.call('POST', '/api/v1/templates/demo/ai-edit', { token: TOK_CLAUDE, body: { draft: 'x', messages: [] } })).status, 403);
  cleanup();
});

test('POST /templates/:name/ai-edit: unparseable reply -> 502, no crash', async () => {
  const { dir, cleanup } = realTemplatesRepo({ 'authored/demo.md': 'x' });
  const a = appWithDir(dir, () => ({ code: 0, stdout: 'garbage, no delimiters', stderr: '' }));
  const r = await a.call('POST', '/api/v1/templates/demo/ai-edit', { body: { draft: 'x', messages: [] } });
  assert.equal(r.status, 502);
  cleanup();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --test test/api.test.js`
Expected: FAIL — route missing.

- [ ] **Step 3: Implement the route**

```js
  app.post('/api/v1/templates/:name/ai-edit', async c => {
    requireTemplateEditing(c);
    const name = c.req.param('name');
    const body = await readJson(c);
    if (typeof body.draft !== 'string' || !Array.isArray(body.messages)) {
      throw new ApiError(400, 'draft (string) and messages (array) required');
    }
    for (const m of body.messages) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
        throw new ApiError(400, 'each message needs role user|assistant and string content');
      }
    }
    const prompt = buildEditPrompt({ name, draft: body.draft, messages: body.messages });
    // text-only: -p prints the reply and exits; --no-session-persistence keeps it
    // stateless. No --allowedTools / no MCP: the process is given nothing to act with.
    const { code, stdout, stderr } = await TPL.run({
      cmd: 'claude', args: ['-p', '--no-session-persistence', prompt], cwd: TPL.dir, timeoutMs: 120000,
    });
    if (code !== 0) throw new ApiError(502, `claude failed: ${stderr.slice(0, 500)}`);
    let parsed;
    try { parsed = parseAiReply(stdout); }
    catch { throw new ApiError(502, 'could not parse the AI reply'); }
    return c.json({ reply: parsed.note, draft: parsed.draft });
  });
```

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test test/api.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api.js test/api.test.js
git commit -m "feat(templates): POST /ai-edit runs claude text-only, returns note+draft"
```

---

## Task 5: `POST /api/v1/templates/:name/save` — validate → write → commit

**Files:**
- Modify: `src/api.js`
- Modify: `test/api.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('POST /templates/:name/save: valid draft validates, writes authored/, commits', async () => {
  const { dir, cleanup } = realTemplatesRepo({ 'packs/core/demo.md': '---\nname: demo\n---\norig' });
  // stub: plt validate OK; git add/commit report success. The WRITE is real fs.
  const a = appWithDir(dir, (s) => s.cmd === 'plt' ? { code: 0, stdout: 'OK', stderr: '' } : { code: 0, stdout: '', stderr: '' });
  const draft = '---\nname: demo\n---\nedited body';
  const r = await a.call('POST', '/api/v1/templates/demo/save', { body: { draft } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  // wrote the OVERRIDE into authored/, not the pack
  assert.equal(readFileSync(join(dir, 'templates', 'authored', 'demo.md'), 'utf8'), draft);
  assert.equal(readFileSync(join(dir, 'templates', 'packs', 'core', 'demo.md'), 'utf8'), '---\nname: demo\n---\norig');
  // validated a temp file named demo.md, then git add + commit ran
  assert.ok(a.calls.some(s => s.cmd === 'plt' && s.args[0] === 'validate' && s.args[1].endsWith('/demo.md')));
  assert.ok(a.calls.some(s => s.cmd === 'git' && s.args.includes('commit')));
  cleanup();
});

test('POST /templates/:name/save: invalid draft -> 422, nothing written/committed', async () => {
  const { dir, cleanup } = realTemplatesRepo({ 'authored/demo.md': '---\nname: demo\n---\norig' });
  const a = appWithDir(dir, (s) => s.cmd === 'plt' ? { code: 1, stdout: 'FAIL  demo.md:3: missing golden exemplar', stderr: '' } : { code: 0, stdout: '', stderr: '' });
  const r = await a.call('POST', '/api/v1/templates/demo/save', { body: { draft: '---\nname: demo\n---\nbad' } });
  assert.equal(r.status, 422);
  assert.equal(r.json.ok, false);
  assert.match(r.json.validation, /golden exemplar/);
  assert.equal(readFileSync(join(dir, 'templates', 'authored', 'demo.md'), 'utf8'), '---\nname: demo\n---\norig', 'unchanged');
  assert.ok(!a.calls.some(s => s.cmd === 'git' && s.args.includes('commit')), 'no commit on invalid');
  cleanup();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --test test/api.test.js`
Expected: FAIL — route missing.

- [ ] **Step 3: Implement the route**

Add `mkdtempSync`, `mkdirSync` to the `node:fs` import in `api.js` (`writeFileSync`, `existsSync`, `realpathSync` already imported); add `tmpdir` from `node:os`.

```js
  app.post('/api/v1/templates/:name/save', async c => {
    requireTemplateEditing(c);
    const name = c.req.param('name');
    if (!/^[a-z0-9-]+$/.test(name)) throw new ApiError(404, 'template not found');
    const body = await readJson(c);
    if (typeof body.draft !== 'string' || body.draft.length === 0) throw new ApiError(400, 'draft (non-empty string) required');
    if (body.draft.length > 65536) throw new ApiError(400, 'template too large');

    // 1) validate a temp copy NAMED <name>.md (filename must match for plt).
    const tmp = mkdtempSync(join(tmpdir(), 'pl-tpl-save-'));
    const tmpFile = join(tmp, `${name}.md`);
    writeFileSync(tmpFile, body.draft);
    const v = await TPL.run({ cmd: 'plt', args: ['validate', tmpFile], cwd: TPL.dir, timeoutMs: 30000 });
    rmSync(tmp, { recursive: true, force: true });
    if (v.code !== 0) {
      return c.json({ ok: false, validation: (v.stdout + v.stderr).trim() || 'validation failed' }, 422);
    }

    // 2) write the override into authored/, then commit (no push). `name` is
    // already constrained to ^[a-z0-9-]+$ above, so the join cannot traverse —
    // that charset guard IS the containment here.
    const authoredDir = join(TPL.dir, 'templates', 'authored');
    mkdirSync(authoredDir, { recursive: true });
    const dest = join(authoredDir, `${name}.md`);
    writeFileSync(dest, body.draft);
    const relDest = join('templates', 'authored', `${name}.md`);
    await TPL.run({ cmd: 'git', args: ['add', '--', relDest], cwd: TPL.dir, timeoutMs: 15000 });
    const commit = await TPL.run({ cmd: 'git', args: ['commit', '-m', `template(${name}): AI-assisted edit via punchlist`, '--', relDest], cwd: TPL.dir, timeoutMs: 15000 });
    return c.json({ ok: true, validation: (v.stdout || 'OK').trim(), committed: commit.code === 0 });
  });
```

> Note for the implementer: the containment line above is over-clever — simplify to a plain check: `dest` must be `join(authoredDir, name + '.md')` and `name` already matches `^[a-z0-9-]+$`, so it cannot traverse. Drop the `realpathSync(mkdirSync(...))` expression; just `mkdirSync(authoredDir,{recursive:true}); writeFileSync(dest, body.draft);`. Keep the charset guard as the real defense.

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test test/api.test.js`
Expected: PASS — valid path writes authored/ + commits; invalid path 422 with no write, no commit.

- [ ] **Step 5: Commit**

```bash
git add src/api.js test/api.test.js
git commit -m "feat(templates): POST /save validates via plt, writes authored/ override, commits (no push)"
```

---

## Task 6: UI — the pencil affordance, gated by the config probe

**Files:**
- Modify: `public/detail.js` (`templateEditor()` ~227; there is an existing config fetch pattern for doc-linking — reuse it)
- Modify: `public/index.html` (add the dialog shell)

- [ ] **Step 1: Add the dialog shell to `index.html`**

Near the other `<wa-dialog>` elements, add:

```html
<wa-dialog id="tpl-editor-dialog" label="Edit template" style="--width: 42rem;">
  <div id="tpl-editor-mount"></div>
</wa-dialog>
```

- [ ] **Step 2: Gate + render the pencil in `templateEditor()`**

Find where `config` (from `GET /api/v1/config`) is already loaded in the front end (the doc-linking affordance uses it). Reuse that cached config. In `renderChip()` / after building `row`, add a pencil button shown only when `config.template_editing && current.template`:

```js
  // pencil: opens the AI editor for the currently-selected template. Shown only
  // when the server says the feature is available to this actor (admin + claude
  // present + templates repo) AND a template is set.
  const pencil = el('button', 'icon-btn tpl-edit-btn');
  pencil.append(icon('pencil-simple', { size: 14 }));
  pencil.title = 'Edit this template with AI';
  const syncPencil = () => { pencil.hidden = !(appConfig()?.template_editing && current.template); };
  pencil.addEventListener('click', async () => {
    const { openTemplateEditor } = await import('./tpleditor.js');
    openTemplateEditor(current.template);
  });
  row.append(sel, chip, pencil);
  // call syncPencil() in renderChip() and after populate()
```

(`appConfig()` = the module's cached `GET /api/v1/config` result; if the front end doesn't cache it yet, add a `let _config; async function appConfig(){ if(!_config) _config = await api('GET','/config'); return _config; }` in `detail.js`.)

- [ ] **Step 3: Manual check**

Start the app against a real templates repo (`PUNCHLIST_TEMPLATES_DIR` set, `claude` on PATH), open a task, set a template → pencil appears. Unset the template or open as a non-admin token → pencil hidden. (No automated assert here; Task 8 covers a smoke test.)

- [ ] **Step 4: Commit**

```bash
git add public/detail.js public/index.html
git commit -m "feat(templates): pencil affordance opens the template editor (config-gated)"
```

---

## Task 7: UI — the editor dialog (chat + live draft + localStorage + save)

**Files:**
- Create: `public/tpleditor.js`

- [ ] **Step 1: Implement the module**

```js
// public/tpleditor.js — conversational, AI-assisted template editor.
// Draft + thread persist in localStorage keyed by template name; cleared on save.
import { el, icon, api, toast } from './app.js';   // match detail.js's imports
import { mdToHtml } from './md.js';

const key = (name) => `pl.tpl-edit.${name}`;
const load = (name) => { try { return JSON.parse(localStorage.getItem(key(name))) || null; } catch { return null; } };
const save = (name, state) => { try { localStorage.setItem(key(name), JSON.stringify(state)); } catch {} };
const clear = (name) => { try { localStorage.removeItem(key(name)); } catch {} };

export async function openTemplateEditor(name) {
  const dialog = document.getElementById('tpl-editor-dialog');
  const mount = document.getElementById('tpl-editor-mount');
  dialog.label = `Edit template: ${name}`;

  // restore a stored draft/thread, else fetch the on-disk template as the draft.
  let state = load(name);
  if (!state) {
    const { markdown } = await api('GET', `/templates/${encodeURIComponent(name)}`);
    state = { draft: markdown, messages: [] };
  }

  const preview = el('div', 'tpl-preview md-body');
  const thread = el('div', 'tpl-thread');
  const input = el('textarea', 'tpl-instruction');
  input.placeholder = 'Describe a change… (e.g. add a priority input; tighten the output shape)';
  const unsaved = el('span', 'tpl-unsaved-dot'); unsaved.title = 'unsaved changes';
  const status = el('div', 'tpl-status');

  const renderPreview = () => { preview.innerHTML = mdToHtml(state.draft); };
  const renderThread = () => {
    thread.replaceChildren(...state.messages.map(m =>
      el('div', `tpl-msg tpl-${m.role}`, m.content)));
  };
  const markUnsaved = () => { unsaved.hidden = !load(name); };
  renderPreview(); renderThread(); markUnsaved();

  const send = async () => {
    const text = input.value.trim(); if (!text) return;
    input.value = ''; input.disabled = true;
    state.messages.push({ role: 'user', content: text }); renderThread();
    try {
      const { reply, draft } = await api('POST', `/templates/${encodeURIComponent(name)}/ai-edit`,
        { draft: state.draft, messages: state.messages });
      state.draft = draft;
      state.messages.push({ role: 'assistant', content: reply || '(updated)' });
      save(name, state); renderThread(); renderPreview(); markUnsaved();
    } catch (e) {
      state.messages.pop();           // drop the user turn we couldn't answer
      renderThread(); toast(`AI edit failed: ${e.message}`, 'danger');
    } finally { input.disabled = false; input.focus(); }
  };

  const doSave = async () => {
    status.textContent = 'Validating…';
    try {
      const res = await api('POST', `/templates/${encodeURIComponent(name)}/save`, { draft: state.draft });
      if (res.ok) { clear(name); markUnsaved(); status.textContent = '✓ Saved & committed'; toast('Template saved', 'success'); }
    } catch (e) {
      // 422 surfaces validation text via api()'s error body
      status.textContent = `✗ ${e.message}`;
    }
  };

  const revert = async () => {
    clear(name);
    const { markdown } = await api('GET', `/templates/${encodeURIComponent(name)}`);
    state = { draft: markdown, messages: [] };
    renderPreview(); renderThread(); markUnsaved(); status.textContent = 'Reverted to saved';
  };

  const sendBtn = el('button', 'wa-primary', 'Send'); sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); });
  const saveBtn = el('button', 'wa-primary', 'Save current draft'); saveBtn.addEventListener('click', doSave);
  const revertBtn = el('button', null, 'Revert to saved'); revertBtn.addEventListener('click', revert);

  const header = el('div', 'tpl-editor-header'); header.append(unsaved, status);
  const composer = el('div', 'tpl-composer'); composer.append(input, sendBtn);
  const actions = el('div', 'tpl-actions'); actions.append(saveBtn, revertBtn);
  mount.replaceChildren(header, el('div', 'tpl-cols', ...[thread, preview]), composer, actions);
  // autosave the draft as the user goes (covers a mid-turn close)
  save(name, state); markUnsaved();
  dialog.open = true;
}
```

> Implementer notes: match the ACTUAL exports of `app.js` (`el`, `icon`, `api`, `toast`) — if `toast`/`api` have different names/signatures, adapt. `api()` must throw on non-2xx with the server error message so the 422 validation text reaches `status`. Add minimal styles in `public/tokens.css` for `.tpl-cols` (two columns → stack on narrow/phone), `.tpl-thread`, `.tpl-msg`, `.tpl-preview`, `.tpl-unsaved-dot` (a small amber dot). Keep to theme tokens only.

- [ ] **Step 2: Manual round-trip check**

Feature-on instance: open editor, send "add a `priority` input", watch the preview update; close the dialog and reopen → draft + thread restored (localStorage). Save → validates; a deliberately-broken draft (delete the golden exemplar) → the `plt` error shows in `status`, nothing committed. `git log` in the templates repo shows the commit on success.

- [ ] **Step 3: Commit**

```bash
git add public/tpleditor.js public/tokens.css
git commit -m "feat(templates): conversational template editor dialog (localStorage draft, save+validate)"
```

---

## Task 8: UI smoke test + docs

**Files:**
- Modify: `test/ui-smoke.test.js`
- Modify: `README.md` (a short subsection), `docs/2026-08-28-template-editor-design.md` (mark shipped)

- [ ] **Step 1: Add a smoke assertion**

Match the existing `ui-smoke.test.js` style (it already asserts modules parse / key elements exist). Add: `public/tpleditor.js` parses as a module and exports `openTemplateEditor`; `index.html` contains `id="tpl-editor-dialog"`. If the smoke suite uses a DOM shim to assert the pencil hides without `template_editing`, add that; otherwise keep it static (parse + presence), since the real interaction is covered by the manual checks and the endpoint tests.

- [ ] **Step 2: Run the FULL suite + coverage**

Run: `npm test`
Expected: all green, coverage ≥ 80% floor (the new endpoints + parser are covered by Tasks 1-5; `tpleditor.js` is UI and may be excluded from coverage like other `public/*.js` — confirm against how coverage currently treats `public/`).

- [ ] **Step 3: Document**

- README: one short paragraph under a "Edit templates with AI" heading — admin-only, needs `claude` on PATH + `PUNCHLIST_TEMPLATES_DIR`, commits (not pushes) to the templates repo.
- Design doc: add a "Shipped 2026-08-28" line at the top.

- [ ] **Step 4: Commit**

```bash
git add test/ui-smoke.test.js README.md docs/2026-08-28-template-editor-design.md
git commit -m "test+docs: template editor smoke test + README/design notes"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** entry point (T6), conversational chat + localStorage (T7), read/ai-edit/save endpoints (T3/T4/T5), text-only claude (T4), plt-validate-before-write + commit-not-push (T5), admin-only + feature-gate (T2/T3), authored-over-pack override (T5). All present.
- **Containment in `save`** rests on the `^[a-z0-9-]+$` name guard applied before any path is built — no realpath dance needed because the name can't traverse.
- **Hermetic tests:** every `claude`/`plt`/`git` invocation goes through the injected `run`; only `save`/`GET` touch a real temp git repo (created + torn down per test). No network, no reliance on a real `claude` binary.
- **Type consistency:** the `run` spec shape `{ cmd, args, cwd, input?, timeoutMs? } -> { code, stdout, stderr }` is identical across `templates.js`, `api.js`, and every test stub. The AI-edit payload `{ draft, messages:[{role,content}] }` and the save payload `{ draft }` match between `tpleditor.js` and the endpoint validators.
