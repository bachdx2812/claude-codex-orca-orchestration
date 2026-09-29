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
 *
 * STUB_WORKTREES_JSON answers `orca worktree ps --json` with a JSON array of worktree rows.
 * A value starting with "@" is a file path instead of literal JSON, read fresh on every
 * invocation — since each call spawns a new stub process, this lets a test rewrite the file
 * between an orca-heartbeat daemon's startup baseline and its next tick, simulating a real
 * worktree transition (e.g. open -> merged) without needing a live Orca.
 */
const fs = require('fs');
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
if (args[0] === 'worktree' && args[1] === 'ps') {
  let worktrees = [];
  const raw = process.env.STUB_WORKTREES_JSON;
  if (raw) {
    try {
      const source = raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw;
      worktrees = JSON.parse(source);
    } catch { worktrees = []; }
  }
  process.stdout.write(JSON.stringify({ result: { worktrees } }));
  process.exit(0);
}
process.stderr.write('orca-stub: unrecognised command\n');
process.exit(1);
