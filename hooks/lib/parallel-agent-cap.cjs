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
const HBL = require('./heartbeat-liveness.cjs');

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

// M1 (orchestrator decision): another session's units count toward the machine-wide budget
// only while there is some recent signal that session is actually still alive — either its
// heartbeat daemon (see `heartbeatAliveAt`), or its state file having changed within this
// window. Without either signal a session is presumed abandoned, and its stale
// reservations/registrations must not eat into a live dispatch's budget. The CALLER's own
// session (`currentState`/`currentSessionId`) always counts regardless — see
// `machineWideLiveUnits`. This is a real trade-off (documented in README known limits): a
// session that is genuinely still working, but whose heartbeat daemon is not running and
// which has not touched its state file in 30 minutes, will have its units silently dropped
// from the count.
const OTHER_SESSION_RECENT_MS = 30 * 60 * 1000;

/**
 * The live units contributed by ONE already-parsed session state object, appended to
 * `entries` as `{ ts, label, kind: 'orca' | 'agent', sid }`. Factored out of
 * `machineWideLiveUnits` so the CALLER's own session can be counted from its accurate,
 * already-in-memory state (which may hold reservations from earlier in the very same
 * multi-invocation command line that are not yet flushed to disk) while every OTHER
 * session is counted from its last-saved file on disk. `sid` is stamped onto every entry
 * (H2) so a refusal can label each unit `<sid8>:<id>` instead of a bare, ambiguous id.
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
function collectLiveUnitsFromState(s, sid, nowMs, entries) {
  if (!s) return;
  const groups = new Map(); // group id -> earliest known ts
  for (const [key, w] of Object.entries(s.workers || {})) {
    if (!w || w.status !== 'live' || w.capExempt) continue;
    // An expired "pending-*" placeholder holds no machine slot anywhere (worker-groups.cjs);
    // the machine-wide budget must not count it either, whatever session it leaked in.
    if (WG.pendingPlaceholderExpired(key, w, nowMs)) continue;
    const g = WG.groupOf(w, key);
    const ts = Number.isFinite(w.started) ? w.started : nowMs;
    if (!groups.has(g) || ts < groups.get(g)) groups.set(g, ts);
  }
  for (const [id, r] of Object.entries(s.reservations || {})) {
    if (!r || !r.newSlot || OC.reservationExpired(r)) continue;
    if (!groups.has(id)) groups.set(id, r.ts);
  }
  for (const [g, ts] of groups) entries.push({ ts, label: g, kind: 'orca', sid });

  for (const [id, a] of Object.entries(s.agents || {})) {
    if (!a || !Number.isFinite(a.ts) || nowMs - a.ts > AGENT_REGISTRY_TTL_MS) continue;
    entries.push({ ts: a.ts, label: id, kind: 'agent', sid });
  }
}

/**
 * Every currently-live "parallel unit" charged against the machine-wide budget, summed
 * across every recent session state file (see `recentSessionStateFiles`) plus, optionally,
 * one caller-supplied in-memory state for its own session (`opts.currentState` +
 * `opts.currentSessionId`, to avoid double-counting that session's own on-disk file, which
 * may be stale relative to reservations added earlier in the same still-in-flight command).
 * Every OTHER session's file is additionally gated by the M1 liveness rule above before its
 * units are ever collected; the caller's own session is exempt from that rule (it is,
 * definitionally, live right now). Returns `{ total, orcaWorkers, subagents, ids }` — `ids`
 * is every counted unit's label as `<sid8>:<id>` (H2), oldest first, capped at 8, for a
 * refusal message that names what is actually holding capacity, and whose session, rather
 * than a bare and potentially ambiguous id.
 */
function machineWideLiveUnits(dir, nowMs = Date.now(), opts = {}) {
  const { currentState, currentSessionId } = opts;
  const currentFileName = currentSessionId
    ? `${String(currentSessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`
    : null;
  const files = recentSessionStateFiles(dir, nowMs);
  const entries = []; // { ts, label, kind: 'orca' | 'agent', sid }

  for (const file of files) {
    const base = path.basename(file);
    if (currentFileName && base === currentFileName) continue; // counted below instead
    const sid = base.slice(0, -'.json'.length);
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue; // removed between the listing and here — not a live session either way
    }
    const recentlyActive = nowMs - mtimeMs <= OTHER_SESSION_RECENT_MS;
    if (!recentlyActive && !HBL.heartbeatAliveAt(dir, sid)) continue; // M1
    collectLiveUnitsFromState(readSessionState(file), sid, nowMs, entries);
  }
  if (currentState) collectLiveUnitsFromState(currentState, currentSessionId || currentState.session_id, nowMs, entries);

  entries.sort((a, b) => a.ts - b.ts);
  const orcaWorkers = entries.filter((e) => e.kind === 'orca').length;
  const subagents = entries.filter((e) => e.kind === 'agent').length;
  const ids = entries.slice(0, 8).map((e) => `${String(e.sid || '').slice(0, 8)}:${e.label}`);
  return { total: orcaWorkers + subagents, orcaWorkers, subagents, ids };
}

/**
 * The refusal reason for `max-parallel-agents` (the caller's `deny()`/`d()` prepends the
 * `[orchestrator-gate:max-parallel-agents]` prefix, so this string never repeats it). H2:
 * every unit is labeled `<sid8>:<id>` (see `machineWideLiveUnits`) so a machine-wide refusal
 * names not just WHAT is holding capacity but WHICH session owns it — a bare id is ambiguous
 * once two sessions' ids can collide in the same list. Recovery is framed as the OPERATOR's
 * call, never the model's: raising the machine-wide budget or clearing a stuck registration
 * is a resource decision, so this never invites the model to just raise the limit itself.
 *
 * `meta.explicitLimit` (review round 3, item 5): the `(<cores> cores x <fraction>%)` derivation
 * is only ever true when the limit was DERIVED from the machine's core count — an operator who
 * set `maxParallelAgents`/`ORCH_MAX_PARALLEL_AGENTS` explicitly never picked that number via any
 * fraction of any core count, so printing one next to their own explicit number is meaningless
 * (and actively misleading if the machine's core count differs from whatever they were picturing
 * when they set it). `meta.stateDir` (same item): the recovery hint used to hardcode
 * `~/.claude/orchestrator-gate/` regardless of `ORCH_STATE_DIR` — wrong, and useless, whenever a
 * session actually runs with a different state dir (every test in this suite, for one).
 */
function formatParallelAgentsRefusal(usage, limit, coreCount, fraction, meta = {}) {
  const idsPart = usage.ids.length ? ` [${usage.ids.join(', ')}]` : '';
  const limitText = Number.isFinite(limit) ? limit : 'unlimited';
  const limitSource = meta.explicitLimit ? 'explicit limit' : `${coreCount} cores x ${Math.round(fraction * 100)}%`;
  const dir = meta.stateDir || path.join(os.homedir(), '.claude', 'orchestrator-gate');
  return `${usage.total}/${limitText} parallel units live on this machine ` +
    `(${limitSource}): ${usage.orcaWorkers} Orca workers, ` +
    `${usage.subagents} subagents${idsPart}. Wait for one to finish and release it, or ask the operator to: ` +
    'release a specific claim (--release-claims <id>|all, this session only), ' +
    `delete a dead session's state file under ${dir}/, ` +
    'or disable this gate (disabledGates: ["max-parallel-agents"]).';
}

/**
 * Refusal text for the one deliberate exception to this file's "lock timeout degrades to
 * allow" convention (Low item, concurrency review): the max-parallel-agents check is a hard
 * resource cap, not policy, so proceeding unlocked when the state-file lock is contended
 * would let every process contending for that SAME lock — i.e. exactly the high-concurrency
 * condition the cap exists to catch — fall through uncounted and all be admitted at once,
 * silently defeating the cap under the load it exists for. This is intentionally distinct
 * from the ordinary at-capacity refusal text: the right response is "retry the same
 * dispatch shortly", never "wait for a slot to free".
 */
const LOCK_CONTENTION_MESSAGE =
  'the orchestrator-gate state lock is contended right now (many concurrent dispatches) - ' +
  'this is transient, not being at capacity. Retry the same dispatch.';

module.exports = {
  MAX_SESSION_AGE_MS, AGENT_REGISTRY_TTL_MS, OTHER_SESSION_RECENT_MS, cores, agentParallelLimit,
  recentSessionStateFiles, readSessionState, machineWideLiveUnits, formatParallelAgentsRefusal,
  LOCK_CONTENTION_MESSAGE,
};
