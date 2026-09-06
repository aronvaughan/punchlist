// kb-remount.js — the side-effectful counterpart to service.js's pure spec
// builders. `punchlist install-silverbullet` already resolves SB's space dir
// from the instance `kb_path` setting, but it only ran once at install time:
// changing kb_path afterwards left SilverBullet serving the OLD folder, so
// "Browse (read-only)" (which reads kb_path) and "Open editor" (which opens
// SB) pointed at different vaults. This remounts SB when kb_path changes.
//
// Deliberately rewrites only the space-dir argument of the existing wrapper
// rather than regenerating it from silverbulletSpec(): the installed wrapper
// holds a resolved absolute binary path (and possibly a non-default port or
// SILVERBULLET_CMD) that the server has no way to re-derive, and clobbering
// it with the 'silverbullet' PATH default would break the service.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { silverbulletSpec, resolveKbSpaceDir } from './service.js';

// The wrapper's final line, as written by silverbulletWrapper():
//   exec "<cmd>" -p "<port>" -L "<host>" "<spaceDir>"
// Captures everything up to the last quoted argument so only that argument
// is replaced; cmd/port/host/env-file lines are preserved byte-for-byte.
const EXEC_LINE = /^(exec\s+.*\s)"([^"]*)"(\s*)$/m;

function defaultRun(cmd, args) {
  execFileSync(cmd, args, { stdio: 'ignore', timeout: 30000 });
}

// Restart commands per service kind. systemd restart is a single verb;
// launchd needs an unload/load pair against the plist path.
function restartCommands(spec) {
  if (spec.kind === 'launchd') {
    return [['launchctl', ['unload', spec.path]], ['launchctl', ['load', '-w', spec.path]]];
  }
  return [['systemctl', ['--user', 'restart', 'punchlist-silverbullet.service']]];
}

// Point an already-installed SilverBullet service at the space dir implied by
// `kbPath` and restart it. Best-effort and non-throwing: a failure here must
// never fail the PATCH that triggered it, so every outcome is reported in the
// return value instead. Returns { remounted, reason, spaceDir }.
export function remountSilverbullet({
  dataDir, kbPath, home = homedir(), platform = process.platform,
  run = defaultRun, log = console.error,
} = {}) {
  const spaceDir = resolveKbSpaceDir(dataDir, kbPath);
  let spec;
  try {
    spec = silverbulletSpec(platform, { spaceDir, home });
  } catch (err) {
    log(`kb remount: unsupported platform: ${err.message}`);
    return { remounted: false, reason: 'unsupported-platform', spaceDir };
  }

  // Never provision SB for an operator who never opted in by running
  // `punchlist install-silverbullet` — only remount an existing install.
  if (!existsSync(spec.wrapperPath) || !existsSync(spec.path)) {
    return { remounted: false, reason: 'not-installed', spaceDir };
  }

  let wrapper;
  try {
    wrapper = readFileSync(spec.wrapperPath, 'utf8');
  } catch (err) {
    log(`kb remount: cannot read ${spec.wrapperPath}: ${err.message}`);
    return { remounted: false, reason: 'unreadable-wrapper', spaceDir };
  }

  const m = wrapper.match(EXEC_LINE);
  if (!m) {
    log(`kb remount: no exec line in ${spec.wrapperPath}; leaving it alone`);
    return { remounted: false, reason: 'unrecognized-wrapper', spaceDir };
  }
  if (m[2] === spaceDir) return { remounted: false, reason: 'unchanged', spaceDir };

  // A space dir containing a double quote would break out of the quoted
  // argument into arbitrary shell — refuse rather than write it.
  if (spaceDir.includes('"')) {
    log('kb remount: refusing a kb_path containing a double quote');
    return { remounted: false, reason: 'unsafe-path', spaceDir };
  }

  try {
    writeFileSync(spec.wrapperPath, wrapper.replace(EXEC_LINE, `$1"${spaceDir}"$3`), { mode: spec.wrapperMode });
  } catch (err) {
    log(`kb remount: cannot write ${spec.wrapperPath}: ${err.message}`);
    return { remounted: false, reason: 'unwritable-wrapper', spaceDir };
  }

  for (const [cmd, args] of restartCommands(spec)) {
    try {
      run(cmd, args);
    } catch (err) {
      // The wrapper is already updated, so the new space dir takes effect on
      // the service's next start either way — report, don't unwind.
      log(`kb remount: ${cmd} ${args.join(' ')} failed: ${err.message}`);
      return { remounted: false, reason: 'restart-failed', spaceDir };
    }
  }
  return { remounted: true, reason: 'remounted', spaceDir };
}
