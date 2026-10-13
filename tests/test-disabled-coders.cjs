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

function configFixture(value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disabled-coders-config-'));
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return { root, file };
}

function fixture(name, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `disabled-coders-${name}-`));
  const stateDir = path.join(root, 'state');
  const kimiHome = path.join(root, 'kimi-home');
  fs.mkdirSync(path.join(kimiHome, 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(kimiHome, 'credentials', 'kimi-code.json'), JSON.stringify({
    access_token: 'fixture-token-never-print', expires_at: Date.now() + 3600_000,
  }));
  fs.mkdirSync(stateDir, { recursive: true });
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    activation: 'always', replyLanguage: null,
    models: {
      review: { alias: 'opus', id: 'claude-opus-5-5' },
      escalation: { alias: 'fable', id: null },
      code: { alias: 'sonnet', id: null, effort: 'medium', agentType: 'sonnet-coder' },
      lookup: { alias: 'haiku', id: null }, codex: { alias: null, id: 'gpt-5.6-sol' },
      kimi: { alias: null, id: null }, deepseek: { alias: null, id: null },
    },
    codexHandoffUsedPercent: 95, kimiHandoffUsedPercent: 95, deepseekHandoffUsedPercent: 95,
    codexQuotaCacheSeconds: 60, kimiQuotaCacheSeconds: 60, deepseekQuotaCacheSeconds: 60,
    coderAvailabilityCacheSeconds: 600,
    maxParallelCodexWorkers: 0, maxParallelKimiWorkers: 0, maxParallelDeepseekWorkers: 0,
    maxParallelAgents: 0, execFallbackWhenCodexUnavailable: 'sonnet',
    disabledGates: options.disabledGates || [], disabledCoders: options.disabledCoders || [],
  }));
  const env = {
    ...BASE, ORCH_STATE_DIR: stateDir, ORCH_CONFIG_PATH: configFile,
    ORCA_BIN: ORCA_STUB, ORCH_CODEX_BIN: CODEX_STUB, CODEX_BIN: CODEX_STUB,
    ORCH_KIMI_HOME: kimiHome, ORCH_KIMI_BIN: KIMI_STUB,
    ORCH_KIMI_USAGE_URL: 'http://127.0.0.1:9/usages',
    ORCH_OPENCODE_BIN: path.join(root, 'missing-opencode'),
    ...(options.envExtra || {}),
  };
  fs.writeFileSync(path.join(stateDir, 'codex-quota-live.json'), JSON.stringify({
    usedPercent: 5, resetsAt: Math.floor(Date.now() / 1000) + 3600, fetchedAt: Date.now(),
  }));
  return { root, stateDir, configFile, env };
}

function gate(env, payload) {
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(payload), encoding: 'utf8', env });
}
function prompt(env, sid, text = 'status') {
  return gate(env, { session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: text });
}
function sessionStart(env, sid) {
  return gate(env, { session_id: sid, hook_event_name: 'SessionStart' });
}
function preBash(env, sid, command) {
  return gate(env, { session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_use_id: `toolu_${sid}`, tool_input: { command }, cwd: ROOT });
}
function state(stateDir, sid) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, `${sid}.json`), 'utf8'));
}
function seedState(stateDir, sid, extra = {}) {
  fs.writeFileSync(path.join(stateDir, `${sid}.json`), JSON.stringify({
    session_id: sid, created: new Date().toISOString(), workers: {},
    agentClaims: {}, reservations: {}, agents: {}, backgroundShells: {}, ...extra,
  }));
}
function execAgent(stateDir, sid) {
  const file = path.join(stateDir, `${sid}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).execAgent : undefined;
}

const configLib = require('../hooks/lib/config.cjs');
const availabilityLib = require('../hooks/lib/coder-availability.cjs');
const poolLib = require('../hooks/lib/coder-pool-route.cjs');
const handover = require('../hooks/lib/worker-quota-handover.cjs');
const resume = require('../hooks/lib/quota-reset-resume.cjs');
const resumeScheduler = require('../hooks/orca-resume-scheduler.cjs');

{
  const f = configFixture({});
  const cfg = withEnv({ ORCH_CONFIG_PATH: f.file, ORCH_DISABLED_CODERS: undefined }, () => configLib.loadConfig());
  check('default disabledCoders is empty', cfg.disabledCoders, []);
  check('default disabledCoders emits no warning', cfg.warnings, []);
  fs.rmSync(f.root, { recursive: true, force: true });
}
{
  const f = configFixture({ disabledCoders: ['Kimi', 'kimi', ' deepseek '] });
  const cfg = withEnv({ ORCH_CONFIG_PATH: f.file }, () => configLib.loadConfig());
  check('disabledCoders normalizes and deduplicates', cfg.disabledCoders, ['kimi', 'deepseek']);
  check('valid disabledCoders emits no warning', cfg.warnings, []);
  fs.rmSync(f.root, { recursive: true, force: true });
}
{
  const f = configFixture({ disabledCoders: ['kimi', 'claude', 5] });
  const cfg = withEnv({ ORCH_CONFIG_PATH: f.file }, () => configLib.loadConfig());
  check('unknown disabledCoders are dropped', cfg.disabledCoders, ['kimi']);
  ok('unknown disabledCoders warn once with values', cfg.warnings.length === 1 && /claude, 5/.test(cfg.warnings[0]));
  fs.rmSync(f.root, { recursive: true, force: true });
}
{
  const f = configFixture({ disabledCoders: 'kimi' });
  const cfg = withEnv({ ORCH_CONFIG_PATH: f.file }, () => configLib.loadConfig());
  check('non-array disabledCoders is ignored', cfg.disabledCoders, []);
  ok('non-array disabledCoders warns', /must be an array/.test(cfg.warnings[0]));
  fs.rmSync(f.root, { recursive: true, force: true });
}
{
  const f = configFixture({ disabledCoders: ['deepseek'] });
  const cfg = withEnv({ ORCH_CONFIG_PATH: f.file, ORCH_DISABLED_CODERS: 'kimi, codex,bogus' },
    () => configLib.loadConfig());
  check('env disabledCoders replaces config', withEnv({ ORCH_DISABLED_CODERS: 'kimi, codex,bogus' },
    () => configLib.disabledCoders(cfg)), ['kimi', 'codex']);
  ok('unknown env disabledCoders warn with the invalid name',
    cfg.warnings.some((warning) => /ORCH_DISABLED_CODERS.*bogus/.test(warning)));
  check('blank env disabledCoders is unset', withEnv({ ORCH_DISABLED_CODERS: '  ' },
    () => configLib.disabledCoders(cfg)), ['deepseek']);
  const typo = withEnv({ ORCH_CONFIG_PATH: f.file, ORCH_DISABLED_CODERS: 'kim' }, () => configLib.loadConfig());
  check('all-unknown env disabledCoders falls back to config',
    withEnv({ ORCH_DISABLED_CODERS: 'kim' }, () => configLib.disabledCoders(typo)), ['deepseek']);
  ok('all-unknown env disabledCoders warns about the typo and fallback',
    typo.warnings.some((warning) => /unknown coder name.*kim/.test(warning)) &&
    typo.warnings.some((warning) => /using disabledCoders from config/.test(warning)));
  ok('coder-disabled is a known gate', configLib.GATE_NAMES.includes('coder-disabled'));
  fs.rmSync(f.root, { recursive: true, force: true });
}
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disabled-availability-'));
  const env = { ...BASE, ORCH_KIMI_BIN: KIMI_STUB, ORCH_KIMI_HOME: path.join(root, 'no-creds') };
  const first = availabilityLib.coderAvailability({ stateDir: root, fresh: true, disabled: ['kimi'], env });
  check('disabled availability wins over auth', [first.kimi.reason, first.kimi.usable, first.kimi.disabled],
    ['disabled by config', false, true]);
  availabilityLib.coderAvailability({ stateDir: root, disabled: ['kimi'], env, now: 1000 });
  const enabled = availabilityLib.coderAvailability({ stateDir: root, disabled: [], env, now: 1001 });
  ok('availability cache invalidates when enabled state changes', enabled.kimi.reason !== 'disabled by config');
  fs.rmSync(root, { recursive: true, force: true });
}
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disabled-codex-auth-cache-'));
  const env = { ...BASE, ORCH_CODEX_BIN: CODEX_STUB, CODEX_BIN: CODEX_STUB };
  availabilityLib.coderAvailability({
    stateDir: root, disabled: ['codex'], codexAuthState: 'logged-out', env, now: 1000,
  });
  const cacheFile = path.join(root, 'coder-availability.json');
  const firstFetchedAt = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).fetchedAt;
  availabilityLib.coderAvailability({
    stateDir: root, disabled: ['codex'], codexAuthState: 'logged-out', env, now: 1001,
  });
  check('disabled Codex ignores auth validation and reuses availability cache',
    JSON.parse(fs.readFileSync(cacheFile, 'utf8')).fetchedAt, firstFetchedAt);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  const usable = Object.fromEntries(availabilityLib.CODERS.map((coder) => [coder, { usable: true }]));
  const pool = poolLib.pickCoderPool({ availability: usable,
    quotas: { codex: { usedPercent: 30 }, kimi: { usedPercent: 1 }, deepseek: { usedPercent: 90 } },
    disabled: ['kimi'], roles: { deepseek: 'overflow' }, fallbackEnabled: true });
  check('disabled best-quota coder is excluded', pool.pick, 'codex');
  ok('disabled coder state and summary are hidden', pool.coders.kimi.state === 'disabled' &&
    !pool.order.includes('kimi') && !/Kimi/.test(pool.summary));
  const legacy = poolLib.pickCoderPool({ availability: { codex: { usable: false, reason: 'not installed' } },
    disabled: ['codex'], fallbackEnabled: null });
  check('legacy Codex fallback cannot resurrect disabled Codex', legacy.coders.codex.state, 'disabled');
  const none = poolLib.pickCoderPool({ availability: usable, disabled: [...availabilityLib.CODERS] });
  check('all disabled routes in-session with clear summary', [none.route, none.summary, none.why],
    ['code', 'no external coder enabled', 'auto: every coder disabled by config']);
  check('handover never targets a disabled coder', handover.pickNextCoder('codex', pool), 'sonnet');
}
{
  const f = fixture('prompt', { disabledCoders: ['kimi'] });
  const out = prompt(f.env, 'disabled-prompt').stdout;
  ok('routing line omits disabled Kimi', /Model routing:/.test(out) && !/Model routing:.*Kimi/.test(out));
  ok('disabled Kimi quota is never probed', !fs.readdirSync(f.stateDir).some((name) => /^kimi-quota/.test(name)));
  const banner = sessionStart(f.env, 'disabled-banner').stdout;
  const codeLine = banner.split('\n').find((line) => line.startsWith('- Code:')) || '';
  const helpLine = banner.split('\n').find((line) => line.includes('Operator-only override')) || '';
  ok('banner code and override help omit disabled Kimi', !/kimi/i.test(codeLine) && !/kimi/i.test(helpLine));

  const shortcut = prompt(f.env, 'shortcut', '--exec-kimi');
  ok('disabled shortcut is ignored with config guidance', /ignored .*disabledCoders/.test(shortcut.stdout));
  check('disabled shortcut leaves override unchanged', execAgent(f.stateDir, 'shortcut'), undefined);
  const model = prompt(f.env, 'model', '--code-model kimi:k3');
  ok('disabled model override is ignored', /ignored .*disabledCoders/.test(model.stdout));
  check('disabled model leaves override unchanged', execAgent(f.stateDir, 'model'), undefined);

  fs.writeFileSync(path.join(f.stateDir, 'persisted.json'), JSON.stringify({
    session_id: 'persisted', created: new Date().toISOString(), execAgent: 'kimi', workers: {},
    agentClaims: {}, reservations: {}, agents: {}, backgroundShells: {},
  }));
  const persisted = prompt(f.env, 'persisted').stdout;
  ok('persisted disabled override falls back and explains why', !/code -> Kimi/.test(persisted) &&
    /ignored: Kimi is in disabledCoders/.test(persisted));

  const brief = 'Implement feature. Verify: npm test. Owns: n/a isolated worktree.';
  seedState(f.stateDir, 'deny-kimi');
  const denied = preBash(f.env, 'deny-kimi', `orca orchestration worker-start --task t1 --agent kimi --spec "${brief}"`);
  ok('disabled Kimi worker-start is refused by coder-disabled gate', denied.status === 2 &&
    /\[orchestrator-gate:coder-disabled\]/.test(denied.stderr) && /disabledCoders/.test(denied.stderr));
  ok('disabled coder refusal names the configured path and enabled coders',
    denied.stderr.includes(f.configFile) && /Enabled coders: codex, deepseek/.test(denied.stderr));
  check('disabled coder refusal creates no reservation', state(f.stateDir, 'deny-kimi').reservations, {});
  const codex = preBash(f.env, 'allow-codex', `orca orchestration worker-start --task t1 --agent codex --spec "${brief}"`);
  ok('enabled Codex is not refused by coder-disabled gate', !/coder-disabled/.test(codex.stderr));
  fs.rmSync(f.root, { recursive: true, force: true });
}
{
  const f = fixture('tracked-disabled', { disabledCoders: ['kimi'] });
  for (const sid of ['retry-disabled', 'terminal-disabled']) {
    seedState(f.stateDir, sid, { workers: {
      ctx_kimi: { status: 'live', group: 'ctx_kimi', agent: 'kimi' },
      term_kimi: { status: 'live', group: 'ctx_kimi', agent: 'kimi' },
    } });
  }
  const retry = preBash(f.env, 'retry-disabled',
    'orca orchestration worker-start --retry-of ctx_kimi --spec "Research only"');
  ok('retry of a tracked disabled coder is refused with fresh-dispatch guidance',
    retry.status === 2 && /instead of --retry-of/.test(retry.stderr) && /fresh dispatch/.test(retry.stderr));
  check('retry refusal leaves reservations empty', state(f.stateDir, 'retry-disabled').reservations, {});
  const terminal = preBash(f.env, 'terminal-disabled',
    'orca orchestration worker-start --terminal term_kimi --spec "Research only"');
  ok('terminal reuse of a tracked disabled coder is refused',
    terminal.status === 2 && /instead of --terminal/.test(terminal.stderr));
  check('terminal refusal leaves reservations empty', state(f.stateDir, 'terminal-disabled').reservations, {});
  fs.rmSync(f.root, { recursive: true, force: true });
}
{
  const f = fixture('disabled-codex-override', { disabledCoders: ['codex'] });
  const out = prompt(f.env, 'codex-override', '--exec-codex');
  ok('disabled Codex shortcut is ignored', /ignored .*Codex.*disabled/.test(out.stdout));
  check('disabled Codex shortcut leaves override unchanged', execAgent(f.stateDir, 'codex-override'), undefined);
  fs.rmSync(f.root, { recursive: true, force: true });
}
{
  const f = fixture('disabled-deepseek-override', { disabledCoders: ['deepseek'] });
  const out = prompt(f.env, 'deepseek-override', '--code-model deepseek');
  ok('disabled DeepSeek model override is ignored', /ignored .*DeepSeek.*disabled/.test(out.stdout));
  check('disabled DeepSeek override leaves state unchanged', execAgent(f.stateDir, 'deepseek-override'), undefined);
  fs.rmSync(f.root, { recursive: true, force: true });
}
{
  const f = fixture('disabled-gate', { disabledCoders: ['kimi'], disabledGates: ['coder-disabled'] });
  const out = preBash(f.env, 'gate-off', 'orca orchestration worker-start --agent kimi --spec "Research only"');
  ok('coder-disabled gate can be disabled', !/coder-disabled/.test(out.stderr));
  fs.rmSync(f.root, { recursive: true, force: true });
}
{
  const f = fixture('opencode', { disabledCoders: ['deepseek'] });
  const out = preBash(f.env, 'deny-opencode',
    'orca orchestration worker-start --agent opencode --spec "Implement feature. Verify: npm test. Owns: n/a isolated worktree."');
  ok('disabled DeepSeek refuses opencode agent', out.status === 2 && /coder-disabled/.test(out.stderr));
  fs.rmSync(f.root, { recursive: true, force: true });
}
{
  const modulePath = require.resolve('../hooks/orca-heartbeat.cjs');
  delete require.cache[modulePath];
  const heartbeat = withEnv({ ORCH_DISABLED_CODERS: 'kimi' }, () => require(modulePath));
  const pool = withEnv({ ORCH_DISABLED_CODERS: 'kimi' }, () => heartbeat.buildHandoverPool({
    codex: { usedPercent: 20 }, kimi: { usedPercent: 10 }, deepseek: null,
  }, Date.now(), {
    codexAuthState: () => 'ok',
    availability: { codex: { usable: true }, kimi: { usable: true }, deepseek: { usable: false, reason: 'not installed' } },
    readCoderExhaustion: () => ({}),
  }));
  check('heartbeat handover pool disables configured coder', pool.coders.kimi.state, 'disabled');
}
{
  let quotaProbes = 0;
  let sends = 0;
  const job = { agent: 'kimi', status: 'scheduled', handle: 'term_disabled', parkedAt: 1, threshold: 95 };
  const result = withEnv({ ORCH_DISABLED_CODERS: 'kimi' }, () => resume.attemptResume(job, {
    now: Date.now(), coderDisabled: resumeScheduler.coderDisabled,
    isAuthorized: () => true,
    probeQuota: () => { quotaProbes += 1; return { usedPercent: 0 }; },
    send: () => { sends += 1; return true; },
  }));
  check('resume scheduler skips a parked disabled coder before quota or terminal work',
    [result.reason, quotaProbes, sends], ['coder-disabled', 0, 0]);
  const applied = resume.applyAttemptResult(job, result, Date.now());
  check('disabled parked worker remains scheduled for a later config recheck',
    [applied.retry, applied.job.status], [true, 'scheduled']);
}

if (failures.length) {
  console.error(`FAIL: ${failures.length} disabled-coder check(s) failed (${passed} passed)\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`ok - ${passed} disabled-coder checks passed`);
