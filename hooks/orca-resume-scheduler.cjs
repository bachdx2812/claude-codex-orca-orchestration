#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const RESUME = require('./lib/quota-reset-resume.cjs');
const QUOTA = require('./lib/exec-route-by-quota.cjs');
const { stateDir } = require('./lib/config.cjs');
const { fetchWorkerListPages } = require('./lib/orca-worker-list-pages.cjs');

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

function authorizedWorkerHandles(workers, panelHandle = process.env.ORCA_TERMINAL_HANDLE || '') {
  const done = new Set(['succeeded', 'failed', 'stopped', 'cancelled', 'completed']);
  return new Set((workers || []).filter((worker) => worker &&
    worker.workerState !== 'unsupervised' && !done.has(worker.workerState) &&
    !done.has(worker.dispatchStatus) &&
    worker.terminalState !== 'released' && worker.agentTerminalHandle !== panelHandle)
    .map((worker) => worker.agentTerminalHandle).filter(Boolean));
}

/**
 * Pages past Orca's 100-row-per-call limit via the shared `orca-worker-list-pages.cjs`
 * helper. Preserves the pre-paging contract: null on no reply/`ok: false` on any page,
 * otherwise every row across every page (a page with no usable rows array still counts as
 * zero rows for that page, not a failure — same leniency the single-call version had).
 */
function workerHandles() {
  let failed = false;
  const paged = fetchWorkerListPages((args) => {
    const reply = orca(args);
    if (!reply || reply.ok === false) {
      failed = true;
      return null;
    }
    return reply;
  }, {
    baseArgs: ['orchestration', 'worker-list', '--json'],
    getRows: (reply) => {
      const result = reply.result || reply;
      const list = Array.isArray(result) ? result : result?.workers;
      return Array.isArray(list) ? list : [];
    },
  });
  if (failed) return null;
  return authorizedWorkerHandles(paged.rows);
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
  let screen = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    screen = terminalScreen(handle);
    if (RESUME.hasKimiIdleSessionMenu(screen)) return { started: false, screen };
    if (RESUME.turnStarted(screen, before)) return { started: true, screen };
  }
  return { started: false, screen };
}

function schedule(file, expectedToken = '') {
  const initial = RESUME.readJob(file);
  if (!initial || RESUME.isSettledJob(initial)) return;
  const token = expectedToken || initial.token;
  if (!token) return;
  const claimed = RESUME.withOwnedJob(file, token, process.pid, (job) => {
    if (RESUME.recoverDeliveredJob(job, Date.now())) {
      RESUME.writeJob(file, job);
      return { settled: true };
    }
    job.pid = process.pid;
    job.status = 'scheduled';
    RESUME.writeJob(file, job);
    return { settled: false, job: { ...job } };
  });
  if (!claimed.owned || claimed.value.settled) return;
  const job = claimed.value.job;
  const delay = Math.max(0, Math.min(0x7fffffff, RESUME.nextAttemptAt(job) - Date.now()));
  setTimeout(() => {
    let current = RESUME.readJob(file);
    if (!current || current.token !== token || Number(current.pid) !== process.pid ||
        RESUME.isSettledJob(current)) return;
    const begun = RESUME.withOwnedJob(file, token, process.pid, (owned) => {
      const attempt = RESUME.beginAttempt(owned, Date.now());
      owned.attempts = attempt.attempts;
      owned.firstAttemptAt = attempt.firstAttemptAt;
      if (attempt.expired) {
        owned.status = 'expired';
        owned.expiredAt = Date.now();
        owned.pid = 0;
      }
      RESUME.writeJob(file, owned);
      return { expired: attempt.expired, job: { ...owned } };
    });
    if (!begun.owned || begun.value.expired) return;
    current = begun.value.job;
    let lostOwnership = false;
    const guardedSend = (handle, text, enter) => {
      const result = RESUME.withOwnedJob(file, token, process.pid, (owned) => {
        const alreadyAttempted = Boolean(owned.inFlightSendAt);
        RESUME.recordDelivery(owned, text, Date.now());
        if (!RESUME.writeJob(file, owned)) return false;
        const delivered = send(handle, text, enter);
        if (!delivered && !alreadyAttempted) {
          delete owned.inFlightSendAt;
          delete owned.lastAttemptedText;
          RESUME.writeJob(file, owned);
        }
        return delivered;
      });
      if (!result.owned) lostOwnership = true;
      return result.owned && result.value;
    };
    const result = RESUME.attemptResume(current, {
      now: Date.now(), isAuthorized, probeQuota, readScreen: terminalScreen,
      send: guardedSend, verifyStarted,
    });
    if (lostOwnership) return;
    const updated = RESUME.withOwnedJob(file, token, process.pid, (owned) => {
      const applied = RESUME.applyAttemptResult(owned, result, Date.now());
      RESUME.writeJob(file, owned);
      return applied.retry;
    });
    if (updated.owned && updated.value) schedule(file, token);
  }, delay);
}

function main() {
  const file = arg('job');
  if (!file || !path.isAbsolute(file)) process.exit(2);
  schedule(file);
}

if (require.main === module) main();

module.exports = {
  terminalScreen, authorizedWorkerHandles, workerHandles, isAuthorized,
  probeQuota, send, verifyStarted, schedule,
};
