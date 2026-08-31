// tailscale.test.js — pure command rendering for `punchlist expose-kb`.
// Mirrors test/service.test.js's style: assert argv shape only, never execute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tailscaleServeSpec } from '../src/tailscale.js';

test('tailscaleServeSpec: defaults (port 3001, host 127.0.0.1, httpsPort 443)', () => {
  const s = tailscaleServeSpec({ port: 3001 });
  assert.equal(s.target, 'http://127.0.0.1:3001');
  assert.equal(s.httpsPort, 443);
  assert.deepEqual(s.on, ['tailscale', ['serve', '--bg', '--https=443', 'http://127.0.0.1:3001']]);
  assert.deepEqual(s.off, ['tailscale', ['serve', '--https=443', 'off']]);
  assert.deepEqual(s.status, ['tailscale', ['serve', 'status']]);
});

test('tailscaleServeSpec: custom port flows into target and on-command', () => {
  const s = tailscaleServeSpec({ port: 4000 });
  assert.equal(s.target, 'http://127.0.0.1:4000');
  assert.deepEqual(s.on, ['tailscale', ['serve', '--bg', '--https=443', 'http://127.0.0.1:4000']]);
});

test('tailscaleServeSpec: custom host flows into target', () => {
  const s = tailscaleServeSpec({ port: 3001, host: '127.0.0.2' });
  assert.equal(s.target, 'http://127.0.0.2:3001');
  assert.deepEqual(s.on, ['tailscale', ['serve', '--bg', '--https=443', 'http://127.0.0.2:3001']]);
});

test('tailscaleServeSpec: custom httpsPort flows into on/off (both share it)', () => {
  const s = tailscaleServeSpec({ port: 3001, httpsPort: 8443 });
  assert.equal(s.httpsPort, 8443);
  assert.deepEqual(s.on, ['tailscale', ['serve', '--bg', '--https=8443', 'http://127.0.0.1:3001']]);
  assert.deepEqual(s.off, ['tailscale', ['serve', '--https=8443', 'off']]);
});

test('tailscaleServeSpec: on includes --bg (persistent background config)', () => {
  const s = tailscaleServeSpec({ port: 3001 });
  assert.ok(s.on[1].includes('--bg'));
});

test('tailscaleServeSpec: status is independent of port/host/httpsPort', () => {
  const s = tailscaleServeSpec({ port: 9999, host: '10.0.0.1', httpsPort: 8443 });
  assert.deepEqual(s.status, ['tailscale', ['serve', 'status']]);
});
