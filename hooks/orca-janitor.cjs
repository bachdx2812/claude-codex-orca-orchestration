#!/usr/bin/env node
/** Machine-wide cleanup for finished Orca worktrees. Every uncertain signal fails closed. */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig, stateDir, janitorEnabled } = require('./lib/config.cjs');
const {
  evaluateDoneButOpen, runGit, worktreeKeys, TERMINAL_WORKER_STATES,
} = require('./orca-heartbeat.cjs');

const ORCA_BIN = process.env.ORCA_BIN || 'orca';
const LOG_FILE = path.join(stateDir(), 'janitor.log');
const MAX_LOG_BYTES = 1024 * 1024;
// A busy machine's `worktree ps` page must not be truncated by a small default page size —
// `worktree ps` genuinely accepts a large explicit limit (verified against a live Orca).
// `worker-list` does NOT: Orca rejects any `--limit` above 100 with `invalid_argument`
// ("Too big: expected number to be <=100"), so worker-list paging follows `page.nextCursor`
// at this bounded per-page size instead (see `workerRows` below).
const INVENTORY_LIMIT = 10000;
const WORKER_LIST_PAGE_LIMIT = 100;
// Fails closed rather than looping forever if Orca ever hands back a `nextCursor` chain
// that never terminates.
const WORKER_LIST_MAX_PAGES = 50;
// Per-worktree "kept" reasons, persisted so a run only re-logs a line when the reason for
// that path actually changed (item 1) instead of repeating the same line every tick.
const KEPT_STATE_FILE = path.join(stateDir(), 'janitor-kept.json');
// Set from main() when invoked with --dry-run: every appendLog call also echoes to the
// console so a live diagnostic run shows its evaluation without digging into the log file.
let ECHO_TO_CONSOLE = false;

function rotateLog() {
  try {
    if (fs.statSync(LOG_FILE).size < MAX_LOG_BYTES) return;
    const previous = `${LOG_FILE}.1`;
    fs.rmSync(previous, { force: true });
    fs.renameSync(LOG_FILE, previous);
  } catch {}
}

function appendLog(message) {
  if (ECHO_TO_CONSOLE) console.log(message);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    rotateLog();
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

/** The persisted path -> last-logged-reason map, or {} on any read failure (missing file,
 * corrupt JSON) — never a crash. */
function loadKeptState() {
  try {
    const value = JSON.parse(fs.readFileSync(KEPT_STATE_FILE, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function saveKeptState(state) {
  try {
    fs.mkdirSync(path.dirname(KEPT_STATE_FILE), { recursive: true });
    const tmp = `${KEPT_STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, KEPT_STATE_FILE);
  } catch {}
}

/**
 * Logs `kept <path>: <reason>` exactly once per distinct reason for that path — a run
 * whose worktree is kept for the same reason as last run stays silent, so the log does not
 * grow unbounded while something stays genuinely kept (e.g. a long-lived live terminal).
 * `state` is the mutable in-memory map for this whole janitor run; the caller persists it
 * once at the end via `saveKeptState`.
 */
function logKept(state, worktreePath, reason) {
  if (state[worktreePath] === reason) return;
  state[worktreePath] = reason;
  appendLog(`kept ${JSON.stringify(worktreePath)}: ${reason}`);
}

/**
 * A real Orca CLI error (e.g. the `--limit` over 100 rejection this module exists to avoid)
 * answers `{ ok: false, error: { code, message } }` on stdout with a non-zero exit code, not
 * silence — so this parses stdout as JSON regardless of exit status, and only falls back to
 * null (genuinely "no reply") when the process itself errored or stdout was not JSON at all.
 * That lets every caller read `reply.error.message` instead of losing it behind "no reply".
 */
function runOrca(args, timeout = 10000) {
  try {
    const result = spawnSync(ORCA_BIN, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
    if (result.error) return null;
    try {
      return JSON.parse(result.stdout || '{}');
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/** `{ ok: false }` or `{ ok: false, error: { message } }` -> a human-readable reason suffix. */
function failureReason(reply) {
  const message = reply && reply.error && typeof reply.error.message === 'string' ? reply.error.message : null;
  return message || 'ok:false';
}

/**
 * `orca worktree ps`, normalized into this module's own row shape. Returns
 * `{ ok: true, worktrees }` on success or `{ ok: false, reason }` naming exactly which
 * check failed — no reply at all, an explicit `ok: false`, a missing `worktrees` array, or
 * a reply Orca itself marks `truncated` — so a top-level "inventory unavailable or
 * incomplete" skip can say which call and which failure mode caused it (item 3).
 */
function worktrees(run = runOrca) {
  const reply = run(['worktree', 'ps', '--json', '--limit', String(INVENTORY_LIMIT)]);
  if (!reply) return { ok: false, reason: 'worktree ps: no reply' };
  if (reply.ok === false) return { ok: false, reason: `worktree ps: ${failureReason(reply)}` };
  const result = reply.result ?? reply;
  if (!Array.isArray(result.worktrees)) return { ok: false, reason: 'worktree ps: missing worktrees array' };
  if (result.truncated) return { ok: false, reason: 'worktree ps: truncated' };
  const worktreeList = result.worktrees.filter((row) => row && typeof row.path === 'string' &&
    (row.hostId === undefined || row.hostId === 'local')).map((row) => ({
    path: row.path,
    worktreeId: typeof row.worktreeId === 'string' ? row.worktreeId : '',
    displayName: row.displayName || row.path,
    isMainWorktree: !!row.isMainWorktree,
    isArchived: !!row.isArchived,
    liveTerminalCount: typeof row.liveTerminalCount === 'number' && Number.isFinite(row.liveTerminalCount)
      ? row.liveTerminalCount : null,
    lastOutputAt: Number(row.lastOutputAt) || 0,
    prState: row.linkedPR ? row.linkedPR.state : null,
    prNumber: row.linkedPR ? row.linkedPR.number : null,
    mrState: row.linkedGitLabMR ? row.linkedGitLabMR.state : null,
    mrNumber: row.linkedGitLabMR ? row.linkedGitLabMR.number : null,
  }));
  return { ok: true, worktrees: worktreeList };
}

/**
 * `orca orchestration worker-list`, paginated by following `page.nextCursor` at a bounded
 * per-page `--limit` (Orca rejects any `--limit` over 100 outright with `invalid_argument`,
 * verified live — unlike `worktree ps`, which does accept a large explicit limit). Returns
 * `{ ok: true, workers }` or `{ ok: false, reason }` naming the failure: no reply, `ok: false`
 * (with Orca's own error message when it supplied one), a missing `workers` array, a page
 * that claims more rows exist but hands out no usable cursor to follow, or the page cap
 * below being hit — fails closed rather than looping forever on a cursor chain that never
 * terminates.
 */
function workerRows(run = runOrca) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < WORKER_LIST_MAX_PAGES; page += 1) {
    const args = ['orchestration', 'worker-list', '--include-remote', '--limit', String(WORKER_LIST_PAGE_LIMIT), '--json'];
    if (cursor) args.push('--cursor', cursor);
    const reply = run(args);
    if (!reply) return { ok: false, reason: 'worker-list: no reply' };
    if (reply.ok === false) return { ok: false, reason: `worker-list: ${failureReason(reply)}` };
    const result = reply.result ?? reply;
    if (!Array.isArray(result.workers)) return { ok: false, reason: 'worker-list: missing workers array' };
    rows.push(...result.workers);
    if (!result.page?.hasMore) return { ok: true, workers: rows };
    if (!result.page.nextCursor || result.page.nextCursor === cursor) {
      return { ok: false, reason: 'worker-list: hasMore with no usable cursor' };
    }
    cursor = result.page.nextCursor;
  }
  return { ok: false, reason: `worker-list: exceeded page cap (${WORKER_LIST_MAX_PAGES})` };
}

function workerWorktreeKeys(row) {
  const keys = new Set();
  const candidates = [
    row?.worktreeId, row?.worktreePath, row?.resourcePath,
    row?.resource?.worktreeId, row?.resource?.worktreePath, row?.resource?.path,
    row?.worktree?.path, row?.projection?.workspace?.id, row?.projection?.workspace?.path,
  ];
  for (const candidate of candidates) {
    for (const key of worktreeKeys(candidate, candidate)) keys.add(key);
  }
  return keys;
}

/**
 * A worker row blocks removal unless its terminal has been released, or every present
 * state field has reached a terminal state (succeeded/completed/failed/stopped/cancelled)
 * — a row with no state fields at all still blocks. Unlike the OR-based done checks used
 * for non-destructive heartbeat auto-close elsewhere in this codebase, a `worktree rm`
 * guard must fail closed on disagreement: a row
 * whose fields disagree (e.g. `workerState: "running"` with `dispatchStatus: "failed"`, or
 * the reverse) is NOT finished and keeps blocking, same as an `unsupervised` row — this
 * guard, unlike heartbeat supervision, treats `unsupervised` as "unknown liveness", not
 * "safe to ignore". A row Orca reports done on every present field and whose terminal shows
 * `terminalState: "retained"` therefore no longer blocks removal (item 2) — the
 * worktree-level `liveTerminalCount === 0` guard in `runJanitor` still independently vetoes
 * any worktree that actually has a live terminal.
 */
function isLiveWorkerRow(row) {
  if (!row) return false;
  if (row.terminalState === 'released') return false;
  const fields = [row.workerState, row.dispatchStatus].filter((v) => v != null && v !== '');
  const finished = fields.length > 0 && fields.every((v) => TERMINAL_WORKER_STATES.has(v));
  return !finished;
}

function blockedWorktreeKeys(rows) {
  const blocked = new Set();
  for (const row of rows || []) {
    if (!isLiveWorkerRow(row)) continue;
    for (const key of workerWorktreeKeys(row)) blocked.add(key);
  }
  return blocked;
}

function isBlocked(worktree, blocked) {
  return [...worktreeKeys(worktree.worktreeId, worktree.path)].some((key) => blocked.has(key));
}

/** The first live worker row blocking this worktree, or null — used only to describe the
 * `kept` reason (item 1); `isBlocked`/`blockedWorktreeKeys` remain the actual guard. */
function findBlockingWorker(worktree, rows) {
  const keys = new Set(worktreeKeys(worktree.worktreeId, worktree.path));
  for (const row of rows || []) {
    if (!isLiveWorkerRow(row)) continue;
    if ([...workerWorktreeKeys(row)].some((key) => keys.has(key))) return row;
  }
  return null;
}

function runJanitor(ctx = {}) {
  const run = ctx.runOrca || runOrca;
  const git = ctx.git || runGit;
  const cfg = ctx.cfg || loadConfig();
  const worktreeResult = worktrees(run);
  const workerResult = workerRows(run);
  if (!worktreeResult.ok || !workerResult.ok) {
    const reasons = [worktreeResult.ok ? null : worktreeResult.reason, workerResult.ok ? null : workerResult.reason]
      .filter(Boolean);
    return { ok: false, removed: [], reason: `inventory unavailable or incomplete (${reasons.join('; ')})` };
  }
  const list = worktreeResult.worktrees;
  const workers = workerResult.workers;
  const blocked = blockedWorktreeKeys(workers);
  const removed = [];
  const keptState = ctx.keptState || loadKeptState();
  const verdictFor = (worktree, extra = {}) => evaluateDoneButOpen(worktree, {
    now: Date.now(), idleSeconds: 0, git, stat: ctx.stat,
    rebuildableIgnored: cfg.janitor.rebuildableIgnored,
    onBlockedIgnored: (filePath) => logKept(keptState, worktree.path, `ignored ${filePath}`),
    onNotDone: (reason) => logKept(keptState, worktree.path, reason),
    onNotClean: (reason) => logKept(keptState, worktree.path, reason),
    ...extra,
  });
  for (const worktree of list) {
    if (worktree.isMainWorktree || worktree.isArchived) continue;
    if (worktree.liveTerminalCount !== 0) {
      logKept(keptState, worktree.path, 'live terminal');
      continue;
    }
    const blockingWorker = findBlockingWorker(worktree, workers);
    if (blockingWorker) {
      logKept(keptState, worktree.path,
        `worker row ${blockingWorker.dispatchId || '?'} ${blockingWorker.workerState || '?'}/${blockingWorker.terminalState || '?'}`);
      continue;
    }
    const verdict = verdictFor(worktree);
    if (!verdict.done) continue;
    // Accepted cache entries may be up to two minutes old. Re-check without the shared
    // cache immediately before the final terminal snapshot so a newly opened PR vetoes
    // this run rather than waiting for a later janitor tick.
    if (!verdictFor(worktree, { cache: {} }).done) continue;
    const freshResult = worktrees(run);
    const fresh = freshResult.ok && freshResult.worktrees.find((row) => row.path === worktree.path);
    if (!fresh) {
      logKept(keptState, worktree.path, 're-read before removal failed');
      continue;
    }
    if (fresh.isMainWorktree || fresh.isArchived || fresh.liveTerminalCount !== 0) {
      logKept(keptState, worktree.path, 'live-terminal state changed before removal');
      continue;
    }
    if (ctx.dryRun) {
      removed.push(worktree.path);
      appendLog(`would remove ${JSON.stringify(worktree.path)} (${verdict.reason})`);
      continue;
    }
    const reply = run(['worktree', 'rm', '--worktree', `path:${worktree.path}`, '--json'], 60000);
    if (reply && reply.ok !== false) {
      removed.push(worktree.path);
      delete keptState[worktree.path];
      appendLog(`removed ${JSON.stringify(worktree.path)} (${verdict.reason})`);
    } else {
      appendLog(`remove failed ${JSON.stringify(worktree.path)}`);
    }
  }
  if (!ctx.keptState && !ctx.dryRun) {
    // Bound the persisted kept-state file to this run's own inventory: a worktree removed
    // manually, by heartbeat `remove` mode, or via a direct `orca worktree rm` never clears
    // its own entry here, so without this prune the file would grow by one stale key per
    // such removal forever.
    const livePaths = new Set(list.map((worktree) => worktree.path));
    for (const key of Object.keys(keptState)) {
      if (!livePaths.has(key)) delete keptState[key];
    }
    saveKeptState(keptState);
  }
  return { ok: true, removed };
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  ECHO_TO_CONSOLE = dryRun;
  const cfg = loadConfig();
  if (!janitorEnabled(cfg)) {
    if (dryRun) console.log('orca-janitor --dry-run: janitor.enabled is false; nothing evaluated');
    return;
  }
  const result = runJanitor({ cfg, dryRun });
  if (!result.ok) {
    appendLog(`skipped: ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  if (dryRun) {
    console.log(`orca-janitor --dry-run: ${result.removed.length} worktree(s) would be removed`);
  }
}

if (require.main === module) main();

module.exports = {
  appendLog, rotateLog, runOrca, worktrees, workerRows, workerWorktreeKeys, blockedWorktreeKeys,
  isBlocked, isLiveWorkerRow, findBlockingWorker, runJanitor, loadKeptState, saveKeptState, logKept,
};
