#!/usr/bin/env node
'use strict';
// A `windows.notify` stand-in for watch.test.js — appends one JSON line per invocation (its argv)
// to the file named by WATCH_NOTIFY_LOG, so a test can assert exactly which runs got notified and
// with what {run, text, next, tab_id, pane_id, label} values.
const fs = require('fs');
const file = process.env.WATCH_NOTIFY_LOG;
if (!file) { process.stderr.write('notify-stub: WATCH_NOTIFY_LOG is not set\n'); process.exit(1); }
const [run, text, next, tab_id, pane_id, label] = process.argv.slice(2);
fs.appendFileSync(file, JSON.stringify({ run, text, next, tab_id, pane_id, label }) + '\n');
