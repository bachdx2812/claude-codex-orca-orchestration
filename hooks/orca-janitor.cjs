#!/usr/bin/env node
/** Machine-wide cleanup for finished Orca worktrees. Every uncertain signal fails closed. */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig, stateDir, janitorEnabled } = require('./lib/config.cjs');
const {
  evaluateDoneButOpen, runGit, worktreeKeys,
} = require('./orca-heartbeat.cjs');

const ORCA_BIN = process.env.ORCA_BIN || 'orca';
const LOG_FILE = path.join(stateDir(), 'janitor.log');

function appendLog(message) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

function runOrca(args, timeout = 10000) {
  try {
    const result = spawnSync(ORCA_BIN, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) return null;
    return JSON.parse(result.stdout || '{}');
  } catch {
    return null;
  }
}

function worktrees(run = runOrca) {
  const reply = run(['worktree', 'ps', '--json', '--limit', '500']);
  if (!reply || reply.ok === false) return null;
  const result = reply.result ?? reply;
  if (!Array.isArray(result.worktrees) || result.truncated) return null;
  return result.worktrees.filter((row) => row && typeof row.path === 'string').map((row) => ({
    path: row.path,
    worktreeId: typeof row.worktreeId === 'string' ? row.worktreeId : '',
    displayName: row.displayName || row.path,
    isMainWorktree: !!row.isMainWorktree,
    isArchived: !!row.isArchived,
    liveTerminalCount: typeof row.liveTerminalCount === 'number' && Number.isFinite(row.liveTerminalCount)
      ? row.liveTerminalCount : null,
    lastOutputAt: Number(row.lastOutputAt) || 0,
    prState: row.linkedPR ? row.linkedPR.state : null,
    prNumber: row.linkedPR ? row.linkedPR.number : null,
    mrState: row.linkedGitLabMR ? row.linkedGitLabMR.state : null,
    mrNumber: row.linkedGitLabMR ? row.linkedGitLabMR.number : null,
  }));
}

function workerRows(run = runOrca) {
  const rows = [];
  let cursor = null;
  do {
    const args = ['orchestration', 'worker-list', '--include-remote', '--limit', '100', '--json'];
    if (cursor) args.push('--cursor', cursor);
    const reply = run(args);
    if (!reply || reply.ok === false) return null;
    const result = reply.result ?? reply;
    if (!Array.isArray(result.workers)) return null;
    rows.push(...result.workers);
    if (!result.page?.hasMore) return rows;
    if (!result.page.nextCursor || result.page.nextCursor === cursor) return null;
    cursor = result.page.nextCursor;
  } while (true);
}

function workerWorktreeKeys(row) {
  const keys = new Set();
  const candidates = [
    row?.worktreeId, row?.worktreePath, row?.resourcePath,
    row?.resource?.worktreeId, row?.resource?.worktreePath, row?.resource?.path,
    row?.worktree?.path, row?.projection?.workspace?.id, row?.projection?.workspace?.path,
  ];
  for (const candidate of candidates) {
    for (const key of worktreeKeys(candidate, candidate)) keys.add(key);
  }
  return keys;
}

function blockedWorktreeKeys(rows) {
  const blocked = new Set();
  for (const row of rows || []) {
    if (!row || row.terminalState === 'released') continue;
    for (const key of workerWorktreeKeys(row)) blocked.add(key);
  }
  return blocked;
}

function isBlocked(worktree, blocked) {
  return [...worktreeKeys(worktree.worktreeId, worktree.path)].some((key) => blocked.has(key));
}

function runJanitor(ctx = {}) {
  const run = ctx.runOrca || runOrca;
  const git = ctx.git || runGit;
  const list = worktrees(run);
  const workers = workerRows(run);
  if (!list || !workers) return { ok: false, removed: [], reason: 'inventory unavailable or incomplete' };
  const blocked = blockedWorktreeKeys(workers);
  const removed = [];
  for (const worktree of list) {
    if (worktree.isMainWorktree || worktree.isArchived || worktree.liveTerminalCount !== 0 || isBlocked(worktree, blocked)) continue;
    const verdict = evaluateDoneButOpen(worktree, { now: Date.now(), idleSeconds: 0, git, stat: ctx.stat });
    if (!verdict.done) continue;
    const reply = run(['worktree', 'rm', '--worktree', `path:${worktree.path}`, '--json'], 60000);
    if (reply && reply.ok !== false) {
      removed.push(worktree.path);
      appendLog(`removed ${JSON.stringify(worktree.path)} (${verdict.reason})`);
    } else {
      appendLog(`remove failed ${JSON.stringify(worktree.path)}`);
    }
  }
  return { ok: true, removed };
}

function main() {
  const cfg = loadConfig();
  if (!janitorEnabled(cfg)) return;
  const result = runJanitor();
  if (!result.ok) {
    appendLog(`skipped: ${result.reason}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  appendLog, runOrca, worktrees, workerRows, workerWorktreeKeys, blockedWorktreeKeys,
  isBlocked, runJanitor,
};
