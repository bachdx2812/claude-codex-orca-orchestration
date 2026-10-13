#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const availability = require('../hooks/lib/coder-availability.cjs');
const CODEX_STUB = path.join(__dirname, 'fixtures', 'codex-app-server-stub.cjs');
try { fs.chmodSync(CODEX_STUB, 0o755); } catch {}

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
function ok(name, value) { check(name, !!value, true); }

const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(ORCH_|CODEX_BIN|CODEX_HOME)/.test(key)));

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-availability-cache-'));
  const env = { ...baseEnv, ORCH_CODEX_BIN: CODEX_STUB };
  const disabled = availability.coderAvailability({ stateDir: root, fresh: true, disabled: ['codex'], env });
  check('disabled Codex is not probed',
    [disabled.codex.disabled, disabled.codex.usable, disabled.codex.reason],
    [true, false, 'disabled by config']);
  const enabled = availability.coderAvailability({ stateDir: root, fresh: true, disabled: [], env, codexAuthState: 'ok' });
  check('re-enabling Codex changes the availability result', enabled.codex.usable, true);
  fs.rmSync(root, { recursive: true, force: true });
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

if (failures.length) {
  console.error(`FAIL (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`PASS (${passed} checks)`);
