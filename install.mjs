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

import crypto from 'node:crypto';
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
const DOCS_FILE = path.join(CLAUDE_DIR, 'docs', 'orchestration-contract.md');
const CONFIG_FILE = path.join(CLAUDE_DIR, 'orchestration.config.json');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const CLAUDE_MD_FILE = path.join(CLAUDE_DIR, 'CLAUDE.md');
const AGENTS_DIR = path.join(CLAUDE_DIR, 'agents');
const MANIFEST_FILE = path.join(HOOKS_DIR, 'install-manifest.json');
const JANITOR_LABEL = 'com.orca.claude-codex-orchestration.janitor';
const JANITOR_PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${JANITOR_LABEL}.plist`);

// Agent definitions the installer ships. They are ONLY ever created, never overwritten:
// an existing file may be user-edited, and uninstall removes only a file this installer
// created whose content still matches the shipped original.
const AGENT_FILES = ['sonnet-coder.md'];

const GATE_SCRIPT = 'orchestrator-gate.cjs';
const HOOK_FILES = [
  'orchestrator-gate.cjs', 'orca-heartbeat.cjs', 'orca-janitor.cjs', 'orca-resume-scheduler.cjs',
  'lib/config.cjs', 'lib/exec-route-by-quota.cjs', 'lib/codex-quota-probe.cjs', 'lib/shell-orca-invocations.cjs',
  'lib/worker-groups.cjs', 'lib/ownership.cjs', 'lib/ownership-claims.cjs', 'lib/file-lock.cjs',
  'lib/parallel-ownership-gates.cjs', 'lib/parallel-agent-cap.cjs', 'lib/heartbeat-liveness.cjs',
  'lib/terminal-signals.cjs', 'lib/worker-progress-fingerprint.cjs', 'lib/worker-quota-handover.cjs', 'lib/quota-reset-resume.cjs', 'lib/live-probe-cache.cjs',
  'lib/coder-availability.cjs', 'lib/codex-eligibility.cjs', 'lib/codex-priority-tier.cjs',
  'lib/orca-worker-list-pages.cjs', 'lib/heartbeat-event-classes.cjs',
];
const RETIRED_HOOK_FILES = [
  'lib/kimi-quota-probe.cjs', 'lib/deepseek-quota-probe.cjs', 'lib/coder-pool-route.cjs',
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

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function launchctl(args) {
  const bin = process.env.ORCH_LAUNCHCTL_BIN || 'launchctl';
  try {
    execFileSync(bin, args, { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function installJanitor(prevManifest) {
  if (process.platform !== 'darwin') return { supported: false, installed: false };
  const existed = fs.existsSync(JANITOR_PLIST);
  let backedUpAt = prevManifest?.janitor?.backedUpAt || null;
  const cfgLib = require(path.join(REPO_ROOT, 'hooks', 'lib', 'config.cjs'));
  const cfg = cfgLib.loadConfig();
  const interval = cfg.janitor.intervalMinutes;
  const janitorLog = path.join(cfgLib.stateDir(), 'janitor.log');
  const text = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0"><dict>\n` +
    `  <key>Label</key><string>${JANITOR_LABEL}</string>\n` +
    `  <key>ProgramArguments</key><array><string>${xmlEscape(NODE_PATH)}</string><string>${xmlEscape(path.join(HOOKS_DIR, 'orca-janitor.cjs'))}</string></array>\n` +
    `  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xmlEscape(process.env.PATH || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin')}</string></dict>\n` +
    `  <key>StandardErrorPath</key><string>${xmlEscape(janitorLog)}</string>\n` +
    `  <key>StartInterval</key><integer>${interval * 60}</integer>\n` +
    `  <key>RunAtLoad</key><true/>\n` +
    `</dict></plist>\n`;
  if (existed && !prevManifest?.janitor?.installed && !backedUpAt) {
    backedUpAt = backupPath(JANITOR_PLIST);
    if (!DRY_RUN) fs.copyFileSync(JANITOR_PLIST, backedUpAt);
  }
  writeText(JANITOR_PLIST, text);
  if (!DRY_RUN) {
    const domain = `gui/${process.getuid()}`;
    launchctl(['bootout', domain, JANITOR_PLIST]);
    if (!launchctl(['bootstrap', domain, JANITOR_PLIST])) {
      warn(`could not register ${JANITOR_PLIST} with launchctl; the janitor can still be run manually.`);
    }
  }
  return { supported: true, installed: true, path: JANITOR_PLIST, label: JANITOR_LABEL,
    intervalMinutes: interval, createdNew: prevManifest?.janitor?.createdNew ?? !existed, backedUpAt };
}

function uninstallJanitor(manifest) {
  const record = manifest.janitor;
  if (!record || !record.installed || process.platform !== 'darwin') return;
  if (!DRY_RUN) launchctl(['bootout', `gui/${process.getuid()}`, record.path || JANITOR_PLIST]);
  if (record.backedUpAt && fs.existsSync(record.backedUpAt)) {
    if (DRY_RUN) log(`  [dry-run] would restore ${record.backedUpAt} -> ${record.path || JANITOR_PLIST}`);
    else {
      fs.copyFileSync(record.backedUpAt, record.path || JANITOR_PLIST);
      fs.unlinkSync(record.backedUpAt);
      launchctl(['bootstrap', `gui/${process.getuid()}`, record.path || JANITOR_PLIST]);
    }
  } else {
    removeFile(record.path || JANITOR_PLIST);
  }
}

// --- install: hook files -----------------------------------------------------

function installHookFiles() {
  log(`Installing hooks into ${HOOKS_DIR}`);
  for (const rel of HOOK_FILES) {
    copyFile(path.join(REPO_ROOT, 'hooks', rel), path.join(HOOKS_DIR, rel));
  }
  for (const rel of RETIRED_HOOK_FILES) removeFile(path.join(HOOKS_DIR, rel));
}

function uninstallHookFiles(manifest) {
  for (const rel of manifest.files || HOOK_FILES) {
    removeFile(path.join(HOOKS_DIR, rel));
  }
  for (const rel of RETIRED_HOOK_FILES) removeFile(path.join(HOOKS_DIR, rel));
  // Remove the lib/ and orchestration/ dirs only if we emptied them ourselves.
  if (!DRY_RUN) {
    for (const dir of [path.join(HOOKS_DIR, 'lib'), HOOKS_DIR]) {
      try { fs.rmdirSync(dir); } catch {} // fails silently if non-empty or already gone
    }
  }
}

// --- install: rules file ------------------------------------------------------

// sha256 of every rules/orchestration-contract.md this repo ever shipped (the full contract,
// before it moved to docs/). An install made by an older installer has no recorded hash, so a
// rules file whose content matches one of these is known to be an untouched installer copy
// and is safe to upgrade in place.
const LEGACY_RULES_SHA256 = new Set([
  '7eb648c67d536ac07dce65cf823d3af908bb4436fc09f40719efc31ac91ff1d7',
  'febe7a51fc1fb8288c38445bf24c9f0608b1b2dac97dd5dde084e38838298032',
  '3fe9ea928eba9bcb829136165bacad02cb822f17a0b932fd4d4a63f03e18c9fa',
  'e408c68d55640ca7cbc6020d907036ff22ae2d16ab33b572f9752f998b82a532',
  '897e666e22322bee4c50dd15c93b823cdc14e8609aa11e393b1ebbf22ed564d6',
  '9f004cc678f10ef8fd571533d57ccc71286259d3e7a14139cc18a4267e60234a',
  '9c0e30718d2d104c9c54ffc45337bb017f73088efe4758ea4f8654ab1abab7dc',
  '8ad812b65d844c155cd1a03e3c500a2d62ba888ed7e334361aaa06fc72eb2c50',
  '7f5580c335318aca2a31432a0f4b47500332f46d65f16c4883759edaf9616258',
  '8df5637230c9b811695aaae045910e7b08ef8034f7bc152ee42db47f0a047ee3',
  'd882853556c594f06e14d2573541b2e8af5593ff1b8fc562067577ab1961a3c3',
  '891a040682659be4d7f1bbe32dbc186cd55db89878f0ab27bc9fd3a874903b7e',
  '0e3553cc6e0af2bd79d46a5378dbe495f7603050d4a43633fa0a091aed736181',
  '43b89ded32dc2550892d1031176ab8e80f42253dbdb24fe7fd46bfba03a62700',
  '1fe4748bcdd0f50725146af40ef26d693db5d96ba56baa918e8390f026705320',
  'c25f35c242826817ecb98fa4774a18705b72e206526c54894f5ea1e2bb39feee',
  '6e10c0bc73f388de3bfba989c56ec2773d35033e9083cacdb78442123a0045e2',
  'd9f838c5d15cc68f88a0ffb244360144df62bd220401ecc0485d1d463cd720ee',
  '15f2b436e6368d055a6a40159e94db4295e0be86bf8b974d20d89ef55a31bea8',
  '45a78ce66a87aa47280f19fa91760ef76793f8826bb7b845573f47e43a6d935e',
  '7e60b1ce9273d898a8d45a5797b1fca1c8f2baba7302efb02d8ea89facc03609',
  'c3379d766a2efd4e70014604cf89d5c8fe33326e55116289efcc841a34792832',
  '192f03a7610699919d5c077e545bd5a79ee0c358f5b4d3332c846ed6fdca8284',
  '5c00e050b953eefaba0b4b06c471a3056ba504c9de43b9ef6da878874538dd5a',
  '72b3be8c7313d10a2e5eedcbb6f41cfd4509387cebc4a1f093ffcd50fe9a9988',
  'ca88d164c718572892db35ce28793a114efccdc60bfe9d2d8e8eb92ff092e370',
  '9374a8b1f7130662818d100a2666037170e0c32f60625a0449610a0aa564d8f4',
  'b5d595573a0885f50154633da98708def19e110c299629d5fddb087ac8fc004a',
  '9b6ec458c7ceb02ae56973cd57b27ca4b3f6c22a3c659b56a0bf17c57d003e09',
  '5e3a5d49e9da7913789792611ae168f674950866d9cdddc4057160b3263e54a4',
  'de9cdfafd0304663942cfd0b111de131ea8ea51e79d9401e706e7c12d41a79e4',
  'ea96e6980fa59f9847e0e92aad527e1445eb729482132a4bd48577bf8225a629',
  '58993be054dabedec4430199dfa913b32c0e6ccca048bb2ade179a742d461e45',
  '9860e5bd731dd0ec909f3dd37e4124c17dedd35a1e2a05420a158891d71ce8a5',
  '8c1b7748fa00d87099c71ddceb02cb3b57d4d2665b606aff7dfb1061d578ef37',
  'cc52eb2990919f7d5f34459d83ddf31d78460c2db8d88444ae1e861d96df766e',
  'f080501364d841aeb87ed8ccd9449901b1bdefc90a793d63673c7e8558cd6919',
  '855011f041569e99f8fec0aec14614d391ec7031ac5e64b924708f3708ba6033',
  '08c8c9806c379fb5b8770746f6f72e286392635fb7c5a8ea4e64c8d66a7aff8c',
  '474e6e89b107a5a369211c2fba4805af18a6091ff71ca4e6b67cdc3cbacb8928',
  'c1e916da792bfd4d329aa61cbf7ef2ca46edd0edb76d36ec7d8ac8a13bb89521',
  '44379327a2d6ae3c512e3d5b233294ce48872276a628e35d1f5dc851f6fcee14',
  '749cbb9d68dddbdb6c5f9113b145f86e1b01d5e7ac25c59e844563d2257605e2',
  '51cf7002acd54bd158759301630615959613e769292e278b7df23da1bbf9fdb1',
  '91c92d0bd6cd5a1184d766737ed006017644828aaf7ff59509e96b4e53cc0053',
  'a36e0da601a1e52bb9f6b10a82fd1ed96d598eee0ed1db7d33f555dcb862585e',
  '83d5584e2dd974037987dff9afc73a5b14e22f40dce378c486d33446136d6922',
  'e55dd9fe2619db6b158b765f9656e51eff6b593358345fa31d7256979f20d8f7',
  'a128e3ab4adedc34120522866e6e30f0120a3e849d6cf24868e22475ca6b6f90',
  '9221e185102ea55515a5c80627a1330bcd3f34a71184558412d6b448ac0e544b',
  '913f126f55a8e1283b7d34be7a52afce8e13fba4bf2a834577fde02df4caadea',
  '7ec0e2936cbfa578650398187d49cbd3663dd486631fcce875af4bbab03cb36d',
  'abd84f3db472c09c301be42df47edfe14a039e22b572bf4e107c3b0b7a8f44e3',
  '3af1cd2a6fa0a69a785f64d740c19a43644de88d948057a0f79ebebc526d5e03',
  'e7d0426746d896b51db3289f029fc0348623d1e1036e65ca132875d228b0a0ef',
  '1a06bd9a5d22add83aa46f6aa41021098fc23beda0acbafae226fb699f085b4d',
  '420d89c9253b7dc3aad6f0998efb2d5eb6d1a5bd6292f04edd3fc8dbf3e27bff',
  'e2a8a5582072fac657379065f2112aeacb541a2ae474a620937148ae66a74d67',
  '5209278ddc954ba6efd73ccf07087928cd7e854ee0d4a94dcf20f79d29ed0980',
  'bcec76e07002194c512b54191a525d894f981312d5c02b2bb234f30f5b4ba20e',
  '615445469d5498876907edb153ecb612d0d6e5efa7e8ba72f1d271199201bba6',
  'b3d634cf150ba4690c5d28c5f6f0aba2d606520bcab830e588354b2ad5d6908e',
  '6f592b17d16c33f0e13e4c76545d53c53d9b95fbd15cac4829b99ff0ee278312',
  '60d716bfb6daaae30e19ba2f39c6d690fea0a1efae8098d33a016b3ae4790ab6',
  'acda889a1aff885183301bb6d5d37e2ba63543cfb3a2ecbc3e6067ed577c47fc',
  '6fabbe79de5474c0587ffa81d26a5ea9eb5399f0fc61396963bc48f465be0041',
  '7caf095becd1561beb164b4665cd04e8a467a845e65da445752f62a4a6803924',
  '9967ba69cecf761867a1823d08b1861572734d7f54c0c157b795c1b656015f47',
  'dd6dd18e94bdf8174df385e8c3ac980c08dc26e7dff501ca6d386b919f22a618',
  'a1a312ee9afd2613d727a7ed48a4d4aa0020c1146330b027f8c76789e052b486',
  'ba945f4e83dba4e7fde4f49c4efa10e63d399d7ddd2ce9b8bed1abd8c83a0497',
  'b5fb0acfd8307501b814d28fc3f6304749e896c559aa485228c854d00dea673b'
]);

function sha256Of(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Both shipped contract files (summary rules + full docs) share one install/uninstall path.
// The manifest record keeps sha256 of the content we last wrote so a later run can tell
// "still the file we installed" from "operator edited it", and carries ownership forward.
function installManagedFile(src, dst, prevRecord, legacyHashes = new Set()) {
  const content = fs.readFileSync(src, 'utf8');
  const sha256 = sha256Of(content);
  const existing = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : null;
  const owned = !!prevRecord?.createdNew;
  const keptBackup = prevRecord?.backedUpAt || null;
  if (existing === null) {
    writeText(dst, content);
    return { path: dst, createdNew: true, backedUpAt: null, sha256 };
  }
  if (existing === content) {
    // Content matches what this installer ships: inherit ownership from the last install.
    return { path: dst, createdNew: owned, backedUpAt: keptBackup, sha256, alreadyCurrent: true };
  }
  const existingHash = sha256Of(existing);
  const pristine = prevRecord?.sha256 ? existingHash === prevRecord.sha256 : legacyHashes.has(existingHash);
  if (pristine) {
    // An older copy we shipped, never edited: upgrade silently, ownership unchanged.
    writeText(dst, content);
    return { path: dst, createdNew: owned, backedUpAt: keptBackup, sha256, upgraded: true };
  }
  if (!FORCE) {
    warn(`${dst} already exists and differs; leaving it. Re-run with --force to overwrite (a backup is made first).`);
    return { path: dst, createdNew: owned, backedUpAt: keptBackup, sha256: prevRecord?.sha256 || null, skipped: true };
  }
  const bak = backupPath(dst);
  if (!DRY_RUN) fs.copyFileSync(dst, bak);
  writeText(dst, content);
  return { path: dst, createdNew: owned, backedUpAt: bak, sha256, forced: true };
}

// Removes the file only when it is still what we wrote (recorded hash, or the shipped
// source / a known legacy copy for records without one); a --force backup is restored.
function uninstallManagedFile(src, dst, record, legacyHashes = new Set()) {
  if (!record || (!record.createdNew && !record.backedUpAt)) return; // never touch what we did not write
  const current = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : null;
  if (current !== null) {
    const h = sha256Of(current);
    const shipped = (() => { try { return fs.readFileSync(src, 'utf8'); } catch { return null; } })();
    const unchanged = record.sha256 ? h === record.sha256 : (current === shipped || legacyHashes.has(h));
    if (!unchanged) {
      warn(`${dst} was edited since install; leaving it in place.`);
      return;
    }
  }
  const bak = record.backedUpAt;
  if (bak && fs.existsSync(bak)) {
    if (DRY_RUN) { log(`  [dry-run] would restore ${bak} -> ${dst}`); return; }
    fs.copyFileSync(bak, dst);
    removeFile(bak);
    return;
  }
  if (record.createdNew) removeFile(dst);
}

const RULES_SRC = path.join(REPO_ROOT, 'rules', 'orchestration-contract.md');
const DOCS_SRC = path.join(REPO_ROOT, 'docs', 'orchestration-contract.md');

function installRulesFile(prevManifest) {
  return installManagedFile(RULES_SRC, RULES_FILE, prevManifest?.rulesFile, LEGACY_RULES_SHA256);
}

function installDocsFile(prevManifest) {
  return installManagedFile(DOCS_SRC, DOCS_FILE, prevManifest?.docsFile);
}

function uninstallRulesFile(manifest) {
  uninstallManagedFile(RULES_SRC, RULES_FILE, manifest.rulesFile, LEGACY_RULES_SHA256);
  uninstallManagedFile(DOCS_SRC, DOCS_FILE, manifest.docsFile);
}

// --- install: agent definitions ------------------------------------------------

function installAgents(prevManifest) {
  const results = {};
  for (const rel of AGENT_FILES) {
    const dest = path.join(AGENTS_DIR, rel);
    if (fs.existsSync(dest)) {
      // Never overwrite: an existing agent definition may be user-edited.
      const owned = prevManifest ? !!prevManifest.agents?.[rel]?.createdNew : false;
      results[rel] = { path: dest, createdNew: owned, alreadyPresent: true };
      continue;
    }
    copyFile(path.join(REPO_ROOT, 'agents', rel), dest);
    results[rel] = { path: dest, createdNew: true };
  }
  return results;
}

function uninstallAgents(manifest) {
  for (const rel of AGENT_FILES) {
    const record = manifest.agents?.[rel];
    if (!record || !record.createdNew) continue; // never delete a file we did not create
    const dest = path.join(AGENTS_DIR, rel);
    const current = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
    const src = (() => { try { return fs.readFileSync(path.join(REPO_ROOT, 'agents', rel), 'utf8'); } catch { return null; } })();
    if (current !== null && src !== null && current !== src) {
      warn(`${dest} was edited since install; leaving it in place.`);
      continue;
    }
    removeFile(dest);
  }
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
  const docsFile = installDocsFile(prevManifest);
  const configFile = installConfig(prevManifest);
  const janitor = installJanitor(prevManifest);
  const settings = installSettings({ pinModels: !NO_PIN }, prevManifest);
  const claudeMd = installClaudeMd(prevManifest);
  const agents = installAgents(prevManifest);

  const manifest = {
    version: 1,
    installedAt: new Date().toISOString(),
    nodePath: NODE_PATH,
    hooksDir: HOOKS_DIR,
    files: HOOK_FILES,
    rulesFile,
    docsFile,
    configFile,
    janitor,
    settings,
    claudeMd,
    agents,
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
  uninstallJanitor(manifest);
  uninstallClaudeMd(manifest);
  uninstallAgents(manifest);
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
  const needed = ['lib/coder-availability.cjs', 'lib/codex-eligibility.cjs',
    'lib/exec-route-by-quota.cjs', 'lib/config.cjs', 'lib/codex-priority-tier.cjs'];
  for (const base of [HOOKS_DIR, path.join(REPO_ROOT, 'hooks')]) {
    if (needed.every((rel) => fs.existsSync(path.join(base, rel)))) return base;
  }
  return null;
}

/** Report Codex availability on this machine, effective settings, and eligibility. */
function checkCoders(hasOrca) {
  log('\n--- coder availability ---');
  const base = hookLibBase();
  if (!base) {
    warn('could not find the coder-routing libraries (not installed yet?) - skipping coder availability.');
    return;
  }
  const availLib = require(path.join(base, 'lib/coder-availability.cjs'));
  const eligibilityLib = require(path.join(base, 'lib/codex-eligibility.cjs'));
  const quotaLib = require(path.join(base, 'lib/exec-route-by-quota.cjs'));
  const cfgLib = require(path.join(base, 'lib/config.cjs'));
  let probeStateDir = null;
  try {
    const cfg = cfgLib.loadConfig();
    const now = Date.now();
    const stateDir = cfgLib.stateDir();
    const threshold = cfgLib.handoffUsed(cfg);
    const cap = cfgLib.maxParallelCodexWorkers(cfg);
    log(`routing: defaultCoder=${cfgLib.defaultCoder(cfg)} codexHandoffUsedPercent=${threshold} ` +
      `maxParallelCodexWorkers=${cap}`);
    const authState = quotaLib.codexAuthState(stateDir, now, cfgLib.coderAvailabilityCacheSeconds(cfg) * 1000);
    const availability = availLib.coderAvailability({
      fresh: true, env: process.env, orcaInstalled: !!hasOrca, codexAuthState: authState, now,
    });
    probeStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-check-'));
    let quota = null;
    if (availability.codex && availability.codex.usable) {
      const q = quotaLib.codexQuota(now, { stateDir: probeStateDir, cacheSeconds: 0 });
      quota = q && !q.failed ? q : null;
    }
    for (const coder of ['codex']) {
      const a = availability[coder] || { usable: false, reason: 'unknown', auth: 'unknown', binPath: null };
      const q = quota;
      const quotaText = q && typeof q.usedPercent === 'number' ? `${Math.round(100 - q.usedPercent)}% left` : 'unknown';
      const binText = a.binPath ? `${a.binPath} ${versionOf(a.binPath) || 'present'}`.trim() : 'none';
      const authText = a.auth === 'logged-out' ? 'logged out' : a.auth;
      log(`coder ${coder}: ${a.usable ? 'usable' : `UNUSABLE (${a.reason})`} ` +
        `[binary ${binText}, auth ${authText}, quota ${quotaText}]`);
    }
    const eligibility = eligibilityLib.codexEligibility({
      availability: availability.codex, quota, threshold,
      exhaustion: availLib.readCoderExhaustion(stateDir, now).codex,
    });
    log(`codex eligibility: ${eligibility.state}${eligibility.reason ? ` (${eligibility.reason})` : ''}`);
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
    try {
      const base = hookLibBase();
      if (base) {
        const priorityTierLib = require(path.join(base, 'lib/codex-priority-tier.cjs'));
        const cfgLib = require(path.join(base, 'lib/config.cjs'));
        const allowed = cfgLib.codexAllowPriorityTier(cfgLib.loadConfig());
        const found = allowed ? null : priorityTierLib.detectCodexPriorityTier(process.env);
        if (found) {
          warn(`Codex config ${found.file}:${found.lineNumber} sets service_tier = "${found.tier}" ` +
            `(shows as "fast" in the Codex footer) - this burns Codex quota faster; remove the line ` +
            `\`${found.line}\`, or set codexAllowPriorityTier: true to accept it.`);
        }
      }
    } catch (err) {
      warn(`could not check the Codex config for service_tier: ${err.message}`);
    }
  }
  if (!hasOrca || !hasCodex) {
    warn('Codex opt-in will fall back to the in-session coder without both Orca and a usable Codex quota reading. ' +
      'See "Coder availability (no Orca / no Codex)" in docs/orchestration-contract.md.');
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
  for (const p of [RULES_FILE, DOCS_FILE, CONFIG_FILE, SETTINGS_FILE]) {
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
