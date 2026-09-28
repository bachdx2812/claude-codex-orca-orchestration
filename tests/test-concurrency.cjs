#!/usr/bin/env node
/**
 * Genuine multi-process concurrency test for the parallel-Codex-worker cap (fix-round-1
 * item 1: "the lock does not serialize"). Before that fix, `main()` loaded session state
 * ONCE before any lock was ever acquired, so every concurrent hook process computed its
 * cap check and reservation against the same stale snapshot, and whichever process saved
 * last silently overwrote every other process's reservation — N processes racing a cap of
 * 2 would ALL be admitted, not just 2.
 *
 * This spawns N real `node orchestrator-gate.cjs` child processes AT ONCE (child_process
 * spawn, not sequential execFileSync), all issuing a PreToolUse `orca orchestration
 * worker-start --agent codex` against the SAME session id with maxParallelCodexWorkers=2,
 * and asserts exactly 2 are admitted (exit 0) and the rest are refused (exit 2).
 *
 * Run: node tests/test-concurrency.cjs (or `npm test`)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GATE = path.join(__dirname, '..', 'hooks', 'orchestrator-gate.cjs');
const STUB = path.join(__dirname, 'fixtures', 'orca-stub.cjs');
try { fs.chmodSync(STUB, 0o755); } catch {}

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-concurrency-'));
const STATE_DIR = path.join(RUN_DIR, 'state');
fs.mkdirSync(STATE_DIR, { recursive: true });
const CONFIG_FILE = path.join(RUN_DIR, 'orchestration.config.json');
fs.writeFileSync(CONFIG_FILE, JSON.stringify({
  activation: 'always',
  maxParallelCodexWorkers: 2,
  disabledGates: [],
}));

const BASE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    !/^(ORCHESTRATOR_GATE|ORCH_|ORCA_TERMINAL_HANDLE|CODEX_HOME|CLAUDE_CODE_)/.test(k))
);
const ENV = {
  ...BASE_ENV,
  ORCH_STATE_DIR: STATE_DIR,
  ORCH_CONFIG_PATH: CONFIG_FILE,
  ORCA_BIN: STUB, CODEX_BIN: STUB,
};

const SID = 'concurrency-race';
const N = 6;
const CAP = 2;

function spawnOne(i) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      session_id: SID, hook_event_name: 'PreToolUse', effort: 'high',
      tool_name: 'Bash',
      tool_input: { command: `orca orchestration worker-start --agent codex --task race${i}` },
      tool_use_id: `toolu_race_${i}`,
    });
    const child = spawn(process.execPath, [GATE], { env: ENV });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ i, code, stderr }));
    child.stdin.write(payload);
    child.stdin.end();
  });
}

async function main() {
  let pass = 0;
  const failures = [];

  // Fire all N hook processes at the same instant — Promise.all starts every spawn()
  // synchronously in this loop before any of their event loops can complete, so their
  // PreToolUse critical sections genuinely overlap in wall-clock time.
  const results = await Promise.all(Array.from({ length: N }, (_, i) => spawnOne(i)));

  const admitted = results.filter((r) => r.code === 0);
  const refused = results.filter((r) => r.code === 2);
  const other = results.filter((r) => r.code !== 0 && r.code !== 2);

  if (admitted.length === CAP) pass += 1;
  else failures.push(`expected exactly ${CAP} admitted under a real concurrent race, got ${admitted.length} (results: ${JSON.stringify(results.map((r) => r.code))})`);

  if (refused.length === N - CAP) pass += 1;
  else failures.push(`expected exactly ${N - CAP} refused, got ${refused.length}`);

  if (other.length === 0) pass += 1;
  else failures.push(`unexpected exit codes: ${JSON.stringify(other)}`);

  for (const r of refused) {
    if (/max-parallel-codex-workers/.test(r.stderr)) pass += 1;
    else failures.push(`refused process ${r.i} did not name the cap gate: ${r.stderr.slice(0, 200)}`);
  }

  // The saved state must also reflect exactly CAP live reservations/workers for this
  // session — proving the race was resolved by real mutual exclusion, not by coincidence
  // in which processes happened to exit first.
  try {
    const stateFile = path.join(STATE_DIR, `${SID}.json`);
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const liveReservations = Object.values(st.reservations || {}).filter((r) => r.codexSlot).length;
    if (liveReservations === CAP) pass += 1;
    else failures.push(`expected exactly ${CAP} codex reservations saved to disk, got ${liveReservations} (${JSON.stringify(st.reservations)})`);
  } catch (err) {
    failures.push(`could not read final state file: ${err.message}`);
  }

  fs.rmSync(RUN_DIR, { recursive: true, force: true });

  console.log(`${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main();
