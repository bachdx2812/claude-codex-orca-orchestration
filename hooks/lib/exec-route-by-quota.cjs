/**
 * exec-route-by-quota.cjs — decides who writes code: Codex (in an Orca worker) or the
 * configured in-session code model, by which provider has more quota left.
 *
 * Codex is the default coder; the in-session code model takes over once Codex has used
 * `handoffUsed(cfg)` percent or more of its tightest rate-limit window (default 40).
 *
 * Sources (all local, no model call):
 *   - Claude: OPTIONAL. Read only if a usage-limits cache file exists and parses — either
 *     `CK_USAGE_CACHE_PATH`, or `${os.tmpdir()}/ck-usage-limits-cache.json`. This is a
 *     ClaudeKit-specific convention, not a Claude Code one, so its absence is normal and
 *     Claude quota is reported as "unknown", never an error. It is informational only —
 *     routing depends solely on Codex quota, never on Claude's.
 *   - Codex: a short-lived state-dir cache, then a live `codex app-server` JSON-RPC
 *     account/rateLimits/read, then the newest session-log `rate_limits` event.
 * Remaining = 100 - the tightest window. A window whose reset time has passed counts as
 * 0% used. Unknown Codex quota still keeps Codex as the preferred route.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { acquireLock, releaseLock } = require('./file-lock.cjs');

// Claude's cache is refreshed by an external hook; older than this it no longer reflects
// this machine.
const CLAUDE_STALE_MS = 6 * 60 * 60 * 1000;
const CODEX_SESSION_STALE_MS = 6 * 60 * 60 * 1000;
// Session files probed, newest first, for one carrying a rate_limits event.
const MAX_CODEX_FILES = 10;
// Only the tail of a session file is read; rate_limits events repeat throughout.
const TAIL_BYTES = 256 * 1024;
const LIVE_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_SECONDS = 60;
const LIVE_CACHE_FILE = 'codex-quota-live.json';
const LIVE_PROBE_LOCK = '.codex-quota-probe.lock';
const LIVE_PROBE = path.join(__dirname, 'codex-quota-probe.cjs');
const processCache = new Map();

function codexSessionsDir() {
  // CODEX_SESSIONS_DIR lets tests point at a fixture instead of live data.
  if (process.env.CODEX_SESSIONS_DIR) return process.env.CODEX_SESSIONS_DIR;
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}

/** The optional Claude usage cache path, or null when none is configured. */
function claudeUsageCachePath() {
  if (process.env.CK_USAGE_CACHE_PATH) return process.env.CK_USAGE_CACHE_PATH;
  const fallback = path.join(os.tmpdir(), 'ck-usage-limits-cache.json');
  return fs.existsSync(fallback) ? fallback : null;
}

/**
 * Percent used by one window, 0 once its reset time has passed.
 *
 * `allowFraction` applies the Claude usage cache's own convention that a value in (0,1)
 * is a fraction rather than an already-a-percentage number - a convention that belongs
 * to that cache's format alone. Codex's `used_percent` is never a fraction by contract
 * (it is always 0-100), so applying the same heuristic there would silently 100x a
 * genuine low-single-digits reading (e.g. 0.5% actually used) into "50% used".
 */
function windowUsed(pct, resetsAtMs, now, allowFraction) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  if (resetsAtMs && resetsAtMs < now) return 0;
  return allowFraction && pct > 0 && pct < 1 ? pct * 100 : pct;
}

/** Percent of Claude quota left, or null when no cache is present/parseable/stale. */
function readClaudeQuota(now = Date.now()) {
  const file = claudeUsageCachePath();
  if (!file) return null;
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!cache || cache.status !== 'available' || !cache.data) return null;
    if (now - Number(cache.timestamp || 0) > CLAUDE_STALE_MS) return null;
    const d = cache.data;
    const used = [d.five_hour, d.seven_day, d.seven_day_sonnet]
      .filter(Boolean)
      .map((w) => windowUsed(w.utilization, w.resets_at ? Date.parse(w.resets_at) : 0, now, true))
      .filter((v) => v !== null);
    if (!used.length) return null;
    return {
      remaining: Math.max(0, 100 - Math.max(...used)),
      ageMs: Math.max(0, now - Number(cache.timestamp || 0)),
    };
  } catch {
    return null;
  }
}

/** Percent of Claude quota left, or null when no cache is present/parseable/stale. */
function claudeRemaining(now = Date.now()) {
  const quota = readClaudeQuota(now);
  return quota ? quota.remaining : null;
}

/** Entry names of dir sorted descending (YYYY/MM/DD and rollout-<ts> names sort by time). */
function listDesc(dir) {
  try { return fs.readdirSync(dir).sort().reverse(); } catch { return []; }
}

/**
 * Up to `limit` newest *.jsonl session files. Walks only the newest year/month/day
 * folders instead of the whole (multi-GB) tree.
 */
function newestSessionFiles(root, limit = MAX_CODEX_FILES) {
  const out = [];
  for (const y of listDesc(root)) {
    for (const m of listDesc(path.join(root, y))) {
      for (const d of listDesc(path.join(root, y, m))) {
        const dayDir = path.join(root, y, m, d);
        const files = listDesc(dayDir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => {
            const p = path.join(dayDir, f);
            try { return { file: p, mtime: fs.statSync(p).mtimeMs }; } catch { return null; }
          })
          .filter(Boolean)
          .sort((a, b) => b.mtime - a.mtime);
        for (const f of files) {
          out.push(f.file);
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

/** The last rate_limits object and its event timestamp in a session file's tail, or null. */
function lastRateLimits(file) {
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split('\n').filter((l) => l.includes('"rate_limits"'));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]);
        const rl = event.payload.rate_limits;
        if (rl && (rl.primary || rl.secondary)) {
          const observedAt = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
          return { rateLimits: rl, observedAt: Number.isFinite(observedAt) ? observedAt : null };
        }
      } catch {}
    }
  } catch {}
  return null;
}

/** Percent of Codex quota left, or null when no session carries a rate_limits event. */
function readSessionQuota(now = Date.now()) {
  try {
    for (const file of newestSessionFiles(codexSessionsDir())) {
      const event = lastRateLimits(file);
      if (!event) continue; // e.g. a session that has not finished its first turn yet
      let observedAt = event.observedAt;
      if (!Number.isFinite(observedAt)) {
        try { observedAt = fs.statSync(file).mtimeMs; } catch { observedAt = now; }
      }
      if (now - observedAt > CODEX_SESSION_STALE_MS) continue;
      const rl = event.rateLimits;
      const used = [rl.primary, rl.secondary]
        .filter(Boolean)
        .map((w) => windowUsed(w.used_percent, w.resets_at ? w.resets_at * 1000 : 0, now, false))
        .filter((v) => v !== null);
      if (used.length) {
        return {
          usedPercent: Math.max(...used),
          resetsAt: 0,
          fetchedAt: observedAt,
          source: 'session log',
          ageMs: Math.max(0, now - observedAt),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Percent of Codex quota left from the legacy session-log source, or null. */
function codexRemaining(now = Date.now()) {
  const quota = readSessionQuota(now);
  return quota ? Math.max(0, 100 - quota.usedPercent) : null;
}

function effectiveUsedPercent(window, now) {
  if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) ||
      window.usedPercent < 0 || window.usedPercent > 100) return null;
  const resetsAt = typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) ? window.resetsAt : 0;
  return { usedPercent: resetsAt && resetsAt * 1000 <= now ? 0 : window.usedPercent, resetsAt };
}

/** Convert a live app-server result to the tightest usable window. */
function parseLiveQuota(result, now = Date.now()) {
  const limits = result && result.rateLimits;
  const limitReached = !!(result && result.rateLimitReachedType) ||
    !!(limits && limits.rateLimitReachedType) ||
    !!(result && result.ordinaryUsageAllowed === false) ||
    !!(limits && limits.ordinaryUsageAllowed === false);
  if (limitReached) return { usedPercent: 100, resetsAt: 0, limitReached: true };
  if (!limits || typeof limits !== 'object') return null;
  const windows = [limits.primary, limits.secondary]
    .map((window) => effectiveUsedPercent(window, now))
    .filter(Boolean);
  if (!windows.length) return null;
  return windows.reduce((tightest, window) => (
    window.usedPercent > tightest.usedPercent ? window : tightest
  ));
}

function liveQuota(now = Date.now()) {
  const codexBin = process.env.ORCH_CODEX_BIN || process.env.CODEX_BIN || 'codex';
  const probe = spawnSync(process.execPath, [LIVE_PROBE, codexBin], {
    encoding: 'utf8',
    timeout: LIVE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  if (probe.error || probe.status !== 0 || !probe.stdout) return null;
  try { return parseLiveQuota(JSON.parse(probe.stdout.trim()), now); } catch { return null; }
}

function cachePath(stateDir) {
  return path.join(stateDir, LIVE_CACHE_FILE);
}

function cacheEntryFresh(cached, cacheSeconds, now) {
  return cached && typeof cached.fetchedAt === 'number' && Number.isFinite(cached.fetchedAt) &&
    now >= cached.fetchedAt && now - cached.fetchedAt < cacheSeconds * 1000;
}

function cachedQuotaResult(cached, now) {
  if (!cached || typeof cached.fetchedAt !== 'number' || !Number.isFinite(cached.fetchedAt)) return null;
  if (cached.failed === true) return { failed: true, fetchedAt: cached.fetchedAt };
  if (typeof cached.usedPercent !== 'number' || !Number.isFinite(cached.usedPercent) ||
      cached.usedPercent < 0 || cached.usedPercent > 100 ||
      typeof cached.resetsAt !== 'number' || !Number.isFinite(cached.resetsAt) || cached.resetsAt < 0 ||
      (cached.resetsAt && cached.resetsAt * 1000 <= now)) return null;
  const effective = effectiveUsedPercent(cached, now);
  return effective
    ? { ...effective, fetchedAt: cached.fetchedAt, source: 'live', limitReached: cached.limitReached === true }
    : null;
}

function readFreshCache(stateDir, cacheSeconds, now = Date.now()) {
  if (!stateDir) return null;
  const file = cachePath(stateDir);
  try {
    // One hook process can ask for the route more than once while evaluating one Agent
    // dispatch. Keep the parsed result in memory as well as on disk so the second lookup is
    // effectively free. Requiring the cache file to still exist keeps tests and operators
    // able to invalidate it explicitly by removing the file.
    const memoized = processCache.get(file);
    if (memoized && fs.existsSync(file) &&
        (cacheSeconds <= 0 || cacheEntryFresh(memoized, cacheSeconds, now))) {
      return cachedQuotaResult(memoized, now);
    }

    if (cacheSeconds <= 0) return null;

    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!cacheEntryFresh(cached, cacheSeconds, now)) return null;
    const result = cachedQuotaResult(cached, now);
    if (!result) return null;
    processCache.set(file, cached);
    return result;
  } catch { return null; }
}

/** A structurally valid cache entry even when its file TTL expired, for probe-lock losers. */
function readStaleCache(stateDir, now = Date.now()) {
  try {
    return cachedQuotaResult(JSON.parse(fs.readFileSync(cachePath(stateDir), 'utf8')), now);
  } catch { return null; }
}

function writeCache(stateDir, quota, now = Date.now()) {
  if (!stateDir) return;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const file = cachePath(stateDir);
    const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const cached = quota ? {
      usedPercent: quota.usedPercent,
      resetsAt: quota.resetsAt || 0,
      fetchedAt: now,
      limitReached: quota.limitReached === true,
    } : { failed: true, fetchedAt: now };
    fs.writeFileSync(temp, JSON.stringify(cached), { mode: 0o600 });
    fs.renameSync(temp, file);
    processCache.set(file, cached);
  } catch {}
}

/** Fresh cache -> live app-server -> session log -> unknown. */
function codexQuota(now = Date.now(), options = {}) {
  let stateDir = options.stateDir;
  let cacheSeconds = options.cacheSeconds;
  if (!stateDir || cacheSeconds === undefined) {
    try {
      const config = require('./config.cjs');
      const cfg = config.loadConfig();
      if (!stateDir) stateDir = config.stateDir();
      if (cacheSeconds === undefined) cacheSeconds = config.codexQuotaCacheSeconds(cfg);
    } catch {}
  }
  stateDir ||= process.env.ORCH_STATE_DIR || path.join(os.homedir(), '.claude', 'orchestrator-gate');
  if (cacheSeconds === undefined) cacheSeconds = DEFAULT_CACHE_SECONDS;
  const cached = readFreshCache(stateDir, cacheSeconds, now);
  if (cached && !cached.failed) return cached;
  if (cached && cached.failed) return readSessionQuota(now);
  const probeLockDir = path.join(stateDir, LIVE_PROBE_LOCK);
  const probeLock = acquireLock(probeLockDir, {
    timeoutMs: 300,
    retryMs: 25,
    staleMs: LIVE_TIMEOUT_MS + 1000,
  });
  if (probeLock === false) {
    const afterWait = readFreshCache(stateDir, cacheSeconds, now);
    if (afterWait && !afterWait.failed) return afterWait;
    if (afterWait && afterWait.failed) return readSessionQuota(now);
    const stale = readStaleCache(stateDir, now);
    return stale && !stale.failed ? stale : readSessionQuota(now);
  }
  try {
    // Another process may have refreshed the cache while this process waited for the lease.
    const afterAcquire = readFreshCache(stateDir, cacheSeconds, now);
    if (afterAcquire && !afterAcquire.failed) return afterAcquire;
    if (afterAcquire && afterAcquire.failed) return readSessionQuota(now);
    const live = liveQuota(now);
    if (live) {
      writeCache(stateDir, live, now);
      return { ...live, fetchedAt: now, source: 'live' };
    }
    writeCache(stateDir, null, now);
    return readSessionQuota(now);
  } finally {
    if (probeLock) releaseLock(probeLockDir);
  }
}

function formatAge(ageMs) {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Pure decision: Codex first; the in-session code model once Codex has used
 * `handoffUsed` % or more. Codex unknown keeps the preferred side (Codex). claudeLeft is
 * reported, not decisive.
 */
function pickExecRoute(claudeLeft, codexLeft, handoffUsedPct = 40) {
  if (codexLeft === null) return 'codex';
  return 100 - codexLeft >= handoffUsedPct ? 'sonnet' : 'codex';
}

/** Current routing verdict with the numbers that produced it. */
function execRoute(handoffUsedPct = 40, now = Date.now(), options = {}) {
  const claudeQuota = readClaudeQuota(now);
  const quota = codexQuota(now, options);
  const claudeLeft = claudeQuota ? claudeQuota.remaining : null;
  const codexLeft = quota ? Math.max(0, 100 - quota.usedPercent) : null;
  const fmt = (v) => (v === null ? 'unknown' : `${Math.round(v)}% left`);
  const claudeSummary = claudeQuota
    ? `Claude ${fmt(claudeLeft)} (cache, ${formatAge(claudeQuota.ageMs)} old)`
    : 'Claude unknown';
  const codexSource = !quota ? 'unknown' : quota.source === 'live'
    ? `${quota.limitReached ? 'limit reached, ' : ''}live, ${formatAge(Math.max(0, now - quota.fetchedAt))} ago`
    : `session log, ${formatAge(quota.ageMs)} old`;
  return {
    route: pickExecRoute(claudeLeft, codexLeft, handoffUsedPct),
    claudeLeft,
    codexLeft,
    codexSource,
    summary: `${claudeSummary} vs Codex ${fmt(codexLeft)} (${codexSource})`,
  };
}

module.exports = {
  pickExecRoute, execRoute, claudeRemaining, codexRemaining, newestSessionFiles,
  parseLiveQuota, liveQuota, codexQuota, readFreshCache, formatAge,
};
