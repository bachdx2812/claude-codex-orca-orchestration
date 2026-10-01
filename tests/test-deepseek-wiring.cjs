#!/usr/bin/env node
/**
 * DeepSeek (opencode) third-coder wiring, review blocker 3 and blocker 4 items b/e/f/h:
 *   - the opencode 402 "Insufficient Balance" matcher and the gate's coder-exhausted path;
 *   - the max-parallel-deepseek-workers cap, including a `--retry-of` an opencode group
 *     that must stay opencode (never relabeled Codex) and an untracked terminal that must
 *     resolve to unknown, not Codex;
 *   - pickNextCoder with opencode/deepseek; and
 *   - the DeepSeek quota probe: cap 0 = unlimited, an exhausted balance = 100% used, the
 *     midnight cache boundary, and the API key never reaching stdout or the cache.
 *
 * Hermetic: `orca` and `opencode` are deterministic local stubs, state lives under a fresh
 * ORCH_STATE_DIR, and ORCH_OPENCODE_DB points at a non-existent file so the probe never
 * reads this machine's real opencode store.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GATE = path.join(ROOT, 'hooks', 'orchestrator-gate.cjs');
const PROBE = path.join(ROOT, 'hooks', 'lib', 'deepseek-quota-probe.cjs');
const ORCA_STUB = path.join(__dirname, 'fixtures', 'orca-stub.cjs');
const BALANCE_SERVER = path.join(__dirname, 'fixtures', 'deepseek-balance-server.cjs');
for (const file of [ORCA_STUB, BALANCE_SERVER]) try { fs.chmodSync(file, 0o755); } catch {}

/** Run the balance fixture as its own process (a spawned probe blocks this one). */
function startBalanceServer(extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BALANCE_SERVER], {
      env: { ...process.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; let errors = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/PORT (\d+)/);
      if (match && !child.resolved) { child.resolved = true; resolve({ child, port: Number(match[1]), output: () => output, errors: () => errors }); }
    });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => { if (!child.resolved) reject(new Error(`balance server exited ${code}: ${errors}`)); });
  });
}
function stopServer(server) {
  if (!server || server.child.exitCode !== null) return Promise.resolve();
  server.child.kill('SIGTERM');
  return new Promise((resolve) => server.child.once('exit', resolve));
}

const quota = require('../hooks/lib/exec-route-by-quota.cjs');
const signals = require('../hooks/lib/terminal-signals.cjs');
const handover = require('../hooks/lib/worker-quota-handover.cjs');

const BASE = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(ORCHESTRATOR_GATE|ORCH_|ORCA_TERMINAL_HANDLE|CODEX_HOME|CLAUDE_CODE_|STUB_|DEEPSEEK_API_KEY|XDG_DATA_HOME)/.test(key)));

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
function ok(name, value) { check(name, !!value, true); }

/** An opencode stub: `auth list` names DeepSeek; `stats` emits an incrementing cost. */
function makeOpencodeStub(dir) {
  const file = path.join(dir, 'opencode-stub.cjs');
  const count = path.join(dir, 'opencode-stats-count');
  fs.writeFileSync(file, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'list') { process.stdout.write('\\u25cf deepseek\\n'); process.exit(0); }
if (args[0] === 'stats') {
  let n = 0;
  try { n = Number(fs.readFileSync(${JSON.stringify(count)}, 'utf8')) || 0; } catch {}
  n += 1;
  fs.writeFileSync(${JSON.stringify(count)}, String(n));
  process.stdout.write('| deepseek/deepseek-flash |\\n|  Cost  $' + n + '.00 |\\n');
  process.exit(0);
}
process.exit(0);
`);
  fs.chmodSync(file, 0o755);
  return { file, count };
}

function fixture(name, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `deepseek-wiring-${name}-`));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const { file: opencodeStub } = makeOpencodeStub(root);
  const opencodeConfig = path.join(root, 'opencode.jsonc');
  fs.writeFileSync(opencodeConfig, JSON.stringify({
    model: options.opencodeModel === undefined ? 'deepseek/deepseek-flash' : options.opencodeModel,
  }));
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    activation: 'always', replyLanguage: null,
    models: {
      review: { alias: 'opus', id: 'claude-opus-5-5' },
      escalation: { alias: 'fable', id: null }, code: { alias: 'sonnet', id: null },
      lookup: { alias: 'haiku', id: null }, codex: { alias: null, id: 'gpt-5.6-sol' },
    },
    codexHandoffUsedPercent: 95, kimiHandoffUsedPercent: 95, deepseekHandoffUsedPercent: 95,
    deepseekRole: options.deepseekRole || 'overflow',
    deepseekDailySpendCapUsd: options.deepseekCapUsd || 0,
    coderAvailabilityCacheSeconds: 600, deepseekQuotaCacheSeconds: 60,
    maxParallelCodexWorkers: options.codexCap ?? 0,
    maxParallelKimiWorkers: options.kimiCap ?? 0,
    maxParallelDeepseekWorkers: options.deepseekCap ?? 0,
    maxParallelAgents: 0, execFallbackWhenCodexUnavailable: 'sonnet', disabledGates: [],
  }));
  const env = {
    ...BASE,
    ORCH_STATE_DIR: stateDir, ORCH_CONFIG_PATH: configFile,
    ORCA_BIN: ORCA_STUB,
    ORCH_CODEX_BIN: path.join(root, 'missing-codex'),
    ORCH_KIMI_HOME: path.join(root, 'kimi-home'),
    ORCH_KIMI_BIN: path.join(root, 'missing-kimi'),
    ORCH_KIMI_USAGE_URL: 'http://127.0.0.1:9/usages',
    ORCH_OPENCODE_BIN: opencodeStub,
    ORCH_OPENCODE_CONFIG: opencodeConfig,
    ORCH_OPENCODE_DB: path.join(root, 'no-opencode.db'),
  };
  return { root, stateDir, env, opencodeStub, opencodeConfig, configFile };
}

function gate(env, payload) {
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(payload), encoding: 'utf8', env });
}
const preBash = (env, sid, toolUseId, command) => gate(env, {
  session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash',
  tool_use_id: toolUseId, tool_input: { command }, cwd: ROOT,
});
const postBash = (env, sid, toolUseId, command, stdout) => gate(env, {
  session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Bash',
  tool_use_id: toolUseId, tool_input: { command }, tool_response: { stdout, stderr: '' },
});
function state(stateDir, sid) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, `${sid}.json`), 'utf8'));
}

// --- (b) 402 matcher + coder-exhausted path -------------------------------------------
{
  check('402 matcher accepts an error-shaped insufficient-balance box',
    signals.hasDeepseekBalanceExhausted('■ Insufficient Balance'), true);
  check('402 matcher accepts a 402-tagged line',
    signals.hasDeepseekBalanceExhausted('402 Insufficient Balance'), true);
  check('402 matcher accepts an error:-prefixed line',
    signals.hasDeepseekBalanceExhausted('error: insufficient balance'), true);
  check('402 matcher accepts a warning-marked line',
    signals.hasDeepseekBalanceExhausted('⚠ insufficient balance'), true);
  check('402 matcher ignores plain prose',
    signals.hasDeepseekBalanceExhausted('The docs describe the Insufficient Balance error.'), false);
  check('402 matcher ignores a quoted/markdown line',
    signals.hasDeepseekBalanceExhausted('> Insufficient Balance'), false);
  check('402 matcher ignores an unrelated error',
    signals.hasDeepseekBalanceExhausted('■ Rate limit exceeded'), false);
  check('402 matcher ignores a normal balance line',
    signals.hasDeepseekBalanceExhausted('■ Balance funding is fine'), false);
}

// --- (e) max-parallel-deepseek-workers cap + retry-of labelling ------------------------
{
  const f = fixture('cap', { deepseekCap: 1 });
  const sid = 'deepseek-cap-session';
  const start = 'orca orchestration worker-start --agent opencode --json';
  const first = preBash(f.env, sid, 'toolu_ds_1', start);
  check('a first opencode worker-start is admitted', first.status, 0);
  postBash(f.env, sid, 'toolu_ds_1', start,
    '{"ok":true,"result":{"dispatchId":"ctx_ds_1","agentTerminalHandle":"term_ds_1"}}');
  check('the opencode worker is tracked as opencode',
    state(f.stateDir, sid).workers.ctx_ds_1.agent, 'opencode');

  const second = preBash(f.env, sid, 'toolu_ds_2', start);
  ok('a second opencode worker-start is refused by the DeepSeek cap',
    second.status === 2 && /max-parallel-deepseek-workers/.test(second.stderr));

  // A bare `--retry-of` the live opencode group is a replacement, not a new slot.
  const retry = preBash(f.env, sid, 'toolu_ds_3', 'orca orchestration worker-start --retry-of ctx_ds_1 --json');
  check('--retry-of a live opencode group is admitted (replacement, not a new slot)', retry.status, 0);

  // An untracked --retry-of resolves to unknown, never Codex.
  const ghost = preBash(f.env, sid, 'toolu_ds_ghost', 'orca orchestration worker-start --retry-of ctx_missing --json');
  check('an untracked --retry-of is admitted (no codex cap applies)', ghost.status, 0);
  postBash(f.env, sid, 'toolu_ds_ghost', 'orca orchestration worker-start --retry-of ctx_missing --json',
    '{"ok":true,"result":{"dispatchId":"ctx_ds_ghost"}}');
  check('an untracked --retry-of worker is stored as unknown, never codex',
    state(f.stateDir, sid).workers.ctx_ds_ghost.agent, null);
  fs.rmSync(f.root, { recursive: true, force: true });
}

// A retry of a SETTLED opencode group is a new slot but still counts against DeepSeek.
{
  const f = fixture('settled-retry', { deepseekCap: 1, codexCap: 1 });
  const sid = 'deepseek-settled-retry';
  const start = 'orca orchestration worker-start --agent opencode --json';
  preBash(f.env, sid, 'toolu_sr_1', start);
  postBash(f.env, sid, 'toolu_sr_1', start, '{"ok":true,"result":{"dispatchId":"ctx_sr_old"}}');
  postBash(f.env, sid, 'toolu_sr_release', 'orca orchestration worker-release --dispatch ctx_sr_old --json',
    '{"ok":true,"result":{}}');
  check('releasing the opencode group settles it', state(f.stateDir, sid).workers.ctx_sr_old.status, 'settled');
  // A second live opencode worker fills the DeepSeek cap.
  preBash(f.env, sid, 'toolu_sr_2', start);
  postBash(f.env, sid, 'toolu_sr_2', start, '{"ok":true,"result":{"dispatchId":"ctx_sr_live"}}');
  // Retrying the settled group opens a new DeepSeek slot and must be refused at the cap.
  const retry = preBash(f.env, sid, 'toolu_sr_3', 'orca orchestration worker-start --retry-of ctx_sr_old --json');
  ok('retrying a settled opencode group counts against the DeepSeek cap',
    retry.status === 2 && /max-parallel-deepseek-workers/.test(retry.stderr));
  fs.rmSync(f.root, { recursive: true, force: true });
}

// --- (b) gate 402 -> coder-exhausted.json ----------------------------------------------
{
  const f = fixture('exhausted');
  const sid = 'deepseek-exhausted-session';
  const start = 'orca orchestration worker-start --agent opencode --json';
  preBash(f.env, sid, 'toolu_ex_1', start);
  postBash(f.env, sid, 'toolu_ex_1', start,
    '{"ok":true,"result":{"dispatchId":"ctx_ex_1","agentTerminalHandle":"term_ex_1"}}');
  const screen = '■ 402 Insufficient Balance';
  postBash(f.env, sid, 'toolu_ex_read', 'orca orchestration worker-read --dispatch ctx_ex_1 --json',
    JSON.stringify({ ok: true, result: { preview: screen } }));
  const marker = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'coder-exhausted.json'), 'utf8'));
  ok('a tracked opencode 402 writes the deepseek exhaustion marker',
    marker.deepseek && marker.deepseek.reason === 'insufficient balance (402)');

  // The same text from a Codex worker must not mark DeepSeek exhausted.
  fs.rmSync(path.join(f.stateDir, 'coder-exhausted.json'));
  preBash(f.env, sid, 'toolu_ex_cx', 'orca orchestration worker-start --agent codex --json');
  postBash(f.env, sid, 'toolu_ex_cx', 'orca orchestration worker-start --agent codex --json',
    '{"ok":true,"result":{"dispatchId":"ctx_ex_cx","agentTerminalHandle":"term_ex_cx"}}');
  postBash(f.env, sid, 'toolu_ex_cx_read', 'orca orchestration worker-read --dispatch ctx_ex_cx --json',
    JSON.stringify({ ok: true, result: { preview: screen } }));
  check('the same 402 from a Codex worker does not mark DeepSeek exhausted',
    fs.existsSync(path.join(f.stateDir, 'coder-exhausted.json')), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

// --- (f) pickNextCoder with opencode/deepseek -----------------------------------------
{
  check('opencode hands over to the first non-self coder in the order',
    handover.pickNextCoder('opencode', { order: ['codex', 'kimi'] }), 'codex');
  check('an opencode worker with no order hands over to an eligible subscription coder',
    handover.pickNextCoder('opencode', { order: [], coders: { kimi: { state: 'eligible' } } }), 'kimi');
  check('a Codex worker hands over to an eligible Kimi',
    handover.pickNextCoder('codex', { order: [], coders: { kimi: { state: 'eligible' } } }), 'kimi');
  check('a standby overflow DeepSeek is never a handover target',
    handover.pickNextCoder('codex', { order: [], coders: { deepseek: { state: 'eligible', standby: true } } }), 'sonnet');
  check('an eligible, non-standby DeepSeek is a handover target',
    handover.pickNextCoder('kimi', { order: [], coders: { deepseek: { state: 'eligible' } } }), 'deepseek');
  check('no eligible coder hands over to Sonnet',
    handover.pickNextCoder('codex', { order: [], coders: {} }), 'sonnet');
}

// --- (h) DeepSeek quota probe: cap, balance, midnight, no key leak --------------------
async function run() {
  // Cap 0 = unlimited: 0% used, flagged unlimited, spend still recorded.
  {
    const f = fixture('unlimited');
    const result = quota.deepseekQuota(Date.now(), {
      stateDir: f.stateDir, cacheSeconds: 60, dailyCapUsd: 0, env: f.env,
    });
    check('an unlimited cap reads 0% used and flags unlimited',
      [result.usedPercent, result.unlimited], [0, true]);
    fs.rmSync(f.root, { recursive: true, force: true });
  }

  // A positive cap: headroom is the remaining share of today's spend.
  {
    const f = fixture('cap-spend');
    const result = quota.deepseekQuota(Date.now(), {
      stateDir: f.stateDir, cacheSeconds: 60, dailyCapUsd: 2, env: f.env,
    });
    check('a positive cap turns spend into a used percentage',
      [result.usedPercent, result.spendUsd], [50, 1]);
    fs.rmSync(f.root, { recursive: true, force: true });
  }

  // An unreadable spend with a positive cap is UNKNOWN, never exhausted.
  {
    const f = fixture('unreadable-spend');
    const broken = path.join(f.root, 'opencode-broken.cjs');
    fs.writeFileSync(broken, '#!/usr/bin/env node\nprocess.exit(7);\n'); fs.chmodSync(broken, 0o755);
    const result = quota.deepseekQuota(Date.now(), {
      stateDir: f.stateDir, cacheSeconds: 60, dailyCapUsd: 5,
      env: { ...f.env, ORCH_OPENCODE_BIN: broken },
    });
    check('an unreadable spend with a positive cap is a failed reading',
      result.failed === true, true);
    fs.rmSync(f.root, { recursive: true, force: true });
  }

  // An exhausted balance reads 100% used whatever the cap, and the API key never leaks.
  {
    const KEY = 'deepseek-fixture-key-never-leak';
    const server = await startBalanceServer({ STUB_DEEPSEEK_TOKEN: KEY });
    const f = fixture('balance');
    const env = {
      ...f.env, DEEPSEEK_API_KEY: KEY,
      ORCH_DEEPSEEK_BALANCE_URL: `http://127.0.0.1:${server.port}/user/balance`,
    };
    const result = quota.deepseekQuota(Date.now(), { stateDir: f.stateDir, cacheSeconds: 60, dailyCapUsd: 10, env });
    check('a zero balance reads as 100% used', [result.usedPercent, result.limitReached], [100, true]);
    const cacheText = fs.readFileSync(path.join(f.stateDir, 'deepseek-quota-live.json'), 'utf8');
    ok('the deepseek quota cache never contains the API key', !cacheText.includes(KEY));
    const direct = spawnSync(process.execPath, [PROBE], { encoding: 'utf8', env });
    ok('the probe output never contains the API key', !String(direct.stdout).includes(KEY));
    ok('the probe output is the expected shape', /"ok":true/.test(String(direct.stdout)));
    // The child's stdout pipe may still be draining when it exits; let it flush first.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const balanceOutput = server.output();
    await stopServer(server);
    ok('the probe sent the key only in the request header', balanceOutput.includes('AUTH true'));
    fs.rmSync(f.root, { recursive: true, force: true });
  }

  // Midnight: yesterday's cached reading must never carry into today.
  {
    const f = fixture('midnight');
    const midnight = new Date(); midnight.setHours(24, 0, 0, 0);
    const t1 = midnight.getTime() - 10 * 60 * 1000;
    const t2 = midnight.getTime() + 10 * 60 * 1000;
    const first = quota.deepseekQuota(t1, { stateDir: f.stateDir, cacheSeconds: 3600, dailyCapUsd: 10, env: f.env });
    const second = quota.deepseekQuota(t2, { stateDir: f.stateDir, cacheSeconds: 3600, dailyCapUsd: 10, env: f.env });
    check('a cached reading is used within the same day', first.spendUsd, 1);
    check('a reading does not carry across local midnight', second.spendUsd, 2);
    fs.rmSync(f.root, { recursive: true, force: true });
  }

  process.stdout.write(`${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
    process.exitCode = 1;
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
