'use strict';

const fs = require('fs');
const path = require('path');
const { acquireLock, releaseLock } = require('./file-lock.cjs');

const UNKNOWN_RETRY_MS = 15 * 60 * 1000;
const RESET_GRACE_MS = 90 * 1000;
const MAX_LIFETIME_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 8 * 24 * 4;
const SETTLED_RETENTION_MS = 24 * 60 * 60 * 1000;
const PENDING_STATUSES = new Set(['parked', 'scheduled']);
const SETTLED_STATUSES = new Set(['resumed', 'resumed-unverified', 'cancelled', 'expired']);
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

function isPendingJob(job) {
  return !!job && PENDING_STATUSES.has(job.status);
}

function isSettledJob(job) {
  return !!job && SETTLED_STATUSES.has(job.status);
}

function removeJobIf(file, predicate) {
  const lockDir = `${file}.lock`;
  const locked = acquireLock(lockDir, { timeoutMs: 12000, retryMs: 20, staleMs: 30000 });
  if (!locked) return false;
  try {
    const job = readJob(file);
    if (!predicate(job)) return false;
    try { fs.unlinkSync(file); return true; } catch { return false; }
  } finally {
    releaseLock(lockDir);
  }
}

function clearSettledJob(stateDir, session, handle) {
  const file = jobFile(stateDir, session, handle);
  // Reportable outcomes must survive until resumeJobEvents marks them and the
  // one-day sweeper removes them. Recovery may immediately clear only quiet outcomes.
  return removeJobIf(file, (job) => job?.status === 'resumed' || job?.status === 'cancelled');
}

/** Run a scheduler mutation only while it still owns this persisted park episode. */
function withOwnedJob(file, token, pid, callback) {
  const lockDir = `${file}.lock`;
  const locked = acquireLock(lockDir, { timeoutMs: 12000, retryMs: 20, staleMs: 30000 });
  if (!locked) return { owned: false, value: null };
  try {
    const current = readJob(file);
    if (!current || current.token !== token || isSettledJob(current) ||
        (Number(current.pid) > 0 && Number(current.pid) !== Number(pid))) {
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

function timeZoneFromText(text) {
  const match = String(text).match(/\(([A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)?)\)/);
  if (!match) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: match[1] }).format(0);
    return match[1];
  } catch { return ''; }
}

function zonedDateParts(epoch, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(epoch));
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
}

function zonedEpoch(year, month, day, hour, minute, timeZone) {
  const target = Date.UTC(year, month, day, hour, minute, 0, 0);
  let epoch = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const shown = zonedDateParts(epoch, timeZone);
    const rendered = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
    epoch += target - rendered;
  }
  return epoch;
}

function clockParts(match, hourIndex, minuteIndex, meridiemIndex) {
  let hour = Number(match[hourIndex]);
  const minute = Number(match[minuteIndex] || 0);
  const meridiem = match[meridiemIndex] && match[meridiemIndex].toLowerCase();
  if (meridiem) {
    hour %= 12;
    if (meridiem === 'pm') hour += 12;
  }
  return hour > 23 || minute > 59 ? null : { hour, minute };
}

/** Parse Claude limit-screen reset hints, honoring an explicit IANA timezone suffix. */
function parseClaudeResetAt(text, now = Date.now()) {
  const relative = durationMs(text);
  if (relative) return now + relative;
  const value = String(text);
  const timeZone = timeZoneFromText(value);
  const monthNames = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|' +
    'Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
  const dated = value.match(new RegExp(`\\bresets?(?:\\s+at)?\\s+(${monthNames})\\s+(\\d{1,2}),?\\s+` +
    '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?\\b', 'i'));
  if (dated) {
    const month = new Date(`${dated[1]} 1, 2000`).getMonth();
    const day = Number(dated[2]);
    const clock = clockParts(dated, 3, 4, 5);
    if (!clock || day < 1 || day > 31) return 0;
    const currentYear = timeZone ? zonedDateParts(now, timeZone).year : new Date(now).getFullYear();
    const make = (year) => timeZone
      ? zonedEpoch(year, month, day, clock.hour, clock.minute, timeZone)
      : new Date(year, month, day, clock.hour, clock.minute, 0, 0).getTime();
    let reset = make(currentYear);
    if (reset <= now) reset = make(currentYear + 1);
    return reset;
  }
  const match = value.match(/\bresets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) return 0;
  const clock = clockParts(match, 1, 2, 3);
  if (!clock) return 0;
  if (timeZone) {
    const current = zonedDateParts(now, timeZone);
    let reset = zonedEpoch(current.year, current.month - 1, current.day,
      clock.hour, clock.minute, timeZone);
    if (reset <= now) reset = zonedEpoch(current.year, current.month - 1, current.day + 1,
      clock.hour, clock.minute, timeZone);
    return reset;
  }
  const reset = new Date(now);
  reset.setHours(clock.hour, clock.minute, 0, 0);
  if (reset.getTime() <= now) reset.setDate(reset.getDate() + 1);
  return reset.getTime();
}

function isClaudeLimitLine(raw) {
  if (!/^\s*(?:■|⚠|✗|error:)/iu.test(raw)) return false;
  const line = raw.trim().replace(/^(?:[■⚠✗•·└>›\s]+|error:\s*)/iu, '');
  return /^(?:you(?:'|’)?ve\s+hit\s+your\s+(?:usage\s+)?limit|(?:claude\s+)?(?:usage\s+)?limit\s+reached|out\s+of\s+usage)\b/i.test(line) &&
    /(?:\bresets?\b|\btry\s+again\s+in\b)/i.test(line);
}

function claudeLimitInfo(text, now = Date.now(), recentLines = 12) {
  const lines = String(text || '').split(/\r?\n/).slice(-recentLines);
  let limitIndex = -1;
  let occurrences = 0;
  for (let index = 0; index < lines.length; index++) {
    if (isClaudeLimitLine(lines[index])) {
      limitIndex = index;
      occurrences += 1;
    }
  }
  if (limitIndex < 0) return { limited: false, resetAt: 0, line: '', occurrences: 0 };
  const newerActivity = lines.slice(limitIndex + 1).some((line) =>
    /(?:Thinking(?:\.{3}|…)|Working\s*\(|Coder Agent Running|esc\s+to\s+interrupt|background\s+(?:terminal|task).*running)/i.test(line) ||
    /^\s*(?:❯|›|>)\s+\S/u.test(line));
  if (newerActivity) return { limited: false, resetAt: 0, line: lines[limitIndex], occurrences };
  return {
    limited: true, resetAt: parseClaudeResetAt(lines[limitIndex], now),
    line: lines[limitIndex], occurrences,
  };
}

function hasClaudeLimitMessage(text) {
  return claudeLimitInfo(text).limited;
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

function beginAttempt(job, now = Date.now()) {
  const firstAttemptAt = Number(job?.firstAttemptAt) || now;
  const attempts = Number(job?.attempts) || 0;
  if (now - firstAttemptAt >= MAX_LIFETIME_MS || attempts >= MAX_ATTEMPTS) {
    return { expired: true, attempts, firstAttemptAt };
  }
  return { expired: false, attempts: attempts + 1, firstAttemptAt };
}

function recordDelivery(job, text, now = Date.now()) {
  job.inFlightSendAt = Number(job.inFlightSendAt) || now;
  job.lastAttemptedText = String(text || '');
  return job;
}

function recoverDeliveredJob(job, now = Date.now()) {
  if (!isPendingJob(job) || !Number(job.inFlightSendAt)) return false;
  job.status = 'resumed-unverified';
  job.unverifiedAt = now;
  job.pid = 0;
  return true;
}

function applyAttemptResult(job, result, now = Date.now()) {
  let retry = false;
  if (result.resumed) {
    job.status = 'resumed';
    job.resumedAt = now;
    job.pid = 0;
  } else if (result.reason === 'foreign-terminal') {
    job.status = 'cancelled';
    job.cancelledAt = now;
    job.pid = 0;
  } else if (result.reason === 'resumed-unverified' || (result.delivered && !result.reparked)) {
    job.status = 'resumed-unverified';
    job.unverifiedAt = now;
    job.pid = 0;
  } else if (result.reason === 'before-reset') {
    retry = true;
  } else {
    job.resetAt = result.resetAt > now ? result.resetAt : 0;
    if (result.limitLine) job.limitLine = result.limitLine;
    if (result.reparked) {
      delete job.inFlightSendAt;
      delete job.lastAttemptedText;
    }
    job.nextAttemptAt = job.resetAt > 0 ? job.resetAt + RESET_GRACE_MS : now + UNKNOWN_RETRY_MS;
    retry = true;
  }
  return { job, retry };
}

function localResetText(resetAt) {
  return resetAt > 0 ? new Date(resetAt).toLocaleString() : 'unknown (probe every 15m)';
}

function park({ stateDir, session, handle, identity, agent, resetAt = 0, limitLine = '', panel = false,
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
    if (isSettledJob(existing) && existing.agent === agent && existing.status !== 'resumed') {
      return { event: null, scheduled: false, file, job: existing };
    }
    const sameEpisode = isPendingJob(existing) && existing.agent === agent;
    const job = sameEpisode ? { ...existing } : {
      version: 1, session, handle, identity: identity || handle, agent,
      panel, panelHandle: panel ? panelHandle : '', status: 'parked', parkedAt: now,
      token: `${process.pid}-${now}-${Math.random().toString(36).slice(2)}`,
      pid: 0, threshold, resetAt: resetAt || 0,
      attempts: 0, firstAttemptAt: 0,
      limitLine,
      nextAttemptAt: resetAt > 0 ? resetAt + RESET_GRACE_MS : now + UNKNOWN_RETRY_MS,
    };
    job.threshold = threshold;
    const sameLimitLine = sameEpisode && Boolean(job.limitLine) && job.limitLine === limitLine;
    if (limitLine && !sameLimitLine) job.limitLine = limitLine;
    if (resetAt > 0 && !sameLimitLine) {
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
  if (!job || isSettledJob(job)) return { resumed: false, reason: 'settled' };
  let delivered = false;
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
  let beforeLimit = { limited: false, resetAt: 0, line: '', occurrences: 0 };
  if (job.agent === 'claude') {
    beforeLimit = claudeLimitInfo(before, now);
    const samePersistedLimit = Boolean(job.limitLine) && job.limitLine === beforeLimit.line;
    const expectedReset = samePersistedLimit && Number(job.resetAt) > 0
      ? Number(job.resetAt) : beforeLimit.resetAt;
    if (beforeLimit.limited && (!expectedReset || now < expectedReset + RESET_GRACE_MS)) {
      return { resumed: false, reason: 'quota-unavailable', resetAt: expectedReset,
        limitLine: beforeLimit.line };
    }
  }
  if (job.agent === 'kimi' && kimiNeedsNeverAsk(before) && typeof deps.send === 'function') {
    if (deps.send(job.handle, '/auto', true) === false) return { resumed: false, reason: 'permission-failed' };
    delivered = true;
    const menu = pollScreen(deps, job.handle, (screen) => kimiPermissionMoves(screen) !== null);
    const moves = kimiPermissionMoves(menu);
    if (moves === null) return { resumed: false, reason: 'permission-unverified', delivered };
    if (deps.send(job.handle, '\u001b[B'.repeat(moves), true) === false) {
      return { resumed: false, reason: 'permission-failed', delivered };
    }
    delivered = true;
    const mode = pollScreen(deps, job.handle,
      (screen) => /Permission\s+mode\s*:\s*Never Ask/i.test(screen));
    if (!/Permission\s+mode\s*:\s*Never Ask/i.test(mode)) {
      return { resumed: false, reason: 'permission-unverified', delivered };
    }
    before = mode;
  }
  const message = job.panel ? PANEL_RESUME_MESSAGE : WORKER_RESUME_MESSAGE;
  const sent = typeof deps.send === 'function' && deps.send(job.handle, message, true) !== false;
  if (!sent) return { resumed: false, reason: 'send-failed', delivered };
  delivered = true;
  const verification = typeof deps.verifyStarted === 'function'
    ? deps.verifyStarted(job.handle, before) : true;
  const verified = typeof verification === 'object' ? verification.started : verification;
  if (verified) return { resumed: true, reason: 'started', message, delivered };
  const after = typeof verification === 'object' && typeof verification.screen === 'string'
    ? verification.screen
    : (typeof deps.readScreen === 'function' ? deps.readScreen(job.handle) : '');
  const limit = job.agent === 'claude' ? claudeLimitInfo(after, now)
    : { limited: false, occurrences: 0 };
  const newLimitResponse = limit.limited &&
    (!beforeLimit.limited || limit.line !== beforeLimit.line ||
      limit.occurrences > beforeLimit.occurrences);
  if (newLimitResponse) {
    return { resumed: false, reason: 'quota-unavailable', resetAt: limit.resetAt,
      limitLine: limit.line, delivered, reparked: true };
  }
  return { resumed: false, reason: 'resumed-unverified', message, delivered };
}

function resumeJobEvents(stateDir, session, now = Date.now(), pidAlive = () => false) {
  const prefix = `resume-${safePart(session)}-`;
  let names = [];
  try { names = fs.readdirSync(stateDir).filter((name) => name.startsWith(prefix) && name.endsWith('.json')); }
  catch { return []; }
  const events = [];
  for (const name of names) {
    const file = path.join(stateDir, name);
    const lockDir = `${file}.lock`;
    const locked = acquireLock(lockDir, { timeoutMs: 1000, retryMs: 20, staleMs: 30000 });
    if (!locked) continue;
    try {
      const job = readJob(file);
      if (isPendingJob(job) && Number(job.inFlightSendAt) && !pidAlive(job.pid, file)) {
        recoverDeliveredJob(job, now);
        writeJob(file, job);
      }
      if (!job || job.reportedAt || !['resumed-unverified', 'expired'].includes(job.status)) continue;
      if (job.status === 'resumed-unverified') {
        events.push(`WORKER RESUME UNVERIFIED ${job.identity || job.handle} (${job.agent}) - ` +
          'resume input may have been delivered but no new turn was confirmed; inspect the terminal; do not retype');
      } else {
        events.push(`WORKER AUTO-RESUME EXPIRED ${job.identity || job.handle} (${job.agent}) - ` +
          'the bounded resume window ended; inspect the terminal and decide manually');
      }
      job.reportedAt = now;
      writeJob(file, job);
    } finally {
      releaseLock(lockDir);
    }
  }
  return events;
}

function sweepJobs(stateDir, session, now = Date.now()) {
  const prefix = `resume-${safePart(session)}-`;
  let names = [];
  try { names = fs.readdirSync(stateDir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(stateDir, name);
    if (name.endsWith('.json')) {
      if (removeJobIf(full, (job) => {
        const settledAt = Number(job?.reportedAt || job?.resumedAt || job?.cancelledAt || job?.expiredAt) || 0;
        return isSettledJob(job) && settledAt > 0 && now - settledAt >= SETTLED_RETENTION_MS;
      })) removed += 1;
    } else if (name.endsWith('.json.lock')) {
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs >= SETTLED_RETENTION_MS) fs.rmdirSync(full);
      } catch {}
    }
  }
  return removed;
}

function clearMissingPendingJobs(stateDir, session, activeHandles) {
  const prefix = `resume-${safePart(session)}-`;
  let names = [];
  try { names = fs.readdirSync(stateDir).filter((name) => name.startsWith(prefix) && name.endsWith('.json')); }
  catch { return 0; }
  let cleared = 0;
  for (const name of names) {
    const job = readJob(path.join(stateDir, name));
    if (isPendingJob(job) && !activeHandles.has(job.handle) && clearJob(stateDir, session, job.handle)) cleared += 1;
  }
  return cleared;
}

module.exports = {
  UNKNOWN_RETRY_MS, RESET_GRACE_MS, MAX_LIFETIME_MS, MAX_ATTEMPTS, SETTLED_RETENTION_MS,
  WORKER_RESUME_MESSAGE, PANEL_RESUME_MESSAGE,
  jobFile, readJob, writeJob, quotaResetAt, parseClaudeResetAt, claudeLimitInfo, hasClaudeLimitMessage,
  clearJob, clearSettledJob, withOwnedJob, isPendingJob, isSettledJob,
  shouldPark, availableHandoverTarget, nextAttemptAt, beginAttempt,
  recordDelivery, recoverDeliveredJob, applyAttemptResult, park,
  kimiNeedsNeverAsk, kimiPermissionMoves,
  turnStarted, attemptResume, resumeJobEvents, sweepJobs, clearMissingPendingJobs,
};
