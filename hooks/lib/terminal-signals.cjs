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
    const errorShaped = /(?:^\s*(?:■|⚠|error:)|\bERROR\b)/i.test(line);
    if ((errorShaped && RATE_LIMIT_MARKER.test(line)) || STRONG_RATE_LIMIT_MARKER.test(line)) return true;
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

module.exports = { hasRateLimitError, hasCodexDisconnect };
