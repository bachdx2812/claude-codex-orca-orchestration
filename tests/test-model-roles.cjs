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
let dispatchCounter = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}

function dispatch(description, model, subagentType = 'general-purpose', prompt = '') {
  dispatchCounter += 1;
  return spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({
      session_id: `role-${dispatchCounter}`,
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      cwd: ROOT,
      tool_use_id: `toolu_role_${dispatchCounter}`,
      tool_input: { description, model, subagent_type: subagentType, prompt },
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
  ['Read-only: advise why parser tests keep failing', 'opus', 0, null, 'general-purpose'],
  ['Find a way forward', 'opus', 0, null, 'kongming', 'Read-only: advice only, no edits.'],
  ['Unblock: parser tests keep failing after 3 fixes', 'opus', 2, 'review-model-scope', 'general-purpose'],
  ['Find a way forward', 'opus', 2, 'review-model-scope', 'kongming'],
  ['Advise on the plan, then implement it', 'opus', 2, 'review-model-scope', 'general-purpose'],
  ['Unblock the design and build the parser', 'opus', 2, 'review-model-scope', 'general-purpose'],
  ['Update the auth module', 'opus', 2, 'review-model-scope', 'advisor'],
  ['Update the auth module', 'opus', 2, 'review-model-scope', 'kongming'],
];

for (const [description, model, status, refusal, subagentType, prompt] of roleCases) {
  const result = dispatch(description, model, subagentType, prompt);
  check(`${JSON.stringify(description)} on ${model} exit`, result.status, status);
  if (refusal) check(`${JSON.stringify(description)} refusal`, result.stderr.includes(refusal), true);
}

const advice = gateModule.classifyDispatch(
  'Unblock: parser tests keep failing after 3 fixes', 'general-purpose', 'Read-only: advice only.', []);
check('explicit read-only marker makes unblock advice', [advice.wantsAdvice, advice.wantsExec], [true, false]);

const typedWithoutMarker = gateModule.classifyDispatch('Find a way forward', 'kongming', '', []);
check('kongming type alone is not advice',
  [typedWithoutMarker.wantsAdvice, typedWithoutMarker.wantsExec], [false, false]);

const executionRepros = [
  ['Advise on the plan, then implement it', 'general-purpose'],
  ['Unblock the design and build the parser', 'general-purpose'],
  ['Advise then edit the gate', 'general-purpose'],
  ['Advise on the plan, then write the parser', 'general-purpose'],
  ['Advise, then modify the auth module', 'general-purpose'],
  ['Unblock: rewrite the config loader', 'general-purpose'],
  ['Consult then patch the bug', 'general-purpose'],
  ['Unblock then delete the old file', 'general-purpose'],
  ['Advise and add a retry to fetch()', 'general-purpose'],
  ['Update the auth module', 'advisor'],
  ['Update the auth module', 'kongming'],
  ['Rename the module', 'advisor'],
  ['Remove dead code in gate', 'advisor'],
  ['Add tests for retry', 'advisor'],
  ['Create a new hook file', 'advisor'],
  ['Patch the parser', 'advisor'],
  ['Rewrite the loader', 'advisor'],
  ['Modify config.cjs', 'advisor'],
  ['Apply the fix', 'advisor'],
  ['Make the edits', 'advisor'],
  ['Updating the auth module', 'advisor'],
  ['Review the auth module and update it', 'advisor'],
  ['Verify then update auth', 'advisor'],
];
for (const [description, subagentType] of executionRepros) {
  const classified = gateModule.classifyDispatch(description, subagentType, '', []);
  check(`${JSON.stringify(description)} on ${subagentType} is execution, not advice`,
    [classified.wantsExec, classified.wantsAdvice], [true, false]);
  const result = dispatch(description, 'opus', subagentType);
  check(`${JSON.stringify(description)} cannot use opus without marker`,
    result.status === 2 && /review-model-scope/.test(result.stderr), true);
}

const markedMutation = dispatch('Implement the parser fix', 'opus', 'kongming',
  'Read-only: advice only, no edits. Explain how the parser should be changed.');
check('read-only marker keeps a mutation discussion advice-only on opus', markedMutation.status, 0);
const markedClassification = gateModule.classifyDispatch(
  'Implement the parser fix', 'kongming', 'Read-only: advice only, no edits.', []);
check('read-only marker overrides code verbs by contract',
  [markedClassification.wantsAdvice, markedClassification.wantsExec], [true, false]);

const promptMutation = gateModule.classifyDispatch(
  'Find a way forward', 'kongming', 'Edit hooks/x.cjs and implement the change.', []);
check('mutation intent in the prompt prevents an unmarked kongming advice route',
  [promptMutation.wantsExec, promptMutation.wantsAdvice], [true, false]);
const promptMutationResult = dispatch('Find a way forward', 'opus', 'kongming',
  'Edit hooks/x.cjs and implement the change.');
check('unmarked prompt mutation follows code routing',
  promptMutationResult.status === 2 && /review-model-scope/.test(promptMutationResult.stderr), true);
const promptExec = gateModule.classifyDispatch(
  'Find a way forward', 'kongming', 'Implement the parser change.', []);
check('execution intent in the prompt prevents an unmarked kongming advice route',
  [promptExec.wantsExec, promptExec.wantsAdvice], [true, false]);
const lateMarker = gateModule.classifyDispatch(
  'Find a way forward', 'kongming', `${'Context only. '.repeat(40)}\nRead-only: advice only, no edits.`, []);
check('read-only marker is recognized anywhere in the prompt',
  [lateMarker.wantsAdvice, lateMarker.wantsExec], [true, false]);

const banner = spawnSync(process.execPath, [GATE], {
  input: JSON.stringify({ session_id: 'role-banner', hook_event_name: 'SessionStart', source: 'startup' }),
  encoding: 'utf8', env,
});
check('session banner summarizes the role split',
  /code -> sonnet-coder; plan\/red-team\/review\/advice with Read-only: marker -> opus; lookup -> haiku/.test(banner.stdout), true);

fs.rmSync(runDir, { recursive: true, force: true });
if (failures.length) {
  console.error(`FAIL (${failures.length})`);
  failures.forEach((failure) => console.error(`  - ${failure}`));
  process.exit(1);
}
console.log(`PASS (${passed} checks)`);
