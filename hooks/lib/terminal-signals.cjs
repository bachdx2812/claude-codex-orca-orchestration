'use strict';

const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const RATE_LIMIT_MARKER = /(rate.?limit|429\b|quota\s+exceeded|usage\s+limit|too\s+many\s+requests|retry[- ]after|overloaded_error)/i;
const STRONG_RATE_LIMIT_MARKER = /(HTTP(?:\/\d(?:\.\d)?)?\s+429\b|too\s+many\s+requests|rate_limit_exceeded|you(?:'|’)?ve\s+hit\s+your\s+usage\s+limit|overloaded_error)/i;

function terminalLines(text) {
  return String(text || '').replace(ANSI_ESCAPE, '').split(/\r?\n/);
}

function isSourceExcerpt(line) {
  if (/^\s*429\s*(?:[|:│-]\s*)?Too Many Requests\b/i.test(line)) return false;
  return /^\s*(?:```|~~~|@@|diff\s+--git\b|index\s+[0-9a-f]+\.\.|[+-](?!\s*(?:ERROR\b|error:|■))|\d+\s*[|:│]|[|│┃]\s*)/i.test(line) ||
    /^\s*(?:const|let|var|function|class|if|for|while|return|check|expect|assert)\b/.test(line) ||
    /^\s*(?:\/\/|#)(?:\s|$)/.test(line) ||
    /^\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*(?:\(|=)/.test(line);
}

/** True only for a terminal line shaped like a runtime error, never standing tips or code/diff excerpts. */
function hasRateLimitError(text) {
  let inFence = false;
  for (const raw of terminalLines(text)) {
    const line = raw.trimEnd();
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence || /^\s*(?:└\s*)?Tip:/i.test(line) || isSourceExcerpt(line)) continue;
    const errorShaped = /^\s*(?:■|⚠|error:)/i.test(line) || /\bERROR\b/.test(line);
    if ((errorShaped && RATE_LIMIT_MARKER.test(line)) || STRONG_RATE_LIMIT_MARKER.test(line)) return true;
  }
  return false;
}

const KIMI_USAGE_LIMIT_SENTENCE = /^you(?:'|’)?ve\s+reached\s+your\s+usage\s+limit\s+for\s+this\s+billing\s+cycle/i;
const KIMI_IGNORED_LINE_PREFIX = /^\s*(?:["'`>]|\/\/|#|[-*](?:\s|$))/;
const KIMI_ERROR_PREFIX = /^\s*\+?\s*(?:[■⚠✗]\s*|error\b[:\s]+|(?:HTTP\s*)?403\b[:\s]+)(?:(?:ERROR\b|(?:HTTP\s*)?403\b)[:\s-]*)*/i;

/** True only when Kimi's billing-cycle usage-limit sentence appears on an error-shaped
 * line — deliberately NOT a strong marker: the sentence alone, in plain prose (a worker
 * narrating or quoting the very text it handles), must never count. Callers additionally
 * scope this to terminals/workers known to be running Kimi. */
function hasKimiUsageExhausted(text) {
  let inFence = false;
  for (const raw of terminalLines(text)) {
    const line = raw.trimEnd();
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence || /^\s*(?:└\s*)?Tip:/i.test(line) || KIMI_IGNORED_LINE_PREFIX.test(line) || isSourceExcerpt(line)) continue;
    const prefix = line.match(KIMI_ERROR_PREFIX);
    if (prefix && KIMI_USAGE_LIMIT_SENTENCE.test(line.slice(prefix[0].length))) return true;
  }
  return false;
}

function hasCodexDisconnect(text) {
  let inFence = false;
  for (const raw of terminalLines(text)) {
    const line = raw.trimEnd();
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence || isSourceExcerpt(line)) continue;
    if (/^\s*■\s*Automatic reconnect could not restore this session\./i.test(line) ||
        /^\s*(?:■|└)?\s*Reconnect failed\b/i.test(line)) return true;
  }
  return false;
}

/**
 * Return a repaint-stable signature for an interactive approval/question/selection prompt,
 * or null for ordinary output that merely discusses those words.
 */
function approvalPromptFingerprint(text) {
  let inFence = false;
  const lines = terminalLines(text).flatMap((raw) => {
    const line = raw.trim();
    if (/^(?:```|~~~)/.test(line)) { inFence = !inFence; return []; }
    return inFence || isSourceExcerpt(line) ? [] : [line];
  }).filter(Boolean);
  const hasNavigation = lines.some((line) =>
    /^[↑↓]+\s*navigate\s*[·•|]\s*Enter\s+select\s*$/i.test(line));
  const hasPermissionMenu = lines.some((line) => /^Select\s+permission\s+mode\s*$/i.test(line));
  const hasApprovalQuestion = lines.some((line) =>
    /^(?:Would\s+you\s+like\s+to\s+(?:allow|approve|run)|Do\s+you\s+want\s+to\s+(?:allow|approve|run)|(?:Allow|Approve)\b.*\?)$/i.test(line));
  const optionNames = new Set(lines.map((line) => line
    .replace(/^[❯›>•·✓✔✗✘\s]+/u, '')
    .replace(/^\d+[.)]\s*/, '')
    .trim()
    .toLowerCase())
    .filter((line) => /^(?:allow|deny|approve|never ask|ask when needed)$/.test(line)));
  const hasOpposingOptions = optionNames.has('allow') && optionNames.has('deny');

  if (!hasNavigation && !hasPermissionMenu && !hasApprovalQuestion && !hasOpposingOptions) return null;

  // Selection arrows and navigation help repaint as the operator moves through the menu.
  // Excluding them keeps one prompt episode stable while retaining question/command text so
  // a later, distinct prompt re-arms even when it uses the same Allow/Deny options.
  const signature = lines
    .filter((line) => !/^[↑↓]+\s*navigate\s*[·•|]\s*Enter\s+select\s*$/i.test(line))
    .map((line) => line.replace(/^[❯›>•·✓✔✗✘\s]+/u, '').replace(/^\d+[.)]\s*/, '').trim())
    .join('\n')
    .toLowerCase();
  return signature || 'selection-prompt';
}

module.exports = {
  hasRateLimitError, hasCodexDisconnect, hasKimiUsageExhausted, approvalPromptFingerprint,
};
