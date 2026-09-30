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
 * It reports only **changes since the baseline snapshot** taken at startup, so
 * terminals that were already open when it started cannot drown the signal.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  loadConfig, stateDir, closeDoneWorktreesEnabled, stallSeconds, handoffUsed, kimiHandoffUsed,
  codexQuotaCacheSeconds, kimiQuotaCacheSeconds, coderAvailabilityCacheSeconds,
} = require('./lib/config.cjs');
const {
  hasRateLimitError, hasCodexDisconnect, hasKimiUsageExhausted, hasCodexUsageExhausted,
  approvalPromptFingerprint,
} = require('./lib/terminal-signals.cjs');
const {
  workerProgressSample, observeWorkerProgress, recordsFromJSON,
} = require('./lib/worker-progress-fingerprint.cjs');
const QUOTA = require('./lib/exec-route-by-quota.cjs');
const CODER_AVAILABILITY = require('./lib/coder-availability.cjs');
const CODER_POOL = require('./lib/coder-pool-route.cjs');
const HANDOVER = require('./lib/worker-quota-handover.cjs');

const DIR = stateDir();
const ORCA_BIN = process.env.ORCA_BIN || 'orca';
// Overridable the same way ORCA_BIN is (tests point this at a deterministic stub); a bare
// "git" resolves against PATH exactly like the bare "orca" default does.
const GIT_BIN = process.env.ORCH_GIT_BIN || 'git';
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
// Persists which done-but-open worktree paths this SESSION has already reported (via the
// one-time startup summary or a wake event), surviving a daemon restart within the session —
// see processDoneWorktrees()'s doc comment for why this file exists.
const DONE_WT_FILE = path.join(DIR, `heartbeat-${SESSION}-done-wt.json`);

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
    const handles = JSON.parse(fs.readFileSync(USAGE_EXHAUSTED_REPORTED_FILE, 'utf8'));
    return new Set(Array.isArray(handles) ? handles.filter((handle) => typeof handle === 'string') : []);
  } catch {
    return new Set();
  }
}

function savePersistedUsageExhaustedReports(set) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${USAGE_EXHAUSTED_REPORTED_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...set]));
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

// What to do when a coder's output shows it is exhausted for this billing cycle: record an
// exhaustion marker the routing code reads to exclude that coder until reset. The module
// providing it may not exist yet (it lands with the routing lane) — a missing/failing
// marker write degrades to a no-op; the report event itself is still emitted.
let onCoderExhausted = defaultOnCoderExhausted;
function defaultOnCoderExhausted(coder) {
  try {
    const now = Date.now();
    require('./lib/coder-availability.cjs').markCoderExhausted(DIR, coder, {
      now, until: now + 6 * 60 * 60 * 1000,
      reason: 'usage limit reached for this billing cycle (worker output)',
    });
  } catch {}
}

/** Test hook: replace the exhaustion-marker side effect. Pass null to restore the default. */
function setOnCoderExhausted(fn) {
  onCoderExhausted = typeof fn === 'function' ? fn : defaultOnCoderExhausted;
}

/**
 * The once-per-terminal-per-session usage-exhausted report: persists the handle BEFORE
 * emitting so a daemon restart never re-marks or re-reports, calls the (injectable)
 * exhaustion-marker hook, and returns the event text — or null when this handle was
 * already reported. Pure apart from that one persisted set, so tests can drive it
 * directly with a synthetic handle.
 */
function reportUsageExhausted({ reported, handle, label, coder }) {
  if (reported.has(handle)) return null;
  reported.add(handle);
  savePersistedUsageExhaustedReports(reported);
  onCoderExhausted(coder);
  const name = coder === 'codex' ? 'Codex' : 'Kimi';
  const other = coder === 'codex' ? 'Kimi' : 'Codex';
  return `${name.toUpperCase()} USAGE LIMIT on ${label}: ${name} is exhausted - ` +
    `route new code to ${other} (or Sonnet if ${other} is also out); follow the WORKER HANDOVER recipe ` +
    'to commit WIP and HANDOVER.md before stopping/releasing this worker; do not retry it until reset';
}

/** Probe only coders with live supervised workers. The existing quota helpers own the
 * shared cache and single-flight lock, so a fresh gate reading makes this effectively free. */
function probeLiveCoderQuotas(agents, now = Date.now(), deps = {}) {
  const result = { codex: null, kimi: null };
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
  return result;
}

/** Supplement live-worker readings with fresh cache-only data for destination selection.
 * This keeps an idle/exhausted alternative out of the recommendation without probing it. */
function cachedCoderQuotas(now = Date.now(), deps = {}) {
  const codex = (deps.readCodexCache || QUOTA.readFreshCache)(DIR, codexQuotaCacheSeconds(cfg), now);
  const kimi = (deps.readKimiCache || QUOTA.readFreshKimiCache)(DIR, kimiQuotaCacheSeconds(cfg), now);
  return {
    codex: codex && !codex.failed ? codex : null,
    kimi: kimi && !kimi.failed ? kimi : null,
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
    thresholds: { codex: handoffUsed(cfg), kimi: kimiHandoffUsed(cfg) },
    exhaustion: (deps.readCoderExhaustion || CODER_AVAILABILITY.readCoderExhaustion)(DIR, now),
    live: { codex: 0, kimi: 0 }, caps: { codex: 0, kimi: 0 },
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
  const d = orca(['orchestration', 'worker-list', '--json']);
  if (!d) return null;
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
        liveTerminalCount: Number(w.liveTerminalCount) || 0,
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
function processDoneWorktrees(data, events, started, ownedWorktreePaths) {
  if (!CLOSE_DONE_WORKTREES || !data || data.truncated) return;
  try {
    ensureDoneWtPersistedLoaded();
    const now = Date.now();
    // A path this process has already reported can never produce a NEW event again once
    // seeding has happened at least once — skip its (potentially several) git subprocess
    // calls entirely instead of re-running them on every future tick forever. Before the
    // first seed, every row must still be evaluated once to establish the backlog / diff
    // against a persisted restart, so nothing is skipped yet at that point.
    const isSeedingPass = !doneWtSeeded;
    const sessionRows = data.rows.filter((w) => w &&
      [...worktreeKeys(w.worktreeId, w.path)].some((key) => ownedWorktreePaths.has(key)));
    const candidates = isSeedingPass
      ? sessionRows
      : sessionRows.filter((w) => !reportedDoneWorktrees.has(w.path));
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
        if (backlog.length) console.log(formatDoneWorktreeStartupSummary(backlog));
        for (const { w } of evaluated) doneWtPersisted.add(w.path);
      } else {
        const newSincePersisted = evaluated.filter((e) => !doneWtPersisted.has(e.w.path));
        for (const { w } of evaluated) doneWtPersisted.add(w.path);
        for (const { w, verdict } of newSincePersisted) events.push(formatDoneWorktreeEvent(w, verdict.reason));
      }
    } else {
      for (const { w, verdict } of evaluated) {
        if (reportedDoneWorktrees.has(w.path)) continue;
        reportedDoneWorktrees.add(w.path);
        doneWtPersisted.add(w.path);
        persistedChanged = true;
        events.push(formatDoneWorktreeEvent(w, verdict.reason));
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
  if (hasRateLimitError(t.preview || '')) return { kind: 'rate_limit' };
  if (hasCodexDisconnect(t.preview || '')) return { kind: 'connection_lost' };
  const approvalFingerprint = approvalPromptFingerprint(
    ctx.approvalText !== undefined ? ctx.approvalText : (t.preview || '')
  );
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

const TERMINAL_WORKER_STATES = new Set(['succeeded', 'failed', 'stopped', 'completed']);

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
  const handoverRecords = HANDOVER.loadRecords(DIR, SESSION);
  const reportedRateLimit = new Set();
  const reportedOrphans = new Set();
  const baseOrphans = new Set((baseTerms || []).filter((t) => t.orphaned).map((t) => t.handle));

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
    processDoneWorktrees(worktrees(), startupEvents, started, ownedWorktreePaths);
    if (startupEvents.length) flushAndExit(startupEvents, Date.now());
  }

  const tick = () => {
    beat(started);
    const events = [];
    const now = Date.now();

    const ws = workers();
    beat(started); // item L1: refresh liveness between round trips at a short --interval
    if (ws) {
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

      // Work that finished but still owns a terminal is exactly the resource
      // leak the contract exists to prevent. Only flag ones that changed on our
      // watch; the backlog from earlier sessions is not this run's event.
      const newDoneHolding = ws.filter(
        (w) =>
          w.workerState !== 'unsupervised' &&
          ['succeeded', 'failed', 'stopped'].includes(w.workerState) &&
          isHoldingResources(w, !!stateWorkerForRow(w, loadSessionState())?.retained) &&
          baseWorkerState.get(w.dispatchId) !== `${w.workerState}|${w.dispatchStatus}|${w.terminalState}`
      );
      if (newDoneHolding.length) {
        events.push(
          `${newDoneHolding.length} finished worker(s) still holding a terminal: ` +
          `${newDoneHolding.map((w) => w.dispatchId).join(', ')} — retain if reusable, else release.`
        );
      }
    }

    if (CLOSE_DONE_WORKTREES) {
      processDoneWorktrees(worktrees(), events, started, ownedWorktreePaths);
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
      const ctx = {
        baseHandles: baseTermHandles, ownHandles: ownTerminalHandles,
        retainedHandles: explicitRetainedHandles, started, now, idleSeconds: IDLE_SECONDS,
        handleAgent,
      };
      const activeCoderHandles = new Set(ts.filter((terminal) =>
        ownTerminalHandles.has(terminal.handle) &&
        !TERMINAL_WORKER_STATES.has(handleWorkerState.get(terminal.handle)) &&
        ['codex', 'kimi'].includes(handleAgent.get(terminal.handle))
      ).map((terminal) => terminal.handle));
      const liveCoderAgents = new Set([...activeCoderHandles].map((handle) => handleAgent.get(handle)));
      const liveQuotas = probeLiveCoderQuotas(liveCoderAgents, now);
      beat(started);
      const cachedQuotas = liveCoderAgents.size ? cachedCoderQuotas(now) : { codex: null, kimi: null };
      const routingQuotas = {
        codex: liveQuotas.codex || cachedQuotas.codex,
        kimi: liveQuotas.kimi || cachedQuotas.kimi,
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
        const verdict = classifyTerminal(t, { ...ctx, approvalText: screenText });
        const label = `${t.handle} (${t.title.slice(0, 40)})`;
        if (verdict.kind === 'usage_exhausted') {
          const event = reportUsageExhausted({
            reported: reportedUsageExhausted, handle: t.handle, label, coder: verdict.coder,
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
        if (activeCoderHandles.has(t.handle)) {
          const quota = liveQuotas[agent];
          const exhausted = verdict.kind === 'usage_exhausted';
          // An unknown/failed probe is absence of evidence, not recovery. Preserve an
          // existing episode until a known below-margin reading or worker completion.
          if (exhausted || typeof quota?.usedPercent === 'number') {
            const threshold = agent === 'kimi' ? kimiHandoffUsed(cfg) : handoffUsed(cfg);
            const target = HANDOVER.pickNextCoder(agent, handoverPool);
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
            if (handover.changed) handoverChanged = true;
            if (handover.event) events.push(handover.event);
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
  terminalWorktreePath, runProgressGit, loadPersistedStallProgress, savePersistedStallProgress,
  formatStallEvent, terminalWorkerStates, stallThresholdForAgent, TERMINAL_WORKER_STATES,
  shouldTrackWorkerProgress,
  loadPersistedApprovalReports, savePersistedApprovalReports, reportApprovalWaiting,
  parseTerminalScreen, terminalReadArgs, terminalScreen, resolveTerminalScreen,
  probeLiveCoderQuotas, cachedCoderQuotas, buildHandoverPool,
};
