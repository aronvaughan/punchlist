// service.js — cross-platform service unit rendering for `punchlist
// install-service`. Pure functions (no I/O) so they're testable and so the CLI
// can just print them with --print. The CLI (bin/punchlist) does the actual
// file write + systemctl/launchctl calls; everything platform-specific about
// WHAT to write lives here.
//
// Linux  -> a systemd *user* unit (~/.config/systemd/user/punchlist.service)
// macOS  -> a launchd LaunchAgent (~/Library/LaunchAgents/com.punchlist.plist)
// Both keep the server bound to 127.0.0.1:8600 and restart it on failure;
// tailnet exposure stays a separate concern (`tailscale serve`).
import { join } from 'node:path';

const LABEL = 'com.punchlist';

// systemd user unit — mirrors scripts/install/setup-service.sh exactly.
export function systemdUnit({ node, serverJs, repo, dataDir }) {
  return `[Unit]
Description=punchlist task manager (127.0.0.1:8600)
After=network-online.target
StartLimitBurst=4

[Service]
Environment=PUNCHLIST_DATA=${dataDir}
WorkingDirectory=${repo}
ExecStart=${node} ${serverJs}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

// XML text escape for values interpolated into the plist (paths are almost
// always plain, but a repo path could contain & or < — never emit raw).
function xml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// launchd LaunchAgent. RunAtLoad + KeepAlive{SuccessfulExit:false} is the
// launchd spelling of systemd's "start on boot, Restart=on-failure". Absolute
// node path (ProgramArguments) so it doesn't depend on launchd's minimal PATH.
export function launchdPlist({ label = LABEL, node, serverJs, repo, dataDir, logPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(serverJs)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(repo)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PUNCHLIST_DATA</key><string>${xml(dataDir)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

// Resolve the full install spec for a platform: where the unit goes, its
// contents, and the idempotent reload/start commands the CLI should run.
// `platform` is a node process.platform value ('linux' | 'darwin' | ...).
export function serviceSpec(platform, { repo, dataDir, node, home, port = 8600 }) {
  const serverJs = join(repo, 'src', 'server.js');
  if (platform === 'darwin') {
    const path = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const logPath = join(home, 'Library', 'Logs', 'punchlist.log');
    return {
      kind: 'launchd',
      label: LABEL,
      path,
      logPath,
      port,
      mode: 0o644,
      contents: launchdPlist({ node, serverJs, repo, dataDir, logPath }),
      // unload first so a re-install is idempotent (ignore its failure on first run)
      reload: [['launchctl', ['unload', path]]],
      start: [['launchctl', ['load', '-w', path]]],
      status: ['launchctl', ['list', LABEL]],
    };
  }
  // default: systemd user unit (Linux)
  const path = join(home, '.config', 'systemd', 'user', 'punchlist.service');
  return {
    kind: 'systemd',
    path,
    port,
    mode: 0o644,
    contents: systemdUnit({ node, serverJs, repo, dataDir }),
    reload: [['systemctl', ['--user', 'daemon-reload']]],
    start: [['systemctl', ['--user', 'enable', '--now', 'punchlist.service']]],
    status: ['systemctl', ['--user', 'status', 'punchlist.service']],
  };
}
