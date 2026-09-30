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
const EMPTY_KIMI_HOME = path.join(RUN_DIR, 'empty-kimi-home');
fs.mkdirSync(EMPTY_KIMI_HOME, { recursive: true });
function seedQuota(stateDir, usedPercent = 30) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'codex-quota-live.json'), JSON.stringify({
    usedPercent,
    resetsAt: Math.floor(Date.now() / 1000) + 3600,
    fetchedAt: Date.now(),
  }));
}
seedQuota(STATE_DIR);
const CONFIG_FILE = path.join(RUN_DIR, 'orchestration.config.json');
fs.writeFileSync(CONFIG_FILE, JSON.stringify({
  activation: 'always',
  maxParallelCodexWorkers: 2,
  disabledGates: [],
}));

const BASE_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !/^(ORCHESTRATOR_GATE|ORCH_|ORCA_TERMINAL_HANDLE|CODEX_HOME|CLAUDE_CODE_)/.test(k))),
  ORCH_KIMI_HOME: EMPTY_KIMI_HOME,
  ORCH_KIMI_BIN: path.join(RUN_DIR, 'missing-kimi'),
  ORCH_KIMI_USAGE_URL: 'http://127.0.0.1:9/usages',
};
const ENV = {
  ...BASE_ENV,
  ORCH_STATE_DIR: STATE_DIR,
  ORCH_CONFIG_PATH: CONFIG_FILE,
  ORCH_CODEX_BIN: STUB,
  ORCH_KIMI_HOME: EMPTY_KIMI_HOME,
  ORCH_KIMI_BIN: path.join(RUN_DIR, 'missing-kimi'),
  ORCH_KIMI_USAGE_URL: 'http://127.0.0.1:9/usages',
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

/**
 * Second review round, item 1: the at-cap reconcile's own Orca round trip must never let a
 * stale post-reconcile save clobber a concurrent process's real-time, lock-protected write.
 * Process A hits the cap and starts a SLOW reconcile (a stub that sleeps 2.5s before
 * replying "no workers"); while A is mid-reconcile, process B releases the one live worker
 * via a normal, fast PostToolUse. B's release must stick — A's reconcile must never
 * resurrect it back to live by saving a snapshot taken before B's write landed.
 */
async function raceReconcileTest() {
  let pass = 0;
  const failures = [];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-race-'));
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  seedQuota(stateDir);
  const configFile = path.join(dir, 'orchestration.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ activation: 'always', maxParallelCodexWorkers: 1, disabledGates: [] }));
  const slowOrca = path.join(dir, 'slow-orca.cjs');
  fs.writeFileSync(slowOrca,
    '#!/usr/bin/env node\n' +
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);\n' +
    'process.stdout.write(JSON.stringify({ result: { workers: [] } }));\n');
  fs.chmodSync(slowOrca, 0o755);
  const env = {
    ...BASE_ENV, ORCH_STATE_DIR: stateDir, ORCH_CONFIG_PATH: configFile,
    ORCA_BIN: slowOrca, CODEX_BIN: slowOrca, ORCA_DOWN_FLAG_PATH: path.join(dir, 'flag'),
  };
  const raceSid = 'race-reconcile';
  const base = (ev, cmd, id, extra) => ({
    session_id: raceSid, hook_event_name: ev, effort: 'high', tool_name: 'Bash',
    tool_input: { command: cmd }, tool_use_id: id, ...(extra || {}),
  });
  const runSync = (payload) => require('child_process').spawnSync(process.execPath, [GATE], {
    input: JSON.stringify(payload), encoding: 'utf8', env,
  });
  const runAsync = (payload) => new Promise((resolve) => {
    const child = spawn(process.execPath, [GATE], { env });
    child.on('close', (code) => resolve(code));
    child.stdin.end(JSON.stringify(payload));
  });

  // Seed one live codex worker.
  runSync(base('PreToolUse', 'orca orchestration worker-start --spec x --agent codex --json', 's1'));
  runSync(base('PostToolUse', 'orca orchestration worker-start --spec x --agent codex --json', 's1',
    { tool_response: { stdout: '{"ok":true,"result":{"dispatchId":"ctx_race_1"}}' } }));

  // A: another worker-start at cap -> triggers the slow reconcile, unlocked, up to 2.5s.
  const aPromise = runAsync(base('PreToolUse', 'orca orchestration worker-start --spec y --agent codex --json', 'a1'));
  // While A is mid-reconcile, B releases ctx_race_1 via a fast, normal PostToolUse.
  await new Promise((r) => setTimeout(r, 800));
  runSync(base('PostToolUse', 'orca orchestration worker-release --dispatch ctx_race_1 --json', 'b1',
    { tool_response: { stdout: '{"ok":true}' } }));
  await aPromise;

  const st = JSON.parse(fs.readFileSync(path.join(stateDir, `${raceSid}.json`), 'utf8'));
  if (st.workers.ctx_race_1 && st.workers.ctx_race_1.status === 'settled') pass += 1;
  else failures.push(`race-reconcile: B's release of ctx_race_1 must stick even though A's slow ` +
    `reconcile was in flight concurrently (final status: ${JSON.stringify(st.workers.ctx_race_1)})`);

  fs.rmSync(dir, { recursive: true, force: true });
  return { pass, failures };
}

/**
 * Genuine multi-process concurrency test for the MACHINE-wide max-parallel-agents cap.
 * Unlike the Codex-cap race above, each spawned process uses its OWN session id (the
 * budget is explicitly machine-wide, summed across every session's state file under one
 * shared stateDir) — this is the harder, more meaningful proof: admission must be
 * serialized correctly across DIFFERENT sessions racing the same shared file lock, not
 * merely within one session's own reservations. Each dispatch is an `Agent` call shaped to
 * pass every other gate cleanly (a lookup-agent type on the lookup model) so a refusal can
 * only ever be this cap.
 */
async function maxParallelAgentsRaceTest() {
  let pass = 0;
  const failures = [];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-agents-race-'));
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  seedQuota(stateDir);
  const configFile = path.join(dir, 'orchestration.config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    activation: 'always', maxParallelAgents: 3, maxParallelCodexWorkers: 0, disabledGates: [],
  }));
  const env = { ...BASE_ENV, ORCH_STATE_DIR: stateDir, ORCH_CONFIG_PATH: configFile, ORCA_BIN: STUB, CODEX_BIN: STUB };

  const CAP2 = 3;
  const N2 = CAP2 + 2;

  function spawnAgent(i) {
    return new Promise((resolve) => {
      const payload = JSON.stringify({
        session_id: `agents-race-${i}`, hook_event_name: 'PreToolUse', effort: 'high',
        tool_name: 'Agent',
        tool_input: { subagent_type: 'Explore', model: 'haiku', description: `lookup task ${i}` },
        tool_use_id: `toolu_agents_race_${i}`,
      });
      const child = spawn(process.execPath, [GATE], { env });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({ i, code, stderr }));
      child.stdin.write(payload);
      child.stdin.end();
    });
  }

  const results = await Promise.all(Array.from({ length: N2 }, (_, i) => spawnAgent(i)));
  const admitted = results.filter((r) => r.code === 0);
  const refused = results.filter((r) => r.code === 2);
  const other = results.filter((r) => r.code !== 0 && r.code !== 2);

  if (admitted.length === CAP2) pass += 1;
  else failures.push(`max-parallel-agents: expected exactly ${CAP2} admitted under a real cross-session race, got ${admitted.length} (${JSON.stringify(results.map((r) => r.code))})`);

  if (refused.length === N2 - CAP2) pass += 1;
  else failures.push(`max-parallel-agents: expected exactly ${N2 - CAP2} refused, got ${refused.length}`);

  if (other.length === 0) pass += 1;
  else failures.push(`max-parallel-agents: unexpected exit codes: ${JSON.stringify(other)}`);

  for (const r of refused) {
    if (/max-parallel-agents/.test(r.stderr)) pass += 1;
    else failures.push(`max-parallel-agents: refused process ${r.i} did not name the cap gate: ${r.stderr.slice(0, 200)}`);
  }

  // Exactly CAP2 registrations must exist across every session's state file on disk —
  // proving the race was resolved by real mutual exclusion across sessions, not by
  // coincidence in which processes happened to exit first.
  try {
    const files = fs.readdirSync(stateDir).filter((n) => n.endsWith('.json') && !n.endsWith('.role.json') && !n.startsWith('heartbeat-'));
    let totalAgents = 0;
    for (const f of files) {
      const st = JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8'));
      totalAgents += Object.keys(st.agents || {}).length;
    }
    if (totalAgents === CAP2) pass += 1;
    else failures.push(`max-parallel-agents: expected exactly ${CAP2} agent registrations across all session files, got ${totalAgents}`);
  } catch (err) {
    failures.push(`max-parallel-agents: could not read final state files: ${err.message}`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  return { pass, failures };
}

async function quotaProbeSingleFlightTest() {
  let pass = 0;
  const failures = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-quota-race-'));
  const stateDir = path.join(dir, 'state');
  const sessionsDir = path.join(dir, 'sessions');
  const callsLog = path.join(dir, 'codex-calls.log');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'codex-quota-live.json'), JSON.stringify({
    usedPercent: 10,
    resetsAt: Math.floor(Date.now() / 1000) + 3600,
    fetchedAt: Date.now() - 61_000,
  }));
  const quotaLib = path.join(__dirname, '..', 'hooks', 'lib', 'exec-route-by-quota.cjs');
  const codexStub = path.join(__dirname, 'fixtures', 'codex-app-server-stub.cjs');
  const env = {
    ...BASE_ENV,
    ORCH_STATE_DIR: stateDir,
    ORCH_CODEX_BIN: codexStub,
    CODEX_SESSIONS_DIR: sessionsDir,
    STUB_CODEX_PRIMARY_USED: '25',
    STUB_CODEX_CALLS_LOG: callsLog,
  };
  const spawnProbe = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e',
      'const q=require(process.argv[1]);const v=q.codexQuota(Date.now(),{stateDir:process.argv[2],cacheSeconds:60});process.stdout.write(JSON.stringify(v));',
      quotaLib, stateDir], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  const results = await Promise.all(Array.from({ length: 6 }, () => spawnProbe()));
  const calls = fs.existsSync(callsLog)
    ? fs.readFileSync(callsLog, 'utf8').trim().split('\n').filter(Boolean).length
    : 0;
  if (calls === 1) pass += 1;
  else failures.push(`quota single-flight: expected one live app-server probe, got ${calls}`);
  if (results.every((result) => result.code === 0 && result.stdout)) pass += 1;
  else failures.push(`quota single-flight: every caller must receive a quota result (${JSON.stringify(results)})`);

  fs.rmSync(dir, { recursive: true, force: true });
  return { pass, failures };
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

  const phase2 = await raceReconcileTest();
  pass += phase2.pass;
  failures.push(...phase2.failures);

  const phase3 = await maxParallelAgentsRaceTest();
  pass += phase3.pass;
  failures.push(...phase3.failures);

  const phase4 = await quotaProbeSingleFlightTest();
  pass += phase4.pass;
  failures.push(...phase4.failures);

  console.log(`${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main();
