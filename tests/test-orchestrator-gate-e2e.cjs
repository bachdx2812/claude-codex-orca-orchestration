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
  // Unlimited by default so the many unrelated tests sharing SID/state below (most never
  // issue the matching PostToolUse that would consume a reservation) cannot spuriously hit
  // the cap. The dedicated max-parallel-codex-workers tests further down set a small,
  // explicit maxParallelCodexWorkers via their own env.
  maxParallelCodexWorkers: 0,
  ownershipClaimTtlMinutes: 120,
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
    ORCA_BIN: STUB, CODEX_BIN: STUB,
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

const mainBash = (command, opts = {}) => ({
  session_id: opts.sid || SID, hook_event_name: 'PreToolUse', effort: 'high',
  tool_name: 'Bash', tool_input: { command }, cwd: opts.cwd, tool_use_id: opts.tool_use_id,
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
const dispatch = (tool_input, sid = SID, opts = {}) => ({
  session_id: sid, hook_event_name: 'PreToolUse', effort: 'high',
  tool_name: 'Agent', tool_input, cwd: opts.cwd, tool_use_id: opts.tool_use_id,
});
const promptSubmit = (sid, promptText) => ({
  session_id: sid, hook_event_name: 'UserPromptSubmit', effort: 'high', prompt: promptText,
});
// A PostToolUse for a Bash tool call — same session/cwd/tool_use_id as the PreToolUse that
// admitted it, since that correlation is exactly what lets the gate attach a reservation's
// owns/ws/agent onto the worker entry it registers.
const postBash = (command, stdout, opts = {}) => ({
  session_id: opts.sid || SID, hook_event_name: 'PostToolUse', effort: 'high',
  tool_name: 'Bash', tool_input: { command }, cwd: opts.cwd, tool_use_id: opts.tool_use_id,
  tool_response: { stdout: stdout || '', stderr: '' },
});
// A synthetic fake repo root (its own `.git` marker) so ownership tests resolve a real,
// stable repoRoot without depending on — or touching — this project's own checkout.
const FAKE_REPO = fs.mkdtempSync(path.join(RUN_DIR, 'fake-repo-'));
fs.mkdirSync(path.join(FAKE_REPO, '.git'));

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
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet', prompt: 'Rename copy. verify: n/a text-only change.\nOwns: n/a (pre-existing gate test).' }), ALLOW, SONNET_WINS);
expect('orca spec without a verify command is refused',
  mainBash('orca orchestration task-create --task-title "x" --spec "implement the parser"'), DENY);
expect('orca spec with a verify command is allowed',
  mainBash('orca orchestration task-create --task-title "x" --spec "implement the parser. Verify: venv/bin/python -m pytest tests/parser -q.\nOwns: n/a (pre-existing gate test, unrelated to ownership)."'), ALLOW);
expect('an =-joined --spec is still recognised as a code brief needing a verify command',
  mainBash('orca orchestration task-create --task-title=x --spec="implement the parser"'), DENY);
expect('an =-joined --spec with a verify command is allowed',
  mainBash('orca orchestration task-create --task-title=x --spec="implement the parser. Verify: npm test.\nOwns: n/a (pre-existing gate test, unrelated to ownership)."'), ALLOW);
{
  const specFile = path.join(RUN_DIR, 'spec.md');
  fs.writeFileSync(specFile, 'Implement the parser.\nVerify: cargo test -p parser\nOwns: n/a (pre-existing gate test, unrelated to ownership).\n');
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
  // A worker-start whose reply carries no dispatch id is tracked as an explicit
  // "pending-<ts>" placeholder (live, unverified) rather than silently dropped or given a
  // fake id - and the next worker-list/worker-read poll resolves it one way or the other.
  {
    rmState(RS);
    const r = invoke(post('orca orchestration worker-start --task t --agent codex', '{"no_id_here":true}'), CODEX_WINS);
    const st1 = readState(RS) || { workers: {} };
    const pendingKeys = Object.keys(st1.workers || {}).filter((k) => k.startsWith('pending-'));
    if (pendingKeys.length === 1 && st1.workers[pendingKeys[0]].status === 'live' && st1.workers[pendingKeys[0]].unverified === true
      && r.out && /tracked as pending-/.test(r.out)) pass += 1;
    else failures.push(`a worker-start with no id in the reply must register one live, unverified pending-* entry (workers: ${JSON.stringify(st1.workers)}, out: ${r.out})`);

    // A poll that surfaces no matching new id settles the pending placeholder instead of
    // nagging forever (it can never be reconciled with real Orca data by id).
    const emptyPoll = ({ session_id: RS, hook_event_name: 'PostToolUse', effort: 'high', tool_name: 'Bash',
      tool_input: { command: 'orca orchestration worker-list --json' }, tool_response: { stdout: '{"result":{"workers":[]}}', stderr: '' } });
    invoke(emptyPoll, CODEX_WINS);
    const st2 = readState(RS);
    const pendingKey = pendingKeys[0];
    if (st2.workers[pendingKey] && st2.workers[pendingKey].status === 'settled') pass += 1;
    else failures.push(`an empty worker-list poll must settle the pending placeholder (${JSON.stringify(st2.workers[pendingKey])})`);
  }
  // A poll that DOES surface a real, not-yet-tracked id adopts it in place of the pending
  // placeholder rather than settling it unresolved.
  {
    rmState(RS);
    invoke(post('orca orchestration worker-start --task t --agent codex', '{"no_id_here":true}'), CODEX_WINS);
    const pendingKey = Object.keys(readState(RS).workers).find((k) => k.startsWith('pending-'));
    const pollWithId = ({ session_id: RS, hook_event_name: 'PostToolUse', effort: 'high', tool_name: 'Bash',
      tool_input: { command: 'orca orchestration worker-list --json' }, tool_response: { stdout: '{"result":{"workers":[{"dispatchId":"ctx_adopted_1"}]}}', stderr: '' } });
    invoke(pollWithId, CODEX_WINS);
    const st = readState(RS);
    if (st.workers.ctx_adopted_1 && st.workers.ctx_adopted_1.status === 'live' && !st.workers[pendingKey]) pass += 1;
    else failures.push(`a worker-list poll surfacing a real id must adopt it and drop the pending placeholder (${JSON.stringify(st.workers)})`);
  }
  rmState(RS);
}

// Operator picks the coding model directly with --code-model.
{
  const OSID = `${SID}-cm`;
  const d = (tool_input) => dispatch(tool_input, OSID);
  const code = (model) => d({ subagent_type: 'fullstack-developer', description: 'implement the plan', model,
    prompt: 'Implement it. Verify: npm test (all pass).\nOwns: n/a (pre-existing gate test, unrelated to ownership).' });
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
  // =-joined forms (regression: the scanner keeps `--model=x` as one word, so a naive
  // args.includes('--model') would miss it and wrongly keep advising).
  const agentEquals = advise('orca orchestration worker-start --task t --agent=codex');
  if (/pin the Codex model/.test(agentEquals)) pass += 1; else failures.push('--agent=codex should still be recognised as a codex worker-start');
  const modelEquals = advise('orca orchestration worker-start --task t --agent=codex --model=gpt-4');
  if (!/pin the Codex model/.test(modelEquals)) pass += 1; else failures.push('an =-joined --model should suppress the advice');
  const terminalEquals = advise('orca orchestration worker-start --task t --agent=codex --terminal=term_1');
  if (!/pin the Codex model/.test(terminalEquals)) pass += 1; else failures.push('an =-joined --terminal should suppress the advice');
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
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet', prompt: 'Implement it. Verify: npm test (all pass).\nOwns: n/a (pre-existing gate test, unrelated to ownership).' }), ALLOW);
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
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet', prompt: 'Implement it. Verify: npm test (all pass).\nOwns: n/a (pre-existing gate test, unrelated to ownership).' }), ALLOW, SONNET_WINS);
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
    dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet', prompt: 'Implement it. Verify: npm test (all pass).\nOwns: n/a (pre-existing gate test, unrelated to ownership).' }), ALLOW);
  {
    const CSID = `${SID}-fallback-codex`;
    invoke(promptSubmit(CSID, '--code-model codex'), CODEX_WINS);
    expect('an explicit codex override still falls back to the code model while Orca is down',
      dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet', prompt: 'Implement it. Verify: npm test (all pass).\nOwns: n/a (pre-existing gate test, unrelated to ownership).' }, CSID), ALLOW, CODEX_WINS);
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

// execFallbackWhenCodexUnavailable: fires ONLY when `orca` or `codex` itself is missing
// from PATH - Codex is the deliberately-preferred default, so an unknown quota reading
// alone (a fresh Codex install that has not run a first turn yet) must never fall back;
// both binaries present, no quota file at all, still routes to Codex.
{
  const dir = path.join(RUN_DIR, 'no-codex-data');
  fs.mkdirSync(path.join(dir, 'empty-codex'), { recursive: true });
  const noOrcaBin = path.join(dir, 'no-such-orca-binary');
  const noCodexBin = path.join(dir, 'no-such-codex-binary');
  const noQuotaEnv = (orcaBin, codexBin) => ({
    ...BASE_ENV, CODEX_SESSIONS_DIR: path.join(dir, 'empty-codex'),
    CK_USAGE_CACHE_PATH: path.join(dir, 'no-such-claude-cache.json'),
    ORCA_DOWN_FLAG_PATH: FLAG, ORCH_STATE_DIR: STATE_DIR, ORCH_CONFIG_PATH: CONFIG_FILE,
    ORCA_BIN: orcaBin, CODEX_BIN: codexBin,
  });
  const FSID = `${SID}-fallback-nodata`;
  const codeBrief = { subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet', prompt: 'Implement it. Verify: npm test (all pass).\nOwns: n/a (pre-existing gate test, unrelated to ownership).' };

  expect('orca missing (quota unknown too) falls back to the code model',
    dispatch(codeBrief, FSID), ALLOW, noQuotaEnv(noOrcaBin, STUB));
  rmState(FSID);
  expect('codex missing (quota unknown too) falls back to the code model',
    dispatch(codeBrief, FSID), ALLOW, noQuotaEnv(STUB, noCodexBin));
  rmState(FSID);
  expect('both orca and codex present, quota simply unknown, stays on Codex',
    dispatch(codeBrief, FSID), DENY, noQuotaEnv(STUB, STUB));
  rmState(FSID);

  // Codex quota IS known and under the handoff threshold (favours Codex) - a missing
  // orca binary still forces the fallback, because Codex cannot be dispatched to at all
  // without Orca, regardless of how much of its quota is left.
  expect('known quota favouring Codex + no orca binary still falls back to the code model',
    dispatch(codeBrief, FSID), ALLOW, { ...CODEX_WINS, ORCA_BIN: noOrcaBin, CODEX_BIN: STUB });
  rmState(FSID);
  expect('known quota favouring Codex + both binaries reachable stays on Codex',
    dispatch(codeBrief, FSID), DENY, { ...CODEX_WINS, CODEX_BIN: STUB });
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

// =====================================================================================
// Gate A: max-parallel-codex-workers
// =====================================================================================
{
  const CAP2 = quotaEnv('cap-2', 10, 30, { maxParallelCodexWorkers: 2 });
  const GSID = `${SID}-cap`;

  /** Registers a live codex worker group under GSID via a real Pre+Post round trip. */
  function registerCodexWorker(n, env = CAP2) {
    const tu = `toolu_cap_${n}`;
    const dispatchId = `ctx_cap_${n}`;
    invoke(mainBash(`orca orchestration worker-start --agent codex --task t${n}`, { sid: GSID, tool_use_id: tu }), env);
    invoke(postBash(`orca orchestration worker-start --agent codex --task t${n}`,
      JSON.stringify({ dispatchId, taskId: `task_cap_${n}`, agentTerminalHandle: `term_cap_${n}` }),
      { sid: GSID, tool_use_id: tu }), env);
    return dispatchId;
  }

  rmState(GSID);
  expect('cap: below the cap is allowed', mainBash('orca orchestration worker-start --agent codex --task t0', { sid: GSID, tool_use_id: 'toolu_cap_probe' }), ALLOW, CAP2);
  // Clean up the probe's reservation (a failed start drops it) so it cannot leak into the
  // cap accounting for the rest of this block.
  invoke(postBash('orca orchestration worker-start --agent codex --task t0', '{"ok":false}', { sid: GSID, tool_use_id: 'toolu_cap_probe' }), CAP2);
  const first = registerCodexWorker(1);
  expect('cap: one live codex worker, cap 2 -> a second is still allowed',
    mainBash('orca orchestration worker-start --agent codex --task t2', { sid: GSID, tool_use_id: 'toolu_cap_probe2' }), ALLOW, CAP2);
  invoke(postBash('orca orchestration worker-start --agent codex --task t2', '{"ok":false}', { sid: GSID, tool_use_id: 'toolu_cap_probe2' }), CAP2);
  const second = registerCodexWorker(2);
  {
    const r = invoke(mainBash('orca orchestration worker-start --agent codex --task t3', { sid: GSID }), CAP2);
    if (r.code === DENY && /max-parallel-codex-workers/.test(r.err) && /2\/2/.test(r.err)) pass += 1;
    else failures.push(`cap: at 2/2 a third codex worker-start must be refused by name (exit ${r.code}, err ${r.err.slice(0, 200)})`);
  }
  expect('cap: --retry-of a tracked group replaces it, not new, so it is allowed at the cap',
    mainBash(`orca orchestration worker-start --agent codex --retry-of ${first}`, { sid: GSID }), ALLOW, CAP2);
  expect('cap: --terminal of a tracked group replaces it, not new, so it is allowed at the cap',
    mainBash('orca orchestration worker-start --agent codex --terminal term_cap_2', { sid: GSID }), ALLOW, CAP2);
  expect('cap: a non-codex agent is never counted, so it is allowed at the cap',
    mainBash('orca orchestration worker-start --agent claude --task t4', { sid: GSID }), ALLOW, CAP2);
  expect('cap: maxParallelCodexWorkers 0 means unlimited even past the configured cap',
    mainBash('orca orchestration worker-start --agent codex --task t5', { sid: GSID }), ALLOW, { ...CAP2, ORCH_MAX_PARALLEL_CODEX_WORKERS: '0' });
  expect('cap: an env override raises the effective cap above what the config says',
    mainBash('orca orchestration worker-start --agent codex --task t6', { sid: GSID }), ALLOW, { ...CAP2, ORCH_MAX_PARALLEL_CODEX_WORKERS: '5' });
  expect('cap: disabledGates lets an over-cap dispatch through',
    mainBash('orca orchestration worker-start --agent codex --task t7', { sid: GSID }), ALLOW,
    quotaEnv('cap-disabled', 10, 30, { maxParallelCodexWorkers: 2, disabledGates: ['max-parallel-codex-workers'] }));
  rmState(GSID);

  // At-cap reconciliation: Orca's own worker-list is consulted only once the local count
  // is at/over the cap, and a row it reports released is dropped before recounting.
  {
    const RSID = `${SID}-cap-reconcile`;
    rmState(RSID);
    registerCodexWorker(90, CAP2);
    // Locally this session also believes ctx_cap_90 is live. Orca's own worker-list says
    // otherwise, only because we've set the "worker" env's id to ctx_cap_90 with a
    // terminalState the reconciler treats as released. Swap the session id onto RSID by
    // re-registering under RSID specifically.
    const tu = 'toolu_reconcile_1';
    invoke(mainBash('orca orchestration worker-start --agent codex --task tr1', { sid: RSID, tool_use_id: tu }), CAP2);
    invoke(postBash('orca orchestration worker-start --agent codex --task tr1',
      JSON.stringify({ dispatchId: 'ctx_reconcile_1' }), { sid: RSID, tool_use_id: tu }), CAP2);
    const tu2 = 'toolu_reconcile_2';
    invoke(mainBash('orca orchestration worker-start --agent codex --task tr2', { sid: RSID, tool_use_id: tu2 }), CAP2);
    invoke(postBash('orca orchestration worker-start --agent codex --task tr2',
      JSON.stringify({ dispatchId: 'ctx_reconcile_2' }), { sid: RSID, tool_use_id: tu2 }), CAP2);
    // Locally: 2/2 live, at cap. Orca reports ctx_reconcile_1 released.
    const reconcileEnv = { ...CAP2, STUB_WORKERS_JSON: JSON.stringify([
      { dispatchId: 'ctx_reconcile_1', terminalState: 'released', workerState: 'succeeded' },
      { dispatchId: 'ctx_reconcile_2', terminalState: 'active', workerState: 'running' },
    ]) };
    expect('cap: at-cap reconciliation drops a row Orca reports released, freeing capacity',
      mainBash('orca orchestration worker-start --agent codex --task tr3', { sid: RSID }), ALLOW, reconcileEnv);
    rmState(RSID);
  }

  // Race: two PreToolUse calls for the same command line, before either's PostToolUse has
  // run, at cap 1 — the FIRST reserves the only opening; the SECOND must see that reservation
  // and be refused, proving the reservation (not just a registered worker) counts.
  {
    const CAP1 = quotaEnv('cap-1-race', 10, 30, { maxParallelCodexWorkers: 1 });
    const RaceSID = `${SID}-cap-race`;
    rmState(RaceSID);
    expect('cap race: the first of two parallel codex worker-starts reserves the only opening',
      mainBash('orca orchestration worker-start --agent codex --task race1', { sid: RaceSID, tool_use_id: 'toolu_race_1' }), ALLOW, CAP1);
    expect('cap race: the second, before the first resolved, is refused by the reservation',
      mainBash('orca orchestration worker-start --agent codex --task race2', { sid: RaceSID, tool_use_id: 'toolu_race_2' }), DENY, CAP1);
    rmState(RaceSID);
  }

  // A failed start ("ok": false) drops its reservation instead of leaving it live forever.
  {
    const CAP1 = quotaEnv('cap-1-fail', 10, 30, { maxParallelCodexWorkers: 1 });
    const FSID = `${SID}-cap-fail`;
    rmState(FSID);
    const tu = 'toolu_fail_1';
    invoke(mainBash('orca orchestration worker-start --agent codex --task fail1', { sid: FSID, tool_use_id: tu }), CAP1);
    invoke(postBash('orca orchestration worker-start --agent codex --task fail1', '{"ok":false,"error":"boom"}', { sid: FSID, tool_use_id: tu }), CAP1);
    expect('cap: a failed start\'s reservation is dropped, freeing capacity for the next dispatch',
      mainBash('orca orchestration worker-start --agent codex --task fail2', { sid: FSID, tool_use_id: 'toolu_fail_2' }), ALLOW, CAP1);
    rmState(FSID);
  }

  // A subagent payload is never gated by the new gates either, even hopelessly over cap.
  {
    const SubSID = `${SID}-cap-sub`;
    rmState(SubSID);
    const subBash = (command) => ({
      session_id: SubSID, hook_event_name: 'PreToolUse',
      agent_id: 'ag_1', agent_type: 'general-purpose',
      tool_name: 'Bash', tool_input: { command },
    });
    for (let i = 0; i < 5; i++) {
      expect(`cap: a subagent's codex worker-start is never gated (${i})`,
        subBash(`orca orchestration worker-start --agent codex --task sub${i}`), ALLOW, CAP2);
    }
    rmState(SubSID);
  }
}

// =====================================================================================
// Gate B: code-brief-needs-owns / ownership-overlap
// =====================================================================================
{
  const OWNS_ENV = quotaEnv('owns', 10, 30, {});
  // In-session Agent exec dispatches also have to clear the execution-routing gates
  // (route-execution-to-codex / execution-model-mismatch) before Owns: is ever reached —
  // this quota favours the code model (Codex >= 40% used), same shape as SONNET_WINS.
  const OWNS_AGENT_ENV = quotaEnv('owns-agent', 10, 75, {});
  const OSID = `${SID}-owns`;

  rmState(OSID);
  // Ownership is enforced where the workspace is actually known — worker-start — not at
  // task-create, which does not yet know whether its eventual worker-start will be
  // isolated (item 9). A task-create with no Owns: therefore is NOT refused by itself...
  expect('owns: task-create alone, missing Owns:, is not refused (enforcement is deferred to worker-start)',
    mainBash('orca orchestration task-create --task-title "x" --spec "implement the parser. Verify: npm test"',
      { sid: OSID, cwd: FAKE_REPO, tool_use_id: 'toolu_defer_1' }), ALLOW, OWNS_ENV);
  // ...but a later worker-start --task <id> referencing it, non-isolated, IS refused, since
  // that is where the shared workspace is finally known.
  {
    const deferEnv = OWNS_ENV;
    invoke(postBash('orca orchestration task-create --task-title "x" --spec "implement the parser. Verify: npm test"',
      '{"taskId":"task_defer_1"}', { sid: OSID, cwd: FAKE_REPO, tool_use_id: 'toolu_defer_1' }), deferEnv);
    const r = invoke(mainBash('orca orchestration worker-start --agent codex --task task_defer_1', { sid: OSID, cwd: FAKE_REPO }), deferEnv);
    if (r.code === DENY && /code-brief-needs-owns/.test(r.err)) pass += 1;
    else failures.push(`owns: worker-start --task <id> with no recorded Owns: must be refused, deferred from task-create (exit ${r.code}, err ${r.err.slice(0, 200)})`);
    expect('owns: the SAME worker-start, isolated in its own worktree, needs no Owns: at all',
      mainBash('orca orchestration worker-start --agent codex --task task_defer_1 --worktree new-child', { sid: OSID, cwd: FAKE_REPO }), ALLOW, deferEnv);
  }
  expect('owns: Owns: n/a satisfies the requirement',
    mainBash('orca orchestration task-create --task-title "x" --spec "implement the parser. Verify: npm test\nOwns: n/a research spike"',
      { sid: OSID, cwd: FAKE_REPO }), ALLOW, OWNS_ENV);
  expect('owns: --worktree new-child needs no Owns: at all (isolated)',
    mainBash('orca orchestration worker-start --worktree new-child --spec "implement the parser. Verify: npm test"',
      { sid: OSID, cwd: FAKE_REPO }), ALLOW, OWNS_ENV);
  expect('owns: a research spec (no exec intent) needs no Owns:',
    mainBash('orca orchestration task-create --task-title "r" --spec "Research: summarize the docs"',
      { sid: OSID, cwd: FAKE_REPO }), ALLOW, OWNS_ENV);
  rmState(OSID);

  // Same-workspace overlap is refused; the same claim isolated in --worktree new-child
  // never conflicts, since every isolated dispatch gets its own unique workspace key.
  {
    const OvSID = `${SID}-owns-overlap`;
    rmState(OvSID);
    const tu1 = 'toolu_ov_1';
    invoke(mainBash('orca orchestration task-create --task-title "a" --spec "implement a.\nVerify: npm test\nOwns: src/shared/a.ts"',
      { sid: OvSID, cwd: FAKE_REPO, tool_use_id: tu1 }), OWNS_ENV);
    invoke(postBash('orca orchestration task-create --task-title "a" --spec "implement a.\nVerify: npm test\nOwns: src/shared/a.ts"',
      '{"taskId":"task_ov_1"}', { sid: OvSID, cwd: FAKE_REPO, tool_use_id: tu1 }), OWNS_ENV);
    // The reservation is consumed by the matching PostToolUse above (transferred onto
    // s.tasks), so it no longer holds the workspace on its own — start the SAME claim as a
    // live worker instead, which is what actually holds a workspace claim.
    const tu2 = 'toolu_ov_2';
    invoke(mainBash('orca orchestration worker-start --agent codex --task task_ov_1', { sid: OvSID, cwd: FAKE_REPO, tool_use_id: tu2 }), OWNS_ENV);
    invoke(postBash('orca orchestration worker-start --agent codex --task task_ov_1',
      '{"dispatchId":"ctx_ov_1"}', { sid: OvSID, cwd: FAKE_REPO, tool_use_id: tu2 }), OWNS_ENV);

    const conflict = invoke(mainBash('orca orchestration task-create --task-title "b" --spec "implement b.\nVerify: npm test\nOwns: src/shared/a.ts"',
      { sid: OvSID, cwd: FAKE_REPO }), OWNS_ENV);
    if (conflict.code === DENY && /ownership-overlap/.test(conflict.err)) pass += 1;
    else failures.push(`owns: a same-workspace overlapping claim must be refused (exit ${conflict.code}, err ${conflict.err.slice(0, 200)})`);

    expect('owns: the SAME overlapping claim, isolated in its own worktree, never conflicts',
      mainBash('orca orchestration worker-start --worktree new-child --spec "implement b.\nVerify: npm test\nOwns: src/shared/a.ts"',
        { sid: OvSID, cwd: FAKE_REPO }), ALLOW, OWNS_ENV);

    // A disabled gate still reserves (item 5: it must not silently skip the cap/claim
    // bookkeeping for the dispatch it would otherwise have refused) — resolve that
    // reservation the same way "a" was resolved above, so it cannot leak into the rest of
    // this block's overlap checks.
    {
      const disabledEnv = quotaEnv('owns-disabled', 10, 30, { disabledGates: ['ownership-overlap'] });
      const tuC = 'toolu_ov_c';
      expect('owns: disabledGates lets an overlapping claim through',
        mainBash('orca orchestration task-create --task-title "c" --spec "implement c.\nVerify: npm test\nOwns: src/shared/a.ts"',
          { sid: OvSID, cwd: FAKE_REPO, tool_use_id: tuC }), ALLOW, disabledEnv);
      invoke(postBash('orca orchestration task-create --task-title "c" --spec "implement c.\nVerify: npm test\nOwns: src/shared/a.ts"',
        '{"taskId":"task_ov_c"}', { sid: OvSID, cwd: FAKE_REPO, tool_use_id: tuC }), disabledEnv);
    }

    // Releasing the worker via --dispatch frees the claim, so a fresh overlapping claim is
    // then allowed again.
    invoke(mainBash(`orca orchestration worker-release --dispatch ctx_ov_1`, { sid: OvSID }), OWNS_ENV);
    invoke(postBash('orca orchestration worker-release --dispatch ctx_ov_1', '{"ok":true}', { sid: OvSID }), OWNS_ENV);
    expect('owns: releasing the worker frees its claim; the same claim is allowed again',
      mainBash('orca orchestration task-create --task-title "d" --spec "implement d.\nVerify: npm test\nOwns: src/shared/a.ts"',
        { sid: OvSID, cwd: FAKE_REPO }), ALLOW, OWNS_ENV);
    rmState(OvSID);
  }

  // task-create's Owns: is inherited by `worker-start --task <id>` (no --spec of its own),
  // and that inherited claim is then enforced against a later overlapping dispatch.
  {
    const TSID = `${SID}-owns-task`;
    rmState(TSID);
    const tu1 = 'toolu_task_1';
    invoke(mainBash('orca orchestration task-create --task-title "e" --spec "implement e.\nVerify: npm test\nOwns: src/task-inherit/a.ts"',
      { sid: TSID, cwd: FAKE_REPO, tool_use_id: tu1 }), OWNS_ENV);
    invoke(postBash('orca orchestration task-create --task-title "e" --spec "implement e.\nVerify: npm test\nOwns: src/task-inherit/a.ts"',
      '{"taskId":"task_inherit_1"}', { sid: TSID, cwd: FAKE_REPO, tool_use_id: tu1 }), OWNS_ENV);
    {
      const st = readState(TSID);
      if (st && st.tasks && st.tasks.task_inherit_1 && st.tasks.task_inherit_1.owns && st.tasks.task_inherit_1.owns.includes('src/task-inherit/a.ts')) pass += 1;
      else failures.push(`owns: task-create must record its Owns: onto s.tasks (${JSON.stringify(st && st.tasks)})`);
    }
    const tu2 = 'toolu_task_2';
    expect('owns: worker-start --task <id> with no --spec inherits the task\'s Owns and needs no re-declaration',
      mainBash('orca orchestration worker-start --agent codex --task task_inherit_1', { sid: TSID, cwd: FAKE_REPO, tool_use_id: tu2 }), ALLOW, OWNS_ENV);
    invoke(postBash('orca orchestration worker-start --agent codex --task task_inherit_1',
      '{"dispatchId":"ctx_inherit_1"}', { sid: TSID, cwd: FAKE_REPO, tool_use_id: tu2 }), OWNS_ENV);

    const conflict = invoke(mainBash('orca orchestration task-create --task-title "f" --spec "implement f.\nVerify: npm test\nOwns: src/task-inherit/a.ts"',
      { sid: TSID, cwd: FAKE_REPO }), OWNS_ENV);
    if (conflict.code === DENY && /ownership-overlap/.test(conflict.err)) pass += 1;
    else failures.push(`owns: an inherited task claim, once running as a worker, must be enforced (exit ${conflict.code}, err ${conflict.err.slice(0, 200)})`);

    expect('owns: worker-start --task $VAR (unresolvable) is allowed, not refused',
      mainBash('orca orchestration worker-start --agent codex --task $SOME_VAR', { sid: TSID, cwd: FAKE_REPO }), ALLOW, OWNS_ENV);
    rmState(TSID);
  }

  // code-brief-needs-owns / ownership-overlap for in-session Agent dispatches.
  {
    const ASID = `${SID}-owns-agent`;
    rmState(ASID);
    const execBrief = (owns) => ({
      subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet',
      prompt: `Implement it. Verify: npm test (all pass).${owns ? `\nOwns: ${owns}` : ''}`,
    });
    expect('owns: an in-session exec dispatch without Owns: is refused',
      dispatch(execBrief(null), ASID, { cwd: FAKE_REPO }), DENY, OWNS_AGENT_ENV);
    expect('owns: isolation:"worktree" needs no Owns: at all',
      dispatch({ ...execBrief(null), isolation: 'worktree' }, ASID, { cwd: FAKE_REPO }), ALLOW, OWNS_AGENT_ENV);

    const tuA = 'toolu_agent_a';
    expect('owns: an in-session exec dispatch with Owns: is allowed and claims it',
      dispatch(execBrief('src/agent-claim/a.ts'), ASID, { cwd: FAKE_REPO, tool_use_id: tuA }), ALLOW, OWNS_AGENT_ENV);
    {
      const st = readState(ASID);
      if (st && st.agentClaims && st.agentClaims[tuA] && st.agentClaims[tuA].owns.includes('src/agent-claim/a.ts')) pass += 1;
      else failures.push(`owns: a successful exec Agent dispatch must record its claim (${JSON.stringify(st && st.agentClaims)})`);
    }

    const overlapping = invoke(dispatch(execBrief('src/agent-claim/a.ts'), ASID, { cwd: FAKE_REPO }), OWNS_AGENT_ENV);
    if (overlapping.code === DENY && /ownership-overlap/.test(overlapping.err)) pass += 1;
    else failures.push(`owns: a second overlapping in-session claim must be refused (exit ${overlapping.code}, err ${overlapping.err.slice(0, 200)})`);

    // Foreground release: the matching PostToolUse (same tool_use_id) frees the claim.
    invoke({ session_id: ASID, hook_event_name: 'PostToolUse', effort: 'high', tool_name: 'Agent',
      tool_input: execBrief('src/agent-claim/a.ts'), tool_use_id: tuA, tool_response: { result: 'done' } }, OWNS_AGENT_ENV);
    {
      const st = readState(ASID);
      if (!st || !st.agentClaims || !st.agentClaims[tuA]) pass += 1;
      else failures.push('owns: the matching PostToolUse must release the foreground claim');
    }
    expect('owns: after the foreground claim is released, the same claim is allowed again',
      dispatch(execBrief('src/agent-claim/a.ts'), ASID, { cwd: FAKE_REPO, tool_use_id: 'toolu_agent_b' }), ALLOW, OWNS_AGENT_ENV);

    // TTL expiry: an old claim written directly into state (simulating a background
    // dispatch nothing ever released) no longer counts once it is older than the TTL.
    {
      const stateFile = path.join(STATE_DIR, `${ASID}.json`);
      const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      st.agentClaims.toolu_stale = { owns: ['src/agent-claim/stale.ts'], ws: st.agentClaims['toolu_agent_b'].ws, ts: Date.now() - 121 * 60 * 1000 };
      fs.writeFileSync(stateFile, JSON.stringify(st));
      expect('owns: a claim older than ownershipClaimTtlMinutes no longer blocks an overlapping dispatch',
        dispatch(execBrief('src/agent-claim/stale.ts'), ASID, { cwd: FAKE_REPO, tool_use_id: 'toolu_agent_c' }), ALLOW, OWNS_AGENT_ENV);
    }

    // --release-claims: the operator's manual escape hatch.
    {
      const stateFile = path.join(STATE_DIR, `${ASID}.json`);
      const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const ws = st.agentClaims['toolu_agent_c'] ? st.agentClaims['toolu_agent_c'].ws : `${FAKE_REPO}|current`;
      st.agentClaims.toolu_release_me = { owns: ['src/agent-claim/release-me.ts'], ws, ts: Date.now() };
      fs.writeFileSync(stateFile, JSON.stringify(st));
      const blocked = invoke(dispatch(execBrief('src/agent-claim/release-me.ts'), ASID, { cwd: FAKE_REPO }), OWNS_AGENT_ENV);
      if (blocked.code === DENY) pass += 1; else failures.push('owns: --release-claims setup: the claim should still block before release');
      invoke(promptSubmit(ASID, '--release-claims all'), OWNS_AGENT_ENV);
      {
        const st2 = readState(ASID);
        if (!st2.agentClaims.toolu_release_me) pass += 1; else failures.push('owns: --release-claims all must clear every tracked claim');
      }
      expect('owns: after --release-claims all, the same claim is allowed again',
        dispatch(execBrief('src/agent-claim/release-me.ts'), ASID, { cwd: FAKE_REPO, tool_use_id: 'toolu_agent_d' }), ALLOW, OWNS_AGENT_ENV);
    }

    // <task-notification> best-effort background release, by id.
    {
      const stateFile = path.join(STATE_DIR, `${ASID}.json`);
      const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      st.agentClaims.toolu_bg_1 = { owns: ['src/agent-claim/bg.ts'], ws: `${FAKE_REPO}|current`, ts: Date.now() };
      fs.writeFileSync(stateFile, JSON.stringify(st));
      invoke(promptSubmit(ASID, '<task-notification>Background task toolu_bg_1 finished successfully.</task-notification>'), OWNS_AGENT_ENV);
      const st2 = readState(ASID);
      if (!st2.agentClaims.toolu_bg_1) pass += 1; else failures.push('owns: a <task-notification> naming a claim id must release it');
    }

    // Subagent payloads are never gated.
    expect('owns: a subagent exec dispatch is never gated by code-brief-needs-owns',
      { session_id: ASID, hook_event_name: 'PreToolUse', agent_id: 'ag_1', agent_type: 'general-purpose',
        tool_name: 'Agent', tool_input: execBrief(null) }, ALLOW, OWNS_AGENT_ENV);

    expect('owns: disabledGates lets an in-session exec dispatch without Owns: through',
      dispatch(execBrief(null), ASID, { cwd: FAKE_REPO }), ALLOW,
      quotaEnv('owns-agent-disabled', 10, 75, { disabledGates: ['code-brief-needs-owns'] }));

    rmState(ASID);
  }
}

// Section 0 bug fixes: triple worker records, and the release matcher settling every live
// worker instead of just its target.
{
  const B0 = quotaEnv('bug0', 10, 30, {});
  const B0SID = `${SID}-bug0`;
  rmState(B0SID);

  // Bug #1: one worker-start reply naming a dispatch id, task id AND terminal handle for
  // the SAME worker must be tracked as one group, not three separate live workers.
  const tu = 'toolu_bug0_1';
  invoke(mainBash('orca orchestration worker-start --agent codex --task tb1', { sid: B0SID, tool_use_id: tu }), B0);
  invoke(postBash('orca orchestration worker-start --agent codex --task tb1',
    JSON.stringify({ dispatchId: 'ctx_bug0_1', taskId: 'task_bug0_1', agentTerminalHandle: 'term_bug0_1' }),
    { sid: B0SID, tool_use_id: tu }), B0);
  {
    const st = readState(B0SID);
    const keys = ['ctx_bug0_1', 'task_bug0_1', 'term_bug0_1'];
    const allTracked = keys.every((k) => st.workers[k] && st.workers[k].status === 'live');
    const sameGroup = new Set(keys.map((k) => st.workers[k].group)).size === 1;
    if (allTracked && sameGroup) pass += 1;
    else failures.push(`bug0#1: triple ids must share one group (${JSON.stringify(st && st.workers)})`);
  }
  // A cap-1 worker-start must now be refused: this is ONE worker, not three.
  expect('bug0#1: three ids from one worker-start still count as exactly one toward the cap',
    mainBash('orca orchestration worker-start --agent codex --task tb2', { sid: B0SID }), DENY,
    quotaEnv('bug0-cap1', 10, 30, { maxParallelCodexWorkers: 1 }));

  // Bug #2: `worker-release --dispatch <id> --json` must settle only that worker's group,
  // never fall back to settling every live worker because a trailing flag looked like the
  // target. Register a second, unrelated worker first.
  const tu2 = 'toolu_bug0_2';
  invoke(mainBash('orca orchestration worker-start --agent codex --task tb3', { sid: B0SID, tool_use_id: tu2 }), B0);
  invoke(postBash('orca orchestration worker-start --agent codex --task tb3',
    '{"dispatchId":"ctx_bug0_2"}', { sid: B0SID, tool_use_id: tu2 }), B0);
  invoke(postBash('orca orchestration worker-release --dispatch ctx_bug0_1 --json', '{"ok":true}', { sid: B0SID }), B0);
  {
    const st = readState(B0SID);
    const released = ['ctx_bug0_1', 'task_bug0_1', 'term_bug0_1'].every((k) => st.workers[k].status === 'settled');
    const stillLive = st.workers.ctx_bug0_2.status === 'live';
    if (released && stillLive) pass += 1;
    else failures.push(`bug0#2: --dispatch <id> --json must settle only that group, not every live worker (${JSON.stringify(st && st.workers)})`);
  }
  // An unrecognised label settles nothing.
  invoke(postBash('orca orchestration worker-release --dispatch ctx_bug0_unknown --json', '{"ok":true}', { sid: B0SID }), B0);
  {
    const st = readState(B0SID);
    if (st.workers.ctx_bug0_2.status === 'live') pass += 1;
    else failures.push('bug0#2: an unrecognised release target must settle nothing');
  }
  rmState(B0SID);
}

// =====================================================================================
// fix-round-1 items 2, 4, 5, 6, 7, 8, 12, 13 — e2e regression coverage
// =====================================================================================

// Item 2: two worker-starts chained in ONE command must be tracked as two distinct
// groups, each converted against its OWN reservation; releasing one must not settle
// the other.
{
  const B2 = quotaEnv('item2-two-starts', 10, 30, {});
  const T2SID = `${SID}-item2`;
  rmState(T2SID);
  const tu = 'toolu_item2_combo';
  const cmd = 'orca orchestration worker-start --agent codex --task ta && orca orchestration worker-start --agent codex --task tb';
  invoke(mainBash(cmd, { sid: T2SID, tool_use_id: tu }), B2);
  const replyOut = [
    JSON.stringify({ ok: true, result: { dispatchId: 'ctx_item2_a' } }),
    JSON.stringify({ ok: true, result: { dispatchId: 'ctx_item2_b' } }),
  ].join('\n');
  invoke(postBash(cmd, replyOut, { sid: T2SID, tool_use_id: tu }), B2);
  {
    const st = readState(T2SID);
    const groupsDistinct = st && st.workers.ctx_item2_a && st.workers.ctx_item2_b &&
      st.workers.ctx_item2_a.group !== st.workers.ctx_item2_b.group;
    if (groupsDistinct) pass += 1;
    else failures.push(`item2: two worker-starts in one command must be tracked as two distinct groups (${JSON.stringify(st && st.workers)})`);
  }
  invoke(postBash('orca orchestration worker-release --dispatch ctx_item2_a', '{"ok":true}', { sid: T2SID }), B2);
  {
    const st = readState(T2SID);
    if (st.workers.ctx_item2_a.status === 'settled' && st.workers.ctx_item2_b.status === 'live') pass += 1;
    else failures.push(`item2: releasing one group must not settle the other (${JSON.stringify(st.workers)})`);
  }
  rmState(T2SID);
}

// Item 4: a background Agent dispatch's Owns: claim must survive its own launch
// PostToolUse, and release only via a matching <task-notification><tool-use-id>.
{
  const B4 = quotaEnv('item4-bg', 10, 75, {});
  const BG4SID = `${SID}-item4-bg`;
  rmState(BG4SID);
  const bgBrief = { subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet',
    prompt: 'Implement it. Verify: npm test (all pass).\nOwns: src/item4-bg/a.ts', run_in_background: true };
  const tuBg = 'toolu_item4_bg_1';
  expect('item4: a background exec dispatch with Owns: is allowed and claims it',
    dispatch(bgBrief, BG4SID, { cwd: FAKE_REPO, tool_use_id: tuBg }), ALLOW, B4);
  {
    const st = readState(BG4SID);
    if (st && st.agentClaims && st.agentClaims[tuBg] && st.agentClaims[tuBg].background === true) pass += 1;
    else failures.push(`item4: a background dispatch's claim must be recorded with background:true (${JSON.stringify(st && st.agentClaims)})`);
  }
  invoke({ session_id: BG4SID, hook_event_name: 'PostToolUse', effort: 'high', tool_name: 'Agent',
    tool_input: bgBrief, tool_use_id: tuBg, tool_response: { result: 'dispatched' } }, B4);
  {
    const st = readState(BG4SID);
    if (st && st.agentClaims && st.agentClaims[tuBg]) pass += 1;
    else failures.push('item4: a background claim must survive its own launch PostToolUse');
  }
  const stillBlocked = invoke(dispatch({ ...bgBrief, run_in_background: false }, BG4SID, { cwd: FAKE_REPO }), B4);
  if (stillBlocked.code === DENY) pass += 1; else failures.push('item4: the background claim must still block an overlapping dispatch');
  invoke(promptSubmit(BG4SID, `<task-notification><tool-use-id>${tuBg}</tool-use-id>Background task finished.</task-notification>`), B4);
  {
    const st = readState(BG4SID);
    if (!st.agentClaims[tuBg]) pass += 1; else failures.push('item4: a <task-notification><tool-use-id> tag must release the matching background claim');
  }
  rmState(BG4SID);
}

// Item 5: a disabled gate must still let the REST of the per-invocation checks run — in
// particular the parallel-Codex cap, in both directions (Owns disabled must not silently
// skip the cap; the cap disabled must not silently skip its own reservation/counting).
{
  const CAP5 = quotaEnv('item5-cap-disabled-owns', 10, 30, { maxParallelCodexWorkers: 1, disabledGates: ['code-brief-needs-owns'] });
  const G5SID = `${SID}-item5a`;
  rmState(G5SID);
  const tu5 = 'toolu_item5_1';
  invoke(mainBash('orca orchestration worker-start --agent codex --task item5a', { sid: G5SID, tool_use_id: tu5 }), CAP5);
  invoke(postBash('orca orchestration worker-start --agent codex --task item5a', '{"dispatchId":"ctx_item5_1"}', { sid: G5SID, tool_use_id: tu5 }), CAP5);
  const r5 = invoke(mainBash('orca orchestration worker-start --agent codex --spec "implement item5b.\nVerify: npm test"', { sid: G5SID, cwd: FAKE_REPO }), CAP5);
  if (r5.code === DENY && /max-parallel-codex-workers/.test(r5.err)) pass += 1;
  else failures.push(`item5: a disabled code-brief-needs-owns must still let the cap check run and count the dispatch (exit ${r5.code}, err ${r5.err.slice(0, 200)})`);
  rmState(G5SID);

  const CAP5b = quotaEnv('item5-cap-disabled-cap', 10, 30, { maxParallelCodexWorkers: 1, disabledGates: ['max-parallel-codex-workers'] });
  const G5bSID = `${SID}-item5b`;
  rmState(G5bSID);
  const tu5b1 = 'toolu_item5b_1';
  invoke(mainBash('orca orchestration worker-start --agent codex --task item5c', { sid: G5bSID, tool_use_id: tu5b1 }), CAP5b);
  invoke(postBash('orca orchestration worker-start --agent codex --task item5c', '{"dispatchId":"ctx_item5b_1"}', { sid: G5bSID, tool_use_id: tu5b1 }), CAP5b);
  expect('item5: disabledGates on the cap itself still allows an over-cap dispatch',
    mainBash('orca orchestration worker-start --agent codex --task item5d', { sid: G5bSID }), ALLOW, CAP5b);
  {
    const st5b = readState(G5bSID);
    const reservedCount = Object.values(st5b.reservations || {}).filter((r) => r.codexSlot).length +
      Object.values(st5b.workers || {}).filter((w) => w.status === 'live' && w.agent === 'codex').length;
    if (reservedCount >= 2) pass += 1; else failures.push(`item5: a disabled cap gate must still reserve/count the dispatch, not skip it silently (${JSON.stringify(st5b)})`);
  }
  rmState(G5bSID);
}

// Item 6: each invocation's Owns:/verify check is judged against its OWN --spec only —
// two disjoint worker-starts in one command, only the second missing Owns:, must be
// refused specifically on the second.
{
  const B6 = quotaEnv('item6-brief-scope', 10, 30, {});
  const T6SID = `${SID}-item6`;
  rmState(T6SID);
  const cmd6 = 'orca orchestration worker-start --agent codex --spec "implement p.\nVerify: npm test\nOwns: src/item6/p.ts" && ' +
    'orca orchestration worker-start --agent codex --spec "implement q.\nVerify: npm test"';
  const r6 = invoke(mainBash(cmd6, { sid: T6SID, cwd: FAKE_REPO }), B6);
  if (r6.code === DENY && /code-brief-needs-owns/.test(r6.err)) pass += 1;
  else failures.push(`item6: the second worker-start (missing Owns) must be refused specifically, not silently inherit the first's Owns: line (exit ${r6.code}, err ${r6.err.slice(0, 200)})`);
  rmState(T6SID);

  expect('item6: a single spec with Owns: is unaffected by unrelated prose earlier on the same line',
    mainBash('echo "not a spec, mentions Owns: nothing" ; orca orchestration worker-start --agent codex --spec "implement r.\nVerify: npm test\nOwns: src/item6/r.ts"',
      { sid: T6SID, cwd: FAKE_REPO }), ALLOW, B6);
  rmState(T6SID);
}

// Item 7: a worker Orca reports done (dispatchStatus "completed") but still holding its
// terminal is cap-exempt (frees capacity) WITHOUT being settled, so the Stop gate still
// catches it as a leak.
{
  const CAP7 = quotaEnv('item7-cap-exempt', 10, 30, { maxParallelCodexWorkers: 1 });
  const G7SID = `${SID}-item7`;
  rmState(G7SID);
  const tu7 = 'toolu_item7_1';
  invoke(mainBash('orca orchestration worker-start --agent codex --task item7a', { sid: G7SID, tool_use_id: tu7 }), CAP7);
  invoke(postBash('orca orchestration worker-start --agent codex --task item7a', '{"dispatchId":"ctx_item7_1"}', { sid: G7SID, tool_use_id: tu7 }), CAP7);
  const doneHeldEnv = { ...CAP7, STUB_WORKERS_JSON: JSON.stringify([
    { dispatchId: 'ctx_item7_1', terminalState: 'live', workerState: 'succeeded', dispatchStatus: 'completed' },
  ]) };
  expect('item7: a done-but-terminal-held worker is cap-exempt (frees capacity without being settled)',
    mainBash('orca orchestration worker-start --agent codex --task item7b', { sid: G7SID }), ALLOW, doneHeldEnv);
  {
    const st7 = readState(G7SID);
    if (st7.workers.ctx_item7_1.status === 'live' && st7.workers.ctx_item7_1.capExempt) pass += 1;
    else failures.push(`item7: a done-but-held worker must stay LIVE (for the Stop gate) and be marked capExempt, not settled (${JSON.stringify(st7.workers.ctx_item7_1)})`);
  }
  rmState(G7SID);
}

// Item 8: worker-start --task "$ID" (unresolved) resolves against the ONE task-create in
// the same command; retrying an already-SETTLED group goes through the normal cap check
// as brand-new capacity, never exempted as if it were replacing a still-live one.
{
  const B8 = quotaEnv('item8-var-resolve', 10, 30, {});
  const T8SID = `${SID}-item8`;
  rmState(T8SID);
  const cmd8 = 'ID=$(orca orchestration task-create --task-title "s" --spec "implement s.\nVerify: npm test\nOwns: src/item8/s.ts") && ' +
    'orca orchestration worker-start --agent codex --task "$ID"';
  expect('item8: worker-start --task "$ID" resolves against the one task-create in the same command',
    mainBash(cmd8, { sid: T8SID, cwd: FAKE_REPO }), ALLOW, B8);
  rmState(T8SID);

  const CAP8 = quotaEnv('item8-retry-settled', 10, 30, { maxParallelCodexWorkers: 1 });
  const G8SID = `${SID}-item8-retry`;
  rmState(G8SID);
  const tuA = 'toolu_item8_a';
  invoke(mainBash('orca orchestration worker-start --agent codex --task item8a', { sid: G8SID, tool_use_id: tuA }), CAP8);
  invoke(postBash('orca orchestration worker-start --agent codex --task item8a', '{"dispatchId":"ctx_item8_a"}', { sid: G8SID, tool_use_id: tuA }), CAP8);
  invoke(postBash('orca orchestration worker-release --dispatch ctx_item8_a', '{"ok":true}', { sid: G8SID }), CAP8);
  const tuB = 'toolu_item8_b';
  invoke(mainBash('orca orchestration worker-start --agent codex --task item8b', { sid: G8SID, tool_use_id: tuB }), CAP8);
  invoke(postBash('orca orchestration worker-start --agent codex --task item8b', '{"dispatchId":"ctx_item8_b"}', { sid: G8SID, tool_use_id: tuB }), CAP8);
  const r8 = invoke(mainBash('orca orchestration worker-start --agent codex --retry-of ctx_item8_a', { sid: G8SID }), CAP8);
  if (r8.code === DENY && /max-parallel-codex-workers/.test(r8.err)) pass += 1;
  else failures.push(`item8: retrying an already-settled group must not be exempted from the cap as if it were replacing a live one (exit ${r8.code}, err ${r8.err.slice(0, 200)})`);
  rmState(G8SID);
}

// Item 12: a failed tool call drops its reservation instead of leaking it until the TTL;
// --release-claims=all also clears reservations, not just agentClaims.
{
  const CAP12 = quotaEnv('item12-fail-release', 10, 30, { maxParallelCodexWorkers: 1 });
  const G12SID = `${SID}-item12`;
  rmState(G12SID);
  const tu12 = 'toolu_item12_1';
  invoke(mainBash('orca orchestration worker-start --agent codex --task item12a', { sid: G12SID, tool_use_id: tu12 }), CAP12);
  invoke({ session_id: G12SID, hook_event_name: 'PostToolUse', effort: 'high', tool_name: 'Bash',
    tool_input: { command: 'orca orchestration worker-start --agent codex --task item12a' },
    tool_use_id: tu12, tool_response: { stdout: '', stderr: 'connection reset', is_error: true } }, CAP12);
  expect('item12: a failed Bash tool call drops its reservation, freeing the cap',
    mainBash('orca orchestration worker-start --agent codex --task item12b', { sid: G12SID }), ALLOW, CAP12);
  rmState(G12SID);

  const R12SID = `${SID}-item12-release`;
  rmState(R12SID);
  const r12StateFile = path.join(STATE_DIR, `${R12SID}.json`);
  fs.writeFileSync(r12StateFile, JSON.stringify({
    session_id: R12SID, created: new Date().toISOString(), bypass: false, execAgent: null,
    workers: {}, reservations: { r_stuck: { ts: Date.now(), agent: 'codex', owns: null, ws: 'w', codexSlot: true } },
    agentClaims: {}, tasks: {}, last_heartbeat: 0, rate_limit_hits: 0,
  }));
  invoke(promptSubmit(R12SID, '--release-claims=all'), CAP12);
  {
    const st12 = readState(R12SID);
    if (!st12.reservations.r_stuck) pass += 1; else failures.push('item12: --release-claims=all must also clear reservations, not only agentClaims');
  }
  rmState(R12SID);
}

// Item 13: --worktree active/current normalize onto the "current" workspace key; a
// subagent's own worker-start is never registered at PostToolUse either (not only never
// gated/capped at PreToolUse); multiple Owns: lines in one brief all contribute.
{
  const B13 = quotaEnv('item13-worktree-normalize', 10, 30, {});
  const W13SID = `${SID}-item13-ws`;
  rmState(W13SID);
  const tu13 = 'toolu_item13_1';
  invoke(mainBash('orca orchestration worker-start --agent codex --worktree active --spec "implement t.\nVerify: npm test\nOwns: src/item13/t.ts"',
    { sid: W13SID, cwd: FAKE_REPO, tool_use_id: tu13 }), B13);
  invoke(postBash('orca orchestration worker-start --agent codex --worktree active --spec "implement t.\nVerify: npm test\nOwns: src/item13/t.ts"',
    '{"dispatchId":"ctx_item13_1"}', { sid: W13SID, cwd: FAKE_REPO, tool_use_id: tu13 }), B13);
  const r13 = invoke(mainBash('orca orchestration worker-start --agent codex --worktree current --spec "implement u.\nVerify: npm test\nOwns: src/item13/t.ts"',
    { sid: W13SID, cwd: FAKE_REPO }), B13);
  if (r13.code === DENY && /ownership-overlap/.test(r13.err)) pass += 1;
  else failures.push(`item13: --worktree active and --worktree current must normalize onto the same workspace key (exit ${r13.code}, err ${r13.err.slice(0, 200)})`);
  rmState(W13SID);

  const Sub13SID = `${SID}-item13-sub`;
  rmState(Sub13SID);
  const subPost = { session_id: Sub13SID, hook_event_name: 'PostToolUse',
    agent_id: 'ag_1', agent_type: 'general-purpose', tool_name: 'Bash',
    tool_input: { command: 'orca orchestration worker-start --agent codex --task subws' },
    tool_response: { stdout: '{"dispatchId":"ctx_item13_sub"}', stderr: '' } };
  invoke(subPost, B13);
  {
    const st13sub = readState(Sub13SID);
    if (!st13sub || !st13sub.workers || !st13sub.workers.ctx_item13_sub) pass += 1;
    else failures.push('item13: a subagent Bash worker-start must never be registered at PostToolUse either');
  }
  rmState(Sub13SID);

  const M13SID = `${SID}-item13-multi`;
  rmState(M13SID);
  expect('item13: multiple Owns: lines in one brief all count (not just the first)',
    mainBash('orca orchestration worker-start --agent codex --spec "implement v.\nVerify: npm test\nOwns: src/item13/a.ts\nsome other line\nOwns: src/item13/b.ts"',
      { sid: M13SID, cwd: FAKE_REPO }), ALLOW, B13);
  {
    const st = readState(M13SID);
    const grp = st && Object.values(st.reservations)[0];
    if (grp && grp.owns && grp.owns.includes('src/item13/a.ts') && grp.owns.includes('src/item13/b.ts')) pass += 1;
    else failures.push(`item13: both Owns: lines must be recorded (${JSON.stringify(st && st.reservations)})`);
  }
  rmState(M13SID);

  // A markdown-bold `**Owns:**` is not read as a declaration — and the refusal explains why.
  const MdSID = `${SID}-item13-md`;
  rmState(MdSID);
  const mdR = invoke(mainBash('orca orchestration worker-start --agent codex --spec "implement w.\nVerify: npm test\n**Owns:** src/item13/w.ts"',
    { sid: MdSID, cwd: FAKE_REPO }), B13);
  if (mdR.code === DENY && /code-brief-needs-owns/.test(mdR.err) && /mid-sentence.*not read|not read.*mid-sentence/i.test(mdR.err)) pass += 1;
  else failures.push(`item13: a markdown-bold **Owns:** must not be read as a declaration, and the refusal must say why (exit ${mdR.code}, err ${mdR.err.slice(0, 300)})`);
  rmState(MdSID);
}

console.log(`${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);

rmState(SID);
try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch {}
process.exit(failures.length ? 1 : 0);
