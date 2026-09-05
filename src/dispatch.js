// dispatch.js — event-driven agent dispatch. Design:
// docs/2026-09-03-event-dispatch.md (Revision 2); plan:
// docs/2026-09-05-event-dispatch-plan.md.
//
// Pure + injectable: given a `db`, a `spawn(cmd, agent) -> child`, and `now()`,
// it decides when to wake an agent's headless orchestrator. Gated by
// settings.dispatch_enabled — with it OFF (the default), every entry point is a
// no-op, so the server behaves exactly as before. No polling: driven by
// onChange() calls from the in-process bus, with reconcile() as a crash /
// missed-event safety net.
//
// Config (hybrid, from the `settings` table):
//   dispatch_enabled     '0'|'1'
//   dispatch_debounce_ms  coalesce an event burst into one wake (default 2000)
//   dispatch_agents       JSON {agent: {cmd, max}} (malformed → {}, never throws)

export function createDispatcher({ db, spawn, now = () => Date.now() }) {
  const getSetting = (k, d = '') =>
    db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? d;

  function config() {
    const enabled = getSetting('dispatch_enabled', '0') === '1';
    const debounceMs = Number(getSetting('dispatch_debounce_ms', '2000')) || 0;
    let agents = {};
    try {
      const parsed = JSON.parse(getSetting('dispatch_agents', '') || '{}');
      if (parsed && typeof parsed === 'object') agents = parsed;
    } catch { /* malformed JSON → no agents, never throw */ }
    return { enabled, debounceMs, agents };
  }

  // Q3 predicate — reuse the exact `queue`-view filter so dispatch and an
  // agent's own queue can never disagree. `status='active'` already excludes
  // blocked (needs-input), in_progress (claimed), review, done, archived.
  const claimable = a =>
    db.prepare("SELECT COUNT(*) n FROM tasks WHERE status='active' AND assignee=? AND vetted=1").get(a).n;
  const executing = a =>
    db.prepare("SELECT COUNT(*) n FROM tasks WHERE status='in_progress' AND assignee=?").get(a).n;

  const live = new Map();   // agent -> { pid, startedAt } — orchestrators in flight
  const timers = new Map(); // agent -> debounce timer

  // Synchronous decision + spawn for one agent. Returns why it did/didn't fire.
  function tryDispatch(agent) {
    const { enabled, agents } = config();
    if (!enabled) return { spawned: false, reason: 'disabled' };
    const spec = agents[agent];
    if (!spec || !spec.cmd) return { spawned: false, reason: 'not-configured' };
    if (live.has(agent)) return { spawned: false, reason: 'already-live' };
    const max = Number(spec.max) || 1;
    if (executing(agent) >= max) return { spawned: false, reason: 'watermark' };
    if (claimable(agent) <= 0) return { spawned: false, reason: 'no-work' };
    const child = spawn(spec.cmd, agent);
    live.set(agent, { pid: child?.pid, startedAt: now() });
    if (child && typeof child.on === 'function') child.on('exit', () => live.delete(agent));
    return { spawned: true, pid: child?.pid, reason: 'spawned' };
  }

  // Edge trigger from the bus. Debounced per agent so an event burst = one wake.
  function onChange(agent) {
    if (!agent) return;
    const { enabled, debounceMs, agents } = config();
    if (!enabled || !agents[agent]) return;      // cheap early-out, no timer churn
    if (debounceMs <= 0) { tryDispatch(agent); return; }
    if (timers.has(agent)) return;                // a wake is already pending → coalesce
    const t = setTimeout(() => { timers.delete(agent); tryDispatch(agent); }, debounceMs);
    if (typeof t.unref === 'function') t.unref();
    timers.set(agent, t);
  }

  // Safety net: sweep every configured agent (catches anything the bus missed).
  function reconcile() {
    const { enabled, agents } = config();
    if (!enabled) return;
    for (const agent of Object.keys(agents)) tryDispatch(agent);
  }

  function stop() { for (const t of timers.values()) clearTimeout(t); timers.clear(); }

  return { onChange, reconcile, tryDispatch, liveCount: () => live.size, stop };
}
