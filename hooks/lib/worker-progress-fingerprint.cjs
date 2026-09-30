'use strict';

const crypto = require('crypto');

const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const SPINNER_PREFIX = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒⏳⌛⣾⣽⣻⢿⡿⣟⣯⣷🌑🌒🌓🌔🌕🌖🌗🌘|/\\\-]+\s*/u;

function meaningfulTerminalOutput(text) {
  return String(text || '')
    .replace(ANSI_ESCAPE, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      const withoutChrome = line
        .replace(/^[┌┐└┘├┤┬┴┼─━│┃╭╮╯╰═║╔╗╚╝]+\s*/u, '')
        .replace(/\s*[┌┐└┘├┤┬┴┼─━│┃╭╮╯╰═║╔╗╚╝]+$/u, '')
        .trim();
      const withoutSpinner = withoutChrome.replace(SPINNER_PREFIX, '').trim();
      if (!withoutSpinner) return false;
      if (/^thinking(?:\.{1,3}|…)?(?:\s+\d+[hms](?:\s+\d+[ms])*)?\s*$/i.test(withoutSpinner)) return false;
      if (/^working(?:\.{1,3}|…)?\s*\(\s*\d+m(?:\s*\d+s)?[^)]*\)\s*$/i.test(withoutSpinner)) return false;
      if (/^(?:elapsed|time)\s*:?\s*\d+(?::\d+){1,2}\s*$/i.test(withoutSpinner)) return false;
      if (/^(?:└\s*)?tip\s*:/i.test(withoutSpinner)) return false;
      if (/^[┌┐└┘├┤┬┴┼─━│┃╭╮╯╰═║╔╗╚╝]+$/u.test(withoutSpinner)) return false;
      if (/^(?:[↑↓]\s*)?(?:cursor|tokens?|context)?\s*:?\s*[\d,.]+k?(?:\s*\/\s*[\d,.]+k?|%|\s+tokens?)?\s*$/i.test(withoutSpinner)) return false;
      if (/^[›>❯]\s*$/.test(withoutSpinner)) return false;
      return true;
    })
    .join('\n');
}

function digest(parts) {
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex');
}

/** Build a stable progress fingerprint. `git` is injected so tests never spawn git. */
function workerProgressFingerprint({ terminalText, worktreePath, git }) {
  const parts = [`output:${meaningfulTerminalOutput(terminalText)}`];
  if (worktreePath && typeof git === 'function') {
    for (const args of [
      ['status', '--porcelain'],
      ['rev-parse', 'HEAD'],
      ['diff', '--stat'],
    ]) {
      const result = git(args, worktreePath);
      parts.push(result && result.status === 0 ? `${args[0]}:${result.stdout || ''}` : `${args[0]}:<unavailable>`);
    }
  } else {
    parts.push('worktree:<unavailable>');
  }
  return digest(parts);
}

/**
 * Update one terminal's persisted progress clock. A changed fingerprint re-arms the
 * episode; an unchanged fingerprint reports once after the configured threshold.
 */
function observeWorkerProgress(records, { handle, fingerprint, now, stallSeconds }) {
  const previous = records.get(handle);
  if (!previous || previous.fingerprint !== fingerprint) {
    records.set(handle, { fingerprint, lastProgressAt: now, reported: false });
    return { stalled: false, changed: true, stalledSeconds: 0 };
  }

  const stalledSeconds = Math.max(0, Math.floor((now - previous.lastProgressAt) / 1000));
  if (stalledSeconds < stallSeconds || previous.reported) {
    return { stalled: false, changed: false, stalledSeconds };
  }
  records.set(handle, { ...previous, reported: true });
  return { stalled: true, changed: false, stalledSeconds };
}

function recordsFromJSON(value) {
  if (!Array.isArray(value)) return new Map();
  return new Map(value.filter(([handle, record]) =>
    typeof handle === 'string' && record && typeof record.fingerprint === 'string' &&
    Number.isFinite(record.lastProgressAt) && typeof record.reported === 'boolean'));
}

module.exports = {
  meaningfulTerminalOutput,
  workerProgressFingerprint,
  observeWorkerProgress,
  recordsFromJSON,
};
