'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { cachedLiveProbe } = require('./live-probe-cache.cjs');

const CODERS = ['codex', 'kimi', 'deepseek'];
const AVAILABILITY_FILE = 'coder-availability.json';
const AVAILABILITY_LOCK = '.coder-availability.lock';
const EXHAUSTION_FILE = 'coder-exhausted.json';

function hasOwn(env, key) {
  return Object.prototype.hasOwnProperty.call(env || {}, key);
}

function existingFile(file) {
  if (!file) return null;
  try {
    fs.accessSync(file, fs.constants.F_OK | fs.constants.X_OK);
    return path.resolve(file);
  } catch { return null; }
}

function findOnPath(name, env = process.env) {
  const pathValue = typeof env.PATH === 'string' ? env.PATH : '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const found = existingFile(path.join(dir, name));
    if (found) return found;
  }
  return null;
}

function kimiHome(env = process.env) {
  if (hasOwn(env, 'ORCH_KIMI_HOME')) return path.resolve(String(env.ORCH_KIMI_HOME));
  const home = typeof env.HOME === 'string' && env.HOME ? env.HOME : os.homedir();
  return path.join(home, '.kimi-code');
}

function kimiBin(env = process.env) {
  if (hasOwn(env, 'ORCH_KIMI_BIN')) return existingFile(String(env.ORCH_KIMI_BIN));
  return findOnPath('kimi', env) || existingFile(path.join(kimiHome(env), 'bin', 'kimi'));
}

function codexBin(env = process.env) {
  if (hasOwn(env, 'ORCH_CODEX_BIN')) return existingFile(String(env.ORCH_CODEX_BIN));
  if (hasOwn(env, 'CODEX_BIN')) return existingFile(String(env.CODEX_BIN));
  return findOnPath('codex', env);
}

function opencodeBin(env = process.env) {
  if (hasOwn(env, 'ORCH_OPENCODE_BIN')) return existingFile(String(env.ORCH_OPENCODE_BIN));
  return findOnPath('opencode', env);
}

function opencodeConfigPath(env = process.env) {
  if (hasOwn(env, 'ORCH_OPENCODE_CONFIG')) return path.resolve(String(env.ORCH_OPENCODE_CONFIG));
  const home = typeof env.HOME === 'string' && env.HOME ? env.HOME : os.homedir();
  return path.join(home, '.config', 'opencode', 'opencode.jsonc');
}

function stripJsonComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'])\/\/[^\n"]*/g, '$1');
}

/** opencode's configured default model (e.g. "deepseek/deepseek-flash"), or null. */
function opencodeDefaultModel(env = process.env) {
  try {
    const value = JSON.parse(stripJsonComments(fs.readFileSync(opencodeConfigPath(env), 'utf8')));
    return value && typeof value.model === 'string' && value.model.trim() ? value.model.trim() : null;
  } catch {
    return null;
  }
}

/**
 * True when a DeepSeek credential is configured for opencode: the DEEPSEEK_API_KEY env var
 * is set, or `opencode auth list` names DeepSeek. The key itself is only ever checked for
 * presence — never read, printed or stored.
 */
function hasDeepseekCredentials(env, binPath) {
  if (typeof env.DEEPSEEK_API_KEY === 'string' && env.DEEPSEEK_API_KEY.trim()) return true;
  if (!binPath) return false;
  try {
    const probe = spawnSync(binPath, ['auth', 'list'], {
      encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024,
      env: { PATH: env.PATH || '', HOME: env.HOME || os.homedir() },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return !probe.error && probe.status === 0 && /\bdeepseek\b/i.test(String(probe.stdout || ''));
  } catch {
    return false;
  }
}

function hasKimiCredentials(env) {
  try {
    const file = path.join(kimiHome(env), 'credentials', 'kimi-code.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return !!(value && typeof value.access_token === 'string' && value.access_token.length > 0);
  } catch {
    return false;
  }
}

function unavailable(coder, binPath, auth, reason) {
  return { coder, installed: !!binPath, binPath: binPath || null, auth, usable: false, reason };
}

function probeCoderAvailability(coder, options = {}) {
  const env = options.env || process.env;
  if (options.orcaInstalled === false) return unavailable(coder, binFor(coder, env), 'unknown', 'orca not installed');
  if (coder === 'codex') {
    const binPath = codexBin(env);
    if (!binPath) return unavailable(coder, null, 'unknown', 'not installed');
    const auth = options.codexAuthState === 'logged-out' ? 'logged-out'
      : options.codexAuthState === 'ok' ? 'ok' : 'unknown';
    if (auth === 'logged-out') return unavailable(coder, binPath, auth, 'not logged in');
    return { coder, installed: true, binPath, auth, usable: true, reason: null };
  }
  if (coder === 'kimi') {
    const binPath = kimiBin(env);
    if (!binPath) return unavailable(coder, null, 'unknown', 'not installed');
    if (!hasKimiCredentials(env)) return unavailable(coder, binPath, 'logged-out', 'not signed in');
    return { coder, installed: true, binPath, auth: 'ok', usable: true, reason: null };
  }
  if (coder === 'deepseek') {
    const binPath = opencodeBin(env);
    if (!binPath) return unavailable(coder, null, 'unknown', 'not installed');
    if (!hasDeepseekCredentials(env, binPath)) return unavailable(coder, binPath, 'logged-out', 'not signed in');
    // Orca `worker-start --agent opencode` cannot pin a model — it comes from opencode's
    // own config. A non-deepseek default would silently run Claude, so it is unusable.
    const model = opencodeDefaultModel(env);
    if (!model || !/^deepseek\//i.test(model)) {
      return unavailable(coder, binPath, 'ok', model
        ? `default model is not deepseek/* (${model})`
        : 'no default model configured');
    }
    return { coder, installed: true, binPath, auth: 'ok', usable: true, reason: null };
  }
  throw new Error(`unknown coder: ${coder}`);
}

function binFor(coder, env) {
  return coder === 'kimi' ? kimiBin(env) : coder === 'deepseek' ? opencodeBin(env) : codexBin(env);
}

function validateAvailability(entry, _now, expectedCodexAuth) {
  if (!entry || typeof entry !== 'object' || typeof entry.fetchedAt !== 'number') return null;
  const result = {};
  for (const coder of CODERS) {
    const item = entry[coder];
    if (!item || item.coder !== coder || typeof item.usable !== 'boolean' ||
        typeof item.installed !== 'boolean' || typeof item.checkedAt !== 'number') return null;
    result[coder] = { ...item };
  }
  if (expectedCodexAuth === 'logged-out' && result.codex.auth !== 'logged-out') return null;
  if (expectedCodexAuth === 'ok' && result.codex.auth === 'logged-out') return null;
  return result;
}

function coderAvailability(options = {}) {
  const stateDir = options.stateDir || process.env.ORCH_STATE_DIR || path.join(os.homedir(), '.claude', 'orchestrator-gate');
  const cacheSeconds = options.cacheSeconds === undefined ? 600 : options.cacheSeconds;
  const now = options.now === undefined ? Date.now() : options.now;
  const codexAuth = options.codexAuthState || 'unknown';
  const probe = () => Object.fromEntries(CODERS.map((coder) => [coder, {
    ...probeCoderAvailability(coder, {
      env: options.env || process.env,
      orcaInstalled: options.orcaInstalled,
      codexAuthState: codexAuth,
    }),
    checkedAt: now,
  }]));
  if (options.fresh === true) return probe();
  return cachedLiveProbe({
    stateDir,
    cacheFile: AVAILABILITY_FILE,
    lockName: AVAILABILITY_LOCK,
    cacheSeconds,
    now,
    probe,
    validate: (entry, at) => validateAvailability(entry, at, codexAuth),
    probeTimeoutMs: 500,
  });
}

function exhaustionPath(stateDir) {
  return path.join(stateDir, EXHAUSTION_FILE);
}

function validMarker(marker, now) {
  return marker && typeof marker.at === 'number' && Number.isFinite(marker.at) &&
    typeof marker.until === 'number' && Number.isFinite(marker.until) && marker.until > now;
}

function readCoderExhaustion(stateDir, now = Date.now()) {
  try {
    const value = JSON.parse(fs.readFileSync(exhaustionPath(stateDir), 'utf8'));
    const result = {};
    for (const coder of CODERS) if (validMarker(value[coder], now)) result[coder] = { ...value[coder] };
    return result;
  } catch { return {}; }
}

function writeExhaustion(stateDir, value) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = exhaustionPath(stateDir);
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function markCoderExhausted(stateDir, coder, options = {}) {
  if (!CODERS.includes(coder)) return false;
  const now = options.now === undefined ? Date.now() : options.now;
  let until = typeof options.until === 'number' && Number.isFinite(options.until) ? options.until : 0;
  if (until > 0 && until < 1e12) until *= 1000;
  const current = readCoderExhaustion(stateDir, now);
  current[coder] = {
    at: now,
    until: until > now ? until : now + 6 * 60 * 60 * 1000,
    reason: typeof options.reason === 'string' ? options.reason : 'quota exhausted',
  };
  try { writeExhaustion(stateDir, current); return true; } catch { return false; }
}

function clearCoderExhaustion(stateDir, coder) {
  const current = readCoderExhaustion(stateDir, -Infinity);
  if (!Object.prototype.hasOwnProperty.call(current, coder)) return true;
  delete current[coder];
  try { writeExhaustion(stateDir, current); return true; } catch { return false; }
}

module.exports = {
  CODERS, kimiHome, kimiBin, opencodeBin, opencodeConfigPath, opencodeDefaultModel,
  hasDeepseekCredentials, probeCoderAvailability, coderAvailability,
  readCoderExhaustion, markCoderExhausted, clearCoderExhaustion,
};
