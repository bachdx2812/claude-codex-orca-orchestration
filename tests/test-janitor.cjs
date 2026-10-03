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
check('a retained worker row prevents removal', retained.calls.includes('worktree rm'), false);

const ghUnavailable = runCase('gh-unavailable', worktree(), {
  STUB_GH_FAIL: '1', STUB_GIT_HAS_UPSTREAM: '0', STUB_GIT_ANCESTOR: '1',
  STUB_GIT_HEAD_COMMIT_TIME: String(Math.floor(Date.now() / 1000) + 60),
  STUB_GIT_REFLOG_HAS_COMMIT: '1',
});
check('missing or unauthenticated gh falls back to ancestor and reflog acceptance',
  ghUnavailable.calls.includes(`worktree rm --worktree path:${ghUnavailable.worktreePath} --json`), true);

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
function invokeGate(payload) {
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(payload), encoding: 'utf8', env: gateEnv });
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

invokeGate({ hook_event_name: 'SessionStart', session_id: shellSession, source: 'resume' });
const afterSessionStart = invokeGate({ hook_event_name: 'UserPromptSubmit', session_id: shellSession, prompt: 'continue' });
check('SessionStart clears background shell tracking from the previous process',
  /background shells running/.test(afterSessionStart.stdout), false);

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
