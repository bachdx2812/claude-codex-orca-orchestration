#!/usr/bin/env node
'use strict';

// A wedged `codex app-server` (never answers, ignores SIGTERM/SIGINT) must degrade the
// live quota probe to "unknown" within its deadline instead of blocking the hook.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CODEX_STUB = path.join(__dirname, 'fixtures', 'codex-app-server-stub.cjs');
const QUOTA = path.join(ROOT, 'hooks', 'lib', 'exec-route-by-quota.cjs');
try { fs.chmodSync(CODEX_STUB, 0o755); } catch {}

const failures = [];
let passed = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-probe-timeout-'));
const pidFile = path.join(root, 'stub.pid');
const script = `
  const q = require(${JSON.stringify(QUOTA)});
  const r = q.codexQuota(Date.now(), { stateDir: ${JSON.stringify(path.join(root, 'state'))}, cacheSeconds: 60 });
  process.stdout.write(JSON.stringify({ quota: r }));
`;
const started = Date.now();
const run = spawnSync(process.execPath, ['-e', script], {
  encoding: 'utf8',
  timeout: 15000,
  killSignal: 'SIGKILL',
  env: {
    ...process.env, ORCH_CODEX_BIN: CODEX_STUB, CODEX_BIN: CODEX_STUB,
    STUB_CODEX_MODE: 'ignore-signals', STUB_CODEX_PID_FILE: pidFile,
    CODEX_SESSIONS_DIR: path.join(root, 'empty-sessions'),
  },
});
const elapsed = Date.now() - started;

check('wedged codex binary does not hit the outer kill', run.error ? String(run.error.code) : null, null);
check('wedged codex binary yields quota unknown', JSON.parse(run.stdout || '{}').quota, null);
check('wedged codex binary returns within the probe deadline', elapsed < 8000, true);

// The stub ignores SIGTERM, so it only disappears if the probe escalated to SIGKILL.
let alive = false;
try {
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 20; i += 1) {
    try { process.kill(pid, 0); alive = true; } catch { alive = false; break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  if (alive) { try { process.kill(pid, 'SIGKILL'); } catch {} }
} catch {}
check('wedged codex child is killed, not orphaned', alive, false);

fs.rmSync(root, { recursive: true, force: true });
if (failures.length) {
  console.error(`FAIL (${failures.length})`);
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log(`PASS (${passed} checks)`);
