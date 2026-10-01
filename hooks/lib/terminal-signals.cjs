'use strict';

const { normalizeTerminalLine } = require('./worker-progress-fingerprint.cjs');

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

const KIMI_USAGE_LIMIT_SENTENCE = /^you(?:'|’)?ve\s+reached\s+your\s+(?:usage\s+limit\s+for\s+this\s+billing\s+cycle|\d+-hour\s+usage\s+limit)/i;
const KIMI_IGNORED_LINE_PREFIX = /^\s*(?:["'`>]|\/\/|#|[-*](?:\s|$))/;
const KIMI_ERROR_PREFIX = /^\s*\+?\s*(?:[■⚠✗]\s*|error\b[:\s]+|(?:HTTP\s*)?403\b[:\s]+)(?:(?:ERROR\b|(?:HTTP\s*)?403\b)[:\s-]*)*/i;

/** The window length in hours when the sentence is the "N-hour usage limit" form, else null. */
function kimiUsageLimitHours(text) {
  const match = String(text || '').match(/reached\s+your\s+(\d+)-hour\s+usage\s+limit/i);
  return match ? Number(match[1]) : null;
}

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

/** Codex's terminal usage-limit screen is a handover signal, unlike a transient generic
 * 429. Keep the matcher error-shaped so prose and source excerpts remain inert. */
function hasCodexUsageExhausted(text) {
  let inFence = false;
  for (const raw of terminalLines(text)) {
    const line = raw.trimEnd();
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence || isSourceExcerpt(line)) continue;
    if (/^\s*(?:■|⚠|error:)?\s*you(?:'|’)?ve\s+hit\s+your\s+usage\s+limit\b/i.test(line)) return true;
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
  const normalized = lines.map((raw) => ({ raw, text: normalizeTerminalLine(raw).text })).filter((line) => line.text);
  const texts = normalized.map((line) => line.text);
  const navigationPattern = /^[↑↓]+\s*navigate\s*[·•|]\s*Enter\s+select(?:\s*[·•|]\s*Esc\s+cancel)?\s*$/i;
  const confirmPattern = /^Press\s+enter\s+to\s+confirm\s+or\s+esc\s+to\s+cancel\.?$/i;
  // Claude Code's trust dialog ("Quick safety check … Do you trust the files in this
  // folder?", "⚠ This folder pre-approves N tool permissions … Only proceed if you trust
  // this configuration") uses a different hint line than the permission prompts.
  const trustPattern = /trust\s+this\s+folder|trust\s+the\s+files\s+in\s+this\s+folder|only\s+proceed\s+if\s+you\s+trust\s+this\s+configuration/i;
  const enterConfirmPattern = /^Enter\s+to\s+confirm\s*[·•|]\s*Esc\s+to\s+cancel\.?$/i;
  const permissionPattern = /^Select\s+permission\s+mode\s*$/i;
  const codexQuestionPattern = /^Would\s+you\s+like\s+to\s+(?:run|make|apply)\b.*\?$/i;
  const approvalQuestionPattern = /^(?:Do\s+you\s+want\s+to\s+(?:allow|approve|run)\b.*|(?:Allow|Approve)\b.*)\?$/i;
  const codexOptionPattern = /^\d+[.)]\s*(?:Yes,\s*proceed|No,\s*and\s+tell)\b.*$/i;
  const commandPattern = /^\$\s+\S.+$/;
  const hasNavigation = texts.some((line) => navigationPattern.test(line));
  const hasConfirmHint = texts.some((line) => confirmPattern.test(line));
  const hasTrustDialog = texts.some((line) => trustPattern.test(line));
  const hasEnterConfirm = texts.some((line) => enterConfirmPattern.test(line));
  const hasPermissionMenu = texts.some((line) => permissionPattern.test(line));
  const hasCodexQuestion = texts.some((line) => codexQuestionPattern.test(line));
  const hasApprovalQuestion = texts.some((line) => approvalQuestionPattern.test(line));
  const numberedOptions = texts.filter((line) => codexOptionPattern.test(line));
  const optionNames = new Set(texts.map((line) => line
    .replace(/^\d+[.)]\s*/, '')
    .trim()
    .toLowerCase())
    .filter((line) => /^(?:allow|deny|approve|never ask|ask when needed)$/.test(line)));
  const hasOpposingOptions = optionNames.has('allow') && optionNames.has('deny');
  const hasBox = lines.some((line) => /[┌┐└┘├┤┬┴┼─━│┃╭╮╯╰═║╔╗╚╝]/u.test(line));
  const questionIndex = texts.findIndex((line) => codexQuestionPattern.test(line));
  const promptCommand = questionIndex >= 0
    ? texts.slice(questionIndex + 1).find((line) => commandPattern.test(line))
    : null;
  const structured = hasNavigation || hasConfirmHint || hasEnterConfirm || numberedOptions.length > 0 ||
    hasOpposingOptions || (hasBox && (hasPermissionMenu || hasCodexQuestion || hasApprovalQuestion)) ||
    (hasTrustDialog && (hasEnterConfirm || hasBox));
  const prompt = hasPermissionMenu || hasCodexQuestion || hasApprovalQuestion ||
    hasOpposingOptions || numberedOptions.length > 0 || hasNavigation || hasTrustDialog || hasEnterConfirm;

  if (!structured || !prompt) return null;

  // Keep only normalized prompt-block lines. This ignores surrounding repaint noise while
  // retaining the question and its `$ command`, so a distinct consecutive prompt re-arms.
  const signature = texts
    .filter((line) => permissionPattern.test(line) || codexQuestionPattern.test(line) ||
      approvalQuestionPattern.test(line) || codexOptionPattern.test(line) ||
      navigationPattern.test(line) || confirmPattern.test(line) ||
      trustPattern.test(line) || enterConfirmPattern.test(line) ||
      line === promptCommand ||
      /^(?:\d+[.)]\s*)?(?:allow|deny|approve|never ask|ask when needed)$/i.test(line))
    .map((line) => line.toLowerCase())
    .join('\n')
    .toLowerCase();
  return signature || 'selection-prompt';
}

// A shell waiting for input: the last visible line ENDS in a prompt character. `%`, `$`
// and `#` count bare; `❯`/`›` need a prompt-prefix before them so Claude's bare input
// caret ("❯ ") and Codex's composer prompt can never look like a shell.
const SHELL_PROMPT_END = /[%$#]\s*$|^\S.{2,}\s[❯›]\s*$/;
const AGENT_TUI_HINT = /esc\s+to\s+interrupt|bypass\s+permissions|accept\s+edits|shift\s*\+\s*tab\s+to\s+cycle|⏵⏵/i;

/**
 * True when the screen's last meaningful line is a shell prompt and no agent TUI chrome
 * shows nearby — the shape of a worker whose agent process exited back to the shell
 * (e.g. Claude Code's trust dialog defaulting to "No, exit" in an untrusted worktree).
 */
function endsAtShellPrompt(text) {
  const lines = terminalLines(text).map((line) => line.trimEnd()).filter((line) => line.trim());
  if (!lines.length) return false;
  const last = lines[lines.length - 1].trim();
  if (!last || last.length > 160 || !SHELL_PROMPT_END.test(last)) return false;
  if (/[┌┐└┘├┤┬┴┼─━│┃╭╮╯╰═║╔╗╚╝]/u.test(last)) return false;
  const tail = lines.slice(-12).join('\n');
  if (AGENT_TUI_HINT.test(tail)) return false;
  return true;
}

module.exports = {
  hasRateLimitError, hasCodexDisconnect, hasKimiUsageExhausted, kimiUsageLimitHours, hasCodexUsageExhausted,
  approvalPromptFingerprint, endsAtShellPrompt,
};
