'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const LEADING_NOISE = /^\s*[•·✢✳✦✧✶✻◯❯›>⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒⏳⌛⣾⣽⣻⢿⡿⣟⣯⣷🌑🌒🌓🌔🌕🌖🌗🌘|/\\\-]+\s*/u;
const BOX_CHROME = /[┌┐└┘├┤┬┴┼─━│┃╭╮╯╰═║╔╗╚╝]/gu;
const DURATION = /\b\d+\s*[hms]\b/gi;
const TOKEN_COUNTER = /[↑↓]?\s*[\d.,]+k?\s*tokens?/gi;
const ACTIVE_CHILD_MARKER = '__active_child_process__';

function isRepaintGarble(line) {
  const bullets = (line.match(/[•·]/g) || []).length;
  const statusFragments = (line.match(/wait|backg|groun|termi|minal/gi) || []).length;
  const symbolsAndDigits = (line.match(/[•·\d…]/g) || []).length;
  return bullets >= 3 || statusFragments >= 5 ||
    (line.length >= 30 && symbolsAndDigits / line.length >= 0.3);
}

function normalizeTerminalLine(rawLine) {
  const rawWithoutAnsi = String(rawLine || '').replace(ANSI_ESCAPE, '');
  const statusCandidate = rawWithoutAnsi.replace(BOX_CHROME, ' ').replace(LEADING_NOISE, '').trim();
  const compactStatus = statusCandidate.toLowerCase().replace(/[•·\s\d…]/g, '');
  const cleanActiveChild = /^(?:waiting\s+(?:\/\s*[·•]\s*)?for\s+background\s+(?:terminal|task|agent)s?\b|waiting\s*\/.*\b\d+\s+background\s+tasks?\s+still\s+running\b|.*\b\d+\s+background\s+(?:terminal|task)s?\s+(?:still\s+)?running\b)/i.test(statusCandidate);
  const garbledActiveChild = isRepaintGarble(statusCandidate) && /backg.*term/i.test(compactStatus);
  const activeChild = cleanActiveChild || garbledActiveChild;
  let line = rawWithoutAnsi
    .trim()
    .replace(BOX_CHROME, ' ')
    .replace(LEADING_NOISE, '')
    .replace(/\s*(?:[·•]\s*)?tip\s*:.*$/i, '')
    .replace(DURATION, '')
    .replace(TOKEN_COUNTER, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (activeChild) return { text: ACTIVE_CHILD_MARKER, activeChild: true };
  if (isRepaintGarble(statusCandidate)) return { text: '', activeChild: false };
  if (!line || !/[\p{L}\p{N}]/u.test(line)) return { text: '', activeChild: false };
  if (/esc\s+to\s+interrupt/i.test(line) || /thinking(?:\.{3}|…)/i.test(line) ||
      /working\s*\(/i.test(line) || /^\S+(?:\.{3}|…)(?:\s|\(|$)/u.test(line)) {
    return { text: '', activeChild: false };
  }
  if (/^(?:elapsed|time)\s*:?\s*(?:\d+(?::\d+){1,2})?\s*$/i.test(line)) {
    return { text: '', activeChild: false };
  }
  return { text: line, activeChild: false };
}

function terminalOutputSample(text) {
  const normalized = String(text || '')
    .replace(ANSI_ESCAPE, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(normalizeTerminalLine);
  return {
    text: normalized.map((line) => line.text).filter(Boolean).join('\n'),
    activeChild: normalized.some((line) => line.activeChild),
  };
}

function meaningfulTerminalOutput(text) {
  return terminalOutputSample(text).text;
}

function digest(parts) {
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex');
}

function gitValue({ key, args, worktreePath, git, previousGitParts }) {
  const result = git(args, worktreePath);
  if (result && result.status === 0) return { value: result.stdout || '', available: true };
  if (previousGitParts && typeof previousGitParts[key] === 'string') {
    return { value: previousGitParts[key], available: false };
  }
  return { value: '<unavailable>', available: false };
}

function changedPathMetadata(worktreePath, pathsText, stat) {
  const root = path.resolve(worktreePath);
  return String(pathsText || '')
    .split(/[\0\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort()
    .map((entry) => {
      const absolute = path.resolve(root, entry);
      if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return `${entry}:<outside>`;
      try {
        const value = stat(absolute);
        return `${entry}:${value.size}:${value.mtimeMs}`;
      } catch {
        return `${entry}:<missing>`;
      }
    })
    .join('\n');
}

/** Build a stable progress sample. Git/stat functions are injected so tests stay hermetic. */
function workerProgressSample({
  terminalText, worktreePath, git, stat = fs.statSync, previousGitParts = null,
}) {
  const output = terminalOutputSample(terminalText);
  const parts = [`output:${output.text}`];
  const gitParts = {};
  if (worktreePath && typeof git === 'function') {
    for (const [key, args] of [
      ['status', ['status', '--porcelain']],
      ['head', ['rev-parse', 'HEAD']],
      ['diff', ['diff']],
      ['changedPaths', ['ls-files', '-z', '-o', '-m', '--exclude-standard']],
    ]) {
      const sampled = gitValue({ key, args, worktreePath, git, previousGitParts });
      gitParts[key] = sampled.value;
      parts.push(`${key}:${sampled.value}`);
    }
    const changedPathsAvailable = gitParts.changedPaths !== '<unavailable>';
    gitParts.pathMetadata = changedPathsAvailable
      ? changedPathMetadata(worktreePath, gitParts.changedPaths, stat)
      : (previousGitParts && previousGitParts.pathMetadata) || '<unavailable>';
    parts.push(`pathMetadata:${gitParts.pathMetadata}`);
  } else {
    parts.push('worktree:<unavailable>');
  }
  return { fingerprint: digest(parts), gitParts, activeChild: output.activeChild };
}

function workerProgressFingerprint(options) {
  return workerProgressSample(options).fingerprint;
}

/**
 * Update one terminal's persisted progress clock. A changed fingerprint re-arms the
 * episode; an unchanged fingerprint reports once after the configured threshold.
 */
function observeWorkerProgress(records, {
  handle, fingerprint, now, stallSeconds, activeChild = false, gitParts, screenText,
}) {
  const previous = records.get(handle);
  if (!previous || previous.fingerprint !== fingerprint) {
    records.set(handle, { fingerprint, lastProgressAt: now, reported: false, activeChild, gitParts, screenText });
    return { stalled: false, changed: true, stalledSeconds: 0 };
  }

  const stalledSeconds = Math.max(0, Math.floor((now - previous.lastProgressAt) / 1000));
  const effectiveThreshold = activeChild ? stallSeconds * 2 : stallSeconds;
  if (stalledSeconds < effectiveThreshold || previous.reported) {
    records.set(handle, {
      ...previous, activeChild, gitParts: gitParts || previous.gitParts,
      screenText: screenText || previous.screenText,
    });
    return { stalled: false, changed: false, stalledSeconds };
  }
  records.set(handle, {
    ...previous, reported: true, activeChild, gitParts: gitParts || previous.gitParts,
    screenText: screenText || previous.screenText,
  });
  return { stalled: true, changed: false, stalledSeconds };
}

function recordsFromJSON(value) {
  if (!Array.isArray(value)) return new Map();
  return new Map(value.filter(([handle, record]) =>
    typeof handle === 'string' && record && typeof record.fingerprint === 'string' &&
    Number.isFinite(record.lastProgressAt) && typeof record.reported === 'boolean'));
}

module.exports = {
  ACTIVE_CHILD_MARKER,
  isRepaintGarble,
  normalizeTerminalLine,
  terminalOutputSample,
  meaningfulTerminalOutput,
  workerProgressSample,
  workerProgressFingerprint,
  observeWorkerProgress,
  recordsFromJSON,
};
