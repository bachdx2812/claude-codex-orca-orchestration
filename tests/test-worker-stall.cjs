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
const {
  approvalPromptFingerprint, hasCodexUsageExhausted,
} = require('../hooks/lib/terminal-signals.cjs');
const handover = require('../hooks/lib/worker-quota-handover.cjs');
const resume = require('../hooks/lib/quota-reset-resume.cjs');
const resumeScheduler = require('../hooks/orca-resume-scheduler.cjs');
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
  check('default handover warning margin is 5 percent', defaults.handoverWarnMarginPercent, 5);
  check('quota reset auto-resume defaults on for workers and panel',
    [defaults.autoResumeAfterReset, defaults.autoResumePanel], [true, true]);
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

  const invalidMargin = withConfig({ handoverWarnMarginPercent: 101 }, () => config.loadConfig());
  check('invalid handover warning margin falls back', invalidMargin.handoverWarnMarginPercent, 5);
  check('invalid handover warning margin warns',
    invalidMargin.warnings.some((warning) => warning.includes('handoverWarnMarginPercent')), true);

  const valid = withConfig({ heartbeat: { stallSeconds: 120, stallSecondsByAgent: { kimi: 30, codex: 90 } } },
    () => config.loadConfig());
  check('valid thresholds are retained',
    [valid.heartbeat.stallSeconds, valid.heartbeat.stallSecondsByAgent], [120, { kimi: 30, codex: 90 }]);
  check('a valid zero handover warning margin is retained',
    withConfig({ handoverWarnMarginPercent: 0 }, () => config.loadConfig()).handoverWarnMarginPercent, 0);
  check('invalid auto-resume booleans fall back independently',
    withConfig({ autoResumeAfterReset: 'yes', autoResumePanel: 0 }, () => {
      const value = config.loadConfig();
      return [value.autoResumeAfterReset, value.autoResumePanel];
    }), [true, true]);
  check('ORCH_AUTO_RESUME accepts false and blank remains unset', [
    withEnv('ORCH_AUTO_RESUME', 'false', () => config.autoResumeAfterReset(defaults)),
    withEnv('ORCH_AUTO_RESUME', '   ', () => config.autoResumeAfterReset(defaults)),
  ], [false, true]);
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

const garbledWaitA = '…ting foing for•g for b for bacor back backgrbackgro…terminal6nalal•••••7•••••8';
const garbledWaitB = 'r back•r backg backgr•backgrouckgrounkground•round tound te•und termd termi termina•erminalrminal1•inalnalal•l•••2•••••3';
const garbledSampleA = workerProgressSample({
  terminalText: garbledWaitA, worktreePath: '/fake/worktree', git: gitStub, stat: statStub,
});
const garbledSampleB = workerProgressSample({
  terminalText: garbledWaitB, worktreePath: '/fake/worktree', git: gitStub, stat: statStub,
});
check('captured garbled Codex previews both detect an active child',
  [garbledSampleA.activeChild, garbledSampleB.activeChild], [true, true]);
check('captured garbled Codex repaints have a stable fingerprint',
  garbledSampleA.fingerprint, garbledSampleB.fingerprint);

const codexScreenA = [
  '• The RTP worker is confirmed active at ~93% CPU, so the long duration is computation rather than a stall.',
  '• Waiting for background terminal (39m 45s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to…',
  '  └ .claude/skills/deepstack-release/scripts/check-pr-ci.sh 464 --game v3 --visual',
  '  └ Tip: Press tab to queue a message when a task is running; otherwise it sends immediately (except !).',
  '› Ask Codex to do anything',
].join('\n');
const codexScreenB = codexScreenA
  .replace('39m 45s', '39m 46s')
  .replace('Press tab to queue a message', 'Use /copy to copy the latest response');
const codexScreenSampleA = workerProgressSample({
  terminalText: codexScreenA, worktreePath: '/fake/worktree', git: gitStub, stat: statStub,
});
const codexScreenSampleB = workerProgressSample({
  terminalText: codexScreenB, worktreePath: '/fake/worktree', git: gitStub, stat: statStub,
});
check('real rendered Codex screens recognize the background-terminal wait',
  [codexScreenSampleA.activeChild, codexScreenSampleB.activeChild], [true, true]);
check('two rendered reads of the same Codex wait fingerprint identically',
  codexScreenSampleA.fingerprint, codexScreenSampleB.fingerprint);
check('Kimi background-task wait is an active child', workerProgressSample({
  terminalText: 'Waiting / · 1 background task still running',
  worktreePath: '/fake/worktree', git: gitStub, stat: statStub,
}).activeChild, true);

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
  handle: 'child', fingerprint: codexScreenSampleA.fingerprint, now: start, stallSeconds: 600,
  activeChild: true, gitParts: codexScreenSampleA.gitParts, screenText: codexScreenA,
});
check('active child gets the requested grace at the normal threshold', observeWorkerProgress(childRecords, {
  handle: 'child', fingerprint: codexScreenSampleB.fingerprint, now: start + 600_000, stallSeconds: 600,
  activeChild: true, gitParts: codexScreenSampleB.gitParts, screenText: codexScreenB,
}).stalled, false);
check('hung rendered Codex wait stalls at twice the configured threshold', observeWorkerProgress(childRecords, {
  handle: 'child', fingerprint: codexScreenSampleB.fingerprint, now: start + 1_200_000, stallSeconds: 600,
  activeChild: true, gitParts: codexScreenSampleB.gitParts, screenText: codexScreenB,
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
  ['succeeded', 'failed', 'stopped', 'cancelled', 'completed']
    .every((state) => heartbeat.TERMINAL_WORKER_STATES.has(state)), true);
check('done workers are skipped even when their terminals classify idle',
  heartbeat.shouldTrackWorkerProgress('idle', 'succeeded'), false);
check('running workers remain eligible for progress checks',
  heartbeat.shouldTrackWorkerProgress('working', 'running'), true);
check('terminal read parser joins the rendered screen tail', heartbeat.parseTerminalScreen({
  ok: true, result: { terminal: { tail: ['line one', 'line two'] } },
}), 'line one\nline two');
check('failed rendered read reuses the last good screen',
  heartbeat.resolveTerminalScreen(null, codexScreenA, garbledWaitA), codexScreenA);
check('first failed rendered read falls back to the list preview',
  heartbeat.resolveTerminalScreen(null, undefined, garbledWaitA), garbledWaitA);
check('rendered terminal reads request the full screen',
  heartbeat.terminalReadArgs('term_kimi'),
  ['terminal', 'read', '--terminal', 'term_kimi', '--screen', '--json']);

const kimiToolScreen172 = [
  '⠴ Coder Agent Running · K3 · low · 172 tools · Using Bash (35m 24s)',
  'context: 5% (47.4k/1M)',
].join('\n');
const kimiToolScreen173 = [
  '⠦ Coder Agent Running · K3 · low · 173 tools · Using Bash (35m 25s)',
  'context: 5% (47.5k/1M)',
].join('\n');
check('Kimi tool count survives while its context counter is ignored',
  [meaningfulTerminalOutput(kimiToolScreen172), meaningfulTerminalOutput(kimiToolScreen173)],
  ['tools:172', 'tools:173']);
check('Kimi toggling footer hints are ignored like context counters',
  [meaningfulTerminalOutput('| ! to run a shell command'),
    meaningfulTerminalOutput('| / to open commands'),
    meaningfulTerminalOutput('| shift+tab to cycle modes')], ['', '', '']);
check('Kimi footer hint toggles do not change the fingerprint',
  fingerprint(`${kimiToolScreen173}\n| ! to run a shell command`),
  fingerprint(`${kimiToolScreen173}\n| / to open commands`));
check('ordinary prose containing a tool count is preserved',
  meaningfulTerminalOutput('Reviewed output from 173 tools before summarizing.'),
  'Reviewed output from 173 tools before summarizing.');
check('only the delimited Kimi status shape collapses to a tool counter',
  meaningfulTerminalOutput('173 tools · Using Bash'), '173 tools · Using Bash');
check('Kimi context counters alone do not change the fingerprint',
  fingerprint('context: 5% (47.4k/1M)'), fingerprint('context: 5% (47.5k/1M)'));
const kimiToolRecords = new Map();
observeWorkerProgress(kimiToolRecords, {
  handle: 'term_kimi_tools', fingerprint: fingerprint(kimiToolScreen172),
  now: start, stallSeconds: 600,
});
check('increasing Kimi tool count after the threshold is progress, not a stall',
  observeWorkerProgress(kimiToolRecords, {
    handle: 'term_kimi_tools', fingerprint: fingerprint(kimiToolScreen173),
    now: start + 700_000, stallSeconds: 600,
  }), { stalled: false, changed: true, stalledSeconds: 0 });

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
  'Would you like to run the following command?',
  '$ git push origin main',
  '› 1. Yes, proceed (y)',
  '  2. No, and tell Codex what to do differently (esc)',
  'Press enter to confirm or esc to cancel',
].join('\n');
check('real Kimi permission menu is detected', typeof approvalPromptFingerprint(kimiApproval), 'string');
check('moving the selection does not create a new prompt episode',
  approvalPromptFingerprint(kimiApprovalMoved), approvalPromptFingerprint(kimiApproval));
check('real Codex command confirmation is detected', typeof approvalPromptFingerprint(codexApproval), 'string');
check('different Codex commands create different approval episodes',
  approvalPromptFingerprint(codexApproval) ===
    approvalPromptFingerprint(codexApproval.replace('$ git push origin main', '$ rm -rf build')), false);
check('real Codex edit confirmation is detected', typeof approvalPromptFingerprint(
  codexApproval.replace('run the following command', 'make the following edits')), 'string');
check('captured selection navigation is sufficient UI evidence',
  typeof approvalPromptFingerprint('↑↓ navigate · Enter select'), 'string');
check('Kimi navigation with Esc cancel is detected',
  typeof approvalPromptFingerprint('↑↓ navigate · Enter select · Esc cancel'), 'string');
const kimiApprovalWithNoiseA = `🌒 · Tip: /web: search\n⠦ Thinking…\n${kimiApproval}`;
const kimiApprovalWithNoiseB = `🌘 · Tip: /clear: reset\n⠏ Thinking…\n${kimiApprovalMoved}`;
check('approval signature ignores rotating tips, spinners, and selection movement',
  approvalPromptFingerprint(kimiApprovalWithNoiseA), approvalPromptFingerprint(kimiApprovalWithNoiseB));
check('approval signature includes only the prompt block, not ordinary surrounding output',
  approvalPromptFingerprint(`Updated hooks/x.cjs\n${codexApproval}`),
  approvalPromptFingerprint(`Running a different explanation\n${codexApproval}`));
for (const prose of [
  'Updated the parser for Allow/Deny/approve prompts.',
  'The Select permission mode test now passes.',
  'The fixture contains ↑↓ navigate · Enter select for coverage.',
  'Normal output can mention allow and deny without asking a question.',
  'Allow and Deny lists are merged. Is that ok?',
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
const oldRateLimitScreen = [
  '  └ HTTP/1.1 429 Too Many Requests',
  '• Working (45s • esc to interrupt)',
].join('\n');
const scopedSignalVerdict = heartbeat.classifyTerminal({
  handle: 'term_approval', preview: '• Working (45s • esc to interrupt)', lastOutputAt: start,
}, { ...approvalCtx, approvalText: oldRateLimitScreen });
check('old rate-limit scrollback does not override the live list preview', scopedSignalVerdict.kind, 'working');
check('a terminal with old rate-limit scrollback remains eligible for stall tracking',
  heartbeat.shouldTrackWorkerProgress(scopedSignalVerdict.kind, 'running'), true);
check('rendered approval UI is still detected when the list preview is working', heartbeat.classifyTerminal({
  handle: 'term_approval', preview: '• Working (45s • esc to interrupt)', lastOutputAt: start,
}, { ...approvalCtx, approvalText: kimiApproval }).kind, 'approval_waiting');

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

// --- Claude trust dialog + WORKER EXITED ---------------------------------------

const trustDialog = [
  ' Claude Code v2.0',
  '',
  ' Quick safety check: Claude Code wants to use the folder /repo/worktree-1.',
  ' Do you trust the files in this folder?',
  '',
  ' ❯ 1. Yes, proceed',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');
const trustConfigDialog = [
  ' ⚠ This folder pre-approves 109 tool permissions in .claude/settings.json.',
  ' Only proceed if you trust this configuration.',
  '',
  ' ❯ 1. Yes, proceed',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');
check('the trust-this-folder dialog is an approval prompt',
  typeof approvalPromptFingerprint(trustDialog), 'string');
check('the trust-this-configuration dialog is an approval prompt',
  typeof approvalPromptFingerprint(trustConfigDialog), 'string');
check('the Enter-to-confirm hint alone is an approval prompt',
  typeof approvalPromptFingerprint('Enter to confirm · Esc to cancel'), 'string');
check('prose quoting the trust wording without prompt chrome is inert',
  approvalPromptFingerprint('I answered the "Do you trust the files in this folder?" dialog for the worker.'), null);

const exitedScreen = [
  trustDialog,
  'macos@host worktree-1 % ',
].join('\n');
check('a shell prompt after the trust dialog classifies as exited, not approval',
  heartbeat.classifyTerminal({
    handle: 'term_approval', preview: exitedScreen, lastOutputAt: start,
  }, approvalCtx).kind, 'exited');
check('a plain zsh prompt classifies as exited for a tracked worker',
  heartbeat.classifyTerminal({
    handle: 'term_approval', preview: 'some last output\nmacos@host repo % ', lastOutputAt: start,
  }, approvalCtx).kind, 'exited');
check('a bare agent input caret is NOT a shell prompt',
  heartbeat.classifyTerminal({
    handle: 'term_approval', preview: '⏵⏵ accept edits on (shift+tab to cycle)\n❯ ', lastOutputAt: start,
  }, approvalCtx).kind, 'working');
check('an echoed command line is NOT a shell prompt',
  heartbeat.classifyTerminal({
    handle: 'term_approval', preview: '$ npm test\nTests passed', lastOutputAt: start,
  }, approvalCtx).kind, 'working');
check('an exited verdict is never stall-tracked',
  heartbeat.shouldTrackWorkerProgress('exited', 'running'), false);

const exitedReports = new Map();
check('the first exit episode emits the WORKER EXITED event', heartbeat.reportWorkerExited({
  reported: exitedReports, handle: 'term_approval', lastOutputAt: start,
  identity: 'ctx_exited', agent: 'claude',
}), 'WORKER EXITED ctx_exited (claude process gone, terminal at shell prompt) - read the terminal for the cause (e.g. Claude Code\'s trust dialog defaulting to exit in an untrusted worktree), then re-dispatch: Kimi/Codex, or headless `claude -p` launched via worker-start');
check('the exit report is persisted for daemon restart',
  heartbeat.loadPersistedExitedReports().get('term_approval'), start);
check('the same exit episode is not re-reported', heartbeat.reportWorkerExited({
  reported: heartbeat.loadPersistedExitedReports(), handle: 'term_approval', lastOutputAt: start,
  identity: 'ctx_exited', agent: 'claude',
}), null);
check('fresh output after the report re-arms the episode',
  typeof heartbeat.reportWorkerExited({
    reported: heartbeat.loadPersistedExitedReports(), handle: 'term_approval', lastOutputAt: start + 5000,
    identity: 'ctx_exited', agent: 'claude',
  }) === 'string', true);

// Live quota handover is symmetric, cached-probe friendly, and persisted per episode.
let codexProbeCalls = 0;
let kimiProbeCalls = 0;
const stubQuotas = heartbeat.probeLiveCoderQuotas(new Set(['kimi']), start, {
  codexQuota: () => { codexProbeCalls += 1; return { usedPercent: 20 }; },
  kimiQuota: () => { kimiProbeCalls += 1; return { usedPercent: 91, source: 'stub' }; },
});
check('quota probing only calls coders with live supervised workers',
  [codexProbeCalls, kimiProbeCalls, stubQuotas.codex, stubQuotas.kimi.usedPercent],
  [0, 1, null, 91]);
check('failed stub quota probes stay unknown', heartbeat.probeLiveCoderQuotas(new Set(['codex']), start, {
  codexQuota: () => ({ failed: true }),
}).codex, null);
check('destination selection can read both quota caches without live probes',
  heartbeat.cachedCoderQuotas(start, {
    readCodexCache: () => ({ usedPercent: 30, source: 'cache' }),
    readKimiCache: () => ({ usedPercent: 97, source: 'cache' }),
  }), {
    codex: { usedPercent: 30, source: 'cache' },
    kimi: { usedPercent: 97, source: 'cache' },
  });

const bothEligiblePool = {
  order: ['codex', 'kimi'],
  coders: { codex: { state: 'eligible' }, kimi: { state: 'eligible' } },
};
check('Kimi handover selects Codex while excluding Kimi',
  handover.pickNextCoder('kimi', bothEligiblePool), 'codex');
check('Codex handover selects Kimi while excluding Codex',
  handover.pickNextCoder('codex', bothEligiblePool), 'kimi');
check('Kimi handover falls back to Sonnet when Codex is unavailable', handover.pickNextCoder('kimi', {
  order: [], coders: { codex: { state: 'exhausted' }, kimi: { state: 'eligible' } },
}), 'sonnet');
check('Codex handover falls back to Sonnet when Kimi is unavailable', handover.pickNextCoder('codex', {
  order: [], coders: { codex: { state: 'eligible' }, kimi: { state: 'unusable' } },
}), 'sonnet');
const cachedExhaustionPool = heartbeat.buildHandoverPool({
  codex: { usedPercent: 30 }, kimi: { usedPercent: 97 },
}, start, {
  codexAuthState: () => 'ok',
  availability: {
    codex: { usable: true }, kimi: { usable: true },
  },
  readCoderExhaustion: () => ({}),
});
check('a cached exhausted alternative is excluded from the handover target',
  handover.pickNextCoder('codex', cachedExhaustionPool), 'sonnet');
const unavailableCodexPool = heartbeat.buildHandoverPool({ codex: null, kimi: { usedPercent: 95 } }, start, {
  codexAuthState: () => 'unknown',
  availability: {
    codex: { usable: false, reason: 'not installed' }, kimi: { usable: true },
  },
  readCoderExhaustion: () => ({}),
});
check('handover never uses legacy routing semantics to select an unavailable Codex',
  handover.pickNextCoder('kimi', unavailableCodexPool), 'sonnet');

const handoverRecords = new Map();
check('below the warning margin emits no handover event', handover.observe(handoverRecords, {
  handle: 'term_kimi_quota', identity: 'ctx_kimi_quota', agent: 'kimi', usedPercent: 89,
  threshold: 95, warnMargin: 5, exhausted: false, target: 'codex', now: start,
}).event, null);
const warningEvent = handover.observe(handoverRecords, {
  handle: 'term_kimi_quota', identity: 'ctx_kimi_quota', agent: 'kimi', usedPercent: 90,
  threshold: 95, warnMargin: 5, exhausted: false, target: 'codex', now: start + 1,
}).event;
check('crossing the warning margin emits a warning once',
  /^WORKER HANDOVER WARNING ctx_kimi_quota \(kimi 90% >= 90% warning; handover at 95%\)/.test(warningEvent), true);
check('the same warning episode does not emit twice', handover.observe(handoverRecords, {
  handle: 'term_kimi_quota', identity: 'ctx_kimi_quota', agent: 'kimi', usedPercent: 91,
  threshold: 95, warnMargin: 5, exhausted: false, target: 'codex', now: start + 2,
}).event, null);
check('a destination change updates the same episode without another wake event', handover.observe(handoverRecords, {
  handle: 'term_kimi_quota', identity: 'ctx_kimi_quota', agent: 'kimi', usedPercent: 92,
  threshold: 95, warnMargin: 5, exhausted: false, target: 'sonnet', now: start + 2,
}).event, null);
const kimiHandoverEvent = handover.observe(handoverRecords, {
  handle: 'term_kimi_quota', identity: 'ctx_kimi_quota', agent: 'kimi', usedPercent: 95,
  threshold: 95, warnMargin: 5, exhausted: false, target: 'codex',
  worktreePath: '/work/kimi-task', now: start + 3,
}).event;
check('Kimi threshold crossing hands over to Codex with the required recipe',
  /^WORKER HANDOVER ctx_kimi_quota \(kimi 95% >= 95%\) -> hand over to Codex\./.test(kimiHandoverEvent) &&
    kimiHandoverEvent.includes('HANDOVER.md') && kimiHandoverEvent.includes('SAME worktree/branch'), true);
handover.saveRecords(stateDir, 'worker-stall-test', handoverRecords);
const handoverAfterRestart = handover.loadRecords(stateDir, 'worker-stall-test');
check('handover episode persists across heartbeat restart', handover.observe(handoverAfterRestart, {
  handle: 'term_kimi_quota', identity: 'ctx_kimi_quota', agent: 'kimi', usedPercent: 96,
  threshold: 95, warnMargin: 5, exhausted: false, target: 'codex',
  worktreePath: '/work/kimi-task', now: start + 4,
}).event, null);
check('gate reminder lists persisted workers needing handover',
  handover.reminder(stateDir, 'worker-stall-test').includes('ctx_kimi_quota (kimi 95%, handover -> Codex)'), true);
check('gate drops a saved handover record after its worker is gone',
  handover.reminder(stateDir, 'worker-stall-test', new Set()), '');
check('stale handover removal is persisted without a heartbeat',
  handover.loadRecords(stateDir, 'worker-stall-test').size, 0);

const codexHandoverEvent = handover.observe(new Map(), {
  handle: 'term_codex_quota', identity: 'ctx_codex_quota', agent: 'codex', usedPercent: 97,
  threshold: 95, warnMargin: 5, exhausted: false, target: 'kimi', now: start,
}).event;
check('Codex threshold crossing symmetrically hands over to Kimi',
  /^WORKER HANDOVER ctx_codex_quota \(codex 97% >= 95%\) -> hand over to Kimi\./.test(codexHandoverEvent), true);

const kimiExhaustedCtx = { ...approvalCtx, handleAgent: new Map([['term_approval', 'kimi']]) };
const kimiExhaustedVerdict = heartbeat.classifyTerminal({
  handle: 'term_approval', preview: '■ 403 You\'ve reached your usage limit for this billing cycle', lastOutputAt: start,
}, kimiExhaustedCtx);
check('Kimi 403 billing-cycle output is a handover exhaustion trigger',
  [kimiExhaustedVerdict.kind, kimiExhaustedVerdict.coder], ['usage_exhausted', 'kimi']);
check('Kimi exhaustion names the usage-limit signal instead of inventing a percentage',
  /^WORKER HANDOVER ctx_kimi_403 \(kimi usage-limit signal\)/.test(handover.observe(new Map(), {
    handle: 'term_kimi_403', identity: 'ctx_kimi_403', agent: 'kimi', usedPercent: undefined,
    threshold: 95, warnMargin: 5, exhausted: true, target: 'codex', now: start,
  }).event), true);
check('a signal-triggered handover ignores a contradictory low live percentage in its text',
  /^WORKER HANDOVER ctx_kimi_low \(kimi usage-limit signal\)/.test(handover.observe(new Map(), {
    handle: 'term_kimi_low', identity: 'ctx_kimi_low', agent: 'kimi', usedPercent: 40,
    threshold: 95, warnMargin: 5, exhausted: true, target: 'codex', now: start,
  }).event), true);
const aliasedSignalRecords = new Map();
handover.observe(aliasedSignalRecords, {
  handle: 'term_alias', identity: 'ctx_alias', aliases: ['task_alias'],
  agent: 'kimi', usedPercent: 40, threshold: 95, warnMargin: 5,
  exhausted: true, target: 'codex', now: start,
});
handover.saveRecords(stateDir, 'aliased-handover', aliasedSignalRecords);
check('usage-limit gate reminder never shows the contradictory live percentage',
  handover.reminder(stateDir, 'aliased-handover', new Set(['task_alias']))
    .includes('ctx_alias (kimi usage-limit signal, handover -> Codex)'), true);
check('a live task alias preserves the persisted terminal/dispatch handover record',
  handover.loadRecords(stateDir, 'aliased-handover').size, 1);
check('the same aliased record is dropped once no worker alias remains live',
  handover.reminder(stateDir, 'aliased-handover', new Set()), '');

const usageReport = heartbeat.reportUsageExhausted({
  reported: new Map(), handle: 'term_usage_recipe', label: 'term_usage_recipe', coder: 'kimi',
});
check('usage-limit report points to committing WIP and HANDOVER.md before release',
  usageReport.includes('follow the WORKER HANDOVER recipe') &&
    usageReport.includes('commit WIP and HANDOVER.md before stopping/releasing'), true);

const repeatedSignalHandover = handover.observe(new Map(), {
  handle: 'term_rate_loop', identity: 'ctx_rate_loop', agent: 'codex', usedPercent: 96,
  threshold: 95, warnMargin: 5, exhausted: false, target: 'kimi', now: start,
}).event;
check('handover remains evaluable for an already-reported terminal signal',
  /^WORKER HANDOVER ctx_rate_loop \(codex 96% >= 95%\)/.test(repeatedSignalHandover), true);

const codexUsageLine = '■ You\'ve hit your usage limit. Try again later.';
check('Codex usage-limit output is distinguished from a transient generic 429',
  [hasCodexUsageExhausted(codexUsageLine), hasCodexUsageExhausted('HTTP/1.1 429 Too Many Requests')],
  [true, false]);
for (const diagnostic of [
  'error: Codex usage limit parser failed',
  '⚠ Codex usage limit request timed out',
]) {
  check(`Codex diagnostic prose is not exhaustion: ${diagnostic}`,
    hasCodexUsageExhausted(diagnostic), false);
}
const codexExhaustedVerdict = heartbeat.classifyTerminal({
  handle: 'term_approval', preview: codexUsageLine, lastOutputAt: start,
}, { ...approvalCtx, handleAgent: new Map([['term_approval', 'codex']]) });
check('Codex usage-limit output symmetrically triggers handover',
  [codexExhaustedVerdict.kind, codexExhaustedVerdict.coder], ['usage_exhausted', 'codex']);

// Exhausted workers with no available handover destination are parked and resumed by a
// detached, per-terminal scheduler. Every clock, probe, and terminal action is stubbed.
const resetNow = new Date(2026, 9, 1, 12, 0, 0, 0).getTime();
check('Codex reset seconds convert to epoch milliseconds',
  resume.quotaResetAt({ resetsAt: (resetNow + 3_600_000) / 1000 }), resetNow + 3_600_000);
check('Kimi resetTime-derived seconds use the same reset conversion',
  resume.quotaResetAt({ resetsAt: (resetNow + 7_200_000) / 1000 }), resetNow + 7_200_000);
check('Claude local 5pm reset text is parsed',
  resume.parseClaudeResetAt('Limit reached — resets 5pm', resetNow),
  new Date(2026, 9, 1, 17, 0, 0, 0).getTime());
check('Claude 24-hour reset text is parsed',
  resume.parseClaudeResetAt('Usage limit reached, resets at 17:00', resetNow),
  new Date(2026, 9, 1, 17, 0, 0, 0).getTime());
check('Claude relative reset text is parsed',
  resume.parseClaudeResetAt('You hit your limit; try again in 2h 15m', resetNow),
  resetNow + 2 * 3_600_000 + 15 * 60_000);
check('Claude month/day reset honors an explicit IANA timezone',
  resume.parseClaudeResetAt('■ Usage limit reached · resets Oct 3, 5pm (Asia/Saigon)', resetNow),
  Date.parse('2026-10-03T10:00:00.000Z'));
check('Claude reset accepts the slashless UTC timezone identifier',
  resume.parseClaudeResetAt('■ Usage limit reached · resets 5pm (UTC)', resetNow),
  Date.parse('2026-10-01T17:00:00.000Z'));
check('ordinary reset discussion is not a Claude limit screen',
  resume.hasClaudeLimitMessage('Updated reset parsing tests for 5pm.'), false);
check('prose quoting limit and reset wording is not a Claude limit screen',
  resume.hasClaudeLimitMessage('The panel reports limit reached and resets 5pm in this test.'), false);
check('an unmarked exact quote is not treated as panel limit UI',
  resume.hasClaudeLimitMessage('Usage limit reached · resets at 17:00'), false);
check('captured Claude limit banner is detected',
  resume.hasClaudeLimitMessage('■ Usage limit reached · resets at 17:00'), true);
check('a newer prompt makes an older Claude limit line historical',
  resume.claudeLimitInfo('■ Usage limit reached · resets at 17:00\n❯ Ready for your next task', resetNow).limited,
  false);
check('an exhausted worker parks only when no handover target exists', [
  resume.shouldPark({ limited: true, handoverTarget: null }),
  resume.shouldPark({ limited: true, handoverTarget: 'codex' }),
  resume.shouldPark({ limited: false, handoverTarget: null }),
], [true, false, false]);
check('a missing or limited panel removes the Sonnet fallback', [
  resume.availableHandoverTarget('sonnet', false),
  resume.availableHandoverTarget('sonnet', true),
  resume.availableHandoverTarget('codex', false),
], [null, 'sonnet', 'codex']);

let schedulerSpawns = 0;
const parkedResetAt = resetNow + 3_600_000;
const firstPark = resume.park({
  stateDir, session: 'park-test', handle: 'term_park', identity: 'ctx_park', agent: 'kimi',
  resetAt: parkedResetAt, threshold: 95, authorizedHandles: new Set(['term_park']), now: resetNow,
  spawnScheduler: () => { schedulerSpawns += 1; return 4321; }, pidAlive: () => false,
});
check('first park emits and persists scheduler pid/reset time', [
  /^WORKER PARKED ctx_park \(kimi limit, resets .+\) - will auto-resume$/.test(firstPark.event),
  firstPark.scheduled, resume.readJob(firstPark.file).pid, resume.readJob(firstPark.file).resetAt,
], [true, true, 4321, parkedResetAt]);
check('new park episodes persist bounded-attempt counters', [
  resume.readJob(firstPark.file).attempts,
  resume.readJob(firstPark.file).firstAttemptAt,
], [0, 0]);
const duplicatePark = resume.park({
  stateDir, session: 'park-test', handle: 'term_park', identity: 'ctx_park', agent: 'kimi',
  resetAt: parkedResetAt, threshold: 95, authorizedHandles: new Set(['term_park']), now: resetNow + 1,
  spawnScheduler: () => { schedulerSpawns += 1; return 9876; }, pidAlive: (pid) => pid === 4321,
});
check('park scheduler is deduped once per persisted episode',
  [duplicatePark.event, duplicatePark.scheduled, schedulerSpawns], [null, true, 1]);
const firstParkToken = resume.readJob(firstPark.file).token;
check('scheduler ownership rejects a replaced or cleared park episode', [
  resume.withOwnedJob(firstPark.file, 'stale-token', 4321, () => true).owned,
  resume.withOwnedJob(firstPark.file, firstParkToken, 4321, () => true).owned,
], [false, true]);
const completedParkJob = resume.readJob(firstPark.file);
completedParkJob.status = 'resumed';
completedParkJob.pid = 0;
completedParkJob.resumedAt = resetNow + 2;
resume.writeJob(firstPark.file, completedParkJob);
check('a successfully resumed terminal can park for a second limit episode', typeof resume.park({
  stateDir, session: 'park-test', handle: 'term_park', identity: 'ctx_park', agent: 'kimi',
  resetAt: 0, threshold: 95, authorizedHandles: new Set(['term_park']), now: resetNow + 2,
  spawnScheduler: () => { schedulerSpawns += 1; return 2222; }, pidAlive: () => false,
}).event, 'string');
resume.clearJob(stateDir, 'park-test', 'term_park');
const panelFirstPark = resume.park({
  stateDir, session: 'panel-repeat', handle: 'term_panel_repeat', identity: 'term_panel_repeat',
  agent: 'claude', panel: true, panelHandle: 'term_panel_repeat', resetAt: 0, now: resetNow,
  spawnScheduler: () => 5555, pidAlive: () => false,
});
const panelFirstJob = resume.readJob(panelFirstPark.file);
panelFirstJob.status = 'resumed';
panelFirstJob.pid = 0;
panelFirstJob.resumedAt = resetNow + 1;
resume.writeJob(panelFirstPark.file, panelFirstJob);
check('a panel can be parked again after a second unknown-reset limit', typeof resume.park({
  stateDir, session: 'panel-repeat', handle: 'term_panel_repeat', identity: 'term_panel_repeat',
  agent: 'claude', panel: true, panelHandle: 'term_panel_repeat', resetAt: 0, now: resetNow + 2,
  spawnScheduler: () => 6666, pidAlive: () => false,
}).event, 'string');
resume.clearJob(stateDir, 'panel-repeat', 'term_panel_repeat');
const slidingLine = '■ Usage limit reached · try again in 2h';
const slidingFirst = resume.park({
  stateDir, session: 'panel-sliding', handle: 'term_panel_sliding', identity: 'term_panel_sliding',
  agent: 'claude', panel: true, panelHandle: 'term_panel_sliding', limitLine: slidingLine,
  resetAt: resetNow + 2 * 3_600_000, now: resetNow, spawnScheduler: () => 7777, pidAlive: () => false,
});
resume.park({
  stateDir, session: 'panel-sliding', handle: 'term_panel_sliding', identity: 'term_panel_sliding',
  agent: 'claude', panel: true, panelHandle: 'term_panel_sliding', limitLine: slidingLine,
  resetAt: resetNow + 2 * 3_600_000 + 60_000, now: resetNow + 60_000,
  spawnScheduler: () => 8888, pidAlive: (pid) => pid === 7777,
});
check('the same visible Claude limit line cannot slide its persisted reset forward',
  resume.readJob(slidingFirst.file).resetAt, resetNow + 2 * 3_600_000);
resume.clearJob(stateDir, 'panel-sliding', 'term_panel_sliding');
check('clearing a park invalidates the scheduler ownership token',
  resume.withOwnedJob(firstPark.file, firstParkToken, 4321, () => true).owned, false);
check('clearing a recovered episode re-arms a later park', typeof resume.park({
  stateDir, session: 'park-test', handle: 'term_park', identity: 'ctx_park', agent: 'kimi',
  resetAt: parkedResetAt + 5000, threshold: 95, authorizedHandles: new Set(['term_park']), now: resetNow + 3,
  spawnScheduler: () => { schedulerSpawns += 1; return 3333; }, pidAlive: () => false,
}).event, 'string');
const pendingFile = resume.jobFile(stateDir, 'pending-test', 'term_pending');
resume.writeJob(pendingFile, {
  version: 1, session: 'pending-test', handle: 'term_pending', identity: 'ctx_pending',
  agent: 'codex', status: 'scheduled', token: 'pending', pid: 11, parkedAt: resetNow,
});
check('a quota recovery does not clear a scheduler-owned pending job', [
  resume.clearSettledJob(stateDir, 'pending-test', 'term_pending'),
  resume.readJob(pendingFile).status,
], [false, 'scheduled']);
check('a worker leaving the supervised set clears its pending job', [
  resume.clearMissingPendingJobs(stateDir, 'pending-test', new Set()),
  resume.readJob(pendingFile),
], [1, null]);
const uncertainFile = resume.jobFile(stateDir, 'uncertain-worker-list', 'term_uncertain');
resume.writeJob(uncertainFile, {
  version: 1, session: 'uncertain-worker-list', handle: 'term_uncertain', identity: 'ctx_uncertain',
  agent: 'codex', status: 'scheduled', token: 'uncertain', pid: 12, parkedAt: resetNow,
});
check('one failed worker-list tick leaves a parked job intact', [
  heartbeat.clearMissingPendingJobsForTick(null, stateDir, 'uncertain-worker-list', new Set()),
  resume.readJob(uncertainFile).status,
], [0, 'scheduled']);
check('an explicit worker-list ok:false reply remains unknown rather than empty',
  heartbeat.parseWorkerRows({ ok: false, error: 'timeout' }), null);
check('an authoritative empty worker-list tick may clear the missing parked job', [
  heartbeat.clearMissingPendingJobsForTick([], stateDir, 'uncertain-worker-list', new Set()),
  resume.readJob(uncertainFile),
], [1, null]);
check('foreign terminals are never parked or scheduled', resume.park({
  stateDir, session: 'park-test', handle: 'term_foreign', identity: 'ctx_foreign', agent: 'codex',
  authorizedHandles: new Set(), now: resetNow,
  spawnScheduler: () => { schedulerSpawns += 1; return 1111; },
}).reason, 'foreign-terminal');
check('Claude workers use the same authorized park path as external coders',
  typeof resume.park({
    stateDir, session: 'claude-worker', handle: 'term_claude', identity: 'ctx_claude', agent: 'claude',
    resetAt: parkedResetAt, authorizedHandles: new Set(['term_claude']), now: resetNow,
    spawnScheduler: () => 4444, pidAlive: () => false,
  }).event, 'string');
check('resume authorization excludes unsupervised, released, finished, and panel rows',
  [...resumeScheduler.authorizedWorkerHandles([
    { agentTerminalHandle: 'term_live', workerState: 'running', terminalState: 'active' },
    { agentTerminalHandle: 'term_unsupervised', workerState: 'unsupervised', terminalState: 'active' },
    { agentTerminalHandle: 'term_released', workerState: 'running', terminalState: 'released' },
    { agentTerminalHandle: 'term_done', workerState: 'succeeded', terminalState: 'active' },
    { agentTerminalHandle: 'term_dispatch_done', workerState: 'running', dispatchStatus: 'completed', terminalState: 'active' },
    { agentTerminalHandle: 'term_panel', workerState: 'running', terminalState: 'active' },
  ], 'term_panel')], ['term_live']);

check('attempt accounting persists a first-attempt time and increments', [
  resume.beginAttempt({ attempts: 0, firstAttemptAt: 0 }, resetNow),
  resume.beginAttempt({ attempts: 1, firstAttemptAt: resetNow }, resetNow + 1000),
], [
  { expired: false, attempts: 1, firstAttemptAt: resetNow },
  { expired: false, attempts: 2, firstAttemptAt: resetNow },
]);
check('attempt accounting expires by count and by eight-day lifetime', [
  resume.beginAttempt({ attempts: resume.MAX_ATTEMPTS, firstAttemptAt: resetNow }, resetNow).expired,
  resume.beginAttempt({ attempts: 2, firstAttemptAt: resetNow }, resetNow + resume.MAX_LIFETIME_MS).expired,
], [true, true]);
const crashSafeDelivery = resume.recordDelivery({ status: 'scheduled', pid: 99 },
  resume.WORKER_RESUME_MESSAGE, resetNow);
check('a pre-send marker recovered after scheduler death becomes report-only', [
  resume.recoverDeliveredJob(crashSafeDelivery, resetNow + 1),
  crashSafeDelivery.status, crashSafeDelivery.pid,
], [true, 'resumed-unverified', 0]);
const appliedUnverified = resume.applyAttemptResult({ status: 'scheduled', pid: 99 }, {
  resumed: false, reason: 'resumed-unverified', delivered: true,
}, resetNow);
check('a delivered unverified result settles without another scheduled attempt', [
  appliedUnverified.job.status, appliedUnverified.job.pid, appliedUnverified.retry,
], ['resumed-unverified', 0, false]);
const appliedRelimit = resume.applyAttemptResult({ status: 'scheduled', pid: 99 }, {
  resumed: false, reason: 'quota-unavailable', delivered: true, reparked: true,
  resetAt: resetNow + 5_000,
}, resetNow);
check('a new post-send limit response is re-parked at its new reset', [
  appliedRelimit.job.status, appliedRelimit.job.resetAt,
  appliedRelimit.job.nextAttemptAt, appliedRelimit.retry,
], ['scheduled', resetNow + 5_000, resetNow + 5_000 + resume.RESET_GRACE_MS, true]);

const resumeJob = {
  handle: 'term_resume', identity: 'ctx_resume', agent: 'codex', panel: false,
  status: 'scheduled', parkedAt: resetNow, resetAt: resetNow + 1000, threshold: 95,
};
let sentMessages = [];
check('scheduler sends nothing before reset plus grace', resume.attemptResume(resumeJob, {
  now: resetNow + 1000 + resume.RESET_GRACE_MS - 1,
  isAuthorized: () => true, probeQuota: () => ({ usedPercent: 0 }),
  send: (...args) => { sentMessages.push(args); return true; },
}).reason, 'before-reset');
check('nothing was typed before reset', sentMessages.length, 0);
check('scheduler sends nothing while quota is still unavailable', resume.attemptResume(resumeJob, {
  now: resetNow + 1000 + resume.RESET_GRACE_MS,
  isAuthorized: () => true, probeQuota: () => ({ usedPercent: 97, resetsAt: (resetNow + 999999) / 1000 }),
  send: (...args) => { sentMessages.push(args); return true; },
}).reason, 'quota-unavailable');
check('scheduler sends nothing to a now-foreign terminal', resume.attemptResume(resumeJob, {
  now: resetNow + 1000 + resume.RESET_GRACE_MS,
  isAuthorized: () => false, probeQuota: () => ({ usedPercent: 0 }),
  send: (...args) => { sentMessages.push(args); return true; },
}).reason, 'foreign-terminal');
check('scheduler treats an unavailable authorization probe as retryable uncertainty', resume.attemptResume(resumeJob, {
  now: resetNow + 1000 + resume.RESET_GRACE_MS,
  isAuthorized: () => null, probeQuota: () => ({ usedPercent: 0 }),
  send: (...args) => { sentMessages.push(args); return true; },
}).reason, 'authorization-unknown');
check('no unavailable or foreign attempt typed into a terminal', sentMessages.length, 0);
const resumed = resume.attemptResume(resumeJob, {
  now: resetNow + 1000 + resume.RESET_GRACE_MS,
  isAuthorized: () => true, probeQuota: () => ({ usedPercent: 2 }),
  readScreen: () => 'Ready',
  send: (...args) => { sentMessages.push(args); return true; },
  verifyStarted: () => true,
});
check('available quota resumes the worker with the exact continuation guard',
  [resumed.resumed, sentMessages.at(-1)[1]], [true, resume.WORKER_RESUME_MESSAGE]);
const unverifiedSends = [];
const unverified = resume.attemptResume(resumeJob, {
  now: resetNow + 1000 + resume.RESET_GRACE_MS,
  isAuthorized: () => true, probeQuota: () => ({ usedPercent: 2 }), readScreen: () => 'Ready',
  send: (...args) => { unverifiedSends.push(args); return true; }, verifyStarted: () => false,
});
check('a delivered resume with no confirmed turn becomes terminal and is never a retry result',
  [unverified.reason, unverified.delivered, unverifiedSends.length],
  ['resumed-unverified', true, 1]);

const kimiSends = [];
const kimiScreens = [
  'Permission mode: Ask When Needed',
  'Permission mode: Ask When Needed',
  '❯ 1. Ask When Needed\n  2. Never Ask',
  '❯ 1. Ask When Needed\n  2. Never Ask',
  'Permission mode: Never Ask',
];
check('Kimi resume re-asserts Never Ask before continuing when needed', resume.attemptResume({
  ...resumeJob, handle: 'term_kimi_resume', agent: 'kimi', threshold: 95,
}, {
  now: resetNow + 1000 + resume.RESET_GRACE_MS,
  isAuthorized: () => true, probeQuota: () => ({ usedPercent: 1 }),
  readScreen: () => kimiScreens.shift() || 'Permission mode: Never Ask',
  send: (...args) => { kimiSends.push(args); return true; }, verifyStarted: () => true, wait: () => {},
}).resumed, true);
check('Kimi permission sequence precedes its resume message',
  kimiSends.map((entry) => entry[1]), ['/auto', '\u001b[B', resume.WORKER_RESUME_MESSAGE]);
check('Kimi option parser moves once in a two-option Ask-to-Never-Ask menu',
  resume.kimiPermissionMoves('❯ 1. Ask When Needed\n  2. Never Ask'), 1);
const failedPermissionSends = [];
check('Kimi never resumes when Never Ask cannot be verified', resume.attemptResume({
  ...resumeJob, handle: 'term_kimi_unverified', agent: 'kimi', threshold: 95,
}, {
  now: resetNow + 1000 + resume.RESET_GRACE_MS,
  isAuthorized: () => true, probeQuota: () => ({ usedPercent: 1 }),
  readScreen: () => 'Permission mode: Ask When Needed',
  send: (...args) => { failedPermissionSends.push(args); return true; }, verifyStarted: () => true,
  wait: () => {},
}).reason, 'permission-unverified');
check('unverified permission mode never receives the resume message',
  failedPermissionSends.some((entry) => entry[1] === resume.WORKER_RESUME_MESSAGE), false);
check('a delivered Kimi permission interaction is marked delivered instead of blindly retried',
  resume.attemptResume({
    ...resumeJob, handle: 'term_kimi_unverified_2', agent: 'kimi', threshold: 95,
  }, {
    now: resetNow + 1000 + resume.RESET_GRACE_MS,
    isAuthorized: () => true, probeQuota: () => ({ usedPercent: 1 }),
    readScreen: () => 'Permission mode: Ask When Needed', send: () => true,
    verifyStarted: () => true, wait: () => {},
  }).delivered, true);

const kimiIdleMenuDefault = [
  'This session has been idle for 2h 2m and is ~200k tokens.',
  '❯ Compact and continue',
  '  Start a new session',
  '  Continue as-is',
  "  Don't ask me again",
  '↑↓ navigate · Enter select',
].join('\n');
const kimiIdleMenuWithHistory = `• Working (4000s • esc to interrupt)\n${kimiIdleMenuDefault}`;
check('visible Kimi idle menu overrides historical active-turn text in the viewport',
  resume.turnStarted(kimiIdleMenuWithHistory, 'Ready'), false);
const kimiIdleDefaultSends = [];
let kimiIdleDefaultVerify = 0;
check('Kimi idle-session prompt selects the captured default Compact and continue option',
  resume.attemptResume({
    ...resumeJob, handle: 'term_kimi_idle_default', agent: 'kimi', threshold: 95,
  }, {
    now: resetNow + 1000 + resume.RESET_GRACE_MS,
    isAuthorized: () => true, probeQuota: () => ({ usedPercent: 1 }), readScreen: () => 'Ready',
    send: (...args) => { kimiIdleDefaultSends.push(args); return true; },
    verifyStarted: () => ++kimiIdleDefaultVerify === 1
      ? { started: false, screen: kimiIdleMenuDefault }
      : { started: true, screen: 'Compacting conversation context…' },
  }).resumed, true);
check('default idle-session cursor needs only one Enter after the resume message',
  kimiIdleDefaultSends.map((entry) => [entry[1], entry[2]]), [
    [resume.WORKER_RESUME_MESSAGE, true], ['', true],
  ]);
const kimiHistoricalSends = [];
let kimiHistoricalVerify = 0;
check('historical Working text cannot bypass idle-menu selection', resume.attemptResume({
  ...resumeJob, handle: 'term_kimi_idle_history', agent: 'kimi', threshold: 95,
}, {
  now: resetNow + 1000 + resume.RESET_GRACE_MS,
  isAuthorized: () => true, probeQuota: () => ({ usedPercent: 1 }), readScreen: () => 'Ready',
  send: (...args) => { kimiHistoricalSends.push(args); return true; },
  verifyStarted: () => ++kimiHistoricalVerify === 1
    ? { started: resume.turnStarted(kimiIdleMenuWithHistory, 'Ready'), screen: kimiIdleMenuWithHistory }
    : { started: true, screen: 'Compacting conversation context…' },
}).resumed, true);
check('historical Working text still leads to one Compact selection Enter',
  kimiHistoricalSends.map((entry) => [entry[1], entry[2]]), [
    [resume.WORKER_RESUME_MESSAGE, true], ['', true],
  ]);
const kimiIdleMenuMoved = kimiIdleMenuDefault
  .replace('❯ Compact and continue', '  Compact and continue')
  .replace('  Continue as-is', '❯ Continue as-is');
const kimiIdleMenuTarget = kimiIdleMenuDefault;
const kimiIdleMovedSends = [];
let kimiIdleMovedVerify = 0;
check('Kimi idle-session prompt moves to Compact and continue and verifies the cursor before Enter',
  resume.attemptResume({
    ...resumeJob, handle: 'term_kimi_idle_moved', agent: 'kimi', threshold: 95,
  }, {
    now: resetNow + 1000 + resume.RESET_GRACE_MS,
    isAuthorized: () => true, probeQuota: () => ({ usedPercent: 1 }),
    readScreen: () => kimiIdleMenuTarget, wait: () => {},
    send: (...args) => { kimiIdleMovedSends.push(args); return true; },
    verifyStarted: () => ++kimiIdleMovedVerify === 1
      ? { started: false, screen: kimiIdleMenuMoved }
      : { started: true, screen: '• Working (1s • esc to interrupt)' },
  }).resumed, true);
check('moved idle-session cursor sends two Downs without Enter, then one Enter',
  kimiIdleMovedSends.map((entry) => [entry[1], entry[2]]), [
    [resume.WORKER_RESUME_MESSAGE, true], ['\u001b[B\u001b[B', false], ['', true],
  ]);
const kimiIdleUnverifiedSends = [];
check('Kimi idle-session prompt never presses Enter when the moved cursor cannot be verified',
  resume.attemptResume({
    ...resumeJob, handle: 'term_kimi_idle_unverified', agent: 'kimi', threshold: 95,
  }, {
    now: resetNow + 1000 + resume.RESET_GRACE_MS,
    isAuthorized: () => true, probeQuota: () => ({ usedPercent: 1 }),
    readScreen: () => kimiIdleMenuMoved, wait: () => {},
    send: (...args) => { kimiIdleUnverifiedSends.push(args); return true; },
    verifyStarted: () => ({ started: false, screen: kimiIdleMenuMoved }),
  }).reason, 'idle-menu-unverified');
check('unverified idle-session cursor receives no selection Enter',
  kimiIdleUnverifiedSends.some((entry) => entry[1] === '' && entry[2] === true), false);
check('retained historical activity without new evidence cannot verify post-menu resumption',
  resume.turnStarted('• Working (4001s • esc to interrupt)',
    '• Working (4000s • esc to interrupt)\n' + kimiIdleMenuDefault), false);
check('spinner and timer repaint on historical activity is not new turn evidence',
  resume.turnStarted('⠋ Working (4001s • esc to interrupt)',
    '• Working (4000s • esc to interrupt)'), false);
check('captured Kimi spinner and inline Tip repaint is not new turn evidence',
  resume.turnStarted('⠏ Thinking… · Tip: /web searches the internet',
    '⠦ Thinking… · Tip: /clear starts fresh'), false);
check('normal output merely mentioning idle compaction words is not treated as the menu',
  resume.hasKimiIdleSessionMenu('The session has been idle for a while; compact later.'), false);

const panelSends = [];
check('panel self-resume uses its orchestration-specific message', resume.attemptResume({
  handle: 'term_panel', identity: 'term_panel', agent: 'claude', panel: true,
  panelHandle: 'term_panel', status: 'scheduled', parkedAt: resetNow,
  resetAt: resetNow + 1000, threshold: 100,
}, {
  now: resetNow + 1000 + resume.RESET_GRACE_MS,
  isAuthorized: () => true, probeQuota: () => ({ usedPercent: 0 }), readScreen: () => 'Ready',
  send: (...args) => { panelSends.push(args); return true; }, verifyStarted: () => true,
}).resumed, true);
check('panel resume message is distinct from worker resume',
  panelSends.at(-1)[1], resume.PANEL_RESUME_MESSAGE);
const staleClaudeSends = [];
check('known Claude reset resumes despite an unchanged stale banner', resume.attemptResume({
  handle: 'term_panel_stale', identity: 'term_panel_stale', agent: 'claude', panel: true,
  status: 'scheduled', parkedAt: resetNow, resetAt: resetNow + 1000, threshold: 100,
  limitLine: '■ Usage limit reached · resets at 12:00',
}, {
  now: resetNow + 1000 + resume.RESET_GRACE_MS,
  isAuthorized: () => true, probeQuota: () => ({ usedPercent: 0 }),
  readScreen: () => '■ Usage limit reached · resets at 12:00',
  send: (...args) => { staleClaudeSends.push(args); return true; }, verifyStarted: () => true,
}).resumed, true);
check('an unchanged post-reset Claude banner is not mistaken for a fresh rejection',
  resume.attemptResume({
    handle: 'term_panel_stale_unverified', identity: 'term_panel_stale_unverified',
    agent: 'claude', panel: true, status: 'scheduled', parkedAt: resetNow,
    resetAt: resetNow + 1000, threshold: 100,
    limitLine: '■ Usage limit reached · resets at 12:00',
  }, {
    now: resetNow + 1000 + resume.RESET_GRACE_MS,
    isAuthorized: () => true, probeQuota: () => ({ usedPercent: 0 }),
    readScreen: () => '■ Usage limit reached · resets at 12:00',
    send: () => true, verifyStarted: () => ({ started: false,
      screen: '■ Usage limit reached · resets at 12:00' }),
  }).reason, 'resumed-unverified');
const changedResetSends = [];
check('a newer visible Claude reset overrides an expired persisted reset and waits',
  resume.attemptResume({
    handle: 'term_panel_new_reset', identity: 'term_panel_new_reset', agent: 'claude', panel: true,
    status: 'scheduled', parkedAt: resetNow,
    resetAt: resetNow - resume.RESET_GRACE_MS - 1000,
    limitLine: '■ Usage limit reached · resets at 12:00',
  }, {
    now: resetNow, isAuthorized: () => true, probeQuota: () => ({ usedPercent: 0 }),
    readScreen: () => '■ Usage limit reached · resets Oct 3, 5pm (Asia/Saigon)',
    send: (...args) => { changedResetSends.push(args); return true; }, verifyStarted: () => true,
  }), {
    resumed: false, reason: 'quota-unavailable', resetAt: Date.parse('2026-10-03T10:00:00.000Z'),
    limitLine: '■ Usage limit reached · resets Oct 3, 5pm (Asia/Saigon)',
  });
check('a panel showing a changed future reset gets zero sends', changedResetSends.length, 0);
const unknownClaudeSends = [];
check('a still-limited panel with an unknown reset receives zero sends', resume.attemptResume({
  handle: 'term_panel_unknown', identity: 'term_panel_unknown', agent: 'claude', panel: true,
  status: 'scheduled', parkedAt: resetNow - resume.UNKNOWN_RETRY_MS, resetAt: 0, threshold: 100,
}, {
  now: resetNow, isAuthorized: () => true, probeQuota: () => ({ usedPercent: 0 }),
  readScreen: () => '■ You\'ve hit your usage limit · try again in 2h',
  send: (...args) => { unknownClaudeSends.push(args); return true; }, verifyStarted: () => false,
}), {
  resumed: false, reason: 'quota-unavailable', resetAt: resetNow + 2 * 3_600_000,
  limitLine: '■ You\'ve hit your usage limit · try again in 2h',
});
check('still-limited Claude pre-send check types nothing', unknownClaudeSends.length, 0);
const reparkingSends = [];
check('a fresh Claude limit response after delivery re-parks instead of becoming unverified',
  resume.attemptResume({
    handle: 'term_panel_relimit', identity: 'term_panel_relimit', agent: 'claude', panel: true,
    status: 'scheduled', parkedAt: resetNow, resetAt: resetNow - resume.RESET_GRACE_MS,
  }, {
    now: resetNow, isAuthorized: () => true, probeQuota: () => ({ usedPercent: 0 }),
    readScreen: () => 'Ready', send: (...args) => { reparkingSends.push(args); return true; },
    verifyStarted: () => ({ started: false,
      screen: '■ Usage limit reached · resets Oct 3, 5pm (Asia/Saigon)' }),
  }), {
    resumed: false, reason: 'quota-unavailable', resetAt: Date.parse('2026-10-03T10:00:00.000Z'),
    limitLine: '■ Usage limit reached · resets Oct 3, 5pm (Asia/Saigon)',
    delivered: true, reparked: true,
  });
check('a re-limit attempt still delivers only once in that episode', reparkingSends.length, 1);
check('an ordinary repaint below the same stale limit line never creates a re-send episode',
  resume.attemptResume({
    handle: 'term_panel_repaint', identity: 'term_panel_repaint', agent: 'claude', panel: true,
    status: 'scheduled', parkedAt: resetNow, resetAt: resetNow - resume.RESET_GRACE_MS,
    limitLine: '■ Usage limit reached · resets at 12:00',
  }, {
    now: resetNow, isAuthorized: () => true, probeQuota: () => ({ usedPercent: 0 }),
    readScreen: () => '■ Usage limit reached · resets at 12:00', send: () => true,
    verifyStarted: () => ({ started: false,
      screen: '■ Usage limit reached · resets at 12:00\nQuota has reset - continue the orchestration' }),
  }).reason, 'resumed-unverified');
check('threshold zero never resumes because no nonnegative quota is below it', resume.attemptResume({
  ...resumeJob, threshold: 0,
}, {
  now: resetNow + 1000 + resume.RESET_GRACE_MS,
  isAuthorized: () => true, probeQuota: () => ({ usedPercent: 0 }),
  send: () => { throw new Error('must not send'); },
}).reason, 'quota-unavailable');
check('turn verification requires an active status, not merely changed screen text', [
  resume.turnStarted('Resume message echoed', 'Ready'),
  resume.turnStarted('• Working (1s • esc to interrupt)', 'Ready'),
], [false, true]);
check('panel auto-resume opt-out is retained by config',
  withConfig({ autoResumePanel: false }, () => config.loadConfig()).autoResumePanel, false);

const eventFile = resume.jobFile(stateDir, 'event-test', 'term_unverified');
resume.writeJob(eventFile, {
  session: 'event-test', handle: 'term_unverified', identity: 'ctx_unverified', agent: 'codex',
  status: 'resumed-unverified', unverifiedAt: resetNow,
});
const unverifiedEvents = resume.resumeJobEvents(stateDir, 'event-test', resetNow + 1);
check('heartbeat reports a delivered-but-unverified resume once without retyping', [
  unverifiedEvents.length,
  /do not retype/.test(unverifiedEvents[0]),
  resume.resumeJobEvents(stateDir, 'event-test', resetNow + 2).length,
], [1, true, 0]);
const crashedFile = resume.jobFile(stateDir, 'event-crash', 'term_crashed_send');
resume.writeJob(crashedFile, {
  session: 'event-crash', handle: 'term_crashed_send', identity: 'ctx_crashed_send', agent: 'codex',
  status: 'scheduled', pid: 1234, inFlightSendAt: resetNow,
});
check('heartbeat recovers and reports a marked send after its scheduler dies', [
  resume.resumeJobEvents(stateDir, 'event-crash', resetNow + 1, () => false).length,
  resume.readJob(crashedFile).status,
], [1, 'resumed-unverified']);
const liveSendFile = resume.jobFile(stateDir, 'event-live-send', 'term_live_send');
resume.writeJob(liveSendFile, {
  session: 'event-live-send', handle: 'term_live_send', identity: 'ctx_live_send', agent: 'codex',
  status: 'scheduled', pid: 5678, inFlightSendAt: resetNow,
});
check('heartbeat leaves a marked send alone while its scheduler is still verifying', [
  resume.resumeJobEvents(stateDir, 'event-live-send', resetNow + 1, () => true).length,
  resume.readJob(liveSendFile).status,
], [0, 'scheduled']);
const unreportedFile = resume.jobFile(stateDir, 'event-race', 'term_unreported');
resume.writeJob(unreportedFile, {
  session: 'event-race', handle: 'term_unreported', identity: 'ctx_unreported', agent: 'claude',
  status: 'resumed-unverified', unverifiedAt: resetNow,
});
check('heartbeat recovery cleanup cannot erase an unreported scheduler outcome', [
  resume.clearSettledJob(stateDir, 'event-race', 'term_unreported'),
  resume.readJob(unreportedFile).status,
], [false, 'resumed-unverified']);
const expiredFile = resume.jobFile(stateDir, 'event-test', 'term_expired');
resume.writeJob(expiredFile, {
  session: 'event-test', handle: 'term_expired', identity: 'ctx_expired', agent: 'claude',
  status: 'expired', expiredAt: resetNow,
});
check('heartbeat emits an expired scheduler outcome once',
  resume.resumeJobEvents(stateDir, 'event-test', resetNow + 3).some((event) =>
    event.startsWith('WORKER AUTO-RESUME EXPIRED ctx_expired (claude)')), true);
check('settled jobs are retained for one day then swept', [
  resume.sweepJobs(stateDir, 'event-test', resetNow + resume.SETTLED_RETENTION_MS - 1),
  resume.sweepJobs(stateDir, 'event-test', resetNow + resume.SETTLED_RETENTION_MS + 10),
  resume.readJob(eventFile), resume.readJob(expiredFile),
], [0, 2, null, null]);
const orphanLock = path.join(stateDir, 'resume-event-test-orphan.json.lock');
fs.mkdirSync(orphanLock);
const oldLockTime = new Date(resetNow - resume.SETTLED_RETENTION_MS - 1);
fs.utimesSync(orphanLock, oldLockTime, oldLockTime);
resume.sweepJobs(stateDir, 'event-test', resetNow);
check('orphaned resume lock directories older than one day are swept',
  fs.existsSync(orphanLock), false);

if (failures.length) {
  console.error(`${failures.length} failure(s), ${pass} passed`);
  for (const failure of failures) console.error(`\nFAIL: ${failure}`);
  process.exit(1);
}
console.log(`worker stall tests: ${pass} passed`);
