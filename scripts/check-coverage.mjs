#!/usr/bin/env node
// check-coverage.mjs — run the exact `node --test --experimental-test-coverage`
// gate and FAIL (exit 1) when all-files line coverage drops below the design
// doc's 80% floor. Node reports coverage but exits 0 regardless; this makes
// the documented gate real.
import { spawnSync } from 'node:child_process';

const FLOOR = 80;

const r = spawnSync(process.execPath, ['--test', '--experimental-test-coverage'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
process.stdout.write(r.stdout ?? '');
process.stderr.write(r.stderr ?? '');
if (r.status !== 0) process.exit(r.status ?? 1);

const m = /all files\s*\|\s*([\d.]+)/.exec(r.stdout);
if (!m) {
  console.error('check-coverage: could not find the "all files" coverage summary line');
  process.exit(1);
}
const lines = Number(m[1]);
if (lines < FLOOR) {
  console.error(`check-coverage: FAIL — ${lines}% line coverage is below the ${FLOOR}% floor`);
  process.exit(1);
}
console.log(`check-coverage: OK — ${lines}% line coverage (floor ${FLOOR}%)`);
