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

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GATE = path.join(__dirname, '..', 'hooks', 'orchestrator-gate.cjs');
const HEARTBEAT = path.join(__dirname, '..', 'hooks', 'orca-heartbeat.cjs');
const STUB = path.join(__dirname, 'fixtures', 'orca-stub.cjs');
try { fs.chmodSync(STUB, 0o755); } catch {}
const GIT_STUB = path.join(__dirname, 'fixtures', 'git-stub.cjs');
try { fs.chmodSync(GIT_STUB, 0o755); } catch {}
const CODEX_APP_SERVER_STUB = path.join(__dirname, 'fixtures', 'codex-app-server-stub.cjs');
try { fs.chmodSync(CODEX_APP_SERVER_STUB, 0o755); } catch {}

// The process this suite runs in may itself be an orchestrated Claude Code session (it
// is, when run under the operator's own setup) and so may carry ORCHESTRATOR_GATE,
// ORCH_*, ORCA_TERMINAL_HANDLE, CODEX_HOME or CLAUDE_CODE_* from its real environment.
// Every test env is built from this stripped base, never raw process.env, so the suite's
// outcome depends only on what each test explicitly sets.
const BASE_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !/^(ORCHESTRATOR_GATE|ORCH_|ORCA_TERMINAL_HANDLE|CODEX_HOME|CLAUDE_CODE_)/.test(k))),
  ORCH_KIMI_HOME: path.join(os.tmpdir(), `orch-e2e-empty-kimi-${process.pid}`),
  ORCH_KIMI_BIN: path.join(os.tmpdir(), `orch-e2e-missing-kimi-${process.pid}`),
  ORCH_KIMI_USAGE_URL: 'http://127.0.0.1:9/usages',
};
fs.mkdirSync(BASE_ENV.ORCH_KIMI_HOME, { recursive: true });

const SID = `e2e-${process.pid}`;
const SRC = '/work/proj/src/app.py'; // synthetic, not under any real tmp/home path

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-e2e-'));
const STATE_DIR = path.join(RUN_DIR, 'state');
fs.mkdirSync(STATE_DIR, { recursive: true });
const EMPTY_KIMI_HOME = path.join(RUN_DIR, 'empty-kimi-home');
fs.mkdirSync(EMPTY_KIMI_HOME, { recursive: true });
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
  codexHandoffUsedPercent: 95,
  codexQuotaCacheSeconds: 60,
  heartbeat: { intervalSeconds: 20, idleSeconds: 60, maxSeconds: 3600 },
  // Unlimited by default so the many unrelated tests sharing SID/state below (most never
  // issue the matching PostToolUse that would consume a reservation) cannot spuriously hit
  // the cap. The dedicated max-parallel-codex-workers tests further down set a small,
  // explicit maxParallelCodexWorkers via their own env.
  maxParallelCodexWorkers: 0,
  ownershipClaimTtlMinutes: 120,
  disabledGates: [],
  // Unlimited by default for the same reason as maxParallelCodexWorkers above: this suite
  // fires many Agent/Task dispatches across many session ids sharing one STATE_DIR, and the
  // machine-wide max-parallel-agents cap sums across ALL of them — on a low-core CI runner,
  // a derived (fraction x cores) limit could be as small as 1 and make unrelated tests fail
  // spuriously. The dedicated max-parallel-agents tests further down set their own small,
  // explicit maxParallelAgents via cfgOverrides/env.
  maxParallelAgents: 0,
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
    ORCH_CODEX_BIN: CODEX_APP_SERVER_STUB,
    ORCH_KIMI_HOME: EMPTY_KIMI_HOME,
    ORCH_KIMI_BIN: path.join(RUN_DIR, 'missing-kimi'),
    ORCH_KIMI_USAGE_URL: 'http://127.0.0.1:9/usages',
    STUB_CODEX_PRIMARY_USED: String(codexUsed),
    ORCA_BIN: STUB, CODEX_BIN: STUB,
  };
}
const CODEX_WINS = quotaEnv('codex-wins', 10, 30);   // Codex 30% used (< 95) -> Codex codes
const SONNET_WINS = quotaEnv('sonnet-wins', 10, 97); // Codex 97% used -> the code model codes

let pass = 0;
const failures = [];

/** One hook invocation, as the CLI performs it. */
function primeQuotaCache(env) {
  // Most E2E cases exercise gate wiring, not the app-server protocol itself (covered by
  // the unit suite). Prime the same live-cache format production writes so hundreds of
  // unrelated hook subprocesses do not each pay for a JSON-RPC child process.
  if (env.ORCH_STATE_DIR && env.STUB_CODEX_PRIMARY_USED !== undefined) {
    fs.mkdirSync(env.ORCH_STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.ORCH_STATE_DIR, 'codex-quota-live.json'), JSON.stringify({
      usedPercent: Number(env.STUB_CODEX_PRIMARY_USED),
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
      fetchedAt: Date.now(),
    }));
  }
}

function spawnGate(payload, env = CODEX_WINS) {
  primeQuotaCache(env);
  return spawnSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  });
}

function invoke(payload, env = CODEX_WINS) {
  const r = spawnGate(payload, env);
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

// Terminal previews can contain Codex's standing usage tip or source/diff text mentioning
// rate limits. Only an error-shaped line is a backoff signal, in both the gate's immediate
// worker-read path and the background heartbeat path covered below.
{
  const sid = `${SID}-rate-limit-lines`;
  const toolUseId = 'toolu_rate_limit_lines';
  const start = 'orca orchestration worker-start --agent codex --task rate-limit-lines --json';
  rmState(sid);
  invoke(mainBash(start, { sid, tool_use_id: toolUseId }), CODEX_WINS);
  invoke(postBash(start, '{"dispatchId":"ctx_rate_limit_lines"}', { sid, tool_use_id: toolUseId }), CODEX_WINS);

  const tip = 'Tip: When signed in with ChatGPT, use /usage to check your account usage and access available usage\n' +
    'limit resets.';
  invoke(postBash('orca orchestration worker-read --dispatch ctx_rate_limit_lines', tip, { sid }), CODEX_WINS);
  checkBool('Codex standing usage tip does not mark workers rate-limited',
    readState(sid)?.rate_limit_hits, 0);

  invoke(postBash('orca orchestration worker-read --dispatch ctx_rate_limit_lines',
    "■ You've hit your usage limit. Try again after the limit resets.", { sid }), CODEX_WINS);
  checkBool('a real-looking Codex usage-limit error marks workers rate-limited',
    readState(sid)?.rate_limit_hits, 1);

  invoke(postBash('orca orchestration worker-read --dispatch ctx_rate_limit_lines --json',
    JSON.stringify({ ok: true, result: { preview: '■ Rate limit hit\nRetry later' } }), { sid }), CODEX_WINS);
  checkBool('worker-read --json scans unescaped string values for line-start rate-limit markers',
    readState(sid)?.rate_limit_hits, 2);
  rmState(sid);
}

// A single Agent PreToolUse evaluates routing twice along the execution path. A failed
// live lookup is process-local memoized, so this one hook process may spawn at most one
// quota probe. The real Codex CLI is never touched: ORCH_CODEX_BIN points at the stub.
{
  const dir = path.join(RUN_DIR, 'failed-quota-one-probe');
  const callsLog = path.join(dir, 'codex-calls.log');
  const stateDir = path.join(dir, 'state');
  const sessionsDir = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const env = {
    ...BASE_ENV,
    ORCH_STATE_DIR: stateDir,
    ORCH_CONFIG_PATH: CONFIG_FILE,
    ORCH_CODEX_BIN: CODEX_APP_SERVER_STUB,
    CODEX_BIN: CODEX_APP_SERVER_STUB,
    CODEX_SESSIONS_DIR: sessionsDir,
    STUB_CODEX_MODE: 'malformed',
    STUB_CODEX_CALLS_LOG: callsLog,
    ORCA_BIN: STUB,
  };
  const r = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify(dispatch({
      subagent_type: 'fullstack-developer', description: 'implement x', model: 'sonnet',
      prompt: 'Owns: n/a isolated probe\nVerify: npm test', isolation: 'worktree',
    }, 'failed-quota-one-probe')),
    encoding: 'utf8', env,
  });
  const calls = fs.readFileSync(callsLog, 'utf8').trim().split('\n').filter(Boolean).length;
  if (r.status === DENY && calls === 1) pass += 1;
  else failures.push(`one Agent PreToolUse should pay at most one failed quota probe; exit=${r.status}, probes=${calls}`);
}

// A state-lock filesystem error is not lock contention. Both a missing parent and a path
// beneath a regular file make mkdir(.lock) fail immediately; the hard Agent cap must degrade
// to allow instead of reporting the worker budget as contended.
{
  const dir = path.join(RUN_DIR, 'lock-fs-errors');
  fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, 'orchestration.config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...DEFAULT_CFG, maxParallelAgents: 1 }));
  const payload = dispatch({ subagent_type: 'Explore', description: 'find the relevant files', model: 'haiku' },
    'lock-fs-errors', { tool_use_id: 'toolu_lock_fs' });
  const base = { ...BASE_ENV, ORCA_BIN: STUB, ORCH_CODEX_BIN: CODEX_APP_SERVER_STUB,
    CODEX_BIN: CODEX_APP_SERVER_STUB, ORCH_CONFIG_PATH: cfg };

  const missingState = path.join(dir, 'missing-parent', 'state');
  const missing = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { ...base, ORCH_STATE_DIR: missingState },
  });
  if (missing.status === ALLOW) pass += 1;
  else failures.push(`Agent dispatch with a missing state parent must degrade to allow; exit=${missing.status}, stderr=${missing.stderr}`);

  const nonDirectoryParent = path.join(dir, 'not-a-directory');
  fs.writeFileSync(nonDirectoryParent, 'x');
  const unwritable = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({ ...payload, session_id: 'lock-fs-errors-2', tool_use_id: 'toolu_lock_fs_2' }),
    encoding: 'utf8', env: { ...base, ORCH_STATE_DIR: path.join(nonDirectoryParent, 'state') },
  });
  if (unwritable.status === ALLOW) pass += 1;
  else failures.push(`Agent dispatch with an unusable state path must degrade to allow; exit=${unwritable.status}, stderr=${unwritable.stderr}`);
}

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
for (const description of [
  'Update the parser to fix X',
  'Write code for Y',
  'Merge and implement follow-ups',
  'Tag release v2 and fix changelog',
  'Re-implement the parser',
  'Hot-fix the heartbeat',
  'Bug-fix the heartbeat',
]) {
  const result = invoke(dispatch({ subagent_type: 'fullstack-developer', description, model: 'sonnet' }));
  if (result.code === DENY && /route-execution-to-codex/.test(result.err)) pass += 1;
  else failures.push(`${description} must route as code\n    exit=${result.code}, stderr=${result.err.slice(0, 200)}`);
}
expect('a neutral Commit verb is not misclassified by review-fix later in the description',
  dispatch({ subagent_type: 'git-manager', description: 'Commit review-fix round in worktree', model: 'sonnet' }), ALLOW);
expect('a neutral Update verb is not misclassified by red-team-fix later in the description',
  dispatch({ subagent_type: 'docs-manager', description: 'Update red-team-fix notes', model: 'sonnet' }), ALLOW);
expect('a neutral Merge verb is not misclassified by plan-build later in the description',
  dispatch({ subagent_type: 'git-manager', description: 'Merge the plan-build notes', model: 'sonnet' }), ALLOW);
expect('a neutral Commit verb is not misclassified by a later plan noun',
  dispatch({ subagent_type: 'git-manager', description: 'Commit the plan file', model: 'sonnet' }), ALLOW);
expect('a neutral Update verb is not misclassified by a later design noun',
  dispatch({ subagent_type: 'docs-manager', description: 'Update design tokens doc', model: 'sonnet' }), ALLOW);
{
  const result = invoke(dispatch({ subagent_type: 'reviewer', description: 'Review the diff', model: 'sonnet' }));
  if (result.code === DENY && /route-review/.test(result.err)) pass += 1;
  else failures.push(`Review the diff must route as review\n    exit=${result.code}, stderr=${result.err.slice(0, 200)}`);
}
{
  const result = invoke(dispatch({ subagent_type: 'fullstack-developer', description: 'Implement the plan', model: 'sonnet' }));
  if (result.code === DENY && /route-execution-to-codex/.test(result.err)) pass += 1;
  else failures.push(`Implement the plan must route as code\n    exit=${result.code}, stderr=${result.err.slice(0, 200)}`);
}
expect('Generate release notes is not code work',
  dispatch({ subagent_type: 'content-creator', description: 'Generate release notes', model: 'sonnet' }), ALLOW);
for (const description of ['Generate code', 'Generate assets', 'Generate components']) {
  const result = invoke(dispatch({ subagent_type: 'fullstack-developer', description, model: 'sonnet' }));
  if (result.code === DENY && /route-execution-to-codex/.test(result.err)) pass += 1;
  else failures.push(`${description} must route as code\n    exit=${result.code}, stderr=${result.err.slice(0, 200)}`);
}
{
  const result = invoke(dispatch({ subagent_type: 'code-reviewer', description: 'Update the findings', model: 'sonnet' }));
  if (result.code === DENY && /route-review/.test(result.err)) pass += 1;
  else failures.push(`a neutral first verb must preserve code-reviewer review routing\n    exit=${result.code}, stderr=${result.err.slice(0, 200)}`);
}
{
  const result = invoke(dispatch({ subagent_type: 'code-reviewer', description: 'Implement the plan', model: 'sonnet' }));
  if (result.code === DENY && /route-execution-to-codex/.test(result.err)) pass += 1;
  else failures.push(`an execution first verb must override code-reviewer review routing\n    exit=${result.code}, stderr=${result.err.slice(0, 200)}`);
}
{
  const result = invoke(dispatch({ subagent_type: 'code-reviewer', description: 'Update the parser to fix X', model: 'sonnet' }));
  if (result.code === DENY && /route-execution-to-codex/.test(result.err) && !/route-review/.test(result.err)) pass += 1;
  else failures.push(`code intent must override code-reviewer review routing\n    exit=${result.code}, stderr=${result.err.slice(0, 200)}`);
}

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
// Compaction summaries arrive in a user-role payload but are generated by the harness.
// Quoted prompts inside them must not become fresh operator instructions.
{
  const CSID = `${SID}-compact-summary`;
  const compact = 'This session is being continued from a previous conversation that ran out of context.\n' +
    'Summary:\nEarlier prompt: --no-orchestrate\nEarlier prompt: --exec-sonnet\nEarlier prompt: --code-model opus';
  invoke(promptSubmit(CSID, compact), CODEX_WINS);
  const st = readState(CSID);
  if (!st || (st.bypass === false && st.execAgent == null)) pass += 1;
  else failures.push(`a continued-session summary toggled operator flags (${JSON.stringify(st && { bypass: st.bypass, execAgent: st.execAgent })})`);
  rmState(CSID);

  const EMBEDDED_SID = `${SID}-embedded-summary`;
  invoke(promptSubmit(EMBEDDED_SID, 'Context from the prior conversation follows.\nSummary:\n--exec-sonnet'), CODEX_WINS);
  const st2 = readState(EMBEDDED_SID);
  if (!st2 || st2.execAgent == null) pass += 1;
  else failures.push(`an embedded Summary: block toggled --exec-sonnet (${JSON.stringify(st2 && st2.execAgent)})`);
  rmState(EMBEDDED_SID);

  const MARKDOWN_SID = `${SID}-ordinary-summary-heading`;
  invoke(promptSubmit(MARKDOWN_SID, '--no-orchestrate'), CODEX_WINS);
  invoke(promptSubmit(MARKDOWN_SID, 'Summary:\nPlease proceed --orchestrate'), CODEX_WINS);
  const markdownState = readState(MARKDOWN_SID);
  if (markdownState && markdownState.bypass === false) pass += 1;
  else failures.push('an ordinary operator Summary: heading suppressed --orchestrate');
  rmState(MARKDOWN_SID);

  const GENUINE_SID = `${SID}-genuine-override`;
  invoke(promptSubmit(GENUINE_SID, 'Use the configured code model now --exec-sonnet'), CODEX_WINS);
  const st3 = readState(GENUINE_SID);
  if (st3 && st3.execAgent === 'claude:sonnet') pass += 1;
  else failures.push('compaction protection prevented a later genuine operator flag');
  rmState(GENUINE_SID);
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
                   'sudo orca orchestration worker-start --task t --agent codex',
                   'if true; then orca orchestration worker-start --task t --agent codex; fi']) {
    if (registered(c)) pass += 1; else failures.push(`real worker start not registered: ${c}`);
  }
  for (const c of ['id=$(orca orchestration worker-start --task t --agent codex)',
                   'id=`orca orchestration worker-start --task t --agent codex`']) {
    rmState(RS);
    invoke(post(c), CODEX_WINS);
    const workers = ((readState(RS) || {}).workers || {});
    if (!workers.ctx_rv_1 && Object.keys(workers).some((id) => id.startsWith('pending-'))) pass += 1;
    else failures.push(`captured worker-start output must not claim the tool stdout reply: ${c}`);
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
  const out = spawnGate(promptSubmit(RS, 'status?'), SONNET_WINS).stdout;
  if (/code -> sonnet, effort medium: Agent subagent_type sonnet-coder \+ model sonnet \[Codex quota 97% used .*Kimi not installed/.test(out) && !/undefined/.test(out)) pass += 1;
  else failures.push(`auto route to the code model must name model "sonnet", never "undefined": ${out.slice(0, 200)}`);
  const bare = spawnGate(promptSubmit(RS, 'please --code-model'), CODEX_WINS).stdout;
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
  const r = spawnGate(payload, CODEX_WINS);
  if (r.status === 0 && /Prefer model \\"haiku\\"|Prefer model "haiku"/.test(r.stdout)) pass += 1;
  else failures.push(`lookup dispatch should be allowed with a haiku advice (exit ${r.status}, stdout ${String(r.stdout).slice(0, 80)})`);
  const r2 = spawnGate(dispatch({ subagent_type: 'Explore', description: 'find the loader', model: 'haiku' }), CODEX_WINS);
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
  if (st && st.execAgent === 'claude:sonnet') pass += 1;
  else failures.push(`--exec-sonnet did not persist execAgent='claude:sonnet' in state (got ${JSON.stringify(st && st.execAgent)})`);
  if (st && !Number.isNaN(Date.parse(st.execAgentSince))) pass += 1;
  else failures.push(`--exec-sonnet did not persist an ISO execAgentSince timestamp (${JSON.stringify(st && st.execAgentSince)})`);
  const reminder = spawnGate(promptSubmit(SID, 'status?'), CODEX_WINS).stdout;
  if (st && reminder.includes(`code forced to Sonnet since ${st.execAgentSince} (--exec-sonnet); --code-model auto to return to quota routing`)) pass += 1;
  else failures.push(`per-prompt reminder did not expose the active --exec-sonnet override: ${reminder.slice(0, 240)}`);
  const banner = spawnGate({ session_id: SID, hook_event_name: 'SessionStart' }, CODEX_WINS).stdout;
  if (st && banner.includes(`code forced to Sonnet since ${st.execAgentSince} (--exec-sonnet); --code-model auto to return to quota routing`)) pass += 1;
  else failures.push(`SessionStart did not expose the active --exec-sonnet override: ${banner.slice(0, 240)}`);
}
expect('exec-intent dispatch on sonnet is allowed once --exec-sonnet is set',
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet', prompt: 'Implement it. Verify: npm test (all pass).\nOwns: n/a (pre-existing gate test, unrelated to ownership).' }), ALLOW);
expect('--exec-sonnet still requires model sonnet',
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan' }), DENY);
expect('plan/review routing to Opus is unaffected by --exec-sonnet',
  dispatch({ subagent_type: 'planner', description: 'plan the refactor', model: 'sonnet' }), DENY);

// Fix 7: the code model's dispatch shape (effort + agent subagent_type) is config-driven and
// surfaced in the banner, the per-prompt reminder and the mismatch refusal advice.
{
  const F7SID = `${SID}-fix7`;
  rmState(F7SID);
  const banner = spawnGate({ session_id: F7SID, hook_event_name: 'SessionStart' }, SONNET_WINS).stdout;
  if (/sonnet, effort medium: Agent subagent_type sonnet-coder \+ model sonnet/.test(banner)) pass += 1;
  else failures.push(`SessionStart banner must name the code dispatch shape (effort + agentType): ${banner.slice(0, 400)}`);
  const reminder = spawnGate(promptSubmit(F7SID, 'status?'), SONNET_WINS).stdout;
  if (/sonnet, effort medium: Agent subagent_type sonnet-coder \+ model sonnet/.test(reminder)) pass += 1;
  else failures.push(`per-prompt reminder must name the code dispatch shape: ${reminder.slice(0, 400)}`);
  const mismatch = invoke(dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'haiku',
    prompt: 'Implement it. Verify: npm test (all pass).\nOwns: n/a (test).' }, F7SID), SONNET_WINS);
  if (mismatch.code === DENY && /subagent_type sonnet-coder \+ model "sonnet" \(effort medium\)/.test(mismatch.err)) pass += 1;
  else failures.push(`execution-model-mismatch advice must name subagent_type + effort (exit ${mismatch.code}): ${mismatch.err.slice(0, 300)}`);
  // models.code.effort / agentType are configurable; an invalid effort warns and defaults.
  const f7Cfg = {
    models: {
      review: { alias: 'opus', id: 'claude-opus-5-5' },
      escalation: { alias: 'fable', id: 'claude-fable-5-1' },
      code: { alias: 'sonnet', id: 'claude-sonnet-5-5', effort: 'high', agentType: 'my-coder' },
      lookup: { alias: 'haiku', id: null },
      codex: { alias: null, id: 'gpt-5.6-sol' },
    },
  };
  const f7Env = quotaEnv('fix7-custom', 10, 97, f7Cfg);
  const f7Banner = spawnGate({ session_id: `${F7SID}-custom`, hook_event_name: 'SessionStart' }, f7Env).stdout;
  if (/sonnet \(claude-sonnet-5-5\), effort high: Agent subagent_type my-coder \+ model sonnet; Orca Claude worker: --model claude-sonnet-5-5 --effort high/.test(f7Banner)) pass += 1;
  else failures.push(`a configured effort/agentType/id must shape the dispatch text: ${f7Banner.slice(0, 400)}`);
  const f7BadEnv = quotaEnv('fix7-bad-effort', 10, 97, {
    models: { ...f7Cfg.models, code: { alias: 'sonnet', id: null, effort: 'bogus', agentType: '' } },
  });
  const f7Bad = spawnGate({ session_id: `${F7SID}-bad`, hook_event_name: 'SessionStart' }, f7BadEnv).stdout;
  if (/models\.code\.effort "bogus"/.test(f7Bad) && /models\.code\.agentType must be a non-empty string/.test(f7Bad) &&
      /sonnet, effort medium: Agent subagent_type sonnet-coder \+ model sonnet/.test(f7Bad)) pass += 1;
  else failures.push(`an invalid effort/agentType must warn and fall back to the defaults: ${f7Bad.slice(0, 500)}`);
  rmState(F7SID);
}

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
  if (st && st.execAgent == null && st.execAgentSince == null) pass += 1;
  else failures.push(`--exec-auto did not clear execAgent and execAgentSince (got ${JSON.stringify(st && { execAgent: st.execAgent, execAgentSince: st.execAgentSince })})`);
}
// Automatic routing: Codex first, the code model once Codex has used >= 95%.
expect('auto: Codex under 95% used -> in-session sonnet code is refused',
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet' }), DENY, CODEX_WINS);
expect('auto: Codex at/over 95% used -> in-session sonnet code is allowed',
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan', model: 'sonnet', prompt: 'Implement it. Verify: npm test (all pass).\nOwns: n/a (pre-existing gate test, unrelated to ownership).' }), ALLOW, SONNET_WINS);
expect('auto: Codex at/over 95% used -> code on another model is refused',
  dispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan' }), DENY, SONNET_WINS);

// --no-orchestrate must still fully bypass everything, unaffected by the exec-agent
// preference. Isolated session id so it cannot leak bypass state into other assertions.
{
  const BYPASS_SID = `${SID}-bypass`;
  const bypassEdit = (file_path) => mainEdit(file_path, BYPASS_SID);
  const bypassDispatch = (tool_input) => dispatch(tool_input, BYPASS_SID);

  expect('--no-orchestrate is accepted', promptSubmit(BYPASS_SID, '--no-orchestrate for this session'), ALLOW);
  {
    const st = readState(BYPASS_SID);
    if (st && !Number.isNaN(Date.parse(st.bypassSince))) pass += 1;
    else failures.push(`--no-orchestrate did not persist an ISO bypassSince timestamp (${JSON.stringify(st && st.bypassSince)})`);
    const reminder = spawnGate(promptSubmit(BYPASS_SID, 'status?'), CODEX_WINS).stdout;
    if (st && reminder.includes(`GATES OFF for this session since ${st.bypassSince} (--no-orchestrate); type --orchestrate to re-enable`)) pass += 1;
    else failures.push(`per-prompt reminder did not expose bypass: ${reminder.slice(0, 240)}`);
    const banner = spawnGate({ session_id: BYPASS_SID, hook_event_name: 'SessionStart' }, CODEX_WINS).stdout;
    if (st && banner.includes(`GATES OFF for this session since ${st.bypassSince} (--no-orchestrate); type --orchestrate to re-enable`)) pass += 1;
    else failures.push(`SessionStart did not expose bypass: ${banner.slice(0, 240)}`);
  }
  expect('bypass allows the main panel to edit product code', bypassEdit(SRC), ALLOW);
  expect('bypass allows an exec-intent dispatch with no exec-agent flag at all',
    bypassDispatch({ subagent_type: 'fullstack-developer', description: 'implement the plan' }), ALLOW);

  expect('--orchestrate is accepted after bypass', promptSubmit(BYPASS_SID, '--orchestrate'), ALLOW);
  {
    const st = readState(BYPASS_SID);
    if (st && st.bypass === false && st.bypassSince == null) pass += 1;
    else failures.push(`--orchestrate did not clear bypassSince (${JSON.stringify(st && st.bypassSince)})`);
  }
  expect('--orchestrate re-enables the main-panel write gate', bypassEdit(SRC), DENY);

  expect('last bypass flag wins when --orchestrate comes last',
    promptSubmit(BYPASS_SID, '--no-orchestrate then --orchestrate'), ALLOW);
  expect('a last --orchestrate leaves gates enabled', bypassEdit(SRC), DENY);
  expect('last bypass flag wins when --no-orchestrate comes last',
    promptSubmit(BYPASS_SID, '--orchestrate then --no-orchestrate'), ALLOW);
  expect('a last --no-orchestrate leaves gates disabled', bypassEdit(SRC), ALLOW);

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
    ORCA_BIN: orcaBin, CODEX_BIN: codexBin, ORCH_CODEX_BIN: codexBin,
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
  const out = spawnGate(promptSubmit(RSID, 'status?'), CODEX_WINS).stdout;
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
  const out1 = spawnGate(promptSubmit(RSID, 'status?'), noLangEnv).stdout;
  if (!/Reply to the operator/.test(out1)) pass += 1; else failures.push('replyLanguage null must omit the language sentence');
  rmState(RSID);
  const out2 = spawnGate(promptSubmit(RSID, 'status?'), withLangEnv).stdout;
  if (/Reply to the operator in Vietnamese/.test(out2)) pass += 1; else failures.push('a configured replyLanguage must appear in the reminder');
  rmState(RSID);
}

// A changed handoff threshold changes the banner text (amendment 6).
{
  const t60Env = quotaEnv('threshold-60', 10, 30, { codexHandoffUsedPercent: 60 });
  const RSID = `${SID}-threshold`;
  const out = spawnGate({ session_id: RSID, hook_event_name: 'SessionStart' }, t60Env).stdout;
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
  const out1 = spawnGate(p1, CODEX_WINS).stdout;
  if (/Heartbeat daemon alive/.test(out1)) pass += 1; else failures.push(`reminder did not see a live heartbeat: ${out1.slice(0, 120)}`);
  fs.writeFileSync(beatF, JSON.stringify({ pid: 999999, last_tick: Date.now(), interval: 20 }));
  const out2 = spawnGate(p1, CODEX_WINS).stdout;
  if (/NO heartbeat daemon/.test(out2)) pass += 1; else failures.push(`reminder trusted a dead heartbeat pid: ${out2.slice(0, 120)}`);
  for (const f of [stateF, beatF]) { try { fs.unlinkSync(f); } catch {} }
}

// =====================================================================================
// Gate A: max-parallel-codex-workers
// =====================================================================================
// A readiness-timeout worker may be retained and driven through its live terminal. Once
// this session explicitly runs worker-retain, a finished row is informational at Stop,
// while a row that is still running must remain heartbeat-supervised.
{
  const env = quotaEnv('retained-readiness-worker', 10, 30, { maxParallelCodexWorkers: 1 });
  const sid = `${SID}-retained-readiness`;
  const dispatchId = 'ctx_retained_readiness';
  const terminalHandle = 'term_retained_readiness';
  const toolUseId = 'toolu_retained_readiness';
  const startCommand = 'orca orchestration worker-start --agent codex --task retained-readiness';
  rmState(sid);
  invoke(mainBash(startCommand, { sid, tool_use_id: toolUseId }), env);
  invoke(postBash(startCommand, JSON.stringify({ dispatchId, agentTerminalHandle: terminalHandle }),
    { sid, tool_use_id: toolUseId }), env);
  invoke(postBash(`orca orchestration worker-retain --dispatch ${dispatchId} --json`, '{"ok":true}', { sid }), env);
  const retainedState = readState(sid);
  checkBool('retained readiness: worker-retain marks the tracked group explicit and cap-exempt',
    retainedState.workers[dispatchId].retained === true && retainedState.workers[dispatchId].capExempt === true, true);

  const retainedEnv = { ...env, STUB_WORKERS_JSON: JSON.stringify([{
    dispatchId,
    agentTerminalHandle: terminalHandle,
    terminalState: 'retained',
    workerState: 'succeeded',
    dispatchStatus: 'completed',
  }]) };
  const beatFile = path.join(STATE_DIR, `heartbeat-${sid}.json`);
  fs.writeFileSync(beatFile, JSON.stringify({ pid: process.pid, last_tick: Date.now(), interval: 20 }));
  expect('retained readiness: Stop is allowed while the heartbeat supervises the retained terminal',
    { session_id: sid, hook_event_name: 'Stop', effort: 'high', stop_hook_active: false }, ALLOW, retainedEnv);
  fs.unlinkSync(beatFile);
  expect('retained readiness: a succeeded retained worker is informational and needs no heartbeat at Stop',
    { session_id: sid, hook_event_name: 'Stop', effort: 'high', stop_hook_active: false }, ALLOW, retainedEnv);

  const runningEnv = { ...env, STUB_WORKERS_JSON: JSON.stringify([{
    dispatchId,
    agentTerminalHandle: terminalHandle,
    terminalState: 'retained',
    workerState: 'running',
    dispatchStatus: 'running',
  }]) };
  const unwatched = invoke(
    { session_id: sid, hook_event_name: 'Stop', effort: 'high', stop_hook_active: false }, runningEnv);
  checkBool('retained readiness: a running retained worker without a heartbeat is listed as unwatched',
    unwatched.code === DENY && /workers-unwatched/.test(unwatched.err) &&
      /ctx_retained_readiness.*\(retained\)/.test(unwatched.err) &&
      !/0 worker\(s\) still running/.test(unwatched.err),
    true);
  rmState(sid);
}

// A failed readiness probe can still leave a usable terminal behind. The PostToolUse hook
// must turn that otherwise-generic failure into concrete recovery advice for the returned
// terminal and dispatch, without launching any real Codex process.
{
  const env = quotaEnv('readiness-timeout-advice', 10, 30, { maxParallelCodexWorkers: 1 });
  const sid = `${SID}-readiness-timeout-advice`;
  const toolUseId = 'toolu_readiness_timeout_advice';
  const command = 'orca orchestration worker-start --agent codex --spec "implement readiness.\nVerify: npm test\nOwns: src/readiness-timeout.ts" --json';
  rmState(sid);
  invoke(mainBash(command, { sid, cwd: FAKE_REPO, tool_use_id: toolUseId }), env);
  const result = invoke(postBash(command, JSON.stringify({
    ok: false,
    result: {
      stage: 'agent_readiness', lastError: 'timeout', dispatchId: 'ctx_readiness_timeout',
      agentTerminalHandle: 'term_readiness_timeout',
    },
  }), { sid, cwd: FAKE_REPO, tool_use_id: toolUseId }), env);
  checkBool('failed readiness worker-start prints terminal-send and worker-retain recovery advice',
    result.out.includes('orca terminal send --terminal term_readiness_timeout') &&
      result.out.includes('--enter') &&
      result.out.includes('orca orchestration worker-retain --dispatch ctx_readiness_timeout'),
    true);

  const timedOut = readState(sid)?.workers?.ctx_readiness_timeout;
  checkBool('failed readiness worker-start tracks the returned worker and preserves its reservation metadata',
    timedOut?.status === 'live' && timedOut?.agent === 'codex' && timedOut?.readinessTimeout === true &&
      timedOut?.owns?.includes('src/readiness-timeout.ts') && timedOut?.ws === `${FAKE_REPO}|current`,
    true);

  invoke(postBash('orca orchestration worker-retain --dispatch ctx_readiness_timeout --json',
    '{"ok":true}', { sid }), env);
  const retained = readState(sid)?.workers?.ctx_readiness_timeout;
  checkBool('retaining a readiness-timeout worker keeps it live and counted by the Codex cap',
    retained?.retained === true && retained?.capExempt !== true,
    true);

  const capped = invoke(mainBash(
    'orca orchestration worker-start --agent codex --spec "implement another.\nVerify: npm test\nOwns: src/other.ts"',
    { sid, cwd: FAKE_REPO }), env);
  checkBool('a retained readiness-timeout worker consumes the configured Codex slot',
    capped.code === DENY && /max-parallel-codex-workers/.test(capped.err), true);

  const overlap = invoke(mainBash(
    'orca orchestration worker-start --agent codex --spec "implement overlap.\nVerify: npm test\nOwns: src/readiness-timeout.ts"',
    { sid, cwd: FAKE_REPO }), { ...env, ORCH_MAX_PARALLEL_CODEX_WORKERS: '2' });
  checkBool('a retained readiness-timeout worker keeps its Owns claim',
    overlap.code === DENY && /ownership-overlap/.test(overlap.err), true);
  rmState(sid);
}

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

  // Two genuinely parallel tool calls can carry byte-for-byte identical commands. A fresh
  // same-hash reservation belongs to the first in-flight call, not a denied/retried call.
  {
    const CAP1 = quotaEnv('cap-1-identical-race', 10, 30, { maxParallelCodexWorkers: 1 });
    const RaceSID = `${SID}-cap-identical-race`;
    const command = 'orca orchestration worker-start --agent codex --task identical';
    rmState(RaceSID);
    expect('identical cap race: the first worker-start reserves the only opening',
      mainBash(command, { sid: RaceSID, tool_use_id: 'toolu_identical_1' }), ALLOW, CAP1);
    expect('identical cap race: a second fresh same-command start is refused while the first is in flight',
      mainBash(command, { sid: RaceSID, tool_use_id: 'toolu_identical_2' }), DENY, CAP1);
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
  // this quota favours the code model (Codex >= 95% used), same shape as SONNET_WINS.
  const OWNS_AGENT_ENV = quotaEnv('owns-agent', 10, 97, {});
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
      // The id must sit inside its own <tool-use-id> tag (the real notification shape) —
      // matching it anywhere in the free-text body is exactly the false-positive round 2's
      // item 7 fix closed (a sibling's id merely mentioned in <result> text must NOT release).
      invoke(promptSubmit(ASID, '<task-notification><tool-use-id>toolu_bg_1</tool-use-id><status>completed</status>' +
        '<result>Background task finished successfully.</result></task-notification>'), OWNS_AGENT_ENV);
      const st2 = readState(ASID);
      if (!st2.agentClaims.toolu_bg_1) pass += 1; else failures.push('owns: a <task-notification> naming a claim id must release it');
    }

    // Subagent payloads are never gated.
    expect('owns: a subagent exec dispatch is never gated by code-brief-needs-owns',
      { session_id: ASID, hook_event_name: 'PreToolUse', agent_id: 'ag_1', agent_type: 'general-purpose',
        tool_name: 'Agent', tool_input: execBrief(null) }, ALLOW, OWNS_AGENT_ENV);

    expect('owns: disabledGates lets an in-session exec dispatch without Owns: through',
      dispatch(execBrief(null), ASID, { cwd: FAKE_REPO }), ALLOW,
      quotaEnv('owns-agent-disabled', 10, 97, { disabledGates: ['code-brief-needs-owns'] }));

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
  const B4 = quotaEnv('item4-bg', 10, 97, {});
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

// --- Second Opus 5.5 review round -------------------------------------------------------

// Round 2, item 3: a REAL PostToolUseFailure event (Claude Code's actual failure event,
// distinct from PostToolUse) drops the reservation/claim its PreToolUse made, UNLESS the
// failed Bash command was itself dispatch-shaped and no id can be found in its `error`
// text — round 3 item 1 tightened that: an unresolvable dispatch outcome must not be
// assumed to have failed (see the round-3 block below), so this bare-failure case (no
// `error` text at all) now correctly LEAVES the reservation in place rather than freeing
// the cap, and the next worker-start at the same cap is refused.
{
  const CAP3b = quotaEnv('round2-item3-failure-event', 10, 30, { maxParallelCodexWorkers: 1 });
  const G3bSID = `${SID}-round2-item3`;
  rmState(G3bSID);
  const tu3b = 'toolu_round2_item3';
  invoke(mainBash('orca orchestration worker-start --agent codex --task round2item3a', { sid: G3bSID, tool_use_id: tu3b }), CAP3b);
  invoke({ session_id: G3bSID, hook_event_name: 'PostToolUseFailure', effort: 'high', tool_name: 'Bash',
    tool_input: { command: 'orca orchestration worker-start --agent codex --task round2item3a' },
    tool_use_id: tu3b }, CAP3b);
  expect('round2 item3: a dispatch-shaped PostToolUseFailure with no id in `error` keeps the reservation (round 3 item 1)',
    mainBash('orca orchestration worker-start --agent codex --task round2item3b', { sid: G3bSID }), DENY, CAP3b);
  rmState(G3bSID);
}

// Round 2, item 3b: a PostToolUseFailure for a NON-dispatch Bash command (nothing to
// preserve) still drops the reservation/claim immediately, same as before round 3.
{
  const CAP3c = quotaEnv('round2-item3-nondispatch-failure', 10, 30, { maxParallelCodexWorkers: 1 });
  const G3cSID = `${SID}-round2-item3-nondispatch`;
  rmState(G3cSID);
  const tu3c = 'toolu_round2_item3_nondispatch';
  // Seed a reservation directly (a plain `npm test` failure never goes through the
  // dispatch-gate PreToolUse path, so there is nothing realistic to reserve here — this
  // proves the CLEANUP side only: a stray reservation under this tool_use_id must still be
  // dropped when the failing command has no dispatch sub-command in it at all).
  const st3c = { session_id: G3cSID, created: new Date().toISOString(), bypass: false, execAgent: null,
    workers: {}, reservations: { [tu3c]: { ts: Date.now(), agent: 'codex', owns: null, ws: null, codexSlot: true } },
    agentClaims: {}, tasks: {}, last_heartbeat: 0, rate_limit_hits: 0 };
  fs.writeFileSync(path.join(STATE_DIR, `${G3cSID}.json`), JSON.stringify(st3c));
  invoke({ session_id: G3cSID, hook_event_name: 'PostToolUseFailure', effort: 'high', tool_name: 'Bash',
    tool_input: { command: 'npm test' }, tool_use_id: tu3c, error: 'Exit code 1\nfailures: 2' }, CAP3c);
  const after3c = JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${G3cSID}.json`), 'utf8'));
  if (!after3c.reservations[tu3c]) pass += 1;
  else failures.push('round2 item3b: a non-dispatch PostToolUseFailure must still drop the reservation');
  rmState(G3cSID);
}

// --- Third Opus 5.5 review round --------------------------------------------------------

// Round 3, item 1a: `orca orchestration worker-start ... --json && false` genuinely
// dispatches the worker before the trailing `&& false` makes the overall Bash call report
// non-zero — Claude Code's PostToolUseFailure carries that real output in `p.error`. A real
// dispatch id found there must be registered and count against the cap exactly like a
// successful PostToolUse would, not be dropped.
{
  const CAP1a = quotaEnv('round3-item1-real-dispatch', 10, 30, { maxParallelCodexWorkers: 1 });
  const G1aSID = `${SID}-round3-item1a`;
  rmState(G1aSID);
  const tu1a = 'toolu_round3_item1a';
  const cmd1a = 'orca orchestration worker-start --spec @a.md --agent codex --json && false';
  invoke(mainBash(cmd1a, { sid: G1aSID, tool_use_id: tu1a }), CAP1a);
  invoke({ session_id: G1aSID, hook_event_name: 'PostToolUseFailure', effort: 'high', tool_name: 'Bash',
    tool_input: { command: cmd1a }, tool_use_id: tu1a,
    error: 'Exit code 1\n{"ok":true,"result":{"dispatchId":"ctx_round3_1a","taskId":"task_round3_1a"}}' }, CAP1a);
  const after1a = readState(G1aSID);
  if (after1a && after1a.workers.ctx_round3_1a && after1a.workers.ctx_round3_1a.status === 'live' && !after1a.reservations[tu1a]) pass += 1;
  else failures.push(`round3 item1a: a real dispatch id in PostToolUseFailure's error text must be registered as a live worker (${JSON.stringify(after1a && after1a.workers)})`);
  expect('round3 item1a: the next worker-start at the same cap is correctly refused (the earlier dispatch really is live)',
    mainBash('orca orchestration worker-start --spec @b.md --agent codex --json', { sid: G1aSID }), DENY, CAP1a);
  rmState(G1aSID);
}

// Round 3, item 1b: a genuinely failed dispatch (no id anywhere in `p.error`) must not be
// assumed to have failed OR succeeded — the reservation survives immediately and is only
// ever cleaned up by its TTL (covered by round2 item3 above), never dropped outright here.
// Already covered by the updated round2-item3 test; this case is intentionally the same
// code path, kept here only as a named cross-reference for item 1b of round 3.

// Round 3, item 1c: an interrupted dispatch-shaped Bash call (`is_interrupt: true`) with no
// id in `error` must be treated the same conservative way — reservation kept, not dropped.
{
  const CAP1c = quotaEnv('round3-item1-interrupt', 10, 30, { maxParallelCodexWorkers: 1 });
  const G1cSID = `${SID}-round3-item1c`;
  rmState(G1cSID);
  const tu1c = 'toolu_round3_item1c';
  const cmd1c = 'orca orchestration worker-start --spec @a.md --agent codex --json';
  invoke(mainBash(cmd1c, { sid: G1cSID, tool_use_id: tu1c }), CAP1c);
  invoke({ session_id: G1cSID, hook_event_name: 'PostToolUseFailure', effort: 'high', tool_name: 'Bash',
    tool_input: { command: cmd1c }, tool_use_id: tu1c, is_interrupt: true, error: '' }, CAP1c);
  expect('round3 item1c: an interrupted dispatch with no id keeps the reservation (cap still refuses)',
    mainBash('orca orchestration worker-start --spec @b.md --agent codex --json', { sid: G1cSID }), DENY, CAP1c);
  rmState(G1cSID);
}

// Round 3, item 3: a mid-loop Orca reconcile's real effect (marking a done-but-held worker
// cap-exempt) must survive even when THIS SAME command's own dispatch attempt ends up
// refused for an unrelated reason later in the same command line — only this command's own
// (rolled-back) reservations must vanish, never the reconcile's independent, Orca-confirmed
// change to a different worker.
{
  const CAP3i = quotaEnv('round3-item3-reconcile-survives-violation', 10, 30, { maxParallelCodexWorkers: 1 });
  const G3iSID = `${SID}-round3-item3`;
  rmState(G3iSID);
  const tuOld = 'toolu_round3_item3_old';
  // Seed one live (not yet cap-exempt) codex worker so the cap (1) is already at capacity.
  invoke(mainBash('orca orchestration worker-start --agent codex --task round3item3old', { sid: G3iSID, tool_use_id: tuOld }), CAP3i);
  invoke(postBash('orca orchestration worker-start --agent codex --task round3item3old', '{"dispatchId":"ctx_round3_item3_old"}', { sid: G3iSID, tool_use_id: tuOld }), CAP3i);
  // Orca now reports that seeded worker as done but still holding its terminal — reconciling
  // it marks it cap-exempt (frees the one opening) without settling it.
  const reconcileEnv3i = { ...CAP3i, STUB_WORKERS_JSON: JSON.stringify([
    { dispatchId: 'ctx_round3_item3_old', terminalState: 'live', workerState: 'succeeded', dispatchStatus: 'completed' },
  ]) };
  // One command, two worker-starts claiming the IDENTICAL Owns in the same shared workspace:
  // invocation 0 triggers the at-cap reconcile (freeing capacity via the done-but-held
  // worker above) and is admitted; invocation 1, in the very same command, then conflicts
  // with invocation 0's own just-made reservation and is refused for ownership-overlap — so
  // the overall command is denied even though the reconcile itself succeeded.
  const sameOwnsSpec = 'implement x.\nVerify: npm test\nOwns: src/round3item3/x.ts';
  const cmd3i = `orca orchestration worker-start --agent codex --spec "${sameOwnsSpec}" --json && ` +
    `orca orchestration worker-start --agent codex --spec "${sameOwnsSpec}" --json`;
  expect('round3 item3: two same-Owns worker-starts in one command, the second self-conflicts and denies the whole command',
    mainBash(cmd3i, { sid: G3iSID, cwd: FAKE_REPO }), DENY, reconcileEnv3i);
  const after3i = readState(G3iSID);
  if (after3i.workers.ctx_round3_item3_old && after3i.workers.ctx_round3_item3_old.status === 'live' && after3i.workers.ctx_round3_item3_old.capExempt) pass += 1;
  else failures.push(`round3 item3: the reconcile's cap-exempt effect on the OTHER worker must survive this command's own refusal (${JSON.stringify(after3i && after3i.workers)})`);
  if (Object.keys(after3i.reservations || {}).length === 0) pass += 1;
  else failures.push(`round3 item3: this command's own (refused) reservations must be rolled back, none left (${JSON.stringify(after3i.reservations)})`);
  rmState(G3iSID);
}

// Round 2, item 6 (revised by the pending-placeholder-leak fix): a "pending-<ts>" placeholder
// older than its 10-minute TTL must NOT hold a cap slot or survive a reconcile — it is
// settled, freeing the slot, exactly so a leaked placeholder cannot block later dispatches
// for hours. A YOUNG placeholder (under the TTL) still counts: Orca may simply not have
// listed a genuinely just-started worker yet.
{
  const CAP6b = quotaEnv('round2-item6-pending', 10, 30, { maxParallelCodexWorkers: 1 });
  const G6bSID = `${SID}-round2-item6`;
  rmState(G6bSID);
  const oldTs = Date.now() - 11 * 60 * 1000;
  const pendingKey = `pending-${oldTs}`;
  fs.writeFileSync(path.join(STATE_DIR, `${G6bSID}.json`), JSON.stringify({
    session_id: G6bSID, created: new Date().toISOString(), bypass: false, execAgent: null,
    workers: { [pendingKey]: { role: 'codex-exec', started: oldTs, status: 'live', last_seen: oldTs,
      rate_limited_until: 0, unverified: true, group: pendingKey, kind: 'worker', agent: 'codex', owns: null, ws: null } },
    reservations: {}, agentClaims: {}, tasks: {}, last_heartbeat: 0, rate_limit_hits: 0,
  }));
  const r6b = invoke(mainBash('orca orchestration worker-start --agent codex --task round2item6', { sid: G6bSID }),
    { ...CAP6b, STUB_WORKERS_JSON: '[]' });
  if (r6b.code === ALLOW) pass += 1;
  else failures.push(`round2 item6: an expired pending-* placeholder must not hold a cap slot (exit ${r6b.code}, err ${r6b.err.slice(0, 200)})`);
  {
    const st = readState(G6bSID);
    if (st.workers[pendingKey] && st.workers[pendingKey].status === 'settled') pass += 1;
    else failures.push(`round2 item6: the expired pending-* entry must be settled by the gate-event reconcile (${JSON.stringify(st.workers)})`);
  }
  rmState(G6bSID);
  // Contrast: a placeholder only 2 minutes old still holds its slot — Orca may not have
  // listed the genuinely just-started worker yet.
  const youngTs = Date.now() - 2 * 60 * 1000;
  const youngKey = `pending-${youngTs}`;
  fs.writeFileSync(path.join(STATE_DIR, `${G6bSID}.json`), JSON.stringify({
    session_id: G6bSID, created: new Date().toISOString(), bypass: false, execAgent: null,
    workers: { [youngKey]: { role: 'codex-exec', started: youngTs, status: 'live', last_seen: youngTs,
      rate_limited_until: 0, unverified: true, group: youngKey, kind: 'worker', agent: 'codex', owns: null, ws: null } },
    reservations: {}, agentClaims: {}, tasks: {}, last_heartbeat: 0, rate_limit_hits: 0,
  }));
  const r6c = invoke(mainBash('orca orchestration worker-start --agent codex --task round2item6young', { sid: G6bSID }),
    { ...CAP6b, STUB_WORKERS_JSON: '[]' });
  if (r6c.code === DENY && /max-parallel-codex-workers/.test(r6c.err)) pass += 1;
  else failures.push(`round2 item6: a young pending-* placeholder must still hold its cap slot (exit ${r6c.code}, err ${r6c.err.slice(0, 200)})`);
  {
    const st = readState(G6bSID);
    if (st.workers[youngKey] && st.workers[youngKey].status === 'live') pass += 1;
    else failures.push(`round2 item6: the young pending-* entry must still be live (${JSON.stringify(st.workers)})`);
  }
  rmState(G6bSID);
}

// Round 2, item 7: the <task-notification> release matcher must only release the id inside
// its own <tool-use-id> tag — not any id merely MENTIONED in the notification's free-text
// <result> body (e.g. a finished task's own result text naming a still-running sibling's id).
{
  const savedFlag = fs.existsSync(FLAG) ? fs.readFileSync(FLAG, 'utf8') : null;
  fs.writeFileSync(FLAG, new Date().toISOString()); // permit in-session exec so the Agent dispatch reaches the Owns claim path
  const B7b = quotaEnv('round2-item7-notif-scope', 10, 30, {});
  const N7SID = `${SID}-round2-item7`;
  rmState(N7SID);
  const dA = dispatch({ subagent_type: 'general-purpose', model: 'sonnet', description: 'implement a', prompt: 'Implement a.\nVerify: npm test\nOwns: src/round2item7/a.ts', run_in_background: true }, N7SID, { tool_use_id: 'toolu_r2_A' });
  invoke(dA, B7b);
  invoke({ ...dA, hook_event_name: 'PostToolUse', tool_response: { status: 'async_launched' } }, B7b);
  const dB = dispatch({ subagent_type: 'general-purpose', model: 'sonnet', description: 'implement b', prompt: 'Implement b.\nVerify: npm test\nOwns: src/round2item7/b.ts', run_in_background: true }, N7SID, { tool_use_id: 'toolu_r2_B' });
  invoke(dB, B7b);
  invoke({ ...dB, hook_event_name: 'PostToolUse', tool_response: { status: 'async_launched' } }, B7b);
  const notif = '<task-notification>\n<task-id>x</task-id>\n<tool-use-id>toolu_r2_A</tool-use-id>\n<status>completed</status>\n' +
    '<result>done; note sibling toolu_r2_B still running</result>\n</task-notification>';
  invoke(promptSubmit(N7SID, notif), B7b);
  {
    const st = readState(N7SID);
    if (st.agentClaims && !st.agentClaims.toolu_r2_A && st.agentClaims.toolu_r2_B) pass += 1;
    else failures.push(`round2 item7: only the id inside <tool-use-id> must be released, not one merely ` +
      `mentioned in <result> text (${JSON.stringify(st && st.agentClaims)})`);
  }
  rmState(N7SID);
  if (savedFlag !== null) fs.writeFileSync(FLAG, savedFlag); else { try { fs.unlinkSync(FLAG); } catch {} }
}

// Round 2, item 8: the "is this worker done" check must test workerState and dispatchStatus
// INDEPENDENTLY — a truthy-but-non-matching workerState (e.g. "running") must never
// short-circuit away from also checking dispatchStatus (e.g. "completed").
{
  const CAP8b = quotaEnv('round2-item8-done-or', 10, 30, { maxParallelCodexWorkers: 1 });
  const G8bSID = `${SID}-round2-item8`;
  rmState(G8bSID);
  const tu8b = 'toolu_round2_item8';
  invoke(mainBash('orca orchestration worker-start --agent codex --task round2item8a', { sid: G8bSID, tool_use_id: tu8b }), CAP8b);
  invoke(postBash('orca orchestration worker-start --agent codex --task round2item8a', '{"dispatchId":"ctx_r2_8"}', { sid: G8bSID, tool_use_id: tu8b }), CAP8b);
  const doneOrEnv = { ...CAP8b, STUB_WORKERS_JSON: JSON.stringify([
    { dispatchId: 'ctx_r2_8', terminalState: 'live', workerState: 'running', dispatchStatus: 'completed' },
  ]) };
  expect('round2 item8: dispatchStatus "completed" alone marks a worker done even when workerState is a non-matching truthy string ("running")',
    mainBash('orca orchestration worker-start --agent codex --task round2item8b', { sid: G8bSID }), ALLOW, doneOrEnv);
  rmState(G8bSID);
}

// Round 2, item 2 (e2e): two worker-starts in ONE command, each reply PRETTY-PRINTED
// (multi-line, nested envelope, as real `orca --json` actually formats) must still land in
// two distinct groups.
{
  const B2b = quotaEnv('round2-item2-pretty', 10, 30, { maxParallelCodexWorkers: 5 });
  const G2bSID = `${SID}-round2-item2`;
  rmState(G2bSID);
  const cmd2b = 'orca orchestration worker-start --agent codex --spec @a.md --json; orca orchestration worker-start --agent codex --spec @b.md --json';
  const prettyEnv = (ctx, task, term) => JSON.stringify({
    id: 'r', ok: true, result: { dispatchId: ctx, taskId: task, handle: term, mutation: { requestId: 'x' } }, _meta: { runtimeId: 'y' },
  }, null, 2);
  invoke(mainBash(cmd2b, { sid: G2bSID, cwd: FAKE_REPO }), B2b);
  invoke(postBash(cmd2b, `${prettyEnv('ctx_r2_1', 'task_r2_1', 'term_r2_1')}\n${prettyEnv('ctx_r2_2', 'task_r2_2', 'term_r2_2')}`,
    { sid: G2bSID, cwd: FAKE_REPO }), B2b);
  {
    const st = readState(G2bSID);
    const w = st && st.workers || {};
    const g1 = w.ctx_r2_1 && w.ctx_r2_1.group;
    const g2 = w.ctx_r2_2 && w.ctx_r2_2.group;
    if (g1 && g2 && g1 !== g2 && w.task_r2_1 && w.task_r2_1.group === g1 && w.term_r2_1 && w.term_r2_1.group === g1
        && w.task_r2_2 && w.task_r2_2.group === g2 && w.term_r2_2 && w.term_r2_2.group === g2) pass += 1;
    else failures.push(`round2 item2: two pretty-printed worker-start replies in one command must land ` +
      `in two distinct groups, never merged (${JSON.stringify(w)})`);
  }
  rmState(G2bSID);
}

// --- Fourth Opus 5.5 review round -------------------------------------------------------

// Round 4, item 1a: two worker-starts in ONE command, replies printed with NO separator at
// all on the same line (`{...}{...}`) — must still land in two distinct groups with correct
// ids, exactly like the newline-separated case already covered above.
{
  const B4a = quotaEnv('round4-item1-nosep', 10, 30, { maxParallelCodexWorkers: 5 });
  const G4aSID = `${SID}-round4-item1a`;
  rmState(G4aSID);
  const cmd4a = 'orca orchestration worker-start --agent codex --spec @a.md --json; orca orchestration worker-start --agent codex --spec @b.md --json';
  const reply = (ctx, task) => JSON.stringify({ ok: true, result: { dispatchId: ctx, taskId: task } });
  invoke(mainBash(cmd4a, { sid: G4aSID, cwd: FAKE_REPO }), B4a);
  invoke(postBash(cmd4a, `${reply('ctx_r4_1', 'task_r4_1')}${reply('ctx_r4_2', 'task_r4_2')}`, { sid: G4aSID, cwd: FAKE_REPO }), B4a);
  {
    const st = readState(G4aSID);
    const w = st && st.workers || {};
    if (w.ctx_r4_1 && w.ctx_r4_2 && w.ctx_r4_1.group !== w.ctx_r4_2.group) pass += 1;
    else failures.push(`round4 item1a: two same-line, no-separator replies must both register in distinct groups (${JSON.stringify(w)})`);
  }
  rmState(G4aSID);
}

// Round 4, item 1b: two worker-starts in ONE command, but the FIRST reply is preceded by a
// log-line prefix on its own line (`Dispatched: {...}`) so only the second reply's line
// starts with `{` — the extracted-reply COUNT (1) no longer matches the invocation count (2).
// Positional zipping must not happen: neither invocation may be credited with the wrong
// dispatch id. Both must fall back to their own id-less pending placeholder instead.
{
  const B4b = quotaEnv('round4-item1-mismatch', 10, 30, { maxParallelCodexWorkers: 5 });
  const G4bSID = `${SID}-round4-item1b`;
  rmState(G4bSID);
  const cmd4b = 'orca orchestration worker-start --agent codex --spec @a.md --json; orca orchestration worker-start --agent codex --spec @b.md --json';
  const reply = (ctx, task) => JSON.stringify({ ok: true, result: { dispatchId: ctx, taskId: task } });
  invoke(mainBash(cmd4b, { sid: G4bSID, cwd: FAKE_REPO }), B4b);
  invoke(postBash(cmd4b, `Dispatched: ${reply('ctx_r4_3', 'task_r4_3')}\n${reply('ctx_r4_4', 'task_r4_4')}`, { sid: G4bSID, cwd: FAKE_REPO }), B4b);
  {
    const st = readState(G4bSID);
    const w = st && st.workers || {};
    const pendingKeys = Object.keys(w).filter((k) => k.startsWith('pending-'));
    if (!w.ctx_r4_3 && !w.ctx_r4_4 && pendingKeys.length === 2) pass += 1;
    else failures.push(`round4 item1b: a reply-count mismatch must never positionally misattribute an id — both invocations must become id-less placeholders (${JSON.stringify(w)})`);
  }
  rmState(G4bSID);
}

// Round 4, item 2: PostToolUseFailure whose error text is NON-EMPTY plain text with no `{`
// at all (e.g. a bad-flag CLI usage message) is affirmative evidence nothing was dispatched —
// the reservation must be dropped immediately, freeing the cap for the very next worker-start
// (contrast with the empty-error / is_interrupt case above, which still correctly keeps it).
{
  const CAP4c = quotaEnv('round4-item2-no-json-error', 10, 30, { maxParallelCodexWorkers: 1 });
  const G4cSID = `${SID}-round4-item2`;
  rmState(G4cSID);
  const tu4c = 'toolu_round4_item2';
  const cmd4c = 'orca orchestration worker-start --bad-flag --agent codex --json';
  invoke(mainBash(cmd4c, { sid: G4cSID, tool_use_id: tu4c }), CAP4c);
  invoke({ session_id: G4cSID, hook_event_name: 'PostToolUseFailure', effort: 'high', tool_name: 'Bash',
    tool_input: { command: cmd4c }, tool_use_id: tu4c,
    error: "Exit code 2\nerror: unrecognized argument '--bad-flag'\nUsage: orca orchestration worker-start [OPTIONS]" }, CAP4c);
  const after4c = readState(G4cSID);
  if (after4c && !after4c.reservations[`${tu4c}#0`]) pass += 1;
  else failures.push(`round4 item2: a plain-text (no JSON) PostToolUseFailure error must drop the reservation immediately (${JSON.stringify(after4c && after4c.reservations)})`);
  expect('round4 item2: the next worker-start at the same cap is now allowed (nothing was really dispatched)',
    mainBash('orca orchestration worker-start --agent codex --json', { sid: G4cSID }), ALLOW, CAP4c);
  rmState(G4cSID);
}

// Round 4, item 2b: the max-parallel-codex-workers refusal names each unresolved reservation
// individually as "pending reservation <id> (expires in <N>m)", not a single generic
// "(reserved, not yet listed by orca)" placeholder.
{
  const CAP4d = quotaEnv('round4-item2-named-reservation', 10, 30, { maxParallelCodexWorkers: 1 });
  const G4dSID = `${SID}-round4-item2b`;
  rmState(G4dSID);
  const resId4d = 'toolu_round4_item2b#0';
  const st4d = { session_id: G4dSID, created: new Date().toISOString(), bypass: false, execAgent: null,
    workers: {}, reservations: { [resId4d]: { ts: Date.now(), agent: 'codex', owns: null, ws: null, codexSlot: true } },
    agentClaims: {}, tasks: {}, last_heartbeat: 0, rate_limit_hits: 0 };
  fs.writeFileSync(path.join(STATE_DIR, `${G4dSID}.json`), JSON.stringify(st4d));
  const r4d = invoke(mainBash('orca orchestration worker-start --agent codex --json', { sid: G4dSID }), CAP4d);
  if (r4d.code === DENY && new RegExp(`pending reservation ${resId4d.replace('#', '\\#')} \\(expires in \\d+m\\)`).test(r4d.err)) pass += 1;
  else failures.push(`round4 item2b: the refusal must name the pending reservation specifically (exit ${r4d.code}, err ${r4d.err.slice(0, 300)})`);
  rmState(G4dSID);
}

// A worker-start id is trusted only from that invocation's own JSON reply. Free-text output
// can contain formatter output or a chained worker-list with unrelated ids, so it must never
// create worker registrations. On an ambiguous failure, retain the reservation until TTL.
{
  const CAP5aEnv = quotaEnv('round5-item1-plaintext-id', 10, 30, { maxParallelCodexWorkers: 1 });
  const G5aSID = `${SID}-round5-item1`;
  rmState(G5aSID);
  const tu5a = 'toolu_round5_item1';
  const cmd5a = 'orca orchestration worker-start --agent codex --spec @a.md && false';
  invoke(mainBash(cmd5a, { sid: G5aSID, tool_use_id: tu5a, cwd: FAKE_REPO }), CAP5aEnv);
  invoke({ session_id: G5aSID, hook_event_name: 'PostToolUseFailure', effort: 'high', tool_name: 'Bash',
    tool_input: { command: cmd5a }, tool_use_id: tu5a,
    error: 'Exit code 1\nDispatched worker ctx_abc123 for task task_xyz' }, CAP5aEnv);
  const after5a = readState(G5aSID);
  if (after5a && !after5a.workers.ctx_abc123 && after5a.reservations[`${tu5a}#0`]) pass += 1;
  else failures.push(`plain-text ids must not register workers; the ambiguous reservation must remain (${JSON.stringify(after5a && { workers: after5a.workers, reservations: after5a.reservations })})`);
  expect('the retained ambiguous reservation keeps the next worker-start at cap 1 refused',
    mainBash('orca orchestration worker-start --agent codex --spec @b.md --json', { sid: G5aSID, cwd: FAKE_REPO }), DENY, CAP5aEnv);
  rmState(G5aSID);
}

// --- max-parallel-agents: machine-wide budget on live Orca workers + subagents ---------
//
// Each case below gets its OWN fresh, isolated state dir (never the shared STATE_DIR every
// other test in this file uses) — this gate counts MACHINE-WIDE, i.e. every session file
// under its state dir, so sharing STATE_DIR with the rest of the suite would make these
// tests depend on exactly what earlier, unrelated tests happened to leave behind.

function mpaTestEnv(cfgOverrides) {
  const dir = fs.mkdtempSync(path.join(RUN_DIR, 'mpa-'));
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const cfgFile = path.join(dir, 'orchestration.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...DEFAULT_CFG, maxParallelAgents: 0, ...cfgOverrides }));
  const env = { ...BASE_ENV, ORCH_STATE_DIR: stateDir, ORCH_CONFIG_PATH: cfgFile, ORCA_BIN: STUB, CODEX_BIN: STUB };
  return { env, stateDir };
}

// A lookup-agent dispatch shaped to pass every OTHER gate cleanly (subagent_type "Explore"
// matches agents.lookup, model "haiku" matches models.lookup — advisory only, never a
// denial) — a refusal in these tests can only ever be max-parallel-agents.
const mpaLookup = (sid, toolUseId, extraToolInput) => dispatch(
  { subagent_type: 'Explore', model: 'haiku', description: 'lookup something', ...(extraToolInput || {}) },
  sid, { tool_use_id: toolUseId }
);
const postAgent = (sid, toolUseId) => ({
  session_id: sid, hook_event_name: 'PostToolUse', effort: 'high', tool_name: 'Agent',
  tool_input: {}, tool_use_id: toolUseId, tool_response: { stdout: '' },
});

// 1. Agent dispatch refused once the cap is reached, allowed below it.
{
  const { env } = mpaTestEnv({ maxParallelAgents: 2 });
  const sid = 'mpa-basic';
  expect('agent #1 admitted under cap 2', mpaLookup(sid, 'toolu_mpa_1'), ALLOW, env);
  expect('agent #2 admitted under cap 2', mpaLookup(sid, 'toolu_mpa_2'), ALLOW, env);
  const r3 = invoke(mpaLookup(sid, 'toolu_mpa_3'), env);
  if (r3.code === DENY && /max-parallel-agents/.test(r3.err)) pass += 1;
  else failures.push(`agent #3 should be refused by max-parallel-agents at cap 2 (code ${r3.code}, err ${r3.err.slice(0, 200)})`);
}

// 2. A foreground dispatch's PostToolUse frees its slot for a later dispatch.
{
  const { env } = mpaTestEnv({ maxParallelAgents: 1 });
  const sid = 'mpa-foreground';
  expect('agent #1 admitted under cap 1', mpaLookup(sid, 'toolu_mpa_fg1'), ALLOW, env);
  const blocked = invoke(mpaLookup(sid, 'toolu_mpa_fg2'), env);
  if (blocked.code === DENY) pass += 1; else failures.push('a second foreground agent at cap 1 should be refused before release');
  invoke(postAgent(sid, 'toolu_mpa_fg1'), env);
  expect('after the foreground PostToolUse frees the slot, a new dispatch is admitted',
    mpaLookup(sid, 'toolu_mpa_fg3'), ALLOW, env);
}

// 3. A background dispatch's own launch-return PostToolUse must NOT free its slot; only a
// matching <task-notification><tool-use-id> does.
{
  const { env } = mpaTestEnv({ maxParallelAgents: 1 });
  const sid = 'mpa-background';
  expect('background agent #1 admitted under cap 1',
    mpaLookup(sid, 'toolu_mpa_bg1', { run_in_background: true }), ALLOW, env);
  invoke(postAgent(sid, 'toolu_mpa_bg1'), env); // the launch itself returning
  const stillBlocked = invoke(mpaLookup(sid, 'toolu_mpa_bg2'), env);
  if (stillBlocked.code === DENY) pass += 1;
  else failures.push('a background dispatch\'s own launch-return PostToolUse must not free its max-parallel-agents slot');
  invoke(promptSubmit(sid, '<task-notification><tool-use-id>toolu_mpa_bg1</tool-use-id>' +
    '<status>completed</status><result>done</result></task-notification>'), env);
  expect('after the matching <task-notification>, a new dispatch is admitted',
    mpaLookup(sid, 'toolu_mpa_bg3'), ALLOW, env);
}

// 4. A Codex worker-start counts against max-parallel-agents too (not only Agent/Task).
{
  const { env } = mpaTestEnv({ maxParallelAgents: 1, maxParallelCodexWorkers: 5 });
  const sid = 'mpa-worker-start';
  expect('a worker-start is admitted under max-parallel-agents cap 1',
    mainBash('orca orchestration worker-start --agent codex --task first --json', { sid }), ALLOW, env);
  const r2 = invoke(mainBash('orca orchestration worker-start --agent codex --task second --json', { sid }), env);
  if (r2.code === DENY && /max-parallel-agents/.test(r2.err)) pass += 1;
  else failures.push(`a second worker-start at max-parallel-agents cap 1 should be refused (code ${r2.code}, err ${r2.err.slice(0, 200)})`);
}

// 5. `--retry-of` an existing LIVE group is a replacement, not a new slot — allowed even
// while already "at cap".
{
  const { env, stateDir } = mpaTestEnv({ maxParallelAgents: 1, maxParallelCodexWorkers: 5 });
  const sid = 'mpa-retry';
  const seeded = {
    session_id: sid, created: new Date().toISOString(), bypass: false, execAgent: null,
    workers: { ctx_mpa_retry: { status: 'live', started: Date.now(), group: 'ctx_mpa_retry',
      kind: 'worker', agent: 'codex', owns: null, ws: null } },
    reservations: {}, agentClaims: {}, agents: {}, tasks: {}, last_heartbeat: 0, rate_limit_hits: 0,
  };
  fs.writeFileSync(path.join(stateDir, `${sid}.json`), JSON.stringify(seeded));
  expect('--retry-of an existing live group is allowed even though its slot is already "at cap"',
    mainBash('orca orchestration worker-start --agent codex --retry-of ctx_mpa_retry --json', { sid }), ALLOW, env);
}

// 6. `ORCH_MAX_PARALLEL_AGENTS=0` overrides the config to unlimited for one process.
{
  const { env } = mpaTestEnv({ maxParallelAgents: 1 });
  const unlimitedEnv = { ...env, ORCH_MAX_PARALLEL_AGENTS: '0' };
  const sid = 'mpa-env-unlimited';
  expect('agent #1 admitted with ORCH_MAX_PARALLEL_AGENTS=0', mpaLookup(sid, 'toolu_mpa_u1'), ALLOW, unlimitedEnv);
  expect('agent #2 also admitted with ORCH_MAX_PARALLEL_AGENTS=0 (unlimited)', mpaLookup(sid, 'toolu_mpa_u2'), ALLOW, unlimitedEnv);
  expect('agent #3 also admitted with ORCH_MAX_PARALLEL_AGENTS=0 (unlimited)', mpaLookup(sid, 'toolu_mpa_u3'), ALLOW, unlimitedEnv);
}

// 7. `disabledGates: ["max-parallel-agents"]` never refuses, even well past a tiny cap —
// registration still happens (proven by the cap re-applying once the gate is re-enabled
// would be a separate test; here we only assert the disabled gate never blocks).
{
  const { env } = mpaTestEnv({ maxParallelAgents: 1, disabledGates: ['max-parallel-agents'] });
  const sid = 'mpa-disabled';
  expect('agent #1 admitted with the gate disabled', mpaLookup(sid, 'toolu_mpa_d1'), ALLOW, env);
  expect('agent #2 also admitted with the gate disabled, despite cap 1', mpaLookup(sid, 'toolu_mpa_d2'), ALLOW, env);
  expect('agent #3 also admitted with the gate disabled, despite cap 1', mpaLookup(sid, 'toolu_mpa_d3'), ALLOW, env);
}

// 8. C1 regression: a dispatch refused by a LATER gate (here: route-review, wrong model)
// must never have registered a max-parallel-agents slot. Before the fix, registration
// happened at the TOP of the Agent/Task branch, before routing/ownership gates ran — so a
// dispatch that failed one of those later gates still left `s.agents[toolUseId]` behind,
// and since a refused dispatch never fires PostToolUse, that slot leaked for up to
// AGENT_REGISTRY_TTL_MS (120 minutes). Reproduced here with 3 wrong-model "review" dispatches
// against cap 2: if any of them registered, the 2 genuine lookup dispatches below would be
// wrongly refused too.
{
  const { env } = mpaTestEnv({ maxParallelAgents: 2 });
  const sid = 'mpa-c1-no-leak-on-later-refusal';
  const wrongModelReview = (toolUseId) => dispatch(
    { subagent_type: 'reviewer', description: 'review the implementation for correctness', model: 'sonnet' },
    sid, { tool_use_id: toolUseId });
  for (const id of ['toolu_mpa_c1_r1', 'toolu_mpa_c1_r2', 'toolu_mpa_c1_r3']) {
    const r = invoke(wrongModelReview(id), env);
    if (r.code === DENY && /route-review/.test(r.err)) pass += 1;
    else failures.push(`C1 setup: wrong-model review dispatch ${id} should be refused by route-review (code ${r.code}, err ${r.err.slice(0, 200)})`);
  }
  expect('C1: after 3 route-review refusals, a genuine dispatch #1 is still admitted under cap 2',
    mpaLookup(sid, 'toolu_mpa_c1_g1'), ALLOW, env);
  expect('C1: after 3 route-review refusals, a genuine dispatch #2 is still admitted under cap 2',
    mpaLookup(sid, 'toolu_mpa_c1_g2'), ALLOW, env);
}

// 9. H3: at the machine-wide cap, the gate reconciles the caller's OWN session against
// Orca's live worker-list before refusing. This session's local state still shows a worker
// live (filling cap 1), but Orca's own worker-list reports it `terminalState: 'released'` —
// the reconcile must settle it locally and free the slot, admitting the dispatch instead of
// refusing it on stale bookkeeping.
{
  const { env, stateDir } = mpaTestEnv({ maxParallelAgents: 1 });
  const sid = 'mpa-h3-reconcile-frees-slot';
  const staleState = {
    session_id: sid, created: new Date().toISOString(), bypass: false, execAgent: null,
    workers: { ctx_h3_stale: { status: 'live', started: Date.now(), group: 'ctx_h3_stale', agent: 'codex', owns: null, ws: null } },
    reservations: {}, agentClaims: {}, agents: {}, tasks: {}, last_heartbeat: 0, rate_limit_hits: 0,
  };
  fs.writeFileSync(path.join(stateDir, `${sid}.json`), JSON.stringify(staleState));
  const h3Env = {
    ...env,
    STUB_WORKERS_JSON: JSON.stringify([
      { dispatchId: 'ctx_h3_stale', taskId: 'task_h3_stale', terminalState: 'released', workerState: 'succeeded', dispatchStatus: 'succeeded' },
    ]),
  };
  expect('H3: a dispatch at a stale-but-full cap is admitted once reconcile frees the Orca-released worker',
    mpaLookup(sid, 'toolu_mpa_h3_1'), ALLOW, h3Env);
  const after = JSON.parse(fs.readFileSync(path.join(stateDir, `${sid}.json`), 'utf8'));
  checkBool('H3: the reconciled worker is persisted as settled, not left live',
    after.workers.ctx_h3_stale.status === 'settled', true);
}

/** Holds `lockDir` genuinely live for the duration of `fn()` — a separate process keeps its
 * mtime refreshed every 200ms, so it never LOOKS abandoned/stale to a concurrent acquirer
 * no matter how long that acquirer's own timeout is. Used to simulate real, ongoing lock
 * contention (as opposed to a merely-abandoned lock, which review round 3, item 2 made the
 * cap paths' own longer acquire timeout outlive on its own — see item 2's own test below). */
function withHeldLock(lockDir, fn) {
  fs.mkdirSync(lockDir, { recursive: true });
  const keepAlive = spawn(process.execPath, ['-e',
    'const fs=require("fs");const d=process.argv[1];' +
    'setInterval(()=>{try{const t=Date.now()/1000;fs.utimesSync(d,t,t);}catch{}},200);',
    lockDir], { stdio: 'ignore' });
  try { fn(); } finally { keepAlive.kill(); fs.rmSync(lockDir, { recursive: true, force: true }); }
}

// 10. Concurrency review, Low item: a max-parallel-agents check that cannot acquire the
// state-file lock at all (contended by another process) must refuse with a distinct,
// transient-retry reason — never silently evaluate capacity unlocked (which, under exactly
// the many-concurrent-dispatches condition that causes lock contention, would let every
// contending process fall through uncounted and all be admitted at once). Simulated here by a
// lock directory a separate live process keeps refreshing (mtime touched every 200ms) for the
// whole test — genuine, ongoing contention, never merely stale. (Review round 3, item 2 made
// the cap paths' own acquire timeout longer than file-lock's staleMs specifically so a lock
// that ISN'T being refreshed gets outlived instead of refused — see items 14/15 below — so a
// merely-abandoned lock no longer exercises this path at all; only an actively-held one does.)
{
  const { env, stateDir } = mpaTestEnv({ maxParallelAgents: 5 }); // generous cap: contention, not capacity, must be the cause
  const sid = 'mpa-lock-contention';
  const lockDir = path.join(stateDir, '.lock');
  withHeldLock(lockDir, () => {
    const r = invoke(mpaLookup(sid, 'toolu_mpa_lock_1'), env);
    if (r.code === DENY && /max-parallel-agents/.test(r.err) && /transient/i.test(r.err) && /retry/i.test(r.err)) pass += 1;
    else failures.push(`lock contention: expected a transient-retry max-parallel-agents refusal (code ${r.code}, err ${r.err.slice(0, 300)})`);
    checkBool('lock contention: the ordinary at-capacity wording is NOT used for a lock-contention refusal',
      /parallel units live on this machine/.test(r.err), false);
  });
  expect('lock contention: once the lock is free again, a dispatch is admitted normally',
    mpaLookup(sid, 'toolu_mpa_lock_2'), ALLOW, env);
}

// 11. Low item: `--release-claims <id>` must release EVERY kind of claim tracked under that
// id, not just whichever the old if/else-if chain happened to check first. Seeds a single
// toolUseId with an agentClaims entry, an agents (max-parallel-agents) entry, AND an indexed
// reservation, then confirms all three are gone after one `--release-claims <id>`.
{
  const { env, stateDir } = mpaTestEnv({ maxParallelAgents: 1 });
  const sid = 'mpa-release-claims-multi-kind';
  const targetId = 'toolu_release_multi';
  const seeded = {
    session_id: sid, created: new Date().toISOString(), bypass: false, execAgent: null,
    workers: {},
    reservations: { [`${targetId}#0`]: { ts: Date.now(), agent: 'codex', owns: null, ws: null, newSlot: true } },
    agentClaims: { [targetId]: { owns: ['src/x.ts'], ws: `${FAKE_REPO}|current`, ts: Date.now() } },
    agents: { [targetId]: { ts: Date.now(), background: false, type: '', model: '' } },
    tasks: {}, last_heartbeat: 0, rate_limit_hits: 0,
  };
  fs.writeFileSync(path.join(stateDir, `${sid}.json`), JSON.stringify(seeded));
  invoke(promptSubmit(sid, `--release-claims ${targetId}`), env);
  const after = JSON.parse(fs.readFileSync(path.join(stateDir, `${sid}.json`), 'utf8'));
  checkBool('release-claims (single id): the agentClaims entry is released', !after.agentClaims[targetId], true);
  checkBool('release-claims (single id): the agents (max-parallel-agents) entry is ALSO released', !after.agents[targetId], true);
  checkBool('release-claims (single id): the indexed reservation is ALSO released', !after.reservations[`${targetId}#0`], true);
}

// 12. C1 backstop: a genuine operator UserPromptSubmit (never an injected notification/
// reminder) sweeps out every FOREGROUND `s.agents` registration — the safety net for a slot
// that somehow outlived its own PostToolUse (e.g. a session that crashed mid-turn). A
// background registration is left alone: it relies on its own <task-notification>/TTL/
// --release-claims release path instead.
{
  const { env, stateDir } = mpaTestEnv({ maxParallelAgents: 5 });
  const sid = 'mpa-c1-backstop-userpromptsubmit';
  const seeded = {
    session_id: sid, created: new Date().toISOString(), bypass: false, execAgent: null,
    workers: {}, reservations: {}, agentClaims: {},
    agents: {
      toolu_leaked_fg: { ts: Date.now(), background: false, type: '', model: '' },
      toolu_leaked_bg: { ts: Date.now(), background: true, type: '', model: '' },
    },
    tasks: {}, last_heartbeat: 0, rate_limit_hits: 0,
  };
  fs.writeFileSync(path.join(stateDir, `${sid}.json`), JSON.stringify(seeded));
  invoke(promptSubmit(sid, 'hello, anything to report?'), env);
  const after = JSON.parse(fs.readFileSync(path.join(stateDir, `${sid}.json`), 'utf8'));
  checkBool('C1 backstop (UserPromptSubmit): a leaked FOREGROUND registration is swept',
    !after.agents.toolu_leaked_fg, true);
  checkBool('C1 backstop (UserPromptSubmit): a BACKGROUND registration survives untouched',
    !!after.agents.toolu_leaked_bg, true);
}

// 13. C1 backstop: same sweep, at Stop — regardless of whether any Orca worker is live.
{
  const { env, stateDir } = mpaTestEnv({ maxParallelAgents: 5 });
  const sid = 'mpa-c1-backstop-stop';
  const seeded = {
    session_id: sid, created: new Date().toISOString(), bypass: false, execAgent: null,
    workers: {}, reservations: {}, agentClaims: {},
    agents: {
      toolu_leaked_fg2: { ts: Date.now(), background: false, type: '', model: '' },
      toolu_leaked_bg2: { ts: Date.now(), background: true, type: '', model: '' },
    },
    tasks: {}, last_heartbeat: 0, rate_limit_hits: 0,
  };
  fs.writeFileSync(path.join(stateDir, `${sid}.json`), JSON.stringify(seeded));
  invoke({ session_id: sid, hook_event_name: 'Stop', effort: 'high', stop_hook_active: false }, env);
  const after = JSON.parse(fs.readFileSync(path.join(stateDir, `${sid}.json`), 'utf8'));
  checkBool('C1 backstop (Stop): a leaked FOREGROUND registration is swept, even with zero live workers',
    !after.agents.toolu_leaked_fg2, true);
  checkBool('C1 backstop (Stop): a BACKGROUND registration survives untouched',
    !!after.agents.toolu_leaked_bg2, true);
}

// 14. A worker-start admitted by this gate can still be refused by a later PreToolUse hook,
// which means no PostToolUse event ever arrives. An exact retry in the same session must
// replace that pending reservation, while a different overlapping command remains refused.
{
  const env = quotaEnv('pending-retry-guidance', 10, 30, { maxParallelCodexWorkers: 1 });
  const sid = 'pending-retry-guidance';
  const command = 'orca orchestration worker-start --agent codex --spec "implement retry.\nVerify: npm test\nOwns: src/retry-guidance.ts"';
  rmState(sid);
  expect('pending retry guidance: the original worker-start reserves its claim and slot',
    mainBash(command, { sid, cwd: FAKE_REPO, tool_use_id: 'toolu_guidance_original' }), ALLOW, env);
  const immediate = invoke(mainBash(command,
    { sid, cwd: FAKE_REPO, tool_use_id: 'toolu_guidance_retry' }), env);
  checkBool('pending retry guidance: a fresh identical retry says to retry in a few seconds',
    immediate.code === DENY && /retry in a few seconds/i.test(immediate.err), true);
  rmState(sid);
}

{
  const env = quotaEnv('pending-retry-missing-ts', 10, 30, { maxParallelCodexWorkers: 1 });
  const sid = 'pending-retry-missing-ts';
  const command = 'orca orchestration worker-start --agent codex --spec "implement retry.\nVerify: npm test\nOwns: src/retry-missing-ts.ts"';
  rmState(sid);
  expect('pending retry missing ts: the original worker-start reserves its claim and slot',
    mainBash(command, { sid, cwd: FAKE_REPO, tool_use_id: 'toolu_missing_ts_original' }), ALLOW, env);
  const withoutTs = readState(sid);
  delete withoutTs.reservations['toolu_missing_ts_original#0'].ts;
  fs.writeFileSync(path.join(STATE_DIR, `${sid}.json`), JSON.stringify(withoutTs));
  expect('pending retry missing ts: the exact same command replaces a timestamp-less reservation',
    mainBash(command, { sid, cwd: FAKE_REPO, tool_use_id: 'toolu_missing_ts_retry' }), ALLOW, env);
  const afterMissingTsRetry = readState(sid);
  checkBool('pending retry missing ts: the stale timestamp-less reservation is removed',
    !afterMissingTsRetry.reservations['toolu_missing_ts_original#0'] &&
      !!afterMissingTsRetry.reservations['toolu_missing_ts_retry#0'] &&
      Object.keys(afterMissingTsRetry.reservations).length === 1,
    true);
  rmState(sid);
}

{
  const env = quotaEnv('pending-retry-replacement', 10, 30, { maxParallelCodexWorkers: 1 });
  const sid = 'pending-retry-replacement';
  const command = 'orca orchestration worker-start --agent codex --spec "implement retry.\nVerify: npm test\nOwns: src/retry.ts"';
  const differentCommand = 'orca orchestration worker-start --agent codex --spec "implement something else.\nVerify: npm test\nOwns: src/retry.ts"';
  rmState(sid);
  expect('pending retry: the original worker-start reserves its claim and slot',
    mainBash(command, { sid, cwd: FAKE_REPO, tool_use_id: 'toolu_pending_original' }), ALLOW, env);
  const aged = readState(sid);
  aged.reservations['toolu_pending_original#0'].ts = Date.now() - 3000;
  fs.writeFileSync(path.join(STATE_DIR, `${sid}.json`), JSON.stringify(aged));
  expect('pending retry: the exact same command replaces its unresolved reservation',
    mainBash(command, { sid, cwd: FAKE_REPO, tool_use_id: 'toolu_pending_retry' }), ALLOW, env);
  const afterRetry = readState(sid);
  checkBool('pending retry: the replaced tool-use reservation is gone',
    !afterRetry.reservations['toolu_pending_original#0'], true);
  checkBool('pending retry: the retry owns the one remaining reservation',
    !!afterRetry.reservations['toolu_pending_retry#0'] && Object.keys(afterRetry.reservations).length === 1, true);
  const overlap = invoke(mainBash(differentCommand,
    { sid, cwd: FAKE_REPO, tool_use_id: 'toolu_pending_different' }), env);
  checkBool('pending retry: a different overlapping command is still refused',
    overlap.code === DENY && /ownership-overlap/.test(overlap.err), true);
  rmState(sid);
}

// 15. Stop sweeps unresolved Bash reservations. UserPromptSubmit cannot: the Bash call may
// still be in flight, and its eventual PostToolUse needs the reservation's Owns claim.
for (const event of ['Stop']) {
  const env = quotaEnv(`pending-sweep-${event.toLowerCase()}`, 10, 30, { maxParallelCodexWorkers: 1 });
  const sid = `pending-sweep-${event.toLowerCase()}`;
  const command = `orca orchestration worker-start --agent codex --task ${event.toLowerCase()}`;
  rmState(sid);
  invoke(mainBash(command, { sid, tool_use_id: `toolu_pending_${event}` }), env);
  const payload = event === 'UserPromptSubmit'
    ? promptSubmit(sid, 'continue after the denied tool call')
    : { session_id: sid, hook_event_name: 'Stop', effort: 'high', stop_hook_active: false };
  invoke(payload, env);
  const after = readState(sid);
  checkBool(`pending sweep (${event}): unresolved reservations are removed`,
    Object.keys(after.reservations || {}).length === 0, true);
  rmState(sid);
}

{
  const env = quotaEnv('pending-prompt-in-flight', 10, 30, { maxParallelCodexWorkers: 2 });
  const sid = 'pending-prompt-in-flight';
  const command = 'orca orchestration worker-start --agent codex --spec "implement a.\nVerify: npm test\nOwns: src/in-flight.ts"';
  rmState(sid);
  invoke(mainBash(command, { sid, cwd: FAKE_REPO, tool_use_id: 'toolu_in_flight' }), env);
  invoke(promptSubmit(sid, 'keep supervising while that Bash call runs'), env);
  invoke(postBash(command, '{"dispatchId":"ctx_in_flight"}',
    { sid, cwd: FAKE_REPO, tool_use_id: 'toolu_in_flight' }), env);
  const after = readState(sid);
  checkBool('in-flight prompt: worker registration retains the reservation Owns claim',
    JSON.stringify(after.workers.ctx_in_flight?.owns), JSON.stringify(['src/in-flight.ts']));
  const overlap = invoke(mainBash(
    'orca orchestration worker-start --agent codex --spec "implement b.\nVerify: npm test\nOwns: src/in-flight.ts"',
    { sid, cwd: FAKE_REPO, tool_use_id: 'toolu_in_flight_overlap' }), env);
  checkBool('in-flight prompt: a later overlapping dispatch is still refused',
    overlap.code === DENY && /ownership-overlap/.test(overlap.err), true);
  rmState(sid);
}

{
  const env = quotaEnv('worker-reply-worktree-id', 10, 30, { maxParallelCodexWorkers: 2 });
  const sid = 'worker-reply-worktree-id';
  const command = 'orca orchestration worker-start --agent codex --task worktree-id';
  rmState(sid);
  invoke(mainBash(command, { sid, tool_use_id: 'toolu_worktree_id' }), env);
  invoke(postBash(command,
    '{"result":{"dispatchId":"ctx_worktree_id","resource":{"worktreeId":"repo_reply::/tmp/reply-wt"}}}',
    { sid, tool_use_id: 'toolu_worktree_id' }), env);
  checkBool('worker-start reply: real nested worktreeId is retained in session state',
    JSON.stringify(readState(sid).workers.ctx_worktree_id?.worktreeIds),
    JSON.stringify(['repo_reply::/tmp/reply-wt']));
  rmState(sid);
}

// 16. Review round 3, item 1: lock contention must refuse ONLY while the cap is actually
// finite — `reconcileParallelAgentsAtCap` (the Agent/Task path) and
// `handleTerminalCreateAgentCap` (the bare `orca terminal create` path) used to check
// `!locked` BEFORE checking gate-disabled/non-finite, so a held `.lock` refused even with the
// cap unlimited (maxParallelAgents 0) or the gate disabled outright. Both must now allow. Uses
// a GENUINELY held (continuously refreshed) lock, never a merely-abandoned one — item 2's own
// longer acquire timeout would otherwise outlive a plain abandoned lock on its own and mask
// whether this fix (checking disabled/unlimited BEFORE `!locked`) is actually what admits it.
{
  const { env, stateDir } = mpaTestEnv({ maxParallelAgents: 0 }); // 0 = unlimited
  const lockDir = path.join(stateDir, '.lock');
  withHeldLock(lockDir, () => {
    const started = Date.now();
    const result = invoke(mpaLookup('mpa-r3-i1-agent-unlimited', 'toolu_r3i1_agent_u'), env);
    const elapsed = Date.now() - started;
    if (result.code === ALLOW) pass += 1;
    else failures.push(`held lock + unlimited cap should allow Agent dispatch, got ${result.code}`);
    if (elapsed < 4000) pass += 1;
    else failures.push(`held lock + unlimited cap should finish in <4s, took ${elapsed}ms`);
    expect('item 1: a genuinely held .lock + unlimited (0) cap still admits `orca terminal create`',
      mainBash('orca terminal create --json', { sid: 'mpa-r3-i1-term-unlimited' }), ALLOW, env);
    const workerStarted = Date.now();
    const worker = invoke(mainBash(
      'orca orchestration worker-start --agent codex --worktree new-child --spec "implement x. Verify: npm test." --json',
      { sid: 'mpa-r5-i3-worker-unlimited', tool_use_id: 'toolu_r5_i3_worker_u' }), env);
    const workerElapsed = Date.now() - workerStarted;
    if (worker.code === ALLOW && workerElapsed < 4000) pass += 1;
    else failures.push(`held lock + both caps unlimited should allow worker-start in <4s; code=${worker.code}, elapsed=${workerElapsed}ms`);
  });
}
{
  const { env, stateDir } = mpaTestEnv({ maxParallelAgents: 1, disabledGates: ['max-parallel-agents'] });
  const lockDir = path.join(stateDir, '.lock');
  withHeldLock(lockDir, () => {
    const started = Date.now();
    const result = invoke(mpaLookup('mpa-r3-i1-agent-disabled', 'toolu_r3i1_agent_d'), env);
    const elapsed = Date.now() - started;
    if (result.code === ALLOW) pass += 1;
    else failures.push(`held lock + disabled gate should allow Agent dispatch, got ${result.code}`);
    if (elapsed < 4000) pass += 1;
    else failures.push(`held lock + disabled gate should finish in <4s, took ${elapsed}ms`);
    expect('item 1: a genuinely held .lock + disabledGates still admits `orca terminal create`',
      mainBash('orca terminal create --json', { sid: 'mpa-r3-i1-term-disabled' }), ALLOW, env);
  });
}

// Review round 5, item 3: a finite worker-start cap gets one long lock attempt. If another
// live process keeps the lock held, it must refuse after that attempt rather than starting a
// reconcile and waiting the same ~10.5s a second time.
{
  const { env, stateDir } = mpaTestEnv({ maxParallelAgents: 1, maxParallelCodexWorkers: 1 });
  const lockDir = path.join(stateDir, '.lock');
  withHeldLock(lockDir, () => {
    const started = Date.now();
    const r = invoke(mainBash(
      'orca orchestration worker-start --agent codex --worktree new-child --spec "implement x. Verify: npm test." --json',
      { sid: 'mpa-r5-i3-worker-finite', tool_use_id: 'toolu_r5_i3_worker_f' }), env);
    const elapsed = Date.now() - started;
    if (r.code === DENY && /transient/i.test(r.err) && elapsed < 13000) pass += 1;
    else failures.push(`held lock + finite worker-start cap should refuse once in <13s; code=${r.code}, elapsed=${elapsed}ms`);
  });
}

// 15. Review round 3, item 2: the cap paths' own lock acquisition (2s default) gave up well
// before file-lock's own staleMs (10s) ever made the lock look abandoned — any caller whose
// attempt started less than (staleMs - timeoutMs) ~= 8s after a dead holder's lock was
// created refused as "contended" instead of outliving it. A FRESH (not pre-backdated) lock,
// combined with a finite cap so the dispatch is not trivially allowed some other way, and a
// remaining life short enough that the OLD 2s timeout could never outlast it but comfortably
// inside the NEW timeout, must now be admitted instead of refused.
{
  const { env, stateDir } = mpaTestEnv({ maxParallelAgents: 5 }); // generous: contention, not capacity
  const lockDir = path.join(stateDir, '.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  // Backdate the lock dir by 7s: 3s of "life" remain before file-lock's own 10s staleMs
  // would call it abandoned. The old 2s timeout could never wait that long; the new ~10.5s
  // timeout comfortably can.
  const backdated = Date.now() / 1000 - 7;
  fs.utimesSync(lockDir, backdated, backdated);
  expect('item 2: a not-yet-stale-but-soon-to-be lock is outlasted, not refused as contended (Agent)',
    mpaLookup('mpa-r3-i2-agent', 'toolu_r3i2_agent'), ALLOW, env);

  fs.mkdirSync(lockDir, { recursive: true });
  const workerBackdated = Date.now() / 1000 - 7;
  fs.utimesSync(lockDir, workerBackdated, workerBackdated);
  expect('worker-start outlasts a soon-stale lock under a finite cap',
    mainBash('orca orchestration worker-start --agent codex --worktree new-child --spec "implement x. Verify: npm test." --json',
      { sid: 'mpa-r3-i2-worker-start', tool_use_id: 'toolu_r3i2_worker_start' }), ALLOW, env);
}

// --- orca-heartbeat.cjs: done-but-open worktree reminder (real spawned daemon + stubs) --
//
// Unlike the gate above, the daemon is long-running, so these spawn it for real (via
// `spawn`, not `spawnSync`) against a short --interval/--max, a `worktree ps` stub backed
// by a file (`STUB_WORKTREES_JSON=@<path>`) this test can rewrite mid-run to simulate a
// real Orca transition (e.g. a PR merging), and a `git` stub (ORCH_GIT_BIN=git-stub.cjs)
// so the "clean"/"accepted-by-ancestor" legs never depend on a real repo existing at a
// synthetic path. `STUB_GIT_CLEAN=1` + `STUB_GIT_HAS_UPSTREAM=1` (a clean worktree with a
// real, fully-pushed upstream) is the default for every call below (most of these cases
// are about the PR/idle/truncation legs, not the git legs themselves) — a test overrides
// one via `gitEnv` only when the git legs are what it is exercising.

/** Spawns the heartbeat daemon against its own state/config/git-stub env, seeded from
 * `worktrees`. `mutateAfterCalls` (paired with `mutateTo`) rewrites the worktree file the
 * moment the Nth `worktree ps` call has actually been observed (via `STUB_WORKTREE_PS_CALLS_LOG`,
 * polled by `waitForCalls`) rather than after a guessed delay (item M2) — deterministic
 * regardless of how fast or slow the test machine is. `envOverrides` layers one-off knobs
 * (e.g. `ORCH_CLOSE_DONE_WORKTREES`) on top; `dirName`/`sessionName` let a test reuse the
 * same state dir and session id across two separate calls, to exercise a daemon restart
 * within one session (item M3). Resolves with combined stdout+stderr once the daemon exits
 * (or is force-killed after 8s as a safety net). */
function runHeartbeat({
  name, worktrees, args, cfgOverrides, envOverrides, gitEnv, mutateAfterCalls, mutateTo,
  dirName, sessionName, workerRows, terminalRows, seedState,
}) {
  return new Promise((resolve) => {
    const dir = path.join(RUN_DIR, dirName || `hb-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    const cfgFile = path.join(dir, 'orchestration.config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ ...DEFAULT_CFG, ...cfgOverrides }));
    const withRealWorktreeIds = (rows) => (rows || []).map((w) =>
      w && typeof w.path === 'string' && !w.worktreeId
        ? { ...w, worktreeId: `repo_hb::${w.path}` }
        : w);
    const initialWorktrees = withRealWorktreeIds(worktrees);
    const wtFile = path.join(dir, 'worktrees.json');
    fs.writeFileSync(wtFile, JSON.stringify(initialWorktrees));
    const callsLogFile = path.join(dir, 'wt-calls.log');
    const scopedWorkerRows = workerRows === undefined
      ? initialWorktrees.filter((w) => w && typeof w.path === 'string').map((w, i) => ({
        dispatchId: `ctx_hb_${i}`,
        workerState: 'running',
        dispatchStatus: 'running',
        terminalState: 'active',
        resource: { worktreeId: w.worktreeId },
        projection: { workspace: { id: w.worktreeId } },
      }))
      : workerRows;
    const heartbeatSession = `hb-${sessionName || name}-${process.pid}`;
    if (seedState) {
      fs.writeFileSync(path.join(dir, `${heartbeatSession}.json`), JSON.stringify({
        session_id: heartbeatSession, workers: {}, reservations: {}, agentClaims: {}, agents: {}, tasks: {},
        ...seedState,
      }));
    }
    const env = {
      ...BASE_ENV, ORCA_BIN: STUB, ORCH_GIT_BIN: GIT_STUB, ORCH_STATE_DIR: dir, ORCH_CONFIG_PATH: cfgFile,
      CLAUDE_CODE_SESSION_ID: heartbeatSession, STUB_WORKTREES_JSON: `@${wtFile}`,
      STUB_WORKTREE_PS_CALLS_LOG: callsLogFile, STUB_WORKERS_JSON: JSON.stringify(scopedWorkerRows),
      STUB_TERMINALS_JSON: JSON.stringify(terminalRows || []),
      STUB_GIT_CLEAN: '1', STUB_GIT_HAS_UPSTREAM: '1',
      ...(gitEnv || {}), ...(envOverrides || {}),
    };
    const child = spawn(process.execPath, [HEARTBEAT, ...(args || [])], { env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    if (mutateAfterCalls != null) {
      waitForCalls(callsLogFile, mutateAfterCalls).then(() => {
        try { fs.writeFileSync(wtFile, JSON.stringify(withRealWorktreeIds(mutateTo))); } catch {}
      });
    }
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 8000);
    child.on('exit', () => { clearTimeout(killer); resolve(out); });
  });
}

/** Polls `file` (one epoch-ms line appended per `worktree ps` call) until it has at least
 * `n` lines, or `timeoutMs` elapses. Item M2: lets a test act exactly when the daemon has
 * made its Nth call, instead of a fixed delay that can land on the wrong side of a tick
 * under a loaded CI machine. */
function waitForCalls(file, n, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      let lines = 0;
      try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch {}
      if (lines >= n || Date.now() - start > timeoutMs) resolve(lines);
      else setTimeout(poll, 20);
    };
    poll();
  });
}

function checkBool(name, actual, expected) {
  if (actual === expected) pass += 1;
  else failures.push(`${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// The git-backed legs (accepted-by-ancestor, clean) really `spawnSync(git, ..., { cwd })`,
// and Node refuses to spawn at all against a `cwd` that does not exist on disk — so every
// worktree fixture below needs a REAL directory, not a synthetic `/wt/...` string, even
// though the git binary itself is stubbed. `realWtDir` creates one on demand under this
// suite's own temp RUN_DIR.
let wtDirCounter = 0;
function realWtDir(label) {
  const p = path.join(RUN_DIR, 'real-wt', `${label}-${wtDirCounter++}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** Same as `realWtDir`, but also plants a `.git` marker file (the mtime H1's
 * `hasProducedMergedWork` stats — see orca-heartbeat.cjs) with a caller-controlled mtime, for
 * fixtures that exercise the no-linked-PR/MR acceptance path against the git-stub (which
 * itself answers HEAD's commit time via `STUB_GIT_HEAD_COMMIT_TIME`, set alongside this). */
function realWtDirWithGitMarker(label, mtimeMs) {
  const p = realWtDir(label);
  const marker = path.join(p, '.git');
  fs.writeFileSync(marker, 'gitdir: /nonexistent\n');
  const t = mtimeMs / 1000;
  fs.utimesSync(marker, t, t);
  return p;
}

async function heartbeatWorktreeTests() {
  {
    const tip = 'Tip: When signed in with ChatGPT, use /usage to check your account usage and access available usage\n' +
      'limit resets.';
    const common = {
      worktrees: [],
      workerRows: [{ dispatchId: 'ctx_rate_tip', workerState: 'running', dispatchStatus: 'running',
        terminalState: 'active', agentTerminalHandle: 'term_rate_tip' }],
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    };
    const tipOut = await runHeartbeat({
      ...common, name: 'rate-limit-tip',
      terminalRows: [{ handle: 'term_rate_tip', title: 'Codex tip', lastOutputAt: Date.now(), preview: tip }],
    });
    checkBool('heartbeat ignores the exact Codex standing usage tip', tipOut.includes('RATE LIMIT'), false);

    const errorOut = await runHeartbeat({
      ...common, name: 'rate-limit-error',
      terminalRows: [{ handle: 'term_rate_tip', title: 'Codex error', lastOutputAt: Date.now(),
        preview: "■ You've hit your usage limit. Try again after the limit resets." }],
    });
    checkBool('heartbeat reports a real-looking Codex rate-limit error', errorOut.includes('RATE LIMIT'), true);
  }

  {
    const common = {
      worktrees: [], dirName: 'hb-codex-disconnect', sessionName: 'codex-disconnect',
      workerRows: [{ dispatchId: 'ctx_disconnected', workerState: 'running', dispatchStatus: 'running',
        terminalState: 'active', agentTerminalHandle: 'term_disconnected' }],
      terminalRows: [{ handle: 'term_disconnected', title: 'Codex worker', lastOutputAt: Date.now(),
        preview: '■ Connection lost. Attempting to reconnect…\n' +
          '■ Automatic reconnect could not restore this session.\n' +
          'Reconnect failed — check the endpoint, then relaunch' }],
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    };
    const first = await runHeartbeat({ ...common, name: 'codex-disconnect-first' });
    checkBool('heartbeat reports a repainting Codex app-server disconnect as WORKER STUCK',
      first.includes('WORKER STUCK on term_disconnected') &&
        first.includes('Codex session lost its app-server connection - its work since the last commit may be lost; release and re-dispatch'),
      true);

    const second = await runHeartbeat({ ...common, name: 'codex-disconnect-restart' });
    checkBool('the same disconnected terminal is reported only once per session across daemon restarts',
      second.includes('WORKER STUCK on term_disconnected'), false);
  }

  // A machine-wide worktree list may include another session's completed worktree. Only
  // paths carried by this session's run-scoped worker rows may enter the reminder.
  {
    const owned = realWtDir('session-owned');
    const foreign = realWtDir('foreign-session');
    const out = await runHeartbeat({
      name: 'session-owned-only',
      worktrees: [
        { path: owned, displayName: 'session-owned', isMainWorktree: false, isArchived: false,
          liveTerminalCount: 1, linkedPR: { state: 'open', number: 501 } },
        { path: foreign, displayName: 'foreign-session', isMainWorktree: false, isArchived: false,
          liveTerminalCount: 1, linkedPR: { state: 'open', number: 502 } },
      ],
      workerRows: [{ dispatchId: 'ctx_session_owned', workerState: 'running', dispatchStatus: 'running',
        terminalState: 'active', resource: { worktreeId: `repo_hb::${owned}` },
        projection: { workspace: { id: `repo_hb::${owned}` } } }],
      mutateAfterCalls: 1,
      mutateTo: [
        { path: owned, displayName: 'session-owned', isMainWorktree: false, isArchived: false,
          liveTerminalCount: 0, linkedPR: { state: 'merged', number: 501 } },
        { path: foreign, displayName: 'foreign-session', isMainWorktree: false, isArchived: false,
          liveTerminalCount: 0, linkedPR: { state: 'merged', number: 502 } },
      ],
      args: ['--interval', '1', '--idle', '60', '--max', '10'],
    });
    checkBool('done-worktree reminder reports a worktree owned by this session',
      out.includes('DONE worktree session-owned'), true);
    checkBool('done-worktree reminder never reports another session\'s worktree',
      out.includes('foreign-session'), false);
  }

  // Readiness failures can have resource:null; projection.workspace.id is the real fallback.
  {
    const p = realWtDir('projection-owned');
    const worktreeId = `repo_hb::${p}`;
    const out = await runHeartbeat({
      name: 'projection-owned',
      worktrees: [{ path: p, worktreeId, displayName: 'projection-owned', isMainWorktree: false,
        isArchived: false, liveTerminalCount: 0, linkedPR: { state: 'merged', number: 31 } }],
      workerRows: [{ dispatchId: 'ctx_projection', workerState: 'failed', dispatchStatus: 'failed',
        terminalState: 'retained', resource: null, projection: { workspace: { id: worktreeId } } }],
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    checkBool('real row shape: projection.workspace.id owns a worktree when resource is null',
      out.includes(`pre-existing done-but-open worktree(s) at startup: projection-owned (${p})`), true);
  }

  // A worktree created by this session can be recovered from its tracked terminal row even
  // when worker-list has not yet attached a resource/projection worktree id.
  {
    const p = realWtDir('terminal-owned');
    const worktreeId = `repo_hb::${p}`;
    const out = await runHeartbeat({
      name: 'terminal-owned',
      worktrees: [{ path: p, worktreeId, displayName: 'terminal-owned', isMainWorktree: false,
        isArchived: false, liveTerminalCount: 0, linkedPR: { state: 'merged', number: 32 } }],
      workerRows: [],
      terminalRows: [{ handle: 'term_session_created', title: 'created', lastOutputAt: 0,
        worktreePath: p, worktreeId }],
      seedState: { workers: { term_session_created: { status: 'live', kind: 'terminal',
        group: 'term_session_created', started: Date.now() } } },
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    checkBool('real row shape: a tracked session terminal contributes its worktreeId',
      out.includes(`pre-existing done-but-open worktree(s) at startup: terminal-owned (${p})`), true);
  }

  // M-1: an explicit worker-retain decision makes a baseline-old retained terminal
  // supervised even when it emitted nothing after daemon startup.
  {
    const old = Date.now() - 60_000;
    const out = await runHeartbeat({
      name: 'explicit-retained-idle', worktrees: [],
      workerRows: [{ dispatchId: 'ctx_explicit_retained', workerState: 'failed', dispatchStatus: 'failed',
        terminalState: 'retained', agentTerminalHandle: 'term_explicit_retained' }],
      terminalRows: [{ handle: 'term_explicit_retained', title: 'explicit retained', lastOutputAt: old }],
      seedState: { workers: { ctx_explicit_retained: { status: 'live', retained: true,
        group: 'ctx_explicit_retained', started: old } } },
      args: ['--interval', '1', '--idle', '2', '--max', '3'],
    });
    checkBool('explicit retained terminal silent before daemon startup is reported IDLE',
      out.includes('IDLE') && out.includes('term_explicit_retained'), true);
  }

  // A retained terminal's quiet stretch is reported once per session, not once per daemon
  // lifetime. A changed lastOutputAt value starts a new quiet stretch and re-arms reporting.
  {
    const old = Date.now() - 60_000;
    const shared = {
      name: 'retained-idle-restart', dirName: 'hb-retained-idle-restart',
      sessionName: 'retained-idle-restart-shared', worktrees: [],
      workerRows: [{ dispatchId: 'ctx_retained_restart', workerState: 'failed', dispatchStatus: 'failed',
        terminalState: 'retained', agentTerminalHandle: 'term_retained_restart' }],
      args: ['--interval', '1', '--idle', '2', '--max', '1'],
    };
    const seedState = { workers: { ctx_retained_restart: { status: 'live', retained: true,
      group: 'ctx_retained_restart', started: old } } };
    const out1 = await runHeartbeat({ ...shared, seedState,
      terminalRows: [{ handle: 'term_retained_restart', title: 'retained restart', lastOutputAt: old }] });
    const out2 = await runHeartbeat({ ...shared,
      terminalRows: [{ handle: 'term_retained_restart', title: 'retained restart', lastOutputAt: old }] });
    const firstStretchCount = ((out1 + out2).match(/IDLE \d+s: term_retained_restart/g) || []).length;
    checkBool('retained terminal quiet stretch is reported once across a daemon restart', firstStretchCount, 1);
    const out3 = await runHeartbeat({ ...shared,
      terminalRows: [{ handle: 'term_retained_restart', title: 'retained restart', lastOutputAt: old + 1_000 }] });
    checkBool('new retained-terminal output re-arms the next quiet-stretch report',
      out3.includes('IDLE') && out3.includes('term_retained_restart'), true);
  }

  // 1. A worktree already done-but-open at startup: only the one-time summary line, never
  //    the wake-event line, and the daemon runs to its --max instead of exiting early.
  {
    const p = realWtDir('pre');
    const out = await runHeartbeat({
      name: 'preexisting',
      worktrees: [{ path: p, displayName: 'pre', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedPR: { state: 'merged', number: 1 } }],
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    checkBool('pre-existing done-but-open worktree appears in the startup summary (with its path)',
      out.includes(`pre-existing done-but-open worktree(s) at startup: pre (${p})`), true);
    checkBool('pre-existing done-but-open worktree never fires the wake-event line',
      out.includes('DONE worktree pre'), false);
    checkBool('the startup summary alone does not end the daemon early',
      out.includes('quiet for'), true);
  }

  // 2. A worktree that transitions to done-but-open AFTER the baseline: a wake event
  //    (naming the acceptance reason, quoted rm path), and the daemon exits promptly
  //    (well before its generous --max) instead of idling on it.
  {
    const p = realWtDir('t1');
    const out = await runHeartbeat({
      name: 'transition',
      worktrees: [{ path: p, displayName: 't1', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 1, linkedPR: { state: 'open', number: 2 } }],
      mutateAfterCalls: 1,
      mutateTo: [{ path: p, displayName: 't1', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedPR: { state: 'merged', number: 2 } }],
      args: ['--interval', '1', '--idle', '60', '--max', '10'],
    });
    checkBool('a worktree that becomes done-but-open mid-run fires the wake-event line',
      out.includes(`DONE worktree t1 (PR #2 merged, no live terminal) — verify it is clean, then close: ` +
        `orca worktree rm --worktree 'path:${p}'`), true);
    checkBool('a genuine transition is not also reported as a startup summary',
      out.includes('pre-existing'), false);
    checkBool('the daemon exits on the transition instead of running to --max',
      out.includes('quiet for'), false);
  }

  // 3. Open PR, a live terminal, the main worktree, and an already-archived worktree must
  //    never be reported, whether at startup or on a later tick (here: never, since static).
  {
    const out = await runHeartbeat({
      name: 'never-report',
      worktrees: [
        { path: realWtDir('openpr'), displayName: 'openpr', isMainWorktree: false, isArchived: false,
          liveTerminalCount: 0, linkedPR: { state: 'open', number: 3 } },
        { path: realWtDir('liveterm'), displayName: 'liveterm', isMainWorktree: false, isArchived: false,
          liveTerminalCount: 2, linkedPR: { state: 'merged', number: 4 } },
        { path: realWtDir('main'), displayName: 'main', isMainWorktree: true, isArchived: false,
          liveTerminalCount: 0, linkedPR: { state: 'merged', number: 5 } },
        { path: realWtDir('archived'), displayName: 'archived', isMainWorktree: false, isArchived: true,
          liveTerminalCount: 0, linkedPR: { state: 'closed', number: 6 } },
      ],
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    checkBool('open-PR/live-terminal/main/archived worktrees never fire the wake-event line',
      out.includes('DONE worktree'), false);
    checkBool('open-PR/live-terminal/main/archived worktrees never appear in the startup summary',
      out.includes('pre-existing'), false);
  }

  // 4. Config (or its env override) can disable the reminder entirely, even when a
  //    worktree is done-but-open right from the baseline. Item L6: both branches now go
  //    through the same `runHeartbeat` helper via `envOverrides`, instead of one of them
  //    hand-duplicating the whole spawn/env/listener boilerplate.
  {
    const out = await runHeartbeat({
      name: 'config-disabled',
      worktrees: [{ path: realWtDir('pre'), displayName: 'pre', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedPR: { state: 'merged', number: 1 } }],
      cfgOverrides: { closeDoneWorktrees: false },
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    checkBool('closeDoneWorktrees:false suppresses the startup summary', out.includes('pre-existing'), false);
    checkBool('closeDoneWorktrees:false suppresses the wake-event line', out.includes('DONE worktree'), false);

    const outEnvDisabled = await runHeartbeat({
      name: 'env-disabled-direct',
      worktrees: [{ path: realWtDir('pre'), displayName: 'pre', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedPR: { state: 'merged', number: 1 } }],
      envOverrides: { ORCH_CLOSE_DONE_WORKTREES: '0' },
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    checkBool('ORCH_CLOSE_DONE_WORKTREES=0 suppresses the startup summary', outEnvDisabled.includes('pre-existing'), false);
    checkBool('ORCH_CLOSE_DONE_WORKTREES=0 suppresses the wake-event line', outEnvDisabled.includes('DONE worktree'), false);
  }

  // 5. Item M1: a malformed worktree row (a bare `null` entry, mixed in with a real one)
  //    must never crash the daemon — it degrades this poll and the real entry still gets
  //    its startup summary.
  {
    const p = realWtDir('pre');
    const out = await runHeartbeat({
      name: 'malformed-row',
      worktrees: [null, { path: p, displayName: 'pre', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedPR: { state: 'merged', number: 1 } }],
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    checkBool('a null row among the worktrees never crashes the daemon',
      out.includes('orca-heartbeat: Orca is not answering'), false);
    checkBool('the real row alongside a null one still gets its startup summary',
      out.includes(`pre-existing done-but-open worktree(s) at startup: pre (${p})`), true);
  }

  // 6. Item M5: a page Orca itself marks `truncated: true` must never be acted on, even
  //    when it contains a row that would otherwise be a clean, obvious done-but-open case
  //    — a partial page can neither confirm nor rule out a transition.
  {
    const out = await runHeartbeat({
      name: 'truncated',
      worktrees: [{ path: realWtDir('pre'), displayName: 'pre', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedPR: { state: 'merged', number: 1 } }],
      envOverrides: { STUB_WORKTREES_TRUNCATED: '1' },
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    checkBool('a truncated page never produces a startup summary', out.includes('pre-existing'), false);
    checkBool('a truncated page never fires a wake-event line', out.includes('DONE worktree'), false);
  }

  // 6b. Auto-close done workers (binding operator decision, 2026-10-01): a successfully
  // done worker still holding a terminal is released and its terminal closed by the daemon
  // itself — no panel decision — when its worktree is provably clean and fully pushed.
  {
    const wt = realWtDir('auto-close-clean');
    const name = 'auto-close-done-clean';
    const callsFile = path.join(RUN_DIR, `hb-${name}`, 'orca-calls.log');
    const out = await runHeartbeat({
      name, worktrees: [],
      workerRows: [{ dispatchId: 'ctx_done_clean', taskId: 'task_done_clean',
        workerState: 'succeeded', dispatchStatus: 'completed', terminalState: 'active',
        agentTerminalHandle: 'term_done_clean', worktreePath: wt }],
      terminalRows: [{ handle: 'term_done_clean', title: 'done worker', lastOutputAt: Date.now() - 65_000,
        worktreePath: wt }],
      envOverrides: { STUB_ORCA_CALLS_LOG: callsFile },
      args: ['--interval', '1', '--idle', '60', '--max', '3'],
    });
    let calls = '';
    try { calls = fs.readFileSync(callsFile, 'utf8'); } catch {}
    checkBool('a done, clean, fully-pushed worker emits WORKER CLOSED (informational)',
      out.includes('WORKER CLOSED ctx_done_clean (done, terminal closed, worktree kept)'), true);
    checkBool('the daemon ran worker-release for the done worker itself',
      calls.includes('orchestration worker-release --dispatch ctx_done_clean'), true);
    checkBool('the daemon closed the done worker\'s terminal itself',
      calls.includes('terminal close --terminal term_done_clean'), true);
    checkBool('an auto-closed worker never fires the retain-or-release event',
      out.includes('still holding a terminal'), false);
  }

  // 6c. A done worker whose worktree is dirty is NOT auto-closed — it is flagged WORKER
  // DONE BUT UNSAVED (a wake event) and its terminal stays open.
  {
    const wt = realWtDir('auto-close-dirty');
    const name = 'auto-close-done-dirty';
    const callsFile = path.join(RUN_DIR, `hb-${name}`, 'orca-calls.log');
    const out = await runHeartbeat({
      name, worktrees: [],
      workerRows: [{ dispatchId: 'ctx_done_dirty', taskId: 'task_done_dirty',
        workerState: 'succeeded', dispatchStatus: 'completed', terminalState: 'active',
        agentTerminalHandle: 'term_done_dirty', worktreePath: wt }],
      terminalRows: [{ handle: 'term_done_dirty', title: 'done worker', lastOutputAt: Date.now() - 65_000,
        worktreePath: wt }],
      envOverrides: { STUB_ORCA_CALLS_LOG: callsFile },
      gitEnv: { STUB_GIT_CLEAN: '0' },
      args: ['--interval', '1', '--idle', '60', '--max', '3'],
    });
    let calls = '';
    try { calls = fs.readFileSync(callsFile, 'utf8'); } catch {}
    checkBool('a done worker with a dirty worktree is flagged WORKER DONE BUT UNSAVED',
      out.includes('WORKER DONE BUT UNSAVED ctx_done_dirty'), true);
    checkBool('a dirty worktree is never auto-released or auto-closed',
      calls.includes('worker-release') || calls.includes('terminal close'), false);
  }

  // 6d. Same for unpushed commits (clean tree, but the upstream lacks commits).
  {
    const wt = realWtDir('auto-close-unpushed');
    const name = 'auto-close-done-unpushed';
    const callsFile = path.join(RUN_DIR, `hb-${name}`, 'orca-calls.log');
    const out = await runHeartbeat({
      name, worktrees: [],
      workerRows: [{ dispatchId: 'ctx_done_unpushed', taskId: 'task_done_unpushed',
        workerState: 'succeeded', dispatchStatus: 'completed', terminalState: 'active',
        agentTerminalHandle: 'term_done_unpushed', worktreePath: wt }],
      terminalRows: [{ handle: 'term_done_unpushed', title: 'done worker', lastOutputAt: Date.now() - 65_000,
        worktreePath: wt }],
      envOverrides: { STUB_ORCA_CALLS_LOG: callsFile },
      gitEnv: { STUB_GIT_UNPUSHED: '1' },
      args: ['--interval', '1', '--idle', '60', '--max', '3'],
    });
    let calls = '';
    try { calls = fs.readFileSync(callsFile, 'utf8'); } catch {}
    checkBool('a done worker with unpushed commits is flagged WORKER DONE BUT UNSAVED',
      out.includes('WORKER DONE BUT UNSAVED ctx_done_unpushed'), true);
    checkBool('unpushed work is never auto-released or auto-closed',
      calls.includes('worker-release') || calls.includes('terminal close'), false);
  }

  // 6e. A worker the panel explicitly retained for reuse (worker-retain) is never
  // auto-closed, even when done and clean.
  {
    const wt = realWtDir('auto-close-retained');
    const name = 'auto-close-done-retained';
    const callsFile = path.join(RUN_DIR, `hb-${name}`, 'orca-calls.log');
    const out = await runHeartbeat({
      name, worktrees: [],
      workerRows: [{ dispatchId: 'ctx_done_retained', taskId: 'task_done_retained',
        workerState: 'succeeded', dispatchStatus: 'completed', terminalState: 'retained',
        agentTerminalHandle: 'term_done_retained', worktreePath: wt }],
      terminalRows: [{ handle: 'term_done_retained', title: 'retained done worker',
        lastOutputAt: Date.now(), worktreePath: wt }],
      seedState: { workers: { ctx_done_retained: { status: 'live', retained: true,
        group: 'ctx_done_retained', started: Date.now() } } },
      envOverrides: { STUB_ORCA_CALLS_LOG: callsFile },
      args: ['--interval', '1', '--idle', '60', '--max', '3'],
    });
    let calls = '';
    try { calls = fs.readFileSync(callsFile, 'utf8'); } catch {}
    checkBool('a retained-for-reuse done worker is never auto-closed',
      out.includes('WORKER CLOSED'), false);
    checkBool('a retained-for-reuse done worker is never released by the daemon',
      calls.includes('worker-release') || calls.includes('terminal close'), false);
  }

  // 6f. closeDoneWorktrees:"remove": the done-worktree detector runs `orca worktree rm`
  // itself and logs WORKTREE REMOVED instead of waking the panel with the rm command.
  {
    const p = realWtDir('rm-merged');
    const name = 'remove-mode-merged';
    const callsFile = path.join(RUN_DIR, `hb-${name}`, 'orca-calls.log');
    const out = await runHeartbeat({
      name,
      worktrees: [{ path: p, displayName: 'rm-merged', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedPR: { state: 'merged', number: 77 } }],
      cfgOverrides: { closeDoneWorktrees: 'remove' },
      envOverrides: { STUB_ORCA_CALLS_LOG: callsFile },
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    let calls = '';
    try { calls = fs.readFileSync(callsFile, 'utf8'); } catch {}
    checkBool('remove mode removes a merged, clean, idle worktree itself',
      out.includes('WORKTREE REMOVED rm-merged (PR #77 merged)'), true);
    checkBool('remove mode ran orca worktree rm with the path target',
      calls.includes(`worktree rm --worktree path:${p}`), true);
    checkBool('remove mode never fires the DONE worktree reminder or the startup summary',
      out.includes('DONE worktree') || out.includes('pre-existing'), false);
  }

  // 6g. Remove mode never removes a worktree with an OPEN PR, nor another session's
  // worktree (the session-owned filter is unchanged by the mode).
  {
    const open = realWtDir('rm-open-pr');
    const foreign = realWtDir('rm-foreign');
    const name = 'remove-mode-never';
    const callsFile = path.join(RUN_DIR, `hb-${name}`, 'orca-calls.log');
    const out = await runHeartbeat({
      name,
      worktrees: [
        { path: open, displayName: 'rm-open-pr', isMainWorktree: false, isArchived: false,
          liveTerminalCount: 0, linkedPR: { state: 'open', number: 78 } },
        { path: foreign, displayName: 'rm-foreign', isMainWorktree: false, isArchived: false,
          liveTerminalCount: 0, linkedPR: { state: 'merged', number: 79 } },
      ],
      workerRows: [{ dispatchId: 'ctx_rm_owned', workerState: 'running', dispatchStatus: 'running',
        terminalState: 'active', resource: { worktreeId: `repo_hb::${open}` },
        projection: { workspace: { id: `repo_hb::${open}` } } }],
      cfgOverrides: { closeDoneWorktrees: 'remove' },
      envOverrides: { STUB_ORCA_CALLS_LOG: callsFile },
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    let calls = '';
    try { calls = fs.readFileSync(callsFile, 'utf8'); } catch {}
    checkBool('remove mode never removes a worktree with an open PR',
      out.includes('rm-open-pr') || calls.includes('worktree rm'), false);
    checkBool('remove mode never removes another session\'s worktree',
      out.includes('rm-foreign') || calls.includes('worktree rm'), false);
  }

  // 6h. Blocker 1 (review): a real worker-list row never carries a flat worktreePath — only
  // nested `resource.worktreeId` (`<repoId>::<abs path>`). The daemon must still resolve it
  // and auto-close exactly like the flat-path fixture above.
  {
    const wt = realWtDir('auto-close-real-shape');
    const name = 'auto-close-real-row-shape';
    const callsFile = path.join(RUN_DIR, `hb-${name}`, 'orca-calls.log');
    const out = await runHeartbeat({
      name, worktrees: [],
      workerRows: [{ dispatchId: 'ctx_real_shape', taskId: 'task_real_shape',
        workerState: 'succeeded', dispatchStatus: 'completed', terminalState: 'active',
        agentTerminalHandle: 'term_real_shape', resource: { worktreeId: `repo_hb::${wt}` } }],
      terminalRows: [{ handle: 'term_real_shape', title: 'done worker',
        lastOutputAt: Date.now() - 65_000, worktreeId: `repo_hb::${wt}` }],
      envOverrides: { STUB_ORCA_CALLS_LOG: callsFile },
      args: ['--interval', '1', '--idle', '60', '--max', '3'],
    });
    let calls = '';
    try { calls = fs.readFileSync(callsFile, 'utf8'); } catch {}
    checkBool('a real nested-shape row (resource.worktreeId only, no flat worktreePath) still auto-closes',
      out.includes('WORKER CLOSED ctx_real_shape (done, terminal closed, worktree kept)'), true);
    checkBool('the release call ran for the real-shape row',
      calls.includes('orchestration worker-release --dispatch ctx_real_shape'), true);
  }

  // 6i. A done worker whose worktree path cannot be resolved at all (no flat path, no
  // worktreeIds) falls back to the old "still holding a terminal" retain-or-release event
  // instead of being silently dropped.
  {
    const name = 'auto-close-unresolvable-path';
    const out = await runHeartbeat({
      name, worktrees: [],
      workerRows: [{ dispatchId: 'ctx_unresolvable', taskId: 'task_unresolvable',
        workerState: 'succeeded', dispatchStatus: 'completed', terminalState: 'active',
        agentTerminalHandle: 'term_unresolvable' }],
      terminalRows: [{ handle: 'term_unresolvable', title: 'done worker',
        lastOutputAt: Date.now() - 65_000 }],
      args: ['--interval', '1', '--idle', '60', '--max', '3'],
    });
    checkBool('a done worker with no resolvable worktree path never auto-closes',
      out.includes('WORKER CLOSED'), false);
    checkBool('it falls back to the retain-or-release wake event instead of going silent',
      out.includes('still holding a terminal'), true);
  }

  // 6j. Blocker 2 (review): WORKER DONE BUT UNSAVED fires once per episode, not on every
  // tick or every daemon restart within the same session.
  {
    const wt = realWtDir('auto-close-unsaved-restart');
    const rows = [{ dispatchId: 'ctx_unsaved_restart', taskId: 'task_unsaved_restart',
      workerState: 'succeeded', dispatchStatus: 'completed', terminalState: 'active',
      agentTerminalHandle: 'term_unsaved_restart', worktreePath: wt }];
    const terms = [{ handle: 'term_unsaved_restart', title: 'done worker',
      lastOutputAt: Date.now() - 65_000, worktreePath: wt }];
    const out1 = await runHeartbeat({
      name: 'unsaved-restart', sessionName: 'unsaved-restart-shared', dirName: 'hb-unsaved-restart-shared',
      worktrees: [], workerRows: rows, terminalRows: terms,
      gitEnv: { STUB_GIT_CLEAN: '0' },
      args: ['--interval', '1', '--idle', '60', '--max', '3'],
    });
    checkBool('the first run flags WORKER DONE BUT UNSAVED',
      out1.includes('WORKER DONE BUT UNSAVED ctx_unsaved_restart'), true);
    const out2 = await runHeartbeat({
      name: 'unsaved-restart', sessionName: 'unsaved-restart-shared', dirName: 'hb-unsaved-restart-shared',
      worktrees: [], workerRows: rows, terminalRows: terms,
      gitEnv: { STUB_GIT_CLEAN: '0' },
      args: ['--interval', '1', '--idle', '60', '--max', '3'],
    });
    checkBool('a daemon restart within the same session never re-fires the same WORKER DONE BUT UNSAVED',
      out2.includes('WORKER DONE BUT UNSAVED'), false);
  }

  // 6k. Blocker 3 (review): a failed worker-release is never logged or persisted as a
  // success. It wakes the panel once with AUTO-CLOSE FAILED and never attempts the
  // terminal close for a release that did not succeed.
  {
    const wt = realWtDir('auto-close-release-fails');
    const name = 'auto-close-release-fails';
    const callsFile = path.join(RUN_DIR, `hb-${name}`, 'orca-calls.log');
    const out = await runHeartbeat({
      name, worktrees: [],
      workerRows: [{ dispatchId: 'ctx_release_fails', taskId: 'task_release_fails',
        workerState: 'succeeded', dispatchStatus: 'completed', terminalState: 'active',
        agentTerminalHandle: 'term_release_fails', worktreePath: wt }],
      terminalRows: [{ handle: 'term_release_fails', title: 'done worker',
        lastOutputAt: Date.now() - 65_000, worktreePath: wt }],
      envOverrides: { STUB_ORCA_CALLS_LOG: callsFile, STUB_WORKER_RELEASE_OK_FALSE: '1' },
      args: ['--interval', '1', '--idle', '60', '--max', '3'],
    });
    let calls = '';
    try { calls = fs.readFileSync(callsFile, 'utf8'); } catch {}
    checkBool('a release Orca refuses is reported as AUTO-CLOSE FAILED, never WORKER CLOSED',
      out.includes('AUTO-CLOSE FAILED ctx_release_fails') && !out.includes('WORKER CLOSED'), true);
    checkBool('the terminal-close call is never attempted after a failed release',
      calls.includes('terminal close'), false);
  }

  // 6l. Blocker 4 (review): Orca's own automatic readiness-timeout retain
  // (retainedReason: identity_unproven) is distinct from an operator retain-for-reuse and
  // stays eligible for auto-close even though terminalState reads 'retained'.
  {
    const wt = realWtDir('auto-close-identity-unproven');
    const name = 'auto-close-identity-unproven';
    const callsFile = path.join(RUN_DIR, `hb-${name}`, 'orca-calls.log');
    const out = await runHeartbeat({
      name, worktrees: [],
      workerRows: [{ dispatchId: 'ctx_identity_unproven', taskId: 'task_identity_unproven',
        workerState: 'succeeded', dispatchStatus: 'completed', terminalState: 'retained',
        agentTerminalHandle: 'term_identity_unproven', worktreePath: wt,
        resource: { retainedReason: 'identity_unproven' } }],
      terminalRows: [{ handle: 'term_identity_unproven', title: 'done worker',
        lastOutputAt: Date.now() - 65_000, worktreePath: wt }],
      envOverrides: { STUB_ORCA_CALLS_LOG: callsFile },
      args: ['--interval', '1', '--idle', '60', '--max', '3'],
    });
    let calls = '';
    try { calls = fs.readFileSync(callsFile, 'utf8'); } catch {}
    checkBool('an Orca-automatic identity_unproven retain still auto-closes',
      out.includes('WORKER CLOSED ctx_identity_unproven'), true);
    checkBool('the release call ran despite terminalState: retained',
      calls.includes('worker-release --dispatch ctx_identity_unproven'), true);
  }

  // 6m. Same shape, but an explicit `worker-retain` (resource.retainedReason:
  // user_requested) that the gate recorded as having happened AFTER the worker was first
  // seen done blocks auto-close (the operator asked to keep this one for reuse).
  {
    const wt = realWtDir('auto-close-user-requested-after-done');
    const name = 'auto-close-user-requested-after-done';
    const callsFile = path.join(RUN_DIR, `hb-${name}`, 'orca-calls.log');
    const farFuture = Date.now() + 10 * 24 * 60 * 60 * 1000;
    const out = await runHeartbeat({
      name, worktrees: [],
      workerRows: [{ dispatchId: 'ctx_user_requested_late', taskId: 'task_user_requested_late',
        workerState: 'succeeded', dispatchStatus: 'completed', terminalState: 'retained',
        agentTerminalHandle: 'term_user_requested_late', worktreePath: wt,
        resource: { retainedReason: 'user_requested' } }],
      terminalRows: [{ handle: 'term_user_requested_late', title: 'done worker',
        lastOutputAt: Date.now() - 65_000, worktreePath: wt }],
      seedState: { workers: { ctx_user_requested_late: { status: 'live', retained: true,
        retainedAt: farFuture, group: 'ctx_user_requested_late', started: Date.now() } } },
      envOverrides: { STUB_ORCA_CALLS_LOG: callsFile },
      args: ['--interval', '1', '--idle', '60', '--max', '3'],
    });
    let calls = '';
    try { calls = fs.readFileSync(callsFile, 'utf8'); } catch {}
    checkBool('a user_requested retain recorded after the done transition is never auto-closed',
      out.includes('WORKER CLOSED'), false);
    checkBool('the daemon never released a worker explicitly retained for reuse after done',
      calls.includes('worker-release'), false);
  }

  // 6n. Blocker 5 (review): remove mode never removes a worktree that still holds a live
  // terminal, even one `isWorktreeIdle` already treats as idle-but-quiet — it falls back
  // to the remind event instead.
  {
    const p = realWtDir('rm-live-terminal');
    const name = 'remove-mode-live-terminal';
    const callsFile = path.join(RUN_DIR, `hb-${name}`, 'orca-calls.log');
    const out = await runHeartbeat({
      name,
      worktrees: [{ path: p, displayName: 'rm-live-terminal', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 1, lastOutputAt: Date.now() - 65_000,
        linkedPR: { state: 'merged', number: 80 } }],
      cfgOverrides: { closeDoneWorktrees: 'remove' },
      envOverrides: { STUB_ORCA_CALLS_LOG: callsFile },
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    let calls = '';
    try { calls = fs.readFileSync(callsFile, 'utf8'); } catch {}
    checkBool('remove mode with a live (even quiet) terminal never runs worktree rm',
      calls.includes('worktree rm'), false);
    checkBool('it falls back to the DONE worktree remind event instead',
      out.includes('DONE worktree rm-live-terminal (PR #80 merged'), true);
  }

  // 6o. Blocker 3 (review): a failed `orca worktree rm` is never recorded as removed; it
  // wakes the panel once with WORKTREE RM FAILED plus the remind fallback.
  {
    const p = realWtDir('rm-fails');
    const name = 'remove-mode-rm-fails';
    const callsFile = path.join(RUN_DIR, `hb-${name}`, 'orca-calls.log');
    const out = await runHeartbeat({
      name,
      worktrees: [{ path: p, displayName: 'rm-fails', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedPR: { state: 'merged', number: 81 } }],
      cfgOverrides: { closeDoneWorktrees: 'remove' },
      envOverrides: { STUB_ORCA_CALLS_LOG: callsFile, STUB_WORKTREE_RM_OK_FALSE: '1' },
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    let calls = '';
    try { calls = fs.readFileSync(callsFile, 'utf8'); } catch {}
    checkBool('a failed worktree rm is reported as WORKTREE RM FAILED, never WORKTREE REMOVED',
      out.includes('WORKTREE RM FAILED') && !out.includes('WORKTREE REMOVED'), true);
    checkBool('the rm call was attempted',
      calls.includes('worktree rm'), true);
    checkBool('the failed rm also falls back to the DONE worktree remind event',
      out.includes('DONE worktree rm-fails (PR #81 merged'), true);
  }

  // 7. Item M4: the daemon's very first `worktree ps` call fails outright (non-zero exit,
  //    no JSON at all) — the eventual FIRST SUCCESSFUL read must still seed as a one-time
  //    backlog summary, never as an immediate flood of "new" wake events for what was
  //    actually pre-existing all along.
  {
    const p = realWtDir('pre');
    const out = await runHeartbeat({
      name: 'failed-first-read',
      worktrees: [{ path: p, displayName: 'pre', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedPR: { state: 'merged', number: 1 } }],
      envOverrides: { STUB_WORKTREE_PS_FAIL_UNTIL: String(Date.now() + 1200) },
      args: ['--interval', '1', '--idle', '60', '--max', '5'],
    });
    checkBool('a worktree already done-but-open when the first read finally succeeds is backlog, not a wake event',
      out.includes('DONE worktree pre'), false);
    checkBool('it still appears in the (delayed) one-time startup summary',
      out.includes(`pre-existing done-but-open worktree(s) at startup: pre (${p})`), true);
  }

  // 7b. The same guarantee for a first read that comes back non-JSON rather than a
  // non-zero exit — a different failure shape, same required outcome.
  {
    const p = realWtDir('pre');
    const out = await runHeartbeat({
      name: 'garbage-first-read',
      worktrees: [{ path: p, displayName: 'pre', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedPR: { state: 'merged', number: 1 } }],
      envOverrides: { STUB_WORKTREE_PS_GARBAGE_UNTIL: String(Date.now() + 1200) },
      args: ['--interval', '1', '--idle', '60', '--max', '5'],
    });
    checkBool('a worktree already done-but-open when the first NON-JSON read finally succeeds is backlog, not a wake event',
      out.includes('DONE worktree pre'), false);
    checkBool('it still appears in the (delayed) one-time startup summary',
      out.includes(`pre-existing done-but-open worktree(s) at startup: pre (${p})`), true);
  }

  // 8. A worktree already done-but-open at the baseline must be reported exactly ONCE
  //    across several ticks of the SAME daemon run, never re-announced tick after tick.
  {
    const out = await runHeartbeat({
      name: 'reported-once',
      worktrees: [{ path: realWtDir('pre'), displayName: 'pre', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedPR: { state: 'merged', number: 1 } }],
      args: ['--interval', '1', '--idle', '60', '--max', '3'],
    });
    const summaryCount = (out.match(/pre-existing done-but-open worktree\(s\) at startup/g) || []).length;
    checkBool('the startup summary appears exactly once across multiple ticks of one run', summaryCount, 1);
  }

  // 9. Item M3: a worktree that becomes done-but-open while NO DAEMON IS RUNNING (between
  //    two daemon lifetimes in the SAME session) must surface as a real wake event on the
  //    restart, not be silently re-absorbed as if it had always been backlog.
  {
    const p = realWtDir('restart-a');
    // First lifetime: nothing done-but-open yet, runs to its own short --max and exits.
    await runHeartbeat({
      name: 'restart',
      sessionName: 'restart-shared',
      dirName: 'hb-restart-shared',
      worktrees: [{ path: p, displayName: 'a', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedPR: { state: 'open', number: 9 } }],
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    // Second lifetime, same session/state dir: the PR is now merged — this worktree became
    // done-but-open while the daemon was not running at all.
    const out2 = await runHeartbeat({
      name: 'restart',
      sessionName: 'restart-shared',
      dirName: 'hb-restart-shared',
      worktrees: [{ path: p, displayName: 'a', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedPR: { state: 'merged', number: 9 } }],
      args: ['--interval', '1', '--idle', '60', '--max', '5'],
    });
    checkBool('a worktree that became done-but-open between two daemon runs fires a real wake event on restart',
      out2.includes('DONE worktree a (PR #9 merged, no live terminal)'), true);
    checkBool('it is not mistaken for pre-existing backlog on the restart',
      out2.includes('pre-existing'), false);
  }

  // 10. Same restart shape, but nothing changed between the two lifetimes: a worktree
  // already reported once (in run 1's startup summary) must never be re-announced — as
  // either a summary line or a wake event — on a later restart within the same session.
  {
    const p = realWtDir('restart-b');
    await runHeartbeat({
      name: 'restart-quiet',
      sessionName: 'restart-quiet-shared',
      dirName: 'hb-restart-quiet-shared',
      worktrees: [{ path: p, displayName: 'b', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedPR: { state: 'merged', number: 10 } }],
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    const out2 = await runHeartbeat({
      name: 'restart-quiet',
      sessionName: 'restart-quiet-shared',
      dirName: 'hb-restart-quiet-shared',
      worktrees: [{ path: p, displayName: 'b', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedPR: { state: 'merged', number: 10 } }],
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    checkBool('a worktree already reported in a prior daemon run is never re-announced as a wake event on restart',
      out2.includes('DONE worktree b'), false);
    checkBool('nor re-announced as a fresh startup summary on restart',
      out2.includes('pre-existing'), false);
  }

  // 11. Item L5: a merged GitLab MR (no GitHub PR linked at all) is accepted the same way a
  // merged PR is; a still-"opened" MR is not.
  {
    const pMerged = realWtDir('mr');
    const out = await runHeartbeat({
      name: 'gitlab-mr-merged',
      worktrees: [{ path: pMerged, displayName: 'mr', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedGitLabMR: { state: 'merged', number: 20 } }],
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    checkBool('a merged GitLab MR (no PR linked) is done-but-open',
      out.includes(`pre-existing done-but-open worktree(s) at startup: mr (${pMerged})`), true);

    const outOpen = await runHeartbeat({
      name: 'gitlab-mr-open',
      worktrees: [{ path: realWtDir('mr2'), displayName: 'mr2', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedGitLabMR: { state: 'opened', number: 21 } }],
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    checkBool('a still-open GitLab MR is never done-but-open', outOpen.includes('pre-existing'), false);
  }

  // 12. No linked PR or MR at all: acceptance falls back to a real git ancestor-of-base
  // check via the git stub — accepted when HEAD is confirmed merged, refused when it isn't.
  // H1: acceptance also requires HEAD's own commit to postdate the worktree's `.git` marker
  // (`hasProducedMergedWork`), so `pMerged`'s marker is forced well into the past and the
  // stub's HEAD commit time well after it. Review round 3, item 3: acceptance ALSO requires
  // the branch's own reflog to record a real commit (`hasOwnCommit`), so the stub is told to
  // answer that too — see the dedicated real-git tests further down for the false-positive
  // case (a rebased/fast-forwarded worktree with no commits of its own) this stub-based pair
  // cannot reproduce with a fake mtime/commit-time pair alone.
  {
    const pMerged = realWtDirWithGitMarker('np', Date.now() - 3_600_000);
    const outMerged = await runHeartbeat({
      name: 'no-pr-ancestor',
      worktrees: [{ path: pMerged, displayName: 'np', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0 }],
      gitEnv: { STUB_GIT_ANCESTOR: '1', STUB_GIT_HEAD_COMMIT_TIME: String(Math.floor(Date.now() / 1000)),
        STUB_GIT_REFLOG_HAS_COMMIT: '1' },
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    checkBool('no linked PR/MR + git confirms HEAD is an ancestor of base + clean is done-but-open',
      outMerged.includes(`pre-existing done-but-open worktree(s) at startup: np (${pMerged})`), true);

    const outNotMerged = await runHeartbeat({
      name: 'no-pr-not-ancestor',
      worktrees: [{ path: realWtDir('np2'), displayName: 'np2', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0 }],
      gitEnv: { STUB_GIT_ANCESTOR: '0' },
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    checkBool('no linked PR/MR + git confirms HEAD is NOT an ancestor is never done-but-open',
      outNotMerged.includes('pre-existing'), false);

    // Review round 3, item 3: ancestor + a postdating HEAD commit time (the OLD sufficient
    // signal) but an empty reflog (no commit ever made ON this branch) must still refuse —
    // this is the stub-reachable half of the H1 false positive (the other half, actually
    // producing that combination through a real rebase/fast-forward, needs real git; see the
    // dedicated real-git tests below).
    const pNoOwnCommit = realWtDirWithGitMarker('np3', Date.now() - 3_600_000);
    const outNoOwnCommit = await runHeartbeat({
      name: 'no-pr-ancestor-no-own-commit',
      worktrees: [{ path: pNoOwnCommit, displayName: 'np3', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0 }],
      gitEnv: { STUB_GIT_ANCESTOR: '1', STUB_GIT_HEAD_COMMIT_TIME: String(Math.floor(Date.now() / 1000)) },
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    checkBool('H1: ancestor + postdating HEAD commit time but an empty reflog (no own commit) is never done-but-open',
      outNoOwnCommit.includes('pre-existing'), false);
  }

  // 13. A merged PR whose worktree git reports DIRTY (uncommitted changes) is never
  // done-but-open — the clean leg is a real, independent gate, not implied by PR state.
  {
    const out = await runHeartbeat({
      name: 'dirty',
      worktrees: [{ path: realWtDir('dirty'), displayName: 'dirty', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedPR: { state: 'merged', number: 30 } }],
      gitEnv: { STUB_GIT_CLEAN: '0' },
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    checkBool('a merged PR with an uncommitted-changes worktree is never done-but-open',
      out.includes('pre-existing'), false);
  }

  // 14. Item M4: `worktree ps` answering `{ ok: false }` must be treated exactly like an
  // unreachable Orca (no summary, daemon keeps polling), never like "zero worktrees" — even
  // though a worktree that would obviously qualify is sitting right there in the stub's data.
  {
    const out = await runHeartbeat({
      name: 'm4-ok-false',
      worktrees: [{ path: realWtDir('m4a'), displayName: 'm4a', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedPR: { state: 'merged', number: 40 } }],
      envOverrides: { STUB_WORKTREES_OK_FALSE: '1' },
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    checkBool('an `ok:false` worktree-ps reply never produces a startup summary', out.includes('pre-existing'), false);
    checkBool('an `ok:false` worktree-ps reply never crashes the daemon',
      out.includes('orca-heartbeat: Orca is not answering'), false);
  }

  // 15. Item M4: a reply that never seeded a `worktrees` array at all (e.g. `result: {}`)
  // must degrade the same way — never silently read as an empty, all-clear list.
  {
    const out = await runHeartbeat({
      name: 'm4-no-array',
      worktrees: [{ path: realWtDir('m4b'), displayName: 'm4b', isMainWorktree: false, isArchived: false,
        liveTerminalCount: 0, linkedPR: { state: 'merged', number: 41 } }],
      envOverrides: { STUB_WORKTREES_NO_ARRAY: '1' },
      args: ['--interval', '1', '--idle', '60', '--max', '1'],
    });
    checkBool('a reply with no `worktrees` array never produces a startup summary', out.includes('pre-existing'), false);
    checkBool('a reply with no `worktrees` array never crashes the daemon',
      out.includes('orca-heartbeat: Orca is not answering'), false);
  }

  // 16. Review round 3, item 4: the FIRST (seeding) pass must never be truncated by the
  // GIT_BUDGET_MS cap. Before this fix, a row the seeding pass could not reach in time was
  // simply left out of both `reportedDoneWorktrees` and the startup summary — on a LATER tick,
  // the steady-state branch would then evaluate it, find it done, and fire it as a genuine
  // wake event, even though it had been part of the original backlog all along. `ORCH_GIT_BUDGET_MS`
  // + `STUB_GIT_DELAY_MS` shrink the budget and slow the git stub enough to make a single tick's
  // naive git-call total exceed the budget with only a few worktrees, without needing a real
  // 10s wait.
  {
    const worktrees = Array.from({ length: 5 }, (_, i) => ({
      path: realWtDir(`gb${i}`), displayName: `gb${i}`, isMainWorktree: false, isArchived: false,
      liveTerminalCount: 0, linkedPR: { state: 'merged', number: 100 + i },
    }));
    const out = await runHeartbeat({
      name: 'git-budget-seeding',
      worktrees,
      gitEnv: { STUB_GIT_DELAY_MS: '60' },
      envOverrides: { ORCH_GIT_BUDGET_MS: '100' },
      args: ['--interval', '1', '--idle', '60', '--max', '3'],
    });
    for (const w of worktrees) {
      checkBool(`item 4: ${w.displayName} appears in the one-time startup summary despite the tight git budget`,
        out.includes(`${w.displayName} (${w.path})`), true);
    }
    checkBool('item 4: no worktree the budget-constrained seeding pass could not reach in one tick fires as a later wake event',
      out.includes('DONE worktree'), false);
  }

  // Released-group settle: the gate's session state still shows the group `live` (its
  // release reply was non-ok, so nothing ever settled it) but Orca's worker-list — which
  // the heartbeat already polls every tick — reports it released. The tick must settle the
  // whole group and persist it, or the dead group keeps holding its Owns: claim forever.
  {
    const name = 'released-group-settle';
    const started = Date.now();
    const seedState = { workers: {
      ctx_hb_released: { role: 'claude-exec', status: 'live', group: 'ctx_hb_released',
        started, agent: 'claude', owns: ['src/hb-released/**'], ws: 'ws-hb-released' },
      task_hb_released: { role: 'claude-exec', status: 'live', group: 'ctx_hb_released',
        started, agent: 'claude' },
    } };
    await runHeartbeat({
      name, worktrees: [], seedState, terminalRows: [],
      workerRows: [{ dispatchId: 'ctx_hb_released', taskId: 'task_hb_released', runId: 'run_hb_released',
        workerState: 'stopped', dispatchStatus: 'failed', agentTerminalHandle: 'term_hb_released',
        terminalState: 'released',
        resource: { id: 'wtr_hb_released', ownershipState: 'owned', releaseState: 'not_requested' },
        projection: { id: 'ctx_hb_released', stage: { worker: 'stopped', dispatch: 'failed' },
          outcome: 'failed', liveness: { verdict: 'dead', observedAt: started, source: 'agent_status' },
          resource: { state: 'released' } } }],
      args: ['--interval', '1', '--idle', '60', '--max', '2'],
    });
    let st = null;
    try {
      st = JSON.parse(fs.readFileSync(
        path.join(RUN_DIR, `hb-${name}`, `hb-${name}-${process.pid}.json`), 'utf8'));
    } catch {}
    checkBool('heartbeat tick settles (and persists) a group Orca reports released',
      !!st && st.workers.ctx_hb_released && st.workers.ctx_hb_released.status === 'settled' &&
        st.workers.task_hb_released.status === 'settled', true);
  }

  // Partial-release guard: a group whose worker-list rows are NOT all released (one released
  // old dispatch row, one still-live row — e.g. a --retry-of / re-dispatched task whose new
  // row shares the task id) must NOT be settled: the live row is decisive. The old code kept
  // one row per id (an older row could overwrite a newer one) and settled on ANY released row.
  {
    const name = 'released-group-partial';
    const started = Date.now();
    const seedState = { workers: {
      ctx_hb_retry: { role: 'claude-exec', status: 'live', group: 'ctx_hb_retry',
        started, agent: 'claude', owns: ['src/hb-retry/**'], ws: 'ws-hb-retry' },
      task_hb_retry: { role: 'claude-exec', status: 'live', group: 'ctx_hb_retry',
        started, agent: 'claude' },
    } };
    await runHeartbeat({
      name, worktrees: [], seedState, terminalRows: [],
      workerRows: [
        // Newest first: the re-dispatch's own row is LIVE and shares the task id.
        { dispatchId: 'ctx_hb_retry', taskId: 'task_hb_retry', runId: 'run_hb_retry_2',
          workerState: 'running', dispatchStatus: 'running', agentTerminalHandle: 'term_hb_retry_2',
          terminalState: 'active',
          resource: { id: 'wtr_hb_retry', ownershipState: 'owned', releaseState: 'not_requested' },
          projection: { id: 'ctx_hb_retry', stage: { worker: 'running', dispatch: 'running' },
            liveness: { verdict: 'alive', observedAt: started, source: 'agent_status' },
            resource: { state: 'active' } } },
        // The older, original dispatch row of the same group: released.
        { dispatchId: 'ctx_hb_retry_old', taskId: 'task_hb_retry', runId: 'run_hb_retry_1',
          workerState: 'stopped', dispatchStatus: 'failed', agentTerminalHandle: 'term_hb_retry_1',
          terminalState: 'released',
          resource: { id: 'wtr_hb_retry', ownershipState: 'owned', releaseState: 'not_requested' },
          projection: { id: 'ctx_hb_retry_old', stage: { worker: 'stopped', dispatch: 'failed' },
            outcome: 'failed', liveness: { verdict: 'dead', observedAt: started, source: 'agent_status' },
            resource: { state: 'released' } } },
      ],
      args: ['--interval', '1', '--idle', '60', '--max', '2'],
    });
    let st = null;
    try {
      st = JSON.parse(fs.readFileSync(
        path.join(RUN_DIR, `hb-${name}`, `hb-${name}-${process.pid}.json`), 'utf8'));
    } catch {}
    checkBool('heartbeat tick must NOT settle a group while any of its rows is still live',
      !!st && st.workers.ctx_hb_retry && st.workers.ctx_hb_retry.status === 'live' &&
        st.workers.task_hb_retry.status === 'live', true);
  }
}

// --- H1 (real git, no stub): a fresh worktree with zero new commits must never be reported
// done-but-open, even though it is trivially "an ancestor of base" and "clean"; a worktree
// with a REAL new commit that is genuinely merged into origin/main must be reported. Uses a
// real bare "origin" repo + a real clone + real linked worktrees (per the reviewer's own
// repro note: "probe with a REAL fresh worktree ... trivially ancestor+clean; stub-only tests
// miss it") — `ORCH_GIT_BIN` is pointed at the real `git` binary for this suite only.
function sh(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`\`${cmd} ${args.join(' ')}\` failed in ${cwd}: ${r.stderr}`);
  return r.stdout;
}

const REAL_GIT_ENV = {
  GIT_AUTHOR_NAME: 'h1-test', GIT_AUTHOR_EMAIL: 'h1-test@example.invalid',
  GIT_COMMITTER_NAME: 'h1-test', GIT_COMMITTER_EMAIL: 'h1-test@example.invalid',
};

/** A real bare "origin" repo (branch `main`, one seed commit) plus a real non-bare clone to
 * branch linked worktrees off. */
function setupRealGitOrigin(label) {
  const root = path.join(RUN_DIR, `real-git-${label}`);
  fs.mkdirSync(root, { recursive: true });
  const originDir = path.join(root, 'origin.git');
  const repoDir = path.join(root, 'repo');
  sh('git', ['init', '--quiet', '--bare', '-b', 'main', originDir], root);
  sh('git', ['clone', '--quiet', originDir, repoDir], root);
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'seed\n');
  sh('git', ['add', 'README.md'], repoDir, REAL_GIT_ENV);
  sh('git', ['commit', '--quiet', '-m', 'seed'], repoDir, REAL_GIT_ENV);
  sh('git', ['push', '--quiet', 'origin', 'main'], repoDir, REAL_GIT_ENV);
  return { root, originDir, repoDir };
}

/** A fresh linked worktree branched off `origin/main`, with its `.git` marker file's mtime
 * force-set to `gitMtimeMs` — sidesteps real-clock jitter/resolution entirely: H1's own
 * discriminator is exactly this timestamp vs. HEAD's real commit time. */
function addRealWorktree({ repoDir }, branch, gitMtimeMs) {
  const wtPath = path.join(path.dirname(repoDir), `wt-${branch}`);
  sh('git', ['worktree', 'add', '--quiet', '-b', branch, wtPath, 'origin/main'], repoDir, REAL_GIT_ENV);
  const marker = path.join(wtPath, '.git');
  const t = gitMtimeMs / 1000;
  fs.utimesSync(marker, t, t);
  return wtPath;
}

async function heartbeatH1RealGitTests() {
  const origin = setupRealGitOrigin('h1');
  const now = Date.now();

  // Negative: zero new commits. Forcing the `.git` marker's mtime an hour into the FUTURE
  // relative to the (real, wall-clock) seed commit means this worktree is unambiguously
  // "created after its own HEAD commit" regardless of how fast or slow this machine is —
  // i.e. it never advanced past what it started from.
  const freshPath = addRealWorktree(origin, 'fresh', now + 3_600_000);
  const outFresh = await runHeartbeat({
    name: 'h1-fresh-worktree',
    dirName: 'hb-h1-fresh',
    worktrees: [{ path: freshPath, displayName: 'fresh', isMainWorktree: false, isArchived: false, liveTerminalCount: 0 }],
    envOverrides: { ORCH_GIT_BIN: 'git' },
    args: ['--interval', '1', '--idle', '60', '--max', '1'],
  });
  checkBool('H1 (real git): a fresh worktree with zero new commits is never reported done-but-open',
    outFresh.includes('pre-existing') || outFresh.includes('DONE worktree'), false);

  // Negative (review round 3, item 3 — the H1 false positive this fixes): the worktree
  // branches off origin/main, origin/main THEN advances with a REAL commit made directly on
  // origin (not on the worktree), and the worktree is fast-forwarded onto that advanced
  // origin/main WITHOUT ever gaining a commit of its own. The `.git` marker is forced an hour
  // into the past, so HEAD's real commit time genuinely postdates it — the OLD heuristic alone
  // (`hasProducedMergedWork`) reads exactly this as "done"; `hasOwnCommit` (an empty reflog on
  // this worktree's own branch) must still refuse it.
  const rebasedPath = addRealWorktree(origin, 'rebased', now - 3_600_000);
  fs.writeFileSync(path.join(origin.repoDir, 'advance.txt'), 'base advanced\n');
  sh('git', ['add', 'advance.txt'], origin.repoDir, REAL_GIT_ENV);
  sh('git', ['commit', '--quiet', '-m', 'advance base'], origin.repoDir, REAL_GIT_ENV);
  sh('git', ['push', '--quiet', 'origin', 'main'], origin.repoDir, REAL_GIT_ENV);
  sh('git', ['fetch', '--quiet', 'origin'], rebasedPath, REAL_GIT_ENV);
  sh('git', ['merge', '--quiet', '--ff-only', 'origin/main'], rebasedPath, REAL_GIT_ENV);
  const outRebased = await runHeartbeat({
    name: 'h1-rebased-no-own-commit',
    dirName: 'hb-h1-rebased',
    worktrees: [{ path: rebasedPath, displayName: 'rebased', isMainWorktree: false, isArchived: false, liveTerminalCount: 0 }],
    envOverrides: { ORCH_GIT_BIN: 'git' },
    args: ['--interval', '1', '--idle', '60', '--max', '1'],
  });
  checkBool('H1 (real git): a worktree rebased/fast-forwarded onto a moved base with no commits of its own is never reported done-but-open (the false-positive case)',
    outRebased.includes('pre-existing') || outRebased.includes('DONE worktree'), false);

  // Positive: a REAL new commit, force-pushed onto the bare origin's `main` and fetched back,
  // so `origin/main` genuinely contains it. The `.git` marker's mtime is forced an hour into
  // the PAST relative to that (real, wall-clock) commit.
  const mergedPath = addRealWorktree(origin, 'merged', now - 3_600_000);
  fs.writeFileSync(path.join(mergedPath, 'feature.txt'), 'real work\n');
  sh('git', ['add', 'feature.txt'], mergedPath, REAL_GIT_ENV);
  sh('git', ['commit', '--quiet', '-m', 'real work'], mergedPath, REAL_GIT_ENV);
  sh('git', ['push', '--quiet', 'origin', 'merged:main'], mergedPath, REAL_GIT_ENV);
  sh('git', ['fetch', '--quiet', 'origin'], mergedPath, REAL_GIT_ENV);
  const outMerged = await runHeartbeat({
    name: 'h1-merged-worktree',
    dirName: 'hb-h1-merged',
    worktrees: [{ path: mergedPath, displayName: 'merged', isMainWorktree: false, isArchived: false, liveTerminalCount: 0 }],
    envOverrides: { ORCH_GIT_BIN: 'git' },
    args: ['--interval', '1', '--idle', '60', '--max', '1'],
  });
  checkBool('H1 (real git): a worktree with a real commit genuinely merged into origin/main is reported done-but-open',
    outMerged.includes(`pre-existing done-but-open worktree(s) at startup: merged (${mergedPath})`), true);
}

// --- pending-placeholder leak fixes (2026-10-01) -----------------------------
// 1. A piped worker-start whose JSON reply is unparseable still registers the real id when
//    the output carries exactly one "dispatchId" line; 2. a live pending placeholder is
//    adopted by the once-a-minute gate-event reconcile against orca worker-list; 3. an
//    unmatched placeholder older than 10 min settles and frees its Owns: claim; 4. a
//    release naming an untracked id settles the one live placeholder it can only mean.
{
  const P_SID = `${SID}-pending-leak`;

  // Fix 1: piped worker-start, single dispatchId in the piped output -> real id registered.
  rmState(P_SID);
  invoke(postBash('orca orchestration worker-start --agent codex --task pl1 --json | grep dispatchId',
    '  "dispatchId": "ctx_piped_1",', { sid: P_SID }), CODEX_WINS);
  {
    const st = readState(P_SID) || { workers: {} };
    const pendings = Object.keys(st.workers).filter((k) => k.startsWith('pending-'));
    if (st.workers.ctx_piped_1 && st.workers.ctx_piped_1.status === 'live' && !pendings.length) pass += 1;
    else failures.push(`piped worker-start with exactly one dispatchId line must register the real id, not a placeholder (${JSON.stringify(st.workers)})`);
  }
  // Wave-0 regression guard: more than one distinct dispatchId in the output is ambiguous —
  // never guess; keep the placeholder, register nothing real.
  rmState(P_SID);
  invoke(postBash('orca orchestration worker-start --agent codex --task pl2 --json | node -e "process.stdin.pipe(process.stdout)"',
    '"dispatchId": "ctx_w0_a"\n"dispatchId": "ctx_w0_b"', { sid: P_SID }), CODEX_WINS);
  {
    const st = readState(P_SID) || { workers: {} };
    const pendings = Object.keys(st.workers).filter((k) => k.startsWith('pending-'));
    if (!st.workers.ctx_w0_a && !st.workers.ctx_w0_b && pendings.length === 1) pass += 1;
    else failures.push(`ambiguous multi-dispatchId piped output must stay a placeholder, never a guessed registration (${JSON.stringify(st.workers)})`);
  }
  // A formatter that RE-EMITS the reply as JSON (| jq ., | tee) leaves exactly one
  // surviving reply — for a single-invocation command it can only be this dispatch's own.
  rmState(P_SID);
  invoke(postBash('orca orchestration worker-start --agent codex --task pl3 --json | jq .',
    '{"ok":true,"result":{"dispatchId":"ctx_jq_1","taskId":"task_jq_1"}}', { sid: P_SID }), CODEX_WINS);
  {
    const st = readState(P_SID) || { workers: {} };
    const pendings = Object.keys(st.workers).filter((k) => k.startsWith('pending-'));
    if (st.workers.ctx_jq_1 && st.workers.ctx_jq_1.status === 'live' && !pendings.length) pass += 1;
    else failures.push(`a piped worker-start whose formatter re-emits its JSON reply must register the real id (${JSON.stringify(st.workers)})`);
  }
  // A raw-mode formatter (| jq -r .result.dispatchId) prints the id bare.
  rmState(P_SID);
  invoke(postBash('orca orchestration worker-start --agent codex --task pl4 --json | jq -r .result.dispatchId',
    'ctx_bare_1\n', { sid: P_SID }), CODEX_WINS);
  {
    const st = readState(P_SID) || { workers: {} };
    const pendings = Object.keys(st.workers).filter((k) => k.startsWith('pending-'));
    if (st.workers.ctx_bare_1 && st.workers.ctx_bare_1.status === 'live' && !pendings.length) pass += 1;
    else failures.push(`a piped worker-start whose formatter prints a bare dispatch id must register it (${JSON.stringify(st.workers)})`);
  }
  // N2: an "ok": false reply piped through jq is still honoured as a failure — nothing is
  // registered, the reservation is dropped; a readiness-timeout failure still registers
  // its retainable dispatch.
  rmState(P_SID);
  const n2cmd = 'orca orchestration worker-start --agent codex --task pln2 --json | jq .';
  invoke(mainBash(n2cmd, { sid: P_SID, tool_use_id: 'toolu_n2_piped' }), CODEX_WINS);
  invoke(postBash(n2cmd, '{"ok":false,"error":"dispatch refused"}', { sid: P_SID, tool_use_id: 'toolu_n2_piped' }), CODEX_WINS);
  {
    const st = readState(P_SID) || { workers: {}, reservations: {} };
    if (!Object.keys(st.workers).length && !Object.keys(st.reservations).length) pass += 1;
    else failures.push(`a piped "ok": false reply must register nothing and drop the reservation (${JSON.stringify({ workers: st.workers, reservations: st.reservations })})`);
  }
  rmState(P_SID);
  invoke(postBash(n2cmd,
    '{"ok":false,"result":{"stage":"agent_readiness","lastError":"timeout","dispatchId":"ctx_rt_piped","agentTerminalHandle":"term_rt_piped"}}',
    { sid: P_SID }), CODEX_WINS);
  {
    const st = readState(P_SID) || { workers: {} };
    if (st.workers.ctx_rt_piped && st.workers.ctx_rt_piped.readinessTimeout === true) pass += 1;
    else failures.push(`a piped readiness-timeout reply must register its retainable dispatch (${JSON.stringify(st.workers)})`);
  }
  // N3: an id already named in the command line (--retry-of) is an input, never the result.
  rmState(P_SID);
  invoke(postBash('orca orchestration worker-start --agent codex --retry-of ctx_OLD42 | tail -2',
    '"retryOf":"ctx_OLD42"', { sid: P_SID }), CODEX_WINS);
  {
    const st = readState(P_SID) || { workers: {} };
    const pendings = Object.keys(st.workers).filter((k) => k.startsWith('pending-'));
    if (!st.workers.ctx_OLD42 && pendings.length === 1) pass += 1;
    else failures.push(`the --retry-of id from the command line must never be registered as the new dispatch (${JSON.stringify(st.workers)})`);
  }
  rmState(P_SID);
  invoke(postBash('orca orchestration worker-start --agent codex --retry-of ctx_OLD42 | tail -2',
    'ctx_OLD42\nctx_NEW42', { sid: P_SID }), CODEX_WINS);
  {
    const st = readState(P_SID) || { workers: {} };
    if (st.workers.ctx_NEW42 && st.workers.ctx_NEW42.status === 'live' && !st.workers.ctx_OLD42) pass += 1;
    else failures.push(`with the command-line id excluded, the one remaining output id is the dispatch (${JSON.stringify(st.workers)})`);
  }

  // Fix 2: a live pending placeholder is adopted by the gate-event reconcile when orca's
  // worker-list has exactly one compatible row, judged on the REAL row shape: agent at
  // projection.provider.id, worktree at resource.worktreeId / projection.workspace.id.
  const rowShape = (overrides = {}) => ({
    dispatchId: 'ctx_adopted_1', taskId: 'task_adopted_1', runId: 'run_adopted_1',
    workerState: 'running', dispatchStatus: 'running',
    agentTerminalHandle: 'term_adopted_1', terminalState: 'active',
    resource: { id: 'wtr_adopted_1', worktreeId: 'wt_adopt' },
    projection: { role: 'worker', provider: { id: 'codex' }, workspace: { id: 'wt_adopt', kind: 'folder_or_worktree' } },
    ...overrides,
  });
  rmState(P_SID);
  const adoptStarted = Date.now();
  fs.writeFileSync(path.join(STATE_DIR, `${P_SID}.json`), JSON.stringify({
    session_id: P_SID, created: new Date().toISOString(), bypass: false, execAgent: null,
    workers: { [`pending-${adoptStarted}-0`]: { role: 'codex-exec', started: adoptStarted, status: 'live',
      last_seen: adoptStarted, rate_limited_until: 0, unverified: true, group: `pending-${adoptStarted}-0`,
      kind: 'worker', agent: 'codex', owns: null, ws: null, worktreeIds: ['wt_adopt'] } },
    reservations: {}, agentClaims: {}, tasks: {}, last_heartbeat: 0, rate_limit_hits: 0,
  }));
  invoke(mainEdit('/work/.claude/hooks/x.cjs', P_SID),
    { ...CODEX_WINS, STUB_WORKERS_JSON: JSON.stringify([rowShape()]) });
  {
    const st = readState(P_SID) || { workers: {} };
    const pendings = Object.keys(st.workers).filter((k) => k.startsWith('pending-'));
    if (st.workers.ctx_adopted_1 && st.workers.ctx_adopted_1.status === 'live' &&
        st.workers.ctx_adopted_1.unverified === false && !pendings.length) pass += 1;
    else failures.push(`the gate-event reconcile must adopt the matching worker-list row in place of the placeholder (${JSON.stringify(st.workers)})`);
  }
  // A worker-list row for a DIFFERENT agent (projection.provider.id) must never be adopted
  // by a codex placeholder; neither must a released terminal or an already-done row.
  for (const [caseName, row] of [
    ['different agent', rowShape({ dispatchId: 'ctx_other_agent', projection: { role: 'worker', provider: { id: 'kimi' } } })],
    ['released terminal', rowShape({ dispatchId: 'ctx_released_row', terminalState: 'released' })],
    ['done row', rowShape({ dispatchId: 'ctx_done_row', workerState: 'succeeded' })],
  ]) {
    rmState(P_SID);
    const mmStarted = Date.now();
    fs.writeFileSync(path.join(STATE_DIR, `${P_SID}.json`), JSON.stringify({
      session_id: P_SID, created: new Date().toISOString(), bypass: false, execAgent: null,
      workers: { [`pending-${mmStarted}-0`]: { role: 'codex-exec', started: mmStarted, status: 'live',
        last_seen: mmStarted, rate_limited_until: 0, unverified: true, group: `pending-${mmStarted}-0`,
        kind: 'worker', agent: 'codex', owns: null, ws: null } },
      reservations: {}, agentClaims: {}, tasks: {}, last_heartbeat: 0, rate_limit_hits: 0,
    }));
    invoke(mainEdit('/work/.claude/hooks/x.cjs', P_SID),
      { ...CODEX_WINS, STUB_WORKERS_JSON: JSON.stringify([row]) });
    {
      const st = readState(P_SID) || { workers: {} };
      const realKeys = Object.keys(st.workers).filter((k) => !k.startsWith('pending-'));
      if (!realKeys.length && st.workers[`pending-${mmStarted}-0`] &&
          st.workers[`pending-${mmStarted}-0`].status === 'live') pass += 1;
      else failures.push(`a placeholder must never adopt a ${caseName} row (${JSON.stringify(st.workers)})`);
    }
  }

  // Fix 3: an unmatched placeholder older than 10 min settles on the gate-event reconcile,
  // freeing its Owns: claim so an overlapping dispatch is admitted again.
  const OWN_LIB = require('../hooks/lib/ownership.cjs');
  const leakWs = OWN_LIB.workspaceKey({ repoRootDir: OWN_LIB.repoRoot(FAKE_REPO), worktreeValue: null, isolated: false });
  rmState(P_SID);
  const staleStarted = Date.now() - 11 * 60 * 1000;
  fs.writeFileSync(path.join(STATE_DIR, `${P_SID}.json`), JSON.stringify({
    session_id: P_SID, created: new Date().toISOString(), bypass: false, execAgent: null,
    workers: { [`pending-${staleStarted}-0`]: { role: 'codex-exec', started: staleStarted, status: 'live',
      last_seen: staleStarted, rate_limited_until: 0, unverified: true, group: `pending-${staleStarted}-0`,
      kind: 'worker', agent: 'codex', owns: ['src/ttl/**'], ws: leakWs } },
    reservations: {}, agentClaims: {}, tasks: {}, last_heartbeat: 0, rate_limit_hits: 0,
  }));
  const ttlSpec = 'Implement the ttl fix. Verify: npm test\nOwns: src/ttl/**';
  const rTtl = invoke(mainBash(`orca orchestration worker-start --agent codex --spec "${ttlSpec}" --json`,
    { sid: P_SID, cwd: FAKE_REPO }), { ...CODEX_WINS, STUB_WORKERS_JSON: '[]' });
  {
    const st = readState(P_SID) || { workers: {} };
    if (rTtl.code === ALLOW && st.workers[`pending-${staleStarted}-0`] &&
        st.workers[`pending-${staleStarted}-0`].status === 'settled') pass += 1;
    else failures.push(`an expired placeholder must settle and free its Owns: claim for the overlapping dispatch (exit ${rTtl.code}, workers ${JSON.stringify(st.workers)})`);
  }

  // Fix 4: releasing an id this session never tracked settles the ONE live placeholder it
  // can only refer to — provided the placeholder is at least a few seconds old and, when
  // Orca lists the release target, of the same agent (projection.provider.id). With two
  // live placeholders, a too-fresh one, or an agent mismatch, nothing moves.
  rmState(P_SID);
  const relStarted = Date.now() - 10000;
  fs.writeFileSync(path.join(STATE_DIR, `${P_SID}.json`), JSON.stringify({
    session_id: P_SID, created: new Date().toISOString(), bypass: false, execAgent: null,
    workers: { [`pending-${relStarted}-0`]: { role: 'codex-exec', started: relStarted, status: 'live',
      last_seen: relStarted, rate_limited_until: 0, unverified: true, group: `pending-${relStarted}-0`,
      kind: 'worker', agent: 'codex', owns: null, ws: null } },
    reservations: {}, agentClaims: {}, tasks: {}, last_heartbeat: 0, rate_limit_hits: 0,
  }));
  invoke(postBash('orca orchestration worker-release --dispatch ctx_never_tracked --json', '{"ok":true}', { sid: P_SID }), CODEX_WINS);
  {
    const st = readState(P_SID) || { workers: {} };
    if (st.workers[`pending-${relStarted}-0`] && st.workers[`pending-${relStarted}-0`].status === 'settled') pass += 1;
    else failures.push(`releasing an untracked id must settle the single live placeholder it can only mean (${JSON.stringify(st.workers)})`);
  }
  // Same, with Orca confirming the released target IS a codex worker (nested row shape).
  rmState(P_SID);
  fs.writeFileSync(path.join(STATE_DIR, `${P_SID}.json`), JSON.stringify({
    session_id: P_SID, created: new Date().toISOString(), bypass: false, execAgent: null,
    workers: { [`pending-${relStarted}-0`]: { role: 'codex-exec', started: relStarted, status: 'live',
      last_seen: relStarted, rate_limited_until: 0, unverified: true, group: `pending-${relStarted}-0`,
      kind: 'worker', agent: 'codex', owns: null, ws: null } },
    reservations: {}, agentClaims: {}, tasks: {}, last_heartbeat: 0, rate_limit_hits: 0,
  }));
  invoke(postBash('orca orchestration worker-release --dispatch ctx_never_tracked --json', '{"ok":true}', { sid: P_SID }),
    { ...CODEX_WINS, STUB_WORKERS_JSON: JSON.stringify([rowShape({ dispatchId: 'ctx_never_tracked' })]) });
  {
    const st = readState(P_SID) || { workers: {} };
    if (st.workers[`pending-${relStarted}-0`] && st.workers[`pending-${relStarted}-0`].status === 'settled') pass += 1;
    else failures.push(`a matching-agent release target must still settle the placeholder (${JSON.stringify(st.workers)})`);
  }
  // Agent mismatch: the released target is a KIMI worker — the codex placeholder is some
  // other, still-running dispatch and must NOT be settled.
  rmState(P_SID);
  fs.writeFileSync(path.join(STATE_DIR, `${P_SID}.json`), JSON.stringify({
    session_id: P_SID, created: new Date().toISOString(), bypass: false, execAgent: null,
    workers: { [`pending-${relStarted}-0`]: { role: 'codex-exec', started: relStarted, status: 'live',
      last_seen: relStarted, rate_limited_until: 0, unverified: true, group: `pending-${relStarted}-0`,
      kind: 'worker', agent: 'codex', owns: null, ws: null } },
    reservations: {}, agentClaims: {}, tasks: {}, last_heartbeat: 0, rate_limit_hits: 0,
  }));
  invoke(postBash('orca orchestration worker-release --dispatch ctx_never_tracked --json', '{"ok":true}', { sid: P_SID }),
    { ...CODEX_WINS, STUB_WORKERS_JSON: JSON.stringify([
      rowShape({ dispatchId: 'ctx_never_tracked', projection: { role: 'worker', provider: { id: 'kimi' } } }),
    ]) });
  {
    const st = readState(P_SID) || { workers: {} };
    if (st.workers[`pending-${relStarted}-0`] && st.workers[`pending-${relStarted}-0`].status === 'live') pass += 1;
    else failures.push(`an agent-mismatched release target must not settle the placeholder (${JSON.stringify(st.workers)})`);
  }
  // A placeholder only seconds old is too fresh to identify with the release target.
  rmState(P_SID);
  const freshStarted = Date.now();
  fs.writeFileSync(path.join(STATE_DIR, `${P_SID}.json`), JSON.stringify({
    session_id: P_SID, created: new Date().toISOString(), bypass: false, execAgent: null,
    workers: { [`pending-${freshStarted}-0`]: { role: 'codex-exec', started: freshStarted, status: 'live',
      last_seen: freshStarted, rate_limited_until: 0, unverified: true, group: `pending-${freshStarted}-0`,
      kind: 'worker', agent: 'codex', owns: null, ws: null } },
    reservations: {}, agentClaims: {}, tasks: {}, last_heartbeat: 0, rate_limit_hits: 0,
  }));
  invoke(postBash('orca orchestration worker-release --dispatch ctx_never_tracked --json', '{"ok":true}', { sid: P_SID }), CODEX_WINS);
  {
    const st = readState(P_SID) || { workers: {} };
    if (st.workers[`pending-${freshStarted}-0`] && st.workers[`pending-${freshStarted}-0`].status === 'live') pass += 1;
    else failures.push(`a seconds-old placeholder must not be settled by an untracked-id release (${JSON.stringify(st.workers)})`);
  }
  rmState(P_SID);
  fs.writeFileSync(path.join(STATE_DIR, `${P_SID}.json`), JSON.stringify({
    session_id: P_SID, created: new Date().toISOString(), bypass: false, execAgent: null,
    workers: {
      'pending-a-0': { role: 'codex-exec', started: Date.now(), status: 'live', last_seen: Date.now(),
        rate_limited_until: 0, unverified: true, group: 'pending-a-0', kind: 'worker', agent: 'codex', owns: null, ws: null },
      'pending-b-1': { role: 'codex-exec', started: Date.now(), status: 'live', last_seen: Date.now(),
        rate_limited_until: 0, unverified: true, group: 'pending-b-1', kind: 'worker', agent: 'codex', owns: null, ws: null },
    },
    reservations: {}, agentClaims: {}, tasks: {}, last_heartbeat: 0, rate_limit_hits: 0,
  }));
  invoke(postBash('orca orchestration worker-release --dispatch ctx_never_tracked --json', '{"ok":true}', { sid: P_SID }), CODEX_WINS);
  {
    const st = readState(P_SID) || { workers: {} };
    if (st.workers['pending-a-0'].status === 'live' && st.workers['pending-b-1'].status === 'live') pass += 1;
    else failures.push(`releasing an untracked id with two live placeholders must settle nothing (${JSON.stringify(st.workers)})`);
  }
  rmState(P_SID);
}

// --- released/stopped worker groups must not keep holding their Owns: claims (2026-10-01) ---
// Workers that were worker-stop + worker-release'd (Orca: workerState stopped, dispatchStatus
// failed, terminalState released) stayed `live` in gate state forever — the release replies
// were non-ok, so nothing settled the group — and every later dispatch overlapping their
// Owns: globs was refused. Fixes: the ownership-overlap path reconciles the HOLDER groups
// against a fresh worker-list before refusing; a failed stop/release/abandon reply whose
// text shows the worker already stopped still settles the group; the heartbeat settles
// released groups it already lists (heartbeat case further down).
{
  const REL_ENV = quotaEnv('released-holders', 10, 30, {});
  // The REAL worker-list row shape (captured live 2026-10-01): top-level
  // dispatchId/taskId/workerState/dispatchStatus/terminalState plus nested resource/projection.
  const realRow = (overrides = {}) => ({
    dispatchId: 'ctx_rel_a', taskId: 'task_rel_a', runId: 'run_rel_a',
    workerState: 'stopped', dispatchStatus: 'failed',
    agentTerminalHandle: 'term_rel_a', terminalState: 'released',
    resource: { id: 'wtr_rel_a', ownershipState: 'owned', releaseState: 'not_requested',
      releaseRequestedAt: null, releaseCompletedAt: null, releaseError: null },
    projection: { id: 'ctx_rel_a', dispatchId: 'ctx_rel_a', taskId: 'task_rel_a',
      stage: { worker: 'stopped', dispatch: 'failed', detail: 'stopped', activity: 'idle' },
      outcome: 'failed', liveness: { verdict: 'dead', observedAt: Date.now(), source: 'agent_status' },
      resource: { state: 'released' } },
    ...overrides,
  });
  const OWN_LIB_REL = require('../hooks/lib/ownership.cjs');
  const REL_WS = OWN_LIB_REL.workspaceKey({
    repoRootDir: OWN_LIB_REL.repoRoot(FAKE_REPO), worktreeValue: null, isolated: false,
  });
  const seedHolder = (sid, id, started) => {
    fs.writeFileSync(path.join(STATE_DIR, `${sid}.json`), JSON.stringify({
      session_id: sid, created: new Date().toISOString(), bypass: false, execAgent: null,
      workers: {
        [`ctx_${id}`]: { role: 'claude-exec', started, status: 'live', last_seen: started,
          rate_limited_until: 0, group: `ctx_${id}`, kind: 'worker', agent: 'claude',
          owns: ['src/released/**'], ws: REL_WS },
        [`task_${id}`]: { role: 'claude-exec', started, status: 'live', last_seen: started,
          rate_limited_until: 0, group: `ctx_${id}`, kind: 'worker', agent: 'claude',
          owns: ['src/released/**'], ws: REL_WS },
      },
      reservations: {}, agentClaims: {}, tasks: {}, last_heartbeat: 0, rate_limit_hits: 0,
    }));
  };
  let relTuCounter = 0;
  const overlapAttempt = (sid) => mainBash(
    'orca orchestration worker-start --agent codex --spec "Implement the overlap. Verify: npm test\nOwns: src/released/**" --json',
    { sid, cwd: FAKE_REPO, tool_use_id: `toolu_rel_new_${relTuCounter++}` });

  // 1a. Every worker-list row of the holder reports stopped/failed + terminal released (the
  //     exact state from the bug report) -> the group settles and the overlap is admitted.
  {
    const sid = `${SID}-rel-rows`;
    rmState(sid);
    seedHolder(sid, 'rel_a', Date.now());
    const r = invoke(overlapAttempt(sid), { ...REL_ENV, STUB_WORKERS_JSON: JSON.stringify([realRow()]) });
    const st = readState(sid) || { workers: {} };
    if (r.code === ALLOW && st.workers.ctx_rel_a && st.workers.ctx_rel_a.status === 'settled' &&
        st.workers.task_rel_a.status === 'settled') pass += 1;
    else failures.push(`overlap reconcile: a holder whose rows all report released must settle and admit the dispatch (exit ${r.code}, ${JSON.stringify(st.workers)})`);
    rmState(sid);
  }
  // 1b. Holder absent from a real reply but only seconds old (Orca may not have listed a
  //     recent dispatch yet) -> not settled, refusal stands.
  {
    const sid = `${SID}-rel-young`;
    rmState(sid);
    seedHolder(sid, 'rel_young', Date.now());
    const r = invoke(overlapAttempt(sid), { ...REL_ENV, STUB_WORKERS_JSON: '[]' });
    const st = readState(sid) || { workers: {} };
    if (r.code === DENY && st.workers.ctx_rel_young && st.workers.ctx_rel_young.status === 'live') pass += 1;
    else failures.push(`overlap reconcile: a fresh holder absent from the list must not settle (exit ${r.code}, ${JSON.stringify(st.workers)})`);
    rmState(sid);
  }
  // 1c. Holder absent from a real reply and older than 10 minutes -> settled, admitted.
  {
    const sid = `${SID}-rel-stale`;
    rmState(sid);
    seedHolder(sid, 'rel_stale', Date.now() - 11 * 60 * 1000);
    const r = invoke(overlapAttempt(sid), { ...REL_ENV, STUB_WORKERS_JSON: '[]' });
    const st = readState(sid) || { workers: {} };
    if (r.code === ALLOW && st.workers.ctx_rel_stale && st.workers.ctx_rel_stale.status === 'settled') pass += 1;
    else failures.push(`overlap reconcile: a holder absent from the list for >10min must settle (exit ${r.code}, ${JSON.stringify(st.workers)})`);
    rmState(sid);
  }
  // 1d. An INCOMPLETE reply (page.hasMore with no cursor to follow) is not the whole worker
  //     list: the absent-settle leg must switch off — nothing settles, refusal stands.
  {
    const sid = `${SID}-rel-trunc`;
    rmState(sid);
    seedHolder(sid, 'rel_trunc', Date.now() - 11 * 60 * 1000);
    const r = invoke(overlapAttempt(sid), { ...REL_ENV, STUB_WORKERS_JSON: '[]', STUB_WORKERS_PAGE_HAS_MORE: '1' });
    const st = readState(sid) || { workers: {} };
    if (r.code === DENY && st.workers.ctx_rel_trunc && st.workers.ctx_rel_trunc.status === 'live') pass += 1;
    else failures.push(`overlap reconcile: an incomplete (hasMore) worker-list must disable the absent-settle leg (exit ${r.code}, ${JSON.stringify(st.workers)})`);
    rmState(sid);
  }
  // 1d2. A paged reply whose later pages ARE followed (page 1 hasMore + nextCursor, the
  //      released row sits on page 2) is exhaustive again: the holder settles, admitted.
  {
    const sid = `${SID}-rel-cursor`;
    rmState(sid);
    seedHolder(sid, 'rel_cursor', Date.now());
    const r = invoke(overlapAttempt(sid), { ...REL_ENV,
      STUB_WORKERS_JSON: '[]', STUB_WORKERS_PAGE_CURSOR: '1',
      STUB_WORKERS_PAGE2_JSON: JSON.stringify([
        realRow({ dispatchId: 'ctx_rel_cursor', taskId: 'task_rel_cursor' }),
      ]) });
    const st = readState(sid) || { workers: {} };
    if (r.code === ALLOW && st.workers.ctx_rel_cursor && st.workers.ctx_rel_cursor.status === 'settled') pass += 1;
    else failures.push(`overlap reconcile: a released row on a followed --cursor page must settle the holder (exit ${r.code}, ${JSON.stringify(st.workers)})`);
    rmState(sid);
  }
  // 1d3. The reconcile must touch ONLY the holder groups whose claims actually overlap this
  //      dispatch in THIS workspace: an unrelated group (different Owns, absent from the
  //      list, >10min old) riding the same conflict check must stay live.
  {
    const sid = `${SID}-rel-unrelated`;
    rmState(sid);
    seedHolder(sid, 'rel_a', Date.now());
    const st0 = readState(sid);
    const unrelatedStarted = Date.now() - 11 * 60 * 1000;
    for (const id of ['ctx_unrel', 'task_unrel']) {
      st0.workers[id] = { role: 'claude-exec', started: unrelatedStarted, status: 'live',
        last_seen: unrelatedStarted, rate_limited_until: 0, group: 'ctx_unrel', kind: 'worker',
        agent: 'claude', owns: ['src/unrelated/**'], ws: REL_WS };
    }
    fs.writeFileSync(path.join(STATE_DIR, `${sid}.json`), JSON.stringify(st0));
    const r = invoke(overlapAttempt(sid), { ...REL_ENV, STUB_WORKERS_JSON: JSON.stringify([realRow()]) });
    const st = readState(sid) || { workers: {} };
    if (r.code === ALLOW && st.workers.ctx_rel_a && st.workers.ctx_rel_a.status === 'settled' &&
        st.workers.ctx_unrel && st.workers.ctx_unrel.status === 'live' &&
        st.workers.task_unrel.status === 'live') pass += 1;
    else failures.push(`overlap reconcile: an unrelated non-overlapping group must never be settled by this dispatch's reconcile (exit ${r.code}, ${JSON.stringify(st.workers)})`);
    rmState(sid);
  }
  // 1e. An ok:false reply is not a real worker list either.
  {
    const sid = `${SID}-rel-okfalse`;
    rmState(sid);
    seedHolder(sid, 'rel_okfalse', Date.now() - 11 * 60 * 1000);
    const r = invoke(overlapAttempt(sid), { ...REL_ENV, STUB_WORKERS_OK_FALSE: '1' });
    const st = readState(sid) || { workers: {} };
    if (r.code === DENY && st.workers.ctx_rel_okfalse && st.workers.ctx_rel_okfalse.status === 'live') pass += 1;
    else failures.push(`overlap reconcile: an ok:false worker-list must settle nothing (exit ${r.code}, ${JSON.stringify(st.workers)})`);
    rmState(sid);
  }
  // 1f. A holder Orca still shows genuinely live keeps the refusal.
  {
    const sid = `${SID}-rel-live`;
    rmState(sid);
    seedHolder(sid, 'rel_live', Date.now());
    const r = invoke(overlapAttempt(sid), { ...REL_ENV, STUB_WORKERS_JSON: JSON.stringify([
      realRow({ dispatchId: 'ctx_rel_live', taskId: 'task_rel_live', workerState: 'running',
        dispatchStatus: 'running', terminalState: 'active' }),
    ]) });
    const st = readState(sid) || { workers: {} };
    if (r.code === DENY && st.workers.ctx_rel_live && st.workers.ctx_rel_live.status === 'live') pass += 1;
    else failures.push(`overlap reconcile: a holder Orca still shows live must keep the refusal (exit ${r.code}, ${JSON.stringify(st.workers)})`);
    rmState(sid);
  }

  // 2. A failed worker-stop/-release/-abandon reply whose TEXT shows the worker already
  //    stopped/closed settles the group even though the command exit/ok is false.
  {
    const sid = `${SID}-rel-markers`;
    for (const [id, sub, marker] of [
      ['ctx_mark_1', 'worker-stop', 'worker ctx_mark_1 [stopped]'],
      ['ctx_mark_2', 'worker-release', 'release failed: process=closed for ctx_mark_2'],
      ['ctx_mark_3', 'worker-abandon', '{"ok":false,"error":"only a settled worker can release"} terminal [released]'],
    ]) {
      rmState(sid);
      seedHolder(sid, id.replace('ctx_', ''), Date.now());
      invoke({ session_id: sid, hook_event_name: 'PostToolUseFailure', effort: 'high', tool_name: 'Bash',
        tool_input: { command: `orca orchestration ${sub} --dispatch ${id} --json` },
        tool_use_id: `toolu_${id}`, error: marker }, REL_ENV);
      const st = readState(sid) || { workers: {} };
      if (st.workers[id] && st.workers[id].status === 'settled') pass += 1;
      else failures.push(`a failed ${sub} whose reply shows "${marker}" must still settle the group (${JSON.stringify(st.workers)})`);
    }
    // Control: a failed release with no stopped/closed marker settles nothing.
    rmState(sid);
    seedHolder(sid, 'mark_control', Date.now());
    invoke({ session_id: sid, hook_event_name: 'PostToolUseFailure', effort: 'high', tool_name: 'Bash',
      tool_input: { command: 'orca orchestration worker-release --dispatch ctx_mark_control --json' },
      tool_use_id: 'toolu_mark_control',
      error: '{"ok":false,"error":"release_unknown: only a settled worker can release"}' }, REL_ENV);
    {
      const st = readState(sid) || { workers: {} };
      if (st.workers.ctx_mark_control && st.workers.ctx_mark_control.status === 'live') pass += 1;
      else failures.push(`a failed release with no stopped/closed marker must settle nothing (${JSON.stringify(st.workers)})`);
    }
    rmState(sid);
  }
}

heartbeatWorktreeTests()
  .then(() => heartbeatH1RealGitTests())
  .then(() => {
    console.log(`${pass} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  FAIL ${f}`);

    rmState(SID);
    try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch {}
    process.exit(failures.length ? 1 : 0);
  });
