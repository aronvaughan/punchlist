// tailscale.js — pure command rendering for exposing the loopback
// SilverBullet KB service over the tailnet via `tailscale serve`. Like
// service.js, this module renders argv (the CLI executes it); no I/O here.
//
// The target passed to `tailscale serve` MUST stay loopback (127.0.0.1) —
// `tailscale serve` is the only tailnet edge: it terminates HTTPS and gates
// access by tailnet identity, so the service itself never binds anything
// beyond localhost. See docs/2026-08-31-kb-silverbullet.md ("Exposure model").
export function tailscaleServeSpec({ port, host = '127.0.0.1', httpsPort = 443 }) {
  const target = `http://${host}:${port}`;
  return {
    target,
    httpsPort,
    on: ['tailscale', ['serve', '--bg', `--https=${httpsPort}`, target]],
    off: ['tailscale', ['serve', `--https=${httpsPort}`, 'off']],
    status: ['tailscale', ['serve', 'status']],
  };
}
