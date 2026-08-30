# punchlist on macOS (standalone instance + local Claude agent)

This sets up a **self-contained punchlist on a Mac**: its own task list, its own
always-on server, and a local Claude agent that works the Mac's own codebases.
No Hermes. Each Mac is independent (separate data), unlike the shared-instance
model where Macs are just browser clients of the Linux box.

The server and CLIs are cross-platform; the only macOS-specific pieces are the
service manager (launchd instead of systemd) and the cron caveat below — both
handled by the tooling.

---

## 1. Prerequisites

```bash
# Homebrew packages
brew install node jq coreutils            # node >=26 (node:sqlite); jq for pl.sh;
                                          # coreutils gives gtimeout for the sweep
node -v                                   # must be >= 26
command -v claude                         # the Claude Code CLI must be installed & signed in
```

`coreutils` matters: the agent sweep needs a `timeout` binary and macOS ships
none — coreutils provides `gtimeout`, which the sweep auto-detects.

## 2. Clone the repos (same layout as the Linux box)

```bash
mkdir -p ~/code && cd ~/code
git clone <punchlist remote> punchlist
cd punchlist && npm install
npm link            # puts `punchlist` on PATH (or: npm i -g .)
```

## 3. Generate a token and create data/.env

```bash
punchlist gen-token aron        # prints a PUNCHLIST_TOKENS line + a client PUNCHLIST_TOKEN
# (add a second actor for the agent)
punchlist gen-token claude
```

Create `~/code/punchlist/data/.env` (chmod 600). Combine the actors
onto ONE `PUNCHLIST_TOKENS` line (comma-separated `name:token`):

```
PUNCHLIST_TOKENS=aron:<aron-token>,claude:<claude-token>
PUNCHLIST_ADMIN=aron
```

```bash
chmod 600 ~/code/punchlist/data/.env
```

The first actor is the admin unless `PUNCHLIST_ADMIN` is set. The server refuses
to start without tokens (fail-closed), and tokens must be ≥32 chars (gen-token
emits 48).

## 4. Install the always-on service (launchd)

```bash
punchlist install-service          # writes ~/Library/LaunchAgents/com.punchlist.plist and loads it
# review first if you like:
punchlist install-service --print  # print the plist, install nothing
```

Same command as on Linux — it detects the OS and writes a **launchd LaunchAgent**
(`RunAtLoad` + `KeepAlive` = start on login, restart on failure) instead of a
systemd unit. It health-checks `http://127.0.0.1:8600` and reports success.

Manage it:

```bash
launchctl list com.punchlist                                   # is it loaded?
launchctl unload ~/Library/LaunchAgents/com.punchlist.plist    # stop
launchctl load -w ~/Library/LaunchAgents/com.punchlist.plist   # start
tail -f ~/Library/Logs/punchlist.log                           # logs
```

> On Big Sur+ the modern spelling is `launchctl bootstrap gui/$(id -u) <plist>` /
> `bootout gui/$(id -u)/com.punchlist`; the `load -w`/`unload` used above still
> works everywhere.

## 5. Point the client at it

- **Web UI:** open `http://127.0.0.1:8600` and paste the **aron** token (stored in
  that browser's localStorage). To reach this Mac's list from elsewhere on your
  tailnet, add `tailscale serve --bg --tcp 8600 tcp://127.0.0.1:8600`.
- **CLI (`pl`):** the av-punchlist skill's `pl.sh` reads the token from
  `~/.claude/secrets.local.env` — add `PUNCHLIST_TOKEN=<the actor's token>`
  (chmod 600). `pl.sh` is already portable (POSIX sed/jq/curl).

## 6. The local Claude agent (the sweep)

The orchestrator lives in `~/.claude/scripts/claude-queue-sweep.sh` and is now
portable — it auto-detects `flock`→`mkdir` lock, `gtimeout`, a POSIX timestamp,
and resolves `claude` from PATH. It reads the **claude** actor's token from
`~/.claude/secrets.local.env`.

Schedule it every 30 min. Two options:

### Option A — crontab (matches the Linux box; `register-crons.sh` supports macOS)

Add a `machines.<this-mac-hostname>.crons` entry in `~/.claude/setup/directives.json`:

```
*/30 * * * * bash $HOME/.claude/scripts/claude-queue-sweep.sh
```

then run `av-claude-setup` (or `~/.claude/setup/register-crons.sh`) — it uses
`scutil --get LocalHostName` for a stable Mac hostname and installs via `crontab`.

> ⚠️ **macOS cron needs Full Disk Access.** Grant it in System Settings →
> Privacy & Security → **Full Disk Access** → add `/usr/sbin/cron`. Without it,
> cron jobs silently can't read many paths. cron also runs with a minimal PATH,
> which is why the sweep resolves `claude`/`gtimeout` by absolute discovery.

### Option B — launchd timer (macOS-native, no Full Disk Access dance)

Create `~/Library/LaunchAgents/com.punchlist.sweep.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.punchlist.sweep</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>exec "$HOME/.claude/scripts/claude-queue-sweep.sh"</string>
  </array>
  <key>StartInterval</key><integer>1800</integer>
  <key>StandardOutPath</key><string>/tmp/punchlist-sweep.out</string>
  <key>StandardErrorPath</key><string>/tmp/punchlist-sweep.err</string>
</dict>
</plist>
```

```bash
launchctl load -w ~/Library/LaunchAgents/com.punchlist.sweep.plist
```

`-lc` gives the job a login shell so `claude` and `gtimeout` are on PATH.

## 7. Onboard the Mac into the ~/.claude config repo

Follow `~/.claude/setup/ONBOARDING.md`: add a `machines.<hostname>` block
(`os: macos`) to `setup/directives.json`, create `CLAUDE.<hostname>.md` and
`settings.local.<hostname>.json`, then run **`av-claude-setup`**. Turn Hermes off
for this machine via `skillOverrides` (no Hermes on the Macs).

---

## What's macOS-specific (and where it's handled)

| Concern | Linux | macOS | Handled by |
| --- | --- | --- | --- |
| Service manager | systemd user unit | launchd LaunchAgent | `punchlist install-service` (auto-detects) |
| Sweep timestamp | `date -Is` | POSIX `date +…%z` | `now()` shim in the sweep |
| Sweep lock | `flock` | atomic `mkdir` lock | sweep detects `flock`, else mkdir |
| Sweep timeout | `timeout` | `gtimeout` (coreutils) | sweep detects either |
| `claude` path | `~/.local/bin/claude` | Homebrew/npm path | `command -v claude` in the sweep |
| Cron scheduling | crontab | crontab (+ Full Disk Access) or launchd | `register-crons.sh` (macOS-aware) / Option B |

The runtime CLIs (`pl.sh`, `plt`) were already portable — POSIX `sed`/`curl`/`jq`
and pure Node — so nothing there changed.
