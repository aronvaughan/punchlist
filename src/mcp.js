// mcp.js — MCP stdio server exposing punchlist as native tools for any MCP
// client (Claude Code, Cursor, Hermes, custom agents). Thin fetch layer over
// the same REST API the skills use; auth resolution mirrors the canonical
// skills/shared/pl.sh exactly:
//   1. $PUNCHLIST_TOKEN in the environment
//   2. $PUNCHLIST_ENV_FILE — a KEY=value file to read PUNCHLIST_TOKEN from
//   3. ~/.claude/secrets.local.env, then $HERMES_HOME/.env (conventions)
// Base URL: $PUNCHLIST_URL (default http://127.0.0.1:8600). The token is only
// ever put in the Authorization header — never logged, never in tool output.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE = process.env.PUNCHLIST_URL || 'http://127.0.0.1:8600';
const API = `${BASE}/api/v1`;

function readEnvToken(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return ''; }
  const m = /^PUNCHLIST_TOKEN=(.*)$/m.exec(text);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

export function resolveToken(env = process.env) {
  if (env.PUNCHLIST_TOKEN) return env.PUNCHLIST_TOKEN;
  if (env.PUNCHLIST_ENV_FILE) {
    const t = readEnvToken(env.PUNCHLIST_ENV_FILE);
    if (t) return t;
  }
  const t = readEnvToken(join(homedir(), '.claude', 'secrets.local.env'));
  if (t) return t;
  if (env.HERMES_HOME) return readEnvToken(join(env.HERMES_HOME, '.env'));
  return '';
}

const TOKEN = resolveToken();
if (!TOKEN) {
  console.error('punchlist-mcp: PUNCHLIST_TOKEN is not set (export it, set PUNCHLIST_ENV_FILE, ' +
    'or put PUNCHLIST_TOKEN=... in ~/.claude/secrets.local.env or $HERMES_HOME/.env)');
  process.exit(1);
}

// Tool errors carry the server's {error} message — never a stack trace.
class ToolError extends Error {}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ToolError(`cannot reach the punchlist server at ${BASE}`);
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    throw new ToolError(`HTTP ${res.status} — ${json?.error ?? res.statusText}`);
  }
  return json;
}

// Compact task shape for tool output: drop nulls/empties the model doesn't need.
function slim(t) {
  const out = { id: t.id, title: t.title, status: t.status, assignee: t.assignee };
  if (t.project_id) out.project_id = t.project_id;
  if (t.due_date) out.due = t.due_date + (t.due_time ? `T${t.due_time}` : '');
  if (t.when_type === 'someday') out.when = 'someday';
  else if (t.when_type === 'date') out.when = t.when_date;
  if (t.tags?.length) out.tags = t.tags;
  if (t.steps?.length) out.steps = t.steps.map(s => ({ title: s.title, done: !!s.done }));
  if (t.notes) out.notes = t.notes;
  if (t.report) out.report = t.report;
  if (t.question) out.question = t.question; // needs-input: what the agent asked
  if (t.answer) out.answer = t.answer;       // …and what the admin answered
  if (t.auto_close) out.auto_close = true;
  if (t.created_by) out.created_by = t.created_by;
  if (t.vetted === 0) out.unvetted = true; // quarantined: agents must not work it
  if (t.allow_push) out.allow_push = true; // owner authorized pushing this task's work
  return out;
}

const text = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const taskResult = res => {
  const out = { task: slim(res.task ?? res) };
  if (res.spawned_id) out.spawned_id = res.spawned_id;
  return text(out);
};

async function resolveProject(nameOrId) {
  const { items } = await api('GET', '/projects?limit=500');
  const hit = items.find(p => p.id === nameOrId ||
    p.name.toLowerCase() === String(nameOrId).toLowerCase());
  if (!hit) {
    throw new ToolError(`unknown project '${nameOrId}' — existing: ${items.map(p => p.name).join(', ')}`);
  }
  return hit.id;
}

// build a POST /tasks or PATCH body from the tool's friendly args
async function taskBody(a, { partial }) {
  const b = {};
  if (a.title !== undefined) b.title = a.title;
  if (a.notes !== undefined) b.notes = a.notes;
  if (a.tags !== undefined) b.tags = a.tags;
  if (a.steps !== undefined) b.steps = a.steps;
  if (a.assignee !== undefined) b.assignee = a.assignee;
  if (a.auto_close !== undefined) b.auto_close = a.auto_close ? 1 : 0;
  if (a.due_time !== undefined) b.due_time = a.due_time;
  if (a.project !== undefined) {
    b.project_id = partial && a.project === 'none' ? null : await resolveProject(a.project);
  }
  if (a.due !== undefined) b.due_date = partial && a.due === 'none' ? null : a.due;
  if (a.when !== undefined) {
    if (a.when === 'someday') { b.when_type = 'someday'; if (partial) b.when_date = null; }
    else if (partial && a.when === 'none') { b.when_type = null; b.when_date = null; }
    else { b.when_type = 'date'; b.when_date = a.when; }
  }
  if (partial && a.status !== undefined) b.status = a.status;
  return b;
}

const ID = { type: 'string', description: 'Task id (ULID) from a previous list/add result' };
const WHEN = 'Start/plan date YYYY-MM-DD, or "someday"';

const TOOLS = [
  {
    name: 'punchlist_add',
    description: 'Create a task on the punchlist. Only title is required; use assignee to ' +
      'delegate it to an agent (e.g. "claude", "hermes") and auto_close:true to skip human review ' +
      'when that agent finishes. Returns the created task with its id.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title (required)' },
        project: { type: 'string', description: 'Project name or id to file the task under' },
        due: { type: 'string', description: 'Hard deadline YYYY-MM-DD' },
        due_time: { type: 'string', description: 'Deadline time HH:MM (with due)' },
        when: { type: 'string', description: WHEN },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag names' },
        assignee: { type: 'string', description: 'Actor who must do it (default: the human admin)' },
        notes: { type: 'string', description: 'Markdown notes / task body' },
        steps: { type: 'array', items: { type: 'string' }, description: 'Checklist step titles' },
        auto_close: { type: 'boolean', description: 'Finish goes straight to done, skipping review' },
      },
      required: ['title'],
    },
    handler: async a => taskResult(await api('POST', '/tasks', await taskBody(a, { partial: false }))),
  },
  {
    name: 'punchlist_quickadd',
    description: 'Create a task from one line of natural text with inline tokens, parsed ' +
      'server-side: #tag @project !due ^when *recur >assignee (dates: YYYY-MM-DD | today | ' +
      'tomorrow | weekday). Fastest capture; use punchlist_add for full control.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The quick-add line' } },
      required: ['text'],
    },
    handler: async a => taskResult(await api('POST', '/tasks/quickadd', { text: a.text })),
  },
  {
    name: 'punchlist_list',
    description: 'List tasks. Views: inbox (unplanned), today, upcoming, overdue, due_soon ' +
      '(within window days), logbook (done), review (finished agent work awaiting approval), ' +
      'delegated (open work assigned to agents), needs_input (blocked on a question for the ' +
      'admin). No view = all open tasks. Filter by project ' +
      '(name or id), tag, or assignee. Paginate with cursor from a previous result.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['inbox', 'today', 'upcoming', 'overdue', 'due_soon',
          'logbook', 'review', 'delegated', 'needs_input'] },
        project: { type: 'string', description: 'Project name or id' },
        tag: { type: 'string', description: 'Tag name' },
        assignee: { type: 'string', description: 'Actor name' },
        window: { type: 'integer', description: 'due_soon horizon in days (default 30)' },
        limit: { type: 'integer', description: 'Max results (default 100, max 500)' },
        cursor: { type: 'string', description: 'next_cursor from a previous result' },
      },
    },
    handler: async a => {
      const qs = new URLSearchParams();
      if (a.view) qs.set('view', a.view);
      if (a.project !== undefined) qs.set('project', await resolveProject(a.project));
      for (const k of ['tag', 'assignee', 'window', 'limit', 'cursor']) {
        if (a[k] !== undefined) qs.set(k, a[k]);
      }
      const res = await api('GET', `/tasks?${qs}`);
      const out = { items: res.items.map(slim) };
      if (res.next_cursor) out.next_cursor = res.next_cursor;
      return text(out);
    },
  },
  {
    name: 'punchlist_show',
    description: 'Fetch one task by id with full details (notes, steps, report, dates), ' +
      'searching open, review, logbook and delegated views.',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
    handler: async a => {
      for (const v of ['', 'review', 'logbook', 'delegated']) {
        const qs = v ? `view=${v}&limit=500` : 'limit=500';
        const { items } = await api('GET', `/tasks?${qs}`);
        const t = items.find(x => x.id === a.id);
        if (t) return text(t);
      }
      throw new ToolError(`task ${a.id} not found in open/review/logbook/delegated views`);
    },
  },
  {
    name: 'punchlist_queue',
    description: 'My work queue: open tasks assigned to me (the actor this token belongs to), ' +
      'status active or in_progress. Server-side scoped: unvetted tasks are excluded. ' +
      'Check this to find delegated work to pick up.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const { actor } = await api('GET', '/counts');
      // view=queue is the server-enforced contract: active+in_progress, vetted only
      const { items } = await api('GET', `/tasks?view=queue&assignee=${encodeURIComponent(actor)}&limit=500`);
      return text({ actor, items: items.map(slim) });
    },
  },
  {
    name: 'punchlist_claim',
    description: 'Claim a task assigned to me before working it (active -> in_progress). ' +
      'Only the assignee can claim; re-claiming your own in-progress task is a no-op.',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
    handler: async a => taskResult(await api('POST', `/tasks/${encodeURIComponent(a.id)}/claim`, {})),
  },
  {
    name: 'punchlist_finish',
    description: 'Finish a task assigned to me with a written outcome report (required). ' +
      'Moves it to the human review lane — or straight to done when the task has auto_close.',
    inputSchema: {
      type: 'object',
      properties: { id: ID, report: { type: 'string', description: 'What was done, outcomes, anything the reviewer must know (markdown)' } },
      required: ['id', 'report'],
    },
    handler: async a => taskResult(await api('POST', `/tasks/${encodeURIComponent(a.id)}/finish`, { report: a.report })),
  },
  {
    name: 'punchlist_block',
    description: 'Block a task assigned to me on ONE concrete, answerable question for the ' +
      'admin (active/in_progress -> blocked). Use this when stuck instead of guessing or ' +
      'finishing with a question in the report; the task leaves my queue and returns to it ' +
      'once answered, with the answer attached. Re-blocking with the same question is a no-op.',
    inputSchema: {
      type: 'object',
      properties: { id: ID, question: { type: 'string', description: 'One concrete question the admin can answer (markdown, <=2048 chars)' } },
      required: ['id', 'question'],
    },
    handler: async a => taskResult(await api('POST', `/tasks/${encodeURIComponent(a.id)}/block`, { question: a.question })),
  },
  {
    name: 'punchlist_answer',
    description: 'Answer a blocked task\'s question (admin/human actor only). Moves it ' +
      'blocked -> active so the assigned agent picks it back up with the answer attached.',
    inputSchema: {
      type: 'object',
      properties: { id: ID, answer: { type: 'string', description: 'The answer to the blocking question (markdown, <=8192 chars)' } },
      required: ['id', 'answer'],
    },
    handler: async a => taskResult(await api('POST', `/tasks/${encodeURIComponent(a.id)}/answer`, { answer: a.answer })),
  },
  {
    name: 'punchlist_reorder',
    description: 'Reprioritize your backlog: move a task directly before or after another in ' +
      'the shared agents backlog (position IS priority). As an agent you MUST pass a reason — ' +
      'it auto-posts a status entry to the task timeline so the owner sees why you moved it. ' +
      'list defaults to "agents"; use "inbox"/"human" only for those lanes.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        before: { type: 'string', description: 'Move directly BEFORE this task id' },
        after: { type: 'string', description: 'Move directly AFTER this task id' },
        list: { type: 'string', enum: ['agents', 'inbox', 'human'], description: 'Which lane (default agents)' },
        reason: { type: 'string', description: 'Why you moved it — auto-posted to the timeline (required for agents)' },
      },
      required: ['id', 'reason'],
    },
    handler: async a => {
      const body = { list: a.list || 'agents', reason: a.reason };
      if (a.before !== undefined) body.before_id = a.before;
      if (a.after !== undefined) body.after_id = a.after;
      return taskResult(await api('POST', `/tasks/${encodeURIComponent(a.id)}/reorder`, body));
    },
  },
  {
    name: 'punchlist_complete',
    description: 'Mark an active task done directly (human-style completion, no report). ' +
      'For delegated work use punchlist_finish instead.',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
    handler: async a => taskResult(await api('POST', `/tasks/${encodeURIComponent(a.id)}/complete`, {})),
  },
  {
    name: 'punchlist_approve',
    description: 'Approve a finished task out of the review lane into the logbook ' +
      '(review -> done). Admin (human) actor only.',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
    handler: async a => taskResult(await api('POST', `/tasks/${encodeURIComponent(a.id)}/approve`, {})),
  },
  {
    name: 'punchlist_vet',
    description: 'Vet a task for agent execution (admin/human actor only). Tasks created by ' +
      'untrusted actors (e.g. email) arrive unvetted: agents cannot see them in queues or ' +
      'claim/finish them until the admin vets them. Idempotent.',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
    handler: async a => taskResult(await api('POST', `/tasks/${encodeURIComponent(a.id)}/vet`, {})),
  },
  {
    name: 'punchlist_update',
    description: 'Update fields on a task (sparse — only what you pass changes). ' +
      'project/due/when accept "none" to clear. Reassigning takes claimed work back to active. ' +
      'Cannot set done/review status here — use complete/finish/approve.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        title: { type: 'string' },
        notes: { type: 'string', description: 'Replaces the notes' },
        project: { type: 'string', description: 'Project name or id, or "none" to clear' },
        due: { type: 'string', description: 'YYYY-MM-DD, or "none" to clear' },
        due_time: { type: 'string', description: 'HH:MM' },
        when: { type: 'string', description: `${WHEN}, or "none" to clear` },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replaces the tag set' },
        assignee: { type: 'string', description: 'Reassign to this actor' },
        status: { type: 'string', enum: ['active', 'archived'] },
        auto_close: { type: 'boolean' },
      },
      required: ['id'],
    },
    handler: async a => taskResult(
      await api('PATCH', `/tasks/${encodeURIComponent(a.id)}`, await taskBody(a, { partial: true }))),
  },
  {
    name: 'punchlist_projects',
    description: 'List projects (id, name, archived, context — a per-project readme/overview the ' +
      'owner maintains; read it for project background before working its tasks — template, ' +
      'the punchlist-templates template name the notepad points to, if any — and kb_path, an ' +
      'absolute local folder to read for extra background AND write new info to when a task asks ' +
      'for it; distinct from working_dir, the code checkout). Pass name to create ' +
      'a new project instead (optional parent = existing project name or id).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Create a project with this name' },
        parent: { type: 'string', description: 'Parent project name or id (with name)' },
      },
    },
    handler: async a => {
      if (a.name !== undefined) {
        const body = { name: a.name };
        if (a.parent !== undefined) body.parent_id = await resolveProject(a.parent);
        const p = await api('POST', '/projects', body);
        return text({ id: p.id, name: p.name });
      }
      const { items } = await api('GET', '/projects?limit=500');
      return text({ items: items.map(p => ({ id: p.id, name: p.name,
        ...(p.archived ? { archived: true } : {}),
        ...(p.working_dir ? { working_dir: p.working_dir } : {}),
        ...(p.kb_path ? { kb_path: p.kb_path } : {}),
        ...(p.notes ? { context: p.notes } : {}),
        ...(p.template ? { template: p.template } : {}) })) });
    },
  },
  {
    name: 'punchlist_counts',
    description: 'Nav counts: inbox, today, upcoming, due_soon, review, delegated, needs_input, per-project ' +
      'open counts — plus which actor this token authenticates as. Cheap situational overview.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => text(await api('GET', '/counts')),
  },
];

const server = new Server(
  { name: 'punchlist', version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const tool = TOOLS.find(t => t.name === req.params.name);
  if (!tool) return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true };
  try {
    return await tool.handler(req.params.arguments ?? {});
  } catch (err) {
    // surface the API's {error} message (ToolError) — never a stack trace
    const msg = err instanceof ToolError ? err.message : 'internal error';
    if (!(err instanceof ToolError)) console.error(err);
    return { content: [{ type: 'text', text: msg }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
