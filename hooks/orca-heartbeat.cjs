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
const { loadConfig, stateDir, closeDoneWorktreesEnabled } = require('./lib/config.cjs');

const DIR = stateDir();
const ORCA_BIN = process.env.ORCA_BIN || 'orca';
// Overridable the same way ORCA_BIN is (tests point this at a deterministic stub); a bare
// "git" resolves against PATH exactly like the bare "orca" default does.
const GIT_BIN = process.env.ORCH_GIT_BIN || 'git';
const RATE_LIMIT = /(rate.?limit|429\b|quota\s+exceeded|usage\s+limit|too\s+many\s+requests|retry[- ]after|overloaded_error)/i;
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
const CLOSE_DONE_WORKTREES = closeDoneWorktreesEnabled(cfg);

// Session whose panel started this daemon (inherited from the Claude Code Bash tool).
const SESSION = String(process.env.CLAUDE_CODE_SESSION_ID || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
const BEAT_FILE = path.join(DIR, `heartbeat-${SESSION}.json`);
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
  }));
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
  }));
}

/** A worker still consuming machine resources, whatever its task status says. */
function isHoldingResources(w) {
  return w.terminalState && w.terminalState !== 'released';
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
 */
function worktrees() {
  try {
    const d = orca(['worktree', 'ps', '--json', '--limit', '500'], 8000);
    if (!d) return null;
    const r = d.result ?? d;
    const rawList = Array.isArray(r) ? r : (Array.isArray(r && r.worktrees) ? r.worktrees : []);
    const rows = rawList
      .filter((w) => w && typeof w.path === 'string')
      .map((w) => ({
        path: w.path,
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
 * The "accepted" leg of done-but-open: a merged/closed linked GitHub PR or GitLab MR, or —
 * only when NEITHER is linked at all — HEAD already contained in the worktree's own
 * upstream default branch. A still-open PR/MR is never accepted, whatever git alone might
 * say about the branch. Git is consulted ONLY in the no-linked-PR/MR case: the cheap,
 * Orca-reported PR/MR state always decides first when one exists, so a real git call never
 * runs for the (common) linked-PR case's acceptance leg. Returns `{ accepted, reason }` so
 * a caller can name which path fired.
 */
function resolveAcceptance(w, git) {
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
  const status = git(['status', '--porcelain'], w.path);
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
  if (!isWorktreeIdle(w, now, idleSeconds)) return { done: false, reason: null };
  const { accepted, reason } = resolveAcceptance(w, git);
  if (!accepted) return { done: false, reason: null };
  if (!isWorktreeClean(w, git)) return { done: false, reason: null };
  return { done: true, reason };
}

/** Boolean convenience wrapper over evaluateDoneButOpen(), for callers that only need the
 * yes/no verdict (most unit tests, and any future direct filter use). */
function isDoneButOpen(w, ctx) {
  return evaluateDoneButOpen(w, ctx).done;
}

/** The wake-event line for one worktree that just became done-but-open. The `rm` target's
 * `path:` value is quoted (item L3) since a worktree's path can contain spaces. */
function formatDoneWorktreeEvent(w, reason) {
  return `DONE worktree ${w.displayName} (${reason}, no live terminal) — verify it is clean, then close: ` +
    `orca worktree rm --worktree "path:${w.path}"`;
}

/** The one-time, non-waking startup line listing backlog already done-but-open at baseline.
 * Includes each worktree's path, not just its display name (item L4), since two worktrees
 * can share a display name. */
function formatDoneWorktreeStartupSummary(list) {
  const names = list.map((w) => `${w.displayName} (${w.path})`).join(', ');
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
function processDoneWorktrees(data, events) {
  if (!CLOSE_DONE_WORKTREES || !data || data.truncated) return;
  try {
    ensureDoneWtPersistedLoaded();
    const now = Date.now();
    const evaluated = data.rows
      .map((w) => ({ w, verdict: evaluateDoneButOpen(w, { now, idleSeconds: IDLE_SECONDS, git: runGit }) }))
      .filter((e) => e.verdict.done);

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
 * A terminal counts as supervised when it appeared after the daemon started OR
 * it has produced output since then. The second case is the load-bearing one:
 * the panel normally dispatches work first and starts the daemon second, so the
 * worker's terminal already exists at baseline and would otherwise never be
 * watched - which is precisely the IDLE blindness this daemon exists to fix.
 */
function classifyTerminal(t, ctx) {
  if (RATE_LIMIT.test(t.preview || '')) return { kind: 'rate_limit' };
  if (t.orphaned) return { kind: 'orphaned' };
  const supervised = !ctx.baseHandles.has(t.handle) || t.lastOutputAt > ctx.started;
  if (!supervised || !t.lastOutputAt) return { kind: 'ignored' };
  const quiet = Math.round((ctx.now - t.lastOutputAt) / 1000);
  return quiet >= ctx.idleSeconds ? { kind: 'idle', quiet } : { kind: 'working', quiet };
}

function snapshotWorkers(list) {
  const m = new Map();
  for (const w of list) m.set(w.dispatchId, `${w.workerState}|${w.dispatchStatus}|${w.terminalState}`);
  return m;
}

function main() {
  const started = Date.now();
  beat(started);
  process.on('exit', unbeat);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => process.exit(0));
  const baseTerms = terminals();
  const baseWorkers = workers();

  if (baseTerms === null && baseWorkers === null) {
    console.log('orca-heartbeat: Orca is not answering; no supervision is possible.');
    console.log('Check `orca status`. If the runtime is down, declare the fallback:');
    console.log('  touch ~/.claude/orchestrator-gate/orca-unavailable');
    process.exit(0);
  }

  // Baseline: only deviations from this state are worth waking the panel for.
  const baseTermHandles = new Set((baseTerms || []).map((t) => t.handle));
  const baseWorkerState = snapshotWorkers(baseWorkers || []);
  let prevWorkers = new Map(baseWorkerState);
  const reportedIdle = new Set();
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
    processDoneWorktrees(worktrees(), startupEvents);
    if (startupEvents.length) flushAndExit(startupEvents, Date.now());
  }

  const tick = () => {
    beat(started);
    const events = [];
    const now = Date.now();

    const ws = workers();
    beat(started); // item L1: refresh liveness between round trips at a short --interval
    if (ws) {
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
          ['succeeded', 'failed', 'stopped'].includes(w.workerState) &&
          isHoldingResources(w) &&
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
      processDoneWorktrees(worktrees(), events);
      beat(started); // item L1
    }

    const ts = terminals();
    if (ts) {
      const ctx = { baseHandles: baseTermHandles, started, now, idleSeconds: IDLE_SECONDS };
      for (const t of ts) {
        const verdict = classifyTerminal(t, ctx);
        const label = `${t.handle} (${t.title.slice(0, 40)})`;
        if (verdict.kind === 'rate_limit') {
          if (reportedRateLimit.has(t.handle)) continue;
          reportedRateLimit.add(t.handle);
          events.push(
            `RATE LIMIT on ${label}: back off, then retry the SAME dispatch with ` +
            '`orca orchestration worker-start --retry-of <dispatchId>`. Do not start a replacement, ' +
            'and reduce how many Codex workers run in parallel.'
          );
        } else if (verdict.kind === 'orphaned') {
          // Orphans already present at startup are backlog, not this run's event: reporting
          // them would make every restarted daemon exit on its first tick, breaking the loop.
          if (baseOrphans.has(t.handle) || reportedOrphans.has(t.handle)) continue;
          reportedOrphans.add(t.handle);
          events.push(`ORPHANED terminal ${label} — close it.`);
        } else if (verdict.kind === 'idle' && !reportedIdle.has(t.handle)) {
          reportedIdle.add(t.handle);
          events.push(`IDLE ${verdict.quiet}s: ${label} — read it and decide: re-prompt, retry, or release.`);
        }
      }
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
  classifyTerminal, isHoldingResources, snapshotWorkers, RATE_LIMIT,
  isDoneButOpen, evaluateDoneButOpen, formatDoneWorktreeEvent, formatDoneWorktreeStartupSummary,
  resolveAcceptance, isWorktreeIdle, isWorktreeClean, resolveBaseRef, isAncestorOf, runGit,
};
