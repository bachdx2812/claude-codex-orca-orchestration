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

function fixture(name, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `disabled-coders-${name}-`));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    activation: 'always', replyLanguage: null, maxParallelAgents: 0,
    maxParallelCodexWorkers: 0, disabledGates: [], disabledCoders: [], ...config,
  }));
  return { root, stateDir, configFile, env: {
    ...BASE, ORCH_STATE_DIR: stateDir, ORCH_CONFIG_PATH: configFile,
    ORCA_BIN: ORCA_STUB, ORCH_CODEX_BIN: CODEX_STUB, CODEX_BIN: CODEX_STUB,
  } };
}

function gate(env, payload) {
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(payload), encoding: 'utf8', env });
}
function prompt(env, sid, text = 'status') {
  return gate(env, { session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: text });
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

{
  const f = fixture('default');
  const cfg = withEnv({ ORCH_CONFIG_PATH: f.configFile }, () => configLib.loadConfig());
  check('default disabledCoders is empty', cfg.disabledCoders, []);
  check('default disabledCoders emits no warning', cfg.warnings, []);
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('normalized', { disabledCoders: ['Codex', 'codex'] });
  const cfg = withEnv({ ORCH_CONFIG_PATH: f.configFile }, () => configLib.loadConfig());
  check('disabledCoders normalizes and deduplicates Codex', cfg.disabledCoders, ['codex']);
  check('valid disabledCoders emits no warning', cfg.warnings, []);
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('unknown', { disabledCoders: ['codex', 'claude', 5] });
  const cfg = withEnv({ ORCH_CONFIG_PATH: f.configFile }, () => configLib.loadConfig());
  check('unknown disabledCoders are dropped', cfg.disabledCoders, ['codex']);
  ok('unknown disabledCoders warn once with values',
    cfg.warnings.length === 1 && /claude, 5/.test(cfg.warnings[0]));
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('non-array', { disabledCoders: 'codex' });
  const cfg = withEnv({ ORCH_CONFIG_PATH: f.configFile }, () => configLib.loadConfig());
  check('non-array disabledCoders is ignored', cfg.disabledCoders, []);
  ok('non-array disabledCoders warns', /must be an array/.test(cfg.warnings[0]));
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('env', { disabledCoders: ['codex'] });
  const cfg = withEnv({ ORCH_CONFIG_PATH: f.configFile, ORCH_DISABLED_CODERS: 'codex,bogus' },
    () => configLib.loadConfig());
  check('the environment override keeps known coders',
    withEnv({ ORCH_DISABLED_CODERS: 'codex,bogus' }, () => configLib.disabledCoders(cfg)), ['codex']);
  ok('the environment override warns about unknown names',
    cfg.warnings.some((warning) => /unknown coder name.*bogus/.test(warning)));
  check('blank environment disabledCoders is unset',
    withEnv({ ORCH_DISABLED_CODERS: '  ' }, () => configLib.disabledCoders(cfg)), ['codex']);
  const typo = withEnv({ ORCH_CONFIG_PATH: f.configFile, ORCH_DISABLED_CODERS: 'codxe' },
    () => configLib.loadConfig());
  check('an all-unknown environment override falls back to config',
    withEnv({ ORCH_DISABLED_CODERS: 'codxe' }, () => configLib.disabledCoders(typo)), ['codex']);
  ok('an all-unknown environment override warns about the typo and fallback',
    typo.warnings.some((warning) => /unknown coder name.*codxe/.test(warning)) &&
    typo.warnings.some((warning) => /using disabledCoders from config/.test(warning)));
  ok('coder-disabled remains a known gate', configLib.GATE_NAMES.includes('coder-disabled'));
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disabled-availability-'));
  const result = availabilityLib.coderAvailability({
    stateDir: root, fresh: true, disabled: ['codex'], env: { ...BASE, ORCH_CODEX_BIN: CODEX_STUB },
  });
  check('disabled availability wins over probing',
    [result.codex.disabled, result.codex.usable, result.codex.reason], [true, false, 'disabled by config']);
  availabilityLib.coderAvailability({
    stateDir: root, disabled: ['codex'], env: { ...BASE, ORCH_CODEX_BIN: CODEX_STUB }, now: 1000,
  });
  const enabled = availabilityLib.coderAvailability({
    stateDir: root, disabled: [], env: { ...BASE, ORCH_CODEX_BIN: CODEX_STUB },
    codexAuthState: 'ok', now: 1001,
  });
  ok('availability cache invalidates when enabled state changes', enabled.codex.reason !== 'disabled by config');
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disabled-codex-auth-cache-'));
  const env = { ...BASE, ORCH_CODEX_BIN: CODEX_STUB, CODEX_BIN: CODEX_STUB };
  availabilityLib.coderAvailability({
    stateDir: root, disabled: ['codex'], codexAuthState: 'logged-out', env, now: 1000,
  });
  const cacheFile = path.join(root, 'coder-availability.json');
  const fetchedAt = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).fetchedAt;
  availabilityLib.coderAvailability({
    stateDir: root, disabled: ['codex'], codexAuthState: 'logged-out', env, now: 1001,
  });
  check('disabled Codex ignores auth validation and reuses availability cache',
    JSON.parse(fs.readFileSync(cacheFile, 'utf8')).fetchedAt, fetchedAt);
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const pool = poolLib.pickCoderPool({
    availability: { codex: { usable: true } }, quotas: { codex: { usedPercent: 10 } },
    thresholds: { codex: 95 }, disabled: ['codex'], fallbackEnabled: true,
  });
  check('a disabled Codex routes to the in-session coder', [pool.route, pool.pick], ['code', null]);
  check('a disabled Codex is hidden from the ranked order', pool.order, []);
  check('all disabled routes in-session with a clear summary', [pool.summary, pool.why],
    ['no external coder enabled', 'auto: every coder disabled by config']);
}

{
  const f = fixture('gate', { disabledCoders: ['codex'] });
  const command = 'orca orchestration worker-start --agent codex --spec "Implement feature. Owns: n/a isolated worktree. Verify: npm test."';
  seedState(f.stateDir, 'deny');
  const denied = preBash(f.env, 'deny', command);
  ok('the coder-disabled gate refuses a disabled Codex worker',
    denied.status === 2 && /coder-disabled/.test(denied.stderr));
  ok('the disabled coder refusal names config and the in-session fallback',
    denied.stderr.includes(f.configFile) && /Enabled coders: sonnet/.test(denied.stderr));
  check('disabled coder refusal creates no reservation', state(f.stateDir, 'deny').reservations, {});

  const shortcut = prompt(f.env, 'shortcut', '--exec-codex');
  ok('the disabled Codex shortcut is ignored', /ignored .*Codex.*disabled/.test(shortcut.stdout));
  check('the disabled Codex shortcut leaves the override unchanged', execAgent(f.stateDir, 'shortcut'), undefined);

  seedState(f.stateDir, 'persisted', { execAgent: 'codex' });
  const persisted = prompt(f.env, 'persisted').stdout;
  ok('a persisted disabled override falls back and explains why',
    !/code -> Codex/.test(persisted) && /ignored: Codex is in disabledCoders/.test(persisted));
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('tracked', { disabledCoders: ['codex'] });
  for (const sid of ['retry-disabled', 'terminal-disabled']) {
    seedState(f.stateDir, sid, { workers: {
      ctx_codex: { status: 'live', group: 'ctx_codex', agent: 'codex' },
      term_codex: { status: 'live', group: 'ctx_codex', agent: 'codex' },
    } });
  }
  const retry = preBash(f.env, 'retry-disabled',
    'orca orchestration worker-start --retry-of ctx_codex --spec "Research only"');
  ok('retry of a tracked disabled Codex worker is refused with fresh-dispatch guidance',
    retry.status === 2 && /instead of --retry-of/.test(retry.stderr) && /fresh dispatch/.test(retry.stderr));
  check('retry refusal leaves reservations empty', state(f.stateDir, 'retry-disabled').reservations, {});
  const terminal = preBash(f.env, 'terminal-disabled',
    'orca orchestration worker-start --terminal term_codex --spec "Research only"');
  ok('terminal reuse of a tracked disabled Codex worker is refused',
    terminal.status === 2 && /instead of --terminal/.test(terminal.stderr));
  check('terminal reuse refusal leaves reservations empty', state(f.stateDir, 'terminal-disabled').reservations, {});
  fs.rmSync(f.root, { recursive: true, force: true });
}

{
  const f = fixture('gate-off', { disabledCoders: ['codex'], disabledGates: ['coder-disabled'] });
  const out = preBash(f.env, 'gate-off',
    'orca orchestration worker-start --agent codex --spec "Research only"');
  ok('the coder-disabled gate can itself be disabled', !/coder-disabled/.test(out.stderr));
  fs.rmSync(f.root, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`FAIL (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`PASS (${passed} checks)`);
