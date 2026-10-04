#!/usr/bin/env node
'use strict';

const { fetchWorkerListPages } = require('../hooks/lib/orca-worker-list-pages.cjs');

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// A clean two-page list is followed to completion and every row is collected in order.
const twoPage = fetchWorkerListPages((args) => {
  const cursorIdx = args.indexOf('--cursor');
  const cursor = cursorIdx >= 0 ? args[cursorIdx + 1] : null;
  if (!cursor) {
    return { result: { workers: [{ dispatchId: 'a' }], page: { hasMore: true, nextCursor: 'p2' } } };
  }
  return { result: { workers: [{ dispatchId: 'b' }], page: { hasMore: false, nextCursor: null } } };
});
check('a clean multi-page list is fully followed', twoPage.ok, true);
check('rows from every page are collected in order',
  twoPage.rows.map((r) => r.dispatchId), ['a', 'b']);
check('a clean finish reports no stoppedBy reason', twoPage.stoppedBy, null);

// `--limit` is always the shared page size, never the caller's own default.
let seenLimit = null;
fetchWorkerListPages((args) => {
  seenLimit = args[args.indexOf('--limit') + 1];
  return { result: { workers: [], page: { hasMore: false } } };
}, { baseArgs: ['--include-remote'] });
check('baseArgs are preserved alongside the shared --limit', seenLimit, '100');

// scope is captured from page 1 only, even across multiple pages.
const scoped = fetchWorkerListPages((args) => {
  const cursorIdx = args.indexOf('--cursor');
  if (cursorIdx < 0) {
    return { result: { workers: [], page: { hasMore: true, nextCursor: 'p2' }, scope: { run: 'r1', source: 'bound' } } };
  }
  return { result: { workers: [], page: { hasMore: false }, scope: { run: 'different', source: 'should-not-win' } } };
});
check('scope is read from the first page only', scoped.scope, { run: 'r1', source: 'bound' });

// A falsy fetchPage result (the caller's own "no reply"/failure signal) stops the loop and
// is reported distinctly from every other stop reason.
const fetchFailed = fetchWorkerListPages(() => null);
check('a fetch failure stops with stoppedBy "fetch"', fetchFailed.stoppedBy, 'fetch');
check('a fetch failure reports ok:false', fetchFailed.ok, false);

// A reply with no rows array at all (a missing/renamed `workers` field) is distinct from a
// genuine failure to fetch — it is a reply that cannot be trusted.
const noRows = fetchWorkerListPages(() => ({ result: { page: { hasMore: false } } }));
check('a reply missing a rows array stops with stoppedBy "rows"', noRows.stoppedBy, 'rows');

// hasMore with no new cursor (a repeated or absent cursor) must never loop forever.
const repeatedCursor = fetchWorkerListPages(() => ({
  result: { workers: [{ dispatchId: 'x' }], page: { hasMore: true, nextCursor: null } },
}));
check('hasMore with no cursor stops with stoppedBy "cursor"', repeatedCursor.stoppedBy, 'cursor');
check('rows already collected before the cursor failure are still returned',
  repeatedCursor.rows.map((r) => r.dispatchId), ['x']);

let sameCursorCalls = 0;
const sameCursor = fetchWorkerListPages((args) => {
  sameCursorCalls += 1;
  const cursorIdx = args.indexOf('--cursor');
  const cursor = cursorIdx >= 0 ? args[cursorIdx + 1] : null;
  if (!cursor) return { result: { workers: [], page: { hasMore: true, nextCursor: 'same' } } };
  return { result: { workers: [], page: { hasMore: true, nextCursor: 'same' } } };
});
check('a cursor that repeats itself stops instead of looping', sameCursor.stoppedBy, 'cursor');
check('a repeated cursor is only fetched twice, never looped', sameCursorCalls, 2);

// A cursor chain that never terminates is capped rather than looping forever.
let pageCapCalls = 0;
const pageCap = fetchWorkerListPages((args) => {
  pageCapCalls += 1;
  const n = pageCapCalls;
  return { result: { workers: [{ dispatchId: `p${n}` }], page: { hasMore: true, nextCursor: `cursor-${n}` } } };
}, { maxPages: 5 });
check('the page cap stops the loop at the configured count', pageCapCalls, 5);
check('a page-cap stop reports stoppedBy "page-cap"', pageCap.stoppedBy, 'page-cap');
check('rows collected before the cap are still returned', pageCap.rows.length, 5);

// Deadline mode (parallel-ownership-gates style): stop once the budget has passed, keeping
// whatever partial rows were already collected, rather than failing the whole call closed.
let deadlineCalls = 0;
const past = Date.now() - 1000;
const deadlineHit = fetchWorkerListPages((args) => {
  deadlineCalls += 1;
  return { result: { workers: [{ dispatchId: 'only' }], page: { hasMore: true, nextCursor: 'next' } } };
}, { deadlineAt: past, maxPages: 50 });
check('an already-past deadline stops before any fetch', deadlineCalls, 0);
check('a deadline stop reports stoppedBy "deadline"', deadlineHit.stoppedBy, 'deadline');

const deadlineMidLoop = fetchWorkerListPages((args, meta) => {
  if (meta.page === 0) return { result: { workers: [{ dispatchId: 'first' }], page: { hasMore: true, nextCursor: 'next' } } };
  return { result: { workers: [{ dispatchId: 'second' }], page: { hasMore: false } } };
}, { deadlineAt: Date.now() + 50, maxPages: 50 });
check('a deadline not yet passed lets at least one page through',
  deadlineMidLoop.rows.length >= 1, true);

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
