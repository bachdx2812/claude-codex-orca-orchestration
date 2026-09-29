#!/usr/bin/env node
/**
 * parallel-agent-cap.cjs — the `max-parallel-agents` gate's pure counting and limit-
 * derivation logic: a MACHINE-WIDE budget on live Orca workers (any agent) plus live
 * in-session Agent/Task subagents, on top of the existing per-session Codex cap.
 *
 * The resource being budgeted is this machine's cores, not any one session's own
 * concurrency — so the count sums across every session's state file under the shared
 * `~/.claude/orchestrator-gate/` directory, not just the caller's own `s`. A file older
 * than `MAX_SESSION_AGE_MS` (6h) is treated as an abandoned/stale session and ignored,
 * exactly like every other cross-session assumption in this gate (a file the gate itself
 * can no longer reasonably believe reflects a live session).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const WG = require('./worker-groups.cjs');
const OC = require('./ownership-claims.cjs');

const MAX_SESSION_AGE_MS = 6 * 60 * 60 * 1000;
// A registered in-session Agent/Task dispatch (`s.agents[id]`) auto-expires after this long
// without an explicit release — a fixed safety net, deliberately not the configurable
// `ownershipClaimTtlMinutes` (that field governs a different claim: a code brief's `Owns:`
// file-ownership lock, not "is this dispatch still running at all").
const AGENT_REGISTRY_TTL_MS = 120 * 60 * 1000;

/** This machine's usable core count, read fresh at each check (never cached — a container
 * or VM's CPU allotment can change between calls). `os.availableParallelism()` (Node 19+)
 * is preferred; `os.cpus().length` is the fallback for older runtimes. */
function cores() {
  try {
    if (typeof os.availableParallelism === 'function') {
      const n = os.availableParallelism();
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {}
  const n = os.cpus().length;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * The live parallel-agents limit: an explicit `maxParallelAgents` (from config or
 * `ORCH_MAX_PARALLEL_AGENTS`) wins outright — `0` there means unlimited (`Infinity`);
 * otherwise `max(1, floor(parallelCoreFraction x cores))`, derived fresh every call so a
 * change in the machine's own core count (or the config) takes effect immediately.
 * `cfgHelpers` is `{ maxParallelAgents, parallelCoreFraction }` from lib/config.cjs,
 * injected rather than required here to avoid a require cycle and to keep this module's
 * own exports pure/testable without touching the filesystem for config.
 */
function agentParallelLimit(cfg, cfgHelpers) {
  const explicit = cfgHelpers.maxParallelAgents(cfg);
  if (explicit === 0) return Infinity;
  if (explicit !== null && explicit !== undefined) return explicit;
  const fraction = cfgHelpers.parallelCoreFraction(cfg);
  return Math.max(1, Math.floor(fraction * cores()));
}

/**
 * Session state file paths under `dir` modified within `maxAgeMs` of `nowMs` — every
 * `<sid>.json` file EXCEPT the role cache (`<sid>.role.json`) and the heartbeat liveness /
 * done-worktree files (`heartbeat-*`), which live in the same directory but are never
 * session state. A directory that cannot be listed at all (not yet created) yields no
 * files, never an error.
 */
function recentSessionStateFiles(dir, nowMs = Date.now(), maxAgeMs = MAX_SESSION_AGE_MS) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.role.json') || name.startsWith('heartbeat-')) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      if (nowMs - st.mtimeMs <= maxAgeMs) out.push(file);
    } catch {
      // Removed between readdir and stat, or unreadable — not a live session either way.
    }
  }
  return out;
}

/** Parses one session state file, or null on any read/parse failure or a non-object
 * result — a corrupt or half-written file counts as zero live units, never a crash. */
function readSessionState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The live units contributed by ONE already-parsed session state object, appended to
 * `entries` as `{ ts, label, kind: 'orca' | 'agent' }`. Factored out of
 * `machineWideLiveUnits` so the CALLER's own session can be counted from its accurate,
 * already-in-memory state (which may hold reservations from earlier in the very same
 * multi-invocation command line that are not yet flushed to disk) while every OTHER
 * session is counted from its last-saved file on disk.
 *   - a live Orca worker GROUP of any agent (codex, claude, ...) — never `capExempt` (a
 *     worker Orca itself reports done but still holding its terminal is not doing work
 *     anymore and must not block a new dispatch, same reasoning as the Codex-only cap);
 *   - a still-unresolved worker-start reservation that represents a genuinely NEW slot
 *     (`r.newSlot`, set by parallel-ownership-gates.cjs — a `--terminal`/`--retry-of`
 *     replacement of an existing group is explicitly excluded there) and has not expired
 *     (`OC.reservationExpired`, the same 10-minute window the ownership/Codex-cap gates use);
 *   - a live in-session Agent/Task subagent dispatch (`s.agents[id]`), not yet past
 *     `AGENT_REGISTRY_TTL_MS` since it was registered.
 */
function collectLiveUnitsFromState(s, nowMs, entries) {
  if (!s) return;
  const groups = new Map(); // group id -> earliest known ts
  for (const [key, w] of Object.entries(s.workers || {})) {
    if (!w || w.status !== 'live' || w.capExempt) continue;
    const g = WG.groupOf(w, key);
    const ts = Number.isFinite(w.started) ? w.started : nowMs;
    if (!groups.has(g) || ts < groups.get(g)) groups.set(g, ts);
  }
  for (const [id, r] of Object.entries(s.reservations || {})) {
    if (!r || !r.newSlot || OC.reservationExpired(r)) continue;
    if (!groups.has(id)) groups.set(id, r.ts);
  }
  for (const [g, ts] of groups) entries.push({ ts, label: g, kind: 'orca' });

  for (const [id, a] of Object.entries(s.agents || {})) {
    if (!a || !Number.isFinite(a.ts) || nowMs - a.ts > AGENT_REGISTRY_TTL_MS) continue;
    entries.push({ ts: a.ts, label: id, kind: 'agent' });
  }
}

/**
 * Every currently-live "parallel unit" charged against the machine-wide budget, summed
 * across every recent session state file (see `recentSessionStateFiles`) plus, optionally,
 * one caller-supplied in-memory state for its own session (`opts.currentState` +
 * `opts.currentSessionId`, to avoid double-counting that session's own on-disk file, which
 * may be stale relative to reservations added earlier in the same still-in-flight command).
 * Returns `{ total, orcaWorkers, subagents, ids }` — `ids` is every counted unit's label,
 * oldest first, capped at 8, for a refusal message that names what is actually holding
 * capacity rather than a bare count.
 */
function machineWideLiveUnits(dir, nowMs = Date.now(), opts = {}) {
  const { currentState, currentSessionId } = opts;
  const currentFileName = currentSessionId
    ? `${String(currentSessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`
    : null;
  const files = recentSessionStateFiles(dir, nowMs);
  const entries = []; // { ts, label, kind: 'orca' | 'agent' }

  for (const file of files) {
    if (currentFileName && path.basename(file) === currentFileName) continue; // counted below instead
    collectLiveUnitsFromState(readSessionState(file), nowMs, entries);
  }
  if (currentState) collectLiveUnitsFromState(currentState, nowMs, entries);

  entries.sort((a, b) => a.ts - b.ts);
  const orcaWorkers = entries.filter((e) => e.kind === 'orca').length;
  const subagents = entries.filter((e) => e.kind === 'agent').length;
  const ids = entries.slice(0, 8).map((e) => e.label);
  return { total: orcaWorkers + subagents, orcaWorkers, subagents, ids };
}

/** The refusal reason for `max-parallel-agents` (the caller's `deny()`/`d()` prepends the
 * `[orchestrator-gate:max-parallel-agents]` prefix, so this string never repeats it). */
function formatParallelAgentsRefusal(usage, limit, coreCount, fraction) {
  const idsPart = usage.ids.length ? ` [${usage.ids.join(', ')}]` : '';
  const limitText = Number.isFinite(limit) ? limit : 'unlimited';
  return `${usage.total}/${limitText} parallel units live on this machine ` +
    `(${coreCount} cores x ${Math.round(fraction * 100)}%): ${usage.orcaWorkers} Orca workers, ` +
    `${usage.subagents} subagents${idsPart}. Wait for one to finish and release it, or raise ` +
    'maxParallelAgents / ORCH_MAX_PARALLEL_AGENTS.';
}

module.exports = {
  MAX_SESSION_AGE_MS, AGENT_REGISTRY_TTL_MS, cores, agentParallelLimit,
  recentSessionStateFiles, readSessionState, machineWideLiveUnits, formatParallelAgentsRefusal,
};
