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

/** Strips a leading/trailing matching quote (single or double) from a bare TOML key/section
 * segment, e.g. `"x"` or `'x'` -> `x`; a segment with no surrounding quotes is returned as
 * given. Used to normalize quoted section names and dotted-key segments onto the same plain
 * identifier space the rest of this module compares against. */
function unquote(segment) {
  const m = segment.match(/^(["'])(.*)\1$/);
  return m ? m[2] : segment;
}

/** Walks a TOML file's lines, tracking the current `[section]` (empty string = top-level;
 * a quoted section name or dotted segment is unquoted and normalized to `a.b.c`), and calls
 * `onLine({ section, lineNumber, raw, line })` for every non-blank, non-header line (`line`
 * has trailing comments stripped and is trimmed; `raw` is the original line with only
 * surrounding whitespace trimmed, for the reported snippet). */
function walkToml(lines, onLine) {
  let section = '';
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().split('.').map((part) => unquote(part.trim())).join('.');
      continue;
    }
    onLine({ section, lineNumber: i + 1, raw: raw.trim(), line });
  }
}

/** Matches a `key = "value"` / `key = 'value'` assignment and returns `[key, value]`, or
 * null. `key` may be dotted (`profiles.x.service_tier`) and each dotted segment may be
 * quoted; both are normalized the same way `walkToml`'s section tracking is. */
function matchAssignment(line) {
  const m = line.match(/^((?:[^.=\s"']+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[^.=\s"']+|"[^"]*"|'[^']*'))*)\s*=\s*(["'])([^"']*)\2\s*$/);
  if (!m) return null;
  const key = m[1].split('.').map((part) => unquote(part.trim())).join('.');
  return [key, m[3]];
}

/**
 * Returns `{ file, lineNumber, line, tier }` for the `service_tier` setting that actually
 * takes effect — a bare top-level key (including the dotted-key form
 * `profiles.<name>.service_tier = "..."`), or one inside the `[profiles.<name>]` section —
 * for the profile a top-level `profile = "<name>"` key names as the default (Codex's own
 * default-profile convention) — when it is `"priority"` or `"fast"`. A `service_tier` set
 * on the active default profile always overrides a top-level one, matching Codex's own
 * profile-override precedence, so a flagged top-level value is never reported when the
 * selected default profile sets its own (even non-flagged) tier. Returns null when the file
 * is absent/unreadable, has no such setting, or the effective setting does not apply (e.g.
 * a non-default profile's own tier). Never throws.
 */
function detectCodexPriorityTier(env = process.env) {
  const file = codexConfigPath(env);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = text.split(/\r?\n/);

  let defaultProfile = null;
  walkToml(lines, ({ section, line }) => {
    if (defaultProfile !== null || section !== '') return;
    const m = matchAssignment(line);
    if (m && m[0] === 'profile') defaultProfile = m[1];
  });

  let topLevel = null;
  let defaultProfileTier = null;
  walkToml(lines, ({ section, lineNumber, raw, line }) => {
    const m = matchAssignment(line);
    if (!m) return;
    const [key, value] = m;
    const inDefaultProfileSection = defaultProfile !== null && section === `profiles.${defaultProfile}`;
    const dottedDefaultProfile = defaultProfile !== null &&
      key === `profiles.${defaultProfile}.service_tier` && section === '';
    if ((inDefaultProfileSection && key === 'service_tier') || dottedDefaultProfile) {
      if (!defaultProfileTier) defaultProfileTier = { lineNumber, raw, tier: value.toLowerCase() };
      return;
    }
    if (section === '' && key === 'service_tier' && !topLevel) {
      topLevel = { lineNumber, raw, tier: value.toLowerCase() };
    }
  });

  // The active default profile's own service_tier, if it sets one at all, overrides a
  // top-level value outright — whatever it is, flagged or not.
  const effective = defaultProfileTier || topLevel;
  if (!effective || !FLAGGED_TIERS.has(effective.tier)) return null;
  return { file, lineNumber: effective.lineNumber, line: effective.raw, tier: effective.tier };
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
