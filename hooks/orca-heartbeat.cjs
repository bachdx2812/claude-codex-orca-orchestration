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
 *
 * It reports only **changes since the baseline snapshot** taken at startup, so
 * terminals that were already open when it started cannot drown the signal.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadConfig, stateDir } = require('./lib/config.cjs');

const DIR = stateDir();
const ORCA_BIN = process.env.ORCA_BIN || 'orca';
const RATE_LIMIT = /(rate.?limit|429\b|quota\s+exceeded|usage\s+limit|too\s+many\s+requests|retry[- ]after|overloaded_error)/i;

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
}

const cfg = loadConfig();
const IDLE_SECONDS = arg('idle', cfg.heartbeat.idleSeconds);        // quiet terminal => needs a decision
const INTERVAL_SECONDS = arg('interval', cfg.heartbeat.intervalSeconds);
const MAX_SECONDS = arg('max', cfg.heartbeat.maxSeconds);           // hard stop so a forgotten daemon dies

// Session whose panel started this daemon (inherited from the Claude Code Bash tool).
const SESSION = String(process.env.CLAUDE_CODE_SESSION_ID || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
const BEAT_FILE = path.join(DIR, `heartbeat-${SESSION}.json`);

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

/** Run an orca command and return parsed JSON, or null when orca cannot answer. */
function orca(args) {
  try {
    const out = execFileSync(ORCA_BIN, args, { encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024 });
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

  const tick = () => {
    beat(started);
    const events = [];
    const now = Date.now();

    const ws = workers();
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

    if (events.length) {
      console.log(`orca-heartbeat: ${events.length} event(s) after ${Math.round((now - started) / 1000)}s.`);
      for (const e of events) console.log(`  - ${e}`);
      console.log('Act on these now — a worker waiting on a decision is wasted wall-clock.');
      try {
        fs.mkdirSync(DIR, { recursive: true });
        fs.appendFileSync(path.join(DIR, 'heartbeat.log'), `${new Date().toISOString()}\t${events.join(' | ')}\n`);
      } catch {}
      process.exit(0); // exiting is the wake-up signal for the panel
    }

    if (Date.now() >= deadline) {
      console.log(`orca-heartbeat: quiet for ${MAX_SECONDS}s, no worker state changed. Stopping.`);
      process.exit(0);
    }
    setTimeout(tick, INTERVAL_SECONDS * 1000);
  };

  setTimeout(tick, INTERVAL_SECONDS * 1000);
}

if (require.main === module) main();

module.exports = { classifyTerminal, isHoldingResources, snapshotWorkers, RATE_LIMIT };
