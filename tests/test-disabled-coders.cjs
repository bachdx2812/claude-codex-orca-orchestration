#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GATE = path.join(ROOT, 'hooks', 'orchestrator-gate.cjs');
const ORCA_STUB = path.join(__dirname, 'fixtures', 'orca-stub.cjs');
const CODEX_STUB = path.join(__dirname, 'fixtures', 'codex-app-server-stub.cjs');
for (const file of [ORCA_STUB, CODEX_STUB]) try { fs.chmodSync(file, 0o755); } catch {}

const BASE = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(ORCHESTRATOR_GATE|ORCH_|ORCA_TERMINAL_HANDLE|CODEX_HOME|CLAUDE_CODE_|STUB_CODEX_)/.test(key)));
let passed = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
function ok(name, value) { check(name, !!value, true); }

function withEnv(values, fn) {
  const before = {};
  for (const [key, value] of Object.entries(values)) {
    before[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function fixture(name, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `disabled-coders-${name}-`));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    activation: 'always', replyLanguage: null, maxParallelAgents: 0,
    maxParallelCodexWorkers: 0, disabledGates: [], disabledCoders: [], ...config,
  }));
  return { root, stateDir, configFile, env: {
    ...BASE, ORCH_STATE_DIR: stateDir, ORCH_CONFIG_PATH: configFile,
    ORCA_BIN: ORCA_STUB, ORCH_CODEX_BIN: CODEX_STUB, CODEX_BIN: CODEX_STUB,
  } };
}

function gate(env, payload) {
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(payload), encoding: 'utf8', env });
}

const configLib = require('../hooks/lib/config.cjs');
const availabilityLib = require('../hooks/lib/coder-availability.cjs');
const poolLib = require('../hooks/lib/coder-pool-route.cjs');

{
  const f = fixture('default');
  const cfg = withEnv({ ORCH_CONFIG_PATH: f.configFile }, () => configLib.loadConfig());
  check('default disabledCoders is empty', cfg.disabledCoders, []);
}

{
  const f = fixture('normalized', { disabledCoders: ['Codex', 'codex'] });
  const cfg = withEnv({ ORCH_CONFIG_PATH: f.configFile }, () => configLib.loadConfig());
  check('disabledCoders normalizes and deduplicates Codex', cfg.disabledCoders, ['codex']);
}

{
  const f = fixture('env', { disabledCoders: [] });
  const cfg = withEnv({ ORCH_CONFIG_PATH: f.configFile, ORCH_DISABLED_CODERS: 'codex,bogus' },
    () => configLib.loadConfig());
  check('the environment override keeps known coders',
    withEnv({ ORCH_DISABLED_CODERS: 'codex,bogus' }, () => configLib.disabledCoders(cfg)), ['codex']);
  ok('the environment override warns about unknown names',
    cfg.warnings.some((warning) => /unknown coder name.*bogus/.test(warning)));
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disabled-availability-'));
  const result = availabilityLib.coderAvailability({
    stateDir: root, fresh: true, disabled: ['codex'], env: { ...BASE, ORCH_CODEX_BIN: CODEX_STUB },
  });
  check('disabled availability wins over probing',
    [result.codex.disabled, result.codex.usable, result.codex.reason], [true, false, 'disabled by config']);
}

{
  const pool = poolLib.pickCoderPool({
    availability: { codex: { usable: true } }, quotas: { codex: { usedPercent: 10 } },
    thresholds: { codex: 95 }, disabled: ['codex'], fallbackEnabled: true,
  });
  check('a disabled Codex routes to the in-session coder', [pool.route, pool.pick], ['code', null]);
}

{
  const f = fixture('gate', { disabledCoders: ['codex'] });
  const command = 'orca orchestration worker-start --agent codex --spec "Implement feature. Owns: n/a isolated worktree. Verify: npm test."';
  const denied = gate(f.env, { session_id: 'deny', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_use_id: 'toolu_deny', tool_input: { command }, cwd: ROOT });
  ok('the coder-disabled gate refuses a disabled Codex worker',
    denied.status === 2 && /coder-disabled/.test(denied.stderr));
}

if (failures.length) {
  console.error(`FAIL (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`PASS (${passed} checks)`);
