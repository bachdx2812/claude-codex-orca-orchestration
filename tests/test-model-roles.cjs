#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GATE = path.join(ROOT, 'hooks', 'orchestrator-gate.cjs');
const gateModule = require(GATE);
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-roles-'));
const stateDir = path.join(runDir, 'state');
const configFile = path.join(runDir, 'config.json');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(configFile, JSON.stringify({
  activation: 'always', defaultCoder: 'sonnet', maxParallelAgents: 0,
  maxParallelCodexWorkers: 0, disabledGates: [],
}));

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(ORCHESTRATOR_GATE|ORCH_|ORCA_TERMINAL_HANDLE|CODEX_HOME|CLAUDE_CODE_)/.test(key))),
  ORCH_STATE_DIR: stateDir,
  ORCH_CONFIG_PATH: configFile,
};

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}

function dispatch(description, model, subagentType = 'general-purpose') {
  return spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({
      session_id: `role-${passed}-${failures.length}`,
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      cwd: ROOT,
      tool_use_id: `toolu_role_${passed}_${failures.length}`,
      tool_input: { description, model, subagent_type: subagentType, prompt: 'Read-only advice.' },
    }),
    encoding: 'utf8',
    env,
  });
}

const roleCases = [
  ['Plan the auth feature', 'opus', 0, null, 'general-purpose'],
  ['Plan the auth feature', 'sonnet', 2, 'route-review', 'general-purpose'],
  ['Red-team plans/x/plan.md', 'opus', 0, null, 'general-purpose'],
  ['Red-team plans/x/plan.md', 'sonnet', 2, 'route-review', 'general-purpose'],
  ['Review plan phase-02', 'opus', 0, null, 'general-purpose'],
  ['Unblock: parser tests keep failing after 3 fixes', 'opus', 0, null, 'general-purpose'],
  ['Find a way forward', 'opus', 0, null, 'kongming'],
];

for (const [description, model, status, refusal, subagentType] of roleCases) {
  const result = dispatch(description, model, subagentType);
  check(`${JSON.stringify(description)} on ${model} exit`, result.status, status);
  if (refusal) check(`${JSON.stringify(description)} refusal`, result.stderr.includes(refusal), true);
}

const advice = gateModule.classifyDispatch(
  'Unblock: parser tests keep failing after 3 fixes', 'general-purpose', '', []);
check('unblock is advice, not execution', [advice.wantsAdvice, advice.wantsExec], [true, false]);

const typedAdvice = gateModule.classifyDispatch('Find a way forward', 'kongming', '', []);
check('kongming type is advice', [typedAdvice.wantsAdvice, typedAdvice.wantsExec], [true, false]);

const execWins = gateModule.classifyDispatch('Unblock and fix the parser', 'advisor', '', []);
check('explicit fix intent wins over advice', [execWins.wantsExec, execWins.wantsAdvice], [true, false]);
const execResult = dispatch('Unblock and fix the parser', 'opus', 'advisor');
check('advice wording cannot bypass execution routing',
  execResult.status === 2 && /review-model-scope|execution-model-mismatch/.test(execResult.stderr), true);

const banner = spawnSync(process.execPath, [GATE], {
  input: JSON.stringify({ session_id: 'role-banner', hook_event_name: 'SessionStart', source: 'startup' }),
  encoding: 'utf8', env,
});
check('session banner summarizes the role split',
  /code -> sonnet-coder; plan\/red-team\/review\/unblock -> opus; lookup -> haiku/.test(banner.stdout), true);

fs.rmSync(runDir, { recursive: true, force: true });
if (failures.length) {
  console.error(`FAIL (${failures.length})`);
  failures.forEach((failure) => console.error(`  - ${failure}`));
  process.exit(1);
}
console.log(`PASS (${passed} checks)`);
