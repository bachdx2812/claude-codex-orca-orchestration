'use strict';

const fs = require('fs');
const path = require('path');
const { acquireLock, releaseLock } = require('./file-lock.cjs');

const UNKNOWN_RETRY_MS = 15 * 60 * 1000;
const RESET_GRACE_MS = 90 * 1000;
const WORKER_RESUME_MESSAGE = 'Quota has reset. Continue the task from where you stopped; check git status/log (and HANDOVER.md if present) first; do not redo finished steps.';
const PANEL_RESUME_MESSAGE = 'Quota has reset - continue the orchestration from where you stopped (check worker-list, plans)';

function safePart(value) {
  return String(value || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
}

function jobFile(stateDir, session, handle) {
  return path.join(stateDir, `resume-${safePart(session)}-${safePart(handle)}.json`);
}

function readJob(file) {
  try {
    const job = JSON.parse(fs.readFileSync(file, 'utf8'));
    return job && typeof job === 'object' ? job : null;
  } catch { return null; }
}

function writeJob(file, job) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(job), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

function clearJob(stateDir, session, handle) {
  const file = jobFile(stateDir, session, handle);
  const lockDir = `${file}.lock`;
  const locked = acquireLock(lockDir, { timeoutMs: 12000, retryMs: 20, staleMs: 30000 });
  if (!locked) return false;
  try {
    try { fs.unlinkSync(file); return true; }
    catch (error) { return error && error.code === 'ENOENT'; }
  } finally {
    releaseLock(lockDir);
  }
}

/** Run a scheduler mutation only while it still owns this persisted park episode. */
function withOwnedJob(file, token, pid, callback) {
  const lockDir = `${file}.lock`;
  const locked = acquireLock(lockDir, { timeoutMs: 12000, retryMs: 20, staleMs: 30000 });
  if (!locked) return { owned: false, value: null };
  try {
    const current = readJob(file);
    if (!current || current.token !== token || current.status === 'resumed' ||
        current.status === 'cancelled' || (Number(current.pid) > 0 && Number(current.pid) !== Number(pid))) {
      return { owned: false, value: null };
    }
    return { owned: true, value: callback(current) };
  } finally {
    releaseLock(lockDir);
  }
}

function quotaResetAt(quota) {
  const seconds = quota && typeof quota.resetsAt === 'number' && Number.isFinite(quota.resetsAt)
    ? quota.resetsAt : 0;
  return seconds > 0 ? Math.round(seconds * 1000) : 0;
}

function durationMs(text) {
  const match = String(text).match(/\btry\s+again\s+in\s+((?:\d+\s*[dhms]\s*)+)/i);
  if (!match) return 0;
  let total = 0;
  for (const part of match[1].matchAll(/(\d+)\s*([dhms])/gi)) {
    total += Number(part[1]) * ({ d: 86400000, h: 3600000, m: 60000, s: 1000 })[part[2].toLowerCase()];
  }
  return total;
}

/** Parse Claude limit-screen reset hints in local time. */
function parseClaudeResetAt(text, now = Date.now()) {
  const relative = durationMs(text);
  if (relative) return now + relative;
  const match = String(text).match(/\bresets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) return 0;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3] && match[3].toLowerCase();
  if (meridiem) {
    hour %= 12;
    if (meridiem === 'pm') hour += 12;
  }
  if (hour > 23 || minute > 59) return 0;
  const reset = new Date(now);
  reset.setHours(hour, minute, 0, 0);
  if (reset.getTime() <= now) reset.setDate(reset.getDate() + 1);
  return reset.getTime();
}

function hasClaudeLimitMessage(text) {
  return String(text || '').split(/\r?\n/).some((raw) => {
    if (!/^\s*(?:■|⚠|✗|error:)/iu.test(raw)) return false;
    const line = raw.trim().replace(/^(?:[■⚠✗•·└>›\s]+|error:\s*)/iu, '');
    return /^(?:you(?:'|’)?ve\s+hit\s+your\s+(?:usage\s+)?limit|(?:claude\s+)?(?:usage\s+)?limit\s+reached|out\s+of\s+usage)\b/i.test(line) &&
      /(?:\bresets?\b|\btry\s+again\s+in\b)/i.test(line);
  });
}

function shouldPark({ limited, handoverTarget }) {
  return limited === true && !handoverTarget;
}

function availableHandoverTarget(target, panelAvailable) {
  return target === 'sonnet' && !panelAvailable ? null : target;
}

function nextAttemptAt(job, now = Date.now()) {
  if (job.resetAt > 0) return job.resetAt + RESET_GRACE_MS;
  if (typeof job.nextAttemptAt === 'number' && Number.isFinite(job.nextAttemptAt)) return job.nextAttemptAt;
  return (Number(job.parkedAt) || now) + UNKNOWN_RETRY_MS;
}

function localResetText(resetAt) {
  return resetAt > 0 ? new Date(resetAt).toLocaleString() : 'unknown (probe every 15m)';
}

function park({ stateDir, session, handle, identity, agent, resetAt = 0, panel = false,
  panelHandle = '', threshold = 100, authorizedHandles = new Set(), now = Date.now(),
  spawnScheduler, pidAlive = () => false }) {
  const authorized = panel ? handle && handle === panelHandle : authorizedHandles.has(handle);
  if (!authorized) return { event: null, scheduled: false, reason: 'foreign-terminal' };
  const file = jobFile(stateDir, session, handle);
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch {
    return { event: null, scheduled: false, reason: 'scheduler-state-unavailable', file };
  }
  const lockDir = `${file}.lock`;
  const locked = acquireLock(lockDir, { timeoutMs: 1000, retryMs: 20, staleMs: 30000 });
  if (!locked) return { event: null, scheduled: false, reason: 'scheduler-lock-unavailable', file };
  try {
    const existing = readJob(file);
    const resumedSameEpisode = existing?.status === 'resumed' && existing.agent === agent &&
      (Number(existing.resetAt) || 0) === (Number(resetAt) || 0);
    if (resumedSameEpisode) return { event: null, scheduled: false, file, job: existing };
    const sameEpisode = existing && existing.status !== 'resumed' && existing.agent === agent;
    const job = sameEpisode ? { ...existing } : {
      version: 1, session, handle, identity: identity || handle, agent,
      panel, panelHandle: panel ? panelHandle : '', status: 'parked', parkedAt: now,
      token: `${process.pid}-${now}-${Math.random().toString(36).slice(2)}`,
      pid: 0, threshold, resetAt: resetAt || 0,
      nextAttemptAt: resetAt > 0 ? resetAt + RESET_GRACE_MS : now + UNKNOWN_RETRY_MS,
    };
    job.threshold = threshold;
    if (resetAt > 0) {
      job.resetAt = resetAt;
      job.nextAttemptAt = resetAt + RESET_GRACE_MS;
    }
    writeJob(file, job);
    let scheduled = sameEpisode && Number(job.pid) > 0 && pidAlive(job.pid, file);
    if (!scheduled && typeof spawnScheduler === 'function') {
      const pid = Number(spawnScheduler(file)) || 0;
      if (pid > 0) {
        job.pid = pid;
        job.status = 'scheduled';
        writeJob(file, job);
        scheduled = true;
      }
    }
    return {
      event: sameEpisode ? null : `WORKER PARKED ${job.identity} (${agent} limit, resets ${localResetText(job.resetAt)}) - will auto-resume`,
      scheduled, file, job,
    };
  } finally {
    releaseLock(lockDir);
  }
}

function kimiNeedsNeverAsk(screen) {
  return /Select\s+permission\s+mode|Permission\s+mode\s*:\s*(?:Ask When Needed|Plan)/i.test(String(screen || '')) &&
    !/Permission\s+mode\s*:\s*Never Ask/i.test(String(screen || ''));
}

function kimiPermissionMoves(screen) {
  const options = String(screen || '').split(/\r?\n/)
    .map((line) => ({ selected: /[❯›>]/u.test(line), text: line.replace(/^[\s❯›>\d.)-]+/u, '').trim() }))
    .filter((line) => /^(?:Ask When Needed|Never Ask|Plan)$/i.test(line.text));
  const selected = options.findIndex((line) => line.selected);
  const target = options.findIndex((line) => /^Never Ask$/i.test(line.text));
  if (selected < 0 || target < 0) return null;
  return (target - selected + options.length) % options.length;
}

function turnStarted(after, before) {
  return String(after || '') !== String(before || '') &&
    /(?:Thinking(?:\.{3}|…)|Working\s*\(|Coder Agent Running|esc\s+to\s+interrupt|background\s+(?:terminal|task).*running)/i.test(String(after || ''));
}

function pollScreen(deps, handle, predicate, attempts = 5) {
  const wait = typeof deps.wait === 'function' ? deps.wait : (ms) => {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
  };
  let screen = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) wait(200);
    screen = typeof deps.readScreen === 'function' ? deps.readScreen(handle) : '';
    if (predicate(screen)) return screen;
  }
  return screen;
}

/** One hermetic scheduler attempt. Callers provide terminal/quota operations. */
function attemptResume(job, deps = {}) {
  const now = deps.now === undefined ? Date.now() : deps.now;
  if (!job || job.status === 'resumed') return { resumed: false, reason: 'settled' };
  const authorization = typeof deps.isAuthorized === 'function' ? deps.isAuthorized(job) : null;
  if (authorization === null || authorization === undefined) {
    return { resumed: false, reason: 'authorization-unknown' };
  }
  if (!authorization) {
    return { resumed: false, reason: 'foreign-terminal' };
  }
  if (now < nextAttemptAt(job, now)) return { resumed: false, reason: 'before-reset' };
  const quota = typeof deps.probeQuota === 'function' ? deps.probeQuota(job.agent) : null;
  if (job.agent !== 'claude' &&
      (!quota || quota.failed || quota.usedPercent >=
        (typeof job.threshold === 'number' && Number.isFinite(job.threshold) ? job.threshold : 100))) {
    const resetAt = quotaResetAt(quota);
    return { resumed: false, reason: 'quota-unavailable', resetAt };
  }
  let before = typeof deps.readScreen === 'function' ? deps.readScreen(job.handle) : '';
  if (job.agent === 'claude' && hasClaudeLimitMessage(before) && job.resetAt > 0 && now < job.resetAt + RESET_GRACE_MS) {
    return { resumed: false, reason: 'quota-unavailable', resetAt: 0 };
  }
  if (job.agent === 'kimi' && kimiNeedsNeverAsk(before) && typeof deps.send === 'function') {
    if (deps.send(job.handle, '/auto', true) === false) return { resumed: false, reason: 'permission-failed' };
    const menu = pollScreen(deps, job.handle, (screen) => kimiPermissionMoves(screen) !== null);
    const moves = kimiPermissionMoves(menu);
    if (moves === null) return { resumed: false, reason: 'permission-unverified' };
    if (deps.send(job.handle, '\u001b[B'.repeat(moves), true) === false) {
      return { resumed: false, reason: 'permission-failed' };
    }
    const mode = pollScreen(deps, job.handle,
      (screen) => /Permission\s+mode\s*:\s*Never Ask/i.test(screen));
    if (!/Permission\s+mode\s*:\s*Never Ask/i.test(mode)) {
      return { resumed: false, reason: 'permission-unverified' };
    }
    before = mode;
  }
  const message = job.panel ? PANEL_RESUME_MESSAGE : WORKER_RESUME_MESSAGE;
  const sent = typeof deps.send === 'function' && deps.send(job.handle, message, true) !== false;
  if (!sent) return { resumed: false, reason: 'send-failed' };
  const verified = typeof deps.verifyStarted === 'function'
    ? deps.verifyStarted(job.handle, before) : true;
  return verified ? { resumed: true, reason: 'started', message } : { resumed: false, reason: 'not-started' };
}

module.exports = {
  UNKNOWN_RETRY_MS, RESET_GRACE_MS, WORKER_RESUME_MESSAGE, PANEL_RESUME_MESSAGE,
  jobFile, readJob, writeJob, quotaResetAt, parseClaudeResetAt, hasClaudeLimitMessage,
  clearJob, withOwnedJob, shouldPark, availableHandoverTarget, nextAttemptAt, park,
  kimiNeedsNeverAsk, kimiPermissionMoves,
  turnStarted, attemptResume,
};
