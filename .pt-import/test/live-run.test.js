'use strict';
// End-to-end: launch + advance against a LIVE throwaway punchlist server.
// Boots the punchlist checkout (PUNCHLIST_SRC, default sibling ../punchlist)
// on a spare port with throwaway tokens and a temp data dir, then drives the
// shipped research-and-buy workflow through a full run:
//   launch -> hermes finishes research -> owner approves -> advance spawns
//   decide (outcome checklist) -> owner checks "approved" + completes ->
//   advance spawns order -> hermes finishes -> owner approves -> advance
//   completes the run. Skipped when no punchlist checkout is available.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PLT = path.join(REPO, 'bin', 'plt');
const PUNCHLIST_SRC = process.env.PUNCHLIST_SRC ||
  path.join(REPO, '..', 'punchlist');
const HAVE_PUNCHLIST = fs.existsSync(path.join(PUNCHLIST_SRC, 'src', 'server.js'));

const PORT = Number(process.env.PLT_TEST_PORT || 8642);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const TOK = { owner: 'o'.repeat(32), claude: 'c'.repeat(32), hermes: 'h'.repeat(32) };

async function api(actor, method, p, body) {
  const res = await fetch(`${URL_BASE}/api/v1${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOK[actor]}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  assert.ok(res.ok, `${method} ${p} as ${actor}: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}

test('live run: research-and-buy end to end', { skip: !HAVE_PUNCHLIST && 'no punchlist checkout' }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-live-data-'));
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-live-runs-'));
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: PUNCHLIST_SRC,
    env: {
      ...process.env,
      PUNCHLIST_PORT: String(PORT),
      PUNCHLIST_HOST: '127.0.0.1',
      PUNCHLIST_DATA: dataDir,
      PUNCHLIST_TOKENS: Object.entries(TOK).map(([n, v]) => `${n}:${v}`).join(','),
      PUNCHLIST_ADMIN: 'owner',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  t.after(() => {
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(runsDir, { recursive: true, force: true });
  });

  // wait for /health
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try {
      const r = await fetch(`${URL_BASE}/api/v1/health`);
      up = r.ok;
    } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(up, `punchlist server did not come up:\n${serverLog}`);

  // plt runs as the claude actor; owner steps map to the "owner" admin actor
  const plt = (args) => {
    const res = spawnSync('node', [PLT, ...args], {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        ...process.env,
        PUNCHLIST_URL: URL_BASE,
        PUNCHLIST_TOKEN: TOK.claude,
        PUNCHLIST_OWNER: 'owner',
        PLT_RUNS_DIR: runsDir,
      },
    });
    assert.strictEqual(res.status, 0, `plt ${args.join(' ')} failed:\n${res.stdout}\n${res.stderr}`);
    return res.stdout;
  };

  const findTask = async (stepId, view) => {
    const q = `&q=${encodeURIComponent(`step=${stepId} `)}`;
    const { items } = await api('owner', 'GET', `/tasks?limit=500${view ? `&view=${view}` : ''}${q}`);
    return items.find((x) => x.notes.includes(`run=${runId} step=${stepId} `));
  };

  // 1. launch — spawns only the initial step (research, assigned to hermes)
  const out = plt(['launch', 'research-and-buy', '--input', 'item=label printer', '--input', 'budget=$150']);
  const runId = out.match(/^run (\S+)$/m)[1];
  assert.ok(fs.existsSync(path.join(runsDir, `${runId}.json`)));
  const research = await findTask('research');
  assert.ok(research, 'research task exists');
  assert.strictEqual(research.assignee, 'hermes');
  assert.strictEqual(research.title, 'Research label printer under $150');
  assert.match(research.notes, /Produce output per template: research-brief \(plt show research-brief\)/);
  assert.match(research.notes, new RegExp(
    `\\n\\n---\\nplt: workflow=research-and-buy run=${runId} step=research template=research-brief attempt=1$`));
  assert.strictEqual((await findTask('decide')), undefined, 'decide not spawned yet');

  // 2. advance while research is open: no change
  assert.match(plt(['advance', '--all']), /running \(no change\)/);

  // 3. hermes claims and finishes research; owner approves (finish -> review -> done)
  await api('hermes', 'POST', `/tasks/${research.id}/claim`, {});
  await api('hermes', 'POST', `/tasks/${research.id}/finish`, { report: 'Top pick: printer X at $129.' });
  await api('owner', 'POST', `/tasks/${research.id}/approve`, {});

  // 4. advance spawns decide with the outcome checklist
  assert.match(plt(['advance', '--all']), /spawned decide/);
  const decide = await findTask('decide');
  assert.ok(decide, 'decide task exists');
  assert.strictEqual(decide.assignee, 'owner');
  assert.deepStrictEqual(decide.steps.map((s) => s.title), ['Outcome: approved', 'Outcome: rejected']);
  assert.match(decide.notes, /checking exactly ONE "Outcome:" checklist item/);

  // 5. owner records the outcome via the steps API and completes the task
  const approvedBox = decide.steps.find((s) => s.title === 'Outcome: approved');
  await api('owner', 'PATCH', `/tasks/${decide.id}/steps/${approvedBox.id}`, { done: true });
  await api('owner', 'POST', `/tasks/${decide.id}/complete`, {});

  // 6. advance takes the approved branch: order spawns, shelve never does
  assert.match(plt(['advance', '--all']), /spawned order/);
  const order = await findTask('order');
  assert.ok(order, 'order task exists');
  assert.strictEqual(order.assignee, 'hermes');
  assert.strictEqual((await findTask('shelve')), undefined, 'shelve (else branch) not spawned');
  assert.strictEqual((await findTask('escalate')), undefined, 'escalate not spawned');

  // 7. hermes finishes the order; owner approves; the run completes
  await api('hermes', 'POST', `/tasks/${order.id}/claim`, {});
  await api('hermes', 'POST', `/tasks/${order.id}/finish`, { report: 'Ordered, arriving Friday.' });
  await api('owner', 'POST', `/tasks/${order.id}/approve`, {});
  assert.match(plt(['advance', '--all']), /completed/);

  const state = JSON.parse(fs.readFileSync(path.join(runsDir, `${runId}.json`), 'utf8'));
  assert.strictEqual(state.status, 'completed');
  assert.strictEqual(state.steps.research.status, 'done');
  assert.strictEqual(state.steps.decide.outcome, 'approved');
  assert.strictEqual(state.steps.order.status, 'done');
  assert.strictEqual(state.steps.shelve, undefined);
  assert.match(plt(['runs']), new RegExp(`${runId}\\s+completed\\s+research-and-buy`));

  // 8. a completed run is not re-advanced
  assert.match(plt(['advance', '--all']), /no running runs/);
});
