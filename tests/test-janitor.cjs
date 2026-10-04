#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-janitor-test-'));
const JANITOR = path.join(__dirname, '..', 'hooks', 'orca-janitor.cjs');
const GATE = path.join(__dirname, '..', 'hooks', 'orchestrator-gate.cjs');
const ORCA = path.join(__dirname, 'fixtures', 'orca-stub.cjs');
const GIT = path.join(__dirname, 'fixtures', 'git-stub.cjs');
const GH = path.join(__dirname, 'fixtures', 'gh-stub.cjs');
for (const file of [ORCA, GIT, GH]) try { fs.chmodSync(file, 0o755); } catch {}

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function runCase(name, row, extraEnv = {}, workers = []) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const worktreePath = path.join(dir, 'worktree');
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, '.git'), 'gitdir: synthetic\n');
  const actualRow = { ...row, path: worktreePath, worktreeId: `repo-1::${worktreePath}` };
  const actualWorkers = JSON.parse(JSON.stringify(workers)
    .replaceAll('/work/feature', worktreePath).replaceAll('/work/foreign', worktreePath));
  const actualExtraEnv = Object.fromEntries(Object.entries(extraEnv).map(([key, value]) => [
    key, typeof value === 'string' ? value.replaceAll('__WORKTREE__', worktreePath) : value,
  ]));
  const calls = path.join(dir, 'orca-calls.log');
  const ghCalls = path.join(dir, 'gh-calls.log');
  const psCalls = path.join(dir, 'ps-calls.log');
  const result = spawnSync(process.execPath, [JANITOR], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ORCH_STATE_DIR: path.join(dir, 'state'),
      ORCH_CONFIG_PATH: path.join(dir, 'missing-config.json'),
      ORCA_BIN: ORCA,
      ORCH_GIT_BIN: GIT,
      ORCH_GH_BIN: GH,
      STUB_WORKTREES_JSON: JSON.stringify([actualRow]),
      STUB_WORKERS_JSON: JSON.stringify(actualWorkers),
      STUB_ORCA_CALLS_LOG: calls,
      STUB_WORKTREE_PS_CALLS_LOG: psCalls,
      STUB_GH_CALLS_LOG: ghCalls,
      STUB_GIT_ORIGIN: 'git@github.com:acme/widgets.git',
      STUB_GIT_BRANCH: 'feature/work',
      STUB_GIT_CLEAN: '1',
      STUB_GIT_HAS_UPSTREAM: '1',
      STUB_GIT_HEAD_OID: 'head123',
      STUB_GH_HEAD_OID: 'head123',
      STUB_GH_STATE: 'MERGED',
      ...actualExtraEnv,
    },
  });
  return {
    result,
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '',
    ghCalls: fs.existsSync(ghCalls) ? fs.readFileSync(ghCalls, 'utf8') : '',
    log: fs.existsSync(path.join(dir, 'state', 'janitor.log'))
      ? fs.readFileSync(path.join(dir, 'state', 'janitor.log'), 'utf8') : '',
    worktreePath,
  };
}

function worktree(overrides = {}) {
  return {
    displayName: 'feature',
    isMainWorktree: false, isArchived: false, liveTerminalCount: 0,
    ...overrides,
  };
}

const squash = runCase('squash-merged', worktree());
check('squash-merged branch without an Orca PR is removed', squash.calls.includes(`worktree rm --worktree path:${squash.worktreePath} --json`), true);
check('GitHub lookup targets the origin repository and branch',
  squash.ghCalls.includes('pr list --repo acme/widgets --head feature/work --state all'), true);
check('GitHub lookup checks up to 100 PRs and requests pushed head OIDs',
  squash.ghCalls.includes('--limit 100 --json state,headRefOid'), true);
check('successful janitor removal is logged', squash.log.includes(`removed ${JSON.stringify(squash.worktreePath)} (GitHub PR MERGED)`), true);

const open = runCase('open-pr', worktree(), { STUB_GH_STATE: 'OPEN', STUB_GIT_ANCESTOR: '1' });
check('an open PR is kept even when Git says the branch is merged', open.calls.includes('worktree rm'), false);

const newlyOpen = runCase('newly-open-pr', worktree(), { STUB_GH_STATE_AFTER_FIRST: 'OPEN' });
check('an uncached pre-removal check catches a PR opened after the initial verdict',
  newlyOpen.calls.includes('worktree rm'), false);

const dirty = runCase('dirty', worktree(), { STUB_GIT_CLEAN: '0' });
check('a dirty worktree is kept', dirty.calls.includes('worktree rm'), false);

const statusProbeFailed = runCase('status-probe-failed', worktree(), { STUB_GIT_STATUS_FAIL: '1' });
check('a worktree whose git status probe itself fails is kept',
  statusProbeFailed.calls.includes('worktree rm'), false);
check('a git probe failure is logged distinctly from a real dirty verdict',
  statusProbeFailed.log.includes(`kept ${JSON.stringify(statusProbeFailed.worktreePath)}: git probe failed`), true);

const deletedUpstream = runCase('deleted-upstream', worktree(), {
  STUB_GIT_HAS_UPSTREAM: '0', STUB_GIT_UPSTREAM_GONE: '1',
});
check('an accepted clean branch is removable after its remote upstream is deleted',
  deletedUpstream.calls.includes(`worktree rm --worktree path:${deletedUpstream.worktreePath} --json`), true);

const upstreamTimeout = runCase('upstream-timeout', worktree(), {
  STUB_GIT_HAS_UPSTREAM: '0', STUB_GIT_UPSTREAM_SIGNAL: '1', STUB_GIT_UPSTREAM_GONE: '1',
});
check('a signalled or timed-out upstream probe fails closed', upstreamTimeout.calls.includes('worktree rm'), false);

const extraLocalCommit = runCase('deleted-upstream-extra-local', worktree(), {
  STUB_GIT_HAS_UPSTREAM: '0', STUB_GIT_UPSTREAM_GONE: '1',
  STUB_GIT_HEAD_OID: 'local-after-push', STUB_GH_HEAD_OID: 'pushed-and-merged',
});
check('a deleted upstream with a local commit after the pushed PR head is kept',
  extraLocalCommit.calls.includes('worktree rm'), false);

const closedUnmerged = runCase('deleted-upstream-closed-unmerged', worktree(), {
  STUB_GIT_HAS_UPSTREAM: '0', STUB_GIT_UPSTREAM_GONE: '1', STUB_GH_STATE: 'CLOSED',
});
check('a closed-unmerged PR never proves a deleted-upstream branch was pushed',
  closedUnmerged.calls.includes('worktree rm'), false);

const ignoredOutput = runCase('ignored-output', worktree(), { STUB_GIT_IGNORED: 'agent/output/result.zip' });
check('a non-rebuildable ignored file keeps the worktree', ignoredOutput.calls.includes('worktree rm'), false);
check('the blocking ignored path is logged', ignoredOutput.log.includes('agent/output/result.zip'), true);

const ignoredBuild = runCase('ignored-build', worktree(), {
  STUB_GIT_IGNORED: 'node_modules/,nested/__pycache__/cache.pyc,dist/',
});
check('a worktree containing only allowlisted rebuildable ignored files is removable',
  ignoredBuild.calls.includes(`worktree rm --worktree path:${ignoredBuild.worktreePath} --json`), true);

const linkedClosedOpen = runCase('linked-closed-new-open-real-shape', {
  ...worktree(), linkedPR: { state: 'closed', number: 44 },
}, { STUB_GH_STATE: 'OPEN', STUB_GIT_ANCESTOR: '1' });
check('an OPEN GitHub PR vetoes a stale linked CLOSED PR', linkedClosedOpen.calls.includes('worktree rm'), false);

const live = runCase('live-terminal', worktree({ liveTerminalCount: 1 }));
check('a worktree with a live terminal is kept', live.calls.includes('worktree rm'), false);

const liveOnRecheck = runCase('live-on-recheck', worktree(), {
  STUB_WORKTREES_AFTER_FIRST_JSON: JSON.stringify([{
    ...worktree({ liveTerminalCount: 1 }), path: '__WORKTREE__', worktreeId: 'repo-1::__WORKTREE__',
  }]),
});
check('a terminal appearing after the initial snapshot prevents removal',
  liveOnRecheck.calls.includes('worktree rm'), false);
check('the recheck-liveness-changed reason is logged distinctly',
  liveOnRecheck.log.includes('live-terminal state changed before removal'), true);

const missingOnRecheck = runCase('missing-on-recheck', worktree(), {
  STUB_WORKTREES_AFTER_FIRST_JSON: '[]',
});
check('a worktree absent from the fresh re-read is kept',
  missingOnRecheck.calls.includes('worktree rm'), false);
check('a failed/missing fresh re-read logs a distinct reason, not the liveness-changed one',
  missingOnRecheck.log.includes('re-read before removal failed'), true);
check('a failed/missing fresh re-read does not reuse the liveness-changed reason',
  missingOnRecheck.log.includes('live-terminal state changed before removal'), false);

const foreign = runCase('foreign-session', worktree(),
  { STUB_GH_STATE: 'CLOSED' }, [{
    dispatchId: 'ctx_other', terminalState: 'released', workerState: 'succeeded',
    projection: { workspace: { id: 'repo-1::/work/foreign' } },
  }]);
check('a foreign-session merged clean worktree is removed without ownership coupling',
  foreign.calls.includes(`worktree rm --worktree path:${foreign.worktreePath} --json`), true);

const retained = runCase('retained-worker', worktree(), {}, [{
  dispatchId: 'ctx_retained', terminalState: 'retained', workerState: 'succeeded',
  projection: { workspace: { id: 'repo-1::/work/feature' } },
}]);
check('a retained-but-terminal (succeeded) worker row no longer blocks removal',
  retained.calls.includes(`worktree rm --worktree path:${retained.worktreePath} --json`), true);

const runningWorker = runCase('running-worker', worktree(), {}, [{
  dispatchId: 'ctx_running', terminalState: 'active', workerState: 'running',
  projection: { workspace: { id: 'repo-1::/work/feature' } },
}]);
check('a still-running worker row keeps blocking removal', runningWorker.calls.includes('worktree rm'), false);
check('the worker-row kept reason names the dispatch id and states',
  runningWorker.log.includes(`kept ${JSON.stringify(runningWorker.worktreePath)}: worker row ctx_running running/active`), true);

const bothTerminalRow = runCase('both-fields-terminal-worker-row', worktree(), {}, [{
  dispatchId: 'ctx_both_terminal', terminalState: 'retained', workerState: 'failed', dispatchStatus: 'completed',
  projection: { workspace: { id: 'repo-1::/work/feature' } },
}]);
check('a row terminal on both workerState and dispatchStatus no longer blocks removal',
  bothTerminalRow.calls.includes(`worktree rm --worktree path:${bothTerminalRow.worktreePath} --json`), true);

const disagreeingRunningFailed = runCase('disagreeing-running-failed', worktree(), {}, [{
  dispatchId: 'ctx_disagree_1', terminalState: 'retained', workerState: 'running', dispatchStatus: 'failed',
  projection: { workspace: { id: 'repo-1::/work/feature' } },
}]);
check('a row with workerState running and dispatchStatus failed keeps blocking removal',
  disagreeingRunningFailed.calls.includes('worktree rm'), false);

const disagreeingFailedRunning = runCase('disagreeing-failed-running', worktree(), {}, [{
  dispatchId: 'ctx_disagree_2', terminalState: 'active', workerState: 'failed', dispatchStatus: 'running',
  projection: { workspace: { id: 'repo-1::/work/feature' } },
}]);
check('a row with workerState failed and dispatchStatus running keeps blocking removal',
  disagreeingFailedRunning.calls.includes('worktree rm'), false);

const succeededNoDispatchStatus = runCase('succeeded-no-dispatch-status', worktree(), {}, [{
  dispatchId: 'ctx_succeeded_only', terminalState: 'retained', workerState: 'succeeded',
  projection: { workspace: { id: 'repo-1::/work/feature' } },
}]);
check('a succeeded row with no dispatchStatus field no longer blocks removal',
  succeededNoDispatchStatus.calls.includes(`worktree rm --worktree path:${succeededNoDispatchStatus.worktreePath} --json`), true);

const unsupervisedRow = runCase('unsupervised-worker-row', worktree(), {}, [{
  dispatchId: 'ctx_unsupervised', terminalState: 'active', workerState: 'unsupervised',
  projection: { workspace: { id: 'repo-1::/work/feature' } },
}]);
check('an unsupervised worker row still blocks removal', unsupervisedRow.calls.includes('worktree rm'), false);

const ghUnavailable = runCase('gh-unavailable', worktree(), {
  STUB_GH_FAIL: '1', STUB_GIT_HAS_UPSTREAM: '0', STUB_GIT_ANCESTOR: '1',
  STUB_GIT_HEAD_COMMIT_TIME: String(Math.floor(Date.now() / 1000) + 60),
  STUB_GIT_REFLOG_HAS_COMMIT: '1',
});
check('a gh command error is uncertain and keeps the worktree',
  ghUnavailable.calls.includes('worktree rm'), false);

const ghMissing = runCase('gh-missing', worktree(), {
  ORCH_GH_BIN: path.join(ROOT, 'missing-gh'),
  STUB_GIT_HAS_UPSTREAM: '0', STUB_GIT_ANCESTOR: '1',
  STUB_GIT_HEAD_COMMIT_TIME: String(Math.floor(Date.now() / 1000) + 60),
  STUB_GIT_REFLOG_HAS_COMMIT: '1',
});
check('a missing gh binary keeps the Git-only ancestor and reflog fallback',
  ghMissing.calls.includes(`worktree rm --worktree path:${ghMissing.worktreePath} --json`), true);

// The kept-reason log dedups by reason-per-path (item 1): two consecutive runs that keep
// the same worktree for the same reason must log the line only once.
function runJanitorRaw(dir, extraEnv) {
  return spawnSync(process.execPath, [JANITOR], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ORCH_STATE_DIR: path.join(dir, 'state'),
      ORCH_CONFIG_PATH: path.join(dir, 'missing-config.json'),
      ORCA_BIN: ORCA,
      ORCH_GIT_BIN: GIT,
      ORCH_GH_BIN: GH,
      ...extraEnv,
    },
  });
}

const dedupDir = path.join(ROOT, 'kept-reason-dedup');
fs.mkdirSync(dedupDir, { recursive: true });
const dedupWorktreePath = path.join(dedupDir, 'worktree');
fs.mkdirSync(dedupWorktreePath, { recursive: true });
fs.writeFileSync(path.join(dedupWorktreePath, '.git'), 'gitdir: synthetic\n');
const dedupEnv = {
  STUB_WORKTREES_JSON: JSON.stringify([{
    ...worktree(), path: dedupWorktreePath, worktreeId: `repo-1::${dedupWorktreePath}`,
  }]),
  STUB_WORKERS_JSON: '[]',
  STUB_GIT_ORIGIN: 'git@github.com:acme/widgets.git', STUB_GIT_BRANCH: 'feature/work',
  STUB_GIT_HAS_UPSTREAM: '1', STUB_GIT_HEAD_OID: 'head123', STUB_GH_HEAD_OID: 'head123',
  STUB_GH_STATE: 'MERGED', STUB_GIT_CLEAN: '0',
};
runJanitorRaw(dedupDir, dedupEnv);
runJanitorRaw(dedupDir, dedupEnv);
const dedupLogPath = path.join(dedupDir, 'state', 'janitor.log');
const dedupLog = fs.existsSync(dedupLogPath) ? fs.readFileSync(dedupLogPath, 'utf8') : '';
const dedupLines = dedupLog.split('\n').filter((line) => line.includes(`kept ${JSON.stringify(dedupWorktreePath)}: dirty`));
check('a kept reason unchanged across two runs is logged exactly once', dedupLines.length, 1);

// A reason change (dirty -> a live terminal appearing) must log again rather than staying
// silent because some earlier reason for this path was already recorded.
const dedupEnvChanged = { ...dedupEnv, STUB_GIT_CLEAN: '0',
  STUB_WORKTREES_JSON: JSON.stringify([{
    ...worktree({ liveTerminalCount: 1 }), path: dedupWorktreePath, worktreeId: `repo-1::${dedupWorktreePath}`,
  }]) };
runJanitorRaw(dedupDir, dedupEnvChanged);
const dedupLogAfterChange = fs.readFileSync(dedupLogPath, 'utf8');
check('a changed kept reason for the same path is logged again',
  dedupLogAfterChange.includes(`kept ${JSON.stringify(dedupWorktreePath)}: live terminal`), true);

// The kept-state file is bounded to the current run's own inventory (MED-2): a path that
// left the inventory (removed manually, by heartbeat `remove` mode, or via a direct
// `orca worktree rm`) must not linger in `janitor-kept.json` forever.
const dedupKeptStatePath = path.join(dedupDir, 'state', 'janitor-kept.json');
const keptStateBeforePrune = JSON.parse(fs.readFileSync(dedupKeptStatePath, 'utf8'));
check('the kept-state file holds an entry for the still-inventoried worktree',
  Object.prototype.hasOwnProperty.call(keptStateBeforePrune, dedupWorktreePath), true);
keptStateBeforePrune['/no/longer/in/inventory'] = 'dirty';
fs.writeFileSync(dedupKeptStatePath, JSON.stringify(keptStateBeforePrune));
runJanitorRaw(dedupDir, dedupEnvChanged);
const keptStateAfterPrune = JSON.parse(fs.readFileSync(dedupKeptStatePath, 'utf8'));
check('a kept-state entry for a worktree no longer in the inventory is pruned on save',
  Object.prototype.hasOwnProperty.call(keptStateAfterPrune, '/no/longer/in/inventory'), false);
check('the kept-state entry for the still-inventoried worktree survives the prune',
  Object.prototype.hasOwnProperty.call(keptStateAfterPrune, dedupWorktreePath), true);

// Incomplete inventory names the failing source (item 3).
const incompleteDir = path.join(ROOT, 'incomplete-inventory');
fs.mkdirSync(incompleteDir, { recursive: true });
runJanitorRaw(incompleteDir, { STUB_WORKTREES_JSON: '[]', STUB_WORKERS_OK_FALSE: '1' });
const incompleteLog = fs.readFileSync(path.join(incompleteDir, 'state', 'janitor.log'), 'utf8');
check('an unreadable worker-list names itself in the skip reason',
  incompleteLog.includes('skipped: inventory unavailable or incomplete (worker-list: ok:false)'), true);

const incompleteWorktreesDir = path.join(ROOT, 'incomplete-worktrees');
fs.mkdirSync(incompleteWorktreesDir, { recursive: true });
runJanitorRaw(incompleteWorktreesDir, { STUB_WORKERS_JSON: '[]', STUB_WORKTREES_NO_ARRAY: '1' });
const incompleteWorktreesLog = fs.readFileSync(path.join(incompleteWorktreesDir, 'state', 'janitor.log'), 'utf8');
check('a worktree-ps reply with no worktrees array names itself in the skip reason',
  incompleteWorktreesLog.includes('skipped: inventory unavailable or incomplete (worktree ps: missing worktrees array)'), true);

const truncatedDir = path.join(ROOT, 'truncated-worktrees');
fs.mkdirSync(truncatedDir, { recursive: true });
runJanitorRaw(truncatedDir, { STUB_WORKERS_JSON: '[]', STUB_WORKTREES_JSON: '[]', STUB_WORKTREES_TRUNCATED: '1' });
const truncatedLog = fs.readFileSync(path.join(truncatedDir, 'state', 'janitor.log'), 'utf8');
check('a truncated worktree-ps page names itself in the skip reason',
  truncatedLog.includes('skipped: inventory unavailable or incomplete (worktree ps: truncated)'), true);

// The real Orca CLI rejects any worker-list --limit over 100 outright (invalid_argument,
// exit 1, JSON error body on stdout) — the stub reproduces that shape so a regression back
// to a >100 limit is caught by the suite without needing a live Orca.
const stubLimitResult = spawnSync(process.execPath, [ORCA, 'orchestration', 'worker-list', '--include-remote', '--limit', '10000', '--json'], { encoding: 'utf8' });
check('the stub rejects a worker-list limit over 100 like a real Orca', stubLimitResult.status, 1);
let stubLimitReply = {};
try { stubLimitReply = JSON.parse(stubLimitResult.stdout); } catch {}
check('the stub rejection carries the real invalid_argument shape',
  stubLimitReply.ok === false && stubLimitReply.error?.code === 'invalid_argument' &&
  stubLimitReply.error?.message === 'Too big: expected number to be <=100', true);

const stubLimitOk = spawnSync(process.execPath, [ORCA, 'orchestration', 'worker-list', '--include-remote', '--limit', '100', '--json'], { encoding: 'utf8' });
check('a worker-list limit at 100 is accepted', stubLimitOk.status, 0);

// workerRows() itself must surface Orca's own error message rather than the opaque "ok:false"
// / "no reply" labels this fix replaces.
const { workerRows } = require('../hooks/orca-janitor.cjs');
const overLimitReply = workerRows((args) => {
  check('workerRows requests a page size of 100, never more', args.includes('--limit') && args[args.indexOf('--limit') + 1], '100');
  return { ok: false, error: { code: 'invalid_argument', message: 'Too big: expected number to be <=100' } };
});
check('workerRows surfaces the real ok:false error message, not a generic label',
  overLimitReply.ok === false && overLimitReply.reason === 'worker-list: Too big: expected number to be <=100', true);

// Multi-page worker-list: the janitor must follow page.nextCursor and actually use page 2's
// rows during evaluation (item 4) — a running worker row that only exists on page 2 still
// blocks removal, proving the second page was fetched and consulted, not just discarded.
const pagedBlocked = runCase('paged-worker-list-blocks', worktree(), {
  STUB_WORKERS_PAGE_CURSOR: '1',
  STUB_WORKERS_PAGE2_JSON: JSON.stringify([{
    dispatchId: 'ctx_page2', terminalState: 'active', workerState: 'running',
    projection: { workspace: { id: 'repo-1::__WORKTREE__' } },
  }]),
});
check('a worker row that only exists on worker-list page 2 still blocks removal',
  pagedBlocked.calls.includes('worktree rm'), false);
check('the page-2 blocking worker is named in the kept reason',
  pagedBlocked.log.includes('worker row ctx_page2 running/active'), true);

// --dry-run performs the full evaluation but never mutates: no `worktree rm` call, logged
// (and printed) as "would remove" instead of "removed".
function runCaseDryRun(name, row, extraEnv = {}, workers = []) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const worktreePath = path.join(dir, 'worktree');
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, '.git'), 'gitdir: synthetic\n');
  const actualRow = { ...row, path: worktreePath, worktreeId: `repo-1::${worktreePath}` };
  const actualWorkers = JSON.parse(JSON.stringify(workers).replaceAll('/work/feature', worktreePath));
  const calls = path.join(dir, 'orca-calls.log');
  const result = spawnSync(process.execPath, [JANITOR, '--dry-run'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ORCH_STATE_DIR: path.join(dir, 'state'),
      ORCH_CONFIG_PATH: path.join(dir, 'missing-config.json'),
      ORCA_BIN: ORCA,
      ORCH_GIT_BIN: GIT,
      ORCH_GH_BIN: GH,
      STUB_WORKTREES_JSON: JSON.stringify([actualRow]),
      STUB_WORKERS_JSON: JSON.stringify(actualWorkers),
      STUB_ORCA_CALLS_LOG: calls,
      STUB_GIT_ORIGIN: 'git@github.com:acme/widgets.git',
      STUB_GIT_BRANCH: 'feature/work',
      STUB_GIT_CLEAN: '1',
      STUB_GIT_HAS_UPSTREAM: '1',
      STUB_GIT_HEAD_OID: 'head123',
      STUB_GH_HEAD_OID: 'head123',
      STUB_GH_STATE: 'MERGED',
      ...extraEnv,
    },
  });
  return {
    result,
    stdout: result.stdout,
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '',
    log: fs.existsSync(path.join(dir, 'state', 'janitor.log'))
      ? fs.readFileSync(path.join(dir, 'state', 'janitor.log'), 'utf8') : '',
    worktreePath,
  };
}

const dryRun = runCaseDryRun('dry-run-removable', worktree());
check('--dry-run never calls worktree rm', dryRun.calls.includes('worktree rm'), false);
check('--dry-run logs a "would remove" line with the verdict reason',
  dryRun.log.includes(`would remove ${JSON.stringify(dryRun.worktreePath)} (GitHub PR MERGED)`), true);
check('--dry-run prints the same "would remove" line to stdout',
  dryRun.stdout.includes(`would remove ${JSON.stringify(dryRun.worktreePath)} (GitHub PR MERGED)`), true);
check('--dry-run prints a one-line summary count', /would be removed/.test(dryRun.stdout), true);

const dryRunKept = runCaseDryRun('dry-run-kept', worktree(), { STUB_GIT_CLEAN: '0' });
check('--dry-run also prints "kept" lines for non-removable worktrees',
  dryRunKept.stdout.includes(`kept ${JSON.stringify(dryRunKept.worktreePath)}: dirty`), true);
check('--dry-run never calls worktree rm for a kept worktree', dryRunKept.calls.includes('worktree rm'), false);

const disabledDir = path.join(ROOT, 'disabled');
fs.mkdirSync(disabledDir, { recursive: true });
const disabledConfig = path.join(disabledDir, 'config.json');
fs.writeFileSync(disabledConfig, JSON.stringify({ janitor: { enabled: false } }));
const disabled = runCase('disabled', worktree(), { ORCH_CONFIG_PATH: disabledConfig });
check('janitor.enabled false disables a scheduled-style run at execution time', disabled.calls, '');

const rotateName = 'rotate-log';
const rotateState = path.join(ROOT, rotateName, 'state');
fs.mkdirSync(rotateState, { recursive: true });
fs.writeFileSync(path.join(rotateState, 'janitor.log'), 'x'.repeat(1024 * 1024));
const rotated = runCase(rotateName, worktree());
check('the janitor rotates its log at approximately one megabyte',
  fs.existsSync(path.join(rotateState, 'janitor.log.1')), true);
check('the active log remains small after rotation', Buffer.byteLength(rotated.log) < 4096, true);

process.env.ORCH_STATE_DIR = path.join(ROOT, 'format-state');
const { formatBackgroundShellReminder } = require('../hooks/orchestrator-gate.cjs');
const now = 1_000_000;
const three = Object.fromEntries([1, 2, 3].map((n) => [`toolu_${n}`, { command: `cmd-${n}`, started: now - n * 1000 }]));
const four = { ...three, toolu_4: { command: 'oldest-command', started: now - 65_000 } };
check('three background shells do not trigger a reminder', formatBackgroundShellReminder(three, now), null);
check('four background shells trigger the one-line TaskStop reminder',
  formatBackgroundShellReminder(four, now),
  '4 background shells running (oldest: oldest-command, 1m) - stop finished/idle ones (TaskStop)');

const gateDir = path.join(ROOT, 'gate-shells');
fs.mkdirSync(gateDir, { recursive: true });
const gateConfig = path.join(gateDir, 'config.json');
fs.writeFileSync(gateConfig, JSON.stringify({ activation: 'always', maxParallelAgents: 0 }));
const gateEnv = {
  ...process.env,
  ORCH_STATE_DIR: path.join(gateDir, 'state'),
  ORCH_CONFIG_PATH: gateConfig,
  ORCA_BIN: ORCA,
};
function invokeGate(payload, envOverrides = {}) {
  return spawnSync(process.execPath, [GATE], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { ...gateEnv, ...envOverrides },
  });
}
function hookContext(result) {
  try { return JSON.parse(result.stdout).hookSpecificOutput?.additionalContext || ''; } catch { return ''; }
}
const shellSession = 'janitor-shell-e2e';
for (let n = 1; n <= 4; n += 1) {
  const payload = {
    hook_event_name: 'PreToolUse', session_id: shellSession, tool_name: 'Bash',
    tool_use_id: `toolu_shell_${n}`, cwd: gateDir,
    tool_input: { command: `sleep ${n}`, run_in_background: true },
  };
  const result = invokeGate(payload);
  check(`background shell ${n} is admitted`, result.status, 0);
  if (n === 1) {
    const preStatePath = path.join(gateEnv.ORCH_STATE_DIR, `${shellSession}.json`);
    const preState = fs.existsSync(preStatePath) ? JSON.parse(fs.readFileSync(preStatePath, 'utf8')) : {};
    check('PreToolUse does not record an unconfirmed background launch',
      !!preState.backgroundShells?.toolu_shell_1, false);
  }
  invokeGate({ ...payload, hook_event_name: 'PostToolUse', tool_response: { status: 'async_launched' } });
}
const reminder = invokeGate({ hook_event_name: 'UserPromptSubmit', session_id: shellSession, prompt: 'continue' });
check('the fourth tracked background shell triggers the live gate reminder',
  /4 background shells running .*TaskStop/.test(reminder.stdout), true);
const stopReminder = invokeGate({ hook_event_name: 'Stop', session_id: shellSession, stop_hook_active: false });
check('Stop does not emit an invisible background-shell reminder',
  /background shells running/.test(stopReminder.stdout), false);
const completion = invokeGate({ hook_event_name: 'UserPromptSubmit', session_id: shellSession,
  prompt: '<task-notification><tool-use-id>toolu_shell_1</tool-use-id><status>completed</status></task-notification>' });
check('a matching completion notice drops the count back below the reminder threshold',
  /background shells running/.test(completion.stdout), false);

const staleStatePath = path.join(gateEnv.ORCH_STATE_DIR, `${shellSession}.json`);
const staleState = JSON.parse(fs.readFileSync(staleStatePath, 'utf8'));
staleState.backgroundShells.toolu_stale = {
  command: 'sleep forever', started: Date.now() - 7 * 60 * 60 * 1000, heartbeat: false,
};
fs.writeFileSync(staleStatePath, JSON.stringify(staleState));
const staleReminder = invokeGate({ hook_event_name: 'UserPromptSubmit', session_id: shellSession, prompt: 'continue' });
check('background shell entries expire after six hours', /sleep forever/.test(staleReminder.stdout), false);

const heartbeatCommand = `${process.execPath} ${path.join(__dirname, '..', 'hooks', 'orca-heartbeat.cjs')}`;
const firstHeartbeatPayload = { hook_event_name: 'PreToolUse', session_id: shellSession, tool_name: 'Bash',
  tool_use_id: 'toolu_heartbeat_1', cwd: gateDir,
  tool_input: { command: heartbeatCommand, run_in_background: true } };
invokeGate(firstHeartbeatPayload);
invokeGate({ ...firstHeartbeatPayload, hook_event_name: 'PostToolUse', tool_response: { status: 'async_launched' } });
const secondHeartbeat = invokeGate({ hook_event_name: 'PreToolUse', session_id: shellSession, tool_name: 'Bash',
  tool_use_id: 'toolu_heartbeat_2', cwd: gateDir,
  tool_input: { command: heartbeatCommand, run_in_background: true } });
check('starting a second heartbeat identifies the previous shell in parsed hook context',
  /stop previous heartbeat shell toolu_heartbeat_1 with TaskStop/.test(hookContext(secondHeartbeat)), true);

const beforeCompact = JSON.parse(fs.readFileSync(staleStatePath, 'utf8'));
invokeGate({ hook_event_name: 'SessionStart', session_id: shellSession, source: 'compact' });
const afterCompact = JSON.parse(fs.readFileSync(staleStatePath, 'utf8'));
check('SessionStart compact preserves background shell tracking',
  !!afterCompact.backgroundShells?.toolu_heartbeat_1, true);
check('SessionStart compact preserves the original session cutoff',
  afterCompact.sessionStartedAt, beforeCompact.sessionStartedAt);

afterCompact.backgroundShells.toolu_heartbeat_1.started = Date.now();
fs.writeFileSync(staleStatePath, JSON.stringify(afterCompact));
fs.writeFileSync(path.join(gateEnv.ORCH_STATE_DIR, `heartbeat-${shellSession}.json`), JSON.stringify({
  pid: 999_999_999, started: Date.now() - 60_000, last_tick: Date.now() - 60_000, interval: 20,
}));
const withStalePriorRecord = invokeGate({
  hook_event_name: 'PreToolUse', session_id: shellSession, tool_name: 'Bash',
  tool_use_id: 'toolu_heartbeat_3', cwd: gateDir,
  tool_input: { command: heartbeatCommand, run_in_background: true },
});
check('a stale prior liveness record does not bypass grace for a new heartbeat launch',
  /stop previous heartbeat shell toolu_heartbeat_1/.test(hookContext(withStalePriorRecord)), true);
const currentHeartbeatState = JSON.parse(fs.readFileSync(staleStatePath, 'utf8'));
currentHeartbeatState.backgroundShells.toolu_heartbeat_1.heartbeatPid = 999_999_999;
fs.writeFileSync(staleStatePath, JSON.stringify(currentHeartbeatState));
const afterExitedHeartbeat = invokeGate({
  hook_event_name: 'PreToolUse', session_id: shellSession, tool_name: 'Bash',
  tool_use_id: 'toolu_heartbeat_4', cwd: gateDir,
  tool_input: { command: heartbeatCommand, run_in_background: true },
});
check('a recorded dead heartbeat bypasses startup grace and no longer triggers duplicate advice',
  /stop previous heartbeat shell/.test(hookContext(afterExitedHeartbeat)), false);
const prunedHeartbeatState = JSON.parse(fs.readFileSync(staleStatePath, 'utf8'));
check('an exited heartbeat shell is removed from persisted tracking',
  !!prunedHeartbeatState.backgroundShells?.toolu_heartbeat_1, false);

const noticeSession = 'janitor-pretool-notices';
const pendingStarted = Date.now() - 11 * 60 * 1000;
const pendingKey = `pending-${pendingStarted}-0`;
const noticeStatePath = path.join(gateEnv.ORCH_STATE_DIR, `${noticeSession}.json`);
fs.writeFileSync(noticeStatePath, JSON.stringify({
  session_id: noticeSession, created: new Date().toISOString(), bypass: false,
  execAgent: 'invalid-route', execAgentSince: Date.now(), sessionStartedAt: pendingStarted,
  workers: { [pendingKey]: { status: 'live', started: pendingStarted, agent: 'codex', group: pendingKey } },
  backgroundShells: { toolu_notice_heartbeat: {
    command: heartbeatCommand, started: Date.now(), heartbeat: true,
  } },
  reservations: {}, agentClaims: {}, agents: {}, tasks: {},
}));
const combinedNotices = invokeGate({
  hook_event_name: 'PreToolUse', session_id: noticeSession, tool_name: 'Bash',
  tool_use_id: 'toolu_notice_second', cwd: gateDir,
  tool_input: { command: heartbeatCommand, run_in_background: true },
}, { STUB_WORKERS_JSON: '[]' });
const combinedContext = hookContext(combinedNotices);
check('PreToolUse notices remain one valid JSON hook response',
  (() => { try { JSON.parse(combinedNotices.stdout); return true; } catch { return false; } })(), true);
check('invalid execAgent repair is included in the combined hook advisory',
  /invalid persisted execAgent/.test(combinedContext), true);
check('placeholder reconciliation is included in the combined hook advisory',
  /placeholder pending-.* settled/.test(combinedContext), true);
check('the regular duplicate-heartbeat advice survives alongside maintenance notices',
  /stop previous heartbeat shell toolu_notice_heartbeat/.test(combinedContext), true);

invokeGate({ hook_event_name: 'SessionStart', session_id: shellSession, source: 'resume' });
const afterSessionStart = invokeGate({ hook_event_name: 'UserPromptSubmit', session_id: shellSession, prompt: 'continue' });
check('SessionStart clears background shell tracking from the previous process',
  /background shells running/.test(afterSessionStart.stdout), false);

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
