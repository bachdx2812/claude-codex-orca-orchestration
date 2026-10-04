'use strict';

/**
 * Surfaces (never edits) a Codex `service_tier = "priority"` / `"fast"` setting in the
 * operator's own `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). Operator finding,
 * 2026-10-04: that setting shows as "fast" in the Codex footer and burns Codex quota much
 * faster than the default tier; removing it cut burn visibly. The gate only ever reports
 * where to look — it never rewrites the operator's Codex config.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const FLAGGED_TIERS = new Set(['priority', 'fast']);

function codexConfigPath(env = process.env) {
  const home = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME
    ? env.CODEX_HOME
    : path.join(typeof env.HOME === 'string' && env.HOME ? env.HOME : os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

/** Walks a TOML file's lines, tracking the current `[section]` (empty string = top-level),
 * and calls `onLine({ section, lineNumber, raw, line })` for every non-blank, non-header
 * line (`line` has trailing comments stripped and is trimmed; `raw` is the original line
 * with only surrounding whitespace trimmed, for the reported snippet). */
function walkToml(lines, onLine) {
  let section = '';
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) { section = sectionMatch[1].trim(); continue; }
    onLine({ section, lineNumber: i + 1, raw: raw.trim(), line });
  }
}

/**
 * Returns `{ file, lineNumber, line, tier }` for the `service_tier` setting that actually
 * takes effect — either a bare top-level key, or one inside the `[profiles.<name>]` section
 * for the profile a top-level `profile = "<name>"` key names as the default (Codex's own
 * default-profile convention) — when it is `"priority"` or `"fast"`. Returns null when the
 * file is absent/unreadable, has no such setting, or the setting present does not apply to
 * the active configuration (e.g. a non-default profile's own tier). Never throws.
 */
function detectCodexPriorityTier(env = process.env) {
  const file = codexConfigPath(env);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = text.split(/\r?\n/);

  let defaultProfile = null;
  walkToml(lines, ({ section, line }) => {
    if (defaultProfile !== null || section !== '') return;
    const m = line.match(/^profile\s*=\s*"([^"]*)"/);
    if (m) defaultProfile = m[1];
  });

  let found = null;
  walkToml(lines, ({ section, lineNumber, raw, line }) => {
    if (found) return;
    const m = line.match(/^service_tier\s*=\s*"([^"]*)"/);
    if (!m) return;
    const tier = m[1].toLowerCase();
    if (!FLAGGED_TIERS.has(tier)) return;
    const appliesTopLevel = section === '';
    const appliesDefaultProfile = defaultProfile !== null && section === `profiles.${defaultProfile}`;
    if (appliesTopLevel || appliesDefaultProfile) found = { file, lineNumber, line: raw, tier };
  });
  return found;
}

/** Human-readable one-line warning for a detected setting, or null when none applies. */
function formatCodexPriorityTierWarning(env = process.env) {
  const found = detectCodexPriorityTier(env);
  if (!found) return null;
  return `Codex config ${found.file}:${found.lineNumber} sets service_tier = "${found.tier}" ` +
    `(shows as "fast" in the Codex footer) — this burns Codex quota faster; remove the line ` +
    `\`${found.line}\` (or set codexAllowPriorityTier: true / ORCH_CODEX_ALLOW_PRIORITY_TIER=1 to silence this).`;
}

module.exports = { codexConfigPath, detectCodexPriorityTier, formatCodexPriorityTierWarning };
