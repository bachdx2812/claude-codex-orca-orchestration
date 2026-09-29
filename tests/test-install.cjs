#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const INSTALLER = path.join(__dirname, '..', 'install.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-install-test-'));
const binDir = path.join(root, 'bin');
fs.mkdirSync(binDir);
try { fs.symlinkSync(process.execPath, path.join(binDir, 'node')); } catch {}
for (const bin of ['claude', 'orca', 'codex']) {
  const file = path.join(binDir, bin);
  fs.writeFileSync(file, '#!/bin/sh\necho "stub 1.0"\n');
  fs.chmodSync(file, 0o755);
}
let passed = 0;
const failures = [];

function run(args, homeName) {
  const home = path.join(root, homeName);
  fs.mkdirSync(home, { recursive: true });
  const result = spawnSync(process.execPath, [INSTALLER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
  });
  return { ...result, home };
}

function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

for (const [flag, homeName] of [['--help', 'help-long'], ['-h', 'help-short']]) {
  const result = run([flag], homeName);
  check(`${flag} exits successfully`, result.status, 0);
  check(`${flag} prints usage`, /Usage:/.test(result.stdout), true);
  check(`${flag} does not install`, fs.existsSync(path.join(result.home, '.claude')), false);
}

const unknown = run(['--definitely-unknown'], 'unknown');
check('an unknown option exits 2', unknown.status, 2);
check('an unknown option prints usage', /Usage:/.test(`${unknown.stdout}${unknown.stderr}`), true);
check('an unknown option does not install', fs.existsSync(path.join(unknown.home, '.claude')), false);

function seedForeignGate(home) {
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), `${JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [
        { type: 'command', command: 'node /custom/hooks/orchestrator-gate.cjs' },
        { type: 'command', command: 'node /custom/hooks/unrelated.cjs' },
      ] }],
    },
  }, null, 2)}\n`);
}

const checkHome = path.join(root, 'foreign-check');
fs.mkdirSync(checkHome, { recursive: true });
seedForeignGate(checkHome);
const foreignCheck = run(['--check'], 'foreign-check');
check('--check reports a foreign orchestrator gate as a problem',
  /PROBLEM.*foreign orchestrator-gate\.cjs/i.test(`${foreignCheck.stdout}${foreignCheck.stderr}`), true);

const keepHome = path.join(root, 'foreign-keep');
fs.mkdirSync(keepHome, { recursive: true });
seedForeignGate(keepHome);
const kept = run([], 'foreign-keep');
const keptSettings = JSON.parse(fs.readFileSync(path.join(kept.home, '.claude', 'settings.json'), 'utf8'));
check('install warns loudly about a foreign gate', /WARNING:.*foreign orchestrator-gate\.cjs/i.test(kept.stdout), true);
check('install keeps a foreign gate unless replacement is explicit',
  JSON.stringify(keptSettings).includes('/custom/hooks/orchestrator-gate.cjs'), true);
check('install explains the explicit replacement flag', kept.stdout.includes('--replace-foreign-gate'), true);

const replaceHome = path.join(root, 'foreign-replace');
fs.mkdirSync(replaceHome, { recursive: true });
seedForeignGate(replaceHome);
const replaced = run(['--replace-foreign-gate'], 'foreign-replace');
const replacedSettings = JSON.parse(fs.readFileSync(path.join(replaced.home, '.claude', 'settings.json'), 'utf8'));
const replacedText = JSON.stringify(replacedSettings);
check('--replace-foreign-gate removes the foreign registration',
  replacedText.includes('/custom/hooks/orchestrator-gate.cjs'), false);
check('--replace-foreign-gate preserves unrelated hooks in the same entry',
  replacedText.includes('/custom/hooks/unrelated.cjs'), true);
check('--replace-foreign-gate installs this package gate',
  replacedText.includes('/hooks/orchestration/orchestrator-gate.cjs'), true);
check('--replace-foreign-gate benefits from the normal settings backup',
  fs.readdirSync(path.join(replaced.home, '.claude')).some((name) => name.startsWith('settings.json.bak-')), true);

fs.rmSync(root, { recursive: true, force: true });
console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
