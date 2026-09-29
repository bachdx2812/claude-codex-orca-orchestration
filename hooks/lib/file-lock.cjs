#!/usr/bin/env node
/**
 * file-lock.cjs — a small cross-process mutual-exclusion lock for the gate's state file,
 * used wherever two parallel Bash tool calls could otherwise both read the same "count so
 * far" before either has written its own reservation (the race the parallel-limit and
 * ownership-overlap gates both need to close).
 *
 * `fs.mkdirSync` on a not-yet-existing directory is the primitive: POSIX and Windows both
 * guarantee that create is atomic, so two processes racing to create the same directory
 * always leave exactly one winner. No dependency, no advisory-lock file format to parse.
 */

'use strict';

const fs = require('fs');

/**
 * Acquire the lock, retrying for up to `timeoutMs`. Returns true when acquired (the
 * caller must release it), false only on contention timeout, and null on an unexpected
 * filesystem error. Callers may transiently refuse on false when protecting a hard cap,
 * but must degrade to allow on null like every other gate infrastructure failure. A lock
 * directory older than `staleMs` is presumed abandoned by a process that crashed
 * mid-critical-section and is cleared rather than waited out.
 */
function acquireLock(lockDir, { timeoutMs = 2000, retryMs = 25, staleMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      return true;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return null; // infrastructure failure, distinct from contention
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > staleMs) { fs.rmdirSync(lockDir); continue; }
      } catch {
        continue; // it vanished between the failed mkdir and this stat — just retry
      }
      if (Date.now() >= deadline) return false;
      sleepMs(Math.min(retryMs, deadline - Date.now()));
    }
  }
}

function releaseLock(lockDir) {
  try { fs.rmdirSync(lockDir); } catch {}
}

/** Synchronous sleep with no busy-wait CPU spin, via Atomics.wait on a throwaway buffer. */
function sleepMs(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* environment without SharedArrayBuffer: busy-wait fallback */ }
  }
}

/** Run `fn(locked)` holding the lock if acquired, always releasing it afterward. */
function withLock(lockDir, opts, fn) {
  const options = typeof opts === 'function' ? {} : (opts || {});
  const callback = typeof opts === 'function' ? opts : fn;
  const locked = acquireLock(lockDir, options);
  try {
    return callback(locked);
  } finally {
    if (locked) releaseLock(lockDir);
  }
}

module.exports = { acquireLock, releaseLock, withLock };
