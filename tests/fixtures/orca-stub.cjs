#!/usr/bin/env node
/**
 * Deterministic stand-in for the `orca` CLI, selected via ORCA_BIN so the test suite's
 * worker-detection behavior never depends on a live Orca install being present.
 *
 * STUB_WORKER_HANDLE (+ optional STUB_TERMINAL_STATE / STUB_WORKER_STATE / STUB_DISPATCH_ID)
 * makes `orchestration worker-list --json` report exactly one worker terminal; unset, it
 * reports none, which is Orca's honest answer for "no dispatches from this session".
 *
 * STUB_WORKERS_JSON, when set, is a JSON array of full worker rows and takes priority over
 * the single-row STUB_WORKER_HANDLE form above — used by tests that need several rows at
 * once (e.g. the parallel-Codex-worker cap's at-cap reconciliation, which drops rows Orca
 * shows released or done). The reply carries the real `result.page = {limit, total,
 * hasMore, nextCursor}` paging shape; STUB_WORKERS_PAGE_HAS_MORE=1 / STUB_WORKERS_PAGE_CURSOR=1
 * simulate an incomplete / multi-page list (see the worker-list branch below).
 *
 * STUB_WORKTREES_JSON answers `orca worktree ps --json` with a JSON array of worktree rows.
 * A value starting with "@" is a file path instead of literal JSON, read fresh on every
 * invocation — since each call spawns a new stub process, this lets a test rewrite the file
 * between an orca-heartbeat daemon's startup baseline and its next tick, simulating a real
 * worktree transition (e.g. open -> merged) without needing a live Orca.
 *
 * STUB_WORKTREES_TRUNCATED=1 marks the `worktree ps` reply `truncated: true`, simulating a
 * page cap Orca hit — orca-heartbeat.cjs must never act on a truncated page.
 *
 * STUB_WORKTREE_PS_FAIL_UNTIL / STUB_WORKTREE_PS_GARBAGE_UNTIL (epoch ms, each independent):
 * while `Date.now()` is before the given time, `worktree ps` fails outright (non-zero exit,
 * no JSON) or exits 0 with non-JSON stdout, respectively — after that time it answers
 * normally from STUB_WORKTREES_JSON. Lets a test exercise "the first few polls fail/return
 * garbage, then recover" without any live Orca.
 *
 * STUB_WORKTREE_PS_CALLS_LOG, when set, gets one line appended (the current epoch ms) every
 * time `worktree ps` is invoked — a test can poll this file to learn exactly when the
 * daemon made its Nth call, instead of guessing a `setTimeout` delay long enough to land
 * between two ticks (a source of flakiness under CI load).
 *
 * STUB_WORKTREES_OK_FALSE=1 answers `{ ok: false }` (Orca reached the call but reports it did
 * not actually succeed) — item M4: must be treated exactly like an unreachable Orca, never
 * like "zero worktrees".
 *
 * STUB_WORKTREES_NO_ARRAY=1 answers `{ ok: true, result: {} }` — a reply that never seeded a
 * `worktrees` array at all — item M4: also must degrade to null, not to an empty list.
 */
const fs = require('fs');
const args = process.argv.slice(2);
const handle = process.env.STUB_WORKER_HANDLE;

if (args[0] === 'orchestration' && args[1] === 'worker-list') {
  // STUB_WORKERS_OK_FALSE=1 answers `{ ok: false }` — not a real worker list the gate may
  // reconcile against. The reply carries the REAL paging shape: `result.page = {limit,
  // total, hasMore, nextCursor}` (there is no `truncated` field in a worker-list reply).
  if (process.env.STUB_WORKERS_OK_FALSE === '1') {
    process.stdout.write(JSON.stringify({ ok: false }));
    process.exit(0);
  }
  let workers;
  if (process.env.STUB_WORKERS_JSON) {
    try { workers = JSON.parse(process.env.STUB_WORKERS_JSON); } catch { workers = []; }
  } else {
    workers = handle ? [{
      dispatchId: process.env.STUB_DISPATCH_ID || 'ctx_stub_1',
      taskId: 'task_stub_1',
      agentTerminalHandle: handle,
      terminalState: process.env.STUB_TERMINAL_STATE || 'active',
      workerState: process.env.STUB_WORKER_STATE || 'running',
      dispatchStatus: 'running',
      resource: { id: 'res_stub_1' },
      projection: { role: 'worker' },
    }] : [];
  }
  // Paging variants:
  //   STUB_WORKERS_PAGE_HAS_MORE=1 — page claims more rows exist but hands out no cursor
  //     (hasMore: true, nextCursor: null): the gate must treat the list as INCOMPLETE and
  //     disable its "absent from the list => settle" leg.
  //   STUB_WORKERS_PAGE_CURSOR=1 — page 1 says hasMore with nextCursor "stub-page-2"; a
  //     follow-up call with `--cursor stub-page-2` answers page 2 (rows from
  //     STUB_WORKERS_PAGE2_JSON, default none) with hasMore: false. Exercises the gate's
  //     cursor-following within its 5s budget.
  const cursorIdx = args.indexOf('--cursor');
  const cursor = cursorIdx >= 0 ? args[cursorIdx + 1] : null;
  let page = { limit: 100, total: workers.length, hasMore: false, nextCursor: null };
  if (process.env.STUB_WORKERS_PAGE_HAS_MORE === '1') {
    page = { limit: 100, total: workers.length + 100, hasMore: true, nextCursor: null };
  } else if (process.env.STUB_WORKERS_PAGE_CURSOR === '1') {
    if (cursor === 'stub-page-2') {
      let page2 = [];
      if (process.env.STUB_WORKERS_PAGE2_JSON) {
        try { page2 = JSON.parse(process.env.STUB_WORKERS_PAGE2_JSON); } catch { page2 = []; }
      }
      page = { limit: 100, total: workers.length + page2.length, hasMore: false, nextCursor: null };
      workers = page2;
    } else {
      page = { limit: 100, total: workers.length + 1, hasMore: true, nextCursor: 'stub-page-2' };
    }
  }
  process.stdout.write(JSON.stringify({ result: { workers, page } }));
  process.exit(0);
}
if (args[0] === 'terminal' && args[1] === 'list') {
  let terminals = [];
  if (process.env.STUB_TERMINALS_JSON) {
    try { terminals = JSON.parse(process.env.STUB_TERMINALS_JSON); } catch { terminals = []; }
  }
  process.stdout.write(JSON.stringify({ result: { terminals } }));
  process.exit(0);
}
if (args[0] === 'worktree' && args[1] === 'ps') {
  if (process.env.STUB_WORKTREE_PS_CALLS_LOG) {
    try { fs.appendFileSync(process.env.STUB_WORKTREE_PS_CALLS_LOG, `${Date.now()}\n`); } catch {}
  }
  const failUntil = Number(process.env.STUB_WORKTREE_PS_FAIL_UNTIL || 0);
  if (failUntil && Date.now() < failUntil) {
    process.stderr.write('orca-stub: worktree ps temporarily unavailable\n');
    process.exit(1);
  }
  const garbageUntil = Number(process.env.STUB_WORKTREE_PS_GARBAGE_UNTIL || 0);
  if (garbageUntil && Date.now() < garbageUntil) {
    process.stdout.write('not actually json {{{');
    process.exit(0);
  }
  if (process.env.STUB_WORKTREES_OK_FALSE === '1') {
    process.stdout.write(JSON.stringify({ ok: false }));
    process.exit(0);
  }
  if (process.env.STUB_WORKTREES_NO_ARRAY === '1') {
    process.stdout.write(JSON.stringify({ ok: true, result: {} }));
    process.exit(0);
  }
  let worktrees = [];
  const raw = process.env.STUB_WORKTREES_JSON;
  if (raw) {
    try {
      const source = raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw;
      worktrees = JSON.parse(source);
    } catch { worktrees = []; }
  }
  const truncated = process.env.STUB_WORKTREES_TRUNCATED === '1';
  process.stdout.write(JSON.stringify({ result: { worktrees, truncated } }));
  process.exit(0);
}
process.stderr.write('orca-stub: unrecognised command\n');
process.exit(1);
