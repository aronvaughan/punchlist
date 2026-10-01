#!/usr/bin/env node
'use strict';
// A `gh` stand-in for CLI-level tests: PLT_GH points here, PLT_GH_FIXTURE names a fixture file
// under this directory (the {view, threads} shape `lib/facts.js#prFacts` expects). Serves
// `gh pr view ...` from `.view` and `gh api graphql ...` from `.threads`, whatever PR number or
// repo was asked for — one fixture per stub invocation is all these tests need.
const fs = require('fs');
const args = process.argv.slice(2);
const file = process.env.PLT_GH_FIXTURE;
if (!file) { process.stderr.write('gh stub: PLT_GH_FIXTURE is not set\n'); process.exit(1); }
const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
// PLT_GH_FAIL_PR=<number> makes the stub fail for that one PR (an unreachable/private PR, or an
// expired token), so a test can prove one bad PR does not abort a whole collect pass.
const failPr = process.env.PLT_GH_FAIL_PR;
if (failPr && args.some((a) => a === failPr || a === `number=${failPr}`)) {
  process.stderr.write(`gh stub: HTTP 404: Not Found (pull request ${failPr})\n`);
  process.exit(1);
}
// PLT_GH_LOG=<file> appends each call's args as one JSON line, so a test can see which repo was asked.
if (process.env.PLT_GH_LOG) fs.appendFileSync(process.env.PLT_GH_LOG, JSON.stringify(args) + '\n');
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify(fixture.view));
} else if (args[0] === 'api' && args.includes('graphql')) {
  process.stdout.write(JSON.stringify(fixture.threads));
} else {
  process.stderr.write('gh stub: unrecognized args ' + args.join(' ') + '\n');
  process.exit(1);
}
