#!/usr/bin/env node
/**
 * install.mjs — installs the orchestration hooks into ~/.claude/, idempotently and
 * reversibly. Zero dependencies, Node >= 18.
 *
 * Usage:
 *   node install.mjs [--dry-run] [--force] [--no-pin-models] [--set-model <alias>]
 *   node install.mjs --check
 *   node install.mjs --uninstall [--purge]
 *   node install.mjs --repair
 *
 * Every filesystem mutation is recorded in
 * `~/.claude/hooks/orchestration/install-manifest.json` so `--uninstall` can remove
 * exactly what this installer added, and nothing it did not: settings.json entries are
 * matched by their exact recorded matcher+command before removal, the CLAUDE.md block is
 * removed only if its content still matches what was inserted, and the model-pin env var
 * is removed only if its current value still matches what this installer set. Nothing
 * this installer did not create is ever touched.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks', 'orchestration');
const RULES_FILE = path.join(CLAUDE_DIR, 'rules', 'orchestration-contract.md');
const CONFIG_FILE = path.join(CLAUDE_DIR, 'orchestration.config.json');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const CLAUDE_MD_FILE = path.join(CLAUDE_DIR, 'CLAUDE.md');
const MANIFEST_FILE = path.join(HOOKS_DIR, 'install-manifest.json');

const GATE_SCRIPT = 'orchestrator-gate.cjs';
const HOOK_FILES = ['orchestrator-gate.cjs', 'orca-heartbeat.cjs', 'lib/config.cjs', 'lib/exec-route-by-quota.cjs'];
const EVENTS = {
  SessionStart: '*',
  UserPromptSubmit: '*',
  PreToolUse: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Agent|Task',
  PostToolUse: '*',
  Stop: '*',
};
const START_MARK = '<!-- orchestration:start -->';
const END_MARK = '<!-- orchestration:end -->';

// --- CLI -------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const DRY_RUN = flag('--dry-run');
const FORCE = flag('--force');
const NO_PIN = flag('--no-pin-models');
const SET_MODEL = opt('--set-model');
const PURGE = flag('--purge');

function log(msg) { console.log(msg); }
function warn(msg) { console.log(`WARNING: ${msg}`); }

// --- small fs helpers, all dry-run aware ------------------------------------

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function readJSONSafe(file, fallback) {
  try { return readJSON(file); } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err; // unparsable existing file: never silently overwrite it
  }
}
function writeJSON(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (DRY_RUN) { log(`  [dry-run] would write ${file}`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function writeText(file, text) {
  if (DRY_RUN) { log(`  [dry-run] would write ${file}`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function copyFile(from, to) {
  if (DRY_RUN) { log(`  [dry-run] would copy ${from} -> ${to}`); return; }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
function removeFile(file) {
  if (DRY_RUN) { log(`  [dry-run] would remove ${file}`); return; }
  try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}
function backupPath(file) {
  return `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

// --- platform ----------------------------------------------------------------

function checkPlatform() {
  if (process.platform === 'win32') {
    console.error('This installer supports macOS and Linux only. Windows is not supported.');
    process.exit(1);
  }
}

// --- install: hook files -----------------------------------------------------

function installHookFiles() {
  log(`Installing hooks into ${HOOKS_DIR}`);
  for (const rel of HOOK_FILES) {
    copyFile(path.join(REPO_ROOT, 'hooks', rel), path.join(HOOKS_DIR, rel));
  }
}

function uninstallHookFiles(manifest) {
  for (const rel of manifest.files || HOOK_FILES) {
    removeFile(path.join(HOOKS_DIR, rel));
  }
  // Remove the lib/ and orchestration/ dirs only if we emptied them ourselves.
  if (!DRY_RUN) {
    for (const dir of [path.join(HOOKS_DIR, 'lib'), HOOKS_DIR]) {
      try { fs.rmdirSync(dir); } catch {} // fails silently if non-empty or already gone
    }
  }
}

// --- install: rules file ------------------------------------------------------

function installRulesFile(prevManifest) {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'rules', 'orchestration-contract.md'), 'utf8');
  const existing = fs.existsSync(RULES_FILE) ? fs.readFileSync(RULES_FILE, 'utf8') : null;
  if (existing === null) {
    writeText(RULES_FILE, src);
    return { path: RULES_FILE, createdNew: true, backedUpAt: null };
  }
  if (existing === src) {
    // Content matches what this installer ships. On a re-install that is simply because
    // we wrote it ourselves last time - inherit that ownership rather than losing it.
    const owned = prevManifest ? !!prevManifest.rulesFile?.createdNew : false;
    return { path: RULES_FILE, createdNew: owned, backedUpAt: null, alreadyCurrent: true };
  }
  if (!FORCE) {
    warn(`${RULES_FILE} already exists and differs; leaving it. Re-run with --force to overwrite (a backup is made first).`);
    return { path: RULES_FILE, createdNew: false, backedUpAt: null, skipped: true };
  }
  const bak = backupPath(RULES_FILE);
  if (!DRY_RUN) fs.copyFileSync(RULES_FILE, bak);
  writeText(RULES_FILE, src);
  return { path: RULES_FILE, createdNew: false, backedUpAt: bak, forced: true };
}

function uninstallRulesFile(manifest) {
  const r = manifest.rulesFile;
  if (!r || !r.createdNew) return; // never delete a file we did not create
  const current = fs.existsSync(RULES_FILE) ? fs.readFileSync(RULES_FILE, 'utf8') : null;
  const src = (() => { try { return fs.readFileSync(path.join(REPO_ROOT, 'rules', 'orchestration-contract.md'), 'utf8'); } catch { return null; } })();
  if (current !== null && src !== null && current !== src) {
    warn(`${RULES_FILE} was edited since install; leaving it in place.`);
    return;
  }
  removeFile(RULES_FILE);
}

// --- install: config seed -----------------------------------------------------

function installConfig(prevManifest) {
  if (fs.existsSync(CONFIG_FILE)) {
    const owned = prevManifest ? !!prevManifest.configFile?.createdNew : false;
    return { path: CONFIG_FILE, createdNew: owned };
  }
  const example = fs.readFileSync(path.join(REPO_ROOT, 'config', 'orchestration.config.example.json'), 'utf8');
  writeText(CONFIG_FILE, example);
  return { path: CONFIG_FILE, createdNew: true };
}

// --no-pin-models etc. never touch config.json on uninstall unless --purge.
function uninstallConfig(manifest, purge) {
  if (!purge) return;
  if (manifest.configFile && manifest.configFile.createdNew) removeFile(CONFIG_FILE);
  else if (fs.existsSync(CONFIG_FILE)) warn(`${CONFIG_FILE} pre-dated this install; leaving it (rerun with --purge only removes what this installer created).`);
}

// --- install: settings.json ---------------------------------------------------

function commandFor(scriptName) {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(HOOKS_DIR, scriptName))}`;
}

function entryMatches(entry, matcher, command) {
  return entry && entry.matcher === matcher && Array.isArray(entry.hooks)
    && entry.hooks.some((h) => h && h.type === 'command' && h.command === command);
}

// `prevManifest` is this repo's own record from an earlier install, if any. A re-install
// (the idempotent case) must keep claiming ownership of keys it created the first time,
// even though those keys now already exist *because we created them* - recomputing
// "did this exist before me" fresh on every install would see its own prior work and
// conclude it never owned it, which is exactly what silently broke `--uninstall` before
// this was fixed: a second install overwrote the manifest with createdArray/created:false,
// and uninstall then left every entry and the model-pin env var behind.
function installSettings(opts, prevManifest) {
  let obj;
  try {
    obj = readJSONSafe(SETTINGS_FILE, null);
  } catch {
    console.error(`${SETTINGS_FILE} exists but is not valid JSON. Fix or remove it, then re-run install.`);
    process.exit(1);
  }
  const isNewFile = obj === null;
  if (isNewFile) obj = {};
  const originalText = isNewFile ? null : fs.readFileSync(SETTINGS_FILE, 'utf8');

  const backupFile = isNewFile ? null : backupPath(SETTINGS_FILE);
  if (backupFile && !DRY_RUN) fs.writeFileSync(backupFile, originalText);

  if (obj.disableAllHooks) warn('settings.json has "disableAllHooks": true — the installed hooks will not run until that is cleared.');
  if (obj.allowManagedHooksOnly) warn('settings.json has "allowManagedHooksOnly": true — verify the installed hooks are treated as managed, or they may be ignored.');

  const prevSettings = prevManifest && prevManifest.settings;
  const createdHooksKey = prevSettings ? !!prevSettings.createdHooksKey : obj.hooks === undefined;
  if (obj.hooks === undefined) obj.hooks = {};

  const events = {};
  for (const [event, matcher] of Object.entries(EVENTS)) {
    const command = commandFor(GATE_SCRIPT);
    const createdArray = prevSettings && prevSettings.events && prevSettings.events[event]
      ? !!prevSettings.events[event].createdArray
      : obj.hooks[event] === undefined;
    if (obj.hooks[event] === undefined) obj.hooks[event] = [];
    const already = obj.hooks[event].some((e) => entryMatches(e, matcher, command));
    if (!already) {
      obj.hooks[event].push({ matcher, hooks: [{ type: 'command', command }] });
    }
    events[event] = { matcher, command, createdArray, addedNow: !already };
  }

  const cfg = readJSONSafe(CONFIG_FILE, null) || readJSONSafe(path.join(REPO_ROOT, 'config', 'orchestration.config.example.json'), {});
  const reviewId = cfg?.models?.review?.id;
  let modelPin = { attempted: false, created: false, value: null, skippedReason: null };
  let createdEnvKey = prevSettings ? !!prevSettings.createdEnvKey : false;
  if (opts.pinModels && reviewId) {
    modelPin.attempted = true;
    modelPin.value = reviewId;
    if (process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX) {
      modelPin.skippedReason = 'CLAUDE_CODE_USE_BEDROCK/VERTEX is set; model IDs differ per provider, so the pin was skipped.';
      warn(modelPin.skippedReason);
    } else {
      const envKeyWasMissing = obj.env === undefined;
      if (envKeyWasMissing) obj.env = {};
      const current = obj.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
      const prevCreatedPin = prevSettings && prevSettings.modelPin && prevSettings.modelPin.created
        && prevSettings.modelPin.value === reviewId;
      if (current === undefined) {
        obj.env.ANTHROPIC_DEFAULT_OPUS_MODEL = reviewId;
        modelPin.created = true;
        createdEnvKey = createdEnvKey || envKeyWasMissing;
      } else if (current === reviewId) {
        // Already correct - either from a prior install of ours (keep owning it) or
        // because it pre-dated us entirely (never claim it in that case).
        modelPin.created = prevCreatedPin;
      } else {
        modelPin.skippedReason = `ANTHROPIC_DEFAULT_OPUS_MODEL is already set to "${current}"; leaving it (wanted "${reviewId}").`;
        warn(modelPin.skippedReason);
      }
    }
  }

  let setModelResult = null;
  if (SET_MODEL) {
    setModelResult = { previous: obj.model === undefined ? null : obj.model, applied: SET_MODEL };
    obj.model = SET_MODEL;
  }

  writeJSON(SETTINGS_FILE, obj);

  return {
    path: SETTINGS_FILE,
    backupPath: backupFile,
    createdNewFile: isNewFile,
    createdHooksKey,
    events,
    createdEnvKey,
    modelPin,
    setModel: setModelResult,
  };
}

function uninstallSettings(manifest) {
  const s = manifest.settings;
  if (!s) return;
  let obj;
  try { obj = readJSON(SETTINGS_FILE); } catch {
    warn(`${SETTINGS_FILE} is missing or invalid; cannot surgically remove entries.`);
    return;
  }

  if (obj.hooks) {
    for (const [event, rec] of Object.entries(s.events || {})) {
      if (!Array.isArray(obj.hooks[event])) continue;
      obj.hooks[event] = obj.hooks[event].filter((e) => !entryMatches(e, rec.matcher, rec.command));
      if (obj.hooks[event].length === 0 && rec.createdArray) delete obj.hooks[event];
    }
    if (s.createdHooksKey && Object.keys(obj.hooks).length === 0) delete obj.hooks;
  }

  if (s.modelPin && s.modelPin.created && obj.env) {
    if (obj.env.ANTHROPIC_DEFAULT_OPUS_MODEL === s.modelPin.value) {
      delete obj.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
      if (s.createdEnvKey && Object.keys(obj.env).length === 0) delete obj.env;
    } else {
      warn('ANTHROPIC_DEFAULT_OPUS_MODEL changed since install; leaving it as-is.');
    }
  }

  // The top-level "model" set by --set-model is a deliberate, visible operator choice;
  // uninstall never reverts it silently. Mention it instead.
  if (s.setModel) {
    warn(`settings.json "model" was set to "${s.setModel.applied}" by --set-model at install time; uninstall does not revert this. Edit settings.json by hand if you want it back.`);
  }

  writeJSON(SETTINGS_FILE, obj);
}

// --- install: CLAUDE.md snippet ------------------------------------------------

function installClaudeMd(prevManifest) {
  const snippet = fs.readFileSync(path.join(REPO_ROOT, 'snippets', 'CLAUDE.md.snippet'), 'utf8').replace(/\r\n/g, '\n').trimEnd();
  const existing = fs.existsSync(CLAUDE_MD_FILE) ? fs.readFileSync(CLAUDE_MD_FILE, 'utf8') : null;

  if (existing === null) {
    writeText(CLAUDE_MD_FILE, `${snippet}\n`);
    return { path: CLAUDE_MD_FILE, createdNewFile: true, snippet };
  }
  // The file already exists - possibly only because we created it on a prior install.
  // Inherit that ownership so a re-install stays fully reversible.
  const inheritedCreatedNewFile = prevManifest ? !!prevManifest.claudeMd?.createdNewFile : false;

  const normalized = existing.replace(/\r\n/g, '\n');
  const startCount = (normalized.match(new RegExp(START_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  const endCount = (normalized.match(new RegExp(END_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  if (startCount !== endCount || startCount > 1) {
    console.error(`${CLAUDE_MD_FILE} has unbalanced or duplicated orchestration markers (${startCount} start, ${endCount} end). Fix it by hand, then re-run install.`);
    process.exit(1);
  }

  const usesCRLF = /\r\n/.test(existing);
  let updated;
  if (startCount === 1) {
    const blockRe = new RegExp(`${START_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    updated = normalized.replace(blockRe, snippet);
  } else {
    updated = `${normalized.replace(/\n+$/, '')}\n\n${snippet}\n`;
  }
  if (usesCRLF) updated = updated.replace(/\n/g, '\r\n');
  writeText(CLAUDE_MD_FILE, updated);
  return { path: CLAUDE_MD_FILE, createdNewFile: inheritedCreatedNewFile, snippet };
}

function uninstallClaudeMd(manifest) {
  const c = manifest.claudeMd;
  if (!c) return;
  if (!fs.existsSync(CLAUDE_MD_FILE)) return;
  const existing = fs.readFileSync(CLAUDE_MD_FILE, 'utf8');
  const normalized = existing.replace(/\r\n/g, '\n');
  const blockRe = new RegExp(`\\n*${START_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n*`);
  const m = normalized.match(blockRe);
  const currentBlock = normalized.slice(normalized.indexOf(START_MARK), normalized.lastIndexOf(END_MARK) + END_MARK.length);
  if (!m || currentBlock !== c.snippet) {
    warn(`${CLAUDE_MD_FILE}'s orchestration block was edited since install; leaving it in place.`);
    return;
  }
  if (c.createdNewFile) {
    removeFile(CLAUDE_MD_FILE);
    return;
  }
  const usesCRLF = /\r\n/.test(existing);
  let updated = normalized.replace(blockRe, '\n').replace(/\n{3,}/g, '\n\n');
  if (usesCRLF) updated = updated.replace(/\n/g, '\r\n');
  writeText(CLAUDE_MD_FILE, updated);
}

// --- install / uninstall / check / repair --------------------------------------

function install() {
  checkPlatform();
  const nodeOk = process.version.replace('v', '').split('.').map(Number)[0] >= 18;
  if (!nodeOk) { console.error(`Node >= 18 is required (found ${process.version}).`); process.exit(1); }

  const prevManifest = readJSONSafe(MANIFEST_FILE, null);

  log(`${DRY_RUN ? '[dry-run] ' : ''}Installing claude-codex-orca-orchestration...`);
  installHookFiles();
  const rulesFile = installRulesFile(prevManifest);
  const configFile = installConfig(prevManifest);
  const settings = installSettings({ pinModels: !NO_PIN }, prevManifest);
  const claudeMd = installClaudeMd(prevManifest);

  const manifest = {
    version: 1,
    installedAt: new Date().toISOString(),
    nodePath: process.execPath,
    hooksDir: HOOKS_DIR,
    files: HOOK_FILES,
    rulesFile,
    configFile,
    settings,
    claudeMd,
  };
  writeJSON(MANIFEST_FILE, manifest);

  log(DRY_RUN ? 'Dry run complete; nothing was written.' : 'Install complete.');
  if (!DRY_RUN) {
    log(`Next: node ${path.relative(process.cwd(), fileURLToPath(import.meta.url))} --check`);
  }
}

function uninstall(purge) {
  checkPlatform();
  const manifest = readJSONSafe(MANIFEST_FILE, null);
  if (!manifest) {
    log('Nothing to uninstall: no install manifest found.');
    return;
  }
  uninstallSettings(manifest);
  uninstallClaudeMd(manifest);
  uninstallRulesFile(manifest);
  uninstallConfig(manifest, purge);
  uninstallHookFiles(manifest);
  removeFile(MANIFEST_FILE);
  log(purge ? 'Uninstalled and purged config.' : 'Uninstalled (config.json kept; rerun with --purge to remove it too).');
}

function which(bin) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch { return false; }
}
function versionOf(bin, args = ['--version']) {
  try { return execFileSync(bin, args, { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0]; }
  catch { return null; }
}

function check() {
  log('--- prerequisites ---');
  log(`node: ${process.version} (${process.version.replace('v', '').split('.').map(Number)[0] >= 18 ? 'OK, >= 18' : 'TOO OLD, need >= 18'})`);
  log(`claude: ${which('claude') ? (versionOf('claude') || 'present') : 'NOT FOUND on PATH'}`);
  const hasOrca = which('orca');
  log(`orca: ${hasOrca ? (versionOf('orca') || 'present') : 'NOT FOUND on PATH'}`);
  const hasCodex = which('codex');
  log(`codex: ${hasCodex ? (versionOf('codex') || 'present') : 'NOT FOUND on PATH'}`);
  if (hasCodex) {
    const codexHome = process.env.CODEX_HOME || path.join(HOME, '.codex');
    const authFile = path.join(codexHome, 'auth.json');
    log(`codex login: ${fs.existsSync(authFile) ? `auth file present at ${authFile} (not a guarantee it is valid)` : `no auth file found at ${authFile} - run \`codex login\``}`);
  }
  if (!hasOrca || !hasCodex) {
    warn('Without both Orca and a usable Codex quota reading, automatic routing keeps defaulting to Codex. ' +
      'Use --exec-sonnet (or --code-model <your code alias>) to route code in-session instead, ' +
      'or see "No Orca / no Codex" in rules/orchestration-contract.md.');
  }

  log('\n--- install status ---');
  const manifest = readJSONSafe(MANIFEST_FILE, null);
  if (!manifest) {
    log('Not installed (no install manifest at ' + MANIFEST_FILE + ').');
    return;
  }
  log(`Installed: ${manifest.installedAt}`);
  for (const rel of manifest.files) {
    const p = path.join(HOOKS_DIR, rel);
    log(`  ${fs.existsSync(p) ? 'OK  ' : 'MISS'} ${p}`);
  }
  log(`  ${fs.existsSync(RULES_FILE) ? 'OK  ' : 'MISS'} ${RULES_FILE}`);
  log(`  ${fs.existsSync(CONFIG_FILE) ? 'OK  ' : 'MISS'} ${CONFIG_FILE}`);
  log(`  ${fs.existsSync(SETTINGS_FILE) ? 'OK  ' : 'MISS'} ${SETTINGS_FILE}`);
  const nodeExists = fs.existsSync(manifest.nodePath);
  log(`  node path recorded at install: ${manifest.nodePath} (${nodeExists ? 'exists' : 'MISSING - run --repair'})`);

  log('\n--- effective environment ---');
  log(`ANTHROPIC_DEFAULT_OPUS_MODEL: ${process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || '(not set in this shell; set via settings.json env on Claude Code launch)'}`);
  if (process.env.CLAUDE_CODE_SUBAGENT_MODEL) {
    warn(`CLAUDE_CODE_SUBAGENT_MODEL=${process.env.CLAUDE_CODE_SUBAGENT_MODEL} is set - it overrides subagent model routing and may fight this gate's model instructions.`);
  }
  try {
    const settings = readJSON(SETTINGS_FILE);
    log(`settings.json env.ANTHROPIC_DEFAULT_OPUS_MODEL: ${settings.env?.ANTHROPIC_DEFAULT_OPUS_MODEL || '(not set)'}`);
  } catch {}
}

function repair() {
  const manifest = readJSONSafe(MANIFEST_FILE, null);
  if (!manifest) { log('Nothing to repair: not installed.'); return; }
  manifest.nodePath = process.execPath;
  writeJSON(MANIFEST_FILE, manifest);
  log(`Repaired: nodePath set to ${process.execPath}.`);
}

// --- entry -----------------------------------------------------------------

if (flag('--check')) check();
else if (flag('--uninstall')) uninstall(PURGE);
else if (flag('--repair')) repair();
else install();
