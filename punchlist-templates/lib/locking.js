'use strict';
// locking — advisory file lock + atomic write for the process spine.
// Standalone module: no dependency on spine.js, which calls withLock from
// writeState and appendEvent. This file is tested on its own.
const fs = require('fs');
const os = require('os');
const path = require('path');

let counter = 0;

// Synchronous sleep (no timers/event-loop dependency) via Atomics.wait on a
// scratch SharedArrayBuffer — blocks the thread without spinning the CPU.
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(sleepBuf, 0, 0, ms); }

// Writes `data` to a temp sibling of `filePath`, fsyncs it, then renames onto
// `filePath` — same directory, so the rename is atomic on one filesystem.
// The temp file is removed on any error before the rename lands, so a crash
// never leaves `.<basename>.<pid>.<counter>.tmp` litter beside the real file.
function writeFileAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.${process.pid}.${counter++}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e2) { /* already closed */ } }
    try { fs.unlinkSync(tmp); } catch (e2) { /* never written, or already gone */ }
    throw e;
  }
}

// Takes an advisory lock at <dir>/.plt.lock (O_EXCL, so only one writer can
// hold it) and runs fn() while holding it, releasing in a finally even when
// fn throws. On EEXIST it re-reads the lock; if the holder's timestamp is
// older than staleMs, the lock is recoverable — the holder process is
// presumed dead (crashed mid-write, or killed) and the lock is removed once,
// then retried. A live holder just keeps refusing until timeoutMs elapses,
// at which point withLock throws rather than silently proceeding unlocked.
function withLock(dir, fn, { timeoutMs = 5000, staleMs = 30000, sleepMs = 25 } = {}) {
  const lock = path.join(dir, '.plt.lock');
  const deadline = Date.now() + timeoutMs;
  let staleTried = false;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch (e2) { /* already closed */ } }
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch (e2) { /* lock vanished or mid-write; retry below */ }
      if (!staleTried && holder && typeof holder.at === 'number' && Date.now() - holder.at > staleMs) {
        staleTried = true;
        try { fs.unlinkSync(lock); } catch (e2) { /* already reclaimed by someone else */ }
        continue;
      }
      if (Date.now() >= deadline) {
        const pid = holder && holder.pid;
        const at = holder && holder.at;
        throw new Error(`another plt is writing ${dir}; retry in a moment (lock held by pid ${pid} since ${at})`);
      }
      sleepSync(sleepMs);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lock); } catch (e) { /* already gone */ }
  }
}

module.exports = { writeFileAtomic, withLock };
