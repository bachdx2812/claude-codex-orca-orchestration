'use strict';

/**
 * Shared cursor-paging loop for `orca orchestration worker-list`. Orca returns at most 100
 * rows per call (any `--limit` above 100 is rejected outright with `invalid_argument`,
 * verified live) and `result.page = { limit, total, hasMore, nextCursor }`; a caller that
 * reads only the first page silently drops every older row once the fleet grows past 100 —
 * this module is the one place that walks `nextCursor` so every worker-list caller in this
 * hook set (the janitor, heartbeat, the gate, the resume scheduler, and the parallel-Codex
 * ownership gates) does it the same bounded way instead of five slightly different copies.
 *
 * This module never shells out itself. The caller supplies `fetchPage(args)` — a function
 * that runs one `orchestration worker-list <args>` invocation (via `spawnSync`,
 * `execFileSync`, a test stub, whatever) and returns the parsed JSON reply, or a falsy value
 * on failure — so every caller keeps its own binary path, spawn style, and per-call timeout.
 * This module only builds `args` (base args + `--limit`/`--cursor`), drives the loop, and
 * reports WHY it stopped; the caller decides what each outcome means for its own failure
 * semantics (e.g. the janitor fails its whole run closed on any page it cannot trust, while
 * `parallel-ownership-gates.cjs` instead keeps whatever partial rows it already has and
 * marks the result non-exhaustive).
 *
 * Two termination modes, selected by which option is supplied:
 *   - `maxPages` (default `DEFAULT_MAX_PAGES`, 50): stop after this many pages regardless of
 *     elapsed time — a cursor chain that never terminates must not loop forever. This is the
 *     right mode for a caller that treats "list incomplete" as a hard failure.
 *   - `deadlineAt` (an epoch-ms budget): stop once `Date.now() >= deadlineAt`, mid-page,
 *     keeping whatever rows were already collected — the right mode for a caller that must
 *     return a partial-but-still-useful result rather than block forever.
 * Both can be supplied together; whichever fires first stops the loop.
 *
 * Returns `{ ok, rows, replies, stoppedBy, cursor, scope }`:
 *   - `rows`     every row collected from every successfully fetched page, in order.
 *   - `replies`  the raw reply from each successfully fetched page (not the failing one).
 *   - `scope`    `result.scope` from the first page, when Orca supplied one — `undefined`
 *     otherwise (an older Orca with no scope field). Live-verified: `worker-list` scopes to
 *     the Run bound to the calling terminal, or to every Run when there is no binding, and
 *     there is no flag to force the broader scope — callers that care should surface this,
 *     not fail closed on it (see `orca-janitor.cjs`'s own comment on why).
 *   - `stoppedBy` is `null` on a clean finish (`ok: true`), else one of:
 *       'fetch'      `fetchPage` returned a falsy value (the caller's own "no reply"/"ok:
 *                    false"/timeout signal) — `reply` on the return value is that falsy value.
 *       'rows'       the reply had no array of rows at the location `getRows` expects.
 *       'cursor'     the page claimed more rows exist but gave no new cursor to follow.
 *       'page-cap'   `maxPages` was reached.
 *       'deadline'   `deadlineAt` passed before the next page could be fetched.
 *   On any `ok: false` outcome, `rows`/`replies` still hold whatever was collected before the
 *   stopping page, so a caller that wants a "best-effort partial list" can still use them.
 */
const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_MAX_PAGES = 50;

function defaultGetRows(reply) {
  const result = reply && (reply.result ?? reply);
  if (!result) return null;
  if (Array.isArray(result)) return result;
  return Array.isArray(result.workers) ? result.workers : null;
}

function defaultGetPage(reply) {
  const result = reply && (reply.result ?? reply);
  return (result && !Array.isArray(result) && result.page) || {};
}

function defaultGetScope(reply) {
  const result = reply && (reply.result ?? reply);
  return result && !Array.isArray(result) ? result.scope : undefined;
}

function fetchWorkerListPages(fetchPage, options = {}) {
  const {
    baseArgs = [],
    pageLimit = DEFAULT_PAGE_LIMIT,
    maxPages = DEFAULT_MAX_PAGES,
    deadlineAt = null,
    getRows = defaultGetRows,
    getPage = defaultGetPage,
    getScope = defaultGetScope,
  } = options;

  const rows = [];
  const replies = [];
  let cursor = null;
  let scope;
  for (let page = 0; page < maxPages; page += 1) {
    if (deadlineAt != null && Date.now() >= deadlineAt) {
      return { ok: false, stoppedBy: 'deadline', rows, replies, cursor, scope };
    }
    const args = [...baseArgs, '--limit', String(pageLimit)];
    if (cursor) args.push('--cursor', cursor);
    const remainingMs = deadlineAt != null ? Math.max(1, deadlineAt - Date.now()) : null;
    const reply = fetchPage(args, { page, cursor, remainingMs });
    if (!reply) return { ok: false, stoppedBy: 'fetch', reply, rows, replies, cursor, scope };
    const pageRows = getRows(reply);
    if (!Array.isArray(pageRows)) {
      return { ok: false, stoppedBy: 'rows', reply, rows, replies, cursor, scope };
    }
    if (page === 0) scope = getScope(reply);
    rows.push(...pageRows);
    replies.push(reply);
    const pageInfo = getPage(reply) || {};
    if (!pageInfo.hasMore) return { ok: true, stoppedBy: null, rows, replies, cursor, scope };
    if (!pageInfo.nextCursor || pageInfo.nextCursor === cursor) {
      return { ok: false, stoppedBy: 'cursor', rows, replies, cursor, scope };
    }
    cursor = pageInfo.nextCursor;
  }
  return { ok: false, stoppedBy: 'page-cap', rows, replies, cursor, scope, maxPages };
}

module.exports = { fetchWorkerListPages, DEFAULT_PAGE_LIMIT, DEFAULT_MAX_PAGES };
