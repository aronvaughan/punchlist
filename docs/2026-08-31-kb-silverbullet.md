# Instance KB via SilverBullet (browse + edit)

**Date:** 2026-08-31
**Status:** Design — approved, not yet implemented
**Supersedes:** the native KB search/wikilink increments (incr. 3–5) from the read-only browser path

## Goal

Give each punchlist instance a real "web obsidian" for its knowledge base:
browse **and edit** markdown notes in the browser, with search, `[[wikilinks]]`,
and backlinks — without building an editor by hand and without weakening the
data-governance model.

## Decision

Run **SilverBullet** (self-hosted, Deno, edits plain markdown files on disk) as a
**second, optional service** per instance, bound to **loopback only** and exposed
over the tailnet with **`tailscale serve`**. Link to it from the Instance dialog.
Keep the existing read-only native browser as an in-app "peek."

There is no web-served Obsidian product; SilverBullet is the folder-backed,
file-on-disk analog. Trilium was rejected because it stores notes in its own DB
(breaks "browse our instance data"); real Obsidian is a per-device desktop app,
not web.

## Exposure model — why `tailscale serve`

Three options were considered:

1. **Direct-bind to the tailnet IP** (how punchlist itself is exposed today, e.g.
   `<tailnet-ip>:8600`). Consistent and zero extra code, but SB's single
   password becomes the only gate on editable private data.
2. **Reverse proxy under punchlist.** Buys a same-origin iframe (embed in the
   Instance dialog under our `default-src 'self'` CSP) and single-auth/single-port
   — but forces proxy code into the zero-dep punchlist (relaying SB's save/sync
   requests) and couples the two services' lifecycles so SB can't upgrade
   independently. Too much standing complexity for v1.
3. **Loopback + `tailscale serve`** ← chosen.
   - SB binds `127.0.0.1:<sbport>` only — never the tailnet IP.
   - `tailscale serve` fronts it with tailnet identity + automatic HTTPS, so
     access is gated by who is on the tailnet, not just an SB password.
   - Nothing new in punchlist; SB upgrades on its own.
   - The nightly `security-check.sh` sees only a loopback listener (baseline once).
   - SB's own auth stays on as defense-in-depth.

### Commands (`punchlist expose-kb`)

The port is derived from `silverbulletSpec()` (`src/service.js`) so it can
never drift from the service `install-silverbullet` actually wires up —
`3001` by default.

```bash
# enable (background, persistent)
tailscale serve --bg --https=443 http://127.0.0.1:3001

# status
tailscale serve status

# disable
tailscale serve --https=443 off
```

Resulting URL: `https://<magicdns-name>/` (this machine's Tailscale MagicDNS
name). Prerequisites (documented, not enforced by punchlist): MagicDNS +
HTTPS certs enabled on the tailnet; on Linux, a non-root user needs
`tailscale set --operator=$USER` (or sudo) to run `tailscale serve`.

`punchlist expose-kb [--off] [--status] [--print]` wraps these — `--print`
renders the commands without touching the system; the CLI never mutates SB
itself, only tailscaled state.

If two-logins friction later proves annoying, revisit the reverse proxy for
SSO + embed. Documented as a future option, not built now.

## Install / service delta (pl / plt)

SB is an **optional capability**, provisioned like KiCad is "declared but optional":

- **Runtime:** install Deno + SilverBullet.
- **Service unit:** reuse the existing `src/service.js` abstraction — systemd user
  unit on Linux, launchd LaunchAgent on macOS, auto-detected by `process.platform`.
- **Space root:** `data/kb` — **not** all of `data/`, so the sqlite db, `media/`,
  `backup/`, `govern/`, and `.env` stay out of SB's index.
- **Bind:** `127.0.0.1:<sbport>`; `tailscale serve` config (or a documented
  command) for tailnet exposure; SB password from a gitignored secret.
- **Security baseline:** add the new loopback port to `security-check.sh` so the
  nightly check doesn't re-alert (cf. the orphaned-scratch-server finding on
  2026-08-31).
- **Instance dialog:** add a link-out button to the tailscale-serve URL, next to
  the read-only native browser button.

## Governance

- SB writes land in `data/kb`, which is already the **private** plane
  (gitignored) — so **no publishable-leak risk by construction** as long as the
  space root stays under `data/`.
- Caveat, stated honestly: the `punchlist-govern` PreToolUse hook only runs on
  **agent** writes. Human edits made in SB are **folder-trust**, not enforced.
  Acceptable for a single-user instance; documented so it's not a surprise.

## Backup

Already covered — restic on `data/` picks up SB's files for free. SB is not
git-aware; git-tracking of note edits (if ever wanted) is a separate manual step.

## Disposition of the native KB work

- **Keep:** the shipped read-only browser (incr. 1–2, `public/kb.js` +
  `GET /kb/tree` + `GET /kb/file`) as the in-app peek — no context switch,
  respects punchlist auth/CSP/governance.
- **Dropped:** native `/kb/search`, wikilinks, and editing (incr. 3–5). SB does
  these natively and better. The paused uncommitted search endpoint was discarded.

## Increment plan

1. **Service scaffolding** — extend `service.js` + the `install-service` path to
   provision an optional SB unit (space root `data/kb`, loopback bind, secret-based
   password). Tests for the generated unit/plist (mirror `test/service.test.js`).
   **Done.**
2. **Exposure** — `tailscale serve` wiring + docs; verify loopback-only bind.
   **Done.** `src/tailscale.js` (pure `tailscaleServeSpec()`) + `punchlist
   expose-kb [--off|--status|--print]`; see "Commands" above.
3. **Security baseline** — teach `security-check.sh` about the SB port.
4. **Instance dialog link** — add the "Open editor →" button (tailscale-serve URL),
   keep the native read-only browser button.
5. **Docs** — `docs/macos-setup.md` + install README: how to enable SB, where the
   space lives, the governance caveat.

## Open items

- Exact SB distribution on macOS (Deno vs. single binary vs. Docker) — pick during
  increment 1.
- Whether to seed `data/kb` with a starter index page on first enable.
