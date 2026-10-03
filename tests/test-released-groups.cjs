#!/usr/bin/env node
/**
 * test-released-groups.cjs — unit coverage for the released-group settle rules fixed in the
 * review of ba59fe7:
 *
 *  1. `fetchOrcaWorkerRows` reads the REAL worker-list paging shape (`result.page.hasMore` /
 *     `nextCursor` — there is no `truncated` field): a page that is not the whole list is
 *     followed via `--cursor` within the 5s budget, and only a fully-followed list comes
 *     back `exhaustive: true`.
 *  2. `applyOwnershipHolderReconciliation` / `applyOrcaReconciliation` run their
 *     "absent from the list >10min => settle" leg ONLY on an exhaustive list — a partial
 *     view must never cost a live worker its Owns: claim.
 *
 * The end-to-end holder-overlap scoping (only same-workspace overlapping claims reconcile)
 * and the heartbeat all-rows-released rule live in test-orchestrator-gate-e2e.cjs.
 */

'use strict';

const path = require('path');
const GATES = require('../hooks/lib/parallel-ownership-gates.cjs');

const STUB = path.join(__dirname, 'fixtures', 'orca-stub.cjs');

let pass = 0;
const failures = [];
function check(name, cond) {
  if (cond) pass += 1;
  else failures.push(name);
}

const STUB_VARS = [
  'STUB_WORKER_HANDLE', 'STUB_WORKERS_JSON', 'STUB_WORKERS_OK_FALSE',
  'STUB_WORKERS_PAGE_HAS_MORE', 'STUB_WORKERS_PAGE_CURSOR', 'STUB_WORKERS_PAGE2_JSON',
  'STUB_TERMINALS_JSON', 'STUB_TERMINALS_OK_FALSE', 'STUB_TERMINALS_NO_ARRAY',
  'STUB_TERMINALS_TRUNCATED',
];
function stubEnv(vars) {
  for (const k of STUB_VARS) delete process.env[k];
  Object.assign(process.env, vars);
}

const ROW_A = { dispatchId: 'ctx_a', taskId: 'task_a', agentTerminalHandle: 'term_a',
  workerState: 'running', dispatchStatus: 'running', terminalState: 'active' };
const ROW_B = { dispatchId: 'ctx_b', taskId: 'task_b', agentTerminalHandle: 'term_b',
  workerState: 'stopped', dispatchStatus: 'failed', terminalState: 'released' };

// --- 1. paging shape ---

stubEnv({ STUB_WORKERS_JSON: JSON.stringify([ROW_A]) });
{
  const r = GATES.fetchOrcaWorkerRows(STUB);
  check('a single complete page comes back exhaustive with its rows',
    !!r && r.exhaustive === true && r.rows.length === 1 && r.rows[0].dispatchId === 'ctx_a');
}

stubEnv({ STUB_WORKERS_JSON: JSON.stringify([ROW_A]), STUB_WORKERS_PAGE_HAS_MORE: '1' });
{
  const r = GATES.fetchOrcaWorkerRows(STUB);
  check('page.hasMore with no nextCursor marks the list NOT exhaustive (absent-settle must stay off)',
    !!r && r.exhaustive === false && r.rows.length === 1);
}

stubEnv({ STUB_WORKERS_JSON: JSON.stringify([ROW_A]), STUB_WORKERS_PAGE_CURSOR: '1',
  STUB_WORKERS_PAGE2_JSON: JSON.stringify([ROW_B]) });
{
  const r = GATES.fetchOrcaWorkerRows(STUB);
  check('a hasMore page with a nextCursor is followed and merged into one exhaustive list',
    !!r && r.exhaustive === true && r.rows.length === 2 &&
      r.rows.some((w) => w.dispatchId === 'ctx_a') && r.rows.some((w) => w.dispatchId === 'ctx_b'));
}

stubEnv({ STUB_WORKERS_OK_FALSE: '1' });
{
  const r = GATES.fetchOrcaWorkerRows(STUB);
  check('an ok:false reply degrades to null', r === null);
}

for (const [name, vars] of [
  ['ok:false', { STUB_TERMINALS_OK_FALSE: '1' }],
  ['missing terminal array', { STUB_TERMINALS_NO_ARRAY: '1' }],
  ['truncated', { STUB_TERMINALS_JSON: '[]', STUB_TERMINALS_TRUNCATED: '1' }],
]) {
  stubEnv({ STUB_WORKERS_JSON: JSON.stringify([ROW_A]), ...vars });
  const r = GATES.fetchOrcaWorkerRows(STUB);
  check(`a ${name} terminal list cannot prove handles closed`,
    !!r && r.exhaustive === true && r.terminalHandles === null);
}

stubEnv({});

// --- 2. the absent-settle leg requires an exhaustive list ---

const OLD = Date.now() - 11 * 60 * 1000;
function stateWithOldGroup() {
  return { workers: {
    ctx_g: { role: 'claude-exec', status: 'live', group: 'ctx_g', kind: 'worker',
      agent: 'claude', started: OLD, owns: ['src/g/**'], ws: 'ws-g' },
    task_g: { role: 'claude-exec', status: 'live', group: 'ctx_g', kind: 'worker',
      agent: 'claude', started: OLD, owns: ['src/g/**'], ws: 'ws-g' },
  } };
}

{
  const s = stateWithOldGroup();
  const changed = GATES.applyOwnershipHolderReconciliation(s, [], ['ctx_g'], Date.now(), false);
  check('holder reconcile: absent >10min on a NON-exhaustive list settles nothing',
    changed === false && s.workers.ctx_g.status === 'live' && s.workers.task_g.status === 'live');
}
{
  const s = stateWithOldGroup();
  const changed = GATES.applyOwnershipHolderReconciliation(s, [], ['ctx_g'], Date.now(), true);
  check('holder reconcile: absent >10min on an exhaustive list settles the group',
    changed === true && s.workers.ctx_g.status === 'settled' && s.workers.task_g.status === 'settled');
}
{
  const s = stateWithOldGroup();
  // A live row in the list keeps the group even when another row (an old retry sibling
  // sharing the task id) reports released — the every-row-released rule.
  const rows = [
    { dispatchId: 'ctx_g', taskId: 'task_g', terminalState: 'active', workerState: 'running' },
    { dispatchId: 'ctx_g_old', taskId: 'task_g', terminalState: 'released', workerState: 'stopped' },
  ];
  const changed = GATES.applyOwnershipHolderReconciliation(s, rows, ['ctx_g'], Date.now(), true);
  check('holder reconcile: one live row defeats one released row for the same group',
    changed === false && s.workers.ctx_g.status === 'live');
}
{
  const s = stateWithOldGroup();
  const rows = [
    { dispatchId: 'ctx_g', taskId: 'task_g', terminalState: 'released', workerState: 'stopped' },
  ];
  const changed = GATES.applyOwnershipHolderReconciliation(s, rows, ['ctx_g'], Date.now(), false);
  check('holder reconcile: all rows released settles even on a non-exhaustive list (positive evidence)',
    changed === true && s.workers.ctx_g.status === 'settled');
}
{
  const s = stateWithOldGroup();
  const changed = GATES.applyOrcaReconciliation(s, [], false);
  check('cap reconcile: absent >10min on a NON-exhaustive list settles nothing',
    changed === false && s.workers.ctx_g.status === 'live');
}
{
  const s = stateWithOldGroup();
  const changed = GATES.applyOrcaReconciliation(s, [], true);
  check('cap reconcile: absent >10min on an exhaustive list settles',
    changed === true && s.workers.ctx_g.status === 'settled');
}
{
  const s = { workers: {
    ctx_new: { status: 'live', group: 'ctx_new', started: Date.now() },
    task_new: { status: 'live', group: 'ctx_new', started: Date.now() },
    term_reused: { status: 'live', group: 'ctx_new', started: Date.now() },
  } };
  const rows = [{ dispatchId: 'ctx_old', taskId: 'task_old', agentTerminalHandle: 'term_reused',
    workerState: 'failed', dispatchStatus: 'failed', terminalState: 'retained',
    resource: { retainedReason: 'no_owned_resource' } }];
  const holderChanged = GATES.applyOwnershipHolderReconciliation(
    s, rows, ['ctx_new'], Date.now(), false, new Set(['term_reused']));
  const capChanged = GATES.applyOrcaReconciliation(
    s, rows, false, new Set(['term_reused']));
  check('a foreign row on a reused terminal is not evidence for the new group',
    holderChanged === false && capChanged === false && s.workers.ctx_new.status === 'live' &&
      s.workers.task_new.status === 'live' && s.workers.term_reused.status === 'live');
}
{
  check('rowReportsReleased: released/closed only',
    GATES.rowReportsReleased({ terminalState: 'released' }) === true &&
    GATES.rowReportsReleased({ terminalState: 'closed' }) === true &&
    GATES.rowReportsReleased({ terminalState: 'active' }) === false &&
    GATES.rowReportsReleased({}) === false);
}

// --- 3. terminal rows with no remaining owned resource ---

const terminalRow = (overrides = {}) => ({
  dispatchId: 'ctx_terminal', taskId: 'task_terminal', runId: 'run_terminal',
  workerState: 'failed', dispatchStatus: 'failed', agentTerminalHandle: 'term_terminal',
  terminalState: 'retained',
  resource: { id: null, retainedReason: 'no_owned_resource' },
  projection: {
    id: 'ctx_terminal', stage: { worker: 'failed', dispatch: 'failed' }, outcome: 'failed',
    resource: { state: 'retained', retainedReason: 'no_owned_resource' },
  },
  ...overrides,
});

{
  const row = terminalRow();
  check('terminal no_owned_resource row reconciles',
    GATES.rowReportsReconciled(row, [row], new Set()) === true);
}
{
  const row = terminalRow({ workerState: 'running', dispatchStatus: 'running' });
  check('running no_owned_resource row never reconciles',
    GATES.rowReportsReconciled(row, [row], new Set()) === false);
}
{
  const row = terminalRow({ workerState: 'running', dispatchStatus: 'failed' });
  const s = { workers: {
    ctx_terminal: { status: 'live', group: 'ctx_terminal', started: Date.now() },
    task_terminal: { status: 'live', group: 'ctx_terminal', started: Date.now() },
  } };
  const changed = GATES.applyOrcaReconciliation(s, [row], true, new Set());
  check('disagreeing running/failed statuses never settle the group',
    GATES.rowReportsReconciled(row, [row], new Set()) === false && changed === true &&
      s.workers.ctx_terminal.status === 'live' && s.workers.task_terminal.status === 'live' &&
      s.workers.ctx_terminal.capExempt === true && s.workers.task_terminal.capExempt === true);
}
{
  const row = terminalRow({ workerState: 'succeeded', dispatchStatus: 'completed',
    resource: { id: 'resource_live', retainedReason: 'user_requested' } });
  check('user-requested retained row with a live terminal remains unreconciled',
    GATES.rowReportsReconciled(row, [row], new Set(['term_terminal'])) === false);
}
{
  const old = terminalRow({ resource: { id: 'resource_old', retainedReason: 'user_requested' } });
  const newer = terminalRow({ dispatchId: 'ctx_newer', taskId: 'task_newer',
    workerState: 'running', dispatchStatus: 'running', terminalState: 'active',
    resource: { id: 'resource_newer' } });
  check('terminal row reconciles when a newer dispatch owns its handle',
    GATES.rowReportsReconciled(old, [newer, old], new Set(['term_terminal'])) === true &&
    GATES.rowReportsReconciled(newer, [newer, old], new Set(['term_terminal'])) === false);
}
{
  const old = terminalRow({ createdAt: '2026-10-04T00:00:00.000Z',
    resource: { id: 'resource_old', retainedReason: 'user_requested' } });
  const newer = terminalRow({ dispatchId: 'ctx_newer', taskId: 'task_newer',
    createdAt: '2026-10-04T00:01:00.000Z', workerState: 'running', dispatchStatus: 'running',
    terminalState: 'active', resource: { id: 'resource_newer' } });
  check('createdAt identifies a newer reused-terminal dispatch independent of row order',
    GATES.rowReportsReconciled(old, [old, newer], new Set(['term_terminal'])) === true &&
    GATES.rowReportsReconciled(newer, [old, newer], new Set(['term_terminal'])) === false);
}
{
  const closed = terminalRow({ resource: { id: 'resource_closed', retainedReason: 'user_requested' } });
  check('terminal row reconciles when terminal-list confirms its handle closed',
    GATES.rowReportsReconciled(closed, [closed], new Set()) === true);
}

stubEnv({});
if (failures.length) {
  console.error(`FAIL ${failures.length}:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`ok ${pass} passed`);
