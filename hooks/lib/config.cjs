/**
 * config.cjs — loads, defaults and validates the orchestration config.
 *
 * Precedence: ORCH_CONFIG_PATH env var > `~/.claude/orchestration.config.json` > defaults.
 * Read fresh on every call — each hook invocation is its own Node process, so there is
 * nothing to cache across calls; a config edit takes effect on the very next tool call.
 * A missing or unparsable file, or an out-of-range value, silently falls back to the
 * default for that field alone — the gate must never crash on bad config (same rule as
 * "gate failure = allow").
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Every gate id `disabledGates` may name. Kept here (not scattered across the gate) so
// validation and documentation stay in sync with what can actually be disabled.
const GATE_NAMES = [
  'main-no-write',
  'main-no-mutate',
  'code-brief-needs-verify',
  'route-review',
  'review-model-scope',
  'escalation-scope',
  'route-execution-to-codex',
  'execution-model-mismatch',
  'workers-unwatched',
  'workers-unreconciled',
];

const DEFAULT_CONFIG = {
  replyLanguage: null,
  activation: 'orca-only', // 'orca-only' | 'always' | 'off'
  models: {
    review: { alias: 'opus', id: 'claude-opus-5-5' },
    escalation: { alias: 'fable', id: 'claude-fable-5-1' },
    code: { alias: 'sonnet', id: null },
    lookup: { alias: 'haiku', id: null },
    codex: { alias: null, id: 'gpt-5.6-sol' },
  },
  agents: {
    escalation: [], // agent names that always count as the escalation role, alias match only
    lookup: ['Explore'],
  },
  codexHandoffUsedPercent: 40,
  execFallbackWhenCodexUnavailable: 'sonnet',
  heartbeat: { intervalSeconds: 20, idleSeconds: 60, maxSeconds: 3600 },
  disabledGates: [],
};

const ACTIVATION_VALUES = new Set(['orca-only', 'always', 'off']);

function deepMerge(base, override) {
  if (typeof override !== 'object' || override === null || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const key of Object.keys(override)) {
    out[key] = deepMerge(base ? base[key] : undefined, override[key]);
  }
  return out;
}

function configPath() {
  if (process.env.ORCH_CONFIG_PATH) return process.env.ORCH_CONFIG_PATH;
  return path.join(os.homedir(), '.claude', 'orchestration.config.json');
}

/**
 * Reads the config file, distinguishing "does not exist" (normal; not worth a warning)
 * from "exists but is not valid JSON" (a real mistake the operator should hear about,
 * even though the gate still degrades to defaults rather than crashing).
 */
function readRaw() {
  let text;
  try {
    text = fs.readFileSync(configPath(), 'utf8');
  } catch {
    return { value: {}, parseError: null };
  }
  try {
    return { value: JSON.parse(text), parseError: null };
  } catch (err) {
    return { value: {}, parseError: err.message };
  }
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validated view of the merged config. Invalid values degrade to the default for that
 * field and collect a human-readable warning; they never throw and never take down the
 * rest of the config. `warnings` is surfaced once, in the SessionStart banner.
 */
function loadConfig() {
  const { value: raw, parseError } = readRaw();
  const merged = deepMerge(DEFAULT_CONFIG, isPlainObject(raw) ? raw : {});
  const warnings = [];

  if (parseError) {
    warnings.push(`config unparsable: ${parseError}; using defaults.`);
  } else if (raw !== null && typeof raw === 'object' && !isPlainObject(raw)) {
    warnings.push('config must be a JSON object; using defaults.');
  }

  // Each models.<role> must be a {alias, id} object; a role that isn't (e.g. a bare
  // string) would otherwise crash the first place that reads `.alias` off it deeper in
  // the gate (onSessionStart building a banner, currentExecRoute, ...). Falls back to
  // that role's own default rather than the whole models block, so one bad role does not
  // take three good ones down with it.
  for (const role of Object.keys(DEFAULT_CONFIG.models)) {
    const v = merged.models[role];
    if (!isPlainObject(v)) {
      warnings.push(`models.${role} must be an object with "alias"/"id"; using the default.`);
      merged.models[role] = { ...DEFAULT_CONFIG.models[role] };
      continue;
    }
    for (const field of ['alias', 'id']) {
      if (v[field] !== undefined && v[field] !== null && typeof v[field] !== 'string') {
        warnings.push(`models.${role}.${field} must be a string or null; using the default.`);
        v[field] = DEFAULT_CONFIG.models[role][field];
      }
    }
  }

  if (!ACTIVATION_VALUES.has(merged.activation)) {
    warnings.push(`activation "${merged.activation}" is not one of orca-only|always|off; using "orca-only".`);
    merged.activation = 'orca-only';
  }

  const threshold = Number(merged.codexHandoffUsedPercent);
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) {
    warnings.push(`codexHandoffUsedPercent "${merged.codexHandoffUsedPercent}" is not an integer 0-100; using ${DEFAULT_CONFIG.codexHandoffUsedPercent}.`);
    merged.codexHandoffUsedPercent = DEFAULT_CONFIG.codexHandoffUsedPercent;
  } else {
    merged.codexHandoffUsedPercent = threshold;
  }

  if (!Array.isArray(merged.disabledGates)) {
    warnings.push('disabledGates must be an array; ignoring.');
    merged.disabledGates = [];
  } else {
    const unknown = merged.disabledGates.filter((g) => !GATE_NAMES.includes(g));
    if (unknown.length) warnings.push(`disabledGates has unknown gate name(s): ${unknown.join(', ')}.`);
  }

  if (merged.execFallbackWhenCodexUnavailable !== 'sonnet' && merged.execFallbackWhenCodexUnavailable !== null) {
    warnings.push(`execFallbackWhenCodexUnavailable "${merged.execFallbackWhenCodexUnavailable}" is not "sonnet" or null; using "sonnet".`);
    merged.execFallbackWhenCodexUnavailable = 'sonnet';
  }

  if (!Array.isArray(merged.agents.escalation)) merged.agents.escalation = DEFAULT_CONFIG.agents.escalation;
  if (!Array.isArray(merged.agents.lookup)) merged.agents.lookup = DEFAULT_CONFIG.agents.lookup;

  merged.warnings = warnings;
  return merged;
}

/** True when `gate` was named in `cfg.disabledGates`. */
function gateDisabled(cfg, gate) {
  return Array.isArray(cfg.disabledGates) && cfg.disabledGates.includes(gate);
}

/**
 * Sonnet takes over code once Codex has used this much (or more) of its tightest quota
 * window. `ORCH_CODEX_HANDOFF_USED` overrides the config value for one process (used by
 * the heartbeat/CLI and by tests); an invalid override falls back to the config value.
 */
function handoffUsed(cfg) {
  const envOverride = process.env.ORCH_CODEX_HANDOFF_USED;
  if (envOverride !== undefined) {
    const n = Number(envOverride);
    if (Number.isInteger(n) && n >= 0 && n <= 100) return n;
  }
  return cfg.codexHandoffUsedPercent;
}

/** Directory holding session state (`<sid>.json`, heartbeat files, violations.log). */
function stateDir() {
  return process.env.ORCH_STATE_DIR || path.join(os.homedir(), '.claude', 'orchestrator-gate');
}

module.exports = { GATE_NAMES, DEFAULT_CONFIG, loadConfig, gateDisabled, handoffUsed, configPath, stateDir };
