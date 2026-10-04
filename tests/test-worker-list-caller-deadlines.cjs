#!/usr/bin/env node
/**
 * Each real worker-list caller (orchestrator-gate.cjs, orca-heartbeat.cjs,
 * orca-resume-scheduler.cjs) now passes an overall `deadlineAt` into the shared
 * `orca-worker-list-pages.cjs` helper, bounding its own total wall time instead of only
 * each page's own per-call timeout. These run each caller against the real `orca-stub.cjs`
 * fixture in a fresh child process (ORCA_BIN must be set before the hook module is
 * required, since each caller reads it into a module-level const at load time), so a
 * caller's actual paging path — not the shared helper alone — is exercised.
 *
 * Run: node tests/test-worker-list-caller-deadlines.cjs (or `npm test`)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const STUB = path.join(__dirname, 'fixtures', 'orca-stub.cjs');
try { fs.chmodSync(STUB, 0o755); } catch {}

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function runInChild(expr, env) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-list-caller-'));
  const res = spawnSync(process.execPath, ['-e', expr], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ORCA_BIN: STUB,
      ORCH_STATE_DIR: stateDir,
      ORCH_CONFIG_PATH: path.join(stateDir, 'no-such-config.json'),
      ...env,
    },
  });
  if (res.status !== 0) {
    throw new Error(`child exited ${res.status}: ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

// --- orchestrator-gate.cjs: orcaWorkerHandles() -----------------------------------------
// Rows spread over two pages: a handle that only exists on page 2 must still be found.
{
  const out = runInChild(`
    const gate = require(${JSON.stringify(path.join(__dirname, '..', 'hooks', 'orchestrator-gate.cjs'))});
    const handles = gate.orcaWorkerHandles();
    process.stdout.write(JSON.stringify(handles ? Array.from(handles) : null));
  `, {
    STUB_WORKERS_JSON: JSON.stringify([{
      dispatchId: 'ctx_page1', agentTerminalHandle: 'term_page1',
      terminalState: 'active', resource: { id: 'res_page1' }, projection: { role: 'worker' },
    }]),
    STUB_WORKERS_PAGE_CURSOR: '1',
    STUB_WORKERS_PAGE2_JSON: JSON.stringify([{
      dispatchId: 'ctx_page2', agentTerminalHandle: 'term_page2',
      terminalState: 'active', resource: { id: 'res_page2' }, projection: { role: 'worker' },
    }]),
  });
  check('gate orcaWorkerHandles: a handle on page 2 is still found', out.includes('term_page2'), true);
}

// A page-2 failure is a non-zero `execFileSync` exit, which the gate's own `threw` flag
// turns into null for the whole call — unchanged from before paging existed.
{
  const out = runInChild(`
    const gate = require(${JSON.stringify(path.join(__dirname, '..', 'hooks', 'orchestrator-gate.cjs'))});
    const handles = gate.orcaWorkerHandles();
    process.stdout.write(JSON.stringify(handles ? Array.from(handles) : null));
  `, {
    STUB_WORKERS_JSON: JSON.stringify([{
      dispatchId: 'ctx_page1', agentTerminalHandle: 'term_page1',
      terminalState: 'active', resource: { id: 'res_page1' }, projection: { role: 'worker' },
    }]),
    STUB_WORKERS_PAGE_CURSOR: '1', STUB_WORKERS_PAGE2_ERROR: '1',
  });
  check('gate orcaWorkerHandles: a page-2 failure returns null', out, null);
}

// --- orca-heartbeat.cjs: workers() -------------------------------------------------------
// Rows spread over two pages: all rows across both pages come back.
{
  const out = runInChild(`
    const hb = require(${JSON.stringify(path.join(__dirname, '..', 'hooks', 'orca-heartbeat.cjs'))});
    const rows = hb.workers();
    process.stdout.write(JSON.stringify(rows ? rows.map((w) => w.dispatchId) : null));
  `, {
    STUB_WORKERS_JSON: JSON.stringify([{ dispatchId: 'hb_page1' }]),
    STUB_WORKERS_PAGE_CURSOR: '1',
    STUB_WORKERS_PAGE2_JSON: JSON.stringify([{ dispatchId: 'hb_page2' }]),
  });
  check('heartbeat workers(): rows from both pages are collected',
    out, ['hb_page1', 'hb_page2']);
}

// A page-2 failure is a genuine `ok: false` reply, which `workers()` treats as "worker-list
// is unavailable right now" — null, not a partial list (documented contract).
{
  const out = runInChild(`
    const hb = require(${JSON.stringify(path.join(__dirname, '..', 'hooks', 'orca-heartbeat.cjs'))});
    const rows = hb.workers();
    process.stdout.write(JSON.stringify(rows));
  `, {
    STUB_WORKERS_JSON: JSON.stringify([{ dispatchId: 'hb_page1' }]),
    STUB_WORKERS_PAGE_CURSOR: '1', STUB_WORKERS_PAGE2_ERROR: '1',
  });
  check('heartbeat workers(): a page-2 failure returns null, not a partial list', out, null);
}

// --- orca-resume-scheduler.cjs: workerHandles() ------------------------------------------
// Rows spread over two pages: an authorized handle on page 2 is still found.
{
  const out = runInChild(`
    const rs = require(${JSON.stringify(path.join(__dirname, '..', 'hooks', 'orca-resume-scheduler.cjs'))});
    const handles = rs.workerHandles();
    process.stdout.write(JSON.stringify(handles ? Array.from(handles) : null));
  `, {
    STUB_WORKERS_JSON: JSON.stringify([{
      dispatchId: 'ctx_rs1', agentTerminalHandle: 'term_rs1', workerState: 'running', terminalState: 'active',
    }]),
    STUB_WORKERS_PAGE_CURSOR: '1',
    STUB_WORKERS_PAGE2_JSON: JSON.stringify([{
      dispatchId: 'ctx_rs2', agentTerminalHandle: 'term_rs2', workerState: 'running', terminalState: 'active',
    }]),
  });
  check('resume-scheduler workerHandles(): a handle on page 2 is still found',
    out.includes('term_rs2'), true);
}

// A page-2 failure returns null outright (the scheduler's own `failed` flag), same as
// before paging existed.
{
  const out = runInChild(`
    const rs = require(${JSON.stringify(path.join(__dirname, '..', 'hooks', 'orca-resume-scheduler.cjs'))});
    const handles = rs.workerHandles();
    process.stdout.write(JSON.stringify(handles ? Array.from(handles) : null));
  `, {
    STUB_WORKERS_JSON: JSON.stringify([{
      dispatchId: 'ctx_rs1', agentTerminalHandle: 'term_rs1', workerState: 'running', terminalState: 'active',
    }]),
    STUB_WORKERS_PAGE_CURSOR: '1', STUB_WORKERS_PAGE2_ERROR: '1',
  });
  check('resume-scheduler workerHandles(): a page-2 failure returns null', out, null);
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
