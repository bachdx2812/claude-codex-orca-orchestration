#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const quota = require('../hooks/lib/exec-route-by-quota.cjs');
const availability = require('../hooks/lib/coder-availability.cjs');
const pool = require('../hooks/lib/coder-pool-route.cjs');

const CODEX_STUB = path.join(__dirname, 'fixtures', 'codex-app-server-stub.cjs');
const KIMI_STUB = path.join(__dirname, 'fixtures', 'kimi-stub.cjs');
const KIMI_SERVER = path.join(__dirname, 'fixtures', 'kimi-usage-server.cjs');
const TOKEN = 'lane-a-fixture-token-never-leak';
for (const file of [CODEX_STUB, KIMI_STUB, KIMI_SERVER]) fs.chmodSync(file, 0o755);

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass += 1;
  else failures.push(`${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
}
function ok(name, value) { check(name, !!value, true); }
function temp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function credentials(home, value) {
  const dir = path.join(home, 'credentials');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kimi-code.json'), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
}
function envFor(home, extra = {}) {
  return {
    PATH: '', HOME: path.dirname(home), ORCH_KIMI_HOME: home, ORCH_KIMI_BIN: KIMI_STUB,
    ORCH_CODEX_BIN: CODEX_STUB, ...extra,
  };
}
function allFiles(root) {
  const out = [];
  for (const name of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, name.name);
    if (name.isDirectory()) out.push(...allFiles(file)); else out.push(file);
  }
  return out;
}

function startServer(extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [KIMI_SERVER], {
      env: { ...process.env, STUB_KIMI_TOKEN: TOKEN, ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; let errors = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/PORT (\d+)/);
      if (match && !child.resolved) {
        child.resolved = true;
        resolve({ child, port: Number(match[1]), output: () => output, errors: () => errors });
      }
    });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => { if (!child.resolved) reject(new Error(`server exited ${code}: ${errors}`)); });
  });
}
async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await new Promise((resolve) => server.child.once('exit', resolve));
}

async function run() {
  // Codex auth state, exact helper exit classification, and same-prompt availability rewrite.
  {
    const root = temp('coder-codex-'); const stateDir = path.join(root, 'state');
    const calls = path.join(root, 'calls.log');
    const old = { ...process.env };
    process.env.ORCH_CODEX_BIN = CODEX_STUB;
    process.env.CODEX_SESSIONS_DIR = path.join(root, 'empty-sessions');
    fs.mkdirSync(process.env.CODEX_SESSIONS_DIR);
    process.env.STUB_CODEX_CALLS_LOG = calls;
    process.env.STUB_CODEX_MODE = 'logged-out';
    const result = quota.codexQuota(Date.now(), { stateDir, cacheSeconds: 600 });
    check('codex logged-out probe returns the reserved auth state',
      [result.failed, result.authState], [true, 'logged-out']);
    check('codexAuthState reads logged-out without spawning', quota.codexAuthState(stateDir), 'logged-out');
    const map = availability.coderAvailability({
      stateDir, cacheSeconds: 600, now: Date.now(), codexAuthState: quota.codexAuthState(stateDir),
      orcaInstalled: true, env: envFor(path.join(root, 'kimi-home'), { ORCH_KIMI_BIN: path.join(root, 'missing-kimi') }),
    });
    check('codex is unusable on the same prompt that observes logout',
      [map.codex.usable, map.codex.reason], [false, 'not logged in']);
    const warmDir = path.join(root, 'warm-state');
    const warmUp = availability.coderAvailability({
      stateDir: warmDir, cacheSeconds: 600, now: Date.now(), codexAuthState: 'ok',
      orcaInstalled: true, env: envFor(path.join(root, 'kimi-home'), { ORCH_KIMI_BIN: path.join(root, 'missing-kimi') }),
    });
    check('warm availability cache starts usable', warmUp.codex.usable, true);
    const warmFlip = availability.coderAvailability({
      stateDir: warmDir, cacheSeconds: 600, now: Date.now(), codexAuthState: 'logged-out',
      orcaInstalled: true, env: envFor(path.join(root, 'kimi-home'), { ORCH_KIMI_BIN: path.join(root, 'missing-kimi') }),
    });
    check('cached-usable entry flips to unusable on the prompt that observes logout',
      [warmFlip.codex.usable, warmFlip.codex.reason], [false, 'not logged in']);
    const flipBack = availability.coderAvailability({
      stateDir, cacheSeconds: 600, now: Date.now(), codexAuthState: 'ok',
      orcaInstalled: true, env: envFor(path.join(root, 'kimi-home'), { ORCH_KIMI_BIN: path.join(root, 'missing-kimi') }),
    });
    check('a cache written while logged out is rejected once auth reads ok again',
      flipBack.codex.usable, true);
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

    const unsupportedDir = path.join(root, 'unsupported');
    process.env.STUB_CODEX_MODE = 'account-read-unsupported';
    const unsupported = quota.codexQuota(Date.now(), { stateDir: unsupportedDir, cacheSeconds: 60 });
    check('unsupported account/read stays auth unknown', quota.codexAuthState(unsupportedDir), 'unknown');
    check('unsupported account/read leaves Codex usable', unsupported, null);

    const childExit3 = path.join(root, 'exit-three.cjs');
    fs.writeFileSync(childExit3, '#!/usr/bin/env node\nprocess.exit(3);\n'); fs.chmodSync(childExit3, 0o755);
    process.env.ORCH_CODEX_BIN = childExit3;
    delete process.env.STUB_CODEX_MODE;
    const collisionDir = path.join(root, 'collision');
    quota.codexQuota(Date.now(), { stateDir: collisionDir, cacheSeconds: 60 });
    check('child app-server exit 3 is not misclassified as logged out', quota.codexAuthState(collisionDir), 'unknown');

    process.env.ORCH_CODEX_BIN = CODEX_STUB;
    process.env.STUB_CODEX_MODE = 'timeout';
    const timeoutDir = path.join(root, 'stub-timeout');
    const timeoutStarted = Date.now();
    const timedOut = quota.codexQuota(Date.now(), { stateDir: timeoutDir, cacheSeconds: 60 });
    check('codex stub timeout mode is quota unknown', timedOut, null);
    ok('codex stub timeout stays bounded', Date.now() - timeoutStarted < 6000);
    check('codex stub timeout leaves auth unknown', quota.codexAuthState(timeoutDir), 'unknown');

    process.env.STUB_CODEX_MODE = 'malformed';
    const malformedDir = path.join(root, 'stub-malformed');
    check('codex stub malformed mode is quota unknown',
      quota.codexQuota(Date.now(), { stateDir: malformedDir, cacheSeconds: 60 }), null);
    check('codex stub malformed leaves auth unknown', quota.codexAuthState(malformedDir), 'unknown');
    check('unknown auth after timeout/malformed keeps Codex usable',
      availability.probeCoderAvailability('codex', {
        env: envFor(path.join(root, 'kimi-home')), codexAuthState: quota.codexAuthState(malformedDir),
      }).usable, true);

    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
    fs.rmSync(root, { recursive: true, force: true });
  }

  // Availability probes are filesystem-only and respect authoritative test overrides.
  {
    const root = temp('coder-availability-'); const home = path.join(root, 'home');
    const missingEnv = envFor(home, { ORCH_CODEX_BIN: path.join(root, 'missing-codex'), ORCH_KIMI_BIN: path.join(root, 'missing-kimi') });
    check('missing Codex override is authoritative', availability.probeCoderAvailability('codex', { env: missingEnv }), {
      coder: 'codex', installed: false, binPath: null, auth: 'unknown', usable: false, reason: 'not installed',
    });
    check('missing Kimi override is authoritative', availability.probeCoderAvailability('kimi', { env: missingEnv }).reason, 'not installed');
    let result = availability.probeCoderAvailability('kimi', { env: envFor(home) });
    check('Kimi binary without credentials is not signed in', [result.installed, result.usable, result.reason], [true, false, 'not signed in']);
    credentials(home, { another: 'field' });
    result = availability.probeCoderAvailability('kimi', { env: envFor(home) });
    check('Kimi credentials without token are rejected', result.reason, 'not signed in');
    credentials(home, { access_token: TOKEN, expires_at: Date.now() - 1000 });
    result = availability.probeCoderAvailability('kimi', { env: envFor(home) });
    check('expired Kimi token still means CLI auth is present', [result.auth, result.usable], ['ok', true]);
    result = availability.probeCoderAvailability('kimi', { env: envFor(home), orcaInstalled: false });
    check('missing Orca excludes an installed coder', result.reason, 'orca not installed');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // Kimi live quota parsing and controlled failure kinds.
  {
    const now = Date.now();
    const parsed = quota.parseKimiUsages({
      usage: { limit: 100, remaining: 70, resetTime: new Date(now + 86400000).toISOString() },
      limits: [{ detail: { limit: 40, remaining: 10, resetTime: new Date(now + 3600000).toISOString() } }],
      usages: { limit_5h: { used_ratio: 0.6, reset_time: new Date(now + 7200000).toISOString() } },
    }, now);
    check('Kimi parser chooses tightest usage/detail/fallback window', Math.round(parsed.usedPercent), 75);
    check('Kimi parser turns a past reset into zero', quota.parseKimiUsages({
      usage: { limit: 10, remaining: 0, resetTime: new Date(now - 1000).toISOString() },
    }, now).usedPercent, 0);
    check('Kimi parser skips non-positive limits', quota.parseKimiUsages({ usage: { limit: 0, remaining: 0 } }, now), null);

    const root = temp('coder-kimi-quota-'); const home = path.join(root, 'home');
    credentials(home, { access_token: TOKEN, expires_at: Date.now() + 3600000 });
    let server = await startServer({ STUB_KIMI_BODY: JSON.stringify({
      usage: { limit: 100, remaining: 80, resetTime: new Date(Date.now() + 86400000).toISOString() },
      limits: [{ detail: { limit: 100, remaining: 45, resetTime: new Date(Date.now() + 3600000).toISOString() } }],
    }) });
    let stateDir = path.join(root, 'success');
    let result = quota.kimiQuota(Date.now(), {
      stateDir, cacheSeconds: 60, env: envFor(home, { ORCH_KIMI_USAGE_URL: `http://127.0.0.1:${server.port}/usages` }),
    });
    check('Kimi 200 response produces tightest used percentage', Math.round(result.usedPercent), 55);
    await new Promise((r) => setTimeout(r, 30));
    ok('Kimi server received the exact fixture authorization', /AUTH true/.test(server.output()));
    ok('Kimi fixture output never prints the token', !server.output().includes(TOKEN) && !server.errors().includes(TOKEN));
    await stopServer(server);

    for (const [status, kind] of [[401, 'unauthorized'], [403, 'unauthorized'], [500, 'http']]) {
      server = await startServer({ STUB_KIMI_STATUS: String(status), STUB_KIMI_ECHO_AUTH: status === 500 ? '1' : '0' });
      stateDir = path.join(root, `status-${status}`);
      result = quota.kimiQuota(Date.now(), {
        stateDir, cacheSeconds: 60, env: envFor(home, { ORCH_KIMI_USAGE_URL: `http://127.0.0.1:${server.port}/usages` }),
      });
      check(`Kimi HTTP ${status} is cached as ${kind}`, [result.failed, result.kind], [true, kind]);
      await stopServer(server);
    }
    server = await startServer({ STUB_KIMI_BODY: '{bad json' });
    result = quota.kimiQuota(Date.now(), {
      stateDir: path.join(root, 'bad-json'), cacheSeconds: 60,
      env: envFor(home, { ORCH_KIMI_USAGE_URL: `http://127.0.0.1:${server.port}/usages` }),
    });
    check('bad JSON becomes quota unknown', result.kind, 'parse');
    await stopServer(server);

    result = quota.kimiQuota(Date.now(), {
      stateDir: path.join(root, 'insecure'), cacheSeconds: 60,
      env: envFor(home, { ORCH_KIMI_USAGE_URL: 'http://example.com/usages' }),
    });
    check('remote plaintext Kimi URL is refused', result.kind, 'insecure-url');

    const malformedHome = path.join(root, 'malformed-home');
    credentials(malformedHome, `{"access_token":"${TOKEN}`);
    const helper = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'lib', 'kimi-quota-probe.cjs')], {
      encoding: 'utf8', env: { ORCH_KIMI_HOME: malformedHome, ORCH_KIMI_USAGE_URL: 'http://127.0.0.1:9/usages' },
    });
    check('malformed credentials return a controlled failure', JSON.parse(helper.stdout).kind, 'no-credentials');
    ok('malformed credential errors never leak the token', !`${helper.stdout}${helper.stderr}`.includes(TOKEN));

    const leakText = allFiles(root).map((file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }).join('\n');
    const outputFiles = allFiles(root).filter((f) => !f.includes(`${path.sep}credentials${path.sep}`));
    ok('no output or state file persists the bare fixture token', !outputFiles.some((f) => {
      try { return fs.readFileSync(f).includes(TOKEN); } catch { return false; }
    }));
    ok('controlled probe output does not surface echoed authorization', !leakText.includes(`Bearer ${TOKEN}`));
    fs.rmSync(root, { recursive: true, force: true });
  }

  // Expired credentials skip network; timeout is bounded and failure is memoized.
  {
    const root = temp('coder-kimi-latency-'); const home = path.join(root, 'home');
    credentials(home, { access_token: TOKEN, expires_at: Date.now() - 1000 });
    let server = await startServer();
    let result = quota.kimiQuota(Date.now(), {
      stateDir: path.join(root, 'expired'), cacheSeconds: 60,
      env: envFor(home, { ORCH_KIMI_USAGE_URL: `http://127.0.0.1:${server.port}/usages` }),
    });
    check('expired Kimi token returns quota unknown without refresh', result.kind, 'expired');
    await new Promise((r) => setTimeout(r, 50));
    check('expired Kimi token makes no network request', (server.output().match(/HIT /g) || []).length, 0);
    await stopServer(server);

    credentials(home, { access_token: TOKEN, expires_at: Date.now() + 3600000 });
    server = await startServer({ STUB_KIMI_DELAY_MS: '10000' });
    const stateDir = path.join(root, 'timeout');
    const started = Date.now();
    result = quota.kimiQuota(Date.now(), {
      stateDir, cacheSeconds: 60,
      env: envFor(home, { ORCH_KIMI_USAGE_URL: `http://127.0.0.1:${server.port}/usages` }),
    });
    const elapsed = Date.now() - started;
    check('Kimi timeout is a controlled unknown quota', result.kind, 'timeout');
    ok('cold Kimi timeout remains below five seconds', elapsed < 5000);
    const secondStarted = Date.now();
    quota.kimiQuota(Date.now() + 1, {
      stateDir, cacheSeconds: 60,
      env: envFor(home, { ORCH_KIMI_USAGE_URL: `http://127.0.0.1:${server.port}/usages` }),
    });
    ok('second in-process Kimi call is memoized', Date.now() - secondStarted < 150);
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }

  // Cross-process single-flight permits exactly one network request.
  {
    const root = temp('coder-kimi-flight-'); const home = path.join(root, 'home'); const stateDir = path.join(root, 'state');
    credentials(home, { access_token: TOKEN, expires_at: Date.now() + 3600000 });
    const server = await startServer({ STUB_KIMI_DELAY_MS: '150' });
    const lib = path.join(__dirname, '..', 'hooks', 'lib', 'exec-route-by-quota.cjs');
    const script = 'const q=require(process.argv[1]);const r=q.kimiQuota(Date.now(),{stateDir:process.argv[2],cacheSeconds:60,env:process.env});if(!r)process.exit(2)';
    await Promise.all(Array.from({ length: 5 }, () => new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', script, lib, stateDir], {
        env: envFor(home, { ORCH_KIMI_USAGE_URL: `http://127.0.0.1:${server.port}/usages` }),
      });
      child.on('exit', resolve);
    })));
    await new Promise((r) => setTimeout(r, 30));
    check('parallel Kimi quota calls make one server request', (server.output().match(/HIT /g) || []).length, 1);
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }

  // Pool routing table, including RT-4 null fallback and RT-9 threshold headroom.
  {
    const markerRoot = temp('coder-marker-');
    const markerNow = Date.now();
    check('exhaustion marker is written atomically', availability.markCoderExhausted(markerRoot, 'kimi', {
      now: markerNow, until: markerNow + 10000, reason: 'usage limit',
    }), true);
    check('active exhaustion marker is readable', availability.readCoderExhaustion(markerRoot, markerNow).kimi.reason, 'usage limit');
    check('expired exhaustion marker is dropped', availability.readCoderExhaustion(markerRoot, markerNow + 10000), {});
    check('exhaustion marker can be cleared', availability.clearCoderExhaustion(markerRoot, 'kimi'), true);
    check('cleared marker is absent', availability.readCoderExhaustion(markerRoot, markerNow), {});
    fs.rmSync(markerRoot, { recursive: true, force: true });

    const base = {
      availability: { codex: { usable: true }, kimi: { usable: true } },
      quotas: { codex: { usedPercent: 89 }, kimi: { usedPercent: 0 } },
      thresholds: { codex: 95, kimi: 95 }, exhaustion: {},
      live: { codex: 0, kimi: 0 }, caps: { codex: 3, kimi: 3 }, fallbackEnabled: true,
    };
    const pick = (overrides = {}) => pool.pickCoderPool({ ...base, ...overrides });
    check('more threshold headroom puts Kimi first', pick().order, ['kimi', 'codex']);
    check('Codex threshold exhaustion leaves Kimi only', pick({ quotas: { codex: { usedPercent: 95 }, kimi: { usedPercent: 1 } } }).order, ['kimi']);
    check('Kimi threshold exhaustion leaves Codex only', pick({ quotas: { codex: { usedPercent: 1 }, kimi: { usedPercent: 95 } } }).order, ['codex']);
    check('separate thresholds rank by own-threshold headroom', pick({
      quotas: { codex: { usedPercent: 50 }, kimi: { usedPercent: 60 } }, thresholds: { codex: 60, kimi: 95 },
    }).pick, 'kimi');
    check('active Kimi marker excludes it', pick({ exhaustion: { kimi: { at: Date.now(), until: Date.now() + 10000 } } }).order, ['codex']);
    check('newer healthy live quota supersedes marker', pick({
      quotas: { codex: { usedPercent: 89 }, kimi: { usedPercent: 0, fetchedAt: 200000 } },
      exhaustion: { kimi: { at: 100000, until: 300000 } },
    }).order, ['kimi', 'codex']);
    check('both exhausted route to in-session code', pick({ quotas: { codex: { usedPercent: 95 }, kimi: { usedPercent: 95 } } }).route, 'code');
    const unusable = pick({ availability: { codex: { usable: false, reason: 'not logged in' }, kimi: { usable: false, reason: 'not installed' } } });
    check('both unusable route to code with both reasons', [unusable.route, /not logged in/.test(unusable.why), /not installed/.test(unusable.why)], [ 'code', true, true ]);
    check('free capacity outranks quota headroom', pick({ live: { codex: 3, kimi: 2 } }).pick, 'kimi');
    // Fix 6 pick order (binding, 2026-10-01): MORE QUOTA LEFT first — more headroom beats
    // fewer live workers once the difference is outside the tie band. (`sessionLive` is
    // zeroed so the per-session free-slot key does not mask the headroom ordering.)
    check('more headroom beats fewer live workers outside the tie band', pick({
      live: { codex: 3, kimi: 0 }, sessionLive: { codex: 0, kimi: 0 },
      quotas: { codex: { usedPercent: 10 }, kimi: { usedPercent: 80 } },
    }).pick, 'codex');
    check('the pick reason names both headrooms', /more quota left: 85 vs 15/.test(pick({
      live: { codex: 3, kimi: 0 }, sessionLive: { codex: 0, kimi: 0 },
      quotas: { codex: { usedPercent: 10 }, kimi: { usedPercent: 80 } },
    }).why), true);
    check('within the tie band fewer live workers decides', pick({
      live: { codex: 3, kimi: 0 }, sessionLive: { codex: 0, kimi: 0 },
      quotas: { codex: { usedPercent: 20 }, kimi: { usedPercent: 10 } },
    }).pick, 'kimi');
    check('a wider configured tie band widens the tie', pick({
      live: { codex: 3, kimi: 0 }, sessionLive: { codex: 0, kimi: 0 },
      quotas: { codex: { usedPercent: 10 }, kimi: { usedPercent: 30 } },
      tieBand: 25,
    }).pick, 'kimi');
    check('an estimated quota reading counts as known headroom', pick({
      live: { codex: 3, kimi: 0 }, sessionLive: { codex: 0, kimi: 0 },
      quotas: { codex: { usedPercent: 5, estimated: true, fetchedAt: Date.now() - 2400000 }, kimi: { usedPercent: 85 } },
    }).pick, 'codex');
    check('an estimated quota reading surfaces in the summary', /~5% used \(est\.\)/.test(pick({
      quotas: { codex: { usedPercent: 89 }, kimi: { usedPercent: 5, estimated: true, fetchedAt: Date.now() } },
    }).summary), true);
    // Unknown headroom ranks as the assumed 30 points: below known >= 30, above known < 30.
    check('unknown headroom ranks below a coder with known headroom >= 30', pick({
      quotas: { codex: null, kimi: { usedPercent: 50 } },
    }).pick, 'kimi');
    check('unknown headroom ranks above a coder with known headroom < 30', pick({
      quotas: { codex: null, kimi: { usedPercent: 80 } },
    }).pick, 'codex');
    check('the assumed unknown value is configurable', pick({
      quotas: { codex: null, kimi: { usedPercent: 60 } }, unknownAssumed: 50,
    }).pick, 'codex');
    // N4 ruling: unknown NEVER ties with known — the tie band applies only between two
    // known headrooms. Known 35 vs assumed 30 decides directly, even against fewer live.
    check('unknown never ties with known within the band (known >= assumed wins despite more live)', pick({
      quotas: { codex: null, kimi: { usedPercent: 60 } },
      live: { codex: 0, kimi: 5 }, sessionLive: { codex: 0, kimi: 0 },
    }).pick, 'kimi');
    check('known below the assumed value ranks under unknown even with more live', pick({
      quotas: { codex: null, kimi: { usedPercent: 70 } },
      live: { codex: 5, kimi: 0 }, sessionLive: { codex: 0, kimi: 0 },
    }).pick, 'codex');
    check('the per-session cap still outranks more headroom', pick({
      sessionLive: { codex: 3, kimi: 0 }, live: { codex: 3, kimi: 0 },
      quotas: { codex: { usedPercent: 0 }, kimi: { usedPercent: 90 } },
    }).pick, 'kimi');
    check('fewer live workers beats quota headroom', pick({
      live: { codex: 2, kimi: 0 }, quotas: { codex: { usedPercent: 10 }, kimi: { usedPercent: 20 } },
    }).pick, 'kimi');
    const bothAtCap = pick({ live: { codex: 3, kimi: 3 } });
    check('both at cap stay external and rank by headroom', bothAtCap.route, 'external');
    ok('both at cap tells the operator to wait', /all at cap, wait/.test(bothAtCap.why));
    const machineAtCapSessionFree = pick({ live: { codex: 4, kimi: 4 }, sessionLive: { codex: 0, kimi: 0 } });
    check('machine-wide at cap but session free still picks a coder', machineAtCapSessionFree.route, 'external');
    ok('machine-wide at cap but session free never says wait', !/all at cap, wait/.test(machineAtCapSessionFree.why));
    const sessionAtCapMachineOver = pick({ live: { codex: 5, kimi: 5 }, sessionLive: { codex: 3, kimi: 3 } });
    ok('this session at its own cap for every coder says wait', /all at cap, wait/.test(sessionAtCapMachineOver.why));
    check('free per-session slot outranks fewer machine-wide live', pick({
      live: { codex: 3, kimi: 9 }, sessionLive: { codex: 3, kimi: 1 },
    }).pick, 'kimi');
    check('machine-wide live still orders among sessions with free slots', pick({
      live: { codex: 3, kimi: 0 }, sessionLive: { codex: 1, kimi: 0 },
    }).pick, 'kimi');
    check('unknown quota ranks by fewer live workers', pick({ quotas: { codex: null, kimi: null }, live: { codex: 2, kimi: 1 } }).pick, 'kimi');
    check('unknown quota tie prefers Codex', pick({ quotas: { codex: null, kimi: null } }).pick, 'codex');
    check('fallback false no longer resurrects an unusable Codex', pick({
      availability: { codex: { usable: false, reason: 'not logged in' }, kimi: { usable: false, reason: 'not installed' } }, fallbackEnabled: false,
    }).route, 'code');
    check('alternation prefers the coder that did not run last (codex)', pick({
      quotas: { codex: { usedPercent: 10 }, kimi: { usedPercent: 10 } }, lastCoder: 'codex',
    }).pick, 'kimi');
    check('alternation prefers the coder that did not run last (kimi)', pick({
      quotas: { codex: { usedPercent: 10 }, kimi: { usedPercent: 10 } }, lastCoder: 'kimi',
    }).pick, 'codex');
    check('a lastCoder that is not eligible is ignored', pick({
      quotas: { codex: { usedPercent: 1 }, kimi: { usedPercent: 95 } }, lastCoder: 'kimi',
    }).pick, 'codex');
    check('an unknown lastCoder value is ignored', pick({
      quotas: { codex: { usedPercent: 10 }, kimi: { usedPercent: 10 } }, lastCoder: 'bogus',
    }).pick, 'codex');
    const spread = pick({ live: { codex: 2, kimi: 0 }, quotas: { codex: { usedPercent: 10 }, kimi: { usedPercent: 20 } } });
    ok('why names the spread reason', /auto: spread, pick Kimi \(fewer live\)/.test(spread.why));
    check('omitted thresholds never compare NaN', pick({
      quotas: { codex: { usedPercent: 80 }, kimi: { usedPercent: 50 } }, thresholds: {},
    }).pick, 'kimi');
    check('omitted thresholds still rank by headroom against the default', pick({
      quotas: { codex: { usedPercent: 96 }, kimi: { usedPercent: 50 } }, thresholds: {},
    }).pick, 'kimi');
    check('null fallback plus exhausted Codex and missing Kimi routes to code', pick({
      availability: { codex: { usable: true }, kimi: { usable: false, reason: 'not installed' } },
      quotas: { codex: { usedPercent: 95 }, kimi: null }, fallbackEnabled: null,
    }).route, 'code');
    check('null fallback preserves legacy missing-Codex external route', pick({
      availability: { codex: { usable: false, reason: 'not installed' }, kimi: { usable: false, reason: 'not installed' } },
      quotas: { codex: null, kimi: null }, fallbackEnabled: null,
    }).order, ['codex']);
    check('formatter reports unknown available quota', pool.formatCoderState('kimi', { state: 'eligible', leftPct: null }), 'Kimi (quota unknown, available)');
  }

  // Fix 6: persisted last-known quota + reset-aware estimate. Stubs only: the reading is
  // persisted directly, and the probe is pointed at an unreachable binary so the estimate
  // path is the only one that can answer.
  {
    const root = temp('coder-last-known-'); const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const now = Date.now();
    check('no reading ever means estimate unknown', quota.estimatedQuota(stateDir, 'kimi', now), null);
    quota.persistLastKnownQuota(stateDir, 'kimi', {
      usedPercent: 40, resetsAt: Math.floor((now + 3600000) / 1000),
      windows: [
        { usedPercent: 40, resetsAt: Math.floor((now + 3600000) / 1000) },
        { usedPercent: 90, resetsAt: Math.floor((now - 60000) / 1000) }, // already reset
      ],
    }, now - 2400000);
    const est = quota.estimatedQuota(stateDir, 'kimi', now);
    check('a reset window counts as 0% used, an unreset window keeps its reading',
      [est.usedPercent, est.estimated, est.source], [40, true, 'estimate']);
    check('the estimate carries the original read time', est.fetchedAt, now - 2400000);
    quota.persistLastKnownQuota(stateDir, 'codex', { usedPercent: 88, resetsAt: 0 }, now - 1000);
    check('a reading without a reset time is kept as-is', quota.estimatedQuota(stateDir, 'codex', now).usedPercent, 88);

    // codexQuota end-to-end: live probe fails (missing binary), no session log, so the
    // estimate from the persisted reading answers instead of "unknown".
    const old = { ORCH_CODEX_BIN: process.env.ORCH_CODEX_BIN, CODEX_SESSIONS_DIR: process.env.CODEX_SESSIONS_DIR };
    process.env.ORCH_CODEX_BIN = path.join(root, 'missing-codex');
    process.env.CODEX_SESSIONS_DIR = path.join(root, 'empty-sessions');
    fs.mkdirSync(process.env.CODEX_SESSIONS_DIR);
    const integrated = quota.codexQuota(now, { stateDir, cacheSeconds: 60 });
    check('codexQuota falls back to the estimate when nothing live answers',
      [integrated.usedPercent, integrated.estimated], [88, true]);
    const estKimi = quota.kimiQuota(now, {
      stateDir, cacheSeconds: 60,
      env: envFor(path.join(root, 'kimi-home-empty'), { ORCH_KIMI_USAGE_URL: 'http://127.0.0.1:9/usages' }),
    });
    check('kimiQuota falls back to the estimate when the live read fails',
      [estKimi.usedPercent, estKimi.estimated], [40, true]);
    // A fresh successful reading persists as the new last-known and is returned live.
    // (Separate state dir: the failed probe above cached a fresh failure in `stateDir`.)
    const liveStateDir = path.join(root, 'state-live');
    const home = path.join(root, 'kimi-home');
    credentials(home, { access_token: TOKEN, expires_at: Date.now() + 3600000 });
    const server = await startServer({});
    const live = quota.kimiQuota(Date.now(), {
      stateDir: liveStateDir, cacheSeconds: 60,
      env: envFor(home, { ORCH_KIMI_USAGE_URL: `http://127.0.0.1:${server.port}/usages` }),
    });
    await stopServer(server);
    ok('a successful live Kimi read is returned live, not estimated', live && !live.estimated && !live.failed);
    check('the successful read replaces the persisted last-known',
      quota.estimatedQuota(liveStateDir, 'kimi', Date.now()).usedPercent, live.usedPercent);
    if (old.ORCH_CODEX_BIN === undefined) delete process.env.ORCH_CODEX_BIN; else process.env.ORCH_CODEX_BIN = old.ORCH_CODEX_BIN;
    if (old.CODEX_SESSIONS_DIR === undefined) delete process.env.CODEX_SESSIONS_DIR; else process.env.CODEX_SESSIONS_DIR = old.CODEX_SESSIONS_DIR;

    // B1: a session-log reading keeps per-window reset times, so the estimate ages out
    // instead of pinning the coder as exhausted forever.
    const sessions = path.join(root, 'sessions-b1');
    fs.mkdirSync(path.join(sessions, '2026', '09', '29'), { recursive: true });
    const b1State = path.join(root, 'state-b1'); fs.mkdirSync(b1State, { recursive: true });
    const t0 = Date.now();
    fs.writeFileSync(path.join(sessions, '2026', '09', '29', 's.jsonl'),
      JSON.stringify({ timestamp: new Date(t0).toISOString(), payload: { rate_limits: {
        primary: { used_percent: 97, resets_at: Math.floor(t0 / 1000) + 3600 } } } }) + '\n');
    process.env.ORCH_CODEX_BIN = path.join(root, 'missing-codex');
    process.env.CODEX_SESSIONS_DIR = sessions;
    const b1First = quota.codexQuota(t0, { stateDir: b1State, cacheSeconds: 60 });
    check('a session-log reading is used while fresh', [b1First.usedPercent, b1First.source], [97, 'session log']);
    check('the persisted last-known keeps the window reset time',
      quota.estimatedQuota(b1State, 'codex', t0 + 30 * 60000).usedPercent, 97);
    // Session log rotated away, live probe still failing, and the window has since reset:
    fs.rmSync(sessions, { recursive: true, force: true }); fs.mkdirSync(sessions);
    const b1Later = quota.codexQuota(t0 + 2 * 3600e3, { stateDir: b1State, cacheSeconds: 60 });
    check('a 97% session-log reading no longer exhausts Codex after the window reset',
      [b1Later.usedPercent, b1Later.estimated], [0, true]);
    check('the post-reset estimate makes the coder eligible, not exhausted',
      pool.pickCoderPool({
        availability: { codex: { usable: true }, kimi: { usable: true } },
        quotas: { codex: b1Later, kimi: { usedPercent: 10 } }, thresholds: { codex: 95, kimi: 95 },
        exhaustion: {}, live: { codex: 0, kimi: 0 }, caps: { codex: 3, kimi: 3 }, fallbackEnabled: true,
      }).coders.codex.state, 'eligible');
    // A window with NO reset time is dropped once the reading is older than 5h.
    const t1 = Date.now();
    quota.persistLastKnownQuota(b1State, 'kimi', { usedPercent: 97, resetsAt: 0 }, t1);
    check('a resetless window is still trusted within the bound',
      quota.estimatedQuota(b1State, 'kimi', t1 + 3600e3).usedPercent, 97);
    check('a resetless window older than the bound drops to unknown',
      quota.estimatedQuota(b1State, 'kimi', t1 + 6 * 3600e3), null);

    // N1: readAt is the reading's own fetchedAt, and a cache-hit shape never rewrites it.
    const n1State = path.join(root, 'state-n1'); fs.mkdirSync(n1State, { recursive: true });
    const fetchedAt = Date.now() - 1800e3;
    quota.persistLastKnownQuota(n1State, 'codex', { usedPercent: 50, resetsAt: 0, fetchedAt });
    const n1File = path.join(n1State, 'codex-quota-last-known.json');
    const n1Before = fs.readFileSync(n1File, 'utf8');
    check('readAt is the reading own fetchedAt, not the call time', JSON.parse(n1Before).readAt, fetchedAt);
    quota.persistLastKnownQuota(n1State, 'codex', { usedPercent: 99, resetsAt: 0, fetchedAt });
    check('the same reading (a cache hit) is never rewritten', fs.readFileSync(n1File, 'utf8'), n1Before);
    if (old.ORCH_CODEX_BIN === undefined) delete process.env.ORCH_CODEX_BIN; else process.env.ORCH_CODEX_BIN = old.ORCH_CODEX_BIN;
    if (old.CODEX_SESSIONS_DIR === undefined) delete process.env.CODEX_SESSIONS_DIR; else process.env.CODEX_SESSIONS_DIR = old.CODEX_SESSIONS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  }

  process.stdout.write(`${pass} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
    process.exitCode = 1;
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
