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

function fixture(name, config = {}, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codex-opt-in-${name}-`));
  const stateDir = path.join(root, 'state');
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    activation: 'always', replyLanguage: null, maxParallelAgents: 0,
    maxParallelCodexWorkers: 0, disabledGates: [], ...config,
  }));
  return { root, stateDir, configFile, env: {
    ...BASE, ORCH_STATE_DIR: stateDir, ORCH_CONFIG_PATH: configFile,
    ORCA_BIN: ORCA_STUB, ORCH_CODEX_BIN: CODEX_STUB, CODEX_BIN: CODEX_STUB,
    CODEX_SESSIONS_DIR: sessionsDir, ...env,
  } };
}

function gate(env, payload) {
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(payload), encoding: 'utf8', env });
}
function prompt(env, sid, text) {
  return gate(env, { session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: text });
}
function codeAgent(env, sid) {
  return gate(env, { session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_use_id: `toolu_${sid}`, cwd: ROOT, tool_input: {
      subagent_type: 'sonnet-coder', model: 'sonnet', description: 'Implement the change',
      prompt: 'Owns: n/a isolated worktree\nVerify: npm test', isolation: 'worktree',
    } });
}
function codexWorker(env, sid) {
  return gate(env, { session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_use_id: `toolu_${sid}`, cwd: ROOT, tool_input: { command:
      'orca orchestration worker-start --agent codex --worktree new-child --spec "Implement change. Owns: n/a isolated worktree. Verify: npm test."' } });
}
function postWorker(env, sid, command, stdout, toolUseId = `toolu_${sid}`) {
  return gate(env, { session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_use_id: toolUseId, cwd: ROOT, tool_input: { command },
    tool_response: { stdout, stderr: '' } });
}
function seedState(stateDir, sid, extra = {}) {
  fs.writeFileSync(path.join(stateDir, `${sid}.json`), JSON.stringify({
    session_id: sid, created: new Date().toISOString(), execAgent: null, workers: {},
    agentClaims: {}, reservations: {}, agents: {}, backgroundShells: {}, ...extra,
  }));
}

{
  const calls = path.join(os.tmpdir(), `codex-opt-in-calls-${process.pid}`);
  try { fs.unlinkSync(calls); } catch {}
  const f = fixture('default', {}, { STUB_CODEX_CALLS_LOG: calls });
  const agent = codeAgent(f.env, 'default-agent');
  check('default Sonnet code dispatch is allowed', agent.status, 0);
  check('default routing does not probe Codex', fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length : 0, 0);
  const worker = codexWorker(f.env, 'default-worker');
  ok('default Codex worker is denied by codex-not-requested', worker.status === 2 && /codex-not-requested/.test(worker.stderr));
  for (const [name, command] of [
    ['bash -c', `bash -c 'orca orchestration worker-start --agent codex --worktree new-child --spec "Implement change. Verify: npm test."'`],
    ['sh -c', `sh -c 'orca orchestration worker-start --agent codex --worktree new-child --spec "Implement change. Verify: npm test."'`],
    ['global --json', 'orca --json orchestration worker-start --agent codex --worktree new-child --spec "Implement change. Verify: npm test."'],
  ]) {
    const wrapped = gate(f.env, {
      session_id: `default-worker-${name.replace(/\W+/g, '-')}`,
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: `toolu_${name}`,
      cwd: ROOT, tool_input: { command },
    });
    ok(`${name} Codex worker is denied by codex-not-requested`,
      wrapped.status === 2 && /codex-not-requested/.test(wrapped.stderr));
  }
  ok('Codex refusal explains the task-bound tracked retry exception',
    /--retry-of.*--task equal to the original task id.*no --spec/i.test(worker.stderr));
  prompt(f.env, 'positive-control', '--exec-codex');
  codeAgent(f.env, 'positive-control');
  ok('explicit Codex routing positively controls the probe counter',
    fs.existsSync(calls) && fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length > 0);
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('override');
  prompt(f.env, 'override', '--exec-codex');
  check('explicit Codex worker is allowed', codexWorker(f.env, 'override').status, 0);
  const agent = codeAgent(f.env, 'override');
  ok('explicit Codex route refuses in-session code', agent.status === 2 && /route-execution-to-codex/.test(agent.stderr));
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('exhausted', {}, { STUB_CODEX_PRIMARY_USED: '97' });
  prompt(f.env, 'exhausted', '--exec-codex');
  const agent = codeAgent(f.env, 'exhausted');
  check('exhausted explicit Codex falls back to Sonnet', agent.status, 0);
  const reminder = prompt(f.env, 'exhausted', 'status');
  ok('exhausted fallback names the measured quota', /codex requested but quota 97% used/i.test(reminder.stdout));
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('tracked-retry');
  const sid = 'tracked-retry';
  prompt(f.env, sid, '--exec-codex');
  const command = 'orca orchestration worker-start --agent codex --worktree new-child --spec "Implement change. Owns: n/a isolated worktree. Verify: npm test."';
  check('opted-in Codex dispatch is initially allowed', gate(f.env, {
    session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: `toolu_${sid}`,
    cwd: ROOT, tool_input: { command },
  }).status, 0);
  postWorker(f.env, sid, command, JSON.stringify({ ok: true, result: {
    dispatchId: 'ctx_tracked_retry', taskId: 'task_tracked_retry', handle: 'term_tracked_retry',
  } }));
  prompt(f.env, sid, '--exec-sonnet');
  const retryCommand = 'orca orchestration worker-start --agent codex --task task_tracked_retry --retry-of ctx_tracked_retry';
  const retry = gate(f.env, { session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_use_id: 'toolu_retry', cwd: ROOT, tool_input: { command: retryCommand } });
  check('tracked Codex dispatch may be retried after switching back to Sonnet', retry.status, 0);
  for (const [name, duplicateCommand] of [
    ['duplicate --task', 'orca orchestration worker-start --agent codex --task task_tracked_retry --task task_new --retry-of ctx_tracked_retry'],
    ['duplicate --agent', 'orca orchestration worker-start --agent kimi --agent codex --task task_tracked_retry --retry-of ctx_tracked_retry'],
    ['fresh duplicate --agent', 'orca orchestration worker-start --agent kimi --agent codex --spec "Implement fresh work. Owns: n/a isolated. Verify: npm test."'],
    ['duplicate --retry-of', 'orca orchestration worker-start --agent codex --task task_tracked_retry --retry-of ctx_tracked_retry --retry-of ctx_other'],
    ['duplicate --terminal', 'orca orchestration worker-start --terminal term_one --terminal=term_two --task task_tracked_retry'],
    ['duplicate --spec', 'orca orchestration worker-start --agent codex --spec "Implement one. Verify: npm test." --spec "Implement two. Verify: npm test."'],
    ['duplicate --spec= forms', 'orca orchestration worker-start --agent=codex --spec="Implement one. Verify: npm test." --spec="Implement two. Verify: npm test."'],
    ['mixed duplicate --spec forms', 'orca orchestration worker-start --agent=codex --spec "Implement one. Verify: npm test." --spec="Implement two. Verify: npm test."'],
  ]) {
    const duplicate = gate(f.env, { session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_use_id: `toolu_${name.replace(/\W+/g, '_')}`, cwd: ROOT, tool_input: { command: duplicateCommand } });
    ok(`${name} is refused clearly`,
      duplicate.status === 2 && /orca-duplicate-flag/.test(duplicate.stderr) && /repeated/.test(duplicate.stderr));
  }
  for (const [name, duplicateCommand] of [
    ['dispatch', 'orca orchestration dispatch --agent codex --agent=claude'],
    ['worker-retain', 'orca orchestration worker-retain --terminal term_one --terminal=term_two'],
  ]) {
    const duplicate = gate(f.env, { session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_use_id: `toolu_duplicate_${name}`, cwd: ROOT, tool_input: { command: duplicateCommand } });
    ok(`${name} shares duplicate identity-flag refusal`,
      duplicate.status === 2 && /orca-duplicate-flag/.test(duplicate.stderr));
  }
  const newSpec = gate(f.env, { session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_use_id: 'toolu_retry_new_spec', cwd: ROOT, tool_input: { command:
      'orca orchestration worker-start --agent codex --spec "Implement another change. Owns: n/a. Verify: npm test." --retry-of ctx_tracked_retry' } });
  ok('retry-of cannot launder a fresh Codex spec',
    newSpec.status === 2 && /codex-not-requested/.test(newSpec.stderr));
  const differentTask = gate(f.env, { session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_use_id: 'toolu_retry_different_task', cwd: ROOT, tool_input: { command:
      'orca orchestration worker-start --agent codex --task task_different --retry-of ctx_tracked_retry' } });
  ok('retry-of must carry the original task id',
    differentTask.status === 2 && /codex-not-requested/.test(differentTask.stderr));
  const missingTask = gate(f.env, { session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_use_id: 'toolu_retry_missing_task', cwd: ROOT, tool_input: { command:
      'orca orchestration worker-start --agent codex --retry-of ctx_tracked_retry' } });
  ok('retry-of without a task id is refused',
    missingTask.status === 2 && /codex-not-requested/.test(missingTask.stderr));
  postWorker(f.env, sid, retryCommand, JSON.stringify({ ok: true, result: {
    dispatchId: 'ctx_retry_child', taskId: 'task_tracked_retry', handle: 'term_retry_child',
  } }), 'toolu_retry');
  const chainedRetry = gate(f.env, { session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_use_id: 'toolu_retry_chain', cwd: ROOT, tool_input: { command:
      'orca orchestration worker-start --agent codex --task task_tracked_retry --retry-of ctx_retry_child' } });
  ok('a retry does not extend opt-in provenance to another retry',
    chainedRetry.status === 2 && /codex-not-requested/.test(chainedRetry.stderr));
  const fresh = codexWorker(f.env, sid);
  ok('fresh Codex dispatch stays refused after switching back to Sonnet',
    fresh.status === 2 && /codex-not-requested/.test(fresh.stderr));
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('unproven-retry');
  seedState(f.stateDir, 'unproven-retry', { workers: {
    ctx_legacy_codex: { status: 'settled', group: 'ctx_legacy_codex', agent: 'codex' },
  } });
  const retry = gate(f.env, { session_id: 'unproven-retry', hook_event_name: 'PreToolUse',
    tool_name: 'Bash', tool_use_id: 'toolu_unproven_retry', cwd: ROOT, tool_input: {
      command: 'orca orchestration worker-start --agent codex --task task_legacy --retry-of ctx_legacy_codex',
    } });
  ok('tracked Codex retry without opt-in provenance is refused',
    retry.status === 2 && /codex-not-requested/.test(retry.stderr));
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('config-default', { defaultCoder: 'codex' });
  check('config defaultCoder Codex allows a worker', codexWorker(f.env, 'config-default').status, 0);
  prompt(f.env, 'config-default', '--exec-sonnet');
  check('explicit Sonnet overrides config default', codeAgent(f.env, 'config-default').status, 0);
  const reset = prompt(f.env, 'config-default', '--exec-auto');
  ok('--exec-auto names the configured default', /back to default \(codex\)/.test(reset.stdout));
  ok('--exec-auto restores config default', codeAgent(f.env, 'config-default').status === 2);
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('invalid-default', { defaultCoder: 'banana' });
  const start = gate(f.env, { session_id: 'invalid-default', hook_event_name: 'SessionStart' });
  ok('invalid defaultCoder warns and falls back to Sonnet',
    /defaultCoder "banana" is not sonnet\|codex; using "sonnet"/.test(start.stdout));
  check('invalid defaultCoder still allows Sonnet code', codeAgent(f.env, 'invalid-default').status, 0);
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('env-default', {}, { ORCH_DEFAULT_CODER: 'codex' });
  check('ORCH_DEFAULT_CODER can opt one process into Codex', codexWorker(f.env, 'env-default').status, 0);
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('retired', { disabledCoders: ['codex'] });
  const start = gate(f.env, { session_id: 'retired', hook_event_name: 'SessionStart' });
  ok('disabledCoders produces only a retired-key warning',
    /CONFIG WARNING: retired keys ignored: disabledCoders/.test(start.stdout) && !/must be an array|unknown coder/.test(start.stdout));
  check('retired disabledCoders does not block default Sonnet', codeAgent(f.env, 'retired').status, 0);
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('notifications');
  const quiet = prompt(f.env, 'quiet', '<task-notification><tool-use-id>toolu_done</tool-use-id></task-notification>');
  check('notification without a live worker is silent', quiet.stdout, '');
  prompt(f.env, 'bypassed', '--no-orchestrate');
  const bypassed = prompt(f.env, 'bypassed', '<task-notification><tool-use-id>toolu_done</tool-use-id></task-notification>');
  check('notification stays silent while orchestration is bypassed', bypassed.stdout, '');
  seedState(f.stateDir, 'live', { workers: {
    ctx_live: { status: 'live', group: 'ctx_live', role: 'codex-exec', agent: 'codex', started: Date.now() },
  } });
  const live = prompt(f.env, 'live', '<task-notification><tool-use-id>toolu_done</tool-use-id></task-notification>');
  ok('notification with a live worker emits only worker and heartbeat guidance',
    /live worker/.test(live.stdout) && /NO heartbeat daemon/.test(live.stdout) &&
    !/Delegate;|code ->|parallel budget/.test(live.stdout));
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('gate-off', { disabledGates: ['codex-not-requested'] });
  const out = codexWorker(f.env, 'gate-off');
  ok('the Codex opt-in gate can itself be disabled without a crash', out.status === 0 && !/codex-not-requested/.test(out.stderr));
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('duplicate-gate-off', { disabledGates: ['orca-duplicate-flag'] });
  const out = gate(f.env, { session_id: 'duplicate-gate-off', hook_event_name: 'PreToolUse',
    tool_name: 'Bash', tool_use_id: 'toolu_duplicate_gate_off', cwd: ROOT, tool_input: {
      command: 'orca orchestration worker-start --agent kimi --agent=kimi --spec "Implement change. Verify: npm test."',
    } });
  ok('disabling duplicate refusal does not skip later worker-start gates',
    out.status === 2 && /code-brief-needs-owns/.test(out.stderr));
  fs.rmSync(f.root, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`FAIL (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`PASS (${passed} checks)`);
