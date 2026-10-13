#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const quota = require('../hooks/lib/exec-route-by-quota.cjs');
const availability = require('../hooks/lib/coder-availability.cjs');
const eligibility = require('../hooks/lib/codex-eligibility.cjs');
const CODEX_STUB = path.join(__dirname, 'fixtures', 'codex-app-server-stub.cjs');
try { fs.chmodSync(CODEX_STUB, 0o755); } catch {}

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
function ok(name, value) { check(name, !!value, true); }
function temp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(ORCH_|CODEX_BIN|CODEX_HOME)/.test(key)));

{
  const root = temp('coder-codex-auth-');
  const stateDir = path.join(root, 'state');
  const calls = path.join(root, 'calls.log');
  const old = { ...process.env };
  process.env.ORCH_CODEX_BIN = CODEX_STUB;
  process.env.CODEX_SESSIONS_DIR = path.join(root, 'empty-sessions');
  process.env.STUB_CODEX_CALLS_LOG = calls;
  process.env.STUB_CODEX_MODE = 'logged-out';
  fs.mkdirSync(process.env.CODEX_SESSIONS_DIR);

  const result = quota.codexQuota(Date.now(), { stateDir, cacheSeconds: 600 });
  check('codex logged-out probe returns the reserved auth state',
    [result.failed, result.authState], [true, 'logged-out']);
  check('codexAuthState reads logged-out without spawning', quota.codexAuthState(stateDir), 'logged-out');
  const loggedOut = availability.coderAvailability({
    stateDir, cacheSeconds: 600, now: Date.now(), codexAuthState: quota.codexAuthState(stateDir),
    orcaInstalled: true, env: { ...baseEnv, ORCH_CODEX_BIN: CODEX_STUB },
  });
  check('codex is unusable on the same prompt that observes logout',
    [loggedOut.codex.usable, loggedOut.codex.reason], [false, 'not logged in']);

  const warmDir = path.join(root, 'warm-state');
  const warmUp = availability.coderAvailability({
    stateDir: warmDir, cacheSeconds: 600, now: Date.now(), codexAuthState: 'ok',
    orcaInstalled: true, env: { ...baseEnv, ORCH_CODEX_BIN: CODEX_STUB },
  });
  check('warm availability cache starts usable', warmUp.codex.usable, true);
  const warmFlip = availability.coderAvailability({
    stateDir: warmDir, cacheSeconds: 600, now: Date.now(), codexAuthState: 'logged-out',
    orcaInstalled: true, env: { ...baseEnv, ORCH_CODEX_BIN: CODEX_STUB },
  });
  check('cached-usable entry flips to unusable on the prompt that observes logout',
    [warmFlip.codex.usable, warmFlip.codex.reason], [false, 'not logged in']);
  const flipBack = availability.coderAvailability({
    stateDir, cacheSeconds: 600, now: Date.now(), codexAuthState: 'ok',
    orcaInstalled: true, env: { ...baseEnv, ORCH_CODEX_BIN: CODEX_STUB },
  });
  check('a cache written while logged out is rejected once auth reads ok again', flipBack.codex.usable, true);
  quota.codexQuota(Date.now() + 1, { stateDir, cacheSeconds: 600 });
  check('logged-out failure is cached', fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1);

  const route = quota.execRoute(95, Date.now(), { stateDir, cacheSeconds: 600 });
  check('execRoute treats a failed logged-out quota as unknown', route.codexLeft, null);
  ok('execRoute summary never prints NaN% left', /Codex unknown/.test(route.summary) && !/NaN/.test(route.summary));
  check('fresh logged-out auth state respects maxAge', quota.codexAuthState(stateDir, Date.now(), 600000), 'logged-out');
  check('logged-out auth state older than maxAge reports unknown',
    quota.codexAuthState(stateDir, Date.now() + 86400000, 600000), 'unknown');

  process.env.STUB_CODEX_MODE = 'auth-error-but-signed-in';
  const authErrorDir = path.join(root, 'auth-error');
  check('rate-limit auth error text with a valid account stays quota unknown',
    quota.codexQuota(Date.now(), { stateDir: authErrorDir, cacheSeconds: 60 }), null);
  check('a signed-in account/read overrides the error-message fallback',
    quota.codexAuthState(authErrorDir), 'unknown');

  process.env.STUB_CODEX_MODE = 'account-read-unsupported';
  const unsupportedDir = path.join(root, 'unsupported');
  const unsupported = quota.codexQuota(Date.now(), { stateDir: unsupportedDir, cacheSeconds: 60 });
  check('unsupported account/read stays auth unknown',
    quota.codexAuthState(unsupportedDir), 'unknown');
  check('unsupported account/read leaves Codex usable',
    unsupported, null);

  const childExit3 = path.join(root, 'exit-three.cjs');
  fs.writeFileSync(childExit3, '#!/usr/bin/env node\nprocess.exit(3);\n');
  fs.chmodSync(childExit3, 0o755);
  process.env.ORCH_CODEX_BIN = childExit3;
  delete process.env.STUB_CODEX_MODE;
  const collisionDir = path.join(root, 'collision');
  quota.codexQuota(Date.now(), { stateDir: collisionDir, cacheSeconds: 60 });
  check('child app-server exit 3 is not misclassified as logged out', quota.codexAuthState(collisionDir), 'unknown');

  process.env.ORCH_CODEX_BIN = CODEX_STUB;
  process.env.STUB_CODEX_MODE = 'timeout';
  const timeoutDir = path.join(root, 'stub-timeout');
  const timeoutStarted = Date.now();
  check('codex stub timeout mode is quota unknown',
    quota.codexQuota(Date.now(), { stateDir: timeoutDir, cacheSeconds: 60 }), null);
  ok('codex stub timeout stays bounded', Date.now() - timeoutStarted < 6000);
  check('codex stub timeout leaves auth unknown', quota.codexAuthState(timeoutDir), 'unknown');

  process.env.STUB_CODEX_MODE = 'malformed';
  const malformedDir = path.join(root, 'stub-malformed');
  check('codex stub malformed mode is quota unknown',
    quota.codexQuota(Date.now(), { stateDir: malformedDir, cacheSeconds: 60 }), null);
  check('codex stub malformed leaves auth unknown', quota.codexAuthState(malformedDir), 'unknown');
  check('unknown auth after timeout or malformed output keeps Codex usable',
    availability.probeCoderAvailability('codex', {
      env: { ...baseEnv, ORCH_CODEX_BIN: CODEX_STUB }, codexAuthState: quota.codexAuthState(malformedDir),
    }).usable, true);

  for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
  Object.assign(process.env, old);
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const result = availability.probeCoderAvailability('codex', {
    env: { ...baseEnv, ORCH_CODEX_BIN: path.join(os.tmpdir(), 'missing-codex') },
  });
  check('a missing Codex binary is unavailable',
    [result.installed, result.usable, result.reason], [false, false, 'not installed']);
}

{
  const result = availability.probeCoderAvailability('codex', {
    env: { ...baseEnv, ORCH_CODEX_BIN: CODEX_STUB }, codexAuthState: 'ok',
  });
  check('an installed authenticated Codex binary is usable',
    [result.installed, result.auth, result.usable, result.reason], [true, 'ok', true, null]);
}

{
  const result = availability.probeCoderAvailability('codex', {
    env: { ...baseEnv, ORCH_CODEX_BIN: CODEX_STUB }, codexAuthState: 'logged-out',
  });
  check('a logged-out Codex binary is unavailable',
    [result.auth, result.usable, result.reason], ['logged-out', false, 'not logged in']);
}

{
  const result = availability.probeCoderAvailability('codex', {
    env: { ...baseEnv, ORCH_CODEX_BIN: CODEX_STUB }, orcaInstalled: false,
  });
  check('Codex is unavailable when Orca is missing', result.reason, 'orca not installed');
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-exhaustion-'));
  const now = Date.now();
  ok('an exhaustion marker can be written', availability.markCoderExhausted(root, 'codex', {
    now, until: now + 60_000, reason: 'test limit',
  }));
  check('an active exhaustion marker is read back', availability.readCoderExhaustion(root, now).codex.reason, 'test limit');
  ok('an exhaustion marker can be cleared', availability.clearCoderExhaustion(root, 'codex'));
  check('a cleared exhaustion marker is absent', availability.readCoderExhaustion(root, now), {});
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const result = (overrides = {}) => eligibility.codexEligibility({
    availability: { usable: true }, quota: { usedPercent: 20 }, threshold: 95,
    ...overrides,
  });
  check('usable Codex below threshold is eligible', result().state, 'eligible');
  check('threshold exhaustion is reported', result({ quota: { usedPercent: 95 } }).state, 'exhausted');
  check('unknown quota keeps usable Codex eligible', result({ quota: null }).state, 'eligible');
  check('unusable Codex preserves its reason',
    result({ availability: { usable: false, reason: 'not logged in' }, quota: null }), {
      state: 'unusable', reason: 'not logged in', leftPct: null, headroom: null,
      estimated: false, quotaFetchedAt: null,
    });
  check('an active exhaustion marker wins over an unknown quota',
    result({ quota: null, exhaustion: { reason: 'usage limit' } }).state, 'exhausted');
}

{
  const root = temp('coder-last-known-');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const now = Date.now();
  check('no Codex reading ever means estimate unknown', quota.estimatedQuota(stateDir, 'codex', now), null);
  quota.persistLastKnownQuota(stateDir, 'codex', {
    usedPercent: 40,
    resetsAt: Math.floor((now + 3600000) / 1000),
    windows: [
      { usedPercent: 40, resetsAt: Math.floor((now + 3600000) / 1000) },
      { usedPercent: 90, resetsAt: Math.floor((now - 60000) / 1000) },
    ],
  }, now - 2400000);
  const estimate = quota.estimatedQuota(stateDir, 'codex', now);
  check('a reset window counts as 0% used while an active window keeps its reading',
    [estimate.usedPercent, estimate.estimated, estimate.source], [40, true, 'estimate']);
  check('the estimate carries the original read time', estimate.fetchedAt, now - 2400000);

  const old = {
    ORCH_CODEX_BIN: process.env.ORCH_CODEX_BIN,
    CODEX_SESSIONS_DIR: process.env.CODEX_SESSIONS_DIR,
  };
  process.env.ORCH_CODEX_BIN = path.join(root, 'missing-codex');
  process.env.CODEX_SESSIONS_DIR = path.join(root, 'empty-sessions');
  fs.mkdirSync(process.env.CODEX_SESSIONS_DIR);
  const integrated = quota.codexQuota(now, { stateDir, cacheSeconds: 60 });
  check('codexQuota falls back to the estimate when nothing live answers',
    [integrated.usedPercent, integrated.estimated], [40, true]);

  const sessions = path.join(root, 'sessions');
  fs.mkdirSync(path.join(sessions, '2026', '09', '29'), { recursive: true });
  const resetState = path.join(root, 'state-reset');
  fs.mkdirSync(resetState, { recursive: true });
  const t0 = Date.now();
  fs.writeFileSync(path.join(sessions, '2026', '09', '29', 's.jsonl'),
    JSON.stringify({ timestamp: new Date(t0).toISOString(), payload: { rate_limits: {
      primary: { used_percent: 97, resets_at: Math.floor(t0 / 1000) + 3600 },
    } } }) + '\n');
  process.env.CODEX_SESSIONS_DIR = sessions;
  const first = quota.codexQuota(t0, { stateDir: resetState, cacheSeconds: 60 });
  check('a session-log reading is used while fresh', [first.usedPercent, first.source], [97, 'session log']);
  check('the persisted last-known keeps the window reset time',
    quota.estimatedQuota(resetState, 'codex', t0 + 30 * 60000).usedPercent, 97);
  fs.rmSync(sessions, { recursive: true, force: true });
  fs.mkdirSync(sessions);
  const later = quota.codexQuota(t0 + 2 * 3600e3, { stateDir: resetState, cacheSeconds: 60 });
  check('a 97% session-log reading no longer exhausts Codex after the window reset',
    [later.usedPercent, later.estimated], [0, true]);
  check('the post-reset estimate makes the coder eligible rather than exhausted',
    eligibility.codexEligibility({ availability: { usable: true }, quota: later, threshold: 95 }).state,
    'eligible');

  const resetlessState = path.join(root, 'state-resetless');
  fs.mkdirSync(resetlessState, { recursive: true });
  const t1 = Date.now();
  quota.persistLastKnownQuota(resetlessState, 'codex', { usedPercent: 97, resetsAt: 0 }, t1);
  check('a resetless window is still trusted within the bound',
    quota.estimatedQuota(resetlessState, 'codex', t1 + 3600e3).usedPercent, 97);
  check('a resetless window older than the bound drops to unknown',
    quota.estimatedQuota(resetlessState, 'codex', t1 + 6 * 3600e3), null);

  const stableState = path.join(root, 'state-stable');
  fs.mkdirSync(stableState, { recursive: true });
  const fetchedAt = Date.now() - 1800e3;
  quota.persistLastKnownQuota(stableState, 'codex', { usedPercent: 50, resetsAt: 0, fetchedAt });
  const stableFile = path.join(stableState, 'codex-quota-last-known.json');
  const before = fs.readFileSync(stableFile, 'utf8');
  check('readAt is the reading own fetchedAt rather than the call time', JSON.parse(before).readAt, fetchedAt);
  quota.persistLastKnownQuota(stableState, 'codex', { usedPercent: 99, resetsAt: 0, fetchedAt });
  check('the same reading from a cache hit is never rewritten', fs.readFileSync(stableFile, 'utf8'), before);

  if (old.ORCH_CODEX_BIN === undefined) delete process.env.ORCH_CODEX_BIN;
  else process.env.ORCH_CODEX_BIN = old.ORCH_CODEX_BIN;
  if (old.CODEX_SESSIONS_DIR === undefined) delete process.env.CODEX_SESSIONS_DIR;
  else process.env.CODEX_SESSIONS_DIR = old.CODEX_SESSIONS_DIR;
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`FAIL (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`PASS (${passed} checks)`);
