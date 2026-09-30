'use strict';

const fs = require('fs');
const path = require('path');
const { acquireLock, releaseLock } = require('./file-lock.cjs');

const processCache = new Map();
const processFallbackCache = new Map();

function fileFor(stateDir, cacheFile) {
  return path.join(stateDir, cacheFile);
}

function validTimestamp(entry) {
  return entry && typeof entry.fetchedAt === 'number' && Number.isFinite(entry.fetchedAt);
}

function fresh(entry, cacheSeconds, now) {
  return validTimestamp(entry) && now >= entry.fetchedAt &&
    now - entry.fetchedAt < cacheSeconds * 1000;
}

function resultFor(entry, now, validate) {
  if (!validTimestamp(entry)) return null;
  const result = validate(entry, now);
  return result && typeof result === 'object' ? result : null;
}

function readEntry(file) {
  try { return { text: fs.readFileSync(file, 'utf8') }; } catch { return null; }
}

function parseEntry(read) {
  if (!read) return null;
  try { return { ...read, entry: JSON.parse(read.text) }; } catch { return null; }
}

function readFresh({ stateDir, cacheFile, cacheSeconds, now, validate }) {
  if (!stateDir) return null;
  const file = fileFor(stateDir, cacheFile);
  const memo = processCache.get(file);
  if (memo) {
    try {
      const stat = fs.statSync(file);
      if (stat.mtimeMs === memo.mtimeMs && stat.size === memo.size && stat.ino === memo.ino &&
          (cacheSeconds <= 0 || fresh(memo.entry, cacheSeconds, now))) {
        return resultFor(memo.entry, now, validate);
      }
    } catch {}
  }
  if (cacheSeconds <= 0) return null;
  const parsed = parseEntry(readEntry(file));
  if (!parsed || !fresh(parsed.entry, cacheSeconds, now)) return null;
  const result = resultFor(parsed.entry, now, validate);
  if (result) {
    try {
      const stat = fs.statSync(file);
      processCache.set(file, { entry: parsed.entry, mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino });
    } catch {}
  }
  return result;
}

function readStale({ stateDir, cacheFile, now, validate, memoize = false }) {
  const file = fileFor(stateDir, cacheFile);
  const parsed = parseEntry(readEntry(file));
  if (!parsed) return null;
  const result = resultFor(parsed.entry, now, validate);
  if (memoize && result) processFallbackCache.set(file, parsed);
  return result;
}

function readProcessFallback({ stateDir, cacheFile, now, validate }) {
  const file = fileFor(stateDir, cacheFile);
  const memo = processFallbackCache.get(file);
  if (!memo) return null;
  try {
    if (fs.readFileSync(file, 'utf8') !== memo.text) {
      processFallbackCache.delete(file);
      return null;
    }
    return resultFor(memo.entry, now, validate);
  } catch {
    processFallbackCache.delete(file);
    return null;
  }
}

function writeEntry(stateDir, cacheFile, value, now) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const file = fileFor(stateDir, cacheFile);
    const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const entry = value && typeof value === 'object'
      ? { ...value, fetchedAt: now }
      : { failed: true, fetchedAt: now };
    fs.writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });
    fs.renameSync(temp, file);
    const stat = fs.statSync(file);
    processCache.set(file, { entry, mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino });
    return entry;
  } catch {
    return null;
  }
}

/**
 * Shared synchronous live-probe cache with a 300ms single-flight lease.
 * Probe failures are cached; lease losers use fresh, then structurally-valid stale data.
 */
function cachedLiveProbe({
  stateDir, cacheFile, lockName, cacheSeconds, now = Date.now(), probe, validate,
  probeTimeoutMs = 5000,
}) {
  const args = { stateDir, cacheFile, cacheSeconds, now, validate };
  const cached = readFresh(args);
  if (cached) return cached;
  const fallback = readProcessFallback(args);
  if (fallback) return fallback;

  try { fs.mkdirSync(stateDir, { recursive: true }); } catch {}
  const lockDir = path.join(stateDir, lockName);
  const lock = acquireLock(lockDir, { timeoutMs: 300, retryMs: 25, staleMs: probeTimeoutMs + 1000 });
  if (lock === false) {
    const laterNow = Math.max(now, Date.now());
    const afterWait = readFresh({ ...args, now: laterNow });
    if (afterWait) return afterWait;
    return readStale({ ...args, memoize: true });
  }
  try {
    const afterAcquire = readFresh({ ...args, now: Math.max(now, Date.now()) });
    if (afterAcquire) return afterAcquire;
    let value = null;
    try { value = probe(); } catch {}
    const entry = writeEntry(stateDir, cacheFile, value, now) ||
      (value && typeof value === 'object' ? { ...value, fetchedAt: now } : { failed: true, fetchedAt: now });
    return resultFor(entry, now, validate);
  } finally {
    if (lock) releaseLock(lockDir);
  }
}

module.exports = { cachedLiveProbe, readFresh, readStale, writeEntry };
