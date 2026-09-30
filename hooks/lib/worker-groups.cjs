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

/** IDs carried by authoritative fields in one parsed worker-start reply. Free-text string
 * values are deliberately never scanned: prompts, formatter output and chained worker-list
 * summaries can mention arbitrary ctx_/task_/term_ ids that do not belong to this start. */
function idsFromReply(reply) {
  const ids = new Set();
  const idKeys = new Set(['dispatchId', 'taskId', 'handle', 'terminalHandle', 'agentTerminalHandle']);
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, child] of Object.entries(value)) {
      if (idKeys.has(key) && typeof child === 'string' && /^(?:ctx|task|term)_[A-Za-z0-9_-]+$/.test(child)) {
        ids.add(child);
      } else if (child && typeof child === 'object') {
        visit(child);
      }
    }
  };
  visit(reply);
  return ids;
}

function fieldValuesFromReply(reply, field) {
  const values = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, child] of Object.entries(value)) {
      if (key === field && typeof child === 'string') values.push(child);
      else if (child && typeof child === 'object') visit(child);
    }
  };
  visit(reply);
  return values;
}

/**
 * True when a parsed value is a real orca reply envelope worth attributing to a dispatch
 * invocation, rather than noise a lenient parser happened to accept: it must be a plain
 * object (never an array or primitive — `[3]` from a stray `retry [3]` log line parses as
 * valid JSON but is never a dispatch reply), it must not be worker-list-shaped (carries a
 * `workers[]` array), and it must carry at least one field a real envelope always has — an
 * explicit `ok`, an `error`, or one of the dispatch/task/terminal id fields, checked at the
 * top level, one level under `.result` (the common `{"ok":true,"result":{...}}` shape), or
 * nested further under `.result.mutation`/`.result.resource` (the fuller nested-envelope
 * shape). A bare `{}` — a real but signal-less object a stray log line can produce just as
 * easily as a genuine reply — carries none of these and is correctly rejected as noise.
 */
function isDispatchReply(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const r = (obj.result && typeof obj.result === 'object' && !Array.isArray(obj.result)) ? obj.result : obj;
  if (Array.isArray(r.workers)) return false;
  const hasSignal = (o) => !!o && typeof o === 'object' && !Array.isArray(o) && (
    'ok' in o || 'error' in o ||
    typeof o.dispatchId === 'string' || typeof o.taskId === 'string' || typeof o.handle === 'string'
  );
  return hasSignal(obj) || hasSignal(r) || hasSignal(r.mutation) || hasSignal(r.resource);
}

/**
 * Depth-limited, string/escape-aware scan that splits a blob of concatenated JSON text into
 * its individual top-level `{...}`/`[...]` value chunks, whatever whitespace (including
 * newlines — a pretty-printed `JSON.stringify(x, null, 2)` reply spans many lines) sits
 * between or inside them. A `{`/`}` inside a quoted string (e.g. a dispatch's own prompt
 * text) never affects the brace-depth count, so it can never mis-split a reply that merely
 * contains braces as content.
 *
 * At depth 0 (not currently inside an opened candidate chunk), a `{`/`[` only OPENS one when
 * it is the first non-whitespace character of its own line, OR the character immediately
 * following a chunk that just closed — the discriminator between "this line is a real JSON
 * reply" and "this is human-readable log/progress text that happens to contain a
 * brace/bracket somewhere in the middle" (`retry [3]`, `progress [==` never open a chunk this
 * way, and never derail bracket-depth tracking for the real replies that follow), while still
 * letting two real replies printed back-to-back on the SAME line (`{...}{...}`, no separator
 * at all) both open — the "start of line" flag is forced true the instant a real, successfully
 * completed top-level value closes, never by arbitrary other characters. Depth 0 also never
 * enters string mode: a stray, unterminated `"` in ordinary log text (`Starting "phase`)
 * before any chunk has been opened is inert noise, not the start of a JSON string —
 * string/escape tracking only applies once already inside an opened chunk (depth > 0), where
 * it is still needed to handle a reply whose own string content contains braces or brackets.
 */
function splitConcatenatedJson(text) {
  const chunks = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let atLineStart = true;
  // Only set true right after a real newline; a chunk closing mid-line re-arms `atLineStart`
  // but must NOT also permit `[` there — a dispatch reply is always a JSON object, never a
  // top-level array, so allowing `[` to reopen immediately after `{...}` with no separator
  // (e.g. `{...}[stray, log, array]`) risks swallowing unrelated log noise as a second "reply".
  // A `[` is only ever a legitimate chunk opener right after an actual newline.
  let realLineStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (depth === 0) {
      if (c === '\n') { atLineStart = true; realLineStart = true; continue; }
      if (c === ' ' || c === '\t' || c === '\r') continue; // whitespace never ends "start of line"
      if ((c === '{' || (c === '[' && realLineStart)) && atLineStart) {
        start = i;
        depth = 1;
        atLineStart = false;
        realLineStart = false;
        continue;
      }
      atLineStart = false; // any other non-whitespace character (including a stray quote) is inert noise
      realLineStart = false;
      continue;
    }
    // depth > 0: inside an opened candidate chunk — normal string/escape-aware balanced scan.
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') { depth += 1; continue; }
    if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) {
        chunks.push(text.slice(start, i + 1));
        start = -1;
        // A real value just closed: the very next character may be a second reply printed
        // immediately after it with no separator (`{...}{...}`) — treat that position as a
        // fresh "start of line" so it can still open a chunk, without waiting for an actual
        // newline.
        atLineStart = true;
      }
      continue;
    }
  }
  return chunks;
}

/**
 * Best-effort split of one Bash call's combined stdout+stderr into the individual JSON
 * reply objects each real orca invocation in that command printed, in command order. Used
 * only to disambiguate MULTIPLE dispatch invocations chained in a single command line.
 *
 * Three passes, each trusted only when it can fully explain the text (never a partial,
 * silently-wrong parse):
 *   1. the whole blob is exactly one JSON value (the common single-dispatch case).
 *   2. one compact JSON value per non-empty line (NDJSON) — accepted only when EVERY
 *      non-empty line parses; a real `orca --json` reply is often pretty-printed across many
 *      lines, and a pretty-printed object's individual lines (`{`, `  "ok": true,`, ...)
 *      would otherwise half-parse and misattribute ids to the wrong invocation.
 *   3. fallback: a balanced-brace/bracket scan across the whole blob (handles concatenated,
 *      possibly pretty-printed, multi-line replies with no separator between them at all).
 * A worker-list-shaped reply (carries a `workers` array) is excluded at every stage rather
 * than misattributed to a dispatch.
 */
function splitJsonReplies(out) {
  const text = String(out || '');
  const trimmed = text.trim();

  if (trimmed) {
    try {
      const obj = JSON.parse(trimmed);
      return isDispatchReply(obj) ? [obj] : [];
    } catch { /* not a single JSON value; fall through */ }
  }

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length) {
    const parsed = [];
    let allParse = true;
    for (const line of lines) {
      if (line[0] !== '{' && line[0] !== '[') { allParse = false; break; }
      try { parsed.push(JSON.parse(line)); } catch { allParse = false; break; }
    }
    if (allParse && parsed.length) return parsed.filter(isDispatchReply);
  }

  const replies = [];
  for (const chunk of splitConcatenatedJson(text)) {
    try {
      const obj = JSON.parse(chunk);
      if (isDispatchReply(obj)) replies.push(obj);
    } catch { /* skip an unparsable chunk */ }
  }
  return replies;
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

/** Number of distinct *live* groups whose resolved agent is `agent` (default 'codex').
 * A group flagged `capExempt` (done per Orca but still holding its terminal — see
 * reconcileCodexGroupsWithOrca) is tracked/live for the Stop gate's sake but excluded here:
 * it is not doing work anymore, so it must not block a new dispatch from being admitted. */
function countLiveGroups(workers, agent = 'codex') {
  const groups = new Set();
  for (const [key, w] of Object.entries(workers || {})) {
    if (w.status !== 'live') continue;
    if (w.agent !== agent) continue;
    if (w.capExempt) continue;
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

const RETAIN_SUB = 'orchestration worker-retain';

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

/** The tracked id explicitly retained by `orca orchestration worker-retain`. */
function retainTarget(inv, flagValue) {
  if (inv.sub !== RETAIN_SUB) return null;
  const rest = inv.args.slice(inv.sub.split(' ').length);
  return flagValue(rest, '--dispatch') || rest.find((a) => !a.startsWith('-')) || null;
}

/** Worker/terminal id whose output an inspection invocation returns. */
function outputTarget(inv, flagValue) {
  const supported = new Set([
    'orchestration worker-read', 'orchestration worker-show', 'terminal read', 'terminal show',
  ]);
  if (!supported.has(inv.sub)) return null;
  const rest = inv.args.slice(inv.sub.split(' ').length);
  return flagValue(rest, '--dispatch') || flagValue(rest, '--task') ||
    flagValue(rest, '--terminal') || flagValue(rest, '--handle') ||
    rest.find((a) => !a.startsWith('-')) || null;
}

module.exports = {
  idsFromOutput, idsFromReply, fieldValuesFromReply,
  splitJsonReplies, splitConcatenatedJson, isDispatchReply, kindOf,
  canonicalGroup, groupOf, countLiveGroups, liveGroupByTerminal, groupById, settleGroup,
  RELEASE_SUBS, releaseTarget, RETAIN_SUB, retainTarget, outputTarget,
};
