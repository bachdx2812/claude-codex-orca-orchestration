'use strict';
/**
 * Wake classification for the heartbeat daemon. Every observation is one of:
 *   info   - logged only; the daemon keeps running and the panel is not woken.
 *   done   - a worker finished normally; buffered and flushed as one summary line once all
 *            of this session's workers are finished or the coalescing window elapses.
 *   urgent - needs a panel decision now; wakes immediately with any buffered done notices.
 * Anything not explicitly classified is urgent, so a new event type is never silently lost.
 */

const DONE_WORKER_STATES = new Set(['succeeded', 'completed']);
const FAILED_WORKER_STATES = new Set(['failed', 'stopped', 'cancelled']);
// States of a worker that is simply still in flight; only these may be silenced. A state the
// daemon does not recognise could be a new failure mode, so it must wake the panel.
const INFO_WORKER_STATES = new Set(['queued', 'created', 'started', 'pending', 'dispatched', 'running']);

/** Splits a `workerState|dispatchStatus|terminalState` triplet (undefined -> all empty). */
function parseTriplet(triplet) {
  const [workerState = '', dispatchStatus = '', terminalState = ''] = String(triplet || '').split('|');
  return { workerState, dispatchStatus, terminalState };
}

/**
 * Classifies one worker's transition. A failed/stopped state always wins (even next to a
 * contradictory "succeeded"), then a clean finish. A known in-flight state (queued -> running,
 * terminal churn) is info; any other state is urgent.
 */
function classifyWorkerTransition(before, after) {
  const next = parseTriplet(after);
  if (FAILED_WORKER_STATES.has(next.workerState) || FAILED_WORKER_STATES.has(next.dispatchStatus)) return 'urgent';
  if (DONE_WORKER_STATES.has(next.workerState) || DONE_WORKER_STATES.has(next.dispatchStatus)) return 'done';
  const inFlight = INFO_WORKER_STATES.has(next.workerState) &&
    (!next.dispatchStatus || INFO_WORKER_STATES.has(next.dispatchStatus));
  return inFlight ? 'info' : 'urgent';
}

/**
 * One summary line for buffered done notices. Worker-finish entries are `{id}`; other done
 * reminders carry `{text}` and are appended verbatim.
 */
function formatDoneSummary(list) {
  const ids = [];
  const reminders = [];
  for (const item of list || []) {
    if (item && item.id) ids.push(item.id);
    else if (item && item.text) reminders.push(item.text);
  }
  if (!ids.length) return `DONE: ${reminders.join('; ')}`;
  const head = `DONE: ${ids.length} worker(s) finished: ${ids.join(', ')}`;
  return reminders.length ? `${head} (+ ${reminders.join('; ')})` : head;
}

module.exports = {
  DONE_WORKER_STATES, FAILED_WORKER_STATES, parseTriplet, classifyWorkerTransition, formatDoneSummary,
};
