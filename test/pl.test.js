// pl.sh — the canonical CLI (skills/shared/pl.sh) exercised as a real child
// process against a live HTTP server (in-memory db, fixed today), exactly as
// agents invoke it. Covers the new `step` subcommand (toggle a step's done
// flag) and the finish-time incomplete-steps warning on stderr.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../src/db.js';
import { buildApp } from '../src/api.js';
import { serve } from '../src/server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PL = join(ROOT, 'skills', 'shared', 'pl.sh');
const TOK_ARON = 'a'.repeat(32);
const TOK_CLAUDE = 'c'.repeat(32);
const TOK_HERMES = 'h'.repeat(32);
const TODAY = '2026-03-10';

let server, url;

before(async () => {
  const { db, migrate } = open(':memory:');
  migrate();
  const app = buildApp({
    db, tokens: { alex: TOK_ARON, claude: TOK_CLAUDE, hermes: TOK_HERMES },
    today: () => TODAY });
  server = serve(app, { host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.on('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); });

const execFileAsync = promisify(execFile);

// Async on purpose: execFileSync blocks this process's event loop, which
// would starve the in-process HTTP server (same event loop) the CLI is
// curling against — deadlocking the request. execFile lets the server keep
// servicing requests while the bash/curl child runs.
async function pl(token, args) {
  try {
    const { stdout, stderr } = await execFileAsync('bash', [PL, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PUNCHLIST_URL: url, PUNCHLIST_TOKEN: token,
        PUNCHLIST_ENV_FILE: '', HERMES_HOME: '' },
    });
    return { status: 0, stdout, stderr };
  } catch (e) {
    return { status: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('pl.sh step: toggles a step done/undone via the CLI', async () => {
  const add = await pl(TOK_ARON, ['add', 'cli step task', '--assignee', 'claude', '--steps', 'first;second']);
  assert.equal(add.status, 0, add.stderr);
  const id = add.stdout.split(/\s+/, 1)[0];
  const show = JSON.parse((await pl(TOK_ARON, ['show', id])).stdout);
  const stepId = show.steps[0].id;

  const marked = await pl(TOK_CLAUDE, ['step', id, stepId]); // default action: done
  assert.equal(marked.status, 0, marked.stderr);
  assert.match(marked.stdout, /^\[x\] first/);

  const unmarked = await pl(TOK_CLAUDE, ['step', id, stepId, 'undone']);
  assert.equal(unmarked.status, 0, unmarked.stderr);
  assert.match(unmarked.stdout, /^\[ \] first/);

  // a bystander (neither assignee nor admin) is rejected
  const denied = await pl(TOK_HERMES, ['step', id, stepId, 'done']);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /HTTP 403/);

  // bad action word is a usage error, not an API call
  const bad = await pl(TOK_CLAUDE, ['step', id, stepId, 'maybe']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /usage: pl\.sh step/);
});

test('pl.sh finish: warns on stderr about incomplete steps but still completes', async () => {
  const add = await pl(TOK_ARON, ['add', 'cli finish warns', '--assignee', 'claude', '--steps', 'one;two']);
  const id = add.stdout.split(/\s+/, 1)[0];
  await pl(TOK_CLAUDE, ['claim', id]);

  const finished = await pl(TOK_CLAUDE, ['finish', id, 'shipped partial work']);
  assert.equal(finished.status, 0, finished.stderr);
  assert.match(finished.stderr, /Warning: 2 step\(s\) still marked incomplete/);
  assert.match(finished.stdout, /\[review\]/);
});

test('pl.sh finish: no warning when all steps are done (or there are none)', async () => {
  const add = await pl(TOK_ARON, ['add', 'cli finish clean', '--assignee', 'claude', '--steps', 'only']);
  const id = add.stdout.split(/\s+/, 1)[0];
  const show = JSON.parse((await pl(TOK_ARON, ['show', id])).stdout);
  await pl(TOK_CLAUDE, ['claim', id]);
  await pl(TOK_CLAUDE, ['step', id, show.steps[0].id]); // mark done

  const finished = await pl(TOK_CLAUDE, ['finish', id, 'all steps done']);
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal(finished.stderr.trim(), '');

  // a task with no steps[] at all never warns either
  const add2 = await pl(TOK_ARON, ['add', 'no steps at all', '--assignee', 'claude']);
  const id2 = add2.stdout.split(/\s+/, 1)[0];
  await pl(TOK_CLAUDE, ['claim', id2]);
  const finished2 = await pl(TOK_CLAUDE, ['finish', id2, 'nothing to track']);
  assert.equal(finished2.status, 0, finished2.stderr);
  assert.equal(finished2.stderr.trim(), '');
});

// tag context notepad (mirrors the project one): `pl.sh tags` lists with a
// [context] marker, `pl.sh tag <name>` prints the readme — the same shape
// `pl.sh project` already has. This is the CLI surface the sweep orchestrator
// reads to assemble a subagent brief: root (instance) -> project -> tag.
test("pl.sh tags/tag: lists with [context] marker; reads one tag's readme by name or id", async () => {
  await pl(TOK_ARON, ['add', 'cli tag task', '--tags', 'sre,plain']);
  const tagsBefore = (await pl(TOK_ARON, ['tags'])).stdout;
  assert.match(tagsBefore, /#sre/);
  assert.match(tagsBefore, /#plain/);
  assert.doesNotMatch(tagsBefore.split('\n').find(l => l.includes('#sre')) || '', /\[context\]/);

  // set context + template on #sre directly through the HTTP API, same path
  // the UI's tag-context dialog PATCHes
  const list = await (await fetch(`${url}/api/v1/tags`,
    { headers: { Authorization: `Bearer ${TOK_ARON}` } })).json();
  const sre = list.items.find(t => t.name === 'sre');
  const patched = await fetch(`${url}/api/v1/tags/${sre.id}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${TOK_ARON}`, 'content-type': 'application/json' },
    body: JSON.stringify({ notes: '# sre\nrunbooks live here', template: 'incident-checklist', kb_path: '/kb/sre' }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).kb_path, '/kb/sre');

  const tagsAfter = (await pl(TOK_ARON, ['tags'])).stdout;
  const sreLine = tagsAfter.split('\n').find(l => l.includes('#sre'));
  assert.match(sreLine, /\[context\]/);

  const single = (await pl(TOK_ARON, ['tag', 'sre'])).stdout;
  assert.match(single, /# #sre/);
  assert.match(single, /\[template: incident-checklist\]/);
  assert.match(single, /kb_path: \/kb\/sre/);
  assert.match(single, /runbooks live here/);

  // resolvable by id too
  const byId = (await pl(TOK_ARON, ['tag', sre.id])).stdout;
  assert.match(byId, /runbooks live here/);

  // unknown tag -> exit 1
  const unknown = await pl(TOK_ARON, ['tag', 'no-such-tag']);
  assert.notEqual(unknown.status, 0);
});

// project-create: agents create their own projects via the CLI, mirroring
// how `add` creates a task (POST /api/v1/projects already existed server-
// side for the UI; this just exposes it on the CLI surface).
test('pl.sh project-create: creates a project, visible via projects/project; rejects dup names', async () => {
  const created = await pl(TOK_ARON, ['project-create', 'cli new project', '--notes', 'hello there', '--working-dir', '/tmp/proj', '--kb-path', '/tmp/kb/proj']);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /cli new project/);
  assert.match(created.stdout, /working_dir:\/tmp\/proj/);
  assert.match(created.stdout, /kb_path:\/tmp\/kb\/proj/);
  const id = created.stdout.split(/\s+/, 1)[0];

  const list = (await pl(TOK_ARON, ['projects'])).stdout;
  assert.match(list, /cli new project/);

  const single = (await pl(TOK_ARON, ['project', id])).stdout;
  assert.match(single, /# cli new project/);
  assert.match(single, /hello there/);
  assert.match(single, /working_dir: \/tmp\/proj/);
  assert.match(single, /kb_path: \/tmp\/kb\/proj/);

  // duplicate name -> server 409, surfaced as a non-zero exit with HTTP in stderr
  const dup = await pl(TOK_ARON, ['project-create', 'cli new project']);
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /HTTP 409/);

  // a child project resolves --parent by name
  const child = await pl(TOK_ARON, ['project-create', 'cli child project', '--parent', 'cli new project']);
  assert.equal(child.status, 0, child.stderr);

  // missing name -> usage error, no API call
  const noArgs = await pl(TOK_ARON, ['project-create']);
  assert.equal(noArgs.status, 2);
  assert.match(noArgs.stderr, /usage: pl\.sh project-create/);
});

// instance-edit / instance: instance-level working_dir + kb_path mirror the
// project/tag pickers (013/017) as the deployment-wide BASE context — read
// FIRST via `pl.sh instance`, before project/tag (root -> project -> tag).
test('pl.sh instance-edit: sets working_dir/kb_path (admin only); pl.sh instance reads them back', async () => {
  const set = await pl(TOK_ARON, ['instance-edit', '--working-dir', '/srv/code', '--kb-path', '/srv/kb']);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /working_dir:\/srv\/code/);
  assert.match(set.stdout, /kb_path:\/srv\/kb/);

  const read = (await pl(TOK_ARON, ['instance'])).stdout;
  assert.match(read, /working_dir: \/srv\/code/);
  assert.match(read, /kb_path: \/srv\/kb  \(read for background/);

  // non-admin actor -> 403, surfaced as a non-zero exit
  const denied = await pl(TOK_CLAUDE, ['instance-edit', '--working-dir', '/nope']);
  assert.notEqual(denied.status, 0);

  // missing flags -> usage error, no API call
  const noArgs = await pl(TOK_ARON, ['instance-edit']);
  assert.equal(noArgs.status, 2);
  assert.match(noArgs.stderr, /usage: pl\.sh instance-edit/);

  // clear both back to "" so later tests in this file see a clean instance
  await pl(TOK_ARON, ['instance-edit', '--working-dir', '', '--kb-path', '']);
});

// project-edit / tag-edit: reopened-task regression — project-create could
// set kb_path at creation time, but there was no CLI verb to set it (or
// notes/template/working_dir) on a project/tag that already exists; the only
// way was a raw PATCH to the HTTP API. An owner trying to "set kb folder" on
// an existing project via the CLI had no command to do it with.
test('pl.sh project-edit: sets kb_path (and other context fields) on an EXISTING project', async () => {
  const created = await pl(TOK_ARON, ['project-create', 'editable project']);
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.split(/\s+/, 1)[0];

  // before: no kb_path
  const before = (await pl(TOK_ARON, ['project', id])).stdout;
  assert.doesNotMatch(before, /kb_path:/);

  const edited = await pl(TOK_ARON, ['project-edit', id, '--kb-path', '/kb/editable', '--notes', 'edited notes']);
  assert.equal(edited.status, 0, edited.stderr);
  assert.match(edited.stdout, /kb_path:\/kb\/editable/);

  const after = (await pl(TOK_ARON, ['project', id])).stdout;
  assert.match(after, /kb_path: \/kb\/editable/);
  assert.match(after, /edited notes/);

  // resolvable by name too, and clears working_dir with an empty string
  const edited2 = await pl(TOK_ARON, ['project-edit', 'editable project', '--working-dir', '/tmp/wd']);
  assert.equal(edited2.status, 0, edited2.stderr);
  assert.match(edited2.stdout, /working_dir:\/tmp\/wd/);

  // unknown project -> exit 1, no server 400
  const unknown = await pl(TOK_ARON, ['project-edit', 'no-such-project', '--kb-path', '/x']);
  assert.equal(unknown.status, 1);

  // no flags -> usage error, no API call
  const noFlags = await pl(TOK_ARON, ['project-edit', id]);
  assert.equal(noFlags.status, 2);
  assert.match(noFlags.stderr, /usage: pl\.sh project-edit/);
});

test('pl.sh tag-edit: sets kb_path (and notes/template) on an EXISTING tag', async () => {
  await pl(TOK_ARON, ['add', 'tag-edit fixture task', '--tags', 'editme']);

  const before = (await pl(TOK_ARON, ['tag', 'editme'])).stdout;
  assert.doesNotMatch(before, /kb_path:/);

  const edited = await pl(TOK_ARON, ['tag-edit', 'editme', '--kb-path', '/kb/editme', '--template', 'incident-checklist']);
  assert.equal(edited.status, 0, edited.stderr);
  assert.match(edited.stdout, /kb_path:\/kb\/editme/);

  const after = (await pl(TOK_ARON, ['tag', 'editme'])).stdout;
  assert.match(after, /kb_path: \/kb\/editme/);
  assert.match(after, /\[template: incident-checklist\]/);

  const unknown = await pl(TOK_ARON, ['tag-edit', 'no-such-tag', '--kb-path', '/x']);
  assert.equal(unknown.status, 1);

  const noFlags = await pl(TOK_ARON, ['tag-edit', 'editme']);
  assert.equal(noFlags.status, 2);
  assert.match(noFlags.stderr, /usage: pl\.sh tag-edit/);
});
