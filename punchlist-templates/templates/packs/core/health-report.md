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
**on-demand** = caller picks. The six sections:

1. **Services & Ports** — gateways/daemons up and listening (hermes-gateway,
   dashboard, llama-swap, punchlist :8600, openviking :1933, the local AI
   model port, SilverBullet :3001), every declared unit active, tailscale up.
2. **Wiring & Config** — plugins enabled == installed; MCP registered ==
   registry; the claude↔hermes↔punchlist delegation pairing; punchlist configs
   present; active config materialized.
3. **Backups** — commit backup (unpushed / dirty / push-failed per repo) and
   disk backup (restic snapshot age + reachable + retention) + repo size;
   the offsite-gap advisory.
4. **Content & Sizes** — skills (total / broken / linked); KB size (files per
   section + total + dangling links); punchlist queue depths; suspicious mail.
5. **Logs** — last-24h scan of the hermes / punchlist / state logs for crashes
   (restart-loops) and severe signatures (Traceback / OOM / segfault); a
   traceback a healthy service caught is `ℹ` context, not an alarm.
6. **Cron jobs** — every declared cron with its humanized schedule, installed
   status, and best-effort last-run time (from the job's real output log).

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
⑥ Cron jobs          <per-job list: schedule · installed · last-run>

doctor: <n> ok / <n> warn / <n> fail / <n> critical
```

## Golden exemplar

# Ecosystem health — workstation-01 — 2026-09-03 04:00

**Verdict:** DEGRADED — 1 warn, 0 fail, 0 critical

## Needs attention
- ⚠ Backups: restic snapshot is 40h old (>36h WARN) — check /mnt/spinner, run nightly-restic-backup.sh

① Services & Ports   ✓ hermes-gateway/dashboard/llama-swap · ✓ punchlist:8600 (v1.0.1-rc.1) · ✓ openviking:1933 · ✓ AI model port · ✓ silverbullet:3001 · ✓ tailscale
② Wiring & Config    ✓ plugins 4/4 · ✓ mcp 2/2 · ✓ claude↔hermes delegation · ✓ punchlist configs present · ✓ CLAUDE.md
③ Backups            ⚠ restic 40h old · ✓ git-nightly clean (0 repos behind) · ℹ offsite gap · repo 3.2G / 28 snapshots
④ Content & Sizes    ✓ skills 142 total / 0 broken / 2 linked · ℹ kb 88 files / 2.1M / 0 dangling · ℹ queue 0c·0h·0r · ✓ 0 suspicious
⑤ Logs               ✓ no crashes or restart-loops (24h)
⑥ Cron jobs          ✓ 9/9 installed · git-backup 4h · restic 4h · doctor 0h · security-check 2h · queue-sweep 0h · …

doctor: 28 ok / 1 warn / 0 fail / 0 critical

*A verdict of DEGRADED means: usable, nothing broken, but one thing wants a
look — a slightly stale disk backup. The `ℹ` lines (offsite gap, kb size,
queue depths) are context, not problems, so they don't touch the verdict.*
