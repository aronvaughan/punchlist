---
name: health-report
kind: template
domain: engineering
inputs:
  - name: host
    exemplar: "workstation-01 — the machine being checked (scopes which subsystems apply)"
  - name: sections
    exemplar: "all sections at `summary`; or a subset at `full` (e.g. backups,logs) to tailor verbosity"
output: markdown
tags: [health, ops, monitoring, doctor]
---
## Purpose

A health report is read by someone asking one question: **is anything wrong,
and if so what do I do?** Write for that reader, not for a metrics dump.

- **Verdict first.** Line 1 answers the question — `HEALTHY` / `DEGRADED` /
  `UNHEALTHY` / `CRITICAL`. Read one line, know the state.
- **Lift attention to the top.** A *Needs attention* block collects every
  non-OK check with its fix, so the reader never scans green sections hunting
  for the one red line.
- **Every non-OK line carries a fix** — a command or next step, never a bare
  "✗ restic failing".
- **Scope gracefully.** Report only the subsystems this machine has; a box
  without the Hermes vault or the punchlist service simply omits them.
- **Thresholds are explicit** (ages, counts) so "stale" is defined, not vibes.
- **Machine-readable summary** at the end so tooling (a startup one-liner, the
  task-on-failure rule) can parse it.

### Severity — four tiers
`✓ OK` · `⚠ WARN` (degraded, not urgent) · `✗ FAIL` (broken, act) ·
`⛔ CRITICAL` (data-loss or security). **Verdict = the worst tier present**
(all OK → HEALTHY; any WARN → DEGRADED; any FAIL → UNHEALTHY; any CRITICAL →
CRITICAL). **Task-filing:** CRITICAL files a punchlist task immediately; FAIL
files if it persists a run; WARN/OK never do. Reserve CRITICAL for:
suspicious inbound mail, a repo with unpushed work not captured by backup,
the backup unreachable and stale, or a leaked secret.

### Sections & verbosity
Checks are grouped into named sections, each rendered at a dial —
`off` · `verdict` (one rolled-up line) · `summary` (only non-OK checks) ·
`full` (every check). Typical profiles: **startup** = all at `verdict`;
**nightly** = all at `summary`, auto-`full` for any FAIL/CRITICAL;
**on-demand** = caller picks. The five sections:

1. **Services & Ports** — gateways/daemons up and listening (hermes-gateway,
   dashboard, llama-swap, punchlist :8600, openviking :1933, the local AI
   model port), every declared unit active, tailscale up.
2. **Wiring & Config** — crons declared == installed; plugins enabled ==
   installed; MCP registered == registry; the claude↔hermes↔punchlist
   delegation pairing; punchlist configs present; active config materialized.
3. **Backups** — commit backup (unpushed / dirty / push-failed per repo) and
   disk backup (restic snapshot age + reachable + retention) + repo size;
   the offsite-gap advisory.
4. **Content & Sizes** — skills (total / broken / linked); KB size (files per
   section + total + dangling links); punchlist queue depths; suspicious mail.
5. **Logs** — last-24h scan of the hermes / punchlist / claude / openviking /
   security logs for error / traceback / OOM / crash / restart-loop.

## Output shape

```markdown
# Ecosystem health — <host> — <timestamp>
**Verdict:** <HEALTHY | DEGRADED | UNHEALTHY | CRITICAL> — <n warn, n fail, n critical>

## Needs attention        (omit when empty)
- <⚠|✗|⛔> <section>: <what's wrong, with the threshold> — <the fix / command>

① Services & Ports   <✓/⚠/✗ rolled-up line, or per-check list at `full`>
② Wiring & Config    <…>
③ Backups            <…>
④ Content & Sizes    <…>
⑤ Logs               <…>

doctor: <n> ok / <n> warn / <n> fail / <n> critical
```

## Golden exemplar

# Ecosystem health — workstation-01 — 2026-09-03 04:00

**Verdict:** DEGRADED — 2 warn, 0 fail, 0 critical

## Needs attention
- ⚠ Backups: restic snapshot is 40h old (>36h WARN) — check /mnt/spinner, run nightly-restic-backup.sh
- ⚠ Backups: disk-only plane (state.db, sessions, .env) has no offsite copy — standing advisory, no action unless you want offsite

① Services & Ports   ✓ hermes-gateway/dashboard/llama-swap · ✓ punchlist:8600 (v1.0.1-rc.1) · ✓ openviking:1933 · ✓ AI model port · ✓ tailscale
② Wiring & Config    ✓ crons 9/9 installed · ✓ plugins 4/4 · ✓ mcp 2/2 · ✓ claude↔hermes delegation · ✓ punchlist configs present
③ Backups            ⚠ restic 40h old · ✓ git-nightly clean (0 repos behind) · ⚠ offsite gap · repo 3.2G / 28 snapshots
④ Content & Sizes    ✓ skills 142 total / 0 broken / 2 linked · kb 88 files / 2.1M / 0 dangling · queue 0 claude·0 hermes·0 review · 0 suspicious
⑤ Logs               ✓ no errors, crashes, or restart-loops in the last 24h

doctor: 21 ok / 2 warn / 0 fail / 0 critical

*A verdict of DEGRADED means: usable, nothing broken, but two things want a
look — a slightly stale disk backup and the standing reminder that the
runtime state plane has no offsite copy. Neither blocks work.*
