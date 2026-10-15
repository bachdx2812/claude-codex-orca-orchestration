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

function fixture(name, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `retired-coders-${name}-`));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ activation: 'always', replyLanguage: null,
    maxParallelCodexWorkers: 0, maxParallelAgents: 0, disabledGates: [], ...config }));
  return { root, stateDir, configFile, env: {
    ...BASE, ORCH_STATE_DIR: stateDir, ORCH_CONFIG_PATH: configFile,
    ORCA_BIN: ORCA_STUB, ORCH_CODEX_BIN: CODEX_STUB, CODEX_BIN: CODEX_STUB,
  } };
}
function gate(env, payload) {
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(payload), encoding: 'utf8', env, timeout: 60000, killSignal: 'SIGKILL' });
}
function prompt(f, sid, text) {
  return gate(f.env, { session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: text });
}
function state(f, sid) {
  return JSON.parse(fs.readFileSync(path.join(f.stateDir, `${sid}.json`), 'utf8'));
}
function execAgent(f, sid) {
  const file = path.join(f.stateDir, `${sid}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).execAgent : undefined;
}

{
  const f = fixture('keys', {
    kimiHandoffUsedPercent: 70,
    maxParallelDeepseekWorkers: 2,
    models: { kimi: { alias: 'legacy' } },
  });
  const config = require('../hooks/lib/config.cjs');
  const previous = process.env.ORCH_CONFIG_PATH;
  process.env.ORCH_CONFIG_PATH = f.configFile;
  const cfg = config.loadConfig();
  if (previous === undefined) delete process.env.ORCH_CONFIG_PATH; else process.env.ORCH_CONFIG_PATH = previous;
  const warnings = cfg.warnings.filter((warning) => /retired keys ignored/.test(warning));
  check('retired config keys produce exactly one warning', warnings.length, 1);
  ok('the warning names every retired key', ['kimiHandoffUsedPercent', 'maxParallelDeepseekWorkers', 'models.kimi']
    .every((key) => warnings[0].includes(key)));
  const run = gate(f.env, { session_id: 'keys', hook_event_name: 'SessionStart' });
  check('the gate still runs with retired keys present', run.status, 0);
}

{
  const f = fixture('gate-name', { disabledGates: ['max-parallel-kimi-workers'] });
  const run = gate(f.env, { session_id: 'gate-name', hook_event_name: 'SessionStart' });
  ok('a retired gate name is reported as retired', /retired gate name/.test(`${run.stdout}${run.stderr}`));
  ok('a retired gate name is not reported as unknown', !/unknown gate name/.test(`${run.stdout}${run.stderr}`));
}

{
  const f = fixture('persisted');
  fs.writeFileSync(path.join(f.stateDir, 'persisted.json'), JSON.stringify({
    session_id: 'persisted', created: new Date().toISOString(), execAgent: 'kimi:k2', workers: {},
    reservations: {}, agentClaims: {}, agents: {}, backgroundShells: {},
  }));
  gate(f.env, { session_id: 'persisted', hook_event_name: 'SessionStart' });
  check('a retired persisted execution override resets to null', state(f, 'persisted').execAgent, null);
}

{
  const f = fixture('flags');
  const retired = prompt(f, 'flags', '--exec-kimi');
  ok('the retired shortcut prints a notice', /--exec-kimi is retired/.test(retired.stdout));
  check('the retired shortcut does not change execution state', execAgent(f, 'flags'), undefined);
  const ignored = prompt(f, 'flags', '--code-model deepseek');
  ok('a retired code model is ignored', /ignored --code-model deepseek/.test(ignored.stdout));
  check('the retired code model leaves execution state unchanged', execAgent(f, 'flags'), undefined);
}

{
  const f = fixture('generic-cap', { maxParallelAgents: 1 });
  const payload = (toolUseId, task) => ({ session_id: 'generic-cap', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_use_id: toolUseId,
    tool_input: { command: `orca orchestration worker-start --agent kimi --task ${task} --json` }, cwd: ROOT });
  const first = gate(f.env, payload('toolu_generic_1', 'first'));
  check('the first arbitrary worker is admitted', first.status, 0);
  const run = gate(f.env, payload('toolu_generic_2', 'second'));
  ok('an arbitrary retired-agent name has no coder-specific cap', !/max-parallel-kimi-workers/.test(run.stderr));
  ok('the arbitrary worker still counts against max-parallel-agents',
    run.status === 2 && /max-parallel-agents/.test(run.stderr));
}

if (failures.length) {
  console.error(`FAIL (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`PASS (${passed} checks)`);
