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
const KIMI_LIVE_TIMEOUT_MS = 3500;
const KIMI_LIVE_CACHE_FILE = 'kimi-quota-live.json';
const KIMI_LIVE_PROBE_LOCK = '.kimi-quota-probe.lock';
const KIMI_LIVE_PROBE = path.join(__dirname, 'kimi-quota-probe.cjs');
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
      const windows = [rl.primary, rl.secondary]
        .filter(Boolean)
        .map((w) => windowUsed(w.used_percent, w.resets_at ? w.resets_at * 1000 : 0, now, false))
        .filter((v) => v !== null);
      if (windows.length) {
        return {
          usedPercent: Math.max(...windows),
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

function resetSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value / 1000 : value;
  if (typeof value !== 'string') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && value.trim() !== '') return numeric > 1e12 ? numeric / 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
}

function kimiWindow(limit, remaining, resetTime, now, usedRatio) {
  let usedPercent = null;
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0 &&
      typeof remaining === 'number' && Number.isFinite(remaining)) {
    usedPercent = Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
  } else if (typeof usedRatio === 'number' && Number.isFinite(usedRatio) && usedRatio >= 0) {
    usedPercent = Math.max(0, Math.min(100, usedRatio <= 1 ? usedRatio * 100 : usedRatio));
  }
  if (usedPercent === null) return null;
  const resetsAt = resetSeconds(resetTime);
  return resetsAt && resetsAt * 1000 <= now ? { usedPercent: 0, resetsAt: 0 } : { usedPercent, resetsAt };
}

/** Every usable window of a Kimi /usages response (unreduced). */
function kimiQuotaWindows(body, now = Date.now()) {
  if (!body || typeof body !== 'object') return [];
  const windows = [];
  const usage = body.usage;
  if (usage && typeof usage === 'object') {
    windows.push(kimiWindow(usage.limit, usage.remaining, usage.resetTime || usage.reset_time, now));
  }
  if (Array.isArray(body.limits)) {
    for (const item of body.limits) {
      const detail = item && item.detail;
      if (detail && typeof detail === 'object') {
        windows.push(kimiWindow(detail.limit, detail.remaining, detail.resetTime || detail.reset_time, now));
      }
    }
  }
  if (body.usages && typeof body.usages === 'object') {
    for (const item of Object.values(body.usages)) {
      if (item && typeof item === 'object') {
        windows.push(kimiWindow(null, null, item.reset_time || item.resetTime, now, item.used_ratio));
      }
    }
  }
  return windows.filter(Boolean);
}

/** Convert Kimi's /usages response to the tightest usable quota window. */
function parseKimiUsages(body, now = Date.now()) {
  const valid = kimiQuotaWindows(body, now);
  return valid.length ? valid.reduce((a, b) => b.usedPercent > a.usedPercent ? b : a) : null;
}

function kimiProbeEnv(env = process.env) {
  const out = {};
  for (const key of ['ORCH_KIMI_HOME', 'ORCH_KIMI_USAGE_URL', 'KIMI_CODE_BASE_URL', 'HOME']) {
    if (Object.prototype.hasOwnProperty.call(env, key)) out[key] = String(env[key]);
  }
  return out;
}

function kimiLiveResult(now, env) {
  const probe = spawnSync(process.execPath, [KIMI_LIVE_PROBE], {
    encoding: 'utf8',
    timeout: KIMI_LIVE_TIMEOUT_MS,
    maxBuffer: 3 * 1024 * 1024,
    env: kimiProbeEnv(env),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const stdout = String(probe.stdout || '').trim();
  if (probe.error || !stdout) return { failed: true, kind: 'timeout' };
  try {
    const reply = JSON.parse(stdout);
    if (probe.status !== 0 || reply.ok !== true) {
      return { failed: true, kind: typeof reply.kind === 'string' ? reply.kind : 'http' };
    }
    const quota = parseKimiUsages(reply.body, now);
    return quota ? { ...quota, windows: kimiQuotaWindows(reply.body, now) } : { failed: true, kind: 'parse' };
  } catch {
    return { failed: true, kind: 'parse' };
  }
}

function cachedKimiResult(entry, now) {
  if (!entry || typeof entry.fetchedAt !== 'number' || !Number.isFinite(entry.fetchedAt)) return null;
  if (entry.failed === true) return {
    failed: true, fetchedAt: entry.fetchedAt,
    ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
  };
  if (typeof entry.usedPercent !== 'number' || !Number.isFinite(entry.usedPercent) ||
      entry.usedPercent < 0 || entry.usedPercent > 100 ||
      typeof entry.resetsAt !== 'number' || !Number.isFinite(entry.resetsAt) || entry.resetsAt < 0 ||
      (entry.resetsAt && entry.resetsAt * 1000 <= now)) return null;
  return { usedPercent: entry.usedPercent, resetsAt: entry.resetsAt, fetchedAt: entry.fetchedAt, source: 'live',
    ...(Array.isArray(entry.windows) ? { windows: entry.windows } : {}) };
}

// --- last-known quota + reset-aware estimate ---------------------------------
// A live read often fails (Kimi's access token expires whenever no Kimi CLI is running).
// The last SUCCESSFUL reading per coder is therefore persisted on its own — used% per
// window, resetAt per window, readAt — so a later failure can still produce an ESTIMATE:
// a window whose reset time has passed counts as 0% used, every other window keeps its last
// reading, and the tightest window wins. Unknown only when a coder was never read at all.
const LAST_KNOWN_FILE = { codex: 'codex-quota-last-known.json', kimi: 'kimi-quota-last-known.json' };

function validKnownWindow(w) {
  return w && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) &&
    w.usedPercent >= 0 && w.usedPercent <= 100 &&
    (w.resetsAt === undefined || (typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) && w.resetsAt >= 0));
}

/** Persist a successful reading (`quota.windows` when present, else its tightest window). */
function persistLastKnownQuota(stateDir, coder, quota, now = Date.now()) {
  const file = LAST_KNOWN_FILE[coder];
  if (!file || !stateDir || !quota) return;
  const raw = Array.isArray(quota.windows) && quota.windows.length
    ? quota.windows
    : [{ usedPercent: quota.usedPercent, resetsAt: quota.resetsAt || 0 }];
  const windows = raw.filter(validKnownWindow)
    .map((w) => ({ usedPercent: w.usedPercent, resetsAt: w.resetsAt || 0 }));
  if (!windows.length) return;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const target = path.join(stateDir, file);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ windows, readAt: now }), { mode: 0o600 });
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
    .map((w) => (w.resetsAt && w.resetsAt * 1000 <= now ? 0 : w.usedPercent));
  if (!used.length) return null;
  return { usedPercent: Math.max(...used), resetsAt: 0, fetchedAt: entry.readAt, estimated: true, source: 'estimate' };
}

function kimiQuota(now = Date.now(), options = {}) {
  const stateDir = options.stateDir || process.env.ORCH_STATE_DIR || path.join(os.homedir(), '.claude', 'orchestrator-gate');
  const cacheSeconds = options.cacheSeconds === undefined ? DEFAULT_CACHE_SECONDS : options.cacheSeconds;
  const result = liveCache().cachedLiveProbe({
    stateDir,
    cacheFile: KIMI_LIVE_CACHE_FILE,
    lockName: KIMI_LIVE_PROBE_LOCK,
    cacheSeconds,
    now,
    probe: () => kimiLiveResult(now, options.env || process.env),
    validate: cachedKimiResult,
    probeTimeoutMs: KIMI_LIVE_TIMEOUT_MS,
  });
  if (result && !result.failed) {
    persistLastKnownQuota(stateDir, 'kimi', result, now);
    return result;
  }
  // Live read unavailable: fall back to the reset-aware estimate of the last known reading.
  return estimatedQuota(stateDir, 'kimi', now) || result;
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
  // Same fallback as Kimi: estimate from the last known reading when nothing live answers.
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
  parseLiveQuota, parseKimiUsages, liveQuotaWindows, kimiQuotaWindows,
  liveQuota, codexQuota, kimiQuota, codexAuthState, readFreshCache, formatAge,
  persistLastKnownQuota, estimatedQuota,
};
