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
 * shows released or done).
 */
const args = process.argv.slice(2);
const handle = process.env.STUB_WORKER_HANDLE;

if (args[0] === 'orchestration' && args[1] === 'worker-list') {
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
  process.stdout.write(JSON.stringify({ result: { workers } }));
  process.exit(0);
}
if (args[0] === 'terminal' && args[1] === 'list') {
  process.stdout.write(JSON.stringify({ result: { terminals: [] } }));
  process.exit(0);
}
process.stderr.write('orca-stub: unrecognised command\n');
process.exit(1);
