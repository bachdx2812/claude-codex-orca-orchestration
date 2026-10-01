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
  'max-parallel-codex-workers',
  'max-parallel-kimi-workers',
  'max-parallel-deepseek-workers',
  'review-model-follows-coder',
  'verify-model',
  'route-verify',
  'code-brief-needs-owns',
  'ownership-overlap',
  'max-parallel-agents',
];

const DEFAULT_CONFIG = {
  replyLanguage: null,
  activation: 'orca-only', // 'orca-only' | 'always' | 'off'
  models: {
    review: { alias: 'opus', id: 'claude-opus-5-5' },
    escalation: { alias: 'fable', id: 'claude-fable-5-1' },
    code: { alias: 'sonnet', id: null, effort: 'medium', agentType: 'sonnet-coder' },
    lookup: { alias: 'haiku', id: null },
    codex: { alias: null, id: 'gpt-5.6-sol' },
    kimi: { alias: null, id: null },
    deepseek: { alias: null, id: null },
    // Verify-run work (running existing checks — CI, screenshots, play-test, post-deploy
    // smoke — rather than reading code and judging a diff) runs on this model (operator
    // decision, 2026-10-02): Sonnet runs the checks, Opus reads and judges the diff.
    verify: { alias: 'sonnet', id: 'claude-sonnet-5-5', effort: 'medium' },
    // Review model follows the code's author (operator decision, 2026-10-02): reading code
    // and judging a diff always runs on the review model — Opus — regardless of which coder
    // wrote it ("code by deepseek/kimi/codex MUST be reviewed by opus"). Verify-run work
    // does NOT follow the author; it always runs on models.verify. Values are model aliases;
    // tunable per coder.
    reviewByCoder: { codex: 'opus', kimi: 'opus', deepseek: 'opus', sonnet: 'opus' },
    // Effort the in-session (code-model) reviewer runs at.
    reviewEffort: 'medium',
  },
  agents: {
    escalation: [], // agent names that always count as the escalation role, alias match only
    lookup: ['Explore'],
  },
  codexHandoffUsedPercent: 95,
  handoverWarnMarginPercent: 5,
  autoResumeAfterReset: true,
  autoResumePanel: true,
  codexQuotaCacheSeconds: 60,
  kimiHandoffUsedPercent: 95,
  kimiQuotaCacheSeconds: 60,
  // DeepSeek (opencode) is pay-per-use with no rate-limit window: its "quota" is the share
  // of a DAILY SPEND CAP already used. 0 = unlimited (operator decision, 2026-10-01): only
  // an exhausted balance (402 "Insufficient Balance") stops it.
  deepseekRole: 'overflow', // 'overflow' (only when no subscription coder is eligible) | 'peer'
  deepseekDailySpendCapUsd: 0,
  deepseekHandoffUsedPercent: 95,
  deepseekQuotaCacheSeconds: 60,
  coderAvailabilityCacheSeconds: 600,
  coderHeadroomTieBand: 10, // headroom points within which two coders tie (falls back to fewer live workers)
  unknownHeadroomAssumed: 30, // headroom points a quota-unknown coder is ranked as
  execFallbackWhenCodexUnavailable: 'sonnet',
  heartbeat: {
    intervalSeconds: 20,
    idleSeconds: 60,
    maxSeconds: 3600,
    stallSeconds: 900,
    stallSecondsByAgent: { kimi: 600 },
  },
  maxParallelCodexWorkers: 3, // 0 = unlimited
  maxParallelKimiWorkers: 3, // 0 = unlimited
  maxParallelDeepseekWorkers: 3, // 0 = unlimited
  ownershipClaimTtlMinutes: 120, // background-Agent Owns: claims auto-release after this long
  disabledGates: [],
  // heartbeat done-worktree handling: 'remove' (run `orca worktree rm` itself), 'remind'
  // (wake the panel with the rm command, never run it) or 'off'. Legacy booleans still
  // load: true -> 'remind', false -> 'off'.
  closeDoneWorktrees: 'remind',
  // Machine-wide budget cap on live Orca workers + in-session subagents, MACHINE-wide (summed
  // across every session's state file, not just this one) — the resource being budgeted is
  // this machine's cores, not any one session's own concurrency. `maxParallelAgents: null`
  // (default) derives the limit as max(1, floor(parallelCoreFraction x cores)); an explicit
  // integer overrides that derivation entirely, and `0` means unlimited.
  parallelCoreFraction: 0.8,
  maxParallelAgents: null,
};

const ACTIVATION_VALUES = new Set(['orca-only', 'always', 'off']);
const EFFORT_VALUES = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CLOSE_DONE_WORKTREES_MODES = new Set(['remove', 'remind', 'off']);

/** Normalizes a closeDoneWorktrees value (config or env) to 'remove'|'remind'|'off', or
 * null when it is not any accepted spelling (legacy booleans included). */
function normalizeCloseDoneWorktrees(value) {
  if (value === true) return 'remind';
  if (value === false) return 'off';
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (CLOSE_DONE_WORKTREES_MODES.has(v)) return v;
    if (v === '1' || v === 'true') return 'remind';
    if (v === '0' || v === 'false') return 'off';
  }
  return null;
}

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

function configuredNumber(value) {
  if (value === null || typeof value === 'boolean' ||
      (typeof value === 'string' && value.trim() === '')) return NaN;
  return Number(value);
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
    // reviewByCoder (an author->alias map) and reviewEffort (a string) live under models
    // but are not {alias,id} roles; they are validated separately below.
    if (role === 'reviewByCoder' || role === 'reviewEffort') continue;
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

  // models.code's dispatch shape (Fix 7): the effort and agent subagent_type the in-session
  // code route is dispatched with.
  if (!EFFORT_VALUES.has(merged.models.code.effort)) {
    warnings.push(`models.code.effort "${merged.models.code.effort}" is not one of low|medium|high|xhigh|max; using "${DEFAULT_CONFIG.models.code.effort}".`);
    merged.models.code.effort = DEFAULT_CONFIG.models.code.effort;
  }
  if (typeof merged.models.code.agentType !== 'string' || !merged.models.code.agentType.trim()) {
    warnings.push(`models.code.agentType must be a non-empty string; using "${DEFAULT_CONFIG.models.code.agentType}".`);
    merged.models.code.agentType = DEFAULT_CONFIG.models.code.agentType;
  }

  // models.verify carries an effort like models.code does (the verify model runs the checks).
  if (!EFFORT_VALUES.has(merged.models.verify.effort)) {
    warnings.push(`models.verify.effort "${merged.models.verify.effort}" is not one of low|medium|high|xhigh|max; using "${DEFAULT_CONFIG.models.verify.effort}".`);
    merged.models.verify.effort = DEFAULT_CONFIG.models.verify.effort;
  }

  // Review-by-coder map: author coder -> review model alias. Values must be model aliases
  // (a string), else that entry falls back to its own default.
  if (!isPlainObject(merged.models.reviewByCoder)) {
    warnings.push('models.reviewByCoder must be an object mapping a coder to a review model alias; using the default.');
    merged.models.reviewByCoder = { ...DEFAULT_CONFIG.models.reviewByCoder };
  } else {
    for (const author of Object.keys(DEFAULT_CONFIG.models.reviewByCoder)) {
      const value = merged.models.reviewByCoder[author];
      if (typeof value !== 'string' || !value.trim()) {
        warnings.push(`models.reviewByCoder.${author} must be a model alias string; using "${DEFAULT_CONFIG.models.reviewByCoder[author]}".`);
        merged.models.reviewByCoder[author] = DEFAULT_CONFIG.models.reviewByCoder[author];
      }
    }
  }
  if (!EFFORT_VALUES.has(merged.models.reviewEffort)) {
    warnings.push(`models.reviewEffort "${merged.models.reviewEffort}" is not one of low|medium|high|xhigh|max; using "${DEFAULT_CONFIG.models.reviewEffort}".`);
    merged.models.reviewEffort = DEFAULT_CONFIG.models.reviewEffort;
  }

  if (!ACTIVATION_VALUES.has(merged.activation)) {
    warnings.push(`activation "${merged.activation}" is not one of orca-only|always|off; using "orca-only".`);
    merged.activation = 'orca-only';
  }

  const threshold = configuredNumber(merged.codexHandoffUsedPercent);
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) {
    warnings.push(`codexHandoffUsedPercent "${merged.codexHandoffUsedPercent}" is not an integer 0-100; using ${DEFAULT_CONFIG.codexHandoffUsedPercent}.`);
    merged.codexHandoffUsedPercent = DEFAULT_CONFIG.codexHandoffUsedPercent;
  } else {
    merged.codexHandoffUsedPercent = threshold;
  }

  const handoverWarnMargin = configuredNumber(merged.handoverWarnMarginPercent);
  if (!Number.isInteger(handoverWarnMargin) || handoverWarnMargin < 0 || handoverWarnMargin > 100) {
    warnings.push(`handoverWarnMarginPercent "${merged.handoverWarnMarginPercent}" is not an integer 0-100; using ${DEFAULT_CONFIG.handoverWarnMarginPercent}.`);
    merged.handoverWarnMarginPercent = DEFAULT_CONFIG.handoverWarnMarginPercent;
  } else {
    merged.handoverWarnMarginPercent = handoverWarnMargin;
  }

  for (const key of ['autoResumeAfterReset', 'autoResumePanel']) {
    if (typeof merged[key] !== 'boolean') {
      warnings.push(`${key} must be a boolean; using ${DEFAULT_CONFIG[key]}.`);
      merged[key] = DEFAULT_CONFIG[key];
    }
  }

  const quotaCacheSeconds = configuredNumber(merged.codexQuotaCacheSeconds);
  if (!Number.isInteger(quotaCacheSeconds) || quotaCacheSeconds < 0 || quotaCacheSeconds > 3600) {
    warnings.push(`codexQuotaCacheSeconds "${merged.codexQuotaCacheSeconds}" is not an integer 0-3600; using ${DEFAULT_CONFIG.codexQuotaCacheSeconds}.`);
    merged.codexQuotaCacheSeconds = DEFAULT_CONFIG.codexQuotaCacheSeconds;
  } else {
    merged.codexQuotaCacheSeconds = quotaCacheSeconds;
  }

  const kimiThreshold = configuredNumber(merged.kimiHandoffUsedPercent);
  if (!Number.isInteger(kimiThreshold) || kimiThreshold < 0 || kimiThreshold > 100) {
    warnings.push(`kimiHandoffUsedPercent "${merged.kimiHandoffUsedPercent}" is not an integer 0-100; using ${DEFAULT_CONFIG.kimiHandoffUsedPercent}.`);
    merged.kimiHandoffUsedPercent = DEFAULT_CONFIG.kimiHandoffUsedPercent;
  } else {
    merged.kimiHandoffUsedPercent = kimiThreshold;
  }

  const kimiQuotaCache = configuredNumber(merged.kimiQuotaCacheSeconds);
  if (!Number.isInteger(kimiQuotaCache) || kimiQuotaCache < 0 || kimiQuotaCache > 3600) {
    warnings.push(`kimiQuotaCacheSeconds "${merged.kimiQuotaCacheSeconds}" is not an integer 0-3600; using ${DEFAULT_CONFIG.kimiQuotaCacheSeconds}.`);
    merged.kimiQuotaCacheSeconds = DEFAULT_CONFIG.kimiQuotaCacheSeconds;
  } else {
    merged.kimiQuotaCacheSeconds = kimiQuotaCache;
  }

  if (merged.deepseekRole !== 'overflow' && merged.deepseekRole !== 'peer') {
    warnings.push(`deepseekRole "${merged.deepseekRole}" is not "overflow" or "peer"; using "${DEFAULT_CONFIG.deepseekRole}".`);
    merged.deepseekRole = DEFAULT_CONFIG.deepseekRole;
  }

  // 0 is meaningful here (unlimited daily spend), so an empty/blank value must NOT coerce
  // to it — only an actual finite number >= 0 is accepted.
  const deepseekCap = configuredNumber(merged.deepseekDailySpendCapUsd);
  if (!Number.isFinite(deepseekCap) || deepseekCap < 0 || deepseekCap > 100000) {
    warnings.push(`deepseekDailySpendCapUsd "${merged.deepseekDailySpendCapUsd}" is not a number 0-100000 (0 = unlimited); using ${DEFAULT_CONFIG.deepseekDailySpendCapUsd}.`);
    merged.deepseekDailySpendCapUsd = DEFAULT_CONFIG.deepseekDailySpendCapUsd;
  } else {
    merged.deepseekDailySpendCapUsd = deepseekCap;
  }

  const deepseekThreshold = configuredNumber(merged.deepseekHandoffUsedPercent);
  if (!Number.isInteger(deepseekThreshold) || deepseekThreshold < 0 || deepseekThreshold > 100) {
    warnings.push(`deepseekHandoffUsedPercent "${merged.deepseekHandoffUsedPercent}" is not an integer 0-100; using ${DEFAULT_CONFIG.deepseekHandoffUsedPercent}.`);
    merged.deepseekHandoffUsedPercent = DEFAULT_CONFIG.deepseekHandoffUsedPercent;
  } else {
    merged.deepseekHandoffUsedPercent = deepseekThreshold;
  }

  const deepseekQuotaCache = configuredNumber(merged.deepseekQuotaCacheSeconds);
  if (!Number.isInteger(deepseekQuotaCache) || deepseekQuotaCache < 0 || deepseekQuotaCache > 3600) {
    warnings.push(`deepseekQuotaCacheSeconds "${merged.deepseekQuotaCacheSeconds}" is not an integer 0-3600; using ${DEFAULT_CONFIG.deepseekQuotaCacheSeconds}.`);
    merged.deepseekQuotaCacheSeconds = DEFAULT_CONFIG.deepseekQuotaCacheSeconds;
  } else {
    merged.deepseekQuotaCacheSeconds = deepseekQuotaCache;
  }

  const availabilityCache = configuredNumber(merged.coderAvailabilityCacheSeconds);
  if (!Number.isInteger(availabilityCache) || availabilityCache < 0 || availabilityCache > 86400) {
    warnings.push(`coderAvailabilityCacheSeconds "${merged.coderAvailabilityCacheSeconds}" is not an integer 0-86400; using ${DEFAULT_CONFIG.coderAvailabilityCacheSeconds}.`);
    merged.coderAvailabilityCacheSeconds = DEFAULT_CONFIG.coderAvailabilityCacheSeconds;
  } else {
    merged.coderAvailabilityCacheSeconds = availabilityCache;
  }

  // Blank (null / empty string) counts as unset and silently takes the default; any other
  // non-integer or out-of-range value warns and defaults.
  const tieBand = configuredNumber(merged.coderHeadroomTieBand);
  if (merged.coderHeadroomTieBand === null ||
      (typeof merged.coderHeadroomTieBand === 'string' && merged.coderHeadroomTieBand.trim() === '')) {
    merged.coderHeadroomTieBand = DEFAULT_CONFIG.coderHeadroomTieBand;
  } else if (!Number.isInteger(tieBand) || tieBand < 0 || tieBand > 100) {
    warnings.push(`coderHeadroomTieBand "${merged.coderHeadroomTieBand}" is not an integer 0-100; using ${DEFAULT_CONFIG.coderHeadroomTieBand}.`);
    merged.coderHeadroomTieBand = DEFAULT_CONFIG.coderHeadroomTieBand;
  } else {
    merged.coderHeadroomTieBand = tieBand;
  }

  const unknownAssumed = configuredNumber(merged.unknownHeadroomAssumed);
  if (merged.unknownHeadroomAssumed === null ||
      (typeof merged.unknownHeadroomAssumed === 'string' && merged.unknownHeadroomAssumed.trim() === '')) {
    merged.unknownHeadroomAssumed = DEFAULT_CONFIG.unknownHeadroomAssumed;
  } else if (!Number.isInteger(unknownAssumed) || unknownAssumed < 0 || unknownAssumed > 100) {
    warnings.push(`unknownHeadroomAssumed "${merged.unknownHeadroomAssumed}" is not an integer 0-100; using ${DEFAULT_CONFIG.unknownHeadroomAssumed}.`);
    merged.unknownHeadroomAssumed = DEFAULT_CONFIG.unknownHeadroomAssumed;
  } else {
    merged.unknownHeadroomAssumed = unknownAssumed;
  }

  if (!isPlainObject(merged.heartbeat)) {
    warnings.push('heartbeat must be an object; using the default.');
    merged.heartbeat = deepMerge({}, DEFAULT_CONFIG.heartbeat);
  }
  const stallSeconds = configuredNumber(merged.heartbeat.stallSeconds);
  if (!Number.isInteger(stallSeconds) || stallSeconds < 1 || stallSeconds > 86400) {
    warnings.push(`heartbeat.stallSeconds "${merged.heartbeat.stallSeconds}" is not an integer 1-86400; using ${DEFAULT_CONFIG.heartbeat.stallSeconds}.`);
    merged.heartbeat.stallSeconds = DEFAULT_CONFIG.heartbeat.stallSeconds;
  } else {
    merged.heartbeat.stallSeconds = stallSeconds;
  }
  if (!isPlainObject(merged.heartbeat.stallSecondsByAgent)) {
    warnings.push('heartbeat.stallSecondsByAgent must be an object; using the default.');
    merged.heartbeat.stallSecondsByAgent = { ...DEFAULT_CONFIG.heartbeat.stallSecondsByAgent };
  } else {
    for (const [agent, value] of Object.entries(merged.heartbeat.stallSecondsByAgent)) {
      const seconds = configuredNumber(value);
      if (!agent || !Number.isInteger(seconds) || seconds < 1 || seconds > 86400) {
        warnings.push(`heartbeat.stallSecondsByAgent.${agent || '<empty>'} "${value}" is not an integer 1-86400; ignoring it.`);
        if (Object.hasOwn(DEFAULT_CONFIG.heartbeat.stallSecondsByAgent, agent)) {
          merged.heartbeat.stallSecondsByAgent[agent] = DEFAULT_CONFIG.heartbeat.stallSecondsByAgent[agent];
        } else {
          delete merged.heartbeat.stallSecondsByAgent[agent];
        }
      } else {
        merged.heartbeat.stallSecondsByAgent[agent] = seconds;
      }
    }
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

  const maxParallel = configuredNumber(merged.maxParallelCodexWorkers);
  if (!Number.isInteger(maxParallel) || maxParallel < 0 || maxParallel > 32) {
    warnings.push(`maxParallelCodexWorkers "${merged.maxParallelCodexWorkers}" is not an integer 0-32; using ${DEFAULT_CONFIG.maxParallelCodexWorkers}.`);
    merged.maxParallelCodexWorkers = DEFAULT_CONFIG.maxParallelCodexWorkers;
  } else {
    merged.maxParallelCodexWorkers = maxParallel;
  }

  const maxKimiParallel = configuredNumber(merged.maxParallelKimiWorkers);
  if (!Number.isInteger(maxKimiParallel) || maxKimiParallel < 0 || maxKimiParallel > 32) {
    warnings.push(`maxParallelKimiWorkers "${merged.maxParallelKimiWorkers}" is not an integer 0-32; using ${DEFAULT_CONFIG.maxParallelKimiWorkers}.`);
    merged.maxParallelKimiWorkers = DEFAULT_CONFIG.maxParallelKimiWorkers;
  } else {
    merged.maxParallelKimiWorkers = maxKimiParallel;
  }

  const maxDeepseekParallel = configuredNumber(merged.maxParallelDeepseekWorkers);
  if (!Number.isInteger(maxDeepseekParallel) || maxDeepseekParallel < 0 || maxDeepseekParallel > 32) {
    warnings.push(`maxParallelDeepseekWorkers "${merged.maxParallelDeepseekWorkers}" is not an integer 0-32; using ${DEFAULT_CONFIG.maxParallelDeepseekWorkers}.`);
    merged.maxParallelDeepseekWorkers = DEFAULT_CONFIG.maxParallelDeepseekWorkers;
  } else {
    merged.maxParallelDeepseekWorkers = maxDeepseekParallel;
  }

  const claimTtl = Number(merged.ownershipClaimTtlMinutes);
  if (!Number.isInteger(claimTtl) || claimTtl < 1 || claimTtl > 10080) {
    warnings.push(`ownershipClaimTtlMinutes "${merged.ownershipClaimTtlMinutes}" is not an integer 1-10080; using ${DEFAULT_CONFIG.ownershipClaimTtlMinutes}.`);
    merged.ownershipClaimTtlMinutes = DEFAULT_CONFIG.ownershipClaimTtlMinutes;
  } else {
    merged.ownershipClaimTtlMinutes = claimTtl;
  }

  if (!Array.isArray(merged.agents.escalation)) merged.agents.escalation = DEFAULT_CONFIG.agents.escalation;
  if (!Array.isArray(merged.agents.lookup)) merged.agents.lookup = DEFAULT_CONFIG.agents.lookup;

  const closeDoneMode = normalizeCloseDoneWorktrees(merged.closeDoneWorktrees);
  if (!closeDoneMode) {
    warnings.push(`closeDoneWorktrees "${merged.closeDoneWorktrees}" is not remove|remind|off (or a legacy boolean); using "${DEFAULT_CONFIG.closeDoneWorktrees}".`);
    merged.closeDoneWorktrees = DEFAULT_CONFIG.closeDoneWorktrees;
  } else {
    merged.closeDoneWorktrees = closeDoneMode;
  }

  // M2: only an actual JSON number is accepted here — `Number("")`/`Number(" ")` coerce to
  // 0, which would otherwise let a stray `"parallelCoreFraction": ""` in the config file
  // silently fail the range check below in a confusing way, or (for maxParallelAgents,
  // where 0 is a valid, meaningful value) silently turn the cap unlimited instead of
  // warning and defaulting. A non-number is never coerced; it is simply invalid.
  const coreFractionRaw = merged.parallelCoreFraction;
  const coreFraction = typeof coreFractionRaw === 'number' ? coreFractionRaw : NaN;
  if (!Number.isFinite(coreFraction) || coreFraction < 0.1 || coreFraction > 1) {
    warnings.push(`parallelCoreFraction "${coreFractionRaw}" is not a number 0.1-1; using ${DEFAULT_CONFIG.parallelCoreFraction}.`);
    merged.parallelCoreFraction = DEFAULT_CONFIG.parallelCoreFraction;
  } else {
    merged.parallelCoreFraction = coreFraction;
  }

  // null (derive from cores) is a valid, and the default, value here — unlike every other
  // integer field above, so it is checked before the numeric-range check runs at all.
  if (merged.maxParallelAgents !== null) {
    const maxAgentsRaw = merged.maxParallelAgents;
    const maxAgents = typeof maxAgentsRaw === 'number' ? maxAgentsRaw : NaN;
    if (!Number.isInteger(maxAgents) || maxAgents < 0 || maxAgents > 256) {
      warnings.push(`maxParallelAgents "${maxAgentsRaw}" is not null or an integer 0-256; using null (derive from cores).`);
      merged.maxParallelAgents = null;
    } else {
      merged.maxParallelAgents = maxAgents;
    }
  }

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
  if (envOverride !== undefined && envOverride.trim() !== '') {
    const n = Number(envOverride);
    if (Number.isInteger(n) && n >= 0 && n <= 100) return n;
  }
  return cfg.codexHandoffUsedPercent;
}

/**
 * Seconds a successful live Codex quota reading or failed probe remains fresh
 * (0 disables reuse).
 * `ORCH_CODEX_QUOTA_CACHE_SECONDS` overrides the config for one process.
 */
function codexQuotaCacheSeconds(cfg) {
  const envOverride = process.env.ORCH_CODEX_QUOTA_CACHE_SECONDS;
  if (envOverride !== undefined && envOverride.trim() !== '') {
    const n = Number(envOverride);
    if (Number.isInteger(n) && n >= 0 && n <= 3600) return n;
  }
  return cfg.codexQuotaCacheSeconds;
}

/**
 * Kimi's own handoff threshold — separate from the Codex one (binding operator decision,
 * 2026-09-30): Sonnet takes over once Kimi has used this much (or more) of its tightest
 * quota window. `ORCH_KIMI_HANDOFF_USED` overrides the config value for one process; an
 * invalid override falls back to the config value, exactly like `handoffUsed`.
 */
function kimiHandoffUsed(cfg) {
  const envOverride = process.env.ORCH_KIMI_HANDOFF_USED;
  if (envOverride !== undefined && envOverride.trim() !== '') {
    const n = Number(envOverride);
    if (Number.isInteger(n) && n >= 0 && n <= 100) return n;
  }
  return cfg.kimiHandoffUsedPercent;
}

/**
 * Seconds a live Kimi quota reading or failed probe remains fresh (0 disables reuse).
 * `ORCH_KIMI_QUOTA_CACHE_SECONDS` overrides the config for one process; an empty-string
 * override counts as unset (falls back to config), same as the Codex TTL override.
 */
function kimiQuotaCacheSeconds(cfg) {
  const envOverride = process.env.ORCH_KIMI_QUOTA_CACHE_SECONDS;
  if (envOverride !== undefined && envOverride.trim() !== '') {
    const n = Number(envOverride);
    if (Number.isInteger(n) && n >= 0 && n <= 3600) return n;
  }
  return cfg.kimiQuotaCacheSeconds;
}

/**
 * Seconds a per-machine coder availability probe (binary present? signed in?) remains
 * fresh before it is re-probed. `ORCH_CODER_AVAILABILITY_CACHE_SECONDS` overrides the
 * config for one process; an empty-string override counts as unset.
 */
function coderAvailabilityCacheSeconds(cfg) {
  const envOverride = process.env.ORCH_CODER_AVAILABILITY_CACHE_SECONDS;
  if (envOverride !== undefined && envOverride.trim() !== '') {
    const n = Number(envOverride);
    if (Number.isInteger(n) && n >= 0 && n <= 86400) return n;
  }
  return cfg.coderAvailabilityCacheSeconds;
}

/** Global stall threshold. A blank ORCH_STALL_SECONDS override is intentionally unset. */
function stallSeconds(cfg) {
  const envOverride = process.env.ORCH_STALL_SECONDS;
  if (envOverride !== undefined && envOverride.trim() !== '') {
    const n = Number(envOverride);
    if (Number.isInteger(n) && n >= 1 && n <= 86400) return n;
  }
  return cfg.heartbeat.stallSeconds;
}

/** Whether exhausted work is parked for a detached reset scheduler. */
function autoResumeAfterReset(cfg) {
  const envOverride = process.env.ORCH_AUTO_RESUME;
  if (envOverride !== undefined && envOverride.trim() !== '') {
    if (/^(?:1|true|yes|on)$/i.test(envOverride)) return true;
    if (/^(?:0|false|no|off)$/i.test(envOverride)) return false;
  }
  return cfg.autoResumeAfterReset;
}

/** Directory holding session state (`<sid>.json`, heartbeat files, violations.log). */
function stateDir() {
  return process.env.ORCH_STATE_DIR || path.join(os.homedir(), '.claude', 'orchestrator-gate');
}

/**
 * How many live Codex worker groups this session may hold at once (0 = unlimited).
 * `ORCH_MAX_PARALLEL_CODEX_WORKERS` overrides the config value for one process (tests, or
 * an operator who wants a one-off cap without editing the config file); an invalid override
 * falls back to the config value, exactly like `handoffUsed`.
 */
function maxParallelCodexWorkers(cfg) {
  const envOverride = process.env.ORCH_MAX_PARALLEL_CODEX_WORKERS;
  if (envOverride !== undefined && envOverride.trim() !== '') {
    const n = Number(envOverride);
    if (Number.isInteger(n) && n >= 0 && n <= 32) return n;
  }
  return cfg.maxParallelCodexWorkers;
}

/**
 * How many live Kimi worker groups this session may hold at once (0 = unlimited).
 * `ORCH_MAX_PARALLEL_KIMI_WORKERS` overrides the config value for one process; an invalid
 * override falls back to the config value, exactly like `maxParallelCodexWorkers`.
 */
function maxParallelKimiWorkers(cfg) {
  const envOverride = process.env.ORCH_MAX_PARALLEL_KIMI_WORKERS;
  if (envOverride !== undefined && envOverride.trim() !== '') {
    const n = Number(envOverride);
    if (Number.isInteger(n) && n >= 0 && n <= 32) return n;
  }
  return cfg.maxParallelKimiWorkers;
}

/**
 * DeepSeek's routing role (binding operator decision, 2026-10-01): 'overflow' (the default)
 * picks it only when no subscription coder (Codex/Kimi) is eligible, but before the
 * in-session code model; 'peer' ranks it by the same headroom/tie-band/live-count/lastCoder
 * rules as Codex and Kimi. `ORCH_DEEPSEEK_ROLE` overrides the config for one process.
 */
function deepseekRole(cfg) {
  const envOverride = process.env.ORCH_DEEPSEEK_ROLE;
  if (envOverride === 'overflow' || envOverride === 'peer') return envOverride;
  return cfg.deepseekRole;
}

/**
 * DeepSeek's daily spend cap in USD; 0 = unlimited (stop only on balance exhausted / 402).
 * `ORCH_DEEPSEEK_DAILY_CAP_USD` overrides the config for one process; an invalid override
 * falls back to the config value, exactly like `handoffUsed`.
 */
function deepseekDailySpendCapUsd(cfg) {
  const envOverride = process.env.ORCH_DEEPSEEK_DAILY_CAP_USD;
  if (envOverride !== undefined && envOverride.trim() !== '') {
    const n = Number(envOverride);
    if (Number.isFinite(n) && n >= 0 && n <= 100000) return n;
  }
  return cfg.deepseekDailySpendCapUsd;
}

/**
 * DeepSeek's handoff threshold against its own headroom (spend cap used percent, or 100 on
 * an exhausted balance). `ORCH_DEEPSEEK_HANDOFF_USED` overrides the config for one process,
 * exactly like `kimiHandoffUsed`.
 */
function deepseekHandoffUsed(cfg) {
  const envOverride = process.env.ORCH_DEEPSEEK_HANDOFF_USED;
  if (envOverride !== undefined && envOverride.trim() !== '') {
    const n = Number(envOverride);
    if (Number.isInteger(n) && n >= 0 && n <= 100) return n;
  }
  return cfg.deepseekHandoffUsedPercent;
}

/**
 * Seconds a live DeepSeek spend/balance reading or failed probe remains fresh (0 disables
 * reuse). `ORCH_DEEPSEEK_QUOTA_CACHE_SECONDS` overrides the config for one process.
 */
function deepseekQuotaCacheSeconds(cfg) {
  const envOverride = process.env.ORCH_DEEPSEEK_QUOTA_CACHE_SECONDS;
  if (envOverride !== undefined && envOverride.trim() !== '') {
    const n = Number(envOverride);
    if (Number.isInteger(n) && n >= 0 && n <= 3600) return n;
  }
  return cfg.deepseekQuotaCacheSeconds;
}

/**
 * How many live DeepSeek (opencode) worker groups this session may hold at once
 * (0 = unlimited). `ORCH_MAX_PARALLEL_DEEPSEEK_WORKERS` overrides the config value for one
 * process, exactly like `maxParallelKimiWorkers`.
 */
function maxParallelDeepseekWorkers(cfg) {
  const envOverride = process.env.ORCH_MAX_PARALLEL_DEEPSEEK_WORKERS;
  if (envOverride !== undefined && envOverride.trim() !== '') {
    const n = Number(envOverride);
    if (Number.isInteger(n) && n >= 0 && n <= 32) return n;
  }
  return cfg.maxParallelDeepseekWorkers;
}

/**
 * The review model alias mapped to the author of the code under review (operator decision,
 * 2026-10-01): external coders (codex/kimi/deepseek) default to the code model alias,
 * in-session code (sonnet) to the review model alias — a model never reviews its own
 * output. `ORCH_REVIEW_MODEL_EXTERNAL` / `ORCH_REVIEW_MODEL_SONNET` override the mapped
 * aliases for one process. `author` may be a worker agent ('opencode' counts as deepseek).
 * Returns null for an unknown author (fail open toward review happening).
 */
function reviewModelForCoder(cfg, author) {
  const normalized = author === 'opencode' ? 'deepseek' : author;
  const known = Object.prototype.hasOwnProperty.call(cfg.models.reviewByCoder, normalized);
  if (!known) return null;
  const envOverride = normalized === 'sonnet'
    ? process.env.ORCH_REVIEW_MODEL_SONNET
    : process.env.ORCH_REVIEW_MODEL_EXTERNAL;
  if (envOverride !== undefined && envOverride.trim() !== '') return envOverride.trim();
  return cfg.models.reviewByCoder[normalized];
}

/**
 * The model alias verify-run work (running existing checks — CI, screenshots, play-test,
 * post-deploy smoke) runs on. `ORCH_VERIFY_MODEL` overrides the configured alias for one
 * process (tests, or a one-off operator preference); an empty/blank override counts as
 * unset and defers to `models.verify.alias`.
 */
function verifyModelAlias(cfg) {
  const envOverride = process.env.ORCH_VERIFY_MODEL;
  if (envOverride !== undefined && envOverride.trim() !== '') return envOverride.trim();
  return cfg.models.verify.alias;
}

/**
 * Minutes a background in-session Agent's `Owns:` claim survives without an explicit
 * release before it auto-expires. `ORCH_CLAIM_TTL_MINUTES` overrides for one process.
 */
function ownershipClaimTtlMinutes(cfg) {
  const envOverride = process.env.ORCH_CLAIM_TTL_MINUTES;
  if (envOverride !== undefined) {
    const n = Number(envOverride);
    if (Number.isInteger(n) && n >= 1 && n <= 10080) return n;
  }
  return cfg.ownershipClaimTtlMinutes;
}

/**
 * What the heartbeat does about done-but-open Orca worktrees (a linked PR/MR already
 * merged/closed, idle, clean, no live terminal): 'remove' runs `orca worktree rm` itself,
 * 'remind' wakes the panel with the exact rm command and never runs it, 'off' does
 * nothing. `ORCH_CLOSE_DONE_WORKTREES` overrides the mode for one process; it only ever
 * forces an explicit answer: remove|remind|off (case-insensitively), or the legacy
 * `1`/`true` (enable = remind) and `0`/`false` (disable = off). Any other value —
 * including an empty string, or the variable being unset entirely — defers to the config
 * rather than silently forcing a mode on.
 */
function closeDoneWorktreesMode(cfg) {
  const envOverride = process.env.ORCH_CLOSE_DONE_WORKTREES;
  if (envOverride !== undefined) {
    const mode = normalizeCloseDoneWorktrees(envOverride);
    if (mode) return mode;
  }
  return normalizeCloseDoneWorktrees(cfg.closeDoneWorktrees) || DEFAULT_CONFIG.closeDoneWorktrees;
}

/** Backward-compatible boolean view: anything but 'off' is enabled. */
function closeDoneWorktreesEnabled(cfg) {
  return closeDoneWorktreesMode(cfg) !== 'off';
}

/**
 * The fraction of this machine's cores the parallel-agents budget derives its limit from
 * (0.1-1). `ORCH_PARALLEL_CORE_FRACTION` overrides the config value for one process; an
 * invalid override falls back to the config value, exactly like `handoffUsed`. M2: an
 * empty-or-whitespace-only override is treated as unset (falls back to config), not as `0`
 * — `Number("")`/`Number(" ")` both coerce to `0`, which would otherwise silently accept an
 * accidentally-empty env var as a real (and, for this field, always out-of-range) value.
 */
function parallelCoreFraction(cfg) {
  const envOverride = process.env.ORCH_PARALLEL_CORE_FRACTION;
  if (envOverride !== undefined && envOverride.trim() !== '') {
    const n = Number(envOverride);
    if (Number.isFinite(n) && n >= 0.1 && n <= 1) return n;
  }
  return cfg.parallelCoreFraction;
}

/**
 * The explicit machine-wide parallel-agents cap, or null to derive it from
 * `parallelCoreFraction x cores` (0 = unlimited). `ORCH_MAX_PARALLEL_AGENTS` overrides the
 * config value for one process; an invalid override falls back to the config value. M2: an
 * empty-or-whitespace-only override is treated as unset, not as `0` — since `0` here means
 * a real, meaningful "unlimited", `Number("")` coercing to `0` would otherwise let a stray
 * empty env var silently disable the entire cap.
 */
function maxParallelAgents(cfg) {
  const envOverride = process.env.ORCH_MAX_PARALLEL_AGENTS;
  if (envOverride !== undefined && envOverride.trim() !== '') {
    const n = Number(envOverride);
    if (Number.isInteger(n) && n >= 0 && n <= 256) return n;
  }
  return cfg.maxParallelAgents;
}

module.exports = {
  GATE_NAMES, DEFAULT_CONFIG, loadConfig, gateDisabled, handoffUsed, configPath, stateDir,
  codexQuotaCacheSeconds, maxParallelCodexWorkers, ownershipClaimTtlMinutes, closeDoneWorktreesEnabled,
  closeDoneWorktreesMode,
  parallelCoreFraction, maxParallelAgents,
  kimiHandoffUsed, kimiQuotaCacheSeconds, coderAvailabilityCacheSeconds, maxParallelKimiWorkers,
  deepseekRole, deepseekDailySpendCapUsd, deepseekHandoffUsed, deepseekQuotaCacheSeconds,
  maxParallelDeepseekWorkers, reviewModelForCoder, verifyModelAlias,
  stallSeconds, autoResumeAfterReset,
};
