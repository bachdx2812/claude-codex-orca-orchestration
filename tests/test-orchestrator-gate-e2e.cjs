#!/usr/bin/env node
/**
 * End-to-end checks: feed real hook payloads to orchestrator-gate.cjs as a
 * subprocess and assert the exit code, exactly as Claude Code invokes it.
 *
 * The unit tests cover the classifiers; this covers the wiring - payload
 * parsing, main-vs-subagent detection, config loading and exit code 2 as the
 * refusal signal. Fully hermetic: state lives under a fresh ORCH_STATE_DIR,
 * `orca` is a deterministic local stub selected via ORCA_BIN, and every path
 * judged by the gate is synthetic (`/work/proj/...`), never this machine's real
 * home or temp directories.
 *
 * Run: node tests/test-orchestrator-gate-e2e.cjs (or `npm test`)
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GATE = path.join(__dirname, '..', 'hooks', 'orchestrator-gate.cjs');
const STUB = path.join(__dirname, 'fixtures', 'orca-stub.cjs');
try { fs.chmodSync(STUB, 0o755); } catch {}

// The process this suite runs in may itself be an orchestrated Claude Code session (it
// is, when run under the operator's own setup) and so may carry ORCHESTRATOR_GATE,
// ORCH_*, ORCA_TERMINAL_HANDLE, CODEX_HOME or CLAUDE_CODE_* from its real environment.
// Every test env is built from this stripped base, never raw process.env, so the suite's
// outcome depends only on what each test explicitly sets.
const BASE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    !/^(ORCHESTRATOR_GATE|ORCH_|ORCA_TERMINAL_HANDLE|CODEX_HOME|CLAUDE_CODE_)/.test(k))
);

const SID = `e2e-${process.pid}`;
const SRC = '/work/proj/src/app.py'; // synthetic, not under any real tmp/home path

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-e2e-'));
const STATE_DIR = path.join(RUN_DIR, 'state');
fs.mkdirSync(STATE_DIR, { recursive: true });
// Temp Orca-fallback flag: never the real machine's ~/.claude/orchestrator-gate/orca-unavailable.
const FLAG = path.join(RUN_DIR, 'orca-unavailable');

// The default fixture config: same alias names as upstream (opus/fable/sonnet/haiku),
// activation forced to "always" so most of this suite exercises full gating regardless
// of whether an ORCA_TERMINAL_HANDLE happens to be set - dedicated activation-mode tests
// further down cover "orca-only" (the real default) and "off" explicitly. `agents.escalation`
// and `agents.lookup` are configured explicitly (never hard-coded) so the ported "escalation-agent"/
// "Explore"/"scout" cases demonstrate the config-driven mechanism, not an operator-local default.
const DEFAULT_CFG = {
  activation: 'always',
  replyLanguage: null,
  models: {
    review: { alias: 'opus', id: 'claude-opus-5-5' },
    escalation: { alias: 'fable', id: 'claude-fable-5-1' },
    code: { alias: 'sonnet', id: null },
    lookup: { alias: 'haiku', id: null },
    codex: { alias: null, id: 'gpt-5.6-sol' },
  },
  agents: { escalation: ['escalation-agent'], lookup: ['Explore', 'scout'] },
  codexHandoffUsedPercent: 40,
  heartbeat: { intervalSeconds: 20, idleSeconds: 60, maxSeconds: 3600 },
  disabledGates: [],
};
const CONFIG_FILE = path.join(RUN_DIR, 'orchestration.config.json');
fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CFG));

function quotaEnv(name, claudeUsed, codexUsed, extraCfg) {
  const dir = path.join(RUN_DIR, name);
  fs.mkdirSync(path.join(dir, 'codex', '2026', '09', '29'), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'claude.json'), JSON.stringify({ timestamp: now, status: 'available',
    data: { five_hour: { utilization: claudeUsed }, seven_day: { utilization: 1 } } }));
  fs.writeFileSync(path.join(dir, 'codex', '2026', '09', '29', 's.jsonl'), JSON.stringify({ payload: { rate_limits: {
    primary: { used_percent: codexUsed, resets_at: Math.floor(now / 1000) + 86400 } } } }) + '\n');
  let configFile = CONFIG_FILE;
  if (extraCfg) {
    configFile = path.join(dir, 'orchestration.config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CFG, ...extraCfg }));
  }
  return {
    ...BASE_ENV,
    CK_USAGE_CACHE_PATH: path.join(dir, 'claude.json'),
    CODEX_SESSIONS_DIR: path.join(dir, 'codex'),
    ORCA_DOWN_FLAG_PATH: FLAG,
    ORCH_STATE_DIR: STATE_DIR,
    ORCH_CONFIG_PATH: configFile,
    ORCA_BIN: STUB,
  };
}
const CODEX_WINS = quotaEnv('codex-wins', 10, 30);   // Codex 30% used (< 40) -> Codex codes
const SONNET_WINS = quotaEnv('sonnet-wins', 10, 75); // Codex 75% used -> the code model codes

let pass = 0;
const failures = [];

/** One hook invocation, as the CLI performs it. */
function invoke(payload, env = CODEX_WINS) {
  const r = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  });
  return { code: r.status, err: (r.stderr || '').trim(), out: r.stdout || '' };
}

function expect(name, payload, wantCode, env) {
  const { code, err } = invoke(payload, env);
  if (code === wantCode) pass += 1;
  else failures.push(`${name}\n    expected exit ${wantCode}, got ${code}\n    ${err.split('\n')[0]}`);
}

const mainBash = (command) => ({
  session_id: SID, hook_event_name: 'PreToolUse', effort: 'high',
  tool_name: 'Bash', tool_input: { command },
});
const mainEdit = (file_path, sid = SID) => ({
  session_id: sid, hook_event_name: 'PreToolUse', effort: 'high',
  tool_name: 'Edit', tool_input: { file_path },
});
const subEdit = (file_path) => ({
  session_id: SID, hook_event_name: 'PreToolUse',
  agent_id: 'ag_1', agent_type: 'general-purpose',
  tool_name: 'Edit', tool_input: { file_path },
});
const dispatch = (tool_input, sid = SID) => ({
  session_id: sid, hook_event_name: 'PreToolUse', effort: 'high',
  tool_name: 'Agent', tool_input,
});
const promptSubmit = (sid, promptText) => ({
  session_id: sid, hook_event_name: 'UserPromptSubmit', effort: 'high', prompt: promptText,
});

function readState(sid) {
  const file = path.join(STATE_DIR, `${sid}.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function rmState(sid) {
  for (const suffix of ['.json', '.role.json']) {
    try { fs.unlinkSync(path.join(STATE_DIR, `${sid}${suffix}`)); } catch {}
  }
}

const ALLOW = 0;
const DENY = 2;

// Panel write boundary
expect('panel editing product code is refused', mainEdit(SRC), DENY);
expect('panel editing the harness is allowed', mainEdit('/work/.claude/hooks/x.cjs'), ALLOW);
expect('a subagent editing product code is allowed', subEdit(SRC), ALLOW);

// The false positives found in real use, each now a permanent test
expect('heredoc containing a comparison is allowed',
  mainBash(`cat > /work/.claude/x.cjs <<'EOF'\nif (a > b) return 1;\nconst f = () => 2;\nEOF`), ALLOW);
expect('quoted text mentioning a redirect is allowed',
  mainBash('echo "compare a > b in prose"'), ALLOW);
expect('scratch cleanup beside an unrelated echo is allowed',
  mainBash('rm -rf /tmp/orch-smoke && mkdir -p /tmp/orch-smoke && echo "A OK (fix 3)"'), ALLOW);
expect('a mutating verb quoted as prose is allowed',
  mainBash('echo "we do not run git commit here"'), ALLOW);
expect('running the unit suite is allowed',
  mainBash('node tests/test-orchestrator-gate.cjs && echo done'), ALLOW);

// Still refused
expect('real commit is refused', mainBash('git commit -m x'), DENY);
expect('real push is refused', mainBash('git push origin main'), DENY);
expect('redirect into product code is refused', mainBash(`echo hi > ${SRC}`), DENY);
expect('rm of product code inside a compound line is refused',
  mainBash(`echo start && rm -rf ${SRC}`), DENY);

// Role routing
expect('planning on sonnet is refused',
  dispatch({ subagent_type: 'planner', description: 'plan the refactor', model: 'sonnet' }), DENY);
expect('planning on opus is allowed',
  dispatch({ subagent_type: 'planner', description: 'plan the refactor', model: 'opus' }), ALLOW);
expect('planning with inherited model is refused',
  dispatch({ subagent_type: 'planner', description: 'plan the refactor' }), DENY);
expect('planning on fable without escalation reason is refused',
  dispatch({ subagent_type: 'planner', description: 'plan the refactor', model: 'fable' }), DENY);
expect('a configured escalation agent (escalation-agent) without escalation reason is refused',
  dispatch({ subagent_type: 'escalation-agent', description: 'review the diff' }), DENY);
expect('planning on fable with escalation reason is allowed',
  dispatch({ subagent_type: 'planner', description: 'escalation: plan the refactor, opus failed twice at high effort', model: 'fable' }), ALLOW);
expect('escalation-agent with escalation reason in prompt is allowed',
  dispatch({ subagent_type: 'escalation-agent', description: 'review the diff', prompt: 'Opus could not resolve the race even with ultrathink; review the diff.' }), ALLOW);
expect('opus for non-review work is refused',
  dispatch({ subagent_type: 'Explore', description: 'find the config loader', model: 'opus' }), DENY);
expect('opus for execution is refused',
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'opus' }), DENY);
expect('an agent name not in the configured escalation list gets no special treatment',
  dispatch({ subagent_type: 'not-configured-agent', description: 'review the diff' }), DENY);

// Main panel vs Orca worker terminal, via the deterministic stub (never a live Orca).
expect('attended main panel is still gated',
  mainEdit(SRC), DENY, { ...CODEX_WINS, CLAUDE_CODE_SESSION_ATTENDED: '1', ORCA_TERMINAL_HANDLE: 'term_not-a-worker' });
{
  const WSID = `${SID}-worker`;
  const workerEnv = { ...CODEX_WINS, ORCA_TERMINAL_HANDLE: 'term_worker_1', STUB_WORKER_HANDLE: 'term_worker_1' };
  expect('a session in an Orca worker terminal (per the stub) is not gated',
    mainEdit(SRC, WSID), ALLOW, workerEnv);
  rmState(WSID);
  const RSID = `${SID}-released`;
  const releasedEnv = { ...CODEX_WINS, ORCA_TERMINAL_HANDLE: 'term_worker_2', STUB_WORKER_HANDLE: 'term_worker_2', STUB_TERMINAL_STATE: 'released' };
  expect('a released worker terminal is gated like any other session',
    mainEdit(SRC, RSID), DENY, releasedEnv);
  rmState(RSID);
}
expect('fable prompt that only quotes the rule name is refused',
  dispatch({ subagent_type: 'planner', description: 'plan it', model: 'fable', prompt: 'Mind the fable-escalation-only gate.' }), DENY);
expect('full fable model id without reason is refused',
  dispatch({ subagent_type: 'planner', description: 'plan it', model: 'claude-fable-5-1' }), DENY);

// Harness-injected turns must never toggle operator flags.
{
  const NSID = `${SID}-notif`;
  invoke(promptSubmit(NSID, '<task-notification>reviewer says `--no-orchestrate` still works</task-notification>'));
  const st = readState(NSID);
  if (!st || !st.bypass) pass += 1;
  else failures.push('a task-notification quoting --no-orchestrate switched the gates off');
  invoke(promptSubmit(NSID, 'the `--no-orchestrate` flag is documented'));
  const st2 = readState(NSID);
  if (!st2 || !st2.bypass) pass += 1;
  else failures.push('a backticked --no-orchestrate mention switched the gates off');
  rmState(NSID);
}
// Fable ladder: an escalation that does not name the higher effort already tried is refused.
expect('fable escalation without the effort tried is refused',
  dispatch({ subagent_type: 'planner', description: 'escalation: opus failed twice to plan it', model: 'fable' }), DENY);

// Code briefs must let the coder verify itself.
expect('sonnet code brief without a verify command is refused',
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet', prompt: 'Implement it.' }), DENY, SONNET_WINS);
expect('sonnet code brief with an explicit verify n/a reason is allowed',
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet', prompt: 'Rename copy. verify: n/a text-only change' }), ALLOW, SONNET_WINS);
expect('orca spec without a verify command is refused',
  mainBash('orca orchestration task-create --task-title "x" --spec "implement the parser"'), DENY);
expect('orca spec with a verify command is allowed',
  mainBash('orca orchestration task-create --task-title "x" --spec "implement the parser. Verify: venv/bin/python -m pytest tests/parser -q"'), ALLOW);
{
  const specFile = path.join(RUN_DIR, 'spec.md');
  fs.writeFileSync(specFile, 'Implement the parser.\nVerify: cargo test -p parser\n');
  expect('orca spec read from a file is judged by the file content',
    mainBash(`orca orchestration task-create --task-title "x" --spec "$(cat ${specFile})"`), ALLOW);
}

// Regressions from the review of the verify rule.
expect('a grep that merely mentions an orca spec is not an orca spec',
  mainBash('grep -rn "orca orchestration task-create --spec" rules'), ALLOW);
expect('worker-start --task without --spec is not gated',
  mainBash('orca orchestration worker-start --task task_abc --agent codex'), ALLOW);
expect('a research spec needs no verify command',
  mainBash('orca orchestration task-create --task-title "r" --spec "Research: summarize the docs and report"'), ALLOW);
expect('a code spec read through $(< file) is judged by the file',
  mainBash(`orca orchestration task-create --task-title "x" --spec "$(< ${path.join(RUN_DIR, 'spec.md')})"`), ALLOW);
{
  const r = invoke(mainBash('orca orchestration task-create --task-title "x" --spec "implement it $(cat /nonexistent/spec.md)"'));
  if (r.code === 2 && /Could not read spec file/.test(r.err + '')) pass += 1;
  else failures.push(`unreadable spec file should be named in the refusal (exit ${r.code})`);
}
expect('fable escalation naming opus (xhigh) is allowed',
  dispatch({ subagent_type: 'planner', description: 'escalation: opus (xhigh) failed twice to plan it', model: 'fable' }), ALLOW);

// orcaInvocations (the linear-time scanner): absolute path, leading VAR= assignment,
// wrapper commands, and $( )/backtick forms all count as a real invocation; a bare
// mention inside an echo/grep does not. A real invocation whose reply carries no
// dispatch id registers nothing (no "unlabelled-*" phantom worker) but prints a notice.
{
  const RS = `${SID}-invoke`;
  const post = (command, stdout = '{"dispatchId":"ctx_rv_1"}') => ({ session_id: RS, hook_event_name: 'PostToolUse', effort: 'high',
    tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '' } });
  const registered = (command) => {
    rmState(RS);
    invoke(post(command), CODEX_WINS);
    return !!((readState(RS) || {}).workers || {}).ctx_rv_1;
  };
  for (const c of ['/opt/local/bin/orca orchestration worker-start --task t --agent codex',
                   'ORCA_X=1 orca orchestration worker-start --task t --agent codex',
                   'id=$(orca orchestration worker-start --task t --agent codex)',
                   'id=`orca orchestration worker-start --task t --agent codex`',
                   'sudo orca orchestration worker-start --task t --agent codex',
                   'if true; then orca orchestration worker-start --task t --agent codex; fi']) {
    if (registered(c)) pass += 1; else failures.push(`real worker start not registered: ${c}`);
  }
  if (!registered('echo "orca orchestration worker-start" | cat')) pass += 1;
  else failures.push('an echo of worker-start registered a phantom worker');
  {
    rmState(RS);
    const r = invoke(post('orca orchestration worker-start --task t --agent codex', '{"no_id_here":true}'), CODEX_WINS);
    const st = readState(RS) || { workers: {} };
    const gotPhantom = Object.keys(st.workers || {}).some((k) => k.startsWith('unlabelled-'));
    if (!gotPhantom && r.out && /no dispatch id was found/.test(r.out)) pass += 1;
    else failures.push(`a worker-start with no id in the reply must print a notice and register nothing (workers: ${JSON.stringify(st.workers)})`);
  }
  rmState(RS);
}

// Operator picks the coding model directly with --code-model.
{
  const OSID = `${SID}-cm`;
  const d = (tool_input) => dispatch(tool_input, OSID);
  const code = (model) => d({ subagent_type: 'fullstack-developer', description: 'implement the plan', model,
    prompt: 'Implement it. Verify: npm test (all pass).' });
  invoke(promptSubmit(OSID, 'use opus to code this --code-model opus'), CODEX_WINS);
  expect('--code-model opus: code on opus is allowed (no review-model-scope refusal)', code('opus'), ALLOW, CODEX_WINS);
  expect('--code-model opus: code on sonnet is refused', code('sonnet'), DENY, CODEX_WINS);
  invoke(promptSubmit(OSID, '--code-model=fable'), CODEX_WINS);
  expect('--code-model fable: code on fable needs no escalation reason', code('fable'), ALLOW, CODEX_WINS);
  expect('--code-model fable: fable for non-code work still needs escalation',
    d({ subagent_type: 'planner', description: 'plan it', model: 'fable' }), DENY, CODEX_WINS);
  invoke(promptSubmit(OSID, '--code-model codex:gpt-5-custom'), SONNET_WINS);
  expect('--code-model codex:<m>: in-session code refused even when quota favours the code model', code('sonnet'), DENY, SONNET_WINS);
  {
    const st = readState(OSID);
    if (st && st.execAgent === 'codex:gpt-5-custom') pass += 1; else failures.push(`codex model override not stored (${st && st.execAgent})`);
  }
  invoke(promptSubmit(OSID, '--code-model banana'), CODEX_WINS);
  {
    const st = readState(OSID);
    if (st && st.execAgent === 'codex:gpt-5-custom') pass += 1; else failures.push('an invalid --code-model must not change the override');
  }
  invoke(promptSubmit(OSID, '--code-model auto'), CODEX_WINS);
  {
    const st = readState(OSID);
    if (st && st.execAgent === null) pass += 1; else failures.push('--code-model auto did not clear the override');
  }
  rmState(OSID);
}

// Review regressions for --code-model and the auto-route banner text.
{
  const RS = `${SID}-rv`;
  const out = spawnSync(process.execPath, [GATE], { input: JSON.stringify(promptSubmit(RS, 'status?')), encoding: 'utf8', env: SONNET_WINS }).stdout;
  if (/code -> in-session subagent \(Agent model "sonnet"\)/.test(out) && !/undefined/.test(out)) pass += 1;
  else failures.push(`auto route to the code model must name model "sonnet", never "undefined": ${out.slice(0, 200)}`);
  const bare = spawnSync(process.execPath, [GATE], { input: JSON.stringify(promptSubmit(RS, 'please --code-model')), encoding: 'utf8', env: CODEX_WINS }).stdout;
  if (/needs a value/.test(bare)) pass += 1; else failures.push('a bare --code-model must print a notice');
  invoke(promptSubmit(RS, '--code-model codex:openai/gpt-5'), CODEX_WINS);
  { const st = readState(RS); if (!st || st.execAgent == null) pass += 1; else failures.push(`a value with "/" must be rejected, not truncated (${st.execAgent})`); }
  invoke(promptSubmit(RS, '--code-model GPT-5.6-Sol'), CODEX_WINS);
  { const st = readState(RS); if (st && st.execAgent === 'codex:gpt-5.6-sol') pass += 1; else failures.push(`gpt ids must be lower-cased (${st && st.execAgent})`); }
  rmState(RS);
}

// Codex worker-start advice: non-blocking, only when --model and --terminal are both absent.
{
  const advise = (command) => invoke(mainBash(command), CODEX_WINS).out;
  const withAdvice = advise('orca orchestration worker-start --task t --agent codex');
  if (/pin the Codex model/.test(withAdvice)) pass += 1; else failures.push('worker-start without --model should get advice');
  const withModel = advise('orca orchestration worker-start --task t --agent codex --model gpt-4');
  if (!/pin the Codex model/.test(withModel)) pass += 1; else failures.push('worker-start with an explicit --model should get no advice');
  const withTerminal = advise('orca orchestration worker-start --task t --agent codex --terminal term_1');
  if (!/pin the Codex model/.test(withTerminal)) pass += 1; else failures.push('worker-start --terminal should get no advice');
  const withSpecFile = advise('orca orchestration worker-start --task t --agent codex --spec @briefs/foo.md');
  if (/pin the Codex model/.test(withSpecFile)) pass += 1; else failures.push('a --spec file should not suppress the advice');
}

// Light lookups: advised toward the lookup model, never blocked.
{
  const payload = dispatch({ subagent_type: 'Explore', description: 'find where the loader is defined' });
  const r = spawnSync(process.execPath, [GATE], { input: JSON.stringify(payload), encoding: 'utf8', env: CODEX_WINS });
  if (r.status === 0 && /Prefer model \\"haiku\\"|Prefer model "haiku"/.test(r.stdout)) pass += 1;
  else failures.push(`lookup dispatch should be allowed with a haiku advice (exit ${r.status}, stdout ${String(r.stdout).slice(0, 80)})`);
  const r2 = spawnSync(process.execPath, [GATE], { input: JSON.stringify(dispatch({ subagent_type: 'Explore', description: 'find the loader', model: 'haiku' })), encoding: 'utf8', env: CODEX_WINS });
  if (r2.status === 0 && !/haiku/.test(r2.stdout)) pass += 1;
  else failures.push('a haiku lookup dispatch should pass silently');
}

expect('in-session execution is refused',
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan' }), DENY);

// Honest, explicit, session-scoped execution-agent preference: --exec-sonnet /
// --exec-codex. Distinct from claiming Orca is down (no orca-unavailable file
// exists at this point in the run).
expect('--exec-sonnet prompt is accepted',
  promptSubmit(SID, 'run this --exec-sonnet please'), ALLOW);
{
  const st = readState(SID);
  if (st && st.execAgent === 'code') pass += 1;
  else failures.push(`--exec-sonnet did not persist execAgent='code' in state (got ${JSON.stringify(st && st.execAgent)})`);
}
expect('exec-intent dispatch on sonnet is allowed once --exec-sonnet is set',
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet', prompt: 'Implement it. Verify: npm test (all pass).' }), ALLOW);
expect('--exec-sonnet still requires model sonnet',
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan' }), DENY);
expect('plan/review routing to Opus is unaffected by --exec-sonnet',
  dispatch({ subagent_type: 'planner', description: 'plan the refactor', model: 'sonnet' }), DENY);

expect('--exec-codex prompt reverts the preference',
  promptSubmit(SID, 'back to --exec-codex'), ALLOW);
{
  const st = readState(SID);
  if (st && st.execAgent === 'codex') pass += 1;
  else failures.push(`--exec-codex did not force execAgent='codex' (got ${JSON.stringify(st && st.execAgent)})`);
}
expect('exec-intent dispatch is denied again after --exec-codex, no orca-unavailable file',
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet' }), DENY);
expect('--exec-codex beats a quota that favours the code model',
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet' }), DENY, SONNET_WINS);
expect('--exec-auto prompt is accepted', promptSubmit(SID, 'ok --exec-auto'), ALLOW);
{
  const st = readState(SID);
  if (st && st.execAgent == null) pass += 1;
  else failures.push(`--exec-auto did not clear execAgent (got ${JSON.stringify(st && st.execAgent)})`);
}
// Automatic routing: Codex first, the code model once Codex has used >= 40%.
expect('auto: Codex under 40% used -> in-session sonnet code is refused',
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet' }), DENY, CODEX_WINS);
expect('auto: Codex at/over 40% used -> in-session sonnet code is allowed',
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet', prompt: 'Implement it. Verify: npm test (all pass).' }), ALLOW, SONNET_WINS);
expect('auto: Codex at/over 40% used -> code on another model is refused',
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan' }), DENY, SONNET_WINS);

// --no-orchestrate must still fully bypass everything, unaffected by the exec-agent
// preference. Isolated session id so it cannot leak bypass state into other assertions.
{
  const BYPASS_SID = `${SID}-bypass`;
  const bypassEdit = (file_path) => mainEdit(file_path, BYPASS_SID);
  const bypassDispatch = (tool_input) => dispatch(tool_input, BYPASS_SID);

  expect('--no-orchestrate is accepted', promptSubmit(BYPASS_SID, '--no-orchestrate for this session'), ALLOW);
  expect('bypass allows the main panel to edit product code', bypassEdit(SRC), ALLOW);
  expect('bypass allows an exec-intent dispatch with no exec-agent flag at all',
    bypassDispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan' }), ALLOW);

  rmState(BYPASS_SID);
}

// The Orca fallback must expire, and even an explicit Codex override falls back to the
// configured code model while the fallback is active (Orca cannot honor "use Codex" at all
// when it is genuinely unreachable).
{
  const saved = fs.existsSync(FLAG) ? fs.readFileSync(FLAG, 'utf8') : null;

  fs.writeFileSync(FLAG, new Date().toISOString());
  expect('a fresh fallback declaration permits in-session execution',
    dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet', prompt: 'Implement it. Verify: npm test (all pass).' }), ALLOW);
  {
    const CSID = `${SID}-fallback-codex`;
    invoke(promptSubmit(CSID, '--code-model codex'), CODEX_WINS);
    expect('an explicit codex override still falls back to the code model while Orca is down',
      dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet', prompt: 'Implement it. Verify: npm test (all pass).' }, CSID), ALLOW, CODEX_WINS);
    rmState(CSID);
  }

  fs.writeFileSync(FLAG, new Date(Date.now() - 3600 * 1000).toISOString());
  expect('an hour-old fallback declaration has expired and no longer permits it',
    dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan' }), DENY);

  if (fs.existsSync(FLAG)) failures.push('an expired fallback flag should have been deleted');
  else pass += 1;

  if (saved !== null) fs.writeFileSync(FLAG, saved);
}
expect('a neutral scouting dispatch is allowed',
  dispatch({ subagent_type: 'scout', description: 'search docs for the config key' }), ALLOW);

// execFallbackWhenCodexUnavailable: when Codex's quota is genuinely unknown (no session
// data at all) and `orca` cannot be found, auto-routing falls back to the code model
// instead of defaulting to Codex; with a real orca binary present, it still defaults to
// Codex despite the unknown quota (unknown is not evidence Codex is unusable).
{
  const dir = path.join(RUN_DIR, 'no-codex-data');
  fs.mkdirSync(path.join(dir, 'empty-codex'), { recursive: true });
  const noQuotaEnv = (orcaBin) => ({
    ...BASE_ENV, CODEX_SESSIONS_DIR: path.join(dir, 'empty-codex'),
    CK_USAGE_CACHE_PATH: path.join(dir, 'no-such-claude-cache.json'),
    ORCA_DOWN_FLAG_PATH: FLAG, ORCH_STATE_DIR: STATE_DIR, ORCH_CONFIG_PATH: CONFIG_FILE, ORCA_BIN: orcaBin,
  });
  const FSID = `${SID}-fallback-nodata`;
  const codeBrief = { subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet', prompt: 'Implement it. Verify: npm test (all pass).' };
  expect('unknown Codex quota + no orca binary falls back to the code model',
    dispatch(codeBrief, FSID), ALLOW, noQuotaEnv(path.join(dir, 'no-such-orca-binary')));
  rmState(FSID);
  expect('unknown Codex quota + a reachable orca binary still falls back (quota alone is never known to favour Codex)',
    dispatch(codeBrief, FSID), ALLOW, noQuotaEnv(STUB));
  rmState(FSID);
  // Codex quota IS known and under the handoff threshold (favours Codex) - a missing
  // orca binary still forces the fallback, because Codex cannot be dispatched to at all
  // without Orca, regardless of how much of its quota is left.
  const knownQuotaNoOrca = { ...CODEX_WINS, ORCA_BIN: path.join(dir, 'no-such-orca-binary-2') };
  expect('known quota favouring Codex + no orca binary still falls back to the code model',
    dispatch(codeBrief, FSID), ALLOW, knownQuotaNoOrca);
  rmState(FSID);
  expect('known quota favouring Codex + a reachable orca binary stays on Codex',
    dispatch(codeBrief, FSID), DENY, CODEX_WINS);
  rmState(FSID);
}

// The per-turn banner names the exact configured model id alongside its alias.
{
  const RSID = `${SID}-modelid`;
  const out = spawnSync(process.execPath, [GATE], { input: JSON.stringify(promptSubmit(RSID, 'status?')), encoding: 'utf8', env: CODEX_WINS }).stdout;
  if (/model "opus" \(claude-opus-5-5\)/.test(out)) pass += 1;
  else failures.push(`banner must show the review model's exact id: ${out.slice(0, 200)}`);
  rmState(RSID);
}

// disabledGates: a named gate stops refusing, others are unaffected.
{
  const gatedOffEnv = quotaEnv('gate-disabled', 10, 30, { disabledGates: ['main-no-write'] });
  expect('main-no-write does not refuse once disabled', mainEdit(SRC), ALLOW, gatedOffEnv);
  expect('main-no-mutate still refuses (a different gate)', mainBash('git commit -m x'), DENY, gatedOffEnv);
}

// replyLanguage: omitted entirely when null (default), present when configured.
{
  const noLangEnv = quotaEnv('no-lang', 10, 30, { replyLanguage: null });
  const withLangEnv = quotaEnv('with-lang', 10, 30, { replyLanguage: 'Vietnamese' });
  const RSID = `${SID}-lang`;
  const out1 = spawnSync(process.execPath, [GATE], { input: JSON.stringify(promptSubmit(RSID, 'status?')), encoding: 'utf8', env: noLangEnv }).stdout;
  if (!/Reply to the operator/.test(out1)) pass += 1; else failures.push('replyLanguage null must omit the language sentence');
  rmState(RSID);
  const out2 = spawnSync(process.execPath, [GATE], { input: JSON.stringify(promptSubmit(RSID, 'status?')), encoding: 'utf8', env: withLangEnv }).stdout;
  if (/Reply to the operator in Vietnamese/.test(out2)) pass += 1; else failures.push('a configured replyLanguage must appear in the reminder');
  rmState(RSID);
}

// A changed handoff threshold changes the banner text (amendment 6).
{
  const t60Env = quotaEnv('threshold-60', 10, 30, { codexHandoffUsedPercent: 60 });
  const RSID = `${SID}-threshold`;
  const out = spawnSync(process.execPath, [GATE], { input: JSON.stringify({ session_id: RSID, hook_event_name: 'SessionStart' }), encoding: 'utf8', env: t60Env }).stdout;
  if (/>= 60% used/.test(out)) pass += 1; else failures.push(`SessionStart banner must reflect a configured threshold of 60: ${out.slice(0, 200)}`);
  rmState(RSID);
}

// Activation modes (amendment 1): "orca-only" (the real default, not the "always" this
// suite otherwise forces) gates only a session that carries ORCA_TERMINAL_HANDLE; "off"
// never gates; "always" gates unconditionally regardless of the environment.
{
  const orcaOnlyEnv = quotaEnv('act-orca-only', 10, 30, { activation: 'orca-only' });
  const offEnv = quotaEnv('act-off', 10, 30, { activation: 'off' });
  const alwaysEnv = quotaEnv('act-always', 10, 30, { activation: 'always' });

  const noHandle = { ...orcaOnlyEnv }; delete noHandle.ORCA_TERMINAL_HANDLE;
  expect('activation orca-only, no terminal handle: main panel edit is ungated',
    mainEdit(SRC, `${SID}-act1`), ALLOW, noHandle);
  rmState(`${SID}-act1`);

  const withHandle = { ...orcaOnlyEnv, ORCA_TERMINAL_HANDLE: 'term_main_only' }; // stub: not a worker
  expect('activation orca-only, a terminal handle that is not a worker: still gated',
    mainEdit(SRC, `${SID}-act2`), DENY, withHandle);
  rmState(`${SID}-act2`);

  expect('activation off: never gated, even with effort/high payload shape',
    mainEdit(SRC, `${SID}-act3`), ALLOW, { ...offEnv, ORCA_TERMINAL_HANDLE: 'term_x' });
  rmState(`${SID}-act3`);

  expect('activation always: gated with no terminal handle at all',
    mainEdit(SRC, `${SID}-act4`), DENY, alwaysEnv);
  rmState(`${SID}-act4`);
}

// ORCHESTRATOR_GATE=off wins over every config, including activation "always".
expect('ORCHESTRATOR_GATE=off disables the gate outright',
  mainEdit(SRC, `${SID}-hard-off`), ALLOW, { ...CODEX_WINS, ORCHESTRATOR_GATE: 'off' });
rmState(`${SID}-hard-off`);

// Stop with live workers: allowed only while this session's heartbeat daemon is alive.
{
  const HSID = `${SID}-hb`;
  const stateF = path.join(STATE_DIR, `${HSID}.json`);
  const beatF = path.join(STATE_DIR, `heartbeat-${HSID}.json`);
  fs.writeFileSync(stateF, JSON.stringify({ session_id: HSID, bypass: false, execAgent: null, last_heartbeat: 0, rate_limit_hits: 0,
    workers: { ctx_e2e_fake: { role: 'codex-exec', started: Date.now(), status: 'live', last_seen: Date.now(), rate_limited_until: 0 } } }));
  const stop = { session_id: HSID, hook_event_name: 'Stop' };
  // The stub has never heard of ctx_e2e_fake, so it reports nothing unsettled -> the record is settled.
  const r = invoke(stop);
  if (r.code === 0) pass += 1; else failures.push(`Stop with a worker Orca does not know should settle it, got ${r.code}`);
  const st = JSON.parse(fs.readFileSync(stateF, 'utf8'));
  if (st.workers.ctx_e2e_fake.status === 'settled') pass += 1; else failures.push('unknown worker was not settled');
  // Liveness file: alive pid + fresh tick is recognised; a dead pid is not.
  fs.writeFileSync(beatF, JSON.stringify({ pid: process.pid, last_tick: Date.now(), interval: 20 }));
  const p1 = promptSubmit(HSID, 'status?');
  st.workers.ctx_e2e_fake.status = 'live'; fs.writeFileSync(stateF, JSON.stringify(st));
  const out1 = spawnSync(process.execPath, [GATE], { input: JSON.stringify(p1), encoding: 'utf8', env: CODEX_WINS }).stdout;
  if (/Heartbeat daemon alive/.test(out1)) pass += 1; else failures.push(`reminder did not see a live heartbeat: ${out1.slice(0, 120)}`);
  fs.writeFileSync(beatF, JSON.stringify({ pid: 999999, last_tick: Date.now(), interval: 20 }));
  const out2 = spawnSync(process.execPath, [GATE], { input: JSON.stringify(p1), encoding: 'utf8', env: CODEX_WINS }).stdout;
  if (/NO heartbeat daemon/.test(out2)) pass += 1; else failures.push(`reminder trusted a dead heartbeat pid: ${out2.slice(0, 120)}`);
  for (const f of [stateF, beatF]) { try { fs.unlinkSync(f); } catch {} }
}

console.log(`${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);

rmState(SID);
try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch {}
process.exit(failures.length ? 1 : 0);
