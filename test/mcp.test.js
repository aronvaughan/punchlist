// mcp — the stdio MCP server speaks the protocol end-to-end against a live
// API: spawn the real HTTP server on an ephemeral port (in-memory db, fixed
// today), spawn `node src/mcp.js` children pointed at it, and drive the
// newline-delimited JSON-RPC stream: initialize, tools/list, and a realistic
// delegation flow (admin adds → claude queues/claims/finishes → admin
// approves). Children inherit NODE_V8_COVERAGE so mcp.js counts toward the
// coverage floor — always shut them down gracefully (end stdin), never kill.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../src/db.js';
import { buildApp } from '../src/api.js';
import { serve } from '../src/server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MCP = join(ROOT, 'src', 'mcp.js');
const TOK_ARON = 'a'.repeat(32);
const TOK_CLAUDE = 'c'.repeat(32);
const TOK_EMAIL = 'e'.repeat(32);
const TODAY = '2026-03-10';

const TOOL_NAMES = ['punchlist_add', 'punchlist_quickadd', 'punchlist_list', 'punchlist_show',
  'punchlist_reorder',
  'punchlist_queue', 'punchlist_claim', 'punchlist_finish', 'punchlist_block', 'punchlist_answer',
  'punchlist_complete', 'punchlist_approve', 'punchlist_vet', 'punchlist_update',
  'punchlist_projects', 'punchlist_counts'];

// minimal newline-delimited JSON-RPC client over a spawned mcp.js
class McpClient {
  constructor(env) {
    this.child = spawn(process.execPath, [MCP], {
      env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = '';
    this.stderr = '';
    this.pending = new Map();
    this.nextId = 1;
    this.child.stdout.on('data', d => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const resolve = this.pending.get(msg.id);
        if (resolve) { this.pending.delete(msg.id); resolve(msg); }
      }
    });
    this.child.stderr.on('data', d => { this.stderr += d; });
  }
  request(method, params) {
    const id = this.nextId++;
    const p = new Promise(resolve => this.pending.set(id, resolve));
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return p;
  }
  async init() {
    const res = await this.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return res;
  }
  // tools/call → {json, isError} with the text content parsed when possible
  async call(name, args = {}) {
    const res = await this.request('tools/call', { name, arguments: args });
    assert.equal(res.error, undefined, `protocol error from ${name}: ${JSON.stringify(res.error)}`);
    const text = res.result.content[0].text;
    let json = null;
    try { json = JSON.parse(text); } catch { /* plain error message */ }
    return { json, text, isError: res.result.isError === true };
  }
  async ok(name, args) { // a call that must succeed
    const r = await this.call(name, args);
    assert.equal(r.isError, false, `${name} failed: ${r.text}`);
    return r.json;
  }
  close() { // graceful: end stdin so the child flushes V8 coverage on exit
    const done = new Promise(resolve => this.child.on('exit', resolve));
    this.child.stdin.end();
    return done;
  }
}

let server, url, admin, agent, tmp;

before(async () => {
  const { db, migrate } = open(':memory:');
  migrate();
  const app = buildApp({ db, tokens: { alex: TOK_ARON, claude: TOK_CLAUDE, email: TOK_EMAIL },
    today: () => TODAY });
  server = serve(app, { host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.on('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  tmp = mkdtempSync(join(tmpdir(), 'pl-mcp-'));
  const env = tok => ({ ...process.env, PUNCHLIST_URL: url, PUNCHLIST_TOKEN: tok,
    PUNCHLIST_ENV_FILE: '', HERMES_HOME: '' });
  admin = new McpClient(env(TOK_ARON));
  agent = new McpClient(env(TOK_CLAUDE));
  await admin.init();
  await agent.init();
});

after(async () => {
  await admin?.close();
  await agent?.close();
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('initialize handshake reports the punchlist server', async () => {
  const extra = new McpClient({ ...process.env, PUNCHLIST_URL: url, PUNCHLIST_TOKEN: TOK_ARON,
    PUNCHLIST_ENV_FILE: '', HERMES_HOME: '' });
  const res = await extra.init();
  assert.equal(res.result.serverInfo.name, 'punchlist');
  assert.match(res.result.serverInfo.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/); // semver, incl. prereleases (e.g. 1.0.1-rc.1)
  assert.ok(res.result.capabilities.tools);
  await extra.close();
});

test('tools/list exposes all sixteen tools with object schemas and descriptions', async () => {
  const res = await admin.request('tools/list', {});
  const tools = res.result.tools;
  assert.deepEqual(tools.map(t => t.name).sort(), [...TOOL_NAMES].sort());
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.description.length > 30, `${t.name} needs a real description`);
  }
  const add = tools.find(t => t.name === 'punchlist_add');
  assert.deepEqual(add.inputSchema.required, ['title']);
  const list = tools.find(t => t.name === 'punchlist_list');
  assert.ok(list.inputSchema.properties.view.enum.includes('delegated'));
});

test('delegation flow: add → today → queue → claim → finish → review → approve', async () => {
  // project create + list (resolution is by case-insensitive name)
  const proj = await admin.ok('punchlist_projects', { name: 'Ops' });
  assert.ok(proj.id);
  const projects = await admin.ok('punchlist_projects', {});
  assert.deepEqual(projects.items.map(p => p.name), ['Ops']);

  // admin delegates a task to claude, due today, with the full field set
  const added = await admin.ok('punchlist_add', {
    title: 'Rotate backups', project: 'ops', due: TODAY, when: 'someday',
    tags: ['infra'], assignee: 'claude', notes: 'use the snapshot script',
    steps: ['snapshot', 'verify'] });
  const id = added.task.id;
  assert.equal(added.task.created_by, 'alex');
  assert.equal(added.task.assignee, 'claude');
  assert.equal(added.task.project_id, proj.id);
  assert.equal(added.task.due, TODAY);
  assert.equal(added.task.when, 'someday');
  assert.deepEqual(added.task.tags, ['infra']);
  assert.deepEqual(added.task.steps.map(s => s.title), ['snapshot', 'verify']);

  // due-date-driven Today includes the delegated task (2026-08-24 amendment)
  const today = await admin.ok('punchlist_list', { view: 'today' });
  assert.ok(today.items.some(t => t.id === id));

  // claude sees it in its queue; admin cannot claim it
  const queue = await agent.ok('punchlist_queue');
  assert.equal(queue.actor, 'claude');
  assert.ok(queue.items.some(t => t.id === id));
  const denied = await admin.call('punchlist_claim', { id });
  assert.equal(denied.isError, true);
  assert.equal(denied.text, 'HTTP 403 — only the assignee can claim');

  // claim → finish with a report → review lane
  const claimed = await agent.ok('punchlist_claim', { id });
  assert.equal(claimed.task.status, 'in_progress');
  const finished = await agent.ok('punchlist_finish', { id, report: 'rotated; verified checksums' });
  assert.equal(finished.task.status, 'review');
  const review = await admin.ok('punchlist_list', { view: 'review' });
  assert.ok(review.items.some(t => t.id === id));

  // admin approves as a separate mcp instance; report survives into the logbook
  const approved = await admin.ok('punchlist_approve', { id });
  assert.equal(approved.task.status, 'done');
  const shown = await admin.ok('punchlist_show', { id });
  assert.equal(shown.status, 'done');
  assert.equal(shown.report, 'rotated; verified checksums');

  const counts = await admin.ok('punchlist_counts');
  assert.equal(counts.actor, 'alex');
  assert.equal(counts.review, 0);
  assert.equal(counts.delegated, 0);
});

test('vetting over MCP: email-created work is unvetted, invisible to the queue, unclaimable until punchlist_vet', async () => {
  const email = new McpClient({ ...process.env, PUNCHLIST_URL: url, PUNCHLIST_TOKEN: TOK_EMAIL,
    PUNCHLIST_ENV_FILE: '', HERMES_HOME: '' });
  await email.init();
  const added = await email.ok('punchlist_add', { title: 'ingested request', assignee: 'claude' });
  const id = added.task.id;
  assert.equal(added.task.created_by, 'email');
  assert.equal(added.task.unvetted, true, 'slim shape carries the quarantine flag');
  await email.close();

  // server-side queue scoping: the agent never sees it
  const queue = await agent.ok('punchlist_queue');
  assert.ok(!queue.items.some(t => t.id === id), 'unvetted task leaked into the queue');
  // ...but the claim door is locked too, even knowing the id
  const claim = await agent.call('punchlist_claim', { id });
  assert.equal(claim.isError, true);
  assert.equal(claim.text, 'HTTP 403 — task not vetted for agent execution');
  // agents cannot vet
  const agentVet = await agent.call('punchlist_vet', { id });
  assert.equal(agentVet.isError, true);
  assert.match(agentVet.text, /only the admin/);
  // counts surface the quarantine for the owner
  assert.equal((await admin.ok('punchlist_counts')).unvetted, 1);

  // admin vets → queue shows it → claim works
  const vetted = await admin.ok('punchlist_vet', { id });
  assert.equal(vetted.task.unvetted, undefined);
  const queue2 = await agent.ok('punchlist_queue');
  assert.ok(queue2.items.some(t => t.id === id));
  const claimed = await agent.ok('punchlist_claim', { id });
  assert.equal(claimed.task.status, 'in_progress');
  await agent.ok('punchlist_finish', { id, report: 'handled the ingested request' });
});

test('needs-input over MCP: block with a question → needs_input lane → admin answers → back in the queue with the exchange', async () => {
  const added = await admin.ok('punchlist_add', { title: 'buy the adapter', assignee: 'claude' });
  const id = added.task.id;
  await agent.ok('punchlist_claim', { id });
  // stuck: block with ONE concrete question instead of guessing
  const blocked = await agent.ok('punchlist_block', { id, question: 'USB-C or barrel jack?' });
  assert.equal(blocked.task.status, 'blocked');
  assert.equal(blocked.task.question, 'USB-C or barrel jack?');
  // out of the agent's queue, in the owner's needs_input lane + counts
  assert.ok(!(await agent.ok('punchlist_queue')).items.some(t => t.id === id));
  const lane = await admin.ok('punchlist_list', { view: 'needs_input' });
  assert.ok(lane.items.some(t => t.id === id));
  assert.equal((await admin.ok('punchlist_counts')).needs_input, 1);
  // the agent cannot answer its own question
  const denied = await agent.call('punchlist_answer', { id, answer: 'USB-C' });
  assert.equal(denied.isError, true);
  assert.match(denied.text, /only the admin/);
  // admin answers → active again, exchange attached in the slim shape
  const answered = await admin.ok('punchlist_answer', { id, answer: 'USB-C, we have spare cables' });
  assert.equal(answered.task.status, 'active');
  assert.equal(answered.task.question, 'USB-C or barrel jack?');
  assert.equal(answered.task.answer, 'USB-C, we have spare cables');
  const queue = await agent.ok('punchlist_queue');
  const back = queue.items.find(t => t.id === id);
  assert.ok(back, 'answered task returns to the queue');
  assert.equal(back.answer, 'USB-C, we have spare cables');
  await agent.ok('punchlist_finish', { id, report: 'ordered the USB-C model' });
  await admin.ok('punchlist_approve', { id });
});

test('quickadd, update (sparse + "none" clears), complete, filtered list', async () => {
  const qa = await admin.ok('punchlist_quickadd', { text: 'buy milk #errand !2026-03-11' });
  const id = qa.task.id;
  assert.deepEqual(qa.task.tags, ['errand']);
  assert.equal(qa.task.due, '2026-03-11');

  const upd = await admin.ok('punchlist_update', {
    id, title: 'buy oat milk', when: 'someday', due: 'none', auto_close: true });
  assert.equal(upd.task.title, 'buy oat milk');
  assert.equal(upd.task.when, 'someday');
  assert.equal(upd.task.due, undefined);
  assert.equal(upd.task.auto_close, true);
  const cleared = await admin.ok('punchlist_update', { id, when: 'none' });
  assert.equal(cleared.task.when, undefined);

  const byTag = await admin.ok('punchlist_list', { tag: 'errand', limit: 5 });
  assert.deepEqual(byTag.items.map(t => t.id), [id]);

  const done = await admin.ok('punchlist_complete', { id });
  assert.equal(done.task.status, 'done');
});

test('errors surface the API message — never a stack', async () => {
  const noProj = await admin.call('punchlist_add', { title: 'x', project: 'nope' });
  assert.equal(noProj.isError, true);
  assert.match(noProj.text, /^unknown project 'nope'/);

  const noTask = await admin.call('punchlist_show', { id: 'missing' });
  assert.equal(noTask.isError, true);
  assert.match(noTask.text, /task missing not found/);

  const badFinish = await agent.call('punchlist_finish', { id: 'missing', report: 'r' });
  assert.equal(badFinish.isError, true);
  assert.equal(badFinish.text, 'HTTP 404 — task not found');

  const unknown = await admin.call('nope');
  assert.equal(unknown.isError, true);
  assert.equal(unknown.text, 'unknown tool: nope');
  for (const r of [noProj, noTask, badFinish, unknown]) {
    assert.doesNotMatch(r.text, /\n\s+at /, 'stack trace leaked');
  }
});

test('token resolution: PUNCHLIST_ENV_FILE works like pl.sh (quoted value, env wins over file)', async () => {
  const envFile = join(tmp, 'agent.env');
  writeFileSync(envFile, `# agent token\nPUNCHLIST_TOKEN="${TOK_CLAUDE}"\n`);
  const env = { ...process.env, PUNCHLIST_URL: url, PUNCHLIST_ENV_FILE: envFile,
    HOME: tmp, HERMES_HOME: '' };
  delete env.PUNCHLIST_TOKEN;
  const c = new McpClient(env);
  await c.init();
  const counts = await c.ok('punchlist_counts');
  assert.equal(counts.actor, 'claude');
  await c.close();
});

test('no token anywhere: exits 1 with the pl.sh-style hint, no server started', async () => {
  const env = { ...process.env, PUNCHLIST_URL: url, HOME: tmp };
  delete env.PUNCHLIST_TOKEN;
  delete env.PUNCHLIST_ENV_FILE;
  delete env.HERMES_HOME;
  const child = spawn(process.execPath, [MCP], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /PUNCHLIST_TOKEN is not set/);
});

test('unreachable server: tool error names the base URL, not a stack', async () => {
  const c = new McpClient({ ...process.env, PUNCHLIST_URL: 'http://127.0.0.1:1',
    PUNCHLIST_TOKEN: TOK_ARON, PUNCHLIST_ENV_FILE: '', HERMES_HOME: '' });
  await c.init();
  const r = await c.call('punchlist_counts');
  assert.equal(r.isError, true);
  assert.equal(r.text, 'cannot reach the punchlist server at http://127.0.0.1:1');
  await c.close();
});

// project context notepad (project.notes) + its optional template pointer
// (project.template): both are agent-readable via punchlist_projects, so an
// agent can read a project's readme-style overview — and see which
// punchlist-templates template it points to — before working its tasks.
test('punchlist_projects surfaces a project\'s context notepad and template pointer', async () => {
  const proj = await admin.ok('punchlist_projects', { name: 'Rocketry' });
  const res = await fetch(`${url}/api/v1/projects/${proj.id}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${TOK_ARON}`, 'content-type': 'application/json' },
    body: JSON.stringify({ notes: '# Rocketry\nOverview for agents.', template: 'research-brief', kb_path: '/kb/rocketry' }),
  });
  assert.equal(res.status, 200);

  const projects = await admin.ok('punchlist_projects', {});
  const p = projects.items.find(x => x.id === proj.id);
  assert.equal(p.context, '# Rocketry\nOverview for agents.');
  assert.equal(p.template, 'research-brief');
  assert.equal(p.kb_path, '/kb/rocketry');

  // a fresh project with none set carries no context/template/kb_path keys at all
  const bare = await admin.ok('punchlist_projects', { name: 'Bare' });
  const bareItem = (await admin.ok('punchlist_projects', {})).items.find(x => x.id === bare.id);
  assert.equal('context' in bareItem, false);
  assert.equal('template' in bareItem, false);
  assert.equal('kb_path' in bareItem, false);
});
