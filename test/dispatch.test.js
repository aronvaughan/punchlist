// dispatch.test.js — the event-driven dispatch brain (src/dispatch.js), tested
// in isolation over an in-memory DB with an injected fake spawn. No live server,
// no real processes. See docs/2026-09-05-event-dispatch-plan.md, Increment 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { open } from '../src/db.js';
import { createDispatcher } from '../src/dispatch.js';

function setup() {
  const { db, migrate } = open(':memory:');
  migrate();
  const spawns = [];
  const spawn = (cmd, agent) => { spawns.push({ cmd, agent }); return { pid: 100 + spawns.length, on() {} }; };
  let seq = 0;
  const addTask = (assignee, status, vetted = 1) => {
    const id = 'T' + String(++seq).padStart(4, '0');
    const t = '2026-01-01T00:00:00Z';
    db.prepare('INSERT INTO tasks (id,title,status,created_at,updated_at,assignee,vetted) VALUES (?,?,?,?,?,?,?)')
      .run(id, 'task ' + id, status, t, t, assignee, vetted);
    return id;
  };
  const set = obj => {
    for (const [k, v] of Object.entries(obj)) {
      db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
    }
  };
  const enable = (agents = { claude: { cmd: '/bin/echo', max: 1 } }) =>
    set({ dispatch_enabled: '1', dispatch_agents: JSON.stringify(agents) });
  const d = createDispatcher({ db, spawn });
  return { db, spawns, addTask, set, enable, d };
}

test('disabled by default → no spawn', () => {
  const { addTask, spawns, d } = setup();
  addTask('claude', 'active');
  assert.equal(d.tryDispatch('claude').reason, 'disabled');
  assert.equal(spawns.length, 0);
});

test('enabled but agent not configured → no spawn', () => {
  const { addTask, enable, spawns, d } = setup();
  enable({ hermes: { cmd: '/bin/echo' } });
  addTask('claude', 'active');
  assert.equal(d.tryDispatch('claude').reason, 'not-configured');
  assert.equal(spawns.length, 0);
});

test('no claimable work → no spawn', () => {
  const { enable, spawns, d } = setup();
  enable();
  assert.equal(d.tryDispatch('claude').reason, 'no-work');
  assert.equal(spawns.length, 0);
});

test('unvetted / in_progress / blocked do not count as claimable', () => {
  const { addTask, enable, spawns, d } = setup();
  enable({ claude: { cmd: '/bin/echo', max: 5 } }); // high max so watermark can't fire first
  addTask('claude', 'active', 0);   // unvetted
  addTask('claude', 'in_progress'); // already claimed
  addTask('claude', 'blocked');     // needs-input
  assert.equal(d.tryDispatch('claude').reason, 'no-work');
  assert.equal(spawns.length, 0);
});

test('claimable work → spawns once, right agent', () => {
  const { addTask, enable, spawns, d } = setup();
  enable();
  addTask('claude', 'active');
  const r = d.tryDispatch('claude');
  assert.equal(r.spawned, true);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].agent, 'claude');
  assert.equal(spawns[0].cmd, '/bin/echo');
});

test('already-live → no second spawn', () => {
  const { addTask, enable, spawns, d } = setup();
  enable();
  addTask('claude', 'active');
  d.tryDispatch('claude');
  assert.equal(d.tryDispatch('claude').reason, 'already-live');
  assert.equal(spawns.length, 1);
  assert.equal(d.liveCount(), 1);
});

test('watermark holds at max executing', () => {
  const { addTask, enable, spawns, d } = setup();
  enable({ claude: { cmd: '/bin/echo', max: 1 } });
  addTask('claude', 'in_progress'); // executing = 1 = max
  addTask('claude', 'active');      // claimable, but at watermark
  assert.equal(d.tryDispatch('claude').reason, 'watermark');
  assert.equal(spawns.length, 0);
});

test('reconcile spawns for an agent with missed claimable work', () => {
  const { addTask, enable, spawns, d } = setup();
  enable();
  addTask('claude', 'active');
  d.reconcile();
  assert.equal(spawns.length, 1);
});

test('malformed dispatch_agents JSON → treated as empty, never throws', () => {
  const { addTask, set, spawns, d } = setup();
  set({ dispatch_enabled: '1', dispatch_agents: '{not json' });
  addTask('claude', 'active');
  assert.equal(d.tryDispatch('claude').reason, 'not-configured');
  assert.equal(spawns.length, 0);
});

test('onChange debounces a burst into one spawn', async () => {
  const { addTask, set, spawns, d } = setup();
  set({
    dispatch_enabled: '1',
    dispatch_debounce_ms: '20',
    dispatch_agents: JSON.stringify({ claude: { cmd: '/bin/echo', max: 1 } }),
  });
  addTask('claude', 'active');
  d.onChange('claude'); d.onChange('claude'); d.onChange('claude');
  assert.equal(spawns.length, 0);  // debounced — nothing yet
  await sleep(50);
  assert.equal(spawns.length, 1);  // coalesced into one wake
  d.stop();
});
