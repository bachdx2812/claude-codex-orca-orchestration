/**
 * exec-route-by-quota.cjs — decides who writes code: Codex (in an Orca worker) or the
 * configured in-session code model, by which provider has more quota left.
 *
 * Codex is the default coder; the in-session code model takes over once Codex has used
 * `handoffUsed(cfg)` percent or more of its tightest rate-limit window (default 95).
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
function liveCache() { return require('./live-probe-cache.cjs'); }

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
const authStateCache = new Map();

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
      // Keep each window's own reset time for the persisted last-known reading: without
      // it the reset-aware estimate could never age a stale session-log reading out (B1).
      const windows = [rl.primary, rl.secondary]
        .filter(Boolean)
        .filter((w) => typeof w.used_percent === 'number' && Number.isFinite(w.used_percent))
        .map((w) => ({ usedPercent: w.used_percent, resetsAt: w.resets_at || 0 }));
      const used = windows
        .map((w) => windowUsed(w.usedPercent, w.resetsAt ? w.resetsAt * 1000 : 0, now, false))
        .filter((v) => v !== null);
      if (used.length) {
        return {
          usedPercent: Math.max(...used),
          resetsAt: 0,
          fetchedAt: observedAt,
          source: 'session log',
          ageMs: Math.max(0, now - observedAt),
          windows,
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
  if (resetsAt && resetsAt * 1000 <= now) return { usedPercent: 0, resetsAt: 0 };
  return { usedPercent: window.usedPercent, resetsAt };
}

/** Every usable window of a live app-server result (unreduced). */
function liveQuotaWindows(result, now = Date.now()) {
  const limits = result && result.rateLimits;
  if (!limits || typeof limits !== 'object') return [];
  return [limits.primary, limits.secondary]
    .map((window) => effectiveUsedPercent(window, now))
    .filter(Boolean);
}

/** Convert a live app-server result to the tightest usable window. */
function parseLiveQuota(result, now = Date.now()) {
  const limits = result && result.rateLimits;
  const limitReached = !!(result && result.rateLimitReachedType) ||
    !!(limits && limits.rateLimitReachedType) ||
    !!(result && result.ordinaryUsageAllowed === false) ||
    !!(limits && limits.ordinaryUsageAllowed === false);
  if (limitReached) return { usedPercent: 100, resetsAt: 0, limitReached: true };
  const windows = liveQuotaWindows(result, now);
  if (!windows.length) return null;
  return windows.reduce((tightest, window) => (
    window.usedPercent > tightest.usedPercent ? window : tightest
  ));
}

// --- last-known quota + reset-aware estimate ---------------------------------
// The last successful reading is persisted on its own — used% per
// window, resetAt per window, readAt — so a later failure can still produce an ESTIMATE:
// a window whose reset time has passed counts as 0% used, every other window keeps its last
// reading, and the tightest window wins. Unknown only when Codex was never read at all.
const LAST_KNOWN_FILE = { codex: 'codex-quota-last-known.json' };
// A persisted window with NO reset time is only trusted for this long; past it the window
// is dropped (a reading that old says nothing about current usage), and if no windows are
// left the estimate is unknown rather than pinning a coder as exhausted forever (B1).
const ESTIMATE_RESETLESS_WINDOW_MAX_AGE_MS = 5 * 60 * 60 * 1000;

function validKnownWindow(w) {
  return w && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) &&
    w.usedPercent >= 0 && w.usedPercent <= 100 &&
    (w.resetsAt === undefined || (typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) && w.resetsAt >= 0));
}

/** Persist a successful reading (`quota.windows` when present, else its tightest window).
 *  `readAt` is the reading's own `fetchedAt` (never the cache-hit time), and the file is
 *  not rewritten when it already records that same reading (N1). */
function persistLastKnownQuota(stateDir, coder, quota, now = Date.now()) {
  const file = LAST_KNOWN_FILE[coder];
  if (!file || !stateDir || !quota) return;
  const raw = Array.isArray(quota.windows) && quota.windows.length
    ? quota.windows
    : [{ usedPercent: quota.usedPercent, resetsAt: quota.resetsAt || 0 }];
  const windows = raw.filter(validKnownWindow)
    .map((w) => ({
      usedPercent: w.usedPercent, resetsAt: w.resetsAt || 0,
    }));
  if (!windows.length) return;
  const readAt = typeof quota.fetchedAt === 'number' && Number.isFinite(quota.fetchedAt) ? quota.fetchedAt : now;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const target = path.join(stateDir, file);
    const existing = (() => { try { return JSON.parse(fs.readFileSync(target, 'utf8')); } catch { return null; } })();
    if (existing && existing.readAt === readAt) return; // same reading already recorded
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ windows, readAt }), { mode: 0o600 });
    fs.renameSync(temp, target);
  } catch {}
}

/**
 * The reset-aware estimate from the persisted last-known reading, or null when the coder
 * was never read successfully. Marked `estimated: true` with `fetchedAt` = the original
 * read time, so the reminder can say "est., read 40m ago".
 */
function estimatedQuota(stateDir, coder, now = Date.now()) {
  const file = LAST_KNOWN_FILE[coder];
  if (!file || !stateDir) return null;
  let entry;
  try { entry = JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf8')); } catch { return null; }
  if (!entry || !Array.isArray(entry.windows) ||
      typeof entry.readAt !== 'number' || !Number.isFinite(entry.readAt)) return null;
  const used = entry.windows.filter(validKnownWindow)
    .map((w) => {
      if (w.resetsAt && w.resetsAt * 1000 <= now) return 0;
      // A window with no reset time is dropped once the reading is too old to trust (B1).
      if (!w.resetsAt && now - entry.readAt > ESTIMATE_RESETLESS_WINDOW_MAX_AGE_MS) return null;
      return w.usedPercent;
    })
    .filter((v) => v !== null);
  if (!used.length) return null;
  return { usedPercent: Math.max(...used), resetsAt: 0, fetchedAt: entry.readAt, estimated: true, source: 'estimate' };
}

function liveQuotaResult(now = Date.now()) {
  const codexBin = process.env.ORCH_CODEX_BIN || process.env.CODEX_BIN || 'codex';
  const probe = spawnSync(process.execPath, [LIVE_PROBE, codexBin], {
    encoding: 'utf8',
    timeout: LIVE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const stdout = String(probe.stdout || '').trim();
  if (probe.status === 3 && stdout === '{"authState":"logged-out"}') {
    return { failed: true, authState: 'logged-out' };
  }
  if (probe.error || probe.status !== 0 || !stdout) return null;
  try {
    const parsed = JSON.parse(stdout);
    const quota = parseLiveQuota(parsed, now);
    return quota ? { ...quota, authState: 'ok', windows: liveQuotaWindows(parsed, now) } : null;
  } catch { return null; }
}

function liveQuota(now = Date.now()) {
  const result = liveQuotaResult(now);
  return result && !result.failed ? result : null;
}

function cachePath(stateDir) {
  return path.join(stateDir, LIVE_CACHE_FILE);
}

function cachedQuotaResult(cached, now) {
  if (!cached || typeof cached.fetchedAt !== 'number' || !Number.isFinite(cached.fetchedAt)) return null;
  if (cached.failed === true) return {
    failed: true,
    fetchedAt: cached.fetchedAt,
    ...(cached.authState === 'logged-out' ? { authState: 'logged-out' } : {}),
  };
  if (typeof cached.usedPercent !== 'number' || !Number.isFinite(cached.usedPercent) ||
      cached.usedPercent < 0 || cached.usedPercent > 100 ||
      typeof cached.resetsAt !== 'number' || !Number.isFinite(cached.resetsAt) || cached.resetsAt < 0 ||
      (cached.resetsAt && cached.resetsAt * 1000 <= now)) return null;
  const effective = effectiveUsedPercent(cached, now);
  return effective
    ? { ...effective, fetchedAt: cached.fetchedAt, source: 'live', limitReached: cached.limitReached === true,
        ...(Array.isArray(cached.windows) ? { windows: cached.windows } : {}) }
    : null;
}

function readFreshCache(stateDir, cacheSeconds, now = Date.now()) {
  return liveCache().readFresh({
    stateDir, cacheFile: LIVE_CACHE_FILE, cacheSeconds, now, validate: cachedQuotaResult,
  });
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
  const result = liveCache().cachedLiveProbe({
    stateDir,
    cacheFile: LIVE_CACHE_FILE,
    lockName: LIVE_PROBE_LOCK,
    cacheSeconds,
    now,
    probe: () => liveQuotaResult(now),
    validate: cachedQuotaResult,
    probeTimeoutMs: LIVE_TIMEOUT_MS,
  });
  if (result && !result.failed) {
    persistLastKnownQuota(stateDir, 'codex', result, now);
    return result;
  }
  if (result && result.authState === 'logged-out') return result;
  const sessionQuota = readSessionQuota(now);
  if (sessionQuota) {
    persistLastKnownQuota(stateDir, 'codex', sessionQuota, now);
    return sessionQuota;
  }
  // Estimate from the last known reading when nothing live answers.
  return estimatedQuota(stateDir, 'codex', now);
}

/** Read the last cached Codex auth state without spawning the app-server probe.
 *  Entries older than `maxAgeMs` (when given) report 'unknown', so a logged-out
 *  reading expires and the next quota call re-probes instead of excluding Codex
 *  forever. */
function codexAuthState(stateDir, now = Date.now(), maxAgeMs) {
  const file = cachePath(stateDir);
  try {
    const stat = fs.statSync(file);
    const memo = authStateCache.get(file);
    let entry;
    if (memo && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) entry = memo.entry;
    else {
      entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      authStateCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entry });
    }
    if (typeof maxAgeMs === 'number' && Number.isFinite(maxAgeMs)) {
      const fetchedAt = entry && typeof entry.fetchedAt === 'number' ? entry.fetchedAt : NaN;
      if (!Number.isFinite(fetchedAt) || now - fetchedAt > maxAgeMs) return 'unknown';
    }
    return entry && entry.authState === 'logged-out' ? 'logged-out'
      : entry && entry.authState === 'ok' ? 'ok'
        : 'unknown';
  } catch {
    return 'unknown';
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
function pickExecRoute(claudeLeft, codexLeft, handoffUsedPct = 95) {
  if (codexLeft === null) return 'codex';
  return 100 - codexLeft >= handoffUsedPct ? 'sonnet' : 'codex';
}

/** Current routing verdict with the numbers that produced it. */
function execRoute(handoffUsedPct = 95, now = Date.now(), options = {}) {
  const claudeQuota = readClaudeQuota(now);
  const result = codexQuota(now, options);
  const quota = result && !result.failed ? result : null;
  const claudeLeft = claudeQuota ? claudeQuota.remaining : null;
  const codexLeft = quota ? Math.max(0, 100 - quota.usedPercent) : null;
  const fmt = (v) => (v === null ? 'unknown' : `${Math.round(v)}% left`);
  const claudeSummary = claudeQuota
    ? `Claude ${fmt(claudeLeft)} (cache, ${formatAge(claudeQuota.ageMs)} old)`
    : 'Claude unknown';
  const codexSource = !quota ? 'unknown' : quota.source === 'live'
    ? `${quota.limitReached ? 'limit reached, ' : ''}live, ${formatAge(Math.max(0, now - quota.fetchedAt))} ago`
    : quota.source === 'estimate'
      ? `est., read ${formatAge(Math.max(0, now - quota.fetchedAt))} ago`
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
  parseLiveQuota, liveQuotaWindows, liveQuota, codexQuota, codexAuthState,
  readFreshCache, formatAge,
  persistLastKnownQuota, estimatedQuota, ESTIMATE_RESETLESS_WINDOW_MAX_AGE_MS,
};
