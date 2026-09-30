#!/usr/bin/env node
/**
 * install.mjs — installs the orchestration hooks into ~/.claude/, idempotently and
 * reversibly. Zero dependencies, Node >= 18.
 *
 * Usage:
 *   node install.mjs [--dry-run] [--force] [--no-pin-models] [--set-model <alias>] [--replace-foreign-gate]
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
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

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
const HOOK_FILES = [
  'orchestrator-gate.cjs', 'orca-heartbeat.cjs',
  'lib/config.cjs', 'lib/exec-route-by-quota.cjs', 'lib/codex-quota-probe.cjs', 'lib/shell-orca-invocations.cjs',
  'lib/worker-groups.cjs', 'lib/ownership.cjs', 'lib/ownership-claims.cjs', 'lib/file-lock.cjs',
  'lib/parallel-ownership-gates.cjs', 'lib/parallel-agent-cap.cjs', 'lib/heartbeat-liveness.cjs',
  'lib/terminal-signals.cjs', 'lib/live-probe-cache.cjs', 'lib/kimi-quota-probe.cjs',
  'lib/coder-availability.cjs', 'lib/coder-pool-route.cjs',
];
const EVENTS = {
  SessionStart: '*',
  UserPromptSubmit: '*',
  PreToolUse: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Agent|Task',
  PostToolUse: '*',
  // A failed tool call (Claude Code's own separate event, distinct from PostToolUse) drops
  // whatever reservation/ownership claim its PreToolUse made, so a Bash/Agent call that
  // errors out never leaks a parallel-Codex-worker opening or an Owns: claim until the TTL.
  PostToolUseFailure: '*',
  Stop: '*',
};
// Claude Code PreToolUse command hooks currently default to 600s. That is safely above
// this gate's roughly 50s worst case, so its per-hook timeout is intentionally left unset.
const START_MARK = '<!-- orchestration:start -->';
const END_MARK = '<!-- orchestration:end -->';

/**
 * The `node` this installer should point settings.json's hook commands at: the stable
 * PATH-resolved path (`which`/`where node`, left as the symlink it is - never resolved to
 * its real target), not `process.execPath`. A version manager (nvm, Homebrew, volta, fnm)
 * commonly puts `process.execPath` inside a version-numbered directory
 * (`/usr/local/Cellar/node/23.11.0/bin/node`, `~/.nvm/versions/node/v23.11.0/bin/node`)
 * that stops existing the moment that Node version is uninstalled, silently breaking every
 * hook. The PATH entry (`/usr/local/bin/node`, `~/.nvm/.../current/bin/node`, ...) is
 * the stable indirection those tools provide for exactly this reason. Falls back to
 * `process.execPath` only when no `node` is found on PATH at all (e.g. this script was
 * invoked with an absolute interpreter path and nothing is otherwise on PATH).
 */
function stableNodePath() {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8', timeout: 5000 });
    const first = out.split('\n').map((l) => l.trim()).find(Boolean);
    if (first) return first;
  } catch {}
  return process.execPath;
}
const NODE_PATH = stableNodePath();

/** Heuristic: a path that sits inside a version-numbered directory a Node upgrade/uninstall can remove out from under it. */
function looksVersioned(p) {
  return /[/\\](Cellar|versions|\.nvm|\.volta|fnm|n[/\\]versions)[/\\]/i.test(p) || /[/\\]v?\d+\.\d+\.\d+[/\\]/.test(p);
}

// --- CLI -------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

function usage(stream = process.stdout) {
  stream.write(
    'Usage:\n' +
    '  node install.mjs [--dry-run] [--force] [--no-pin-models] [--set-model <alias>] [--replace-foreign-gate]\n' +
    '  node install.mjs --check\n' +
    '  node install.mjs --uninstall [--purge]\n' +
    '  node install.mjs --repair\n' +
    '  node install.mjs --help | -h\n');
}

const BOOLEAN_FLAGS = new Set([
  '--dry-run', '--force', '--no-pin-models', '--replace-foreign-gate',
  '--check', '--uninstall', '--purge', '--repair', '--help', '-h',
]);
let argvError = null;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (BOOLEAN_FLAGS.has(arg)) continue;
  if (arg === '--set-model') {
    if (!argv[i + 1] || argv[i + 1].startsWith('-')) argvError = '--set-model requires an alias value.';
    else i += 1;
    continue;
  }
  argvError = `Unknown option: ${arg}`;
}
if (flag('--help') || flag('-h')) {
  usage();
  process.exit(0);
}
if (argvError) {
  console.error(argvError);
  usage(process.stderr);
  process.exit(2);
}

const DRY_RUN = flag('--dry-run');
const FORCE = flag('--force');
const NO_PIN = flag('--no-pin-models');
const SET_MODEL = opt('--set-model');
const PURGE = flag('--purge');
const REPLACE_FOREIGN_GATE = flag('--replace-foreign-gate');

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

function commandFor(scriptName, nodePath = NODE_PATH) {
  return `${JSON.stringify(nodePath)} ${JSON.stringify(path.join(HOOKS_DIR, scriptName))}`;
}

function entryMatches(entry, matcher, command) {
  return entry && entry.matcher === matcher && Array.isArray(entry.hooks)
    && entry.hooks.some((h) => h && h.type === 'command' && h.command === command);
}

function foreignGateCommands(settings, ownedCommands = []) {
  const owned = new Set([commandFor(GATE_SCRIPT), ...ownedCommands].filter(Boolean));
  const found = [];
  for (const [event, entries] of Object.entries(settings?.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!Array.isArray(entry?.hooks)) continue;
      for (const hook of entry.hooks) {
        const command = hook?.type === 'command' ? hook.command : null;
        if (typeof command === 'string' && /(?:^|[\/\\"'\s])orchestrator-gate\.cjs(?:["']|\s|$)/.test(command) && !owned.has(command)) {
          found.push({ event, matcher: entry.matcher, command });
        }
      }
    }
  }
  return found;
}

function removeForeignGateCommands(settings, foreign) {
  const commands = new Set(foreign.map((item) => item.command));
  for (const [event, entries] of Object.entries(settings.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    settings.hooks[event] = entries.flatMap((entry) => {
      if (!Array.isArray(entry?.hooks)) return [entry];
      const hooks = entry.hooks.filter((hook) => !(hook?.type === 'command' && commands.has(hook.command)));
      return hooks.length ? [{ ...entry, hooks }] : [];
    });
  }
}

// `prevManifest` is this repo's own record from an earlier install, if any. A re-install
// (the idempotent case) must keep claiming ownership of keys it created the first time,
// even though those keys now already exist *because we created them* - recomputing
// "did this exist before me" fresh on every install would see its own prior work and
// conclude it never owned it, which is exactly what silently broke `--uninstall` before
// this was fixed: a second install overwrote the manifest with createdArray/created:false,
// and uninstall then left every entry and the model-pin env var behind.
/**
 * Pin one env var to `desiredValue` in `obj.env`, with the same ownership rule the
 * settings-entry tracking above uses: claim it when it is missing, or when it is already
 * exactly the value *this installer* set last time (read from `prevPin`) - which is what
 * lets ownership survive the pinned id itself changing between installs (M4): the id in
 * config.json moved on, but the env var still holds our old value, so it is still ours to
 * update. Never claims a value that pre-dates us or that something else changed it to.
 */
function pinModelEnv(obj, envKey, desiredValue, prevPin) {
  const result = { attempted: true, created: false, value: desiredValue, skippedReason: null };
  const current = obj.env[envKey];
  const weOwnedItBefore = !!(prevPin && prevPin.created && current === prevPin.value);
  if (current === undefined || weOwnedItBefore) {
    obj.env[envKey] = desiredValue;
    result.created = true;
  } else if (current === desiredValue) {
    result.created = false; // matches by coincidence (or pre-dates us); never claim it
  } else {
    result.skippedReason = `${envKey} is already set to "${current}"; leaving it (wanted "${desiredValue}").`;
    warn(result.skippedReason);
  }
  return result;
}

// `prevManifest` is this repo's own record from an earlier install, if any. A re-install
// (the idempotent case) must keep claiming ownership of keys it created the first time,
// even though those keys now already exist *because we created them* - recomputing
// "did this exist before me" fresh on every install would see its own prior work and
// conclude it never owned it, which is exactly what silently broke `--uninstall` before
// this was fixed: a second install overwrote the manifest with createdArray/created:false,
// and uninstall then left every entry and the model-pin env vars behind.
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

  if (obj.disableAllHooks) warn('settings.json has "disableAllHooks": true — the installed hooks will not run until that is cleared.');
  if (obj.allowManagedHooksOnly) warn('settings.json has "allowManagedHooksOnly": true — verify the installed hooks are treated as managed, or they may be ignored.');

  const foreign = foreignGateCommands(obj);
  if (foreign.length && REPLACE_FOREIGN_GATE) {
    removeForeignGateCommands(obj, foreign);
    warn(`${DRY_RUN ? 'would remove' : 'removed'} ${foreign.length} foreign orchestrator-gate.cjs registration(s) because --replace-foreign-gate was supplied.`);
  } else if (foreign.length) {
    warn(`FOREIGN orchestrator-gate.cjs registration(s) detected (${foreign.map((item) => item.command).join(', ')}). ` +
      'They remain active alongside this package and may enforce conflicting rules. Re-run with --replace-foreign-gate to remove them.');
  }

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
  const escalationId = cfg?.models?.escalation?.id;
  let opusPin = { attempted: false, created: false, value: null, skippedReason: null };
  let fablePin = { attempted: false, created: false, value: null, skippedReason: null };
  let createdEnvKey = prevSettings ? !!prevSettings.createdEnvKey : false;
  if (opts.pinModels && (reviewId || escalationId)) {
    if (process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX) {
      const reason = 'CLAUDE_CODE_USE_BEDROCK/VERTEX is set; model IDs differ per provider, so the pin was skipped.';
      if (reviewId) opusPin = { attempted: true, created: false, value: reviewId, skippedReason: reason };
      if (escalationId) fablePin = { attempted: true, created: false, value: escalationId, skippedReason: reason };
      warn(reason);
    } else {
      const envKeyWasMissing = obj.env === undefined;
      if (envKeyWasMissing) obj.env = {};
      if (reviewId) opusPin = pinModelEnv(obj, 'ANTHROPIC_DEFAULT_OPUS_MODEL', reviewId, prevSettings?.modelPin);
      if (escalationId) fablePin = pinModelEnv(obj, 'ANTHROPIC_DEFAULT_FABLE_MODEL', escalationId, prevSettings?.fablePin);
      createdEnvKey = createdEnvKey || (envKeyWasMissing && (opusPin.created || fablePin.created));
    }
  }

  let setModelResult = null;
  if (SET_MODEL) {
    setModelResult = { previous: obj.model === undefined ? null : obj.model, applied: SET_MODEL };
    obj.model = SET_MODEL;
  }

  // Back up only when this install actually changes the file's content (M1), and record
  // only the FIRST backup this repo ever made in the manifest - re-installs still take a
  // fresh timestamped backup on disk (never destroyed), but the manifest's pointer, and
  // what any doc tells the operator to roll back to, stays the one true "before I ever
  // touched this file" snapshot rather than churning forward on every re-install.
  const newText = `${JSON.stringify(obj, null, 2)}\n`;
  let backupFile = prevSettings ? prevSettings.backupPath || null : null;
  if (!isNewFile && originalText !== newText) {
    const freshBackup = backupPath(SETTINGS_FILE);
    if (!DRY_RUN) fs.writeFileSync(freshBackup, originalText);
    if (!backupFile) backupFile = freshBackup;
  }

  writeJSON(SETTINGS_FILE, obj);

  return {
    path: SETTINGS_FILE,
    backupPath: backupFile,
    createdNewFile: isNewFile,
    createdHooksKey,
    events,
    createdEnvKey,
    modelPin: opusPin,
    fablePin,
    setModel: setModelResult,
  };
}

/**
 * When the node path this installer would use has changed since the last install (a
 * version manager moved on, or the operator switched Node installs), the settings.json
 * entries this repo owns still carry the OLD path baked into their command string.
 * Removing those exact old entries before `installSettings` adds the new ones keeps a
 * re-install from ending up with two live copies of every hook - one per node path - both
 * of which would fire on every tool call.
 */
function removeStaleNodeCommands(prevManifest) {
  if (!prevManifest || !prevManifest.nodePath || prevManifest.nodePath === NODE_PATH) return false;
  if (!prevManifest.settings || !prevManifest.settings.events) return false;
  let obj;
  try { obj = readJSON(SETTINGS_FILE); } catch { return false; }
  if (!obj.hooks) return false;
  let changed = false;
  for (const [event, rec] of Object.entries(prevManifest.settings.events)) {
    if (!Array.isArray(obj.hooks[event])) continue;
    const oldCommand = commandFor(GATE_SCRIPT, prevManifest.nodePath);
    const before = obj.hooks[event].length;
    obj.hooks[event] = obj.hooks[event].filter((e) => !entryMatches(e, rec.matcher, oldCommand));
    if (obj.hooks[event].length !== before) changed = true;
  }
  if (changed) {
    log(`Node path changed since last install (${prevManifest.nodePath} -> ${NODE_PATH}); removing the old command entries before adding the new ones.`);
    // A real mutation ahead of installSettings' own backup-on-change logic - take a
    // safety backup here too (not referenced by the manifest as "the" rollback target;
    // installSettings still owns that, inheriting the first one ever made).
    if (!DRY_RUN) fs.writeFileSync(backupPath(SETTINGS_FILE), fs.readFileSync(SETTINGS_FILE, 'utf8'));
    writeJSON(SETTINGS_FILE, obj);
  }
  return changed;
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

  const unpin = (envKey, pin) => {
    if (!pin || !pin.created || !obj.env) return;
    if (obj.env[envKey] === pin.value) {
      delete obj.env[envKey];
    } else {
      warn(`${envKey} changed since install; leaving it as-is.`);
    }
  };
  unpin('ANTHROPIC_DEFAULT_OPUS_MODEL', s.modelPin);
  unpin('ANTHROPIC_DEFAULT_FABLE_MODEL', s.fablePin);
  if (s.createdEnvKey && obj.env && Object.keys(obj.env).length === 0) delete obj.env;

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
  const usesCRLF = /\r\n/.test(existing);
  let updated = normalized.replace(blockRe, '\n').replace(/\n{3,}/g, '\n\n');
  // Delete the file only when nothing but whitespace is left, regardless of whether we
  // created it fresh: the operator may well have added content of their own below or
  // above our block after installing, and that content must survive uninstall even if
  // this file did not exist before we created it.
  if (updated.trim().length === 0) {
    removeFile(CLAUDE_MD_FILE);
    return;
  }
  if (usesCRLF) updated = updated.replace(/\n/g, '\r\n');
  writeText(CLAUDE_MD_FILE, updated);
}

// --- install / uninstall / check / repair --------------------------------------

/**
 * Validate everything that could make install() fail partway through, BEFORE it writes
 * anything. Without this, a bad settings.json or an unbalanced CLAUDE.md could be
 * discovered only after hook files, the rules file and config.json were already written -
 * with no manifest yet on disk to record or later clean up that partial state (H1).
 */
function preflightInstall() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try { readJSON(SETTINGS_FILE); } catch {
      console.error(`${SETTINGS_FILE} exists but is not valid JSON. Fix or remove it, then re-run install. Nothing was written.`);
      process.exit(1);
    }
  }
  if (fs.existsSync(CLAUDE_MD_FILE)) {
    const existing = fs.readFileSync(CLAUDE_MD_FILE, 'utf8').replace(/\r\n/g, '\n');
    const startCount = (existing.match(new RegExp(START_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    const endCount = (existing.match(new RegExp(END_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (startCount !== endCount || startCount > 1) {
      console.error(`${CLAUDE_MD_FILE} has unbalanced or duplicated orchestration markers (${startCount} start, ${endCount} end). Fix it by hand, then re-run install. Nothing was written.`);
      process.exit(1);
    }
  }
}

/**
 * The installed hooks run under NODE_PATH (the stable PATH node), not necessarily the
 * node this installer itself is running under (`process.version`) - the two can differ
 * when this script was invoked via an absolute interpreter path while PATH points
 * elsewhere, or vice versa. A warning here, before install proceeds, is cheaper than
 * discovering it the first time a hook silently fails to run under an old Node.
 */
function checkTargetNodeVersion() {
  let out;
  try {
    out = execFileSync(NODE_PATH, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch (err) {
    warn(`could not run "${NODE_PATH} --version" (${err.message}); proceeding anyway.`);
    return;
  }
  const major = Number(out.replace(/^v/, '').split('.')[0]);
  if (!Number.isInteger(major) || major < 18) {
    warn(`the node the hooks will run under (${NODE_PATH}) reports ${out}, which is below the required >= 18.`);
  }
  if (out !== process.version) {
    warn(`the node the hooks will run under (${NODE_PATH}, ${out}) differs from the node running this installer (${process.version}). This is usually fine, but if hooks misbehave, check both.`);
  }
}

function install() {
  checkPlatform();
  const nodeOk = process.version.replace('v', '').split('.').map(Number)[0] >= 18;
  if (!nodeOk) { console.error(`Node >= 18 is required (found ${process.version}).`); process.exit(1); }
  checkTargetNodeVersion();
  preflightInstall();

  const prevManifest = readJSONSafe(MANIFEST_FILE, null);
  removeStaleNodeCommands(prevManifest);

  log(`${DRY_RUN ? '[dry-run] ' : ''}Installing claude-codex-orca-orchestration...`);
  installHookFiles();
  const rulesFile = installRulesFile(prevManifest);
  const configFile = installConfig(prevManifest);
  const settings = installSettings({ pinModels: !NO_PIN }, prevManifest);
  const claudeMd = installClaudeMd(prevManifest);

  const manifest = {
    version: 1,
    installedAt: new Date().toISOString(),
    nodePath: NODE_PATH,
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

function hookLibBase() {
  const needed = ['lib/coder-availability.cjs', 'lib/coder-pool-route.cjs',
    'lib/exec-route-by-quota.cjs', 'lib/config.cjs'];
  for (const base of [HOOKS_DIR, path.join(REPO_ROOT, 'hooks')]) {
    if (needed.every((rel) => fs.existsSync(path.join(base, rel)))) return base;
  }
  return null;
}

/** Report each coder's availability on this machine, the effective thresholds/caps, and
 *  the pool pick they produce. Probes run fresh with caches written only to a throwaway
 *  state dir, so `--check` never mutates the operator's real gate state, and the Kimi
 *  token is only ever read inside the spawned quota helper - never printed here. */
function checkCoders(hasOrca) {
  log('\n--- coder availability ---');
  const base = hookLibBase();
  if (!base) {
    warn('could not find the coder-routing libraries (not installed yet?) - skipping coder availability.');
    return;
  }
  const availLib = require(path.join(base, 'lib/coder-availability.cjs'));
  const poolLib = require(path.join(base, 'lib/coder-pool-route.cjs'));
  const quotaLib = require(path.join(base, 'lib/exec-route-by-quota.cjs'));
  const cfgLib = require(path.join(base, 'lib/config.cjs'));
  let probeStateDir = null;
  try {
    const cfg = cfgLib.loadConfig();
    const now = Date.now();
    const stateDir = cfgLib.stateDir();
    const thresholds = { codex: cfgLib.handoffUsed(cfg), kimi: cfgLib.kimiHandoffUsed(cfg) };
    const caps = { codex: cfgLib.maxParallelCodexWorkers(cfg), kimi: cfgLib.maxParallelKimiWorkers(cfg) };
    log(`thresholds: codexHandoffUsedPercent=${thresholds.codex} kimiHandoffUsedPercent=${thresholds.kimi} ` +
      `maxParallelKimiWorkers=${caps.kimi} maxParallelCodexWorkers=${caps.codex}`);
    const authState = quotaLib.codexAuthState(stateDir, now, cfgLib.coderAvailabilityCacheSeconds(cfg) * 1000);
    const availability = availLib.coderAvailability({
      fresh: true, env: process.env, orcaInstalled: !!hasOrca, codexAuthState: authState, now,
    });
    probeStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-check-'));
    const quotas = { codex: null, kimi: null };
    if (availability.codex && availability.codex.usable) {
      const q = quotaLib.codexQuota(now, { stateDir: probeStateDir, cacheSeconds: 0 });
      quotas.codex = q && !q.failed ? q : null;
    }
    if (availability.kimi && availability.kimi.usable) {
      const q = quotaLib.kimiQuota(now, { stateDir: probeStateDir, cacheSeconds: 0, env: process.env });
      quotas.kimi = q && !q.failed ? q : null;
    }
    for (const coder of ['codex', 'kimi']) {
      const a = availability[coder] || { usable: false, reason: 'unknown', auth: 'unknown', binPath: null };
      const q = quotas[coder];
      const quotaText = q && typeof q.usedPercent === 'number' ? `${Math.round(100 - q.usedPercent)}% left` : 'unknown';
      const binText = a.binPath ? `${a.binPath} ${versionOf(a.binPath) || 'present'}`.trim() : 'none';
      const authText = a.auth === 'logged-out' ? 'logged out' : a.auth;
      log(`coder ${coder}: ${a.usable ? 'usable' : `UNUSABLE (${a.reason})`} ` +
        `[binary ${binText}, auth ${authText}, quota ${quotaText}]`);
    }
    const pool = poolLib.pickCoderPool({
      availability, quotas, thresholds,
      exhaustion: availLib.readCoderExhaustion(stateDir, now),
      live: { codex: 0, kimi: 0 }, caps,
      fallbackEnabled: cfg.execFallbackWhenCodexUnavailable === null ? null : true,
    });
    log(`pool: ${pool.summary}`);
    if (pool.route === 'code') {
      warn(`no coder usable -> code routes to ${cfg.models?.code?.alias || 'the configured code model'} in-session. ` +
        'Fix a coder (install/sign in) or accept the in-session model.');
    }
  } catch (err) {
    warn(`could not evaluate coder availability: ${err.message}`);
  } finally {
    if (probeStateDir) try { fs.rmSync(probeStateDir, { recursive: true, force: true }); } catch {}
  }
}

function check() {
  checkPlatform();
  let checkFailed = false;
  log('--- prerequisites ---');
  const nodeOk = process.version.replace('v', '').split('.').map(Number)[0] >= 18;
  log(`node: ${process.version} (${nodeOk ? 'OK, >= 18' : 'FAIL, need >= 18'})`);
  if (!nodeOk) checkFailed = true;
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
      'or see "Coder availability (no Orca / no Codex / no Kimi)" in rules/orchestration-contract.md.');
  }

  checkCoders(hasOrca);

  log('\n--- install status ---');
  const manifest = readJSONSafe(MANIFEST_FILE, null);
  const settingsForForeignCheck = readJSONSafe(SETTINGS_FILE, {});
  const recordedCommands = Object.values(manifest?.settings?.events || {}).map((entry) => entry.command);
  const foreign = foreignGateCommands(settingsForForeignCheck, recordedCommands);
  if (foreign.length) {
    log(`  PROBLEM: ${foreign.length} foreign orchestrator-gate.cjs registration(s) found in ${SETTINGS_FILE}:`);
    for (const item of foreign) log(`    ${item.event} matcher "${item.matcher}": ${item.command}`);
    checkFailed = true;
  } else {
    log('  OK   no foreign orchestrator-gate.cjs registrations');
  }
  if (!manifest) {
    log('Not installed (no install manifest at ' + MANIFEST_FILE + ').');
    if (checkFailed) process.exitCode = 1;
    return;
  }
  log(`Installed: ${manifest.installedAt}`);
  for (const rel of manifest.files) {
    const p = path.join(HOOKS_DIR, rel);
    const present = fs.existsSync(p);
    log(`  ${present ? 'OK  ' : 'MISS'} ${p}`);
    if (!present) checkFailed = true;
  }
  for (const p of [RULES_FILE, CONFIG_FILE, SETTINGS_FILE]) {
    const present = fs.existsSync(p);
    log(`  ${present ? 'OK  ' : 'MISS'} ${p}`);
    if (!present) checkFailed = true;
  }
  const nodeExists = fs.existsSync(manifest.nodePath);
  log(`  node path recorded at install: ${manifest.nodePath} (${nodeExists ? 'exists' : 'MISSING - run --repair'})`);
  if (!nodeExists) checkFailed = true;
  if (looksVersioned(manifest.nodePath)) {
    warn(`the recorded node path sits inside a version-numbered directory (${manifest.nodePath}) - a Node ` +
      'upgrade or uninstall can remove it out from under the hooks. Run --repair to re-point at the current PATH node.');
  }

  log('\n--- hook entries in settings.json ---');
  const settingsNow = readJSONSafe(SETTINGS_FILE, {});
  for (const [event, rec] of Object.entries(manifest.settings?.events || {})) {
    const present = Array.isArray(settingsNow.hooks?.[event])
      && settingsNow.hooks[event].some((e) => entryMatches(e, rec.matcher, rec.command));
    log(`  ${present ? 'OK  ' : 'MISS'} ${event} (matcher "${rec.matcher}")`);
    if (!present) checkFailed = true;
  }

  log('\n--- effective environment ---');
  log(`ANTHROPIC_DEFAULT_OPUS_MODEL: ${process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || '(not set in this shell; set via settings.json env on Claude Code launch)'}`);
  log(`ANTHROPIC_DEFAULT_FABLE_MODEL: ${process.env.ANTHROPIC_DEFAULT_FABLE_MODEL || '(not set in this shell; set via settings.json env on Claude Code launch)'}`);
  if (process.env.CLAUDE_CODE_SUBAGENT_MODEL) {
    warn(`CLAUDE_CODE_SUBAGENT_MODEL=${process.env.CLAUDE_CODE_SUBAGENT_MODEL} is set - it overrides subagent model routing and may fight this gate's model instructions.`);
  }
  log(`settings.json env.ANTHROPIC_DEFAULT_OPUS_MODEL: ${settingsNow.env?.ANTHROPIC_DEFAULT_OPUS_MODEL || '(not set)'}`);
  log(`settings.json env.ANTHROPIC_DEFAULT_FABLE_MODEL: ${settingsNow.env?.ANTHROPIC_DEFAULT_FABLE_MODEL || '(not set)'}`);

  log('\n--- effective config ---');
  try {
    const cfgLib = require(path.join(HOOKS_DIR, 'lib', 'config.cjs'));
    const cfg = cfgLib.loadConfig();
    log(`  activation: ${cfg.activation}`);
    log(`  codexHandoffUsedPercent: ${cfg.codexHandoffUsedPercent}`);
    log(`  disabledGates: ${cfg.disabledGates.length ? cfg.disabledGates.join(', ') : '(none)'}`);
    log(`  models: review=${cfg.models.review.alias}(${cfg.models.review.id}) escalation=${cfg.models.escalation.alias}(${cfg.models.escalation.id}) ` +
      `code=${cfg.models.code.alias} lookup=${cfg.models.lookup.alias} codex=${cfg.models.codex.id}`);
    for (const w of cfg.warnings) warn(`config: ${w}`);
  } catch (err) {
    warn(`could not evaluate the installed config: ${err.message}`);
  }
  if (checkFailed) process.exitCode = 1;
}

function repair() {
  checkPlatform();
  const manifest = readJSONSafe(MANIFEST_FILE, null);
  if (!manifest) { log('Nothing to repair: not installed.'); return; }
  const oldNodePath = manifest.nodePath;
  if (oldNodePath !== NODE_PATH) {
    let obj;
    try { obj = readJSON(SETTINGS_FILE); } catch { obj = null; }
    if (obj && obj.hooks) {
      for (const [event, rec] of Object.entries(manifest.settings?.events || {})) {
        if (!Array.isArray(obj.hooks[event])) continue;
        const oldCommand = commandFor(GATE_SCRIPT, oldNodePath);
        const newCommand = commandFor(GATE_SCRIPT, NODE_PATH);
        for (const entry of obj.hooks[event]) {
          if (entry.matcher !== rec.matcher || !Array.isArray(entry.hooks)) continue;
          for (const h of entry.hooks) {
            if (h && h.type === 'command' && h.command === oldCommand) h.command = newCommand;
          }
        }
        manifest.settings.events[event].command = newCommand;
      }
      // A real settings.json mutation, same as any other - back it up first, same as
      // install() does, rather than relying solely on whatever backup an earlier install
      // happened to make.
      if (!DRY_RUN) fs.writeFileSync(backupPath(SETTINGS_FILE), fs.readFileSync(SETTINGS_FILE, 'utf8'));
      writeJSON(SETTINGS_FILE, obj);
    }
  }
  manifest.nodePath = NODE_PATH;
  writeJSON(MANIFEST_FILE, manifest);
  log(`Repaired: nodePath set to ${NODE_PATH}${oldNodePath !== NODE_PATH ? ` (was ${oldNodePath}; settings.json commands rewritten)` : ''}.`);
}

// --- entry -----------------------------------------------------------------

if (flag('--check')) check();
else if (flag('--uninstall')) uninstall(PURGE);
else if (flag('--repair')) repair();
else install();
