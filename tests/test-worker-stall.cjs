#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-worker-stall-'));
const configFile = path.join(stateDir, 'config.json');
process.env.ORCH_STATE_DIR = stateDir;
process.env.ORCH_CONFIG_PATH = configFile;
process.env.CLAUDE_CODE_SESSION_ID = 'worker-stall-test';
fs.writeFileSync(configFile, '{}');

const config = require('../hooks/lib/config.cjs');
const heartbeat = require('../hooks/orca-heartbeat.cjs');
const { approvalPromptFingerprint } = require('../hooks/lib/terminal-signals.cjs');
const {
  meaningfulTerminalOutput,
  workerProgressSample,
  workerProgressFingerprint,
  observeWorkerProgress,
  recordsFromJSON,
} = require('../hooks/lib/worker-progress-fingerprint.cjs');

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass += 1;
  else failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
}

function withConfig(value, fn) {
  fs.writeFileSync(configFile, JSON.stringify(value));
  try { return fn(); } finally { fs.writeFileSync(configFile, '{}'); }
}

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
  }
}

// Config defaults, validation and blank-as-unset env behavior.
{
  const defaults = config.loadConfig();
  check('default stall threshold is 15 minutes', defaults.heartbeat.stallSeconds, 900);
  check('Kimi default override is 10 minutes', defaults.heartbeat.stallSecondsByAgent, { kimi: 600 });
  check('ORCH_STALL_SECONDS overrides the global threshold',
    withEnv('ORCH_STALL_SECONDS', '45', () => config.stallSeconds(defaults)), 45);
  check('blank ORCH_STALL_SECONDS is unset',
    withEnv('ORCH_STALL_SECONDS', '   ', () => config.stallSeconds(defaults)), 900);
  check('invalid ORCH_STALL_SECONDS falls back',
    withEnv('ORCH_STALL_SECONDS', 'nope', () => config.stallSeconds(defaults)), 900);

  const invalid = withConfig({ heartbeat: { stallSeconds: 0, stallSecondsByAgent: { kimi: 'bad', codex: -1 } } },
    () => config.loadConfig());
  check('invalid global threshold falls back', invalid.heartbeat.stallSeconds, 900);
  check('invalid known agent override falls back and unknown invalid is dropped',
    invalid.heartbeat.stallSecondsByAgent, { kimi: 600 });
  check('invalid thresholds produce warnings',
    invalid.warnings.filter((warning) => warning.includes('stallSeconds')).length, 3);

  const valid = withConfig({ heartbeat: { stallSeconds: 120, stallSecondsByAgent: { kimi: 30, codex: 90 } } },
    () => config.loadConfig());
  check('valid thresholds are retained',
    [valid.heartbeat.stallSeconds, valid.heartbeat.stallSecondsByAgent], [120, { kimi: 30, codex: 90 }]);
}

// Repaint-only changes collapse to the same meaningful output.
const repaintA = '\u001b[2K╭────────╮\n│ ⠋ Thinking… │\nTip: Press esc to interrupt\n↑ 12.3k tokens';
const repaintB = '\u001b[2K╰────────╯\n│ 🌔 Working (9m 58s • esc to interrupt) │\nTip: Try another command\n↑ 12.4k tokens';
check('spinner/chrome/tip/counter repaint A has no meaningful output', meaningfulTerminalOutput(repaintA), '');
check('spinner/chrome/tip/counter repaint B has no meaningful output', meaningfulTerminalOutput(repaintB), '');
check('real output survives repaint filtering',
  meaningfulTerminalOutput('⠏ Thinking…\nUpdated hooks/orca-heartbeat.cjs\nTip: hello'),
  'Updated hooks/orca-heartbeat.cjs');

let gitState = { status: '', head: 'abc123', diff: '', changedPaths: '' };
let statState = {};
const gitStub = (args) => {
  if (args[0] === 'status') return { status: 0, stdout: gitState.status };
  if (args[0] === 'rev-parse') return { status: 0, stdout: gitState.head };
  if (args[0] === 'diff') return { status: 0, stdout: gitState.diff };
  if (args[0] === 'ls-files') return { status: 0, stdout: gitState.changedPaths };
  throw new Error(`unexpected git command: ${args.join(' ')}`);
};
const statStub = (filename) => {
  const value = statState[path.basename(filename)];
  if (!value) throw new Error('missing');
  return value;
};
const fingerprint = (terminalText) => workerProgressFingerprint({
  terminalText, worktreePath: '/fake/worktree', git: gitStub, stat: statStub,
});

// Real Orca preview captures: timer/spinner/tip changes in the same frame must hash alike.
for (const [name, a, b] of [
  ['Codex Working', '• Working (45s • esc to interrupt)', '• Working (1h 02m 3s • esc to interrupt)'],
  ['Kimi moon tip', '🌔 · Tip: /web: search current docs', '🌘 · Tip: /clear: reset the context'],
  ['Kimi Thinking tip', '⠦ Thinking… · Tip: /clear: reset', '⠏ Thinking… · Tip: /web: search'],
  ['Claude gerund status', '✢ Quantumizing… (19s · ↓ 1.2k tokens)', '✳ Quantumizing… (1m 23s · ↓ 1.3k tokens)'],
]) {
  check(`${name} captured frames normalize to empty`,
    [meaningfulTerminalOutput(a), meaningfulTerminalOutput(b)], ['', '']);
  check(`${name} timer/spinner variants have identical fingerprints`, fingerprint(a), fingerprint(b));
}
check('captured noise plus real new output changes the fingerprint',
  fingerprint('• Working (45s • esc to interrupt)\nUpdated hooks/x.cjs') ===
    fingerprint('• Working (1m 23s • esc to interrupt)'), false);

const records = new Map();
const start = 2_000_000_000_000;
const first = fingerprint(repaintA);
check('first observation arms without reporting', observeWorkerProgress(records, {
  handle: 'term_kimi', fingerprint: first, now: start, stallSeconds: 600,
}).stalled, false);
check('spinner-only repaint does not reset progress', fingerprint(repaintB), first);
check('spinner-only repaint fires at the fake-clock threshold', observeWorkerProgress(records, {
  handle: 'term_kimi', fingerprint: fingerprint(repaintB), now: start + 600_000, stallSeconds: 600,
}), { stalled: true, changed: false, stalledSeconds: 600 });
check('the same episode reports only once', observeWorkerProgress(records, {
  handle: 'term_kimi', fingerprint: first, now: start + 900_000, stallSeconds: 600,
}).stalled, false);

// Persisted records survive a daemon restart and retain the once-per-episode marker.
heartbeat.savePersistedStallProgress(records);
const afterRestart = heartbeat.loadPersistedStallProgress();
check('reported episode persists across daemon restart', afterRestart.get('term_kimi'), records.get('term_kimi'));
check('restart does not re-report unchanged fingerprint', observeWorkerProgress(afterRestart, {
  handle: 'term_kimi', fingerprint: first, now: start + 1_200_000, stallSeconds: 600,
}).stalled, false);
check('JSON record parser preserves persisted state',
  recordsFromJSON(JSON.parse(JSON.stringify([...records]))).get('term_kimi'), records.get('term_kimi'));

// Either worktree state or real terminal output is progress and starts a new episode.
gitState = {
  status: ' M hooks/orca-heartbeat.cjs', head: 'abc123',
  diff: '-old line\n+new line', changedPaths: 'hooks/orca-heartbeat.cjs',
};
statState = { 'orca-heartbeat.cjs': { size: 100, mtimeMs: 1000 } };
const fileProgress = fingerprint(repaintB);
check('file changes alter the fingerprint', fileProgress === first, false);
check('file changes re-arm the progress clock', observeWorkerProgress(afterRestart, {
  handle: 'term_kimi', fingerprint: fileProgress, now: start + 1_300_000, stallSeconds: 600,
}), { stalled: false, changed: true, stalledSeconds: 0 });

const realOutput = fingerprint('Implemented the stall detector.');
check('real output alters the fingerprint', realOutput === fileProgress, false);
check('real output prevents a stall and re-arms', observeWorkerProgress(afterRestart, {
  handle: 'term_kimi', fingerprint: realOutput, now: start + 1_899_000, stallSeconds: 600,
}).stalled, false);

// Full diff content and changed-path metadata catch progress missed by --stat/status.
const sameLineCountBefore = fingerprint(repaintB);
gitState.diff = '-old line\n+newer line';
const sameLineCountAfter = fingerprint(repaintB);
check('editing a modified file with unchanged line counts changes the full-diff fingerprint',
  sameLineCountAfter === sameLineCountBefore, false);

gitState = { status: '?? new-module.cjs', head: 'abc123', diff: '', changedPaths: 'new-module.cjs' };
statState = { 'new-module.cjs': { size: 50, mtimeMs: 2000 } };
const untrackedBefore = fingerprint(repaintB);
statState = { 'new-module.cjs': { size: 75, mtimeMs: 3000 } };
const untrackedAfter = fingerprint(repaintB);
check('editing untracked content changes its size/mtime fingerprint', untrackedAfter === untrackedBefore, false);

// A timeout after a successful sample reuses the last good git parts, avoiding false progress.
const goodSample = workerProgressSample({
  terminalText: repaintB, worktreePath: '/fake/worktree', git: gitStub, stat: statStub,
});
const timedOutSample = workerProgressSample({
  terminalText: repaintB, worktreePath: '/fake/worktree', git: () => null, stat: statStub,
  previousGitParts: goodSample.gitParts,
});
check('timed-out git probes reuse the last good fingerprint', timedOutSample.fingerprint, goodSample.fingerprint);

// Per-agent override is applied by the same selection used in the daemon.
const cfg = withConfig({ heartbeat: { stallSeconds: 900, stallSecondsByAgent: { kimi: 60 } } },
  () => config.loadConfig());
const thresholdFor = (agent) => heartbeat.stallThresholdForAgent(agent, cfg.heartbeat, cfg.heartbeat.stallSeconds);
check('Kimi uses its per-agent override', thresholdFor('kimi'), 60);
check('Codex uses the global threshold', thresholdFor('codex'), 900);
check('prototype property names cannot become thresholds', thresholdFor('constructor'), 900);
const kimiRecords = new Map();
observeWorkerProgress(kimiRecords, { handle: 'k', fingerprint: 'same', now: start, stallSeconds: thresholdFor('kimi') });
check('Kimi stalls at its shorter fake-clock threshold', observeWorkerProgress(kimiRecords, {
  handle: 'k', fingerprint: 'same', now: start + 60_000, stallSeconds: thresholdFor('kimi'),
}).stalled, true);

const childA = workerProgressSample({
  terminalText: '•Waiting for background terminal(15m 28s • esc to interrupt) · 1 background terminal running',
  worktreePath: '/fake/worktree', git: gitStub, stat: statStub,
});
const childB = workerProgressSample({
  terminalText: '•Waiting for background terminal(16m 41s • esc to interrupt) · 1 background terminal running',
  worktreePath: '/fake/worktree', git: gitStub, stat: statStub,
});
check('active-child timers normalize to one stable fingerprint', childA.fingerprint, childB.fingerprint);
check('active-child status is detected', childA.activeChild, true);
const childRecords = new Map();
observeWorkerProgress(childRecords, {
  handle: 'child', fingerprint: childA.fingerprint, now: start, stallSeconds: 600,
  activeChild: true, gitParts: childA.gitParts,
});
check('active child gets the requested grace at the normal threshold', observeWorkerProgress(childRecords, {
  handle: 'child', fingerprint: childB.fingerprint, now: start + 600_000, stallSeconds: 600,
  activeChild: true, gitParts: childB.gitParts,
}).stalled, false);
check('active child stalls at twice the configured threshold', observeWorkerProgress(childRecords, {
  handle: 'child', fingerprint: childB.fingerprint, now: start + 1_200_000, stallSeconds: 600,
  activeChild: true, gitParts: childB.gitParts,
}).stalled, true);
check('stall wake event identifies the dispatch and recommends nudge or cross-coder retry',
  heartbeat.formatStallEvent({ dispatchId: 'ctx_stalled', handle: 'term_stalled', agent: 'kimi', stalledSeconds: 601 }),
  'WORKER STALLED ctx_stalled (kimi, no file change or new output for 10m) - nudge it (terminal send "continue ..."), or stop it and re-dispatch the same brief to the other coder');

// Worktree resolution uses the supervised terminal/worker data and never a global scan.
check('terminal worktree path wins', heartbeat.terminalWorktreePath(
  { handle: 'term_1', worktreePath: '/terminal/path', worktreeId: '' }, []), '/terminal/path');
check('worker worktree id suffix resolves when terminal row omits it', heartbeat.terminalWorktreePath(
  { handle: 'term_2', worktreePath: '', worktreeId: '' },
  [{ agentTerminalHandle: 'term_2', worktreePaths: [], worktreeIds: ['repo::/worker/path'] }]), '/worker/path');
check('done worker states are mapped by terminal handle', [...heartbeat.terminalWorkerStates([
  { agentTerminalHandle: 'term_done', workerState: 'completed' },
  { agentTerminalHandle: 'term_live', workerState: 'running' },
])], [['term_done', 'completed'], ['term_live', 'running']]);
check('all Orca terminal worker states are excluded from stall checks',
  ['succeeded', 'failed', 'stopped', 'completed'].every((state) => heartbeat.TERMINAL_WORKER_STATES.has(state)), true);
check('done workers are skipped even when their terminals classify idle',
  heartbeat.shouldTrackWorkerProgress('idle', 'succeeded'), false);
check('running workers remain eligible for progress checks',
  heartbeat.shouldTrackWorkerProgress('working', 'running'), true);

// Approval/question prompts wake immediately, while prose mentioning their vocabulary does not.
const kimiApproval = [
  'Select permission mode',
  '  1. Ask When Needed',
  '❯ 2. Never Ask',
  '↑↓ navigate · Enter select',
].join('\n');
const kimiApprovalMoved = [
  'Select permission mode',
  '❯ 1. Ask When Needed',
  '  2. Never Ask',
  '↑↓ navigate · Enter select',
].join('\n');
const codexApproval = [
  'Do you want to allow Codex to run `npm test`?',
  '❯ Allow',
  '  Deny',
  '↑↓ navigate · Enter select',
].join('\n');
check('real Kimi permission menu is detected', typeof approvalPromptFingerprint(kimiApproval), 'string');
check('moving the selection does not create a new prompt episode',
  approvalPromptFingerprint(kimiApprovalMoved), approvalPromptFingerprint(kimiApproval));
check('real Codex Allow/Deny question is detected', typeof approvalPromptFingerprint(codexApproval), 'string');
check('captured selection navigation is sufficient UI evidence',
  typeof approvalPromptFingerprint('↑↓ navigate · Enter select'), 'string');
for (const prose of [
  'Updated the parser for Allow/Deny/approve prompts.',
  'The Select permission mode test now passes.',
  'The fixture contains ↑↓ navigate · Enter select for coverage.',
  'Normal output can mention allow and deny without asking a question.',
  '```\nAllow\nDeny\n```',
  'const prompt = "Select permission mode";',
]) {
  check(`ordinary prose is not approval UI: ${prose}`, approvalPromptFingerprint(prose), null);
}

const approvalCtx = {
  baseHandles: new Set(), ownHandles: new Set(['term_approval']), retainedHandles: new Set(),
  handleAgent: new Map([['term_approval', 'kimi']]), started: start - 1000,
  now: start, idleSeconds: 60,
};
check('supervised approval screen classifies before idle/stall', heartbeat.classifyTerminal({
  handle: 'term_approval', preview: kimiApproval, lastOutputAt: start,
}, approvalCtx).kind, 'approval_waiting');
check('prose with approval words remains ordinary working output', heartbeat.classifyTerminal({
  handle: 'term_approval', preview: 'Implemented Allow and Deny parsing.', lastOutputAt: start,
}, approvalCtx).kind, 'working');

const approvalReports = new Map();
const approvalFingerprint = approvalPromptFingerprint(kimiApproval);
check('first approval episode emits the exact wake event', heartbeat.reportApprovalWaiting({
  reported: approvalReports, handle: 'term_approval', fingerprint: approvalFingerprint,
  identity: 'ctx_approval', agent: 'kimi',
}), 'WORKER WAITING FOR APPROVAL ctx_approval (kimi)');
check('approval report is persisted for daemon restart',
  heartbeat.loadPersistedApprovalReports().get('term_approval'), approvalFingerprint);
const approvalAfterRestart = heartbeat.loadPersistedApprovalReports();
check('same approval episode reports only once across restart', heartbeat.reportApprovalWaiting({
  reported: approvalAfterRestart, handle: 'term_approval', fingerprint: approvalFingerprint,
  identity: 'ctx_approval', agent: 'kimi',
}), null);
approvalAfterRestart.delete('term_approval');
heartbeat.savePersistedApprovalReports(approvalAfterRestart);
check('clearing the disappeared prompt re-arms the same future prompt', heartbeat.reportApprovalWaiting({
  reported: approvalAfterRestart, handle: 'term_approval', fingerprint: approvalFingerprint,
  identity: 'ctx_approval', agent: 'kimi',
}), 'WORKER WAITING FOR APPROVAL ctx_approval (kimi)');

if (failures.length) {
  console.error(`${failures.length} failure(s), ${pass} passed`);
  for (const failure of failures) console.error(`\nFAIL: ${failure}`);
  process.exit(1);
}
console.log(`worker stall tests: ${pass} passed`);
