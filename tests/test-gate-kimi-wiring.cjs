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
const KIMI_STUB = path.join(__dirname, 'fixtures', 'kimi-stub.cjs');
for (const file of [ORCA_STUB, CODEX_STUB, KIMI_STUB]) try { fs.chmodSync(file, 0o755); } catch {}

const BASE = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(ORCHESTRATOR_GATE|ORCH_|ORCA_TERMINAL_HANDLE|CODEX_HOME|CLAUDE_CODE_|STUB_CODEX_)/.test(key)));
let passed = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
function ok(name, value) { check(name, !!value, true); }

function fixture(name, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gate-kimi-${name}-`));
  const stateDir = path.join(root, 'state');
  const kimiHome = path.join(root, 'kimi-home');
  fs.mkdirSync(path.join(kimiHome, 'credentials'), { recursive: true });
  if (options.kimi !== false) {
    fs.writeFileSync(path.join(kimiHome, 'credentials', 'kimi-code.json'), JSON.stringify({
      access_token: 'fixture-token-never-print', expires_at: Date.now() + 3600_000,
    }));
  }
  fs.mkdirSync(stateDir, { recursive: true });
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    activation: 'always', replyLanguage: null,
    models: {
      review: { alias: 'opus', id: 'claude-opus-5-5' },
      escalation: { alias: 'fable', id: null }, code: { alias: 'sonnet', id: null },
      lookup: { alias: 'haiku', id: null }, codex: { alias: null, id: 'gpt-5.6-sol' },
      kimi: { alias: null, id: null },
    },
    codexHandoffUsedPercent: 95, kimiHandoffUsedPercent: 95,
    codexQuotaCacheSeconds: 60, kimiQuotaCacheSeconds: 60, coderAvailabilityCacheSeconds: 600,
    maxParallelCodexWorkers: 0, maxParallelKimiWorkers: 0, maxParallelAgents: 0,
    execFallbackWhenCodexUnavailable: 'sonnet', disabledGates: [],
  }));
  const env = {
    ...BASE, ORCH_STATE_DIR: stateDir, ORCH_CONFIG_PATH: configFile,
    ORCA_BIN: options.orca === false ? path.join(root, 'missing-orca') : ORCA_STUB,
    ORCH_CODEX_BIN: options.codex === false ? path.join(root, 'missing-codex') : CODEX_STUB,
    CODEX_BIN: options.codex === false ? path.join(root, 'missing-codex') : CODEX_STUB,
    ORCH_KIMI_HOME: kimiHome,
    ORCH_KIMI_BIN: options.kimi === false ? path.join(root, 'missing-kimi') : KIMI_STUB,
    ORCH_KIMI_USAGE_URL: 'http://127.0.0.1:9/usages',
  };
  const now = Date.now();
  if (options.codex !== false && options.codexUsed !== null) {
    fs.writeFileSync(path.join(stateDir, 'codex-quota-live.json'), JSON.stringify({
      usedPercent: options.codexUsed ?? 5, resetsAt: Math.floor(now / 1000) + 3600, fetchedAt: now,
    }));
  }
  if (options.kimi !== false) {
    fs.writeFileSync(path.join(stateDir, 'kimi-quota-live.json'), JSON.stringify({
      usedPercent: options.kimiUsed ?? 5, resetsAt: Math.floor(now / 1000) + 3600, fetchedAt: now,
    }));
  }
  return { root, stateDir, env };
}

function gate(env, payload) {
  return spawnSync(process.execPath, [GATE], {
    input: JSON.stringify(payload), encoding: 'utf8', env,
  });
}
function prompt(env, sid, text = 'status') {
  return gate(env, { session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: text });
}
function preBash(env, sid, toolUseId, command) {
  return gate(env, { session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_use_id: toolUseId, tool_input: { command }, cwd: ROOT });
}
function postBash(env, sid, toolUseId, command, stdout) {
  return gate(env, { session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_use_id: toolUseId, tool_input: { command }, tool_response: { stdout, stderr: '' } });
}
function state(stateDir, sid) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, `${sid}.json`), 'utf8'));
}

{
  const f = fixture('split', { codexUsed: 5, kimiUsed: 10 });
  fs.writeFileSync(path.join(f.stateDir, 'other.json'), JSON.stringify({
    session_id: 'other', workers: { ctx_c1: { status: 'live', agent: 'codex', group: 'ctx_c1' } },
  }));
  const out = prompt(f.env, 'split-session').stdout;
  ok('reminder names both peers with machine-wide live counts and next pick',
    /code -> split: Codex \(1 live, 90% headroom\) \+ Kimi \(0 live, 85% headroom\); next -> Kimi/.test(out));
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('none', { codex: false, kimi: false });
  const out = prompt(f.env, 'none-session').stdout;
  ok('neither usable routes to Sonnet with both reasons',
    /code -> Sonnet: Codex not installed, Kimi not installed/.test(out));
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('overrides');
  prompt(f.env, 'override-session', '--code-model kimi:k3');
  check('kimi:<model> persists', state(f.stateDir, 'override-session').execAgent, 'kimi:k3');
  const reminder = prompt(f.env, 'override-session').stdout;
  ok('kimi model preference is described without a model pin', /default_model; Orca cannot pin it/.test(reminder));
  prompt(f.env, 'override-session', '--exec-kimi');
  check('--exec-kimi persists kimi', state(f.stateDir, 'override-session').execAgent, 'kimi');
  prompt(f.env, 'override-session', '--code-model opus');
  ok('Claude model overrides name the selected model in reminders',
    /code -> in-session subagent \(Agent model "opus"/.test(prompt(f.env, 'override-session').stdout));
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('register');
  const sid = 'register-session';
  const command = 'orca orchestration worker-start --agent kimi --model k3 --json';
  const advised = preBash(f.env, sid, 'toolu_kimi', command);
  ok('kimi --model is warned but not refused', advised.status === 0 && /drop --model for --agent kimi/.test(advised.stdout));
  postBash(f.env, sid, 'toolu_kimi', command,
    '{"ok":true,"result":{"dispatchId":"ctx_kimi_owned","taskId":"task_kimi_owned","agentTerminalHandle":"term_kimi_owned"}}');
  const s = state(f.stateDir, sid);
  check('kimi worker role follows its agent', s.workers.ctx_kimi_owned.role, 'kimi-exec');
  check('machine-wide lastCoder records registered Kimi',
    JSON.parse(fs.readFileSync(path.join(f.stateDir, 'coder-route-state.json'), 'utf8')).lastCoder, 'kimi');
  fs.unlinkSync(path.join(f.stateDir, `${sid}.json`));
  ok('automatic tie-breaking reads machine-wide lastCoder and alternates away from Kimi',
    /next -> Codex/.test(prompt(f.env, 'after-kimi-session').stdout));
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('brief-gates');
  const noVerify = preBash(f.env, 'brief-session', 'toolu_no_verify',
    'orca orchestration worker-start --agent kimi --spec "implement the feature" --json');
  check('Kimi code briefs must include a verify command', noVerify.status, 2);
  const noOwns = preBash(f.env, 'brief-session', 'toolu_no_owns',
    'orca orchestration worker-start --agent kimi --spec "implement the feature. Verify: npm test." --json');
  check('Kimi code briefs in the current workspace must include Owns', noOwns.status, 2);
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('reply-scope');
  const sid = 'reply-scope-session';
  const command = 'orca orchestration worker-start --agent codex --json && orca orchestration worker-list | formatter';
  preBash(f.env, sid, 'toolu_reply_scope', command);
  const noise = Array.from({ length: 101 }, (_, i) => `ctx_noise_${i}`).join(' ');
  postBash(f.env, sid, 'toolu_reply_scope', command,
    `{"ok":true,"result":{"dispatchId":"ctx_worker_start_only"}}\nformatted workers: ${noise}`);
  const ids = Object.keys(state(f.stateDir, sid).workers);
  check('worker registration uses only the worker-start JSON reply', ids, ['ctx_worker_start_only']);
  const showSid = 'reply-show-session';
  const showCommand = 'orca orchestration worker-start --agent codex --json && orca orchestration worker-show --dispatch ctx_worker_start_show --json';
  preBash(f.env, showSid, 'toolu_reply_show', showCommand);
  postBash(f.env, showSid, 'toolu_reply_show', showCommand,
    '{"ok":true,"result":{"dispatchId":"ctx_worker_start_show"}}\n{"ok":true,"result":{"dispatchId":"ctx_worker_show_echo","preview":"healthy"}}');
  check('a chained worker-show JSON reply does not displace the worker-start reply',
    Object.keys(state(f.stateDir, showSid).workers), ['ctx_worker_start_show']);
  const formattedSid = 'reply-formatted-session';
  const formattedCommand = 'orca orchestration worker-start --agent kimi --json | formatter && orca orchestration worker-show --dispatch ctx_other --json';
  preBash(f.env, formattedSid, 'toolu_reply_formatted', formattedCommand);
  postBash(f.env, formattedSid, 'toolu_reply_formatted', formattedCommand,
    'Started ctx_own\n{"ok":true,"result":{"dispatchId":"ctx_other","preview":"healthy"}}');
  const formattedWorkers = Object.keys(state(f.stateDir, formattedSid).workers);
  ok('a surviving worker-show reply cannot be stolen as the formatted worker-start reply',
    formattedWorkers.length === 1 && formattedWorkers[0].startsWith('pending-'));
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('logged-out', { codexUsed: null });
  f.env.STUB_CODEX_MODE = 'logged-out';
  const out = prompt(f.env, 'logged-out-session').stdout;
  ok('fresh logged-out Codex flips availability on the same prompt',
    out.includes('Codex not logged in') && /next -> Kimi|code -> Kimi/.test(out));
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('signal');
  const sid = 'signal-session';
  const start = 'orca orchestration worker-start --agent kimi --json';
  preBash(f.env, sid, 'toolu_signal', start);
  postBash(f.env, sid, 'toolu_signal', start, '{"ok":true,"dispatchId":"ctx_kimi_signal"}');
  const signal = "403 You've reached your usage limit for this billing cycle";
  postBash(f.env, sid, 'toolu_read', 'orca orchestration worker-read --dispatch ctx_kimi_signal --json', signal);
  ok('tracked Kimi output writes an exhaustion marker',
    JSON.parse(fs.readFileSync(path.join(f.stateDir, 'coder-exhausted.json'), 'utf8')).kimi);
  fs.unlinkSync(path.join(f.stateDir, 'coder-exhausted.json'));
  postBash(f.env, sid, 'toolu_read_noise',
    'orca orchestration worker-read --dispatch ctx_kimi_signal --json && cat docs/provider-error.log',
    `{"ok":true,"result":{"preview":"healthy"}}\n${signal}`);
  check('non-Orca prose chained after a healthy Kimi JSON reply cannot mark exhaustion',
    fs.existsSync(path.join(f.stateDir, 'coder-exhausted.json')), false);
  postBash(f.env, sid, 'toolu_read_json_noise',
    'orca orchestration worker-read --dispatch ctx_kimi_signal && cat docs/provider-error.json',
    `healthy plaintext worker output\n{"ok":true,"result":{"preview":"${signal}"}}`);
  check('unrelated chained JSON cannot masquerade as the Kimi worker-read reply',
    fs.existsSync(path.join(f.stateDir, 'coder-exhausted.json')), false);
  const codexStart = 'orca orchestration worker-start --agent codex --json';
  preBash(f.env, sid, 'toolu_codex_signal', codexStart);
  postBash(f.env, sid, 'toolu_codex_signal', codexStart, '{"ok":true,"dispatchId":"ctx_codex_signal"}');
  postBash(f.env, sid, 'toolu_codex_read', 'orca orchestration worker-read --dispatch ctx_codex_signal --json', signal);
  check('the same text from a tracked Codex worker does not mark Kimi exhausted',
    fs.existsSync(path.join(f.stateDir, 'coder-exhausted.json')), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

process.stdout.write(`${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.exitCode = 1;
}
