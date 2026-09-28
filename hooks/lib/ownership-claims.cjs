#!/usr/bin/env node
/**
 * ownership-claims.cjs — the live-claim bookkeeping shared by the ownership-overlap check
 * for Bash-dispatched orca briefs (task-create/worker-start --spec) and in-session Agent
 * dispatches: what counts as "currently claimed", how long a claim survives without an
 * explicit release, and finding the first conflicting claim in the same workspace.
 *
 * Three sources of a live claim, all normalized to the same shape by `liveClaims()`:
 *   - a registered worker group (`s.workers[id].owns`, set once the worker actually starts);
 *   - a Bash-dispatch reservation (`s.reservations[id].owns`) held between the PreToolUse
 *     that admitted it and the PostToolUse that either turns it into a worker or drops it;
 *   - an in-session Agent claim (`s.agentClaims[tool_use_id].owns`), released at the
 *     matching PostToolUse (foreground), a `<task-notification>` naming its id
 *     (background, best effort), `ownershipClaimTtlMinutes` (background safety net), or the
 *     operator's `--release-claims`.
 */

'use strict';

const { groupOf } = require('./worker-groups.cjs');
const { anyOverlap } = require('./ownership.cjs');

// A Bash-dispatch reservation (parallel-limit capacity or ownership claim, or both) is
// abandoned if nothing converts it to a real record within this long — the same window
// the parallel-limit gate uses for "started but Orca hasn't listed it yet".
const RESERVATION_TTL_MS = 10 * 60 * 1000;

function reservationExpired(r) {
  return !r || !Number.isFinite(r.ts) || (Date.now() - r.ts) > RESERVATION_TTL_MS;
}

function claimExpired(c, ttlMinutes) {
  if (!c || !Number.isFinite(c.ts)) return true;
  const ttl = Number.isFinite(ttlMinutes) ? ttlMinutes : 120;
  return (Date.now() - c.ts) > ttl * 60 * 1000;
}

/**
 * Every currently-live ownership claim in session state `s`, from all three sources, each
 * shaped `{ id, owns, ws, source, ts }`. `excludeGroup` (a worker-group id) omits the
 * group a `--terminal`/`--retry-of` invocation is about to replace, so a worker never
 * conflicts with its own predecessor.
 */
function liveClaims(s, ttlMinutes, excludeGroup) {
  const claims = [];
  for (const [key, w] of Object.entries(s.workers || {})) {
    if (w.status !== 'live' || !w.owns || !w.owns.length) continue;
    const group = groupOf(w, key);
    if (excludeGroup && group === excludeGroup) continue;
    claims.push({ id: group, owns: w.owns, ws: w.ws, source: 'worker', ts: w.started });
  }
  for (const [id, r] of Object.entries(s.reservations || {})) {
    if (reservationExpired(r) || !r.owns || !r.owns.length) continue;
    if (excludeGroup && id === excludeGroup) continue;
    claims.push({ id, owns: r.owns, ws: r.ws, source: 'reservation', ts: r.ts });
  }
  for (const [id, c] of Object.entries(s.agentClaims || {})) {
    if (claimExpired(c, ttlMinutes) || !c.owns || !c.owns.length) continue;
    claims.push({ id, owns: c.owns, ws: c.ws, source: 'agent', ts: c.ts });
  }
  return claims;
}

/** The first live claim in the same workspace whose patterns overlap `owns`, or null. */
function findOverlap(claims, ws, owns) {
  for (const c of claims) {
    if (c.ws !== ws) continue;
    const hit = anyOverlap(owns, c.owns);
    if (hit) return { ...c, hit };
  }
  return null;
}

/** A short human-readable age for a refusal message ("42s", "6m"). */
function ageString(ts) {
  if (!Number.isFinite(ts)) return 'unknown age';
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 90) return `${secs}s`;
  return `${Math.round(secs / 60)}m`;
}

/** Live (unexpired) Bash-dispatch reservations that hold parallel-Codex-worker capacity. */
function countPendingCodexReservations(s) {
  let n = 0;
  for (const r of Object.values(s.reservations || {})) {
    if (reservationExpired(r)) continue;
    if (r.codexSlot) n += 1;
  }
  return n;
}

module.exports = {
  RESERVATION_TTL_MS, reservationExpired, claimExpired, liveClaims, findOverlap, ageString,
  countPendingCodexReservations,
};
