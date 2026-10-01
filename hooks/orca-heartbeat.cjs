#!/usr/bin/env node
/**
 * orca-heartbeat.cjs — the supervision loop for the orchestration contract.
 *
 * The main panel must never let a dispatched worker sit IDLE, and must notice a
 * Codex rate limit early enough to back off instead of re-dispatching into it.
 * A panel cannot watch anything while it is blocked waiting for a reply, so this
 * runs as a background process: it polls Orca, and **exits as soon as something
 * needs a decision**. A background process exiting re-invokes the panel, so the
 * exit is itself the wake-up signal. While nothing happens it stays silent and
 * costs no tokens.
 *
 * Usage (started by the panel right after dispatching work):
 *   node hooks/orca-heartbeat.cjs [--idle 60] [--interval 20] [--max 3600]
 *
 * Liveness: while running it keeps DIR/heartbeat-<session>.json fresh (pid, last_tick),
 * and removes it on exit. orchestrator-gate reads that file: a panel with live workers
 * may end its turn only while this daemon is alive, so waiting is never AFK - the
 * daemon's exit wakes the panel, and the gate makes it restart the daemon afterwards.
 *
 * Every fact it reports comes from Orca's own JSON, never from a guess about
 * what a worker "should" be doing:
 *   orca orchestration worker-list --json   -> dispatch/worker/terminal state
 *   orca terminal list --json               -> live terminals, lastOutputAt, orphaned
 *   orca worktree ps --json                 -> done-but-open worktrees (merged/closed PR
 *                                               or GitLab MR, or — with no PR/MR linked at
 *                                               all — HEAD already merged into the
 *                                               worktree's own upstream default branch;
 *                                               idle and clean; see the done-but-open
 *                                               section below) that nobody has closed yet.
 *                                               Live envelope shape:
 *                                               {id, ok, result:{worktrees[], hostScope,
 *                                               totalCount, truncated}, _meta}.
 *
 * It also ACTS by itself, never waiting for a panel decision, in exactly two safe cases
 * (binding operator decision, 2026-10-01):
 *   - a worker Orca reports successfully done whose worktree is provably clean and fully
 *     pushed is released and its terminal closed (WORKER CLOSED ...);
 *   - with closeDoneWorktrees:"remove", a done-but-open worktree is removed itself
 *     (WORKTREE REMOVED ...) instead of only reminding.
 * Both are informational log lines, not wake events; everything uncertain (dirty/unpushed
 * worktree, retained-for-reuse worker, open PR, another session's row) keeps the panel
 * flow.
 *
 * It reports only **changes since the baseline snapshot** taken at startup, so
 * terminals that were already open when it started cannot drown the signal.
 */

const { execFileSync, spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  loadConfig, stateDir, closeDoneWorktreesEnabled, closeDoneWorktreesMode, stallSeconds, handoffUsed, kimiHandoffUsed,
  codexQuotaCacheSeconds, kimiQuotaCacheSeconds, coderAvailabilityCacheSeconds,
  deepseekRole, deepseekDailySpendCapUsd, deepseekHandoffUsed, deepseekQuotaCacheSeconds,
  maxParallelDeepseekWorkers,
  autoResumeAfterReset,
} = require('./lib/config.cjs');
const {
  hasRateLimitError, hasCodexDisconnect, hasKimiUsageExhausted, kimiUsageLimitHours, hasCodexUsageExhausted,
  hasDeepseekBalanceExhausted,
  approvalPromptFingerprint, endsAtShellPrompt,
} = require('./lib/terminal-signals.cjs');
const {
  workerProgressSample, observeWorkerProgress, recordsFromJSON,
} = require('./lib/worker-progress-fingerprint.cjs');
const QUOTA = require('./lib/exec-route-by-quota.cjs');
const CODER_AVAILABILITY = require('./lib/coder-availability.cjs');
const CODER_POOL = require('./lib/coder-pool-route.cjs');
const HANDOVER = require('./lib/worker-quota-handover.cjs');
const RESUME = require('./lib/quota-reset-resume.cjs');
const WG = require('./lib/worker-groups.cjs');
const GATES = require('./lib/parallel-ownership-gates.cjs');
const { acquireLock, releaseLock } = require('./lib/file-lock.cjs');

const DIR = stateDir();
const ORCA_BIN = process.env.ORCA_BIN || 'orca';
// Overridable the same way ORCA_BIN is (tests point this at a deterministic stub); a bare
// "git" resolves against PATH exactly like the bare "orca" default does.
const GIT_BIN = process.env.ORCH_GIT_BIN || 'git';
const RESUME_SCHEDULER = path.join(__dirname, 'orca-resume-scheduler.cjs');
const DONE_PR_STATES = new Set(['merged', 'closed']);
// GitLab's MR state vocabulary uses "opened"/"merged"/"closed"/"locked" where GitHub's PR
// vocabulary uses "open"/"merged"/"closed" — normalize the "still open" spelling so a linked
// GitLab MR is judged by the same accepted/still-open distinction as a linked GitHub PR.
const OPEN_MR_STATES = new Set(['open', 'opened', 'locked']);

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
}

const cfg = loadConfig();
const IDLE_SECONDS = arg('idle', cfg.heartbeat.idleSeconds);        // quiet terminal => needs a decision
const INTERVAL_SECONDS = arg('interval', cfg.heartbeat.intervalSeconds);
const MAX_SECONDS = arg('max', cfg.heartbeat.maxSeconds);           // hard stop so a forgotten daemon dies
const STALL_SECONDS = stallSeconds(cfg);
const CLOSE_DONE_WORKTREES = closeDoneWorktreesEnabled(cfg);
// 'remove' | 'remind' | 'off' — in remove mode the done-worktree detector runs
// `orca worktree rm` itself instead of only reminding the panel.
const CLOSE_DONE_WORKTREES_MODE = closeDoneWorktreesMode(cfg);
const AUTO_RESUME = autoResumeAfterReset(cfg);
// A fleet with many worktrees means many per-row git subprocess calls (idle/accepted/clean,
// each independently bounded ~3s by runGit) inside one `processDoneWorktrees` pass — capped
// (on the steady-state pass only, see processDoneWorktrees's item-4 note) so a single
// git-heavy tick can never run long enough to starve the liveness file (see `beat()` calls
// inside that loop) into looking dead. `ORCH_GIT_BUDGET_MS` overrides it for one process
// (tests only — a real 10s budget would make exercising the cap prohibitively slow to test).
const GIT_BUDGET_MS = Number(process.env.ORCH_GIT_BUDGET_MS) > 0 ? Number(process.env.ORCH_GIT_BUDGET_MS) : 10000;

// Session whose panel started this daemon (inherited from the Claude Code Bash tool).
const SESSION = String(process.env.CLAUDE_CODE_SESSION_ID || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
const BEAT_FILE = path.join(DIR, `heartbeat-${SESSION}.json`);
// Persists the last quiet stretch reported for each terminal in this session. The daemon
// exits to wake the panel, so process-local de-duplication alone would re-report the same
// retained terminal after every restart. A changed lastOutputAt value starts a new stretch.
const IDLE_REPORTED_FILE = path.join(DIR, `heartbeat-${SESSION}-idle-reported.json`);
// A lost app-server connection is independent of terminal output activity: Codex can keep
// repainting its TUI forever after the session is unrecoverable. Report each affected
// terminal once for this session, including across heartbeat daemon restarts.
const DISCONNECT_REPORTED_FILE = path.join(DIR, `heartbeat-${SESSION}-disconnect-reported.json`);
// Kimi's "usage limit for this billing cycle" 403 is terminal for this billing cycle, not a
// back-off-and-retry: report each affected terminal once per session (surviving daemon
// restarts, same mechanism as the disconnect report) so a restart never re-marks Kimi
// exhausted.
const USAGE_EXHAUSTED_REPORTED_FILE = path.join(DIR, `heartbeat-${SESSION}-usage-exhausted-reported.json`);
// Per-terminal fingerprint, last real progress time and once-per-episode report marker.
// This survives daemon restarts because emitting any wake event intentionally exits.
const STALL_PROGRESS_FILE = path.join(DIR, `heartbeat-${SESSION}-stall-progress.json`);
const APPROVAL_REPORTED_FILE = path.join(DIR, `heartbeat-${SESSION}-approval-reported.json`);
// A worker whose agent process died back to a shell prompt is reported once per episode
// (handle -> lastOutputAt at report time; fresh output afterwards re-arms it), surviving
// daemon restarts like the idle report.
const EXITED_REPORTED_FILE = path.join(DIR, `heartbeat-${SESSION}-exited-reported.json`);
// Persists which done-but-open worktree paths this SESSION has already reported (via the
// one-time startup summary or a wake event), surviving a daemon restart within the session —
// see processDoneWorktrees()'s doc comment for why this file exists.
const DONE_WT_FILE = path.join(DIR, `heartbeat-${SESSION}-done-wt.json`);
// Persists, per dispatch id, the auto-close state this session already reached for a done
// worker: {state, at} where state is 'closed' (released + terminal closed), 'unsaved'
// (WORKER DONE BUT UNSAVED reported) or 'failed' (the release call itself failed; `at`
// bounds the retry so a failing Orca is not hammered every tick). A later tick (or daemon
// restart) never re-closes or re-reports the same worker, while an 'unsaved' worker that
// later becomes clean still gets closed.
const AUTO_CLOSED_FILE = path.join(DIR, `heartbeat-${SESSION}-auto-closed.json`);
// Persists, per dispatch id, when this session's daemon FIRST saw the worker done. The
// retained-for-reuse check compares the gate's retainedAt against this: only a retain
// that ran after the done transition blocks auto-close.
const DONE_AT_FILE = path.join(DIR, `heartbeat-${SESSION}-done-at.json`);
// Persists, per worktree path, when a remove-mode `orca worktree rm` last failed, so the
// retry is bounded instead of hammered on every tick (and never silently dropped).
const RM_FAILED_FILE = path.join(DIR, `heartbeat-${SESSION}-rm-failed.json`);
// Orca vocabulary for "the work finished successfully" — distinct from failed/stopped,
// which keep the panel-decision flow. Auto-release only ever applies to these.
const DONE_WORKER_STATES = new Set(['succeeded', 'completed']);
// Orca vocabulary for "the work did not finish successfully" — never auto-closed,
// regardless of which of workerState/dispatchStatus carries it (review, non-blocking
// note: a contradictory row such as workerState 'succeeded' with dispatchStatus 'failed'
// must not auto-close either).
const FAILED_WORKER_STATES = new Set(['failed', 'stopped', 'cancelled']);
function isFailedWorker(w) {
  return FAILED_WORKER_STATES.has(w && w.workerState) || FAILED_WORKER_STATES.has(w && w.dispatchStatus);
}
// Cooldown before a failed worker-release or worktree-rm is retried.
const MUTATION_RETRY_MS = 10 * 60 * 1000;

/** Refresh the liveness file the gate checks (atomic write). */
function beat(started) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${BEAT_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      pid: process.pid, session: SESSION, started, last_tick: Date.now(), interval: INTERVAL_SECONDS,
    }));
    fs.renameSync(tmp, BEAT_FILE);
  } catch {}
}

/** Remove the liveness file, but only if it is still ours. */
function unbeat() {
  try {
    const b = JSON.parse(fs.readFileSync(BEAT_FILE, 'utf8'));
    if (b.pid === process.pid) fs.unlinkSync(BEAT_FILE);
  } catch {}
}

/** The persisted "already reported this session" path set, or null when the file does not
 * exist yet — which is how the session's very first daemon run is told apart from a later
 * restart within the same session (see processDoneWorktrees()). */
function loadPersistedDoneWorktrees() {
  try {
    const arr = JSON.parse(fs.readFileSync(DONE_WT_FILE, 'utf8'));
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return null;
  }
}

function savePersistedDoneWorktrees(set) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${DONE_WT_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...set]));
    fs.renameSync(tmp, DONE_WT_FILE);
  } catch {}
}

function loadPersistedAutoClosed() {
  try {
    const pairs = JSON.parse(fs.readFileSync(AUTO_CLOSED_FILE, 'utf8'));
    if (!Array.isArray(pairs)) return new Map();
    return new Map(pairs.filter((pair) => Array.isArray(pair) && pair.length === 2 &&
      typeof pair[0] === 'string').map(([id, v]) => {
      // Legacy entries were a bare 'closed'|'unsaved' string; normalize to {state, at}.
      if (typeof v === 'string') return [id, { state: v, at: 0 }];
      return [id, v];
    }).filter(([, v]) => v && typeof v === 'object' &&
      ['closed', 'unsaved', 'failed', 'unknown'].includes(v.state) && Number.isFinite(v.at)));
  } catch {
    return new Map();
  }
}

function savePersistedAutoClosed(map) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${AUTO_CLOSED_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...map]));
    fs.renameSync(tmp, AUTO_CLOSED_FILE);
  } catch {}
}

/** Generic loader for the small dispatchId/path -> epoch-ms persistence files. */
function loadPersistedTimestampMap(file) {
  try {
    const pairs = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(pairs)) return new Map();
    return new Map(pairs.filter((pair) => Array.isArray(pair) && pair.length === 2 &&
      typeof pair[0] === 'string' && Number.isFinite(pair[1])));
  } catch {
    return new Map();
  }
}

function savePersistedTimestampMap(file, map) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...map]));
    fs.renameSync(tmp, file);
  } catch {}
}

/** An action the daemon took by itself (no panel decision needed): printed, and appended
 * to the session log, but never a wake event — the daemon keeps running. */
function logInfoLine(line) {
  console.log(`orca-heartbeat: ${line}`);
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(path.join(DIR, 'heartbeat.log'), `${new Date().toISOString()}\t${line}\n`);
  } catch {}
}

function loadPersistedIdleReports() {
  try {
    const pairs = JSON.parse(fs.readFileSync(IDLE_REPORTED_FILE, 'utf8'));
    if (!Array.isArray(pairs)) return new Map();
    return new Map(pairs.filter((pair) => Array.isArray(pair) && pair.length === 2 &&
      typeof pair[0] === 'string' && Number.isFinite(pair[1])));
  } catch {
    return new Map();
  }
}

function savePersistedIdleReports(map) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${IDLE_REPORTED_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...map]));
    fs.renameSync(tmp, IDLE_REPORTED_FILE);
  } catch {}
}

function loadPersistedDisconnectReports() {
  try {
    const handles = JSON.parse(fs.readFileSync(DISCONNECT_REPORTED_FILE, 'utf8'));
    return new Set(Array.isArray(handles) ? handles.filter((handle) => typeof handle === 'string') : []);
  } catch {
    return new Set();
  }
}

function savePersistedDisconnectReports(set) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${DISCONNECT_REPORTED_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...set]));
    fs.renameSync(tmp, DISCONNECT_REPORTED_FILE);
  } catch {}
}

function loadPersistedUsageExhaustedReports() {
  try {
    const data = JSON.parse(fs.readFileSync(USAGE_EXHAUSTED_REPORTED_FILE, 'utf8'));
    if (!Array.isArray(data)) return new Map();
    // Legacy format: a bare array of handle strings — those handles stay reported
    // forever, exactly as the old once-per-session semantics had it.
    if (data.every((entry) => typeof entry === 'string')) {
      return new Map(data.map((handle) => [handle, { coder: null, until: Number.MAX_SAFE_INTEGER }]));
    }
    return new Map(data.filter((pair) =>
      Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' &&
      pair[1] && Number.isFinite(pair[1].until)));
  } catch {
    return new Map();
  }
}

function savePersistedUsageExhaustedReports(map) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${USAGE_EXHAUSTED_REPORTED_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...map]));
    fs.renameSync(tmp, USAGE_EXHAUSTED_REPORTED_FILE);
  } catch {}
}

function loadPersistedStallProgress() {
  try { return recordsFromJSON(JSON.parse(fs.readFileSync(STALL_PROGRESS_FILE, 'utf8'))); }
  catch { return new Map(); }
}

function savePersistedStallProgress(records) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${STALL_PROGRESS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...records]));
    fs.renameSync(tmp, STALL_PROGRESS_FILE);
  } catch {}
}

function loadPersistedApprovalReports() {
  try {
    const pairs = JSON.parse(fs.readFileSync(APPROVAL_REPORTED_FILE, 'utf8'));
    return new Map(Array.isArray(pairs) ? pairs.filter((pair) =>
      Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' &&
      typeof pair[1] === 'string') : []);
  } catch {
    return new Map();
  }
}

function savePersistedApprovalReports(reported) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${APPROVAL_REPORTED_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...reported]));
    fs.renameSync(tmp, APPROVAL_REPORTED_FILE);
  } catch {}
}

function reportApprovalWaiting({ reported, handle, fingerprint, identity, agent }) {
  if (reported.get(handle) === fingerprint) return null;
  reported.set(handle, fingerprint);
  savePersistedApprovalReports(reported);
  return `WORKER WAITING FOR APPROVAL ${identity || handle} (${agent || 'unknown'})`;
}

function loadPersistedExitedReports() {
  try {
    const pairs = JSON.parse(fs.readFileSync(EXITED_REPORTED_FILE, 'utf8'));
    if (!Array.isArray(pairs)) return new Map();
    return new Map(pairs.filter((pair) => Array.isArray(pair) && pair.length === 2 &&
      typeof pair[0] === 'string' && Number.isFinite(pair[1])));
  } catch {
    return new Map();
  }
}

function savePersistedExitedReports(map) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${EXITED_REPORTED_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...map]));
    fs.renameSync(tmp, EXITED_REPORTED_FILE);
  } catch {}
}

/** Once-per-episode report for a worker whose agent process is gone from its terminal. */
function reportWorkerExited({ reported, handle, lastOutputAt, identity, agent }) {
  if (reported.get(handle) === lastOutputAt) return null;
  reported.set(handle, lastOutputAt);
  savePersistedExitedReports(reported);
  return `WORKER EXITED ${identity || handle} (${agent || 'unknown'} process gone, terminal at shell prompt) - ` +
    'read the terminal for the cause (e.g. Claude Code\'s trust dialog defaulting to exit in an ' +
    'untrusted worktree), then re-dispatch: Kimi/Codex, or headless `claude -p` launched via worker-start';
}

// What to do when a coder's output shows it is exhausted for this billing cycle: record an
// exhaustion marker the routing code reads to exclude that coder until reset. A
// missing/failing marker write degrades to a no-op; the report event itself is still emitted.
/**
 * The exhaustion episode's end time: a windowed limit lasts until that window's known
 * reset (else one window length from now); the billing-cycle form keeps the long default.
 * Shared by the marker write and the report de-duplication so both agree on when an
 * episode is over and a re-used terminal may re-mark.
 */
function exhaustionUntilMs(coder, windowHours, now) {
  const hours = Number.isFinite(windowHours) ? windowHours : null;
  if (coder === 'kimi' && hours) {
    return QUOTA.kimiWindowResetMs(DIR, hours * 60, now) || now + hours * 60 * 60 * 1000;
  }
  if (hours) return now + hours * 60 * 60 * 1000;
  return now + 6 * 60 * 60 * 1000;
}

let onCoderExhausted = defaultOnCoderExhausted;
function defaultOnCoderExhausted(coder, info = {}) {
  try {
    const now = Date.now();
    const hours = Number.isFinite(info.windowHours) ? info.windowHours : null;
    const until = Number.isFinite(info.until) ? info.until : exhaustionUntilMs(coder, info.windowHours, now);
    require('./lib/coder-availability.cjs').markCoderExhausted(DIR, coder, {
      now, until,
      reason: hours ? `${hours}-hour usage limit reached (worker output)`
        : 'usage limit reached for this billing cycle (worker output)',
    });
  } catch {}
}

/** Test hook: replace the exhaustion-marker side effect. Pass null to restore the default. */
function setOnCoderExhausted(fn) {
  onCoderExhausted = typeof fn === 'function' ? fn : defaultOnCoderExhausted;
}

/**
 * The usage-exhausted report: persists the handle with its episode end BEFORE emitting so
 * a daemon restart never re-marks or re-reports mid-episode, calls the (injectable)
 * exhaustion-marker hook, and returns the event text. A handle re-arms once its episode
 * ends (`until` passes), so a Kimi terminal re-used after the window reset marks again on
 * the next limit. `silent` writes the marker without an event — for terminals outside
 * this session's fleet, whose exhaustion is a machine-wide fact but not this session's
 * wake event. Returns null when the handle's episode is still open.
 */
function reportUsageExhausted({ reported, handle, label, coder, windowHours, now = Date.now(), silent = false }) {
  const until = exhaustionUntilMs(coder, windowHours, now);
  const previous = reported.get(handle);
  if (previous && previous.until > now) return null;
  reported.set(handle, { coder, until });
  savePersistedUsageExhaustedReports(reported);
  onCoderExhausted(coder, {
    windowHours: Number.isFinite(windowHours) ? windowHours : null, until,
  });
  if (silent) return null;
  const name = coder === 'codex' ? 'Codex' : coder === 'kimi' ? 'Kimi' : 'DeepSeek';
  const other = coder === 'codex' ? 'Kimi or DeepSeek' : coder === 'kimi' ? 'Codex or DeepSeek' : 'Codex or Kimi';
  return `${name.toUpperCase()} USAGE LIMIT on ${label}: ${name} is exhausted - ` +
    `route new code to ${other} (or Sonnet if none is eligible); follow the WORKER HANDOVER recipe ` +
    'to commit WIP and HANDOVER.md before stopping/releasing this worker; do not retry it until reset';
}

function pidAlive(pid, file) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'win32') return true;
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8', timeout: 1000,
    });
    return command.includes('orca-resume-scheduler.cjs') && (!file || command.includes(file));
  } catch { return false; }
}

function spawnResumeScheduler(file) {
  try {
    const child = spawn(process.execPath, [RESUME_SCHEDULER, '--job', file], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    child.unref();
    return child.pid || 0;
  } catch { return 0; }
}

/** The pool/quota coder key for a worker agent (opencode runs DeepSeek). */
function quotaKeyForAgent(agent) {
  return agent === 'opencode' ? 'deepseek' : agent;
}

/** Probe only coders with live supervised workers. The existing quota helpers own the
 * shared cache and single-flight lock, so a fresh gate reading makes this effectively free. */
function probeLiveCoderQuotas(agents, now = Date.now(), deps = {}) {
  const result = { codex: null, kimi: null, deepseek: null };
  if (agents.has('codex')) {
    const reading = (deps.codexQuota || QUOTA.codexQuota)(now, {
      stateDir: DIR, cacheSeconds: codexQuotaCacheSeconds(cfg),
    });
    if (reading && !reading.failed) result.codex = reading;
  }
  if (agents.has('kimi')) {
    const reading = (deps.kimiQuota || QUOTA.kimiQuota)(now, {
      stateDir: DIR, cacheSeconds: kimiQuotaCacheSeconds(cfg), env: process.env,
    });
    if (reading && !reading.failed) result.kimi = reading;
  }
  if (agents.has('deepseek') || agents.has('opencode')) {
    const reading = (deps.deepseekQuota || QUOTA.deepseekQuota)(now, {
      stateDir: DIR, cacheSeconds: deepseekQuotaCacheSeconds(cfg), env: process.env,
      dailyCapUsd: deepseekDailySpendCapUsd(cfg),
    });
    if (reading && !reading.failed) result.deepseek = reading;
  }
  return result;
}

/** Supplement live-worker readings with fresh cache-only data for destination selection.
 * This keeps an idle/exhausted alternative out of the recommendation without probing it. */
function cachedCoderQuotas(now = Date.now(), deps = {}) {
  const codex = (deps.readCodexCache || QUOTA.readFreshCache)(DIR, codexQuotaCacheSeconds(cfg), now);
  const kimi = (deps.readKimiCache || QUOTA.readFreshKimiCache)(DIR, kimiQuotaCacheSeconds(cfg), now);
  const deepseek = (deps.readDeepseekCache || QUOTA.readFreshDeepseekCache)(DIR, deepseekQuotaCacheSeconds(cfg), now);
  return {
    codex: codex && !codex.failed ? codex : null,
    kimi: kimi && !kimi.failed ? kimi : null,
    deepseek: deepseek && !deepseek.failed ? deepseek : null,
  };
}

function buildHandoverPool(quotas, now = Date.now(), deps = {}) {
  const authState = (deps.codexAuthState || QUOTA.codexAuthState)(
    DIR, now, coderAvailabilityCacheSeconds(cfg) * 1000
  );
  const availability = deps.availability || CODER_AVAILABILITY.coderAvailability({
    stateDir: DIR, cacheSeconds: coderAvailabilityCacheSeconds(cfg), now,
    orcaInstalled: true, env: process.env, codexAuthState: authState,
  });
  return (deps.pickCoderPool || CODER_POOL.pickCoderPool)({
    availability, quotas,
    thresholds: { codex: handoffUsed(cfg), kimi: kimiHandoffUsed(cfg), deepseek: deepseekHandoffUsed(cfg) },
    roles: { deepseek: deepseekRole(cfg) },
    exhaustion: (deps.readCoderExhaustion || CODER_AVAILABILITY.readCoderExhaustion)(DIR, now),
    live: { codex: 0, kimi: 0, deepseek: 0 }, caps: { codex: 0, kimi: 0, deepseek: 0 },
    // Handover must never recommend an unavailable destination. The legacy null fallback
    // mode applies only to default new-work routing, not recovery of an in-flight task.
    fallbackEnabled: true,
  });
}

/** Run an orca command and return parsed JSON, or null when orca cannot answer. */
function orca(args, timeoutMs = 20000) {
  try {
    const out = execFileSync(ORCA_BIN, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function terminals() {
  const d = orca(['terminal', 'list', '--json']);
  if (!d) return null;
  const r = d.result ?? d;
  const list = Array.isArray(r) ? r : r.terminals || [];
  return list.map((t) => ({
    handle: t.handle,
    title: t.title || '',
    agentIdentity: typeof t.agentIdentity === 'string' ? t.agentIdentity : '',
    preview: t.preview || '',
    lastOutputAt: Number(t.lastOutputAt) || 0,
    orphaned: !!t.orphaned,
    connected: !!t.connected,
    worktreePath: t.worktreePath || '',
    worktreeId: t.worktreeId || '',
  }));
}

function parseTerminalScreen(reply) {
  if (!reply || reply.ok === false) return null;
  const result = reply.result ?? reply;
  const terminal = result && result.terminal ? result.terminal : result;
  if (!terminal) return null;
  if (Array.isArray(terminal.tail)) return terminal.tail.join('\n');
  if (typeof terminal.tail === 'string') return terminal.tail;
  return null;
}

/** Rendered screen text is authoritative; list previews are lossy repaint composites. */
function terminalReadArgs(handle) {
  return ['terminal', 'read', '--terminal', handle, '--screen', '--json'];
}

function terminalScreen(handle) {
  return parseTerminalScreen(orca(terminalReadArgs(handle), 2000));
}

function resolveTerminalScreen(readText, previousText, listPreview) {
  if (readText !== null) return readText;
  if (typeof previousText === 'string') return previousText;
  return listPreview || '';
}

function workers() {
  return parseWorkerRows(orca(['orchestration', 'worker-list', '--json']));
}

/** Orca's own completion time on a worker row (epoch ms or ISO), or null. */
function workerRowCompletedAt(w) {
  const candidates = [w.completedAt, w.finishedAt, w.endedAt,
    w.resource && (w.resource.completedAt || w.resource.finishedAt || w.resource.endedAt)];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
    if (typeof value === 'string') {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && value.trim() !== '') return numeric < 1e12 ? numeric * 1000 : numeric;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function parseWorkerRows(d) {
  if (!d || d.ok === false) return null;
  const r = d.result ?? d;
  const list = Array.isArray(r) ? r : r.workers || [];
  return list.map((w) => ({
    dispatchId: w.dispatchId,
    taskId: w.taskId,
    workerState: w.workerState,
    dispatchStatus: w.dispatchStatus,
    terminalState: w.terminalState,
    agent: w.agent || '',
    agentTerminalHandle: w.agentTerminalHandle || '',
    // Orca's own completion time (epoch ms or ISO), when the row carries one: the
    // authoritative done timestamp, preferred over this daemon's first-seen-done time.
    completedAt: workerRowCompletedAt(w),
    // Orca's own distinction between an explicit operator retain and its automatic
    // readiness-timeout retain ('user_requested' | 'identity_unproven' | null).
    retainedReason: typeof w.retainedReason === 'string' ? w.retainedReason
      : (w.resource && typeof w.resource.retainedReason === 'string' ? w.resource.retainedReason : null),
    // Orca's own operator-ownership signal — a live 'user_owned' row must never be
    // auto-closed regardless of retainedReason (review, blocker 2).
    ownershipState: typeof w.ownershipState === 'string' ? w.ownershipState
      : (w.resource && typeof w.resource.ownershipState === 'string' ? w.resource.ownershipState : null),
    worktreeIds: [
      w.worktreeId,
      w.resource && w.resource.worktreeId,
      w.projection && w.projection.workspace && w.projection.workspace.id,
    ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0),
    worktreePaths: [
      w.worktreePath,
      w.resourcePath,
      w.resource && w.resource.path,
      w.resource && w.resource.worktreePath,
      w.worktree && w.worktree.path,
    ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0),
  }));
}

function terminalWorktreePath(terminal, workerRows) {
  if (terminal.worktreePath) return terminal.worktreePath;
  const terminalKeys = [...worktreeKeys(terminal.worktreeId, '')];
  const terminalPath = terminalKeys.find((key) => path.isAbsolute(key));
  if (terminalPath) return terminalPath;
  const worker = (workerRows || []).find((row) => row.agentTerminalHandle === terminal.handle);
  if (!worker) return '';
  const candidates = [
    ...(worker.worktreePaths || []),
    ...(worker.worktreeIds || []).flatMap((id) => [...worktreeKeys(id, '')]),
  ];
  return candidates.find((candidate) => path.isAbsolute(candidate)) || '';
}

/** Four bounded probes keep one supervised worker's git fingerprint near 3s total. */
function runProgressGit(args, cwd) {
  try {
    const r = spawnSync(GIT_BIN, args, {
      cwd, encoding: 'utf8', timeout: 750, maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error || r.status === null || r.status === undefined) return null;
    return { status: r.status, stdout: r.stdout || '' };
  } catch {
    return null;
  }
}

/** Every stable join key for a worktree id/path. Real Orca ids are `<repoId>::<abs path>`;
 * the suffix keeps the reminder compatible with older rows that expose only the path. */
function worktreeKeys(worktreeId, worktreePath) {
  const keys = new Set();
  if (typeof worktreeId === 'string' && worktreeId) {
    keys.add(worktreeId);
    const split = worktreeId.indexOf('::');
    if (split >= 0 && worktreeId.slice(split + 2)) keys.add(worktreeId.slice(split + 2));
  }
  if (typeof worktreePath === 'string' && worktreePath) keys.add(worktreePath);
  return keys;
}

/** Worktree ids/paths owned by this run-scoped worker list. */
function workerWorktreePaths(workerRows) {
  const owned = new Set();
  for (const worker of workerRows || []) {
    for (const id of worker?.worktreeIds || []) {
      for (const key of worktreeKeys(id, '')) owned.add(key);
    }
    for (const candidate of worker?.worktreePaths || []) owned.add(candidate);
  }
  return owned;
}

function loadSessionState() {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, `${SESSION}.json`), 'utf8')); }
  catch { return { workers: {} }; }
}

/**
 * Settle this session's gate-state groups that Orca's worker-list reports released. A
 * worker stopped/released whose release reply was non-ok never settles in the gate's own
 * PostToolUse bookkeeping, so its group stays `live` and keeps holding its Owns: claim
 * forever — the heartbeat already polls the list, so it reconciles what it sees. Runs under
 * the same state-file lock the gate uses, and persists only when something changed.
 */
function settleOrcaReleasedSessionGroups(workerRows) {
  if (!workerRows || !workerRows.length) return;
  const lockDir = path.join(DIR, '.lock');
  const locked = acquireLock(lockDir, {});
  if (!locked) return;
  try {
    const state = loadSessionState();
    // Same rule the gate's ownership-overlap path uses: a group settles only when EVERY
    // worker-list row matching one of its live keys reports released — never on a single
    // released row (a --retry-of / re-dispatched group can carry an old released row while
    // its newer dispatch, sharing the task id, is still live; the list is newest-first and
    // `every()` keeps the live row decisive). No absent leg here: the heartbeat only
    // settles on positive released evidence, never on a row being missing.
    const groups = new Set();
    for (const [key, w] of Object.entries(state.workers || {})) {
      if (w && w.status === 'live') groups.add(WG.groupOf(w, key));
    }
    const changed = GATES.applyOwnershipHolderReconciliation(
      state, workerRows, [...groups], Date.now(), false);
    if (changed) {
      try {
        const file = path.join(DIR, `${SESSION}.json`);
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, file);
      } catch {}
    }
  } finally {
    releaseLock(lockDir);
  }
}

function stateWorkerForRow(row, state) {
  const ids = [row?.dispatchId, row?.taskId, row?.agentTerminalHandle].filter(Boolean);
  for (const id of ids) if (state?.workers?.[id]) return state.workers[id];
  return null;
}

function retainedTerminalHandles(workerRows, state = loadSessionState()) {
  const handles = new Set();
  for (const row of workerRows || []) {
    if (row && row.agentTerminalHandle && stateWorkerForRow(row, state)?.retained) {
      handles.add(row.agentTerminalHandle);
    }
  }
  return handles;
}

/** Add worktrees recorded in this session's worker-start/terminal-create replies and the
 * terminal-list rows for handles this session tracks. */
function sessionWorktreeKeys(workerRows, terminalRows, ownHandles, state = loadSessionState()) {
  const owned = workerWorktreePaths(workerRows);
  for (const worker of Object.values(state.workers || {})) {
    for (const id of worker?.worktreeIds || []) {
      for (const key of worktreeKeys(id, '')) owned.add(key);
    }
  }
  for (const terminal of terminalRows || []) {
    if (!terminal || !ownHandles.has(terminal.handle)) continue;
    for (const key of worktreeKeys(terminal.worktreeId, terminal.worktreePath)) owned.add(key);
  }
  return owned;
}

/** Terminal handles this session owns: worker-list is run-scoped, while the gate's own
 * session state also records bare `terminal create` replies that have no worker row. */
function sessionTerminalHandles(workerRows, state = loadSessionState()) {
  const panelHandle = process.env.ORCA_TERMINAL_HANDLE || '';
  const handles = new Set((workerRows || [])
    .filter((w) => w && w.workerState !== 'unsupervised')
    .map((w) => w.agentTerminalHandle)
    .filter((handle) => handle && handle !== panelHandle));
  try {
    for (const [id, worker] of Object.entries(state.workers || {})) {
      if (worker && worker.status === 'live' && id !== panelHandle &&
          (worker.kind === 'terminal' || /^term_/.test(id))) handles.add(id);
    }
  } catch {}
  return handles;
}

/**
 * Machine-wide terminal-handle -> agent map from EVERY session's gate state file
 * (~/.claude/orchestrator-gate/<session>.json), so a terminal this session does not own
 * can still be attributed to the agent another session registered for it.
 */
function machineTerminalAgents(stateDir = DIR) {
  const agents = new Map();
  let files = [];
  try { files = fs.readdirSync(stateDir); } catch { return agents; }
  for (const file of files) {
    if (!file.endsWith('.json') || file.startsWith('heartbeat-')) continue;
    let state;
    try { state = JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf8')); } catch { continue; }
    for (const [id, worker] of Object.entries(state && state.workers || {})) {
      if (worker && typeof worker.agent === 'string' && worker.agent &&
          (worker.kind === 'terminal' || /^term_/.test(id))) {
        agents.set(id, worker.agent);
      }
    }
  }
  return agents;
}

/**
 * RT-3 scope guard for terminals OUTSIDE this session's fleet: such a terminal may mark a
 * coder exhausted only when positively identified as that coder's terminal — via another
 * session's worker records or Orca's own `terminal list` agentIdentity. An absent
 * identity is never enough: it could be another session's Codex/Claude pane, the
 * operator panel, or a plain shell. The terminal title is deliberately NOT a signal:
 * Claude Code titles itself after its conversation topic, so a Claude session working
 * on Kimi would false-positive (RT-3 again).
 */
function isNonOwnAgentTerminal({ handle, ownHandles, panelHandle, machineAgents, orcaAgents, agent }) {
  if (!handle || (ownHandles && ownHandles.has(handle)) || handle === panelHandle) return false;
  const recorded = machineAgents && machineAgents.get(handle);
  if (recorded) return recorded === agent;
  return !!(orcaAgents && orcaAgents.get(handle) === agent);
}

function isNonOwnKimiTerminal(ctx) {
  return isNonOwnAgentTerminal({ ...ctx, agent: 'kimi' });
}

/** A worker still consuming machine resources, whatever its task status says. */
function isHoldingResources(w, explicitlyRetained = false) {
  return !!w.terminalState && w.terminalState !== 'released' &&
    !(w.terminalState === 'retained' && explicitlyRetained);
}

/**
 * `orca worktree ps --json`, defensively parsed (Opus review, item M1): a malformed or
 * unexpected reply (a non-array `worktrees`, a `null` entry in it, a field of the wrong
 * type) must never crash this long-running daemon — the whole function degrades to null,
 * exactly like an unreachable Orca, and the caller simply tries again next tick. `--limit`
 * is passed explicitly (item M5) so a normal-sized fleet never gets silently truncated;
 * when the page comes back truncated anyway, `truncated: true` is surfaced so the caller
 * can refuse to trust it for this reminder rather than risk a false or missed transition.
 * The worktree-ps round trip is bounded tighter (8s) than the worker/terminal listing
 * calls (20s default) — it is normally fast, and a short bound leaves more of the liveness
 * margin intact at a short `--interval` (item L1).
 *
 * Item M4: an explicit `ok: false`, or a `result` that never seeded a `worktrees` array at
 * all, is NOT the same fact as "zero worktrees exist" — the former means Orca could not
 * actually answer this call, and treating it as an empty list would let a real backlog go
 * unreported for as long as that condition persists. Both degrade to null, exactly like an
 * unreachable Orca, so the caller retries next tick instead of quietly believing nothing is
 * done-but-open.
 */
function worktrees() {
  try {
    const d = orca(['worktree', 'ps', '--json', '--limit', '500'], 8000);
    if (!d || d.ok === false) return null;
    const r = d.result ?? d;
    const seeded = Array.isArray(r) || Array.isArray(r && r.worktrees);
    if (!seeded) return null;
    const rawList = Array.isArray(r) ? r : r.worktrees;
    const rows = rawList
      .filter((w) => w && typeof w.path === 'string')
      .map((w) => ({
        path: w.path,
        worktreeId: typeof w.worktreeId === 'string' ? w.worktreeId : '',
        displayName: w.displayName || w.path,
        isMainWorktree: !!w.isMainWorktree,
        isArchived: !!w.isArchived,
        // Preserve "missing/non-numeric" as-is (do not coerce to 0 here) — a remove-mode
        // rm must treat that as unknown, never as "0 live terminals" (review, non-blocking
        // item). Known-numeric readings (including a genuine 0) pass through unchanged.
        liveTerminalCount: (w.liveTerminalCount === null || w.liveTerminalCount === undefined ||
          !Number.isFinite(Number(w.liveTerminalCount))) ? w.liveTerminalCount : Number(w.liveTerminalCount),
        // One aggregate timestamp per worktree (not per terminal) — see isWorktreeIdle().
        lastOutputAt: Number(w.lastOutputAt) || 0,
        prState: w.linkedPR ? w.linkedPR.state : null,
        prNumber: w.linkedPR ? w.linkedPR.number : null,
        mrState: w.linkedGitLabMR ? w.linkedGitLabMR.state : null,
        mrNumber: w.linkedGitLabMR ? w.linkedGitLabMR.number : null,
      }));
    return { truncated: !!(r && r.truncated), rows };
  } catch {
    return null;
  }
}

/**
 * Run `git <args>` in `cwd`, bounded to a short timeout, never throwing. Returns
 * `{ status, stdout }` — `status` is git's real exit code (0 success; `merge-base
 * --is-ancestor` uses 1 for a clean, confirmed "no", which callers must not confuse with
 * failure) — or null on a spawn-level problem (missing binary, timeout, signal). Every
 * caller treats null exactly like an unreadable answer: never a candidate for a git-backed
 * check, per the "never remind on uncertainty" rule.
 */
function runGit(args, cwd) {
  try {
    const r = spawnSync(GIT_BIN, args, { cwd, encoding: 'utf8', timeout: 3000 });
    if (r.error || r.status === null || r.status === undefined) return null;
    return { status: r.status, stdout: (r.stdout || '').trim() };
  } catch {
    return null;
  }
}

/**
 * The worktree's upstream default branch (e.g. "origin/main"), resolved from
 * `refs/remotes/origin/HEAD`, falling back to `origin/main` then `main`. Never runs
 * `git fetch` — a stale remote-tracking ref is the operator's problem to keep current, not
 * this reminder's to fix. Returns null when nothing resolves.
 */
function resolveBaseRef(cwd, git) {
  const sym = git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (sym && sym.status === 0 && sym.stdout) return sym.stdout;
  const originMain = git(['rev-parse', '--verify', '-q', 'origin/main'], cwd);
  if (originMain && originMain.status === 0) return 'origin/main';
  const main = git(['rev-parse', '--verify', '-q', 'main'], cwd);
  if (main && main.status === 0) return 'main';
  return null;
}

/**
 * True only when git affirmatively confirms HEAD is already an ancestor of `base` (exit
 * 0). Exit 1 (a real, clean "not yet merged") and any spawn-level failure both return
 * false here — this function never distinguishes "confirmed not merged" from "could not
 * tell", since neither is ever a done-but-open candidate.
 */
function isAncestorOf(cwd, git, base) {
  const r = git(['merge-base', '--is-ancestor', 'HEAD', base], cwd);
  return !!r && r.status === 0;
}

/**
 * H1: the worktree's own creation-time proxy — the mtime of its `.git` file. A linked
 * worktree's `.git` is a small text file naming its real gitdir under the main repo's
 * `.git/worktrees/<name>/`, written once by `git worktree add` and never touched again in
 * ordinary use, so its mtime is a reliable "this worktree was created at roughly T" signal
 * without needing Orca to report a creation timestamp at all. Returns null on any stat
 * failure (unreadable path, `.git` missing entirely) — never a candidate for a "produced new
 * work" verdict; uncertain is never a pass, same rule as every other leg here.
 */
function statMtimeMs(dirPath) {
  try {
    const st = fs.statSync(path.join(dirPath, '.git'));
    return Number.isFinite(st.mtimeMs) ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

/** HEAD's own commit time (`%ct`, committer date, seconds since epoch), in ms. Null on any
 * git failure — same uncertainty rule as everywhere else in this file. */
function headCommitTimeMs(cwd, git) {
  const r = git(['log', '-1', '--format=%ct', 'HEAD'], cwd);
  if (!r || r.status !== 0 || !r.stdout) return null;
  const sec = Number(String(r.stdout).trim());
  return Number.isFinite(sec) ? sec * 1000 : null;
}

/**
 * H1: a worktree freshly branched off its base and never given a new commit is trivially
 * "HEAD is an ancestor of base" (HEAD literally IS a commit already on base) AND trivially
 * "clean" — the no-linked-PR/MR acceptance path must not mistake that for done-but-open work.
 * This holds only when HEAD's own commit postdates the worktree's creation (`statMtimeMs`): a
 * commit that already existed on `base` before the worktree was created necessarily predates
 * it, so requiring the reverse means the worktree's branch actually advanced past what it
 * started from. Either signal being unreadable is never a pass.
 */
function hasProducedMergedWork(w, git, stat) {
  const created = stat(w.path);
  if (created == null) return false;
  const headTime = headCommitTimeMs(w.path, git);
  return headTime != null && headTime > created;
}

/**
 * Whether this worktree itself ever recorded a commit action, straight from its reflog —
 * `git reflog show
 * --format=%gs HEAD` (HEAD, not a hardcoded branch name: from `w.path`, Git resolves the
 * per-worktree HEAD reflog for that linked worktree) lists one line per ref-log entry; any
 * subject starting with "commit" (`commit: ...`, `commit (initial): ...`, `commit (amend): ...`, `commit (merge):
 * ...`) is a real commit action taken in this worktree.
 *
 * `hasProducedMergedWork` above (the `.git`-marker-mtime vs HEAD-commit-time heuristic) has a
 * false positive: a worktree with zero commits of its own, rebased or fast-forwarded onto a
 * base that itself advanced AFTER the worktree was created, ends up with a HEAD commit time
 * that postdates the worktree's own creation — exactly the signal `hasProducedMergedWork`
 * reads as "this worktree produced work" — even though that worktree never recorded a
 * commit action. This reflog check answers the actual question directly instead of
 * inferring it from timestamps, so it is required IN ADDITION TO (not instead of)
 * `hasProducedMergedWork` below: a real commit made in the worktree satisfies both signals, a
 * rebase/fast-forward with no own commits satisfies only the (now insufficient) old one. Same
 * uncertainty rule as everywhere else in this file: a git failure, or an empty reflog, is
 * never a pass.
 */
function hasOwnCommit(w, git) {
  const r = git(['reflog', 'show', '--format=%gs', 'HEAD'], w.path);
  if (!r || r.status !== 0 || !r.stdout) return false;
  return r.stdout.split('\n').some((line) => /^commit\b/.test(line.trim()));
}

/**
 * The "accepted" leg of done-but-open: a merged/closed linked GitHub PR or GitLab MR, or —
 * only when NEITHER is linked at all — HEAD already contained in the worktree's own
 * upstream default branch AND that worktree actually produced a new, now-merged commit
 * (`hasProducedMergedWork` AND `hasOwnCommit`, item H1 — otherwise a freshly-created,
 * never-touched worktree, or one merely rebased/fast-forwarded onto a moved base without ever
 * gaining a commit of its own, would both qualify too). A still-open PR/MR is never accepted,
 * whatever git alone might say about the branch. Git is consulted ONLY in the no-linked-PR/MR
 * case: the cheap, Orca-reported PR/MR state always decides first when one exists, so a real
 * git call never runs for the (common) linked-PR case's acceptance leg — a PR/MR's own
 * merged/closed state is already external evidence real work happened, so H1's extra checks do
 * not apply there. Returns `{ accepted, reason }` so a caller can name which path fired.
 */
function resolveAcceptance(w, git, stat) {
  if (w.prState != null) {
    return DONE_PR_STATES.has(w.prState)
      ? { accepted: true, reason: `PR #${w.prNumber != null ? w.prNumber : '?'} ${w.prState}` }
      : { accepted: false, reason: null };
  }
  if (w.mrState != null) {
    if (OPEN_MR_STATES.has(w.mrState)) return { accepted: false, reason: null };
    return DONE_PR_STATES.has(w.mrState)
      ? { accepted: true, reason: `MR #${w.mrNumber != null ? w.mrNumber : '?'} ${w.mrState}` }
      : { accepted: false, reason: null };
  }
  const base = resolveBaseRef(w.path, git);
  if (!base || !isAncestorOf(w.path, git, base)) return { accepted: false, reason: null };
  if (!hasProducedMergedWork(w, git, stat)) return { accepted: false, reason: null };
  if (!hasOwnCommit(w, git)) return { accepted: false, reason: null };
  return { accepted: true, reason: `no linked PR, HEAD already merged into ${base}` };
}

/**
 * The "idle" leg: no live terminal at all, or — `orca worktree ps` exposes one aggregate
 * `lastOutputAt` per worktree, not per terminal, so this is necessarily best-effort — that
 * aggregate (the MOST RECENT output across every terminal on it) is already older than the
 * idle threshold, which can only be true once every terminal on the worktree is quiet.
 * A worktree with live terminals but no usable timestamp is never treated as idle: absence
 * of the field is uncertainty, not evidence.
 */
function isWorktreeIdle(w, now, idleSeconds) {
  if (w.liveTerminalCount === 0) return true;
  if (!w.lastOutputAt) return false;
  return Math.round((now - w.lastOutputAt) / 1000) >= idleSeconds;
}

/**
 * The "clean" leg: no uncommitted changes, and no commits this worktree's branch holds
 * that its upstream does not (or, lacking an upstream entirely, that the resolved base
 * branch does not). Any git failure along the way (unreadable repo, a timeout) means "not
 * confirmed clean", never "clean" — same uncertainty rule as everywhere else here.
 */
function isWorktreeClean(w, git) {
  // `--no-optional-locks`: a plain status read must never contend with, or be blocked by,
  // another concurrent git process's lock on this worktree's index — this daemon polls
  // repeatedly and runs alongside the user's own git/IDE activity.
  const status = git(['--no-optional-locks', 'status', '--porcelain'], w.path);
  if (!status || status.status !== 0 || status.stdout !== '') return false;
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], w.path);
  if (upstream && upstream.status === 0 && upstream.stdout) {
    const unpushed = git(['rev-list', '@{u}..HEAD'], w.path);
    return !!unpushed && unpushed.status === 0 && unpushed.stdout === '';
  }
  const base = resolveBaseRef(w.path, git);
  return !!base && isAncestorOf(w.path, git, base);
}

/**
 * "Retained for reuse AFTER the done state" — the only retain that blocks auto-close.
 * Orca's own `resource.retainedReason` distinguishes the cases (review, blocker 4 and
 * its 2026-10-01 re-review):
 *   - 'identity_unproven': Orca's AUTOMATIC retain on a readiness timeout — not an
 *     operator decision, eligible for auto-close;
 *   - no reason at all (older Orca), and no session-recorded retain flag either: nothing
 *     is held, eligible for auto-close;
 *   - 'user_requested': ambiguous by itself — the standard Kimi readiness-recovery recipe
 *     (`orca terminal send` + `worker-retain`, see orchestration-contract.md's "Codex rate
 *     limits" / Orca-recovery guidance) runs `worker-retain` on a worker that has not
 *     finished yet, and Orca records that same 'user_requested' reason for it as it would
 *     for a deliberate "keep this finished worker open" operator decision. The two are told
 *     apart by WHEN the retain ran relative to WHEN the worker went done, using this
 *     session's own gate state (`worker.retainedAt`, written by orchestrator-gate.cjs on
 *     `worker-retain`) against the heartbeat's own first-seen-done timestamp (`ctx.doneAt`):
 *     a retain that ran strictly before the done transition (`retainedAt < doneAt`) is the
 *     recovery recipe and stays eligible; no gate record at all, or one that ran at/after
 *     done, fails CLOSED (an operator decision to keep a finished worker around on purpose
 *     blocks auto-close, same as 'user_takeover');
 *   - anything else — 'user_takeover', any other current or future reason string — fails
 *     CLOSED: the operator may have taken the terminal over, so it blocks auto-close
 *     (review, blocker 2: a live 'user_takeover' row was being released and closed).
 * Independently, `w.ownershipState === 'user_owned'` always blocks auto-close, whatever
 * retainedReason says.
 */
function isRetainedForReuse(w, ctx = {}) {
  if (w && w.ownershipState === 'user_owned') return true;
  const reason = ctx.retainedReason !== undefined ? ctx.retainedReason : (w.retainedReason ?? null);
  const held = w.terminalState === 'retained' || !!ctx.retained || reason != null;
  if (!held) return false;
  if (reason === 'identity_unproven') return false;
  if (reason == null) return !!ctx.retained;
  if (reason === 'user_requested') {
    const retainedAt = ctx.retainedAt;
    const doneAt = ctx.doneAt;
    if (Number.isFinite(retainedAt) && Number.isFinite(doneAt) && retainedAt < doneAt) {
      return false; // recovery retain before completion — eligible for auto-close.
    }
    return true; // no session record, or retained at/after done — blocked.
  }
  // Any other non-null reason ('user_takeover', and unknown future values) fails closed:
  // blocked.
  return true;
}

/**
 * Auto-close for one done worker row (binding operator decision, 2026-10-01): a worker
 * Orca reports successfully done (`workerState`/`dispatchStatus` succeeded/completed) that
 * still holds its terminal does not need a panel decision when its work is provably saved —
 * the daemon releases the dispatch and closes the agent terminal itself, keeping the
 * worktree. Decision inputs are injectable (`git`, `runOrca`, timestamps) so this is
 * testable without a live Orca or repo. Returns null (leave the row entirely alone) for:
 *   - anything not done, or explicitly failed/stopped (a contradictory row such as
 *     workerState 'failed' with dispatchStatus 'completed' never auto-closes);
 *   - a worker retained for reuse after its done state (see isRetainedForReuse);
 *   - the panel's own terminal (ORCA_TERMINAL_HANDLE — defence in depth, same guard as
 *     sessionTerminalHandles);
 *   - a worker not holding a terminal;
 *   - a worker whose agent terminal produced output within the last idleSeconds — the
 *     agent may still be mid-turn (worker-done races the terminal), so closing waits for
 *     a quiet terminal.
 * Returns {kind: 'unknown'} when the worktree path cannot be resolved — real worker-list
 * rows carry only `resource.worktreeId` / `projection.workspace.id` in the form
 * `<repoId>::<abs path>`, resolved here exactly the way terminalWorktreePath does — so
 * the caller can fall back to the old retain-or-release event instead of going silent.
 * Returns {kind: 'failed'} when the release call itself failed (orca answered ok:false or
 * could not answer at all); the caller persists that with a timestamp so the retry is
 * bounded, and nothing is ever logged as a success that did not happen.
 */
function autoCloseDoneWorker(w, ctx = {}) {
  if (!w || w.workerState === 'unsupervised' || !w.dispatchId) return null;
  if (isFailedWorker(w)) return null;
  const done = DONE_WORKER_STATES.has(w.workerState) || DONE_WORKER_STATES.has(w.dispatchStatus);
  if (!done) return null;
  if (isRetainedForReuse(w, ctx)) return null;
  const panelHandle = ctx.panelHandle !== undefined ? ctx.panelHandle : (process.env.ORCA_TERMINAL_HANDLE || '');
  if (panelHandle && w.agentTerminalHandle === panelHandle) return null;
  if (!isHoldingResources(w, false)) return null;
  if (ctx.lastOutputAt != null) {
    const now = ctx.now != null ? ctx.now : Date.now();
    const idleSeconds = ctx.idleSeconds != null ? ctx.idleSeconds : IDLE_SECONDS;
    if (Math.round((now - ctx.lastOutputAt) / 1000) < idleSeconds) return null;
  }
  const candidates = [
    ...(w.worktreePaths || []),
    ...(w.worktreeIds || []).flatMap((id) => [...worktreeKeys(id, '')]),
  ];
  const worktreePath = ctx.worktreePath ||
    candidates.find((candidate) => path.isAbsolute(candidate)) || '';
  if (!worktreePath) return { kind: 'unknown' };
  const git = ctx.git || runGit;
  if (!isWorktreeClean({ path: worktreePath }, git)) {
    return {
      kind: 'unsaved',
      line: `WORKER DONE BUT UNSAVED ${w.dispatchId} — its worktree has uncommitted or ` +
        'unpushed work; commit and push it (or discard it), then release. Terminal kept open.',
    };
  }
  const runOrca = ctx.runOrca || orca;
  const releaseCmd = ['orchestration', 'worker-release', '--dispatch', w.dispatchId, '--json'];
  const release = runOrca(releaseCmd);
  if (!release || release.ok === false) {
    return {
      kind: 'failed',
      line: `AUTO-CLOSE FAILED ${w.dispatchId}: \`orca ${releaseCmd.join(' ')}\` did not succeed — ` +
        'the daemon will retry; release it manually if this repeats.',
    };
  }
  // A close failure after a successful release is tolerated: worker-release may have
  // closed the agent terminal itself, in which case the close fails harmlessly.
  if (w.agentTerminalHandle) runOrca(['terminal', 'close', '--terminal', w.agentTerminalHandle, '--json']);
  return { kind: 'closed', line: `WORKER CLOSED ${w.dispatchId} (done, terminal closed, worktree kept)` };
}

/**
 * What to do with one worktree that just evaluated done-but-open, per the
 * closeDoneWorktrees mode: 'remove' runs `orca worktree rm --worktree path:<path>` itself
 * (the row already passed every never-remove guard in evaluateDoneButOpen: never an open
 * PR/MR, never dirty or unpushed, never the main worktree, never another session's — the
 * caller only feeds it session-owned rows) and returns the informational WORKTREE REMOVED
 * line; 'remind' returns the panel-facing wake event with the exact, quoted rm command and
 * never runs it. Remove mode is strictly "holds no live terminal": a live-but-quiet
 * terminal (an approval prompt, a shell the operator left open) falls back to the remind
 * event — evaluateDoneButOpen's idle leg alone is not enough for an irreversible rm
 * (review, blocker 5). A failed rm returns {kind: 'rm_failed'} so the caller can bound
 * the retry instead of recording a removal that never happened. Injectable
 * `runOrca`/`mode` keep it testable; the real rm runs with a longer timeout than the
 * default 20s polling calls, since a large worktree can legitimately take longer.
 */
function actOnDoneWorktree(w, reason, ctx = {}) {
  const mode = ctx.mode || CLOSE_DONE_WORKTREES_MODE;
  const liveTerminalCountKnown = w.liveTerminalCount !== null && w.liveTerminalCount !== undefined &&
    Number.isFinite(Number(w.liveTerminalCount));
  if (mode === 'remove' && liveTerminalCountKnown && Number(w.liveTerminalCount) === 0) {
    const runOrca = ctx.runOrca || ((args) => orca(args, 60000));
    const reply = runOrca(['worktree', 'rm', '--worktree', `path:${w.path}`, '--json']);
    if (reply && reply.ok !== false) {
      return {
        kind: 'removed',
        line: `WORKTREE REMOVED ${sanitizeText(w.displayName)} (${reason}) — ${sanitizeText(w.path)}`,
      };
    }
    return {
      kind: 'rm_failed',
      line: `WORKTREE RM FAILED ${sanitizeText(w.path)} — removal did not succeed; ` +
        'the daemon will retry, or close it manually.',
      remind: formatDoneWorktreeEvent(w, reason),
    };
  }
  return { kind: 'remind', line: formatDoneWorktreeEvent(w, reason) };
}

/** Routes one done-but-open verdict: an informational line on success in remove mode, a
 * wake event otherwise (remind mode, live-terminal fallback, or a failed rm — the failure
 * line first, then the remind line, and only on the first attempt: a bounded retry that
 * fails again just refreshes its timestamp). `rmFailed` maps path -> last failure ms. */
function emitDoneWorktree(w, reason, events, rmFailed, isRetry = false) {
  const act = actOnDoneWorktree(w, reason);
  if (act.kind === 'removed') {
    if (rmFailed && rmFailed.delete(w.path)) savePersistedTimestampMap(RM_FAILED_FILE, rmFailed);
    logInfoLine(act.line);
    return;
  }
  if (act.kind === 'rm_failed') {
    if (rmFailed) {
      rmFailed.set(w.path, Date.now());
      savePersistedTimestampMap(RM_FAILED_FILE, rmFailed);
    }
    if (isRetry) return;
    events.push(act.line);
    events.push(act.remind);
    return;
  }
  if (!isRetry) events.push(act.line);
}

/**
 * The full done-but-open verdict for one worktree, pure so it is directly testable against
 * synthetic rows and an injectable `git` runner without a live Orca or a real repo. Never
 * the main worktree or an already-archived one. Checked cheapest-first: idle (Orca data
 * only) before accepted/clean (which may shell out to git) — git only ever runs for a row
 * that already passed the idle gate, and each call is independently bounded (~3s, see
 * runGit) so one unreachable or slow worktree can never stall a whole tick.
 * `ctx = { now, idleSeconds, git }`, all optional (defaulting to the daemon's own
 * settings and the real `git` binary). Returns `{ done, reason }` — `reason` names which
 * acceptance path fired, for the wake-event message.
 */
function evaluateDoneButOpen(w, ctx = {}) {
  if (w.isMainWorktree || w.isArchived) return { done: false, reason: null };
  const now = ctx.now != null ? ctx.now : Date.now();
  const idleSeconds = ctx.idleSeconds != null ? ctx.idleSeconds : IDLE_SECONDS;
  const git = ctx.git || runGit;
  const stat = ctx.stat || statMtimeMs;
  if (!isWorktreeIdle(w, now, idleSeconds)) return { done: false, reason: null };
  const { accepted, reason } = resolveAcceptance(w, git, stat);
  if (!accepted) return { done: false, reason: null };
  if (!isWorktreeClean(w, git)) return { done: false, reason: null };
  return { done: true, reason };
}

/** Boolean convenience wrapper over evaluateDoneButOpen(), for callers that only need the
 * yes/no verdict (most unit tests, and any future direct filter use). */
function isDoneButOpen(w, ctx) {
  return evaluateDoneButOpen(w, ctx).done;
}

/** Strips ASCII control characters (a literal newline or other control char in an
 * Orca-reported displayName/path could corrupt this single-line message or mislead whoever
 * reads it) from free-text Orca-reported fields before they go into a printed line. */
function sanitizeText(str) {
  // eslint-disable-next-line no-control-regex
  return String(str).replace(/[\x00-\x1f\x7f]/g, '');
}

/** POSIX-safe single-quoting: wraps `str` (already control-char-stripped) in `'...'`,
 * escaping any embedded `'` the standard `'\''` way, so a path containing a space, `"`, `$`
 * or backtick is still exactly one shell argument if the suggested command is pasted
 * verbatim (item L2/L7 — the old double-quoted form did not protect against any of those). */
function shellSingleQuote(str) {
  return `'${sanitizeText(str).replace(/'/g, `'\\''`)}'`;
}

/** The wake-event line for one worktree that just became done-but-open. The `rm` target's
 * `path:` value is single-quoted (items L2/L3/L7). Names which idle leg actually fired
 * (item L1) instead of always claiming "no live terminal" — a worktree can also go idle with
 * a live-but-quiet terminal (see `isWorktreeIdle`), and the earlier wording was misleading
 * whenever that was the real reason. */
function formatDoneWorktreeEvent(w, reason) {
  const idleDetail = w.liveTerminalCount > 0 ? 'quiet terminal(s)' : 'no live terminal';
  return `DONE worktree ${sanitizeText(w.displayName)} (${reason}, ${idleDetail}) — verify it is clean, then close: ` +
    `orca worktree rm --worktree ${shellSingleQuote(`path:${w.path}`)}`;
}

/** The one-time, non-waking startup line listing backlog already done-but-open at baseline.
 * Includes each worktree's path, not just its display name (item L4), since two worktrees
 * can share a display name. Both fields are control-char-stripped (item L7) before joining
 * this multi-row line. */
function formatDoneWorktreeStartupSummary(list) {
  const names = list.map((w) => `${sanitizeText(w.displayName)} (${sanitizeText(w.path)})`).join(', ');
  return `orca-heartbeat: ${list.length} pre-existing done-but-open worktree(s) at startup: ${names} ` +
    '— verify each is clean, then close with `orca worktree rm --worktree "path:<path>"`.';
}

// --- done-but-open worktree reminder: cross-restart, first-successful-read state ---------
//
// `doneWtSeeded` / `doneWtPersisted` / `doneWtFirstSessionRun` are this PROCESS's view of
// the reminder's cross-restart bookkeeping; `reportedDoneWorktrees` is this process's own
// in-memory de-dupe of what IT has already reported (via the seed pass or a later tick).
let doneWtSeeded = false;
let doneWtPersisted = null;
let doneWtFirstSessionRun = false;
const reportedDoneWorktrees = new Set();

function ensureDoneWtPersistedLoaded() {
  if (doneWtPersisted) return;
  const loaded = loadPersistedDoneWorktrees();
  doneWtFirstSessionRun = loaded === null;
  doneWtPersisted = loaded || new Set();
}

/**
 * Processes one successful `worktrees()` read for the done-but-open reminder, appending any
 * wake events to `events`. Does nothing at all when the reminder is disabled, the read
 * itself failed (`data` is null), or the page came back truncated (item M5 — a partial
 * worktree list can neither confirm nor rule out a transition, and acting on it risks a
 * false or a missed wake, either worse than waiting for a later, complete page).
 *
 * The FIRST successful read this process ever sees — whichever tick that turns out to be;
 * a failed `worktree ps` at true startup no longer poisons this (item M4) — seeds rather
 * than reports:
 *   - the session's very first daemon run ever (no persisted file yet, item M3) treats
 *     every currently done-but-open worktree as pre-existing backlog: a one-time, non-
 *     waking summary line, same as before this fix;
 *   - a LATER daemon run within the SAME session (the persisted file already exists) is a
 *     restart, not a fresh session — anything done-but-open that is NOT already in the
 *     persisted set became so while no daemon was watching, and is reported as a genuine
 *     wake event right away, not silently re-absorbed as backlog (item M3's actual bug:
 *     every restart used to re-seed quietly, which could hide a real transition from the
 *     panel indefinitely).
 * After seeding, this same process continues in ordinary steady-state on every later call:
 * anything done-but-open this process has not itself already reported is a wake event.
 */
function processDoneWorktrees(data, events, started, ownedWorktreePaths, rmFailed) {
  if (!CLOSE_DONE_WORKTREES || !data || data.truncated) return;
  try {
    ensureDoneWtPersistedLoaded();
    const now = Date.now();
    // A path this process has already reported can never produce a NEW event again once
    // seeding has happened at least once — skip its (potentially several) git subprocess
    // calls entirely instead of re-running them on every future tick forever. Before the
    // first seed, every row must still be evaluated once to establish the backlog / diff
    // against a persisted restart, so nothing is skipped yet at that point. The one
    // exception: a remove-mode `worktree rm` that FAILED earlier is re-evaluated once its
    // retry cooldown has passed (the failure itself was reported at the time; the retry
    // is silent unless it succeeds).
    const isSeedingPass = !doneWtSeeded;
    const sessionRows = data.rows.filter((w) => w &&
      [...worktreeKeys(w.worktreeId, w.path)].some((key) => ownedWorktreePaths.has(key)));
    const rmRetryDue = (w) => CLOSE_DONE_WORKTREES_MODE === 'remove' && rmFailed &&
      Number.isFinite(rmFailed.get(w.path)) && now - rmFailed.get(w.path) >= MUTATION_RETRY_MS;
    const candidates = isSeedingPass
      ? sessionRows
      : sessionRows.filter((w) => !reportedDoneWorktrees.has(w.path) || rmRetryDue(w));
    // A git-heavy pass (many worktrees left to evaluate) must never run long enough to make
    // the liveness file look stale: cap it to ~GIT_BUDGET_MS total and beat() between rows.
    // Whatever does not fit in the budget is simply retried next tick — evaluateDoneButOpen
    // is pure/idempotent per row, so a partial pass here is a delay, never a correctness bug.
    //
    // The ONE pass that budget cap must never truncate is the seeding pass itself: seeding
    // marks EVERY row it does not evaluate as implicitly "not backlog" (never added to
    // `reportedDoneWorktrees`/`doneWtPersisted` below), so a row skipped here by the budget
    // would fall through to the steady-state branch on some later tick and fire as a brand
    // new wake event for what was actually pre-existing backlog all along. `beat(started)`
    // still runs per row regardless, so liveness stays fresh even on a long first pass.
    const budgetDeadline = Date.now() + GIT_BUDGET_MS;
    const allEvaluated = [];
    for (const w of candidates) {
      allEvaluated.push({ w, verdict: evaluateDoneButOpen(w, { now, idleSeconds: IDLE_SECONDS, git: runGit }) });
      beat(started);
      if (!isSeedingPass && Date.now() >= budgetDeadline) break;
    }
    const evaluated = allEvaluated.filter((e) => e.verdict.done);

    let persistedChanged = false;

    if (!doneWtSeeded) {
      doneWtSeeded = true;
      for (const { w } of evaluated) reportedDoneWorktrees.add(w.path);
      // The persisted file is written on this branch even when `evaluated` is empty: its
      // mere EXISTENCE is what tells a later restart within this same session "seeding
      // already happened once" (loadPersistedDoneWorktrees() returning null vs. an empty
      // Set) — an empty first run must not look, to a later restart, like a session that
      // never got as far as its first successful `worktree ps` read at all.
      persistedChanged = true;
      if (doneWtFirstSessionRun) {
        const backlog = evaluated.map((e) => e.w);
        // Remove mode acts on backlog too (each row already passed every guard); remind
        // mode keeps the one-time, non-waking summary line.
        if (backlog.length && CLOSE_DONE_WORKTREES_MODE !== 'remove') {
          console.log(formatDoneWorktreeStartupSummary(backlog));
        }
        if (CLOSE_DONE_WORKTREES_MODE === 'remove') {
          for (const { w, verdict } of evaluated) emitDoneWorktree(w, verdict.reason, events, rmFailed);
        }
        for (const { w } of evaluated) doneWtPersisted.add(w.path);
      } else {
        const newSincePersisted = evaluated.filter((e) => !doneWtPersisted.has(e.w.path));
        for (const { w } of evaluated) doneWtPersisted.add(w.path);
        for (const { w, verdict } of newSincePersisted) emitDoneWorktree(w, verdict.reason, events, rmFailed);
      }
    } else {
      for (const { w, verdict } of evaluated) {
        const isRmRetry = reportedDoneWorktrees.has(w.path) && rmRetryDue(w);
        if (reportedDoneWorktrees.has(w.path) && !isRmRetry) continue;
        if (!isRmRetry) {
          reportedDoneWorktrees.add(w.path);
          doneWtPersisted.add(w.path);
          persistedChanged = true;
        }
        emitDoneWorktree(w, verdict.reason, events, rmFailed, isRmRetry);
      }
    }
    if (persistedChanged) savePersistedDoneWorktrees(doneWtPersisted);
  } catch {
    // Item M1: a malformed/unexpected worktree row must never crash the daemon — skip
    // this poll entirely and let the next one try again.
  }
}

/**
 * Decide what one terminal means for supervision. Pure, so it can be tested
 * against synthetic input instead of a live Orca.
 *
 * Only a terminal owned by this session can be supervised. Within that set, a terminal
 * counts as supervised when it appeared after the daemon started OR it has produced output
 * since then. The second case is the load-bearing one:
 * the panel normally dispatches work first and starts the daemon second, so the
 * worker's terminal already exists at baseline and would otherwise never be
 * watched - which is precisely the IDLE blindness this daemon exists to fix.
 */
function classifyTerminal(t, ctx) {
  if (!ctx.ownHandles || !ctx.ownHandles.has(t.handle)) return { kind: 'ignored' };
  // Kimi's billing-cycle usage limit is checked before the generic rate-limit backoff: it
  // is terminal for the billing cycle, not a retry-soon condition. Only ever applied to a
  // terminal whose tracked worker agent IS kimi (RT-3: a codex worker quoting the sentence,
  // or prose narrating it, must never mark Kimi exhausted).
  if (ctx.handleAgent && ctx.handleAgent.get(t.handle) === 'kimi' &&
      hasKimiUsageExhausted(t.preview || '')) return { kind: 'usage_exhausted', coder: 'kimi' };
  if (ctx.handleAgent && ctx.handleAgent.get(t.handle) === 'codex' &&
      hasCodexUsageExhausted(t.preview || '')) return { kind: 'usage_exhausted', coder: 'codex' };
  // DeepSeek's 402 "Insufficient Balance" is terminal until the account is topped up —
  // the pay-per-use equivalent of the billing-cycle limits above (same RT-3 scoping).
  if (ctx.handleAgent && ctx.handleAgent.get(t.handle) === 'opencode' &&
      hasDeepseekBalanceExhausted(t.preview || '')) return { kind: 'usage_exhausted', coder: 'deepseek' };
  if (hasRateLimitError(t.preview || '')) return { kind: 'rate_limit' };
  if (hasCodexDisconnect(t.preview || '')) return { kind: 'connection_lost' };
  // A terminal whose tracked agent dropped back to a shell prompt (agent process gone)
  // takes precedence over the approval detector: the scrollback can still SHOW a dialog
  // (e.g. Claude's trust prompt) the worker already died on, and a live dialog never
  // ends at a shell prompt.
  const screenText = ctx.approvalText !== undefined ? ctx.approvalText : (t.preview || '');
  if (ctx.handleAgent && ctx.handleAgent.has(t.handle) && endsAtShellPrompt(screenText)) {
    return { kind: 'exited' };
  }
  const approvalFingerprint = approvalPromptFingerprint(screenText);
  if (approvalFingerprint) return { kind: 'approval_waiting', fingerprint: approvalFingerprint };
  if (t.orphaned) return { kind: 'orphaned' };
  const supervised = (ctx.retainedHandles && ctx.retainedHandles.has(t.handle)) ||
    !ctx.baseHandles.has(t.handle) || t.lastOutputAt > ctx.started;
  if (!supervised || !t.lastOutputAt) return { kind: 'ignored' };
  const quiet = Math.round((ctx.now - t.lastOutputAt) / 1000);
  return quiet >= ctx.idleSeconds ? { kind: 'idle', quiet } : { kind: 'working', quiet };
}

function snapshotWorkers(list) {
  const m = new Map();
  for (const w of list) {
    if (!w || w.workerState === 'unsupervised') continue;
    m.set(w.dispatchId, `${w.workerState}|${w.dispatchStatus}|${w.terminalState}`);
  }
  return m;
}

const TERMINAL_WORKER_STATES = new Set(['succeeded', 'failed', 'stopped', 'cancelled', 'completed']);

function terminalWorkerStates(workerRows) {
  const states = new Map();
  for (const row of workerRows || []) {
    if (row && row.agentTerminalHandle && row.workerState) {
      const previous = states.get(row.agentTerminalHandle);
      if (!TERMINAL_WORKER_STATES.has(previous) || TERMINAL_WORKER_STATES.has(row.workerState)) {
        states.set(row.agentTerminalHandle, row.workerState);
      }
    }
  }
  return states;
}

function stallThresholdForAgent(agent, heartbeatConfig, globalThreshold) {
  return Object.hasOwn(heartbeatConfig.stallSecondsByAgent, agent)
    ? heartbeatConfig.stallSecondsByAgent[agent]
    : globalThreshold;
}

function shouldTrackWorkerProgress(verdictKind, workerState) {
  return ['working', 'idle'].includes(verdictKind) && !TERMINAL_WORKER_STATES.has(workerState);
}

/** Absence-based cleanup is safe only after Orca supplied an authoritative worker list. */
function clearMissingPendingJobsForTick(workerRows, stateDir, session, activeHandles,
  clear = RESUME.clearMissingPendingJobs) {
  if (!Array.isArray(workerRows)) return 0;
  return clear(stateDir, session, activeHandles);
}

function formatStallEvent({ dispatchId, handle, agent, stalledSeconds }) {
  const identity = dispatchId || handle;
  return `WORKER STALLED ${identity} (${agent}, no file change or new output for ` +
    `${Math.floor(stalledSeconds / 60)}m) - nudge it (terminal send "continue ..."), ` +
    'or stop it and re-dispatch the same brief to the other coder';
}

function main() {
  const started = Date.now();
  beat(started);
  process.on('exit', unbeat);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => process.exit(0));
  const baseTerms = terminals();
  const baseWorkers = workers();
  const sessionState = loadSessionState();

  if (baseTerms === null && baseWorkers === null) {
    console.log('orca-heartbeat: Orca is not answering; no supervision is possible.');
    console.log('Check `orca status`. If the runtime is down, declare the fallback:');
    console.log('  touch ~/.claude/orchestrator-gate/orca-unavailable');
    process.exit(0);
  }

  // Baseline: only deviations from this state are worth waking the panel for.
  const baseTermHandles = new Set((baseTerms || []).map((t) => t.handle));
  const baseWorkerState = snapshotWorkers(baseWorkers || []);
  const ownTerminalHandles = sessionTerminalHandles(baseWorkers || [], sessionState);
  const explicitRetainedHandles = retainedTerminalHandles(baseWorkers || [], sessionState);
  const ownedWorktreePaths = sessionWorktreeKeys(baseWorkers || [], baseTerms || [], ownTerminalHandles, sessionState);
  let prevWorkers = new Map(baseWorkerState);
  const reportedIdle = loadPersistedIdleReports();
  const reportedDisconnect = loadPersistedDisconnectReports();
  const reportedUsageExhausted = loadPersistedUsageExhaustedReports();
  const stallProgress = loadPersistedStallProgress();
  const lastScreenText = new Map([...stallProgress]
    .filter(([, record]) => record && typeof record.screenText === 'string')
    .map(([handle, record]) => [handle, record.screenText]));
  const reportedApproval = loadPersistedApprovalReports();
  const reportedExited = loadPersistedExitedReports();
  const autoClosed = loadPersistedAutoClosed();
  const doneAtMap = loadPersistedTimestampMap(DONE_AT_FILE);
  const rmFailed = loadPersistedTimestampMap(RM_FAILED_FILE);
  const handoverRecords = HANDOVER.loadRecords(DIR, SESSION);
  const reportedRateLimit = new Set();
  const reportedOrphans = new Set();
  const baseOrphans = new Set((baseTerms || []).filter((t) => t.orphaned).map((t) => t.handle));
  // Every dispatch id this daemon has ever seen NOT done. A done row first seen done whose
  // gate record shows a retain already set must be treated as retain-AFTER-done (blocks
  // auto-close) — the daemon never saw the worker running, so the retain could not have
  // been the mid-run recovery recipe.
  const isDoneRow = (w) => DONE_WORKER_STATES.has(w && w.workerState) || DONE_WORKER_STATES.has(w && w.dispatchStatus) ||
    isFailedWorker(w);
  const everSeenRunningIds = new Set((baseWorkers || [])
    .filter((w) => w && w.dispatchId && !isDoneRow(w))
    .map((w) => w.dispatchId));

  const deadline = started + MAX_SECONDS * 1000;

  /** Shared exit path for both the startup done-worktree pass and every later tick. */
  const flushAndExit = (events, now) => {
    console.log(`orca-heartbeat: ${events.length} event(s) after ${Math.round((now - started) / 1000)}s.`);
    for (const e of events) console.log(`  - ${e}`);
    console.log('Act on these now — a worker waiting on a decision is wasted wall-clock.');
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.appendFileSync(path.join(DIR, 'heartbeat.log'), `${new Date().toISOString()}\t${events.join(' | ')}\n`);
    } catch {}
    process.exit(0); // exiting is the wake-up signal for the panel
  };

  // Done-but-open worktree reminder: try to seed immediately at startup, so the one-time
  // passive summary (or, on a same-session restart, a real wake event per item M3) shows up
  // right away instead of waiting a full --interval. A failed first attempt is not fatal
  // (item M4): processDoneWorktrees() only marks itself seeded on a SUCCESSFUL read, so
  // tick() below keeps retrying until one comes back.
  if (CLOSE_DONE_WORKTREES) {
    const startupEvents = [];
    processDoneWorktrees(worktrees(), startupEvents, started, ownedWorktreePaths, rmFailed);
    if (startupEvents.length) flushAndExit(startupEvents, Date.now());
  }

  const tick = () => {
    beat(started);
    const events = [];
    const now = Date.now();
    events.push(...RESUME.resumeJobEvents(DIR, SESSION, now, pidAlive));
    RESUME.sweepJobs(DIR, SESSION, now);

    const ws = workers();
    beat(started); // item L1: refresh liveness between round trips at a short --interval
    if (ws) {
      settleOrcaReleasedSessionGroups(ws);
      for (const w of ws) if (w && w.dispatchId && !isDoneRow(w)) everSeenRunningIds.add(w.dispatchId);
      for (const worktreePath of workerWorktreePaths(ws)) ownedWorktreePaths.add(worktreePath);
      for (const handle of sessionTerminalHandles(ws)) ownTerminalHandles.add(handle);
      for (const handle of retainedTerminalHandles(ws)) explicitRetainedHandles.add(handle);
      const cur = snapshotWorkers(ws);
      for (const [id, state] of cur) {
        const before = prevWorkers.get(id);
        if (before === undefined) events.push(`NEW worker ${id} -> ${state}`);
        else if (before !== state) events.push(`worker ${id} changed: ${before} -> ${state}`);
      }
      prevWorkers = cur;
      // Bound the persisted done/auto-close maps: entries for workers Orca no longer lists
      // at all, older than a week, are dead weight from long-gone dispatches.
      const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
      const listedDispatchIds = new Set(ws.map((w) => w && w.dispatchId).filter(Boolean));
      let doneAtPruned = false;
      for (const [id, ts] of doneAtMap) {
        if (!listedDispatchIds.has(id) && now - ts > PRUNE_AGE_MS) { doneAtMap.delete(id); doneAtPruned = true; }
      }
      if (doneAtPruned) savePersistedTimestampMap(DONE_AT_FILE, doneAtMap);
      let autoClosedPruned = false;
      for (const [id, v] of autoClosed) {
        const at = Number.isFinite(v && v.at) ? v.at : 0;
        if (!listedDispatchIds.has(id) && now - at > PRUNE_AGE_MS) { autoClosed.delete(id); autoClosedPruned = true; }
      }
      if (autoClosedPruned) savePersistedAutoClosed(autoClosed);
    }

    if (CLOSE_DONE_WORKTREES) {
      processDoneWorktrees(worktrees(), events, started, ownedWorktreePaths, rmFailed);
      beat(started); // item L1
    }

    const ts = terminals();
    if (ts) {
      // Re-read gate state each tick so a bare terminal created after daemon startup joins
      // this session's set even though it has no worker-list row.
      const tickState = loadSessionState();
      for (const handle of sessionTerminalHandles(ws || [])) ownTerminalHandles.add(handle);
      for (const key of sessionWorktreeKeys(ws || [], ts, ownTerminalHandles)) ownedWorktreePaths.add(key);
      // Which coder each supervised terminal runs — the usage-exhausted signal is only ever
      // attributed to a terminal whose tracked worker agent is kimi (RT-3).
      const handleAgent = new Map();
      const handleDispatch = new Map();
      const handleAliases = new Map();
      const handleWorkerState = terminalWorkerStates(ws || []);
      for (const row of ws || []) {
        if (row && row.agentTerminalHandle) {
          const agent = stateWorkerForRow(row, tickState)?.agent || row.agent;
          if (agent) handleAgent.set(row.agentTerminalHandle, agent);
          if (row.dispatchId) handleDispatch.set(row.agentTerminalHandle, row.dispatchId);
          handleAliases.set(row.agentTerminalHandle,
            [row.agentTerminalHandle, row.dispatchId, row.taskId].filter(Boolean));
        }
      }
      for (const [id, w] of Object.entries(tickState.workers || {})) {
        if (w && w.agent && w.status === 'live' && (w.kind === 'terminal' || /^term_/.test(id))) {
          handleAgent.set(id, w.agent);
        }
      }

      // A successfully-done worker still holding a terminal no longer waits for a panel
      // decision (binding operator decision, 2026-10-01): the daemon releases and closes
      // it itself when the worktree is provably clean and pushed AND the agent terminal
      // has been quiet past idleSeconds (a done agent may still be mid-turn). Dirty or
      // unpushed work wakes the panel once with WORKER DONE BUT UNSAVED; a failed release
      // wakes it once with AUTO-CLOSE FAILED and is retried on a bounded cooldown; a
      // worker whose worktree path cannot be resolved at all falls back to the old
      // retain-or-release event below rather than going silent. Terminal quiet comes from
      // the terminal list (ts), which is why this loop lives here and not in the ws block.
      const terminalLastOutput = new Map(ts.map((t) => [t.handle, t.lastOutputAt]));
      const autoCloseUnknown = [];
      for (const w of ws || []) {
        if (w.workerState === 'unsupervised' || !w.dispatchId) continue;
        if (isFailedWorker(w)) continue;
        if (!DONE_WORKER_STATES.has(w.workerState) && !DONE_WORKER_STATES.has(w.dispatchStatus)) continue;
        const previous = autoClosed.get(w.dispatchId);
        if (previous && previous.state === 'closed') continue;
        if (previous && previous.state === 'failed' && now - previous.at < MUTATION_RETRY_MS) continue;
        const gateWorker = stateWorkerForRow(w, tickState);
        if (!doneAtMap.has(w.dispatchId)) {
          // Prefer Orca's own completion time over this daemon's first-seen-done time. When
          // Orca carries none and the gate record shows a retain already set even though
          // this daemon never saw the worker RUNNING, treat it as retain-after-done: stamp
          // doneAt at the retain itself so `retainedAt < doneAt` is false and auto-close
          // stays blocked (the retain could not have been the mid-run recovery recipe).
          let doneAt = Number.isFinite(w.completedAt) ? w.completedAt : now;
          if (!Number.isFinite(w.completedAt) && Number.isFinite(gateWorker?.retainedAt) &&
              !everSeenRunningIds.has(w.dispatchId)) {
            doneAt = gateWorker.retainedAt;
          }
          doneAtMap.set(w.dispatchId, doneAt);
          savePersistedTimestampMap(DONE_AT_FILE, doneAtMap);
        }
        const result = autoCloseDoneWorker(w, {
          retained: !!gateWorker?.retained,
          retainedAt: Number.isFinite(gateWorker?.retainedAt) ? gateWorker.retainedAt : null,
          doneAt: doneAtMap.get(w.dispatchId),
          lastOutputAt: terminalLastOutput.has(w.agentTerminalHandle)
            ? terminalLastOutput.get(w.agentTerminalHandle) : null,
          idleSeconds: IDLE_SECONDS, now,
        });
        if (!result) continue;
        // A done worker whose worktree path cannot be resolved at all falls back to the
        // old retain-or-release event (below) rather than the auto-close path — but that
        // fallback is itself a done-and-holding row with no state transition to key off
        // (it is "done" from the very first read), so it needs its own once-per-episode
        // transition tracking here, same shape as unsaved/failed.
        if (result.kind === 'unknown') {
          autoCloseUnknown.push(w);
          if (!previous || previous.state !== 'unknown') {
            autoClosed.set(w.dispatchId, { state: 'unknown', at: now });
            savePersistedAutoClosed(autoClosed);
          }
          continue;
        }
        autoClosed.set(w.dispatchId, { state: result.kind, at: now });
        savePersistedAutoClosed(autoClosed);
        if (result.kind === 'closed') logInfoLine(result.line);
        // Unsaved/failed wake events fire only on the TRANSITION into that state —
        // re-evaluation continues (a clean worktree still closes later), but the panel
        // is never re-woken for a state it was already told about.
        else if (!previous || previous.state !== result.kind) events.push(result.line);
      }

      // Work that finished but still owns a terminal is exactly the resource
      // leak the contract exists to prevent. Failed/stopped/cancelled rows only fire when
      // something CHANGED this tick — the backlog from earlier sessions is not this run's
      // event. A done worker whose worktree path is unresolvable (uncertainty) instead
      // fires once, on the transition tracked by `autoClosed` above, since it is
      // definitionally already "done" on the very first read and has no base state to
      // diff against.
      const autoCloseUnknownNew = autoCloseUnknown.filter((w) => {
        const previous = autoClosed.get(w.dispatchId);
        return previous && previous.state === 'unknown' && previous.at === now;
      });
      const changedFailedOrStopped = (ws || []).filter(
        (w) =>
          w.workerState !== 'unsupervised' &&
          isFailedWorker(w) &&
          isHoldingResources(w, !!stateWorkerForRow(w, tickState)?.retained) &&
          baseWorkerState.get(w.dispatchId) !== `${w.workerState}|${w.dispatchStatus}|${w.terminalState}`
      );
      const newDoneHolding = [...changedFailedOrStopped, ...autoCloseUnknownNew];
      if (newDoneHolding.length) {
        events.push(
          `${newDoneHolding.length} finished worker(s) still holding a terminal: ` +
          `${newDoneHolding.map((w) => w.dispatchId).join(', ')} — retain if reusable, else release.`
        );
      }
      const ctx = {
        baseHandles: baseTermHandles, ownHandles: ownTerminalHandles,
        retainedHandles: explicitRetainedHandles, started, now, idleSeconds: IDLE_SECONDS,
        handleAgent,
      };
      const machineAgents = machineTerminalAgents();
      const orcaAgents = new Map(ts.map((t) => [t.handle, t.agentIdentity]));
      const panelHandle = process.env.ORCA_TERMINAL_HANDLE || '';
      let panelLimited = false;
      let panelAvailable = false;
      if (panelHandle) {
        const panelTerminal = ts.find((terminal) => terminal.handle === panelHandle);
        if (panelTerminal) {
          const panelScreen = terminalScreen(panelHandle) || panelTerminal.preview || '';
          beat(started);
          const recentPanelScreen = panelScreen.split(/\r?\n/).slice(-8).join('\n');
          const panelLimit = RESUME.claudeLimitInfo(recentPanelScreen, now);
          panelLimited = panelLimit.limited;
          panelAvailable = !panelLimited;
          if (panelLimited && AUTO_RESUME && cfg.autoResumePanel) {
            const parked = RESUME.park({
              stateDir: DIR, session: SESSION, handle: panelHandle, identity: panelHandle,
              agent: 'claude', resetAt: panelLimit.resetAt, limitLine: panelLimit.line,
              panel: true, panelHandle, now, spawnScheduler: spawnResumeScheduler, pidAlive,
            });
            if (parked.event) events.push(parked.event);
          } else if (!AUTO_RESUME || !cfg.autoResumePanel) {
            RESUME.clearJob(DIR, SESSION, panelHandle);
          } else if (!panelLimited) {
            // Recovery ends a settled episode so a later, separate limit can be parked.
            // Pending jobs remain scheduler-owned even if the live quota recovers early.
            RESUME.clearSettledJob(DIR, SESSION, panelHandle);
          }
        }
      }
      const liveWorkerHandles = new Set((ws || []).filter((worker) => worker &&
        worker.workerState !== 'unsupervised' &&
        !TERMINAL_WORKER_STATES.has(worker.workerState) &&
        !TERMINAL_WORKER_STATES.has(worker.dispatchStatus) && worker.terminalState !== 'released')
        .map((worker) => worker.agentTerminalHandle).filter(Boolean));
      const activeResumeHandles = new Set(ts.filter((terminal) =>
        ownTerminalHandles.has(terminal.handle) &&
        liveWorkerHandles.has(terminal.handle) &&
        ['codex', 'kimi', 'opencode', 'claude'].includes(handleAgent.get(terminal.handle))
      ).map((terminal) => terminal.handle));
      const activeCoderHandles = new Set([...activeResumeHandles]
        .filter((handle) => ['codex', 'kimi', 'opencode'].includes(handleAgent.get(handle))));
      const authorizedResumeHandles = new Set(activeResumeHandles);
      if (panelHandle && ts.some((terminal) => terminal.handle === panelHandle)) {
        authorizedResumeHandles.add(panelHandle);
      }
      clearMissingPendingJobsForTick(ws, DIR, SESSION, authorizedResumeHandles);
      const liveCoderAgents = new Set([...activeCoderHandles].map((handle) => handleAgent.get(handle)));
      const liveQuotas = probeLiveCoderQuotas(liveCoderAgents, now);
      beat(started);
      const cachedQuotas = liveCoderAgents.size ? cachedCoderQuotas(now) : { codex: null, kimi: null, deepseek: null };
      const routingQuotas = {
        codex: liveQuotas.codex || cachedQuotas.codex,
        kimi: liveQuotas.kimi || cachedQuotas.kimi,
        deepseek: liveQuotas.deepseek || cachedQuotas.deepseek,
      };
      const handoverPool = liveCoderAgents.size ? buildHandoverPool(routingQuotas, now) : null;
      let handoverChanged = false;
      for (const handle of [...handoverRecords.keys()]) {
        if (!activeCoderHandles.has(handle)) {
          handoverRecords.delete(handle);
          handoverChanged = true;
        }
      }
      for (const t of ts) {
        const workerState = handleWorkerState.get(t.handle);
        let screenText = t.preview;
        if (ownTerminalHandles.has(t.handle) && !TERMINAL_WORKER_STATES.has(workerState)) {
          const readText = terminalScreen(t.handle);
          beat(started);
          if (readText !== null) {
            lastScreenText.set(t.handle, readText);
          }
          screenText = resolveTerminalScreen(readText, lastScreenText.get(t.handle), t.preview);
        }
        let verdict = classifyTerminal(t, { ...ctx, approvalText: screenText });
        const label = `${t.handle} (${t.title.slice(0, 40)})`;
        // Kimi exhaustion is a machine-wide fact: a Kimi terminal showing the limit marks
        // the coder exhausted even when it is not a tracked worker of this session. But a
        // terminal OUTSIDE this session's fleet only ever marks it when positively
        // identified as Kimi (another session's worker records or Orca's own
        // agentIdentity) — never on an absent identity or a Kimi-mentioning title,
        // which could be another session's Codex/Claude pane, the operator panel, or
        // a plain shell quoting the error (RT-3). The marker is
        // written without a wake event: wake events stay scoped to this session's fleet.
        const terminalAgent = handleAgent.get(t.handle);
        if (verdict.kind !== 'usage_exhausted' && !terminalAgent &&
            hasKimiUsageExhausted(t.preview || '') &&
            isNonOwnKimiTerminal({
              handle: t.handle, ownHandles: ownTerminalHandles,
              panelHandle, machineAgents, orcaAgents,
            })) {
          reportUsageExhausted({
            reported: reportedUsageExhausted, handle: t.handle, label, coder: 'kimi',
            windowHours: kimiUsageLimitHours(t.preview || ''), now, silent: true,
          });
        }
        // Same machine-wide fact, same RT-3 scoping, for DeepSeek's 402 balance signal.
        if (verdict.kind !== 'usage_exhausted' && !terminalAgent &&
            hasDeepseekBalanceExhausted(t.preview || '') &&
            isNonOwnAgentTerminal({
              handle: t.handle, ownHandles: ownTerminalHandles,
              panelHandle, machineAgents, orcaAgents, agent: 'opencode',
            })) {
          reportUsageExhausted({
            reported: reportedUsageExhausted, handle: t.handle, label, coder: 'deepseek',
            windowHours: null, now, silent: true,
          });
        }
        if (verdict.kind === 'usage_exhausted') {
          const event = reportUsageExhausted({
            reported: reportedUsageExhausted, handle: t.handle, label, coder: verdict.coder,
            windowHours: verdict.coder === 'kimi' ? kimiUsageLimitHours(t.preview || '') : null,
          });
          if (event) events.push(event);
        } else if (verdict.kind === 'rate_limit') {
          if (!reportedRateLimit.has(t.handle)) {
            reportedRateLimit.add(t.handle);
            events.push(
              `RATE LIMIT on ${label}: back off, then retry the SAME dispatch with ` +
              '`orca orchestration worker-start --retry-of <dispatchId>`. Do not start a replacement, ' +
              'and reduce how many coder workers run in parallel.'
            );
          }
        } else if (verdict.kind === 'connection_lost') {
          if (!reportedDisconnect.has(t.handle)) {
            reportedDisconnect.add(t.handle);
            savePersistedDisconnectReports(reportedDisconnect);
            events.push(
              `WORKER STUCK on ${label}: Codex session lost its app-server connection - ` +
              'its work since the last commit may be lost; release and re-dispatch'
            );
          }
        } else if (verdict.kind === 'exited') {
          // A finished worker at a shell prompt is normal — only a LIVE worker whose
          // agent process vanished is an event. Report it immediately (no stall grace):
          // the worker is already gone, so waiting buys nothing.
          if (TERMINAL_WORKER_STATES.has(workerState)) {
            if (reportedExited.delete(t.handle)) savePersistedExitedReports(reportedExited);
          } else {
            const event = reportWorkerExited({
              reported: reportedExited, handle: t.handle, lastOutputAt: t.lastOutputAt,
              identity: handleDispatch.get(t.handle) || t.handle,
              agent: handleAgent.get(t.handle) || 'unknown',
            });
            if (event) events.push(event);
          }
        } else if (verdict.kind === 'approval_waiting') {
          if (TERMINAL_WORKER_STATES.has(workerState)) {
            if (reportedApproval.delete(t.handle)) savePersistedApprovalReports(reportedApproval);
            continue;
          }
          const event = reportApprovalWaiting({
            reported: reportedApproval,
            handle: t.handle,
            fingerprint: verdict.fingerprint,
            identity: handleDispatch.get(t.handle) || t.handle,
            agent: handleAgent.get(t.handle) || 'unknown',
          });
          if (event) events.push(event);
        } else if (verdict.kind === 'orphaned') {
          // Orphans already present at startup are backlog, not this run's event: reporting
          // them would make every restarted daemon exit on its first tick, breaking the loop.
          if (!baseOrphans.has(t.handle) && !reportedOrphans.has(t.handle)) {
            reportedOrphans.add(t.handle);
            events.push(`ORPHANED terminal ${label} — close it.`);
          }
        } else if (verdict.kind === 'idle' && reportedIdle.get(t.handle) !== t.lastOutputAt) {
          reportedIdle.set(t.handle, t.lastOutputAt);
          savePersistedIdleReports(reportedIdle);
          events.push(`IDLE ${verdict.quiet}s: ${label} — read it and decide: re-prompt, retry, or release.`);
        }

        if (verdict.kind !== 'approval_waiting' && reportedApproval.delete(t.handle)) {
          savePersistedApprovalReports(reportedApproval);
        }

        const agent = handleAgent.get(t.handle) || 'unknown';
        if (agent === 'claude' && activeResumeHandles.has(t.handle)) {
          const claudeLimit = RESUME.claudeLimitInfo(screenText, now);
          if (claudeLimit.limited && AUTO_RESUME) {
            const parked = RESUME.park({
              stateDir: DIR, session: SESSION, handle: t.handle,
              identity: handleDispatch.get(t.handle) || t.handle, agent,
              resetAt: claudeLimit.resetAt, limitLine: claudeLimit.line, panelHandle,
              authorizedHandles: activeResumeHandles, now,
              spawnScheduler: spawnResumeScheduler, pidAlive,
            });
            if (parked.event) events.push(parked.event);
          } else if (!AUTO_RESUME) {
            RESUME.clearJob(DIR, SESSION, t.handle);
          } else if (!claudeLimit.limited) {
            RESUME.clearSettledJob(DIR, SESSION, t.handle);
          }
        }
        if (activeCoderHandles.has(t.handle)) {
          const quota = liveQuotas[quotaKeyForAgent(agent)];
          const exhausted = verdict.kind === 'usage_exhausted';
          // An unknown/failed probe is absence of evidence, not recovery. Preserve an
          // existing episode until a known below-margin reading or worker completion.
          if (exhausted || typeof quota?.usedPercent === 'number') {
            const threshold = agent === 'kimi' ? kimiHandoffUsed(cfg)
              : agent === 'opencode' ? deepseekHandoffUsed(cfg) : handoffUsed(cfg);
            let target = HANDOVER.pickNextCoder(agent, handoverPool);
            const limited = exhausted || quota.usedPercent >= 100;
            // Sonnet lives inside the panel. If that panel is itself quota-limited, there
            // is no viable handover destination and the resumable worker must be parked.
            target = RESUME.availableHandoverTarget(target, panelAvailable);
            if (RESUME.shouldPark({ limited, handoverTarget: target })) {
              if (handoverRecords.delete(t.handle)) handoverChanged = true;
              if (AUTO_RESUME) {
                const parked = RESUME.park({
                  stateDir: DIR, session: SESSION, handle: t.handle,
                  identity: handleDispatch.get(t.handle) || t.handle, agent,
                  resetAt: RESUME.quotaResetAt(quota), panelHandle, threshold,
                  authorizedHandles: activeCoderHandles, now,
                  spawnScheduler: spawnResumeScheduler, pidAlive,
                });
                if (parked.event) events.push(parked.event);
              } else {
                RESUME.clearJob(DIR, SESSION, t.handle);
              }
            } else if (target) {
              const handover = HANDOVER.observe(handoverRecords, {
                handle: t.handle,
                identity: handleDispatch.get(t.handle) || t.handle,
                agent,
                usedPercent: quota?.usedPercent,
                threshold,
                warnMargin: cfg.handoverWarnMarginPercent,
                exhausted,
                target,
                aliases: handleAliases.get(t.handle) || [t.handle],
                worktreePath: terminalWorktreePath(t, ws || []),
                now,
              });
              // Only a real warning/handover supersedes the scheduler. A below-margin
              // reading can arrive before reset+grace and must not erase a pending job.
              if (handover.record) RESUME.clearJob(DIR, SESSION, t.handle);
              if (handover.changed) handoverChanged = true;
              if (handover.event) events.push(handover.event);
            }
          }
        }

        // Fatal/quota signals above take precedence and are never mislabeled as stalls.
        if (!shouldTrackWorkerProgress(verdict.kind, workerState)) {
          if (!TERMINAL_WORKER_STATES.has(workerState)) continue;
          if (stallProgress.delete(t.handle)) savePersistedStallProgress(stallProgress);
          continue;
        }
        const threshold = stallThresholdForAgent(agent, cfg.heartbeat, STALL_SECONDS);
        const previousProgress = stallProgress.get(t.handle);
        const sample = workerProgressSample({
          terminalText: screenText,
          worktreePath: terminalWorktreePath(t, ws || []),
          git: runProgressGit,
          previousGitParts: previousProgress && previousProgress.gitParts,
        });
        const progress = observeWorkerProgress(stallProgress, {
          handle: t.handle, fingerprint: sample.fingerprint, now, stallSeconds: threshold,
          activeChild: sample.activeChild, gitParts: sample.gitParts, screenText,
        });
        beat(started);
        if (progress.changed || progress.stalled) savePersistedStallProgress(stallProgress);
        if (progress.stalled) {
          events.push(formatStallEvent({
            dispatchId: handleDispatch.get(t.handle), handle: t.handle, agent,
            stalledSeconds: progress.stalledSeconds,
          }));
        }
      }
      if (handoverChanged) HANDOVER.saveRecords(DIR, SESSION, handoverRecords);
      beat(started);
    }

    if (events.length) { flushAndExit(events, now); return; }

    if (Date.now() >= deadline) {
      console.log(`orca-heartbeat: quiet for ${MAX_SECONDS}s, no worker state changed. Stopping.`);
      process.exit(0);
    }
    setTimeout(tick, INTERVAL_SECONDS * 1000);
  };

  setTimeout(tick, INTERVAL_SECONDS * 1000);
}

if (require.main === module) main();

module.exports = {
  classifyTerminal, isHoldingResources, snapshotWorkers, sessionTerminalHandles,
  workerWorktreePaths, worktreeKeys, sessionWorktreeKeys, retainedTerminalHandles,
  isDoneButOpen, evaluateDoneButOpen, formatDoneWorktreeEvent, formatDoneWorktreeStartupSummary,
  resolveAcceptance, isWorktreeIdle, isWorktreeClean, resolveBaseRef, isAncestorOf, runGit,
  statMtimeMs, headCommitTimeMs, hasProducedMergedWork, hasOwnCommit,
  setOnCoderExhausted, reportUsageExhausted, loadPersistedUsageExhaustedReports, savePersistedUsageExhaustedReports,
  machineTerminalAgents, isNonOwnKimiTerminal, isNonOwnAgentTerminal, quotaKeyForAgent, exhaustionUntilMs,
  loadPersistedExitedReports, savePersistedExitedReports, reportWorkerExited,
  terminalWorktreePath, runProgressGit, loadPersistedStallProgress, savePersistedStallProgress,
  formatStallEvent, terminalWorkerStates, stallThresholdForAgent, TERMINAL_WORKER_STATES,
  shouldTrackWorkerProgress,
  clearMissingPendingJobsForTick,
  loadPersistedApprovalReports, savePersistedApprovalReports, reportApprovalWaiting,
  parseTerminalScreen, terminalReadArgs, terminalScreen, resolveTerminalScreen,
  parseWorkerRows,
  probeLiveCoderQuotas, cachedCoderQuotas, buildHandoverPool,
  pidAlive, spawnResumeScheduler,
  DONE_WORKER_STATES, FAILED_WORKER_STATES, isFailedWorker, autoCloseDoneWorker, actOnDoneWorktree, isRetainedForReuse,
  loadPersistedAutoClosed, savePersistedAutoClosed,
  loadPersistedTimestampMap, savePersistedTimestampMap, MUTATION_RETRY_MS,
};
