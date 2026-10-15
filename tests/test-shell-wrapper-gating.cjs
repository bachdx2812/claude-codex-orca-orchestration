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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `shell-wrapper-${name}-`));
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
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(payload), encoding: 'utf8', env, timeout: 60000, killSignal: 'SIGKILL' });
}
function prompt(env, sid, text) {
  return gate(env, { session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: text });
}

const INNER = `orca orchestration worker-start --agent codex --worktree new-child --spec "Implement change. Verify: npm test."`;
const q = (s) => `'${s}'`;
const WRAPPED = [
  ['direct', INNER],
  ['bash -lc', `bash -lc ${q(INNER)}`],
  ['bash -ec', `bash -ec ${q(INNER)}`],
  ['bash -l -c', `bash -l -c ${q(INNER)}`],
  ['bash --norc -c', `bash --norc -c ${q(INNER)}`],
  ['bash -o pipefail -c', `bash -o pipefail -c ${q(INNER)}`],
  ['zsh -c', `zsh -c ${q(INNER)}`],
  ['dash -c', `dash -c ${q(INNER)}`],
  ['ksh -c', `ksh -c ${q(INNER)}`],
  ['sh -euc', `sh -euc ${q(INNER)}`],
  ['/bin/zsh -lc', `/bin/zsh -lc ${q(INNER)}`],
  ['env bash -lc', `env bash -lc ${q(INNER)}`],
  ['nested', `bash -lc "sh -c 'orca orchestration worker-start --agent codex --worktree new-child --spec x'"`],
  ['eval', `eval ${q(INNER)}`],
  ['here-string', `bash <<< ${q(INNER)}`],
  ['echo | bash', `echo ${q(INNER)} | bash`],
  ['printf | sh', `printf ${q(INNER)} | sh`],
  ['printf %s | sh', `printf '%s\\n' ${q(INNER)} | sh`],
];
const f = fixture('wrapper');
let n = 0;
function pre(command) {
  n += 1;
  return gate(f.env, { session_id: `wrapper-${n}`, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_use_id: `toolu_wrapper_${n}`, cwd: ROOT, tool_input: { command } });
}
for (const [name, command] of WRAPPED) {
  const r = pre(command);
  ok(`${name} fresh Codex start is denied like the direct command`,
    r.status === 2 && /codex-not-requested/.test(r.stderr));
}
for (const command of [
  'bash -lc "ls"', 'bash -l -c "ls"', 'zsh -c "ls"', 'eval "ls"', 'bash <<< "ls"',
  'echo orca | grep x', 'echo "orca orchestration worker-start --agent codex" | grep x',
  'printf "orca" | cat', 'echo orca | bash -s',
]) {
  check(`harmless ${command} stays allowed`, pre(command).status, 0);
}

// Deep eval nesting fails closed (denied) and quickly, not open.
{
  const { orcaInvocations } = require(path.join(ROOT, 'hooks', 'lib', 'shell-orca-invocations.cjs'));
  const deep = 'eval '.repeat(5000) + INNER;
  const start = Date.now();
  const found = orcaInvocations(deep);
  const elapsed = Date.now() - start;
  ok('5000-deep eval chain is flagged', found.length > 0);
  ok(`5000-deep eval chain scans quickly (${elapsed}ms)`, elapsed < 200);
  const r = pre(deep);
  ok('5000-deep eval chain is denied', r.status === 2 && /codex-not-requested/.test(r.stderr));
  check('deep eval of a harmless command stays allowed', pre('eval '.repeat(5000) + 'ls').status, 0);
  const deepBash = 'eval '.repeat(20) + `bash -c ${q(INNER)}`;
  ok('eval chain wrapping bash -c is denied', pre(deepBash).status === 2);
}

// More wrapper / stdin forms.
for (const [name, command] of [
  ['heredoc into bash', `bash <<EOF\n${INNER}\nEOF`],
  ['heredoc via cat | bash', `cat <<EOF | bash\n${INNER}\nEOF`],
  ['tee in pipe', `echo ${q(INNER)} | tee /tmp/x | bash`],
  ['|& bash', `echo ${q(INNER)} |& bash`],
  ['builtin eval', `builtin eval ${q(INNER)}`],
  ['process substitution', `bash <(echo ${q(INNER)})`],
  ['source /dev/stdin', `source /dev/stdin <<< ${q(INNER)}`],
  ['timeout wrapper', `timeout 5 bash -c ${q(INNER)}`],
  ['timeout plain orca', `timeout -s KILL 5 ${INNER}`],
  ['nice -n wrapper', `nice -n 5 bash -c ${q(INNER)}`],
  ['nice plain orca', `nice ${INNER}`],
  ['nohup plain orca', `nohup ${INNER}`],
  ['command wrapper', `command bash -lc ${q(INNER)}`],
  ['exec plain orca', `exec ${INNER}`],
]) {
  const r = pre(command);
  ok(`${name} fresh Codex start is denied`, r.status === 2 && /codex-not-requested/.test(r.stderr));
}

// Stdin is a script only when the shell reads stdin.
for (const command of [
  `echo ${q(INNER)} | bash script.sh`,
  `bash script.sh <<< ${q(INNER)}`,
  `bash --version <<< ${q(INNER)}`,
  `bash <<EOF\nls\nEOF`,
  `cat <<EOF\n${INNER}\nEOF`,
]) {
  check(`stdin not executed: ${command.split('\n')[0]}`, pre(command).status, 0);
}

fs.rmSync(f.root, { recursive: true, force: true });
if (failures.length) {
  console.error(`FAIL (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`PASS (${passed} checks)`);
