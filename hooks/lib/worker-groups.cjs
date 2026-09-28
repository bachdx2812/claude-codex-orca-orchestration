#!/usr/bin/env node
/**
 * worker-groups.cjs — group/kind bookkeeping for `s.workers`, shared by the parallel-limit
 * gate (counting) and the ownership gate (settling a claim when its worker finishes).
 *
 * Fixes two pre-existing bugs in the state this module manages:
 *
 * 1. "Triple worker records": a single `worker-start` reply can carry a dispatch id
 *    (`ctx_*`), a task id (`task_*`) and a terminal handle (`term_*`) for the SAME
 *    worker. Registering each as its own top-level `s.workers` entry (the old behavior)
 *    triple-counts one worker as three. Every entry now carries a `group` — the same
 *    value for every id that came from one worker-start reply — and callers that need a
 *    worker *count* (as opposed to an Orca-reconciliation *lookup*, which still needs
 *    every individual id as its own key) count distinct groups, not distinct keys.
 *    `groupOf()` falls back to the entry's own key for legacy entries written before this
 *    field existed, so an old state file degrades to "every entry is its own group"
 *    (the previous, over-counting behavior) rather than crashing.
 *
 * 2. Release matcher settling every live worker: `worker-release --dispatch <id> --json`
 *    was previously matched by taking the command line's last shell token — `--json` — and
 *    since no worker is ever labelled `--json`, the old code fell back to settling every
 *    live worker in the session. `releaseTarget()` reads the *specific* orca invocation's
 *    own parsed args (via `orcaInvocations()` + `flagValue()`) instead of the raw command
 *    string, so trailing flags can never be mistaken for the target id.
 */

'use strict';

// A worker-start reply's JSON body, scanned for every candidate id it names — structured
// fields first (authoritative), then a generic scan for bare ctx_/task_/term_ tokens as a
// fallback for replies that don't use those exact field names.
function idsFromOutput(out) {
  const ids = new Set();
  for (const m of String(out || '').matchAll(/"(?:dispatchId|taskId|handle)"\s*:\s*"([^"]+)"/g)) ids.add(m[1]);
  for (const m of String(out || '').matchAll(/\b((?:ctx|task|term)_[A-Za-z0-9_-]+)\b/g)) ids.add(m[1]);
  return ids;
}

/** A terminal handle (`term_*`) is a distinct resource from a worker id (`ctx_*`/`task_*`). */
function kindOf(id) {
  return /^term_/.test(String(id)) ? 'terminal' : 'worker';
}

/**
 * The canonical group id for a set of ids surfaced by one worker-start reply: prefer the
 * dispatch id, then the task id, then the terminal handle — whichever is present first,
 * since that is the order later lookups (Orca reconciliation, `--retry-of`) use too.
 * Returns null when `ids` is empty (caller picks a synthetic group, e.g. `start-<ts>`).
 */
function canonicalGroup(ids) {
  const arr = [...ids];
  return arr.find((i) => /^ctx_/.test(i)) || arr.find((i) => /^task_/.test(i)) || arr.find((i) => /^term_/.test(i)) || null;
}

/** The group a tracked `s.workers` entry belongs to — its own key for a legacy entry. */
function groupOf(entry, key) {
  return (entry && entry.group) || key;
}

/** Number of distinct *live* groups whose resolved agent is `agent` (default 'codex'). */
function countLiveGroups(workers, agent = 'codex') {
  const groups = new Set();
  for (const [key, w] of Object.entries(workers || {})) {
    if (w.status !== 'live') continue;
    if (w.agent !== agent) continue;
    groups.add(groupOf(w, key));
  }
  return groups.size;
}

/** A tracked *live* group by the terminal handle it holds — used to resolve `--terminal
 * <h>` on a worker-start into "this replaces an existing group", not a new dispatch. */
function liveGroupByTerminal(workers, handle) {
  for (const [key, w] of Object.entries(workers || {})) {
    if (w.status !== 'live') continue;
    if (kindOf(key) !== 'terminal') continue;
    if (key === handle) return { group: groupOf(w, key), agent: w.agent, owns: w.owns, ws: w.ws };
  }
  return null;
}

/** A tracked group (any status — `--retry-of` commonly targets one already finished or
 * rate-limited) by any id it was ever registered under. */
function groupById(workers, id) {
  const w = (workers || {})[id];
  if (!w) return null;
  return { group: groupOf(w, id), agent: w.agent, owns: w.owns, ws: w.ws };
}

/** Settle every entry sharing `group`. Returns true when anything changed. */
function settleGroup(workers, group) {
  let changed = false;
  for (const [key, w] of Object.entries(workers || {})) {
    if (w.status === 'live' && groupOf(w, key) === group) {
      w.status = 'settled';
      changed = true;
    }
  }
  return changed;
}

// Sub-commands that settle a worker/terminal. Matched against orcaInvocations()' own
// `sub` field, never against the raw command string.
const RELEASE_SUBS = new Set([
  'orchestration worker-release',
  'orchestration worker-stop',
  'orchestration worker-abandon',
  'terminal close',
]);

/**
 * The id (dispatch/task/terminal) a release-shaped orca invocation targets: `--dispatch`
 * (or `--task`/`--terminal`, all =-joined-aware via the caller's `flagValue`), falling back
 * to the first positional argument after the subcommand's own words. Only the words after
 * the subcommand are considered, so `terminal close term_x` never mistakes `terminal` or
 * `close` themselves for the target. Returns null when nothing identifies a target at all
 * — the caller must settle nothing rather than guess.
 */
function releaseTarget(inv, flagValue) {
  if (!RELEASE_SUBS.has(inv.sub)) return null;
  const rest = inv.args.slice(inv.sub.split(' ').length);
  const byFlag = flagValue(rest, '--dispatch') || flagValue(rest, '--task') || flagValue(rest, '--terminal') || flagValue(rest, '--handle');
  if (byFlag) return byFlag;
  const positional = rest.find((a) => !a.startsWith('-'));
  return positional || null;
}

module.exports = {
  idsFromOutput, kindOf, canonicalGroup, groupOf, countLiveGroups,
  liveGroupByTerminal, groupById, settleGroup, RELEASE_SUBS, releaseTarget,
};
