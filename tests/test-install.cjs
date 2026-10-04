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
const launchctlLog = path.join(root, 'launchctl.log');
try { fs.symlinkSync(process.execPath, path.join(binDir, 'node')); } catch {}
for (const bin of ['claude', 'orca', 'codex', 'kimi']) {
  const file = path.join(binDir, bin);
  fs.writeFileSync(file, '#!/bin/sh\necho "stub 1.0"\n');
  fs.chmodSync(file, 0o755);
}
fs.copyFileSync(path.join(__dirname, 'fixtures', 'launchctl-stub.cjs'), path.join(binDir, 'launchctl'));
fs.chmodSync(path.join(binDir, 'launchctl'), 0o755);
let passed = 0;
const failures = [];

function run(args, homeName, extraEnv = {}) {
  const home = path.join(root, homeName);
  fs.mkdirSync(home, { recursive: true });
  const result = spawnSync(process.execPath, [INSTALLER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      STUB_LAUNCHCTL_LOG: launchctlLog, ...extraEnv },
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
const janitorPlist = path.join(installedForMissing.home, 'Library', 'LaunchAgents',
  'com.orca.claude-codex-orchestration.janitor.plist');
check('install writes the janitor LaunchAgent on macOS', process.platform !== 'darwin' || fs.existsSync(janitorPlist), true);
check('the janitor LaunchAgent uses the default ten-minute interval', process.platform !== 'darwin' ||
  fs.readFileSync(janitorPlist, 'utf8').includes('<integer>600</integer>'), true);
check('the janitor LaunchAgent preserves an executable search path for orca and gh', process.platform !== 'darwin' ||
  fs.readFileSync(janitorPlist, 'utf8').includes('<key>PATH</key>'), true);
check('the janitor LaunchAgent captures stderr in the bounded janitor log', process.platform !== 'darwin' ||
  fs.readFileSync(janitorPlist, 'utf8').includes('<key>StandardErrorPath</key>'), true);
check('install registers the janitor with launchctl', process.platform !== 'darwin' ||
  fs.readFileSync(launchctlLog, 'utf8').includes(`bootstrap gui/${process.getuid()} ${janitorPlist}`), true);

if (process.platform === 'darwin') {
  const clampedHome = path.join(root, 'janitor-clamped');
  fs.mkdirSync(path.join(clampedHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(clampedHome, '.claude', 'orchestration.config.json'),
    JSON.stringify({ janitor: { intervalMinutes: 5000 } }));
  const clamped = run([], 'janitor-clamped');
  const clampedPlist = fs.readFileSync(path.join(clamped.home, 'Library', 'LaunchAgents',
    'com.orca.claude-codex-orchestration.janitor.plist'), 'utf8');
  check('the janitor LaunchAgent uses the validated 1-1440 interval', clamped.status, 0);
  check('an out-of-range interval falls back to the validated default', clampedPlist.includes('<integer>600</integer>'), true);
}
const missingManifest = JSON.parse(fs.readFileSync(
  path.join(installedForMissing.home, '.claude', 'hooks', 'orchestration', 'install-manifest.json'), 'utf8'));
fs.unlinkSync(path.join(installedForMissing.home, '.claude', 'hooks', 'orchestration', missingManifest.files[0]));
const missingCheck = run(['--check'], missingHome);
check('--check prints MISS for a missing installed artifact', /\bMISS\b/.test(missingCheck.stdout), true);
check('--check exits 1 whenever it prints MISS', missingCheck.status, 1);

if (process.platform === 'darwin') {
  const preexistingHome = path.join(root, 'janitor-preexisting');
  const preexistingPlist = path.join(preexistingHome, 'Library', 'LaunchAgents',
    'com.orca.claude-codex-orchestration.janitor.plist');
  fs.mkdirSync(path.dirname(preexistingPlist), { recursive: true });
  fs.writeFileSync(preexistingPlist, 'pre-existing launch agent\n');
  const installed = run([], 'janitor-preexisting');
  check('install with a pre-existing janitor plist succeeds', installed.status, 0);
  check('install activates this package janitor over the backed-up plist',
    fs.readFileSync(preexistingPlist, 'utf8').includes('orca-janitor.cjs'), true);
  const uninstalled = run(['--uninstall'], 'janitor-preexisting');
  check('uninstall with a pre-existing janitor plist succeeds', uninstalled.status, 0);
  check('uninstall restores the pre-existing janitor plist',
    fs.readFileSync(preexistingPlist, 'utf8'), 'pre-existing launch agent\n');
}

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

// --- Codex service_tier = "priority"/"fast" surfacing (never edits the operator's config) --
function writeCodexConfig(home, text) {
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), text);
}

const priorityHome = path.join(root, 'codex-priority-tier');
fs.mkdirSync(priorityHome, { recursive: true });
writeCodexConfig(priorityHome, 'service_tier = "priority"\n');
const priorityCheck = run(['--check'], 'codex-priority-tier');
check('--check warns about a top-level service_tier = "priority"',
  /WARNING:.*config\.toml.*service_tier = "priority"/i.test(`${priorityCheck.stdout}${priorityCheck.stderr}`), true);

const fastHome = path.join(root, 'codex-fast-tier');
fs.mkdirSync(fastHome, { recursive: true });
writeCodexConfig(fastHome, 'service_tier = "fast"\n');
const fastCheck = run(['--check'], 'codex-fast-tier');
check('--check warns about a top-level service_tier = "fast" too',
  /WARNING:.*service_tier = "fast"/i.test(`${fastCheck.stdout}${fastCheck.stderr}`), true);

const absentHome = path.join(root, 'codex-tier-absent');
fs.mkdirSync(absentHome, { recursive: true });
writeCodexConfig(absentHome, 'model = "gpt-5"\n');
const absentCheck = run(['--check'], 'codex-tier-absent');
check('--check does not warn when no service_tier is set',
  /service_tier/i.test(`${absentCheck.stdout}${absentCheck.stderr}`), false);

const flexHome = path.join(root, 'codex-tier-flex');
fs.mkdirSync(flexHome, { recursive: true });
writeCodexConfig(flexHome, 'service_tier = "flex"\n');
const flexCheck = run(['--check'], 'codex-tier-flex');
check('--check does not warn for a non-priority tier such as "flex"',
  /service_tier/i.test(`${flexCheck.stdout}${flexCheck.stderr}`), false);

const defaultHome = path.join(root, 'codex-tier-default');
fs.mkdirSync(defaultHome, { recursive: true });
writeCodexConfig(defaultHome, 'service_tier = "default"\n');
const defaultTierCheck = run(['--check'], 'codex-tier-default');
check('--check does not warn for the "default" tier',
  /service_tier/i.test(`${defaultTierCheck.stdout}${defaultTierCheck.stderr}`), false);

const nonDefaultProfileHome = path.join(root, 'codex-tier-non-default-profile');
fs.mkdirSync(nonDefaultProfileHome, { recursive: true });
writeCodexConfig(nonDefaultProfileHome,
  'profile = "work"\n\n[profiles.work]\nmodel = "gpt-5"\n\n[profiles.other]\nservice_tier = "priority"\n');
const nonDefaultProfileCheck = run(['--check'], 'codex-tier-non-default-profile');
check('--check does not warn about a priority tier set on a non-default profile',
  /service_tier/i.test(`${nonDefaultProfileCheck.stdout}${nonDefaultProfileCheck.stderr}`), false);

const defaultProfileHome = path.join(root, 'codex-tier-default-profile');
fs.mkdirSync(defaultProfileHome, { recursive: true });
writeCodexConfig(defaultProfileHome, 'profile = "work"\n\n[profiles.work]\nservice_tier = "priority"\n');
const defaultProfileCheck = run(['--check'], 'codex-tier-default-profile');
check('--check warns about a priority tier set on the default profile',
  /WARNING:.*service_tier = "priority"/i.test(`${defaultProfileCheck.stdout}${defaultProfileCheck.stderr}`), true);

const allowHome = path.join(root, 'codex-tier-allowed');
fs.mkdirSync(path.join(allowHome, '.claude'), { recursive: true });
fs.writeFileSync(path.join(allowHome, '.claude', 'orchestration.config.json'),
  JSON.stringify({ codexAllowPriorityTier: true }));
writeCodexConfig(allowHome, 'service_tier = "priority"\n');
const allowCheck = run(['--check'], 'codex-tier-allowed');
check('codexAllowPriorityTier: true silences the warning',
  /service_tier/i.test(`${allowCheck.stdout}${allowCheck.stderr}`), false);

const singleQuotedHome = path.join(root, 'codex-tier-single-quoted');
fs.mkdirSync(singleQuotedHome, { recursive: true });
writeCodexConfig(singleQuotedHome, "service_tier = 'priority'\n");
const singleQuotedCheck = run(['--check'], 'codex-tier-single-quoted');
check('--check warns about a single-quoted top-level service_tier',
  /WARNING:.*service_tier = 'priority'/i.test(`${singleQuotedCheck.stdout}${singleQuotedCheck.stderr}`), true);

const dottedKeyHome = path.join(root, 'codex-tier-dotted-key');
fs.mkdirSync(dottedKeyHome, { recursive: true });
writeCodexConfig(dottedKeyHome, 'profile = "work"\nprofiles.work.service_tier = "fast"\n');
const dottedKeyCheck = run(['--check'], 'codex-tier-dotted-key');
check('--check warns about a dotted-key profile service_tier on the default profile',
  /WARNING:.*service_tier = "fast"/i.test(`${dottedKeyCheck.stdout}${dottedKeyCheck.stderr}`), true);

const quotedSectionHome = path.join(root, 'codex-tier-quoted-section');
fs.mkdirSync(quotedSectionHome, { recursive: true });
writeCodexConfig(quotedSectionHome, 'profile = "work"\n\n[profiles."work"]\nservice_tier = "priority"\n');
const quotedSectionCheck = run(['--check'], 'codex-tier-quoted-section');
check('--check warns about a priority tier under a quoted default-profile section name',
  /WARNING:.*service_tier = "priority"/i.test(`${quotedSectionCheck.stdout}${quotedSectionCheck.stderr}`), true);

const overriddenByFlexHome = path.join(root, 'codex-tier-overridden-by-flex');
fs.mkdirSync(overriddenByFlexHome, { recursive: true });
writeCodexConfig(overriddenByFlexHome,
  'profile = "work"\nservice_tier = "priority"\n\n[profiles.work]\nservice_tier = "flex"\n');
const overriddenByFlexCheck = run(['--check'], 'codex-tier-overridden-by-flex');
check('--check does not warn about a top-level priority tier the default profile overrides with flex',
  /service_tier/i.test(`${overriddenByFlexCheck.stdout}${overriddenByFlexCheck.stderr}`), false);

const unreadableHome = path.join(root, 'codex-tier-unreadable');
fs.mkdirSync(unreadableHome, { recursive: true });
const unreadableCheck = run(['--check'], 'codex-tier-unreadable');
check('a missing Codex config file never warns and never crashes --check',
  unreadableCheck.status === 0 && !/service_tier/i.test(`${unreadableCheck.stdout}${unreadableCheck.stderr}`), true);

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
  const cleanPlist = path.join(clean.home, 'Library', 'LaunchAgents',
    'com.orca.claude-codex-orchestration.janitor.plist');
  check('clean install ships the agent definition', fs.existsSync(cleanDest), true);
  const uninstClean = run(['--uninstall'], 'agents-clean');
  check('clean uninstall exits successfully', uninstClean.status, 0);
  check('uninstall removes an unmodified installer-created agent definition', fs.existsSync(cleanDest), false);
  check('uninstall removes the janitor LaunchAgent', process.platform === 'darwin' ? fs.existsSync(cleanPlist) : false, false);
  check('uninstall unregisters the janitor from launchctl', process.platform !== 'darwin' ||
    fs.readFileSync(launchctlLog, 'utf8').includes(`bootout gui/${process.getuid()} ${cleanPlist}`), true);

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
