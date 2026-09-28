/**
 * exec-route-by-quota.cjs — decides who writes code: Codex (in an Orca worker) or the
 * configured in-session code model, by which provider has more quota left.
 *
 * Codex is the default coder; the in-session code model takes over once Codex has used
 * `handoffUsed(cfg)` percent or more of its tightest rate-limit window (default 40).
 *
 * Sources (both local, no network):
 *   - Claude: OPTIONAL. Read only if a usage-limits cache file exists and parses — either
 *     `CK_USAGE_CACHE_PATH`, or `${os.tmpdir()}/ck-usage-limits-cache.json`. This is a
 *     ClaudeKit-specific convention, not a Claude Code one, so its absence is normal and
 *     Claude quota is reported as "unknown", never an error. It is informational only —
 *     routing depends solely on Codex quota, never on Claude's.
 *   - Codex: the newest `rate_limits` event among the most recent session files under
 *     `$CODEX_HOME/sessions` (YYYY/MM/DD/*.jsonl): primary/secondary used_percent.
 * Remaining = 100 - the tightest window. A window whose resets_at has passed counts as
 * 0% used, on both sides. Codex readings never go stale by age: no newer session means
 * no newer Codex usage, and resets_at already says when each window refilled.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Claude's cache is refreshed by an external hook; older than this it no longer reflects
// this machine.
const CLAUDE_STALE_MS = 6 * 60 * 60 * 1000;
// Session files probed, newest first, for one carrying a rate_limits event.
const MAX_CODEX_FILES = 10;
// Only the tail of a session file is read; rate_limits events repeat throughout.
const TAIL_BYTES = 256 * 1024;

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
function claudeRemaining(now = Date.now()) {
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
    return Math.max(0, 100 - Math.max(...used));
  } catch {
    return null;
  }
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

/** The last rate_limits object in a session file's tail, or null. */
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
        const rl = JSON.parse(lines[i]).payload.rate_limits;
        if (rl && (rl.primary || rl.secondary)) return rl;
      } catch {}
    }
  } catch {}
  return null;
}

/** Percent of Codex quota left, or null when no session carries a rate_limits event. */
function codexRemaining(now = Date.now()) {
  try {
    for (const file of newestSessionFiles(codexSessionsDir())) {
      const rl = lastRateLimits(file);
      if (!rl) continue; // e.g. a session that has not finished its first turn yet
      const used = [rl.primary, rl.secondary]
        .filter(Boolean)
        .map((w) => windowUsed(w.used_percent, w.resets_at ? w.resets_at * 1000 : 0, now, false))
        .filter((v) => v !== null);
      if (used.length) return Math.max(0, 100 - Math.max(...used));
    }
    return null;
  } catch {
    return null;
  }
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
function execRoute(handoffUsedPct = 40, now = Date.now()) {
  const claudeLeft = claudeRemaining(now);
  const codexLeft = codexRemaining(now);
  const fmt = (v) => (v === null ? 'unknown' : `${Math.round(v)}% left`);
  return {
    route: pickExecRoute(claudeLeft, codexLeft, handoffUsedPct),
    claudeLeft,
    codexLeft,
    summary: `Claude ${fmt(claudeLeft)} vs Codex ${fmt(codexLeft)}`,
  };
}

module.exports = { pickExecRoute, execRoute, claudeRemaining, codexRemaining, newestSessionFiles };
