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
for (const bin of ['claude', 'orca', 'codex', 'kimi']) {
  const file = path.join(binDir, bin);
  fs.writeFileSync(file, '#!/bin/sh\necho "stub 1.0"\n');
  fs.chmodSync(file, 0o755);
}
let passed = 0;
const failures = [];

function run(args, homeName, extraEnv = {}) {
  const home = path.join(root, homeName);
  fs.mkdirSync(home, { recursive: true });
  const result = spawnSync(process.execPath, [INSTALLER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`, ...extraEnv },
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

function seedLookalikeGate(home) {
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), `${JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [
        { type: 'command', command: 'node /custom/hooks/test-orchestrator-gate.cjs' },
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
check('--check exits 1 when it reports a problem', foreignCheck.status, 1);

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

const dryRunHome = path.join(root, 'foreign-dry-run');
fs.mkdirSync(dryRunHome, { recursive: true });
seedForeignGate(dryRunHome);
const dryRunReplace = run(['--dry-run', '--replace-foreign-gate'], 'foreign-dry-run');
check('--dry-run --replace-foreign-gate describes the removal conditionally',
  /would remove 1 foreign orchestrator-gate\.cjs registration/.test(dryRunReplace.stdout), true);
check('--dry-run --replace-foreign-gate does not claim it removed registrations',
  /WARNING: removed 1 foreign orchestrator-gate\.cjs registration/.test(dryRunReplace.stdout), false);

const lookalikeHome = path.join(root, 'foreign-lookalike');
fs.mkdirSync(lookalikeHome, { recursive: true });
seedLookalikeGate(lookalikeHome);
const lookalike = run(['--replace-foreign-gate'], 'foreign-lookalike');
const lookalikeSettings = JSON.parse(fs.readFileSync(path.join(lookalike.home, '.claude', 'settings.json'), 'utf8'));
check('--replace-foreign-gate preserves test-orchestrator-gate.cjs',
  JSON.stringify(lookalikeSettings).includes('/custom/hooks/test-orchestrator-gate.cjs'), true);

const missingHome = 'check-missing-artifact';
const installedForMissing = run([], missingHome);
check('fixture install for missing-artifact check succeeds', installedForMissing.status, 0);
const missingManifest = JSON.parse(fs.readFileSync(
  path.join(installedForMissing.home, '.claude', 'hooks', 'orchestration', 'install-manifest.json'), 'utf8'));
fs.unlinkSync(path.join(installedForMissing.home, '.claude', 'hooks', 'orchestration', missingManifest.files[0]));
const missingCheck = run(['--check'], missingHome);
check('--check prints MISS for a missing installed artifact', /\bMISS\b/.test(missingCheck.stdout), true);
check('--check exits 1 whenever it prints MISS', missingCheck.status, 1);

// --- coder availability section (stubs only: fake codex/kimi binaries, tmp Kimi homes,
// an unreachable usage URL; nothing touches real ~/.kimi-code, real codex, or the network)
const emptyKimiHome = path.join(root, 'kimi-home-empty');
fs.mkdirSync(emptyKimiHome, { recursive: true });
const emptyEnv = {
  ORCH_KIMI_HOME: emptyKimiHome,
  ORCH_KIMI_USAGE_URL: 'http://127.0.0.1:9/usages',
  ORCH_KIMI_HANDOFF_USED: '80',
  ORCH_OPENCODE_BIN: path.join(root, 'missing-opencode'),
};
const emptyCheck = run(['--check'], 'check-kimi-empty', emptyEnv);
const emptyOut = `${emptyCheck.stdout}${emptyCheck.stderr}`;
check('--check exits 0 on a clean machine with no install problems', emptyCheck.status, 0);
check('--check prints the effective thresholds with env overrides applied',
  /codexHandoffUsedPercent=95 kimiHandoffUsedPercent=80 maxParallelKimiWorkers=3/.test(emptyOut), true);
check('--check reports the codex coder line (stub binary, auth unknown, quota unreadable)',
  /coder codex: usable \[binary [^\]]*stub 1\.0, auth unknown, quota unknown\]/.test(emptyOut), true);
check('--check reports kimi unusable when no credentials exist',
  /coder kimi: UNUSABLE \(not signed in\)/.test(emptyOut), true);
check('--check reports deepseek unusable when opencode is absent',
  /coder deepseek: UNUSABLE \(not installed\)/.test(emptyOut), true);
check('--check prints the coder pool summary',
  /pool: Codex quota unknown, available \(0\/3 live\) or Kimi \(unusable: not signed in\) or DeepSeek \(unusable: not installed\); pick Codex/.test(emptyOut), true);

const credsKimiHome = path.join(root, 'kimi-home-creds');
fs.mkdirSync(path.join(credsKimiHome, 'credentials'), { recursive: true });
const FIXTURE_TOKEN = 'fixture-token-9f8e7d6c5b4a-never-print';
fs.writeFileSync(path.join(credsKimiHome, 'credentials', 'kimi-code.json'),
  JSON.stringify({ access_token: FIXTURE_TOKEN, expires_at: Date.now() + 3600e3 }));
const credsCheck = run(['--check'], 'check-kimi-creds', {
  ORCH_KIMI_HOME: credsKimiHome,
  ORCH_KIMI_USAGE_URL: 'http://127.0.0.1:9/usages',
  ORCH_OPENCODE_BIN: path.join(root, 'missing-opencode'),
});
const credsOut = `${credsCheck.stdout}${credsCheck.stderr}`;
check('--check reports kimi usable once credentials exist (quota unknown on an unreachable URL)',
  /coder kimi: usable \[binary [^\]]*stub 1\.0, auth ok, quota unknown\]/.test(credsOut), true);
check('--check never prints the Kimi access token', credsOut.includes(FIXTURE_TOKEN), false);

// --- shipped agent definitions (agents/sonnet-coder.md): created only when absent, ------
// --- never overwritten, removed on uninstall only when still the shipped original -------
const SHIPPED_AGENT = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sonnet-coder.md'), 'utf8');
{
  const fresh = run([], 'agents-fresh');
  const dest = path.join(fresh.home, '.claude', 'agents', 'sonnet-coder.md');
  check('install ships agents/sonnet-coder.md', fs.existsSync(dest), true);
  check('the shipped agent definition matches the repo original',
    fs.existsSync(dest) && fs.readFileSync(dest, 'utf8'), SHIPPED_AGENT);

  // A user edit is never overwritten by a re-install, and never removed by uninstall.
  fs.writeFileSync(dest, 'user-edited agent definition\n');
  const again = run([], 'agents-fresh');
  check('re-install never overwrites a user-edited agent definition',
    fs.readFileSync(dest, 'utf8'), 'user-edited agent definition\n');
  const uninstEdited = run(['--uninstall'], 'agents-fresh');
  check('uninstall exits successfully with an edited agent present', uninstEdited.status, 0);
  check('uninstall leaves a user-edited agent definition in place', fs.existsSync(dest), true);
  check('uninstall warns about the edited agent definition',
    /WARNING:.*sonnet-coder\.md was edited since install/i.test(`${uninstEdited.stdout}${uninstEdited.stderr}`), true);

  // An untouched, installer-created agent definition IS removed on uninstall.
  const clean = run([], 'agents-clean');
  const cleanDest = path.join(clean.home, '.claude', 'agents', 'sonnet-coder.md');
  check('clean install ships the agent definition', fs.existsSync(cleanDest), true);
  const uninstClean = run(['--uninstall'], 'agents-clean');
  check('clean uninstall exits successfully', uninstClean.status, 0);
  check('uninstall removes an unmodified installer-created agent definition', fs.existsSync(cleanDest), false);

  // A pre-existing (not installer-created) agent definition is left alone by both.
  const pre = run([], 'agents-preexisting');
  const preDestDir = path.join(pre.home, '.claude', 'agents');
  fs.mkdirSync(preDestDir, { recursive: true });
  fs.writeFileSync(path.join(preDestDir, 'sonnet-coder.md'), 'my own agent\n');
  const pre2 = run([], 'agents-preexisting');
  check('install leaves a pre-existing agent definition untouched',
    fs.readFileSync(path.join(preDestDir, 'sonnet-coder.md'), 'utf8'), 'my own agent\n');
  const uninstPre = run(['--uninstall'], 'agents-preexisting');
  check('uninstall of a pre-existing agent definition exits successfully', uninstPre.status, 0);
  check('uninstall leaves a pre-existing agent definition in place',
    fs.existsSync(path.join(preDestDir, 'sonnet-coder.md')), true);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
