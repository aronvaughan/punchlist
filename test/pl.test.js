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
