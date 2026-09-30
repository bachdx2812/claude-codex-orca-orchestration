#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const RESUME = require('./lib/quota-reset-resume.cjs');
const QUOTA = require('./lib/exec-route-by-quota.cjs');
const { stateDir } = require('./lib/config.cjs');

const ORCA_BIN = process.env.ORCA_BIN || 'orca';
const DIR = stateDir();

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function orca(args, timeout = 10000) {
  try {
    const value = execFileSync(ORCA_BIN, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(value);
  } catch { return null; }
}

function terminalScreen(handle) {
  const reply = orca(['terminal', 'read', '--terminal', handle, '--screen', '--json']);
  const terminal = reply?.result?.terminal || reply?.result || reply;
  return Array.isArray(terminal?.tail) ? terminal.tail.join('\n')
    : typeof terminal?.tail === 'string' ? terminal.tail : '';
}

function workerHandles() {
  const reply = orca(['orchestration', 'worker-list', '--json']);
  if (!reply || reply.ok === false) return null;
  const result = reply?.result || reply;
  const workers = Array.isArray(result) ? result : result?.workers;
  return new Set((workers || []).map((worker) => worker?.agentTerminalHandle).filter(Boolean));
}

function isAuthorized(job) {
  if (job.panel) {
    return Boolean(job.handle && job.handle === job.panelHandle &&
      job.panelHandle === process.env.ORCA_TERMINAL_HANDLE);
  }
  const handles = workerHandles();
  return handles ? handles.has(job.handle) : null;
}

function probeQuota(agent) {
  if (agent === 'codex') return QUOTA.codexQuota(Date.now(), { stateDir: DIR, cacheSeconds: 0 });
  if (agent === 'kimi') return QUOTA.kimiQuota(Date.now(), {
    stateDir: DIR, cacheSeconds: 0, env: process.env,
  });
  return { usedPercent: 0, resetsAt: 0 };
}

function send(handle, text, enter) {
  const args = ['terminal', 'send', '--terminal', handle, '--text', text];
  if (enter) args.push('--enter');
  args.push('--json');
  const reply = orca(args);
  return !!reply && reply.ok !== false;
}

function verifyStarted(handle, before) {
  // Give the TUI a short opportunity to repaint, then require visible change. This child
  // process is dedicated to one resume and does not own heartbeat liveness.
  for (let attempt = 0; attempt < 5; attempt++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    if (RESUME.turnStarted(terminalScreen(handle), before)) return true;
  }
  return false;
}

function schedule(file, expectedToken = '') {
  const initial = RESUME.readJob(file);
  if (!initial || initial.status === 'resumed' || initial.status === 'cancelled') return;
  const token = expectedToken || initial.token;
  if (!token) return;
  const claimed = RESUME.withOwnedJob(file, token, process.pid, (job) => {
    job.pid = process.pid;
    job.status = 'scheduled';
    RESUME.writeJob(file, job);
    return { ...job };
  });
  if (!claimed.owned) return;
  const job = claimed.value;
  const delay = Math.max(0, Math.min(0x7fffffff, RESUME.nextAttemptAt(job) - Date.now()));
  setTimeout(() => {
    const current = RESUME.readJob(file);
    if (!current || current.token !== token || Number(current.pid) !== process.pid ||
        current.status === 'resumed' || current.status === 'cancelled') return;
    let lostOwnership = false;
    const guardedSend = (handle, text, enter) => {
      const result = RESUME.withOwnedJob(file, token, process.pid,
        () => send(handle, text, enter));
      if (!result.owned) lostOwnership = true;
      return result.owned && result.value;
    };
    const result = RESUME.attemptResume(current, {
      now: Date.now(), isAuthorized, probeQuota, readScreen: terminalScreen,
      send: guardedSend, verifyStarted,
    });
    if (lostOwnership) return;
    let retry = false;
    const updated = RESUME.withOwnedJob(file, token, process.pid, (owned) => {
      if (result.resumed) {
        owned.status = 'resumed';
        owned.resumedAt = Date.now();
        owned.pid = 0;
      } else if (result.reason === 'foreign-terminal') {
        owned.status = 'cancelled';
        owned.pid = 0;
      } else if (result.reason === 'before-reset') {
        retry = true;
      } else {
        owned.resetAt = result.resetAt > Date.now() ? result.resetAt : 0;
        owned.nextAttemptAt = owned.resetAt > 0
          ? owned.resetAt + RESUME.RESET_GRACE_MS
          : Date.now() + RESUME.UNKNOWN_RETRY_MS;
        retry = true;
      }
      RESUME.writeJob(file, owned);
    });
    if (updated.owned && retry) schedule(file, token);
  }, delay);
}

function main() {
  const file = arg('job');
  if (!file || !path.isAbsolute(file)) process.exit(2);
  schedule(file);
}

if (require.main === module) main();

module.exports = { terminalScreen, workerHandles, isAuthorized, probeQuota, send, verifyStarted, schedule };
