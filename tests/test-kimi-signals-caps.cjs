#!/usr/bin/env node
/**
 * Unit tests for the Kimi-coder additions: config keys (kimiHandoffUsedPercent,
 * kimiQuotaCacheSeconds, coderAvailabilityCacheSeconds, maxParallelKimiWorkers,
 * models.kimi), the Kimi usage-limit terminal signal, heartbeat usage-exhausted
 * classification/reporting, and the generalised per-agent cap accounting.
 *
 * Hermetic: state lives under a fresh ORCH_STATE_DIR; no real codex/kimi binary, no
 * network, and the real ~/.kimi-code is never read (nothing here touches it at all).
 *
 * Run: node tests/test-kimi-signals-caps.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-kimi-state-'));
process.env.ORCH_STATE_DIR = STATE_DIR;
process.env.ORCH_CONFIG_PATH = path.join(STATE_DIR, 'no-such-config.json'); // -> defaults
process.env.CLAUDE_CODE_SESSION_ID = 'kimi-signals-caps-test';

const config = require('../hooks/lib/config.cjs');
const heartbeat = require('../hooks/orca-heartbeat.cjs');
const { hasRateLimitError, hasKimiUsageExhausted } = require('../hooks/lib/terminal-signals.cjs');
const OC = require('../hooks/lib/ownership-claims.cjs');
const POG = require('../hooks/lib/parallel-ownership-gates.cjs');

let pass = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass += 1;
  else failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
}

const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-kimi-config-'));
const cfgFile = path.join(cfgDir, 'orchestration.config.json');
function withConfig(obj, fn) {
  fs.writeFileSync(cfgFile, JSON.stringify(obj));
  const prev = process.env.ORCH_CONFIG_PATH;
  process.env.ORCH_CONFIG_PATH = cfgFile;
  try { return fn(); } finally { process.env.ORCH_CONFIG_PATH = prev; }
}

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[name]; else process.env[name] = prev;
  }
}

// --- config: defaults ---------------------------------------------------------

{
  const defaults = withConfig({}, () => config.loadConfig());
  check('default kimiHandoffUsedPercent is 95', defaults.kimiHandoffUsedPercent, 95);
  check('default kimiQuotaCacheSeconds is 60', defaults.kimiQuotaCacheSeconds, 60);
  check('default coderAvailabilityCacheSeconds is 600', defaults.coderAvailabilityCacheSeconds, 600);
  check('default maxParallelKimiWorkers is 3', defaults.maxParallelKimiWorkers, 3);
  check('default models.kimi is {alias:null,id:null}', defaults.models.kimi, { alias: null, id: null });
  check('defaults produce no warnings', defaults.warnings, []);
  check('GATE_NAMES includes max-parallel-kimi-workers',
    config.GATE_NAMES.includes('max-parallel-kimi-workers'), true);
  check('gateDisabled recognises max-parallel-kimi-workers',
    config.gateDisabled(withConfig({ disabledGates: ['max-parallel-kimi-workers'] }, () => config.loadConfig()),
      'max-parallel-kimi-workers'), true);

  const example = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'config', 'orchestration.config.example.json'), 'utf8'));
  check('example config keeps codexHandoffUsedPercent 95', example.codexHandoffUsedPercent, 95);
  check('example config has kimiHandoffUsedPercent 95', example.kimiHandoffUsedPercent, 95);
  check('example config has maxParallelKimiWorkers 3', example.maxParallelKimiWorkers, 3);
  check('example config has kimiQuotaCacheSeconds 60', example.kimiQuotaCacheSeconds, 60);
  check('example config has coderAvailabilityCacheSeconds 600', example.coderAvailabilityCacheSeconds, 600);
  check('example config has models.kimi', example.models.kimi, { alias: null, id: null });
}

// --- config: validation (warning + default fallback, same as the codex key) ---

for (const [key, bad, dflt] of [
  ['kimiHandoffUsedPercent', 150, 95],
  ['kimiHandoffUsedPercent', -1, 95],
  ['kimiHandoffUsedPercent', 'ninety-five', 95],
  ['kimiHandoffUsedPercent', 95.5, 95],
  ['kimiQuotaCacheSeconds', 3601, 60],
  ['kimiQuotaCacheSeconds', -1, 60],
  ['kimiQuotaCacheSeconds', 'sixty', 60],
  ['coderAvailabilityCacheSeconds', 86401, 600],
  ['coderAvailabilityCacheSeconds', -5, 600],
  ['maxParallelKimiWorkers', 33, 3],
  ['maxParallelKimiWorkers', -1, 3],
  ['maxParallelKimiWorkers', 2.5, 3],
]) {
  const cfg = withConfig({ [key]: bad }, () => config.loadConfig());
  check(`${key} ${JSON.stringify(bad)} falls back to default`, cfg[key], dflt);
  check(`${key} ${JSON.stringify(bad)} produces a warning`,
    cfg.warnings.some((w) => w.includes(key)), true);
}

for (const bad of [null, true]) {
  for (const [key, dflt] of [
    ['codexHandoffUsedPercent', 95],
    ['kimiHandoffUsedPercent', 95],
    ['codexQuotaCacheSeconds', 60],
    ['kimiQuotaCacheSeconds', 60],
    ['coderAvailabilityCacheSeconds', 600],
    ['maxParallelCodexWorkers', 3],
    ['maxParallelKimiWorkers', 3],
  ]) {
    const cfg = withConfig({ [key]: bad }, () => config.loadConfig());
    check(`${key} ${bad} falls back to default instead of numeric coercion`, cfg[key], dflt);
    check(`${key} ${bad} produces a banner warning`, cfg.warnings.some((w) => w.includes(key)), true);
  }
}

{
  const good = withConfig({
    kimiHandoffUsedPercent: 80, kimiQuotaCacheSeconds: 0,
    coderAvailabilityCacheSeconds: 86400, maxParallelKimiWorkers: 0,
  }, () => config.loadConfig());
  check('valid kimi keys are kept as-is', [
    good.kimiHandoffUsedPercent, good.kimiQuotaCacheSeconds,
    good.coderAvailabilityCacheSeconds, good.maxParallelKimiWorkers,
  ], [80, 0, 86400, 0]);
  check('valid kimi keys produce no warnings', good.warnings, []);
  // A numeric string coerces exactly like the codex key (Number() then range check).
  const coerced = withConfig({ kimiHandoffUsedPercent: '95' }, () => config.loadConfig());
  check('a numeric-string kimi threshold coerces like the codex one', coerced.kimiHandoffUsedPercent, 95);

  // The kimi threshold is independent of the codex one.
  const split = withConfig({ codexHandoffUsedPercent: 60 }, () => config.loadConfig());
  check('setting codexHandoffUsedPercent leaves kimiHandoffUsedPercent at default',
    split.kimiHandoffUsedPercent, 95);
  const split2 = withConfig({ kimiHandoffUsedPercent: 70 }, () => config.loadConfig());
  check('setting kimiHandoffUsedPercent leaves codexHandoffUsedPercent at default',
    split2.codexHandoffUsedPercent, 95);
}

// --- config: env overrides -----------------------------------------------------

{
  const defaults = withConfig({}, () => config.loadConfig());

  withEnv('ORCH_KIMI_HANDOFF_USED', '88', () => {
    check('ORCH_KIMI_HANDOFF_USED overrides the config value', config.kimiHandoffUsed(defaults), 88);
  });
  withEnv('ORCH_KIMI_HANDOFF_USED', 'bad', () => {
    check('an invalid kimi handoff override falls back to config', config.kimiHandoffUsed(defaults), 95);
  });
  for (const [name, read, expected] of [
    ['ORCH_CODEX_HANDOFF_USED', config.handoffUsed, 95],
    ['ORCH_KIMI_HANDOFF_USED', config.kimiHandoffUsed, 95],
    ['ORCH_CODEX_QUOTA_CACHE_SECONDS', config.codexQuotaCacheSeconds, 60],
    ['ORCH_KIMI_QUOTA_CACHE_SECONDS', config.kimiQuotaCacheSeconds, 60],
    ['ORCH_CODER_AVAILABILITY_CACHE_SECONDS', config.coderAvailabilityCacheSeconds, 600],
    ['ORCH_MAX_PARALLEL_CODEX_WORKERS', config.maxParallelCodexWorkers, 3],
    ['ORCH_MAX_PARALLEL_KIMI_WORKERS', config.maxParallelKimiWorkers, 3],
  ]) {
    withEnv(name, '   ', () => {
      check(`${name} whitespace counts as unset`, read(defaults), expected);
    });
  }
  withEnv('ORCH_KIMI_QUOTA_CACHE_SECONDS', '5', () => {
    check('ORCH_KIMI_QUOTA_CACHE_SECONDS overrides the config value', config.kimiQuotaCacheSeconds(defaults), 5);
  });
  withEnv('ORCH_KIMI_QUOTA_CACHE_SECONDS', '', () => {
    check('an empty kimi quota cache override counts as unset', config.kimiQuotaCacheSeconds(defaults), 60);
  });
  withEnv('ORCH_KIMI_QUOTA_CACHE_SECONDS', 'nope', () => {
    check('an invalid kimi quota cache override falls back to config', config.kimiQuotaCacheSeconds(defaults), 60);
  });
  withEnv('ORCH_CODER_AVAILABILITY_CACHE_SECONDS', '120', () => {
    check('ORCH_CODER_AVAILABILITY_CACHE_SECONDS overrides the config value',
      config.coderAvailabilityCacheSeconds(defaults), 120);
  });
  withEnv('ORCH_CODER_AVAILABILITY_CACHE_SECONDS', '', () => {
    check('an empty availability cache override counts as unset',
      config.coderAvailabilityCacheSeconds(defaults), 600);
  });
  withEnv('ORCH_MAX_PARALLEL_KIMI_WORKERS', '7', () => {
    check('ORCH_MAX_PARALLEL_KIMI_WORKERS overrides the config value', config.maxParallelKimiWorkers(defaults), 7);
  });
  withEnv('ORCH_MAX_PARALLEL_KIMI_WORKERS', 'bad', () => {
    check('an invalid kimi cap override falls back to config', config.maxParallelKimiWorkers(defaults), 3);
  });
}

// --- terminal signals ----------------------------------------------------------

const KIMI_403 = "■ ERROR 403 You've reached your usage limit for this billing cycle.";

check('an error-shaped kimi billing-cycle line is usage-exhausted', hasKimiUsageExhausted(KIMI_403), true);
check('an error-shaped kimi billing-cycle line is also a rate-limit signal', hasRateLimitError(KIMI_403), true);
check('a warning-shaped line with 403 counts', hasKimiUsageExhausted(
  "⚠ You've reached your usage limit for this billing cycle (HTTP 403)."), true);
check('an error: prefix counts', hasKimiUsageExhausted(
  "error: You've reached your usage limit for this billing cycle."), true);
check('a curly apostrophe counts', hasKimiUsageExhausted(
  '■ ERROR 403 You’ve reached your usage limit for this billing cycle.'), true);
check('the bare sentence in plain prose is NOT usage-exhausted', hasKimiUsageExhausted(
  "You've reached your usage limit for this billing cycle."), false);
check('prose ABOUT the sentence is NOT usage-exhausted', hasKimiUsageExhausted(
  'I will match /you\'ve reached your usage limit for this billing cycle/i on error lines only.'), false);
check('a codex-style strong sentence without the billing-cycle wording is NOT kimi-exhausted',
  hasKimiUsageExhausted("■ You've hit your usage limit. Try again after the limit resets."), false);
check('the sentence inside a fence is NOT usage-exhausted', hasKimiUsageExhausted(
  '```\n■ ERROR 403 You\'ve reached your usage limit for this billing cycle.\n```'), false);
check('the sentence in a plain diff excerpt is NOT usage-exhausted', hasKimiUsageExhausted(
  "+ You've reached your usage limit for this billing cycle."), false);
check('an error-shaped diff line still counts (same carve-out as hasRateLimitError)',
  hasKimiUsageExhausted('+■ ERROR 403 You\'ve reached your usage limit for this billing cycle.'), true);
check('the sentence in a numbered code excerpt is NOT usage-exhausted', hasKimiUsageExhausted(
  '12 | ■ ERROR 403 You\'ve reached your usage limit for this billing cycle.'), false);
check('the sentence in a Tip line is NOT usage-exhausted', hasKimiUsageExhausted(
  'Tip: ■ ERROR 403 You\'ve reached your usage limit for this billing cycle.'), false);
check('the sentence as a js string literal is NOT usage-exhausted', hasKimiUsageExhausted(
  'const msg = "■ ERROR 403 You\'ve reached your usage limit for this billing cycle.";'), false);
check('a matching line later in the output still counts', hasKimiUsageExhausted(
  'some normal output\nworking...\n' + KIMI_403), true);
check('the contract-doc sentence is NOT usage-exhausted', hasKimiUsageExhausted(
  '403 ("You\'ve reached your usage limit for this billing cycle", error-shaped lines only, and'), false);
check('a double-quote-prefixed test-source line is NOT usage-exhausted', hasKimiUsageExhausted(
  '"\u26a0 You\'ve reached your usage limit for this billing cycle (HTTP 403)."), true);'), false);
check('a single-quote-prefixed test-source line is NOT usage-exhausted', hasKimiUsageExhausted(
  '\'\u25a0 ERROR 403 You’ve reached your usage limit for this billing cycle.\'), true);'), false);
check('worker narration mentioning 403 is NOT usage-exhausted', hasKimiUsageExhausted(
  "The server replied 403: You've reached your usage limit for this billing cycle, so I will stop."), false);
check('worker narration mentioning ERROR is NOT usage-exhausted', hasKimiUsageExhausted(
  "I handle the ERROR case where You've reached your usage limit for this billing cycle appears"), false);
for (const marker of ['`', '> ', '// ', '# ', '- ', '* ']) {
  check(`${marker.trim() || marker} source/list prefix is NOT usage-exhausted`, hasKimiUsageExhausted(
    `${marker}\u25a0 ERROR 403 You've reached your usage limit for this billing cycle.`), false);
}
check('a direct HTTP 403 prefix counts', hasKimiUsageExhausted(
  "HTTP 403: You've reached your usage limit for this billing cycle."), true);

// --- heartbeat classification (agent-scoped, RT-3) -----------------------------

const NOW = 1800000000000;
const baseCtx = {
  baseHandles: new Set(), ownHandles: new Set(['k1', 'c1']),
  started: NOW - 600000, now: NOW, idleSeconds: 90,
};

check('a kimi-agent terminal with the billing-cycle 403 is usage_exhausted',
  heartbeat.classifyTerminal(
    { handle: 'k1', preview: KIMI_403, lastOutputAt: NOW },
    { ...baseCtx, handleAgent: new Map([['k1', 'kimi'], ['c1', 'codex']]) }),
  { kind: 'usage_exhausted', coder: 'kimi' });

check('a codex-agent terminal showing the same sentence is NOT usage_exhausted',
  heartbeat.classifyTerminal(
    { handle: 'c1', preview: KIMI_403, lastOutputAt: NOW },
    { ...baseCtx, handleAgent: new Map([['k1', 'kimi'], ['c1', 'codex']]) }).kind,
  'rate_limit');

check('a kimi-agent terminal showing the sentence only as prose stays working',
  heartbeat.classifyTerminal(
    { handle: 'k1', preview: "note: You've reached your usage limit for this billing cycle.", lastOutputAt: NOW },
    { ...baseCtx, handleAgent: new Map([['k1', 'kimi']]) }).kind,
  'working');

check('without agent info the sentence is only a generic rate limit',
  heartbeat.classifyTerminal({ handle: 'k1', preview: KIMI_403, lastOutputAt: NOW }, baseCtx).kind,
  'rate_limit');

// once-per-handle reporting with the injected exhaustion hook
{
  const calls = [];
  heartbeat.setOnCoderExhausted((coder) => calls.push(coder));
  const reported = new Set();
  const event = heartbeat.reportUsageExhausted({ reported, handle: 'term_k1', label: 'term_k1 (Kimi worker)', coder: 'kimi' });
  check('the first usage-exhausted report emits the KIMI USAGE LIMIT event',
    typeof event === 'string' && event.startsWith('KIMI USAGE LIMIT on term_k1'), true);
  check('the event says to release and not retry',
    event.includes('release this worker, do not retry it until reset'), true);
  check('the exhaustion hook fired once for kimi', calls, ['kimi']);
  check('the same handle is not reported twice',
    heartbeat.reportUsageExhausted({ reported, handle: 'term_k1', label: 'term_k1 (Kimi worker)', coder: 'kimi' }), null);
  check('the exhaustion hook still fired only once', calls.length, 1);
  heartbeat.setOnCoderExhausted(null);
}

// --- caps accounting -----------------------------------------------------------

{
  const s = {
    workers: {
      ctx_k1: { status: 'live', agent: 'kimi', group: 'ctx_k1' },
      term_k1: { status: 'live', agent: 'kimi', group: 'ctx_k1' }, // same group: one worker
      ctx_k2: { status: 'live', agent: 'kimi', group: 'ctx_k2' },
      ctx_c1: { status: 'live', agent: 'codex', group: 'ctx_c1' },
      ctx_k3: { status: 'settled', agent: 'kimi', group: 'ctx_k3' },
      ctx_k4: { status: 'live', agent: 'kimi', group: 'ctx_k4', capExempt: true },
    },
    reservations: {
      'r1#0': { ts: Date.now(), agent: 'kimi', newSlot: true, kimiSlot: true },
      'r2#0': { ts: Date.now(), agent: 'codex', newSlot: true, codexSlot: true },
      'r3#0': { ts: Date.now(), codexSlot: true }, // legacy: no agent/newSlot fields
      'r4#0': { ts: Date.now(), agent: 'kimi', newSlot: false }, // replacement: holds no slot
      'r5#0': { ts: Date.now() - 20 * 60 * 1000, agent: 'kimi', newSlot: true }, // expired
    },
  };

  check('countPendingReservations counts live kimi reservations',
    OC.countPendingReservations(s, 'kimi'), 1);
  check('countPendingReservations counts codex reservations including legacy codexSlot',
    OC.countPendingReservations(s, 'codex'), 2);
  check('countPendingCodexReservations remains as the codex wrapper',
    OC.countPendingCodexReservations(s), 2);

  const kimiNames = POG.liveGroupIds(s, 'kimi');
  check('liveGroupIds names live kimi groups (cap-exempt suffixed, pending reservation named)',
    kimiNames, ['ctx_k1', 'ctx_k2', 'ctx_k4 (done, release it)', 'pending reservation r1#0 (expires in 10m)']);
  check('liveGroupIds for codex names codex groups and both codex reservations',
    POG.liveGroupIds(s, 'codex'), ['ctx_c1', 'pending reservation r2#0 (expires in 10m)', 'pending reservation r3#0 (expires in 10m)']);
  check('liveCodexGroupIds remains as the codex wrapper',
    POG.liveCodexGroupIds(s), POG.liveGroupIds(s, 'codex'));
}

// --- summary -------------------------------------------------------------------

if (failures.length) {
  console.error(`${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log(`${pass} passed, 0 failed`);
