#!/usr/bin/env node
/**
 * Unit tests for the pure helpers in orchestrator-gate.cjs, orca-heartbeat.cjs,
 * lib/config.cjs and lib/exec-route-by-quota.cjs.
 *
 * Hermetic: state lives under a fresh ORCH_STATE_DIR (never `~/.claude/`), and every
 * path judged by the gate is synthetic and outside any temp directory (`/work/proj/...`),
 * so a result can never depend on this machine's real filesystem layout.
 *
 * Run: node tests/test-orchestrator-gate.cjs (or `npm test`)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-unit-state-'));
process.env.ORCH_STATE_DIR = STATE_DIR;
process.env.ORCH_CONFIG_PATH = path.join(STATE_DIR, 'no-such-config.json'); // -> defaults

const gate = require('../hooks/orchestrator-gate.cjs');
const heartbeat = require('../hooks/orca-heartbeat.cjs');
const config = require('../hooks/lib/config.cjs');
const { orcaInvocations } = require('../hooks/lib/shell-orca-invocations.cjs');
const WG = require('../hooks/lib/worker-groups.cjs');
const OWN = require('../hooks/lib/ownership.cjs');
const OC = require('../hooks/lib/ownership-claims.cjs');
const PAC = require('../hooks/lib/parallel-agent-cap.cjs');
const { acquireLock, releaseLock } = require('../hooks/lib/file-lock.cjs');
const { hasRateLimitError, hasCodexDisconnect } = require('../hooks/lib/terminal-signals.cjs');

let pass = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass += 1;
  else failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
}

// --- redirectTargets --------------------------------------------------------

const SRC = '/work/proj/src/app.py'; // synthetic, not under any real tmp/home path

check('heredoc body with a comparison is not a redirect',
  gate.redirectTargets(`cat > /work/.claude/x.cjs <<'EOF'\nif (t.lastOutputAt > ctx.started) return 1;\nconst f = () => x;\nEOF`),
  ['/work/.claude/x.cjs']);

check('quoted text containing an angle bracket is not a redirect',
  gate.redirectTargets('echo "compare a > b here"'),
  []);

check('plain redirect is caught',
  gate.redirectTargets(`echo hi > ${SRC}`),
  [SRC]);

check('append redirect is caught',
  gate.redirectTargets(`echo hi >> ${SRC}`),
  [SRC]);

check('quoted target after a real operator is still caught',
  gate.redirectTargets(`echo hi > "${SRC}"`),
  [SRC]);

check('tee target is caught',
  gate.redirectTargets(`echo hi | tee ${SRC}`),
  [SRC]);

check('greater-or-equal is not a redirect',
  gate.redirectTargets('node -e "process.exit(a >= b ? 0 : 1)"'),
  []);

check('arrow function is not a redirect',
  gate.redirectTargets('node -e "const f = () => 1"'),
  []);

check('python heredoc with type arrow and comparison',
  gate.redirectTargets(`python3 - <<'PY'\ndef f(x) -> int:\n    return 1 if x >= 2 else 0\nPY`),
  []);

check('stderr merge is not a file target',
  gate.redirectTargets('noisy > /dev/null 2>&1'),
  ['/dev/null']);

// --- isExemptPath -----------------------------------------------------------

check('src path is not exempt', gate.isExemptPath(SRC), false);
check('.claude is exempt', gate.isExemptPath('/work/.claude/rules/z.md'), true);
check('plans is exempt', gate.isExemptPath('/work/proj/plans/p.md'), true);
check('docs is exempt', gate.isExemptPath('/work/proj/docs/d.md'), true);
check('tmp is exempt', gate.isExemptPath('/tmp/whatever.py'), true);

// --- movesOnlyExemptPaths ---------------------------------------------------
// Scratch cleanup must stay allowed; touching a workspace must not.

check('rm in tmp is scratch work', gate.movesOnlyExemptPaths('rm -rf /tmp/orch-501/x'), true);
check('rm in src is not', gate.movesOnlyExemptPaths('rm -rf /work/proj/src'), false);
check('mv between scratch paths is fine',
  gate.movesOnlyExemptPaths('mv /tmp/a.json /work/.claude/orchestrator-gate/a.json'), true);
check('mv out of scratch into a workspace is not',
  gate.movesOnlyExemptPaths(`mv /tmp/a.py ${SRC}`), false);
check('a file-moving command with no visible path is treated as unsafe',
  gate.movesOnlyExemptPaths('rm -rf $TARGET'), false);

// Compound lines must be judged per command. Before this, a descriptive echo
// elsewhere on the line poisoned the verdict for a harmless scratch cleanup.
check('scratch cleanup beside an unrelated echo is still allowed',
  gate.movesOnlyExemptPaths('rm -rf /tmp/smoke && echo "--- A: rm in tmp (fix #3) ---"'), true);
check('a workspace rm anywhere in a compound line is still caught',
  gate.movesOnlyExemptPaths(`echo start && rm -rf ${SRC}`), false);
check('a line with no mover at all is not a move violation',
  gate.movesOnlyExemptPaths('node hooks/orchestrator-gate.cjs && echo done'), true);

// --- shellSegments ----------------------------------------------------------

check('compound line splits into commands',
  gate.shellSegments('echo a && rm -rf /tmp/x; ls'),
  ['echo a', 'rm -rf /tmp/x', 'ls']);
check('quoted text is dropped before segmenting',
  gate.shellSegments('echo "git commit is only mentioned here"'),
  ['echo']);

// --- orcaInvocations ---------------------------------------------------------
// Linear-time shell scanner, replacing an earlier regex-based detector. Each case
// checks the list of `sub` names detected, since that is what the gate routes on.

function subs(cmd) { return orcaInvocations(cmd).map((inv) => inv.sub); }

// Detected: bare, absolute path, assignment, env, env -u, command, exec, nohup,
// time, sudo, xargs, ( ), { ; }, if;then;fi, backticks, unquoted and
// double-quoted $( ), nested quoted $( ) inside $( ).
check('bare orca invocation is detected',
  subs('orca orchestration worker-start --task t'), ['orchestration worker-start']);
check('absolute path is detected',
  subs('/opt/local/bin/orca orchestration worker-start --task t'), ['orchestration worker-start']);
check('leading assignment is detected',
  subs('ORCA_X=1 orca orchestration worker-start --task t'), ['orchestration worker-start']);
check('env wrapper is detected',
  subs('env A=1 orca orchestration worker-start --task t'), ['orchestration worker-start']);
check('env -u wrapper is detected',
  subs('env -u FOO orca orchestration worker-start --task t'), ['orchestration worker-start']);
check('command wrapper is detected',
  subs('command orca orchestration worker-start --task t'), ['orchestration worker-start']);
check('exec wrapper is detected',
  subs('exec orca orchestration worker-start --task t'), ['orchestration worker-start']);
check('nohup wrapper is detected',
  subs('nohup orca orchestration worker-start --task t'), ['orchestration worker-start']);
check('time wrapper is detected',
  subs('time orca orchestration worker-start --task t'), ['orchestration worker-start']);
check('sudo wrapper is detected',
  subs('sudo orca orchestration worker-start --task t'), ['orchestration worker-start']);
check('xargs wrapper is detected',
  subs('echo t | xargs -n1 orca orchestration worker-start --task'), ['orchestration worker-start']);
check('bare (  ) grouping is detected',
  subs('( orca orchestration worker-start --task t )'), ['orchestration worker-start']);
check('{ ; } grouping is detected',
  subs('{ orca orchestration worker-start --task t; }'), ['orchestration worker-start']);
check('if ...; then ...; fi is detected',
  subs('if true; then orca orchestration worker-start --task t; fi'), ['orchestration worker-start']);
check('backtick substitution is detected',
  subs('id=`orca orchestration worker-start --task t`'), ['orchestration worker-start']);
check('unquoted $( ) substitution is detected',
  subs('id=$(orca orchestration worker-start --task t)'), ['orchestration worker-start']);
check('double-quoted $( ) substitution is detected',
  subs('id="$(orca orchestration worker-start --task t)"'), ['orchestration worker-start']);
check('nested quoted $( ) inside $( ) is detected',
  subs('id="$(orca orchestration worker-start --task "$(cat f)")"'), ['orchestration worker-start']);

// Not detected: single-quoted, heredoc body (incl. a markdown code span with
// backticks), escaped \$(, echo/grep mentions, worker-started.
check('single-quoted text is never scanned',
  subs("echo '$(orca orchestration worker-start)'"), []);
check('heredoc body is skipped, including a markdown code span with backticks',
  subs('cat <<EOF\n```\norca orchestration worker-start\n```\nEOF'), []);
check('escaped \\$( is literal, not a substitution',
  subs(String.raw`echo "\$(orca orchestration worker-start)"`), []);
check('an echo mention is text, not an invocation',
  subs('echo "orca orchestration worker-start"'), []);
check('a grep mention is text, not an invocation',
  subs("grep -rn 'orca orchestration worker-start' /work/.claude"), []);
check('a longer sub-command name is not worker-start',
  subs('orca orchestration worker-started --x'), ['orchestration worker-started']);

// --help / --spec are judged per invocation's own args, not the whole line.
check('--help in a different orca invocation does not suppress this one\'s --spec',
  orcaInvocations('orca orchestration task-create --spec s ; orca orchestration worker-start --help')
    .map((inv) => [inv.sub, inv.args.includes('--spec'), inv.args.includes('--help')]),
  [['orchestration task-create', true, false], ['orchestration worker-start', false, true]]);
check('--spec in a different orca invocation does not count for this one',
  orcaInvocations('orca orchestration task-create --help ; orca orchestration worker-start --spec s')
    .map((inv) => [inv.sub, inv.args.includes('--spec'), inv.args.includes('--help')]),
  [['orchestration task-create', false, true], ['orchestration worker-start', true, false]]);

// Timing: none of these may pay a backtracking-regex-shaped cost.
{
  const timed = (cmd) => {
    const t0 = process.hrtime.bigint();
    orcaInvocations(cmd);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  const t1 = timed('A=$(b) '.repeat(2000) + 'x');
  if (t1 < 50) pass += 1; else failures.push(`'A=$(b) '.repeat(2000)+'x' took ${t1}ms, want <50ms`);
  const t2 = timed('A=$(b ' + 'x'.repeat(60 * 1024));
  if (t2 < 50) pass += 1; else failures.push(`60KB unclosed A=$(b took ${t2}ms, want <50ms`);
  const t3 = timed('`'.repeat(60 * 1024));
  if (t3 < 50) pass += 1; else failures.push(`60KB of backticks took ${t3}ms, want <50ms`);
}

// --- heartbeat classifyTerminal --------------------------------------------

check('standing usage tip is not a rate-limit error', hasRateLimitError(
  'Tip: When signed in with ChatGPT, use /usage to check your account usage and access available usage\nlimit resets.'
), false);
check('a diff excerpt mentioning a rate limit is not an error',
  hasRateLimitError('+const message = "Error: 429 rate limit";'), false);
check('a fenced code excerpt mentioning a rate limit is not an error',
  hasRateLimitError('```text\nError: 429 rate limit\n```'), false);
check('a displayed function call containing an HTTP 429 string is not an error',
  hasRateLimitError('console.error("HTTP 429 Too Many Requests")'), false);
check('a displayed test assertion containing an API error code is not an error',
  hasRateLimitError("expect(message).toContain('rate_limit_exceeded');"), false);
check('a progress line about rate-limit error handling is not an error',
  hasRateLimitError('• Added retry handling for the rate limit error path'), false);
check('a progress line about a usage-limit error message is not an error',
  hasRateLimitError('I fixed the usage limit error message in the banner.'), false);
check('a Codex error bullet is a rate-limit error',
  hasRateLimitError("■ You've hit your usage limit. Try again later."), true);
check('an HTTP 429 response line is a rate-limit error',
  hasRateLimitError('request failed with HTTP 429 Too Many Requests'), true);
check('a bare 429 response is not mistaken for a numbered source excerpt',
  hasRateLimitError('429: Too Many Requests'), true);
check('a timestamped ERROR log line is a rate-limit error',
  hasRateLimitError('2026-09-30T12:00:00Z ERROR codex_core: rate limit hit'), true);
check('a bracketed ERROR log line is a rate-limit error',
  hasRateLimitError('[ERROR] rate limit hit'), true);
check('a warning-prefixed usage-limit line is a rate-limit error',
  hasRateLimitError('⚠ You have reached your usage limit'), true);
check('a connection-lost reconnect attempt alone is not a terminal disconnect',
  hasCodexDisconnect('■ Connection lost. Attempting to reconnect…'), false);
check('Codex automatic reconnect failure is a disconnect',
  hasCodexDisconnect('■ Automatic reconnect could not restore this session.'), true);
check('a connection-lost notice followed by reconnect failure is a disconnect',
  hasCodexDisconnect('■ Connection lost. Attempting to reconnect…\n■ Automatic reconnect could not restore this session.'), true);
check('Codex endpoint reconnect failure is a disconnect',
  hasCodexDisconnect('Reconnect failed — check the endpoint, then relaunch'), true);
check('a bullet-prefixed reconnect failure is a disconnect',
  hasCodexDisconnect('■ Reconnect failed — check the endpoint, then relaunch'), true);
check('a branch-prefixed reconnect failure is a disconnect',
  hasCodexDisconnect('└ Reconnect failed — check the endpoint, then relaunch'), true);
check('a diff excerpt containing a reconnect failure is not a disconnect',
  hasCodexDisconnect('+Reconnect failed — check the endpoint, then relaunch'), false);

const NOW = 1800000000000;
const ctx = {
  baseHandles: new Set(['old']), ownHandles: new Set(['old', 'new', 'x']),
  started: NOW - 600000, now: NOW, idleSeconds: 90,
};

check('rate limit in preview wins over everything',
  heartbeat.classifyTerminal({ handle: 'x', preview: 'Error: 429 rate limit', lastOutputAt: NOW }, ctx).kind,
  'rate_limit');

check('a reconnect attempt with continuing terminal output remains working',
  heartbeat.classifyTerminal({ handle: 'x', preview: '■ Connection lost. Attempting to reconnect…',
    lastOutputAt: NOW }, ctx).kind,
  'working');

check('a reported disconnect skips the same terminal\'s orphan and idle checks',
  heartbeat.classifyTerminal({ handle: 'x', preview: '■ Automatic reconnect could not restore this session.',
    orphaned: true, lastOutputAt: NOW - 200000 }, ctx).kind,
  'connection_lost');

const contract = fs.readFileSync(path.join(__dirname, '..', 'rules', 'orchestration-contract.md'), 'utf8');
check('the contract documents that disconnected terminals skip idle and orphan checks',
  /A reported disconnected terminal skips its idle and orphan checks\./.test(contract), true);

check('orphaned terminal is reported',
  heartbeat.classifyTerminal({ handle: 'x', preview: '', orphaned: true, lastOutputAt: NOW }, ctx).kind,
  'orphaned');

check('a terminal that existed at baseline and stayed quiet is ignored',
  heartbeat.classifyTerminal({ handle: 'old', preview: '', lastOutputAt: ctx.started - 60000 }, ctx).kind,
  'ignored');

check('an explicitly retained terminal that was already quiet before startup is idle',
  heartbeat.classifyTerminal(
    { handle: 'retained-old', preview: '', lastOutputAt: ctx.started - 60000 },
    { ...ctx, baseHandles: new Set(['retained-old']), ownHandles: new Set(['retained-old']),
      retainedHandles: new Set(['retained-old']) }
  ).kind,
  'idle');

check('a terminal that existed at baseline but produced output since is supervised, and is idle',
  heartbeat.classifyTerminal({ handle: 'old', preview: '', lastOutputAt: NOW - 200000 }, ctx).kind,
  'idle');

check('a brand new terminal gone quiet is idle',
  heartbeat.classifyTerminal({ handle: 'new', preview: '', lastOutputAt: NOW - 120000 }, ctx).kind,
  'idle');

check('a brand new terminal still producing output is working',
  heartbeat.classifyTerminal({ handle: 'new', preview: '', lastOutputAt: NOW - 5000 }, ctx).kind,
  'working');

check('a foreign terminal that produced output after startup is ignored',
  heartbeat.classifyTerminal({ handle: 'foreign', preview: '', lastOutputAt: NOW - 200000 }, ctx).kind,
  'ignored');

{
  const previousPanelHandle = process.env.ORCA_TERMINAL_HANDLE;
  process.env.ORCA_TERMINAL_HANDLE = 'term_panel';
  check('heartbeat session handles exclude the panel terminal and unsupervised context-only rows',
    [...heartbeat.sessionTerminalHandles([
      { workerState: 'unsupervised', agentTerminalHandle: 'term_context_only' },
      { workerState: 'running', agentTerminalHandle: 'term_panel' },
      { workerState: 'running', agentTerminalHandle: 'term_worker' },
    ])],
    ['term_worker']);
  if (previousPanelHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
  else process.env.ORCA_TERMINAL_HANDLE = previousPanelHandle;
}

check('an explicitly retained terminal is not a finished-worker resource leak',
  heartbeat.isHoldingResources({ terminalState: 'retained' }, true), false);
check('an Orca auto-retained readiness failure still holds resources without explicit worker-retain',
  heartbeat.isHoldingResources({ terminalState: 'retained' }, false), true);
check('a released worker holds nothing',
  heartbeat.isHoldingResources({ terminalState: 'released' }), false);
check('a retained worker terminal remains in the session supervision set',
  [...heartbeat.sessionTerminalHandles([
    { workerState: 'failed', terminalState: 'retained', agentTerminalHandle: 'term_retained' },
  ], { workers: { ctx_retained: { status: 'live', retained: true, group: 'ctx_retained' } } })],
  ['term_retained']);
check('heartbeat event snapshots exclude unsupervised context-only rows',
  [...heartbeat.snapshotWorkers([
    { dispatchId: 'ctx_context_only', workerState: 'unsupervised', dispatchStatus: 'created', terminalState: null },
    { dispatchId: 'ctx_worker', workerState: 'running', dispatchStatus: 'started', terminalState: 'attached' },
  ])],
  [['ctx_worker', 'running|started|attached']]);

// --- heartbeat isDoneButOpen / worktree event formatting --------------------

{
  // A git stand-in whose every answer is overridable per test, defaulting to "clean,
  // origin/main resolves, HEAD is an ancestor of it, a real upstream with nothing unpushed"
  // — the common accepted-and-clean backdrop most cases build on.
  // `pick` distinguishes "no override supplied" (use the default) from an override that is
  // explicitly `null` (simulate runGit()'s own "spawn-level failure" answer) — a plain `??`
  // cannot tell those apart, since it treats an explicit null exactly like "absent".
  const pick = (overrides, key, dflt) => (key in overrides ? overrides[key] : dflt);
  function fakeGit(overrides = {}) {
    return (args) => {
      // A leading global flag (e.g. `--no-optional-locks`, see the real `status --porcelain`
      // call) must not be mistaken for the subcommand itself.
      const sub = args.find((a) => !a.startsWith('--'));
      if (sub === 'symbolic-ref') return pick(overrides, 'symbolicRef', { status: 0, stdout: 'origin/main' });
      if (sub === 'merge-base') return pick(overrides, 'mergeBase', { status: 0, stdout: '' });
      if (sub === 'status') return pick(overrides, 'status', { status: 0, stdout: '' });
      if (sub === 'rev-parse' && args.includes('@{u}')) return pick(overrides, 'upstream', { status: 0, stdout: 'origin/feature' });
      if (sub === 'rev-list') return pick(overrides, 'revList', { status: 0, stdout: '' });
      // H1: HEAD's own commit time (seconds), consulted only on the no-linked-PR/MR
      // acceptance path. Default (700s -> 700_000ms) sits after the default `stat` fixture
      // below (500_000ms), so the common backdrop is "this worktree really did advance".
      if (sub === 'log') return pick(overrides, 'log', { status: 0, stdout: '700' });
      // Review round 3, item 3: the worktree branch's own reflog, consulted alongside the
      // mtime/commit-time signal above on the same no-linked-PR/MR acceptance path. Default
      // is "a real commit happened" (matching the "everything checks out" backdrop the other
      // defaults on this fixture already use), so a test proving the H1 false positive
      // overrides this specifically to an empty reflog.
      if (sub === 'reflog') return pick(overrides, 'reflog', { status: 0, stdout: 'commit: real work' });
      if (sub === 'rev-parse') {
        const ref = args[args.length - 1];
        if (ref === 'origin/main') return pick(overrides, 'revParseOriginMain', { status: 0, stdout: 'sha' });
        if (ref === 'main') return pick(overrides, 'revParseMain', { status: 0, stdout: 'sha' });
        return { status: 1, stdout: '' };
      }
      return { status: 1, stdout: '' };
    };
  }
  const throwingGit = () => { throw new Error('git must not be called for this row'); };
  // H1: the worktree's own `.git` mtime proxy, injectable per test; defaults to a time
  // before the default HEAD commit time above, so "no linked PR/MR" cases default to
  // accepted exactly as they did before H1 introduced this extra leg.
  const defaultStat = () => 500_000;
  const ctx = (overrides = {}) => ({
    now: 1_000_000, idleSeconds: 60, ...overrides,
    git: fakeGit(overrides.git), stat: overrides.stat || defaultStat,
  });

  const mergedIdle = { path: '/wt/a', displayName: 'a', isMainWorktree: false, isArchived: false,
    liveTerminalCount: 0, lastOutputAt: 0, prState: 'merged', prNumber: 12 };
  check('merged PR + no live terminal + clean is done-but-open', heartbeat.isDoneButOpen(mergedIdle, ctx()), true);

  const closedIdle = { ...mergedIdle, prState: 'closed', prNumber: 13 };
  check('closed PR + no live terminal + clean is done-but-open', heartbeat.isDoneButOpen(closedIdle, ctx()), true);

  check('an open PR is never done-but-open (git is never consulted)',
    heartbeat.isDoneButOpen({ ...mergedIdle, prState: 'open' }, { ...ctx(), git: throwingGit }), false);
  check('a merged PR with a live terminal and no lastOutputAt is never done-but-open (uncertain idle)',
    heartbeat.isDoneButOpen({ ...mergedIdle, liveTerminalCount: 1 }, { ...ctx(), git: throwingGit }), false);
  check('the main worktree is never done-but-open even when merged and idle',
    heartbeat.isDoneButOpen({ ...mergedIdle, isMainWorktree: true }, { ...ctx(), git: throwingGit }), false);
  check('an archived worktree is never done-but-open',
    heartbeat.isDoneButOpen({ ...mergedIdle, isArchived: true }, { ...ctx(), git: throwingGit }), false);
  check('a merged PR that is NOT clean (dirty working tree) is never done-but-open',
    heartbeat.isDoneButOpen(mergedIdle, ctx({ git: { status: { status: 0, stdout: ' M x\n' } } })), false);
  check('a git status failure means "not confirmed clean", never done-but-open',
    heartbeat.isDoneButOpen(mergedIdle, ctx({ git: { status: null } })), false);

  // No linked PR at all: acceptance falls back to a real git ancestor-of-base check.
  const noPrIdle = { ...mergedIdle, prState: null, prNumber: null };
  check('no linked PR + HEAD is an ancestor of the resolved base + clean is done-but-open',
    heartbeat.isDoneButOpen(noPrIdle, ctx()), true);
  check('no linked PR + HEAD is NOT an ancestor of the base is never done-but-open',
    heartbeat.isDoneButOpen(noPrIdle, ctx({ git: { mergeBase: { status: 1, stdout: '' } } })), false);
  check('no linked PR + no resolvable base at all is never done-but-open',
    heartbeat.isDoneButOpen(noPrIdle, ctx({ git: {
      symbolicRef: { status: 128, stdout: '' },
      revParseOriginMain: { status: 1, stdout: '' },
      revParseMain: { status: 1, stdout: '' },
    } })), false);

  // H1: a worktree trivially "an ancestor of base" and "clean" because it was JUST created
  // off that base (zero new commits) must not be reported — HEAD's commit predates the
  // worktree's own creation.
  check('H1: no linked PR + ancestor + clean, but HEAD predates the worktree\'s own creation, is never done-but-open',
    heartbeat.isDoneButOpen(noPrIdle, ctx({ stat: () => 900_000 })), false);
  check('H1: no linked PR + ancestor + clean, HEAD commit time exactly equal to creation, is never done-but-open',
    heartbeat.isDoneButOpen(noPrIdle, ctx({ stat: () => 700_000 })), false);
  check('H1: an unreadable worktree creation time (.git unstattable) is never done-but-open',
    heartbeat.isDoneButOpen(noPrIdle, ctx({ stat: () => null })), false);
  check('H1: an unreadable HEAD commit time (git log failure) is never done-but-open',
    heartbeat.isDoneButOpen(noPrIdle, ctx({ git: { log: null } })), false);
  check('H1: hasProducedMergedWork is true when HEAD postdates the worktree\'s creation',
    heartbeat.hasProducedMergedWork(noPrIdle, fakeGit(), () => 500_000), true);
  check('H1: hasProducedMergedWork is false when HEAD predates the worktree\'s creation',
    heartbeat.hasProducedMergedWork(noPrIdle, fakeGit(), () => 900_000), false);

  // Review round 3, item 3: hasOwnCommit reads the branch's OWN reflog directly, straight
  // from a "commit"-prefixed subject line, regardless of any mtime/commit-time timestamp.
  check('hasOwnCommit is true when the reflog has a "commit:" line',
    heartbeat.hasOwnCommit(noPrIdle, fakeGit()), true);
  check('hasOwnCommit is false when the reflog is empty (no commit was ever made on this branch)',
    heartbeat.hasOwnCommit(noPrIdle, fakeGit({ reflog: { status: 0, stdout: '' } })), false);
  check('hasOwnCommit recognizes "commit (amend)" as a real commit action',
    heartbeat.hasOwnCommit(noPrIdle, fakeGit({ reflog: { status: 0, stdout: 'commit (amend): fixup' } })), true);
  check('hasOwnCommit recognizes "commit (merge)" as a real commit action',
    heartbeat.hasOwnCommit(noPrIdle, fakeGit({ reflog: { status: 0, stdout: 'commit (merge): merge feature' } })), true);
  check('hasOwnCommit is false when only non-commit reflog entries exist (e.g. a rebase/fast-forward)',
    heartbeat.hasOwnCommit(noPrIdle, fakeGit({ reflog: { status: 0, stdout: 'rebase (finish): returning to refs/heads/feature' } })), false);
  check('hasOwnCommit is false on a git failure (never a pass on uncertainty)',
    heartbeat.hasOwnCommit(noPrIdle, fakeGit({ reflog: null })), false);

  // Review round 3, item 3 (H1 leftover false positive): the OLD mtime/commit-time signal
  // alone (`hasProducedMergedWork`) is satisfied by a worktree that was merely rebased/
  // fast-forwarded onto a base that itself advanced after the worktree's creation — HEAD's
  // commit time postdates the worktree's own creation even though the worktree's own branch
  // never gained a commit. `resolveAcceptance`/`isDoneButOpen` must additionally require
  // `hasOwnCommit`, so this combination (old signal true, reflog empty) must still refuse.
  check('H1: a postdating HEAD commit time alone (no reflog commit of its own) is never done-but-open',
    heartbeat.isDoneButOpen(noPrIdle, ctx({ git: { reflog: { status: 0, stdout: '' } } })), false);
  check('H1: evaluateDoneButOpen reports not-done for the same rebased/no-own-commit case',
    heartbeat.evaluateDoneButOpen(noPrIdle, ctx({ git: { reflog: { status: 0, stdout: '' } } })).done, false);

  // No upstream: the clean check falls back to "HEAD is an ancestor of the resolved base".
  const noPrNoUpstream = ctx({ git: { upstream: { status: 128, stdout: '' } } });
  check('clean check falls back to base-ancestor when there is no upstream at all',
    heartbeat.isDoneButOpen(mergedIdle, noPrNoUpstream), true);
  check('no upstream + not an ancestor of base is never clean',
    heartbeat.isDoneButOpen(mergedIdle, ctx({ git: { upstream: { status: 128, stdout: '' }, mergeBase: { status: 1, stdout: '' } } })), false);
  check('an upstream with unpushed commits is never clean',
    heartbeat.isDoneButOpen(mergedIdle, ctx({ git: { revList: { status: 0, stdout: 'deadbeef\n' } } })), false);

  // Idle via the worktree-level lastOutputAt aggregate (no per-terminal data is exposed).
  const liveButQuiet = { ...mergedIdle, liveTerminalCount: 1, lastOutputAt: 1_000_000 - 120_000 };
  check('a live terminal whose aggregate lastOutputAt is past the idle threshold is idle',
    heartbeat.isDoneButOpen(liveButQuiet, ctx()), true);
  const liveAndRecent = { ...mergedIdle, liveTerminalCount: 1, lastOutputAt: 1_000_000 - 5_000 };
  check('a live terminal whose aggregate lastOutputAt is within the idle threshold is not idle',
    heartbeat.isDoneButOpen(liveAndRecent, { ...ctx(), git: throwingGit }), false);

  // GitLab MR support (item L5): judged the same way a GitHub PR is, only when no PR at all
  // is linked (a GitLab worktree never carries both fields at once in practice).
  const mrMerged = { ...noPrIdle, mrState: 'merged', mrNumber: 7 };
  check('a merged GitLab MR (no PR linked) is done-but-open',
    heartbeat.isDoneButOpen(mrMerged, ctx({ git: { symbolicRef: { status: 128, stdout: '' } } })), true);
  const mrOpen = { ...noPrIdle, mrState: 'opened', mrNumber: 8 };
  check('a still-open ("opened") GitLab MR is never done-but-open, even if HEAD is an ancestor',
    heartbeat.isDoneButOpen(mrOpen, { ...ctx(), git: throwingGit }), false);

  check('evaluateDoneButOpen names the PR acceptance path in its reason',
    heartbeat.evaluateDoneButOpen(mergedIdle, ctx()).reason, 'PR #12 merged');
  check('evaluateDoneButOpen names the no-linked-PR/git acceptance path in its reason',
    heartbeat.evaluateDoneButOpen(noPrIdle, ctx()).reason, 'no linked PR, HEAD already merged into origin/main');

  check('formatDoneWorktreeEvent names the acceptance reason, single-quotes the rm target path',
    heartbeat.formatDoneWorktreeEvent(mergedIdle, 'PR #12 merged'),
    "DONE worktree a (PR #12 merged, no live terminal) — verify it is clean, then close: orca worktree rm --worktree 'path:/wt/a'");

  // Low item: a live-but-quiet terminal is a different idle leg than "no live terminal at
  // all" — the wake line must say so accurately.
  check('formatDoneWorktreeEvent names "quiet terminal(s)" when the worktree has a live terminal',
    heartbeat.formatDoneWorktreeEvent(liveButQuiet, 'PR #12 merged').includes('quiet terminal(s)'), true);
  check('formatDoneWorktreeEvent never says "no live terminal" when a terminal actually is live',
    heartbeat.formatDoneWorktreeEvent(liveButQuiet, 'PR #12 merged').includes('no live terminal'), false);

  // Low item: control characters and a literal `'` in an Orca-reported name/path must never
  // corrupt the line or escape the single-quoted shell argument.
  check('formatDoneWorktreeEvent strips control characters from displayName and single-quote-escapes the path',
    heartbeat.formatDoneWorktreeEvent({ ...mergedIdle, displayName: 'a\nb', path: "/wt/it's-a" }, 'PR #12 merged'),
    "DONE worktree ab (PR #12 merged, no live terminal) — verify it is clean, then close: orca worktree rm --worktree 'path:/wt/it'\\''s-a'");

  check('formatDoneWorktreeStartupSummary lists every pre-existing worktree by name AND path',
    heartbeat.formatDoneWorktreeStartupSummary([mergedIdle, { ...closedIdle, displayName: 'b', path: '/wt/b' }])
      .includes('2 pre-existing done-but-open worktree(s) at startup: a (/wt/a), b (/wt/b)'), true);
  check('formatDoneWorktreeStartupSummary strips control characters from displayName/path',
    heartbeat.formatDoneWorktreeStartupSummary([{ ...mergedIdle, displayName: 'a\nb' }])
      .includes('ab (/wt/a)'), true);

  // --- resolveBaseRef / isAncestorOf / resolveAcceptance / isWorktreeIdle directly -------
  check('resolveBaseRef prefers the resolved origin/HEAD symbolic ref',
    heartbeat.resolveBaseRef('/wt/a', fakeGit()), 'origin/main');
  check('resolveBaseRef falls back to origin/main when no symbolic ref resolves',
    heartbeat.resolveBaseRef('/wt/a', fakeGit({ symbolicRef: { status: 128, stdout: '' } })), 'origin/main');
  check('resolveBaseRef falls back to local main when origin/main does not exist either',
    heartbeat.resolveBaseRef('/wt/a', fakeGit({
      symbolicRef: { status: 128, stdout: '' }, revParseOriginMain: { status: 1, stdout: '' },
    })), 'main');
  check('resolveBaseRef returns null when nothing resolves at all',
    heartbeat.resolveBaseRef('/wt/a', fakeGit({
      symbolicRef: { status: 128, stdout: '' },
      revParseOriginMain: { status: 1, stdout: '' },
      revParseMain: { status: 1, stdout: '' },
    })), null);
  check('resolveBaseRef returns null when git cannot answer at all',
    heartbeat.resolveBaseRef('/wt/a', () => null), null);

  check('isAncestorOf is true only on a confirmed git exit 0',
    heartbeat.isAncestorOf('/wt/a', fakeGit(), 'origin/main'), true);
  check('isAncestorOf is false on a confirmed "not an ancestor" (exit 1)',
    heartbeat.isAncestorOf('/wt/a', fakeGit({ mergeBase: { status: 1, stdout: '' } }), 'origin/main'), false);
  check('isAncestorOf is false on a spawn-level git failure',
    heartbeat.isAncestorOf('/wt/a', () => null, 'origin/main'), false);

  check('isWorktreeIdle is true immediately when there is no live terminal at all',
    heartbeat.isWorktreeIdle({ liveTerminalCount: 0, lastOutputAt: 0 }, 1_000_000, 60), true);
  check('isWorktreeIdle is false when lastOutputAt is missing but a terminal is live',
    heartbeat.isWorktreeIdle({ liveTerminalCount: 1, lastOutputAt: 0 }, 1_000_000, 60), false);
}

// --- config.cjs --------------------------------------------------------------

{
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-config-'));
  const cfgFile = path.join(cfgDir, 'orchestration.config.json');
  const withConfig = (obj, fn) => {
    fs.writeFileSync(cfgFile, JSON.stringify(obj));
    const prev = process.env.ORCH_CONFIG_PATH;
    process.env.ORCH_CONFIG_PATH = cfgFile;
    try { return fn(); } finally { process.env.ORCH_CONFIG_PATH = prev; }
  };

  const defaults = withConfig({}, () => config.loadConfig());
  check('default activation is orca-only', defaults.activation, 'orca-only');
  check('default review alias is opus', defaults.models.review.alias, 'opus');
  check('default codexHandoffUsedPercent is 95', defaults.codexHandoffUsedPercent, 95);
  const exampleConfig = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'config', 'orchestration.config.example.json'), 'utf8'));
  check('example config uses the 95% handoff default', exampleConfig.codexHandoffUsedPercent, 95);
  check('default codexQuotaCacheSeconds is 60', defaults.codexQuotaCacheSeconds, 60);
  check('default agents.lookup is [Explore]', defaults.agents.lookup, ['Explore']);
  check('default agents.escalation is empty', defaults.agents.escalation, []);
  check('default config has no warnings', defaults.warnings, []);

  const badActivation = withConfig({ activation: 'sometimes' }, () => config.loadConfig());
  check('invalid activation falls back to orca-only', badActivation.activation, 'orca-only');
  check('invalid activation produces a warning', badActivation.warnings.length > 0, true);

  const badThreshold = withConfig({ codexHandoffUsedPercent: 150 }, () => config.loadConfig());
  check('out-of-range threshold falls back to default', badThreshold.codexHandoffUsedPercent, 95);
  check('out-of-range threshold produces a warning', badThreshold.warnings.length > 0, true);

  const goodThreshold = withConfig({ codexHandoffUsedPercent: 60 }, () => config.loadConfig());
  check('a valid threshold is kept as-is', goodThreshold.codexHandoffUsedPercent, 60);
  check('handoffUsed reads the config value', config.handoffUsed(goodThreshold), 60);

  const unknownGate = withConfig({ disabledGates: ['not-a-real-gate'] }, () => config.loadConfig());
  check('an unknown disabled gate name produces a warning', unknownGate.warnings.length > 0, true);
  check('unknown gate name is still kept in disabledGates', unknownGate.disabledGates, ['not-a-real-gate']);

  const realGate = withConfig({ disabledGates: ['main-no-write'] }, () => config.loadConfig());
  check('a known gate name in disabledGates produces no warning', realGate.warnings, []);
  check('gateDisabled is true for a listed gate', config.gateDisabled(realGate, 'main-no-write'), true);
  check('gateDisabled is false for an unlisted gate', config.gateDisabled(realGate, 'main-no-mutate'), false);

  const before = process.env.ORCH_CODEX_HANDOFF_USED;
  process.env.ORCH_CODEX_HANDOFF_USED = '55';
  check('ORCH_CODEX_HANDOFF_USED overrides the config value', config.handoffUsed(defaults), 55);
  process.env.ORCH_CODEX_HANDOFF_USED = 'not-a-number';
  check('an invalid override falls back to config', config.handoffUsed(defaults), defaults.codexHandoffUsedPercent);
  if (before === undefined) delete process.env.ORCH_CODEX_HANDOFF_USED; else process.env.ORCH_CODEX_HANDOFF_USED = before;

  const goodQuotaCache = withConfig({ codexQuotaCacheSeconds: 15 }, () => config.loadConfig());
  check('a valid codex quota cache TTL is kept as-is', goodQuotaCache.codexQuotaCacheSeconds, 15);
  const badQuotaCache = withConfig({ codexQuotaCacheSeconds: 3601 }, () => config.loadConfig());
  check('an invalid codex quota cache TTL falls back to default', badQuotaCache.codexQuotaCacheSeconds, 60);
  check('an invalid codex quota cache TTL produces a warning', badQuotaCache.warnings.length > 0, true);
  const beforeQuotaCache = process.env.ORCH_CODEX_QUOTA_CACHE_SECONDS;
  process.env.ORCH_CODEX_QUOTA_CACHE_SECONDS = '0';
  check('ORCH_CODEX_QUOTA_CACHE_SECONDS overrides the config value', config.codexQuotaCacheSeconds(defaults), 0);
  process.env.ORCH_CODEX_QUOTA_CACHE_SECONDS = 'bad';
  check('an invalid quota cache override falls back to config', config.codexQuotaCacheSeconds(defaults), 60);
  if (beforeQuotaCache === undefined) delete process.env.ORCH_CODEX_QUOTA_CACHE_SECONDS;
  else process.env.ORCH_CODEX_QUOTA_CACHE_SECONDS = beforeQuotaCache;

  check('default closeDoneWorktrees is true', defaults.closeDoneWorktrees, true);
  check('closeDoneWorktreesEnabled defaults to the config value', config.closeDoneWorktreesEnabled(defaults), true);

  const wtOff = withConfig({ closeDoneWorktrees: false }, () => config.loadConfig());
  check('closeDoneWorktrees:false is kept as-is with no warning', wtOff.closeDoneWorktrees, false);
  check('closeDoneWorktreesEnabled respects a false config value', config.closeDoneWorktreesEnabled(wtOff), false);

  const wtBad = withConfig({ closeDoneWorktrees: 'yes' }, () => config.loadConfig());
  check('a non-boolean closeDoneWorktrees falls back to the default', wtBad.closeDoneWorktrees, true);
  check('a non-boolean closeDoneWorktrees produces a warning', wtBad.warnings.length > 0, true);

  const beforeWt = process.env.ORCH_CLOSE_DONE_WORKTREES;
  process.env.ORCH_CLOSE_DONE_WORKTREES = '0';
  check('ORCH_CLOSE_DONE_WORKTREES=0 disables it even when config says true',
    config.closeDoneWorktreesEnabled(defaults), false);
  process.env.ORCH_CLOSE_DONE_WORKTREES = 'false';
  check('ORCH_CLOSE_DONE_WORKTREES=false also disables it', config.closeDoneWorktreesEnabled(defaults), false);
  process.env.ORCH_CLOSE_DONE_WORKTREES = '1';
  check('an explicit "1" override enables it even when config says false', config.closeDoneWorktreesEnabled(wtOff), true);
  process.env.ORCH_CLOSE_DONE_WORKTREES = 'TRUE';
  check('an explicit "TRUE" override (case-insensitive) enables it even when config says false',
    config.closeDoneWorktreesEnabled(wtOff), true);
  // Item L2: anything other than an explicit 1/true/0/false — including an empty string —
  // defers to the config value rather than being read as "set at all, so true".
  process.env.ORCH_CLOSE_DONE_WORKTREES = '';
  check('an empty override defers to config (true default)', config.closeDoneWorktreesEnabled(defaults), true);
  check('an empty override defers to config (false)', config.closeDoneWorktreesEnabled(wtOff), false);
  process.env.ORCH_CLOSE_DONE_WORKTREES = 'garbage';
  check('a garbage override defers to config (true default)', config.closeDoneWorktreesEnabled(defaults), true);
  check('a garbage override defers to config (false)', config.closeDoneWorktreesEnabled(wtOff), false);
  if (beforeWt === undefined) delete process.env.ORCH_CLOSE_DONE_WORKTREES; else process.env.ORCH_CLOSE_DONE_WORKTREES = beforeWt;

  // --- max-parallel-agents config fields (parallelCoreFraction / maxParallelAgents) -----
  check('default parallelCoreFraction is 0.8', defaults.parallelCoreFraction, 0.8);
  check('default maxParallelAgents is null (derive from cores)', defaults.maxParallelAgents, null);
  check('max-parallel-agents is a known gate name', config.GATE_NAMES.includes('max-parallel-agents'), true);

  const badFraction = withConfig({ parallelCoreFraction: 1.5 }, () => config.loadConfig());
  check('out-of-range parallelCoreFraction falls back to default', badFraction.parallelCoreFraction, 0.8);
  check('out-of-range parallelCoreFraction produces a warning', badFraction.warnings.length > 0, true);

  const tooLowFraction = withConfig({ parallelCoreFraction: 0.05 }, () => config.loadConfig());
  check('below-range parallelCoreFraction falls back to default', tooLowFraction.parallelCoreFraction, 0.8);

  const goodFraction = withConfig({ parallelCoreFraction: 0.5 }, () => config.loadConfig());
  check('a valid parallelCoreFraction is kept as-is', goodFraction.parallelCoreFraction, 0.5);
  check('parallelCoreFraction() reads the config value', config.parallelCoreFraction(goodFraction), 0.5);

  const badMaxAgents = withConfig({ maxParallelAgents: 'lots' }, () => config.loadConfig());
  check('a non-integer maxParallelAgents falls back to null', badMaxAgents.maxParallelAgents, null);
  check('a non-integer maxParallelAgents produces a warning', badMaxAgents.warnings.length > 0, true);

  const outOfRangeMaxAgents = withConfig({ maxParallelAgents: 500 }, () => config.loadConfig());
  check('an out-of-range maxParallelAgents falls back to null', outOfRangeMaxAgents.maxParallelAgents, null);

  const explicitMaxAgents = withConfig({ maxParallelAgents: 5 }, () => config.loadConfig());
  check('an explicit integer maxParallelAgents is kept as-is', explicitMaxAgents.maxParallelAgents, 5);
  check('maxParallelAgents() reads the config value', config.maxParallelAgents(explicitMaxAgents), 5);

  const zeroMaxAgents = withConfig({ maxParallelAgents: 0 }, () => config.loadConfig());
  check('maxParallelAgents: 0 is kept as 0 (unlimited), not treated as falsy-missing', zeroMaxAgents.maxParallelAgents, 0);

  const beforeFraction = process.env.ORCH_PARALLEL_CORE_FRACTION;
  process.env.ORCH_PARALLEL_CORE_FRACTION = '0.3';
  check('ORCH_PARALLEL_CORE_FRACTION overrides the config value', config.parallelCoreFraction(defaults), 0.3);
  process.env.ORCH_PARALLEL_CORE_FRACTION = 'nope';
  check('an invalid ORCH_PARALLEL_CORE_FRACTION falls back to config', config.parallelCoreFraction(defaults), defaults.parallelCoreFraction);
  if (beforeFraction === undefined) delete process.env.ORCH_PARALLEL_CORE_FRACTION; else process.env.ORCH_PARALLEL_CORE_FRACTION = beforeFraction;

  const beforeMaxAgentsEnv = process.env.ORCH_MAX_PARALLEL_AGENTS;
  process.env.ORCH_MAX_PARALLEL_AGENTS = '7';
  check('ORCH_MAX_PARALLEL_AGENTS overrides the config value', config.maxParallelAgents(defaults), 7);
  process.env.ORCH_MAX_PARALLEL_AGENTS = '0';
  check('ORCH_MAX_PARALLEL_AGENTS=0 overrides to explicit unlimited', config.maxParallelAgents(defaults), 0);
  process.env.ORCH_MAX_PARALLEL_AGENTS = 'nope';
  check('an invalid ORCH_MAX_PARALLEL_AGENTS falls back to config', config.maxParallelAgents(defaults), defaults.maxParallelAgents);

  // M2: an empty or whitespace-only override is unset, never coerced to 0 (Number("")===0).
  process.env.ORCH_MAX_PARALLEL_AGENTS = '';
  check('M2: ORCH_MAX_PARALLEL_AGENTS="" is treated as unset, not as 0', config.maxParallelAgents(defaults), defaults.maxParallelAgents);
  process.env.ORCH_MAX_PARALLEL_AGENTS = '   ';
  check('M2: ORCH_MAX_PARALLEL_AGENTS="   " is treated as unset, not as 0', config.maxParallelAgents(defaults), defaults.maxParallelAgents);
  if (beforeMaxAgentsEnv === undefined) delete process.env.ORCH_MAX_PARALLEL_AGENTS; else process.env.ORCH_MAX_PARALLEL_AGENTS = beforeMaxAgentsEnv;

  const beforeFraction2 = process.env.ORCH_PARALLEL_CORE_FRACTION;
  process.env.ORCH_PARALLEL_CORE_FRACTION = '';
  check('M2: ORCH_PARALLEL_CORE_FRACTION="" is treated as unset, not as 0', config.parallelCoreFraction(defaults), defaults.parallelCoreFraction);
  process.env.ORCH_PARALLEL_CORE_FRACTION = '  ';
  check('M2: ORCH_PARALLEL_CORE_FRACTION="  " is treated as unset, not as 0', config.parallelCoreFraction(defaults), defaults.parallelCoreFraction);
  if (beforeFraction2 === undefined) delete process.env.ORCH_PARALLEL_CORE_FRACTION; else process.env.ORCH_PARALLEL_CORE_FRACTION = beforeFraction2;

  // M2: the config FILE also only accepts an actual JSON number, never a numeric-looking
  // string or an empty string silently coerced by Number(...).
  const emptyStringMaxAgents = withConfig({ maxParallelAgents: '' }, () => config.loadConfig());
  check('M2: maxParallelAgents:"" in the config file falls back to null with a warning',
    emptyStringMaxAgents.maxParallelAgents, null);
  check('M2: maxParallelAgents:"" produces a warning', emptyStringMaxAgents.warnings.length > 0, true);

  const stringMaxAgents = withConfig({ maxParallelAgents: '5' }, () => config.loadConfig());
  check('M2: maxParallelAgents:"5" (a string, not a number) falls back to null with a warning',
    stringMaxAgents.maxParallelAgents, null);

  const emptyStringFraction = withConfig({ parallelCoreFraction: '' }, () => config.loadConfig());
  check('M2: parallelCoreFraction:"" in the config file falls back to the default with a warning',
    emptyStringFraction.parallelCoreFraction, 0.8);
  check('M2: parallelCoreFraction:"" produces a warning', emptyStringFraction.warnings.length > 0, true);

  fs.rmSync(cfgDir, { recursive: true, force: true });
}

// --- lib/parallel-agent-cap.cjs: limit derivation + cross-session counting -----------

{
  const cfgHelpers = (maxAgents, fraction) => ({
    maxParallelAgents: () => maxAgents,
    parallelCoreFraction: () => fraction,
  });

  // `PAC.cores()` reads this real machine's own core count (not injectable — deliberately,
  // since a container's CPU allotment can change between calls and must be read fresh), so
  // the derivation FORMULA itself is verified against the documented 18 -> 14 example
  // directly, and `agentParallelLimit`'s null-derivation path is cross-checked against
  // this real machine's own `PAC.cores()` further below instead of a hard-coded core count.
  check('floor(0.8 x 18) = 14 (the documented example)', Math.max(1, Math.floor(0.8 * 18)), 14);
  check('floor(0.8 x 1) = 1, never below the floor of 1', Math.max(1, Math.floor(0.8 * 1)), 1);

  check('an explicit maxParallelAgents overrides the derivation entirely',
    PAC.agentParallelLimit({}, cfgHelpers(5, 0.8)), 5);
  check('maxParallelAgents: 0 means unlimited (Infinity)',
    PAC.agentParallelLimit({}, cfgHelpers(0, 0.8)), Infinity);
  check('maxParallelAgents: null derives from cores x fraction',
    PAC.agentParallelLimit({}, cfgHelpers(null, 0.8)), Math.max(1, Math.floor(0.8 * PAC.cores())));

  // --- cross-session counting: live workers/reservations/agents summed across files, -----
  // --- ignoring a stale (> 6h old) session file entirely -----------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pac-'));
  const now = Date.now();
  const write = (name, obj, ageMs) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(obj));
    if (ageMs != null) {
      const t = (now - ageMs) / 1000;
      fs.utimesSync(file, t, t);
    }
  };

  write('sessA.json', {
    workers: { ctx_a1: { status: 'live', started: now, group: 'ctx_a1' } },
    reservations: {}, agents: { toolu_a1: { ts: now } },
  });
  write('sessB.json', {
    workers: {}, reservations: { 'toolu_b1#0': { ts: now, newSlot: true } },
    agents: {},
  });
  // A stale session (7h old) with live-looking entries must be ignored entirely.
  write('sessStale.json', {
    workers: { ctx_stale: { status: 'live', started: now, group: 'ctx_stale' } },
    reservations: {}, agents: { toolu_stale: { ts: now } },
  }, 7 * 60 * 60 * 1000);
  // A capExempt worker (done per Orca, still holding its terminal) must not count.
  write('sessC.json', {
    workers: { ctx_c1: { status: 'live', started: now, group: 'ctx_c1', capExempt: true } },
    reservations: {}, agents: {},
  });
  // An expired reservation (no newSlot, or past the 10-minute reservation TTL) must not count.
  write('sessD.json', {
    workers: {}, reservations: {
      'toolu_d1#0': { ts: now - 11 * 60 * 1000, newSlot: true }, // expired (> 10 min)
      'toolu_d2#0': { ts: now, newSlot: false },                 // not a new slot (e.g. task-create)
    }, agents: {},
  });
  // An agent registration past its 120-minute TTL must not count.
  write('sessE.json', {
    workers: {}, reservations: {}, agents: { toolu_e1: { ts: now - 121 * 60 * 1000 } },
  });
  // Not a session state file at all — must be ignored by the directory scan.
  write('sessA.role.json', { handle: 'x', role: 'worker' });
  write('heartbeat-sessA.json', { pid: 1, last_tick: now });

  const usage = PAC.machineWideLiveUnits(dir, now);
  check('recentSessionStateFiles excludes .role.json and heartbeat-* files',
    PAC.recentSessionStateFiles(dir, now).some((f) => /sessA\.role\.json|heartbeat-/.test(f)), false);
  check('machineWideLiveUnits counts one live worker group from sessA', usage.orcaWorkers >= 1, true);
  check('machineWideLiveUnits counts one live reservation-backed slot from sessB', usage.orcaWorkers >= 2, true);
  check('machineWideLiveUnits counts one live subagent from sessA', usage.subagents >= 1, true);
  check('machineWideLiveUnits ignores a stale (>6h) session file entirely',
    usage.ids.includes('ctx_stale') || usage.ids.includes('toolu_stale'), false);
  check('machineWideLiveUnits never counts a capExempt worker', usage.ids.includes('ctx_c1'), false);
  check('machineWideLiveUnits never counts an expired reservation', usage.ids.includes('toolu_d1#0'), false);
  check('machineWideLiveUnits never counts a reservation with newSlot:false', usage.ids.includes('toolu_d2#0'), false);
  check('machineWideLiveUnits never counts an agent past its TTL', usage.ids.includes('toolu_e1'), false);
  // Exactly the 3 genuinely-live units: sessA's worker, sessA's agent, sessB's reservation.
  check('machineWideLiveUnits total is exactly the 3 genuinely-live units', usage.total, 3);

  // `currentState`/`currentSessionId` avoid double-counting the caller's own on-disk file
  // when an accurate in-memory copy (e.g. with a same-command-earlier reservation already
  // applied) is supplied instead.
  const withCurrent = PAC.machineWideLiveUnits(dir, now, {
    currentSessionId: 'sessA',
    currentState: { workers: {}, reservations: {}, agents: { toolu_a1: { ts: now }, toolu_a2: { ts: now } } },
  });
  check('currentState overrides that session\'s own on-disk file rather than adding to it',
    withCurrent.subagents, 2);

  const refusal = PAC.formatParallelAgentsRefusal(usage, 3, 18, 0.8);
  check('formatParallelAgentsRefusal names the totals, cores/fraction and ids',
    /3\/3 parallel units live on this machine \(18 cores x 80%\): 2 Orca workers, 1 subagents/.test(refusal), true);
  // H2: every unit is labeled <sid8>:<id>, not a bare id.
  check('formatParallelAgentsRefusal labels sessA\'s worker group <sid8>:<id>', refusal.includes('sessA:ctx_a1'), true);
  check('formatParallelAgentsRefusal labels sessB\'s reservation <sid8>:<id>', refusal.includes('sessB:toolu_b1#0'), true);
  check('formatParallelAgentsRefusal labels sessA\'s subagent <sid8>:<id>', refusal.includes('sessA:toolu_a1'), true);
  // H2: recovery is framed as the operator's call (release-claims / delete a dead session's
  // state file / disable the gate), never as an invitation for the model to raise the limit.
  check('formatParallelAgentsRefusal asks the operator, and offers --release-claims/disabledGates',
    /ask the operator/i.test(refusal) && /--release-claims/.test(refusal) && /disabledGates/.test(refusal), true);
  check('formatParallelAgentsRefusal never invites the model to just raise the limit itself',
    /or raise maxParallelAgents/.test(refusal), false);
  // Review round 3, item 5: the "(N cores x fraction%)" derivation is only ever true when the
  // limit came FROM that derivation — an operator-set explicit limit never went through any
  // core/fraction math, so the message must say so instead of printing a fabricated-looking
  // "(18 cores x 80%)" next to a number the operator picked directly.
  const explicitRefusal = PAC.formatParallelAgentsRefusal(usage, 3, 18, 0.8, { explicitLimit: true });
  check('formatParallelAgentsRefusal says "explicit limit" instead of a cores/fraction derivation when the limit is explicit',
    explicitRefusal.includes('(explicit limit):'), true);
  check('formatParallelAgentsRefusal with an explicit limit never prints the cores x fraction wording',
    /\d+ cores x \d+%/.test(explicitRefusal), false);
  check('formatParallelAgentsRefusal without meta.explicitLimit keeps the derived cores/fraction wording',
    refusal.includes('(18 cores x 80%):'), true);
  // Review round 3, item 5: the recovery hint must name the REAL, ORCH_STATE_DIR-aware state
  // dir, not a hardcoded ~/.claude/orchestrator-gate/ that is wrong whenever ORCH_STATE_DIR
  // points elsewhere (every test in this suite, for one).
  const customDirRefusal = PAC.formatParallelAgentsRefusal(usage, 3, 18, 0.8, { stateDir: '/custom/state/dir' });
  check('formatParallelAgentsRefusal names the real (meta.stateDir) state dir when given one',
    customDirRefusal.includes("delete a dead session's state file under /custom/state/dir/"), true);
  check('formatParallelAgentsRefusal falls back to the ~/.claude/orchestrator-gate/ default when no stateDir is given',
    refusal.includes("delete a dead session's state file under ") && refusal.includes('orchestrator-gate/'), true);

  // M1: another session's units only count while it has a recent liveness signal (its own
  // state file changed recently, OR its heartbeat daemon is alive) — a session with NEITHER
  // signal is presumed abandoned and must not eat into the budget, even though its file is
  // still within the (much longer) 6h staleness window.
  const abandonedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pac-m1-'));
  const writeAt = (dirPath, name, obj, ageMs) => {
    const file = path.join(dirPath, name);
    fs.writeFileSync(file, JSON.stringify(obj));
    if (ageMs != null) {
      const t = (now - ageMs) / 1000;
      fs.utimesSync(file, t, t);
    }
  };
  writeAt(abandonedDir, 'sessAbandoned.json', {
    workers: { ctx_abandoned: { status: 'live', started: now, group: 'ctx_abandoned' } },
    reservations: {}, agents: {},
  }, 40 * 60 * 1000); // mtime 40 minutes old: past the 30-minute recency window
  const abandonedUsage = PAC.machineWideLiveUnits(abandonedDir, now);
  check('M1: a session with no heartbeat and a >30min-stale state file is never counted',
    abandonedUsage.total, 0);

  writeAt(abandonedDir, 'sessRecent.json', {
    workers: { ctx_recent: { status: 'live', started: now, group: 'ctx_recent' } },
    reservations: {}, agents: {},
  }); // fresh mtime (just written): within the 30-minute recency window
  const recentUsage = PAC.machineWideLiveUnits(abandonedDir, now);
  check('M1: a session whose state file changed within the last 30 minutes still counts',
    recentUsage.total, 1);

  fs.rmSync(abandonedDir, { recursive: true, force: true });

  // The other M1 leg: a stale state file whose SESSION's heartbeat daemon is alive still
  // counts. `process.pid` (this very test process) is guaranteed alive. Own fresh dir so
  // the earlier `sessRecent`/`sessAbandoned` fixtures above cannot contaminate this count.
  const hbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pac-m1-hb-'));
  writeAt(hbDir, 'sessHbAlive.json', {
    workers: { ctx_hb: { status: 'live', started: now, group: 'ctx_hb' } },
    reservations: {}, agents: {},
  }, 40 * 60 * 1000);
  fs.writeFileSync(path.join(hbDir, 'heartbeat-sessHbAlive.json'),
    JSON.stringify({ pid: process.pid, last_tick: now, interval: 20 }));
  const hbAliveUsage = PAC.machineWideLiveUnits(hbDir, now);
  check('M1: a >30min-stale session whose heartbeat daemon IS alive still counts',
    hbAliveUsage.total, 1);
  fs.rmSync(hbDir, { recursive: true, force: true });

  fs.rmSync(dir, { recursive: true, force: true });
}

// --- gate.cjs: parseCodeModel / describeOverride / currentExecRoute / escapeRegex ----

{
  const cfg = config.loadConfig(); // default config: opus/fable/sonnet/haiku/codex
  check('escapeRegex escapes regex metacharacters', gate.escapeRegex('a.b+c'), 'a\\.b\\+c');

  check('parseCodeModel: auto clears the override', gate.parseCodeModel(cfg, 'auto'), null);
  check('parseCodeModel: the code alias maps to "code"', gate.parseCodeModel(cfg, 'sonnet'), 'code');
  check('parseCodeModel: the review alias maps to claude:<alias>', gate.parseCodeModel(cfg, 'opus'), 'claude:opus');
  check('parseCodeModel: the escalation alias maps to claude:<alias>', gate.parseCodeModel(cfg, 'fable'), 'claude:fable');
  check('parseCodeModel: the lookup alias maps to claude:<alias>', gate.parseCodeModel(cfg, 'haiku'), 'claude:haiku');
  check('parseCodeModel: bare codex', gate.parseCodeModel(cfg, 'codex'), 'codex');
  check('parseCodeModel: codex:<model>', gate.parseCodeModel(cfg, 'codex:gpt-5-custom'), 'codex:gpt-5-custom');
  check('parseCodeModel: a gpt- id is treated as a codex model', gate.parseCodeModel(cfg, 'gpt-5.6-sol'), 'codex:gpt-5.6-sol');
  check('parseCodeModel: a gpt id is lower-cased', gate.parseCodeModel(cfg, 'GPT-5.6-Sol'), 'codex:gpt-5.6-sol');
  check('parseCodeModel: an unknown word is invalid', gate.parseCodeModel(cfg, 'banana'), 'invalid');
  check('parseCodeModel: a value with "/" is rejected, never truncated', gate.parseCodeModel(cfg, 'codex:openai/gpt-5'), 'invalid');

  check('describeOverride: codex', gate.describeOverride(cfg, 'codex'), 'Codex in an Orca worker');
  check('describeOverride: codex:<model>', gate.describeOverride(cfg, 'codex:gpt-5-custom'), 'Codex (gpt-5-custom) in an Orca worker');
  check('describeOverride: code alias', gate.describeOverride(cfg, 'code'), 'in-session Agent with model "sonnet"');
  check('describeOverride: claude:<alias>', gate.describeOverride(cfg, 'claude:opus'), 'in-session Agent with model "opus"');

  check('currentExecRoute: operator override "code"',
    gate.currentExecRoute(cfg, { execAgent: 'code' }).route, 'code');
  check('currentExecRoute: operator override "codex"',
    gate.currentExecRoute(cfg, { execAgent: 'codex' }).route, 'codex');
  check('currentExecRoute: operator override "codex:<model>" carries the model',
    gate.currentExecRoute(cfg, { execAgent: 'codex:gpt-5-custom' }).codexModel, 'gpt-5-custom');
  check('currentExecRoute: operator override "claude:opus" carries the alias',
    gate.currentExecRoute(cfg, { execAgent: 'claude:opus' }).alias, 'opus');

  check('activationApplies: off is never active', gate.activationApplies({ activation: 'off' }), false);
  check('activationApplies: always is always active', gate.activationApplies({ activation: 'always' }), true);
  {
    const had = process.env.ORCA_TERMINAL_HANDLE;
    delete process.env.ORCA_TERMINAL_HANDLE;
    check('activationApplies: orca-only without a terminal handle is inactive',
      gate.activationApplies({ activation: 'orca-only' }), false);
    process.env.ORCA_TERMINAL_HANDLE = 'term_x';
    check('activationApplies: orca-only with a terminal handle is active',
      gate.activationApplies({ activation: 'orca-only' }), true);
    if (had === undefined) delete process.env.ORCA_TERMINAL_HANDLE; else process.env.ORCA_TERMINAL_HANDLE = had;
  }

  // hasFlag / flagValue: orcaInvocations() args are shell words, so `--spec=x.md` is one
  // word, not `--spec` followed by `x.md` - these must recognise both forms.
  check('hasFlag: space-separated form', gate.hasFlag(['--spec', 'x.md'], '--spec'), true);
  check('hasFlag: =-joined form', gate.hasFlag(['--spec=x.md'], '--spec'), true);
  check('hasFlag: absent', gate.hasFlag(['--other'], '--spec'), false);
  check('hasFlag: does not match a longer flag name as a prefix', gate.hasFlag(['--spectacular'], '--spec'), false);
  check('flagValue: space-separated form', gate.flagValue(['--agent', 'codex'], '--agent'), 'codex');
  check('flagValue: =-joined form', gate.flagValue(['--agent=codex'], '--agent'), 'codex');
  check('flagValue: absent is undefined', gate.flagValue(['--other'], '--agent'), undefined);
}

// Exec routing by quota left: pure decision table.
{
  const { pickExecRoute } = require('../hooks/lib/exec-route-by-quota.cjs');
  check('pickExecRoute default keeps Codex below 95% used', pickExecRoute(90, 6), 'codex');
  check('pickExecRoute default hands off at 95% used', pickExecRoute(90, 5), 'sonnet');
  const cases = [
    // Codex first; the code model once Codex has used >= 95% (i.e. <= 5% left).
    [[90, 90], 'codex'], [[90, 6], 'codex'], [[90, 5], 'sonnet'], [[10, 1], 'sonnet'],
    [[null, 3], 'sonnet'], [[90, null], 'codex'], [[null, null], 'codex'], [[5, 80], 'codex'],
  ];
  for (const [[c, x], want] of cases) {
    const got = pickExecRoute(c, x, 95);
    if (got === want) pass += 1; else failures.push(`pickExecRoute(${c}, ${x}, 95) = ${got}, want ${want}`);
  }
  check('pickExecRoute: a lower handoff threshold hands off sooner', pickExecRoute(90, 45, 50), 'sonnet');
  check('pickExecRoute: the same reading stays with Codex at a higher threshold', pickExecRoute(90, 45, 70), 'codex');
}

// Quota math against fixture files (no live data). Claude quota is fully optional:
// it must read only when an explicit cache path is configured.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-math-'));
  const now = Date.UTC(2026, 8, 28, 12);
  const day = path.join(root, 'codex', '2026', '09', '28');
  fs.mkdirSync(day, { recursive: true });
  const rl = (primary, secondary) => JSON.stringify({ payload: { rate_limits: { primary, secondary } } });
  const writeCodex = (name, lines, mtime) => {
    const f = path.join(day, name); fs.writeFileSync(f, lines.join('\n') + '\n');
    fs.utimesSync(f, mtime / 1000, mtime / 1000);
  };
  const future = now / 1000 + 3600;
  // Older file with limits; newer file without any (a session before its first turn).
  writeCodex('a.jsonl', [rl({ used_percent: 30, resets_at: future }, { used_percent: 70, resets_at: future })], now - 60000);
  writeCodex('b.jsonl', ['{"type":"session_meta"}'], now - 1000);
  process.env.CODEX_SESSIONS_DIR = path.join(root, 'codex');
  // Point explicitly at a file that does not exist, rather than relying on the real
  // machine's os.tmpdir() fallback being empty — a real ClaudeKit cache may well sit
  // there, which would make this assertion depend on this machine's state.
  process.env.CK_USAGE_CACHE_PATH = path.join(root, 'no-such-claude-cache.json');
  const q = require('../hooks/lib/exec-route-by-quota.cjs');
  const eq = (name, got, want) => { if (got === want) pass += 1; else failures.push(`${name}: got ${got}, want ${want}`); };
  eq('claude: an explicitly configured but missing cache path is unknown', q.claudeRemaining(now), null);
  eq('codex: newer file without limits falls through; secondary is the tighter window', q.codexRemaining(now), 30);
  writeCodex('c.jsonl', [rl({ used_percent: 95, resets_at: now / 1000 - 60 }, null)], now);
  eq('codex: a window past resets_at counts as 0% used', q.codexRemaining(now), 100);
  eq('codex: a session-log reading older than 6h is ignored', q.codexRemaining(now + 30 * 86400000), null);
  writeCodex('d.jsonl', [rl({ used_percent: 0.5, resets_at: future }, null)], now + 1);
  eq('codex: used_percent in (0,1) is a genuine low reading, never treated as a fraction', q.codexRemaining(now), 99.5);

  const cache = path.join(root, 'claude.json');
  process.env.CK_USAGE_CACHE_PATH = cache;
  const writeClaude = (data, ts = now) => fs.writeFileSync(cache, JSON.stringify({ timestamp: ts, status: 'available', data }));
  writeClaude({ five_hour: { utilization: 40, resets_at: new Date(now + 3600e3).toISOString() }, seven_day: { utilization: 10 } });
  eq('claude: tightest window (when a cache path is explicitly configured)', q.claudeRemaining(now), 60);
  writeClaude({ five_hour: { utilization: 100, resets_at: new Date(now - 60e3).toISOString() }, seven_day: { utilization: 10 } });
  eq('claude: a reset 5h window counts as 0%', q.claudeRemaining(now), 90);
  writeClaude({ five_hour: { utilization: 0.3 }, seven_day: { utilization: 5 }, seven_day_sonnet: { utilization: 20 } });
  eq('claude: fraction + seven_day_sonnet', q.claudeRemaining(now), 70);
  writeClaude({ five_hour: { utilization: 5 } }, now - 7 * 3600e3);
  eq('claude: cache older than 6h is unknown', q.claudeRemaining(now), null);
  delete process.env.CODEX_SESSIONS_DIR; delete process.env.CK_USAGE_CACHE_PATH;
  fs.rmSync(root, { recursive: true, force: true });
}

// Live Codex quota via app-server, including cache and every fallback edge. The stub
// speaks the real initialize -> initialized -> account/rateLimits/read exchange.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-live-'));
  const stateDir = path.join(root, 'state');
  const sessions = path.join(root, 'sessions');
  const day = path.join(sessions, '2026', '09', '29');
  fs.mkdirSync(day, { recursive: true });
  const stub = path.join(__dirname, 'fixtures', 'codex-app-server-stub.cjs');
  try { fs.chmodSync(stub, 0o755); } catch {}
  const oldEnv = {};
  for (const key of ['ORCH_CODEX_BIN', 'STUB_CODEX_MODE', 'STUB_CODEX_PRIMARY_USED',
    'STUB_CODEX_SECONDARY_USED', 'STUB_CODEX_PRIMARY_RESET', 'STUB_CODEX_SECONDARY_RESET',
    'CODEX_SESSIONS_DIR']) oldEnv[key] = process.env[key];
  process.env.ORCH_CODEX_BIN = stub;
  process.env.CODEX_SESSIONS_DIR = sessions;
  const q = require('../hooks/lib/exec-route-by-quota.cjs');
  const eq = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) pass += 1;
    else failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  const clearCache = () => { try { fs.unlinkSync(path.join(stateDir, 'codex-quota-live.json')); } catch {} };
  const clearStub = () => {
    delete process.env.STUB_CODEX_MODE;
    delete process.env.STUB_CODEX_SECONDARY_USED;
    delete process.env.STUB_CODEX_PRIMARY_RESET;
    delete process.env.STUB_CODEX_SECONDARY_RESET;
  };

  const callsLog = path.join(root, 'codex-calls.log');

  const contendedStateDir = path.join(root, 'contended-state');
  fs.mkdirSync(contendedStateDir, { recursive: true });
  const contendedNow = Date.now();
  fs.writeFileSync(path.join(contendedStateDir, 'codex-quota-live.json'), JSON.stringify({
    usedPercent: 33,
    resetsAt: Math.floor(contendedNow / 1000) + 3600,
    fetchedAt: contendedNow - 120_000,
  }));
  const probeLease = path.join(contendedStateDir, '.codex-quota-probe.lock');
  const heldProbeLease = acquireLock(probeLease, { timeoutMs: 50, retryMs: 5 });
  try {
    const firstStarted = Date.now();
    const firstContended = q.codexQuota(contendedNow, { stateDir: contendedStateDir, cacheSeconds: 60 });
    const firstElapsed = Date.now() - firstStarted;
    const secondStarted = Date.now();
    const secondContended = q.codexQuota(contendedNow + 1, { stateDir: contendedStateDir, cacheSeconds: 60 });
    const secondElapsed = Date.now() - secondStarted;
    eq('codex live contention: both reads use the stale quota fallback',
      [firstContended.usedPercent, secondContended.usedPercent], [33, 33]);
    check('codex live contention: two reads in one process wait for the held lease at most once',
      firstElapsed >= 250 && secondElapsed < 150, true);
  } finally {
    if (heldProbeLease) releaseLock(probeLease);
  }

  clearStub(); clearCache();
  process.env.STUB_CODEX_PRIMARY_USED = '25';
  let quota = q.codexQuota(Date.now(), { stateDir, cacheSeconds: 60 });
  eq('codex live: app-server reading is used', [quota.usedPercent, quota.source], [25, 'live']);
  eq('codex reminder: a live reading names the live source',
    q.execRoute(95, quota.fetchedAt, { stateDir, cacheSeconds: 60 }).summary.includes('Codex 75% left (live, 0s ago)'), true);

  process.env.STUB_CODEX_PRIMARY_USED = '90';
  const cached = q.codexQuota(quota.fetchedAt + 30_000, { stateDir, cacheSeconds: 60 });
  eq('codex live cache: a fresh value wins before another probe', cached.usedPercent, 25);
  eq('codex reminder: a cached live reading includes its age',
    q.execRoute(95, quota.fetchedAt + 30_000, { stateDir, cacheSeconds: 60 }).summary.includes('Codex 75% left (live, 30s ago)'), true);
  const refreshed = q.codexQuota(quota.fetchedAt + 60_000, { stateDir, cacheSeconds: 60 });
  eq('codex live cache: an expired value is refreshed', refreshed.usedPercent, 90);

  clearCache(); clearStub();
  const crossoverNow = Date.now();
  process.env.STUB_CODEX_PRIMARY_USED = '70';
  process.env.STUB_CODEX_SECONDARY_USED = '60';
  process.env.STUB_CODEX_PRIMARY_RESET = String(Math.floor(crossoverNow / 1000) + 30);
  process.env.STUB_CODEX_SECONDARY_RESET = String(Math.floor(crossoverNow / 1000) + 3600);
  quota = q.codexQuota(crossoverNow, { stateDir, cacheSeconds: 60 });
  eq('codex live cache: the initially tighter window is cached', quota.usedPercent, 70);
  quota = q.codexQuota(Math.floor(crossoverNow / 1000) * 1000 + 30_000, { stateDir, cacheSeconds: 60 });
  eq('codex live cache: the exact reset invalidates cache so the active secondary wins', quota.usedPercent, 60);

  clearCache(); clearStub();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'codex-quota-live.json'), JSON.stringify({
    usedPercent: 80, fetchedAt: Date.now(),
  }));
  process.env.STUB_CODEX_PRIMARY_USED = '35';
  quota = q.codexQuota(Date.now(), { stateDir, cacheSeconds: 60 });
  eq('codex live cache: a malformed schema is ignored in favour of live data', quota.usedPercent, 35);

  clearCache(); clearStub();
  process.env.STUB_CODEX_PRIMARY_USED = '10';
  process.env.STUB_CODEX_SECONDARY_USED = '70';
  quota = q.codexQuota(Date.now(), { stateDir, cacheSeconds: 60 });
  eq('codex live: secondary wins when it is tighter than primary', quota.usedPercent, 70);
  eq('codex live: a denied ordinary-use flag needs no quota windows to count as limit reached',
    q.parseLiveQuota({ ordinaryUsageAllowed: false }), { usedPercent: 100, resetsAt: 0, limitReached: true });

  clearCache(); clearStub();
  process.env.STUB_CODEX_PRIMARY_USED = '95';
  process.env.STUB_CODEX_PRIMARY_RESET = String(Math.floor(Date.now() / 1000) - 1);
  quota = q.codexQuota(Date.now(), { stateDir, cacheSeconds: 60 });
  eq('codex live: a passed reset counts as zero percent used', quota.usedPercent, 0);

  clearCache(); clearStub();
  process.env.STUB_CODEX_PRIMARY_USED = '5';
  process.env.STUB_CODEX_RATE_LIMIT_REACHED_TYPE = 'ordinary';
  quota = q.codexQuota(Date.now(), { stateDir, cacheSeconds: 60 });
  eq('codex live: rateLimitReachedType is treated as fully used', [quota.usedPercent, quota.limitReached], [100, true]);
  eq('codex reminder: a reached limit is surfaced explicitly',
    q.execRoute(95, quota.fetchedAt, { stateDir, cacheSeconds: 60 }).summary.includes('limit reached'), true);
  delete process.env.STUB_CODEX_RATE_LIMIT_REACHED_TYPE;

  clearCache(); clearStub();
  process.env.STUB_CODEX_PRIMARY_USED = '5';
  process.env.STUB_CODEX_ORDINARY_USAGE_ALLOWED = 'false';
  quota = q.codexQuota(Date.now(), { stateDir, cacheSeconds: 60 });
  eq('codex live: ordinaryUsageAllowed=false is treated as fully used', quota.usedPercent, 100);
  delete process.env.STUB_CODEX_ORDINARY_USAGE_ALLOWED;

  const sessionFile = path.join(day, 'fallback.jsonl');
  const sessionNow = Date.now();
  fs.writeFileSync(sessionFile, `${JSON.stringify({ timestamp: new Date(sessionNow - 5 * 60_000).toISOString(), payload: { rate_limits: {
    primary: { used_percent: 65, resets_at: Math.floor(sessionNow / 1000) + 3600 },
  } } })}\n`);
  fs.utimesSync(sessionFile, sessionNow / 1000, sessionNow / 1000);

  clearCache(); clearStub();
  process.env.STUB_CODEX_MODE = 'malformed';
  quota = q.codexQuota(sessionNow, { stateDir, cacheSeconds: 60 });
  eq('codex live: a malformed reply falls back to the session log', [quota.usedPercent, quota.source], [65, 'session log']);
  eq('codex reminder: a session fallback names its source and age',
    q.execRoute(95, sessionNow, { stateDir, cacheSeconds: 0 }).summary.includes('Codex 35% left (session log, 5m old)'), true);

  clearCache(); clearStub();
  process.env.STUB_CODEX_MODE = 'timeout';
  quota = q.codexQuota(sessionNow, { stateDir, cacheSeconds: 60 });
  eq('codex live: a timeout falls back to the session log', [quota.usedPercent, quota.source], [65, 'session log']);

  clearCache();
  fs.rmSync(sessions, { recursive: true, force: true });
  process.env.STUB_CODEX_MODE = 'malformed';
  const route = q.execRoute(95, sessionNow, { stateDir, cacheSeconds: 0 });
  eq('codex live: malformed with no session is unknown and keeps Codex', [route.codexSource, route.route], ['unknown', 'codex']);
  eq('codex reminder: an unknown reading names the unknown source', route.summary.includes('Codex unknown (unknown)'), true);

  clearCache();
  try { fs.unlinkSync(callsLog); } catch {}
  process.env.STUB_CODEX_CALLS_LOG = callsLog;
  q.codexQuota(sessionNow, { stateDir, cacheSeconds: 60 });
  q.codexQuota(sessionNow + 1, { stateDir, cacheSeconds: 60 });
  const failedProbeCalls = fs.readFileSync(callsLog, 'utf8').trim().split('\n').filter(Boolean).length;
  eq('codex live failure is cached and memoized for the configured TTL', failedProbeCalls, 1);
  delete process.env.STUB_CODEX_CALLS_LOG;

  clearCache(); clearStub();
  try { fs.unlinkSync(callsLog); } catch {}
  process.env.STUB_CODEX_CALLS_LOG = callsLog;
  process.env.STUB_CODEX_PRIMARY_USED = '28';
  q.codexQuota(sessionNow, { stateDir, cacheSeconds: 0 });
  q.codexQuota(sessionNow + 1, { stateDir, cacheSeconds: 0 });
  const zeroTtlProbeCalls = fs.readFileSync(callsLog, 'utf8').trim().split('\n').filter(Boolean).length;
  eq('codex live: zero file-cache TTL still keeps one process-local probe result', zeroTtlProbeCalls, 1);
  delete process.env.STUB_CODEX_CALLS_LOG;

  clearCache(); clearStub();
  const oldOrchBin = process.env.ORCH_CODEX_BIN;
  delete process.env.ORCH_CODEX_BIN;
  process.env.CODEX_BIN = stub;
  process.env.STUB_CODEX_PRIMARY_USED = '12';
  quota = q.codexQuota(Date.now(), { stateDir, cacheSeconds: 60 });
  eq('codex live: legacy CODEX_BIN remains an accepted probe alias', quota.usedPercent, 12);
  process.env.ORCH_CODEX_BIN = oldOrchBin;
  delete process.env.CODEX_BIN;

  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
}

// The live-quota helper owns its app-server child after its synchronous parent dies. Its
// internal deadline must kill a child that ignores SIGTERM, then let the orphaned helper
// exit on its own. This never invokes the real Codex binary: ORCH_CODEX_BIN is the stub.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-orphan-'));
  const pidFile = path.join(root, 'stub.pid');
  const stub = path.join(__dirname, 'fixtures', 'codex-app-server-stub.cjs');
  const quotaLib = path.join(__dirname, '..', 'hooks', 'lib', 'exec-route-by-quota.cjs');
  const parent = spawn(process.execPath, ['-e', 'require(process.argv[1]).liveQuota()', quotaLib], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ORCH_CODEX_BIN: stub,
      STUB_CODEX_MODE: 'ignore-signals',
      STUB_CODEX_PID_FILE: pidFile,
    },
  });
  parent.unref();
  const waitUntil = (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      spawnSync('sleep', ['0.05']);
    }
    return predicate();
  };
  const pidWritten = waitUntil(() => fs.existsSync(pidFile), 2000);
  let stubPid = null;
  if (pidWritten) stubPid = Number(fs.readFileSync(pidFile, 'utf8'));
  try { process.kill(parent.pid, 'SIGKILL'); } catch {}
  const isAlive = (pid) => {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const childExited = waitUntil(() => !isAlive(stubPid), 6000);
  check('codex quota helper kills its stubborn child after the parent is killed mid-probe',
    [pidWritten, childExited], [true, true]);
  try { process.kill(-parent.pid, 'SIGKILL'); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}

// --- ownership.cjs: parseOwns ------------------------------------------------

{
  const REPO = '/work/proj'; // synthetic repo root — never resolved against real fs

  check('parseOwns: no Owns: line at all',
    OWN.parseOwns('Implement the thing.', { repoRoot: REPO }),
    { present: false, isNA: false, owns: [], reason: null });

  check('parseOwns: a simple list, comma and space separated',
    OWN.parseOwns('Do the work.\nOwns: src/api/**, src/models/user.ts foo/bar.py', { repoRoot: REPO }).owns,
    ['src/api/**', 'src/models/user.ts', 'foo/bar.py']);

  check('parseOwns: multi-line Owns: contributes to one combined, deduped list',
    OWN.parseOwns('x\nOwns: src/api/**\ny\nOwns: src/api/**, src/models/user.ts', { repoRoot: REPO }).owns,
    ['src/api/**', 'src/models/user.ts']);

  check('parseOwns: n/a claims nothing and captures the reason',
    OWN.parseOwns('x\nOwns: n/a text-only change', { repoRoot: REPO }),
    { present: true, isNA: true, owns: [], reason: 'text-only change' });

  check('parseOwns: n/a on any one of several Owns: lines wins for the whole brief',
    OWN.parseOwns('x\nOwns: src/api/**\ny\nOwns: n/a research only', { repoRoot: REPO }).isNA,
    true);

  check('parseOwns: a `..` segment is refused, not partially resolved',
    OWN.parseOwns('x\nOwns: ../../etc/passwd, src/ok.ts', { repoRoot: REPO }).owns,
    ['src/ok.ts']);

  check('parseOwns: an absolute path under the repo root is made relative',
    OWN.parseOwns(`x\nOwns: ${REPO}/src/api/handler.ts`, { repoRoot: REPO }).owns,
    ['src/api/handler.ts']);

  check('parseOwns: an absolute path outside the repo root is refused',
    OWN.parseOwns('x\nOwns: /etc/passwd', { repoRoot: REPO }).owns,
    []);

  check('parseOwns: an absolute path with no known repo root is refused (cannot relativize)',
    OWN.parseOwns(`x\nOwns: ${REPO}/src/api/handler.ts`, {}).owns,
    []);

  check('parseOwns: leading ./ and trailing / are cosmetic',
    OWN.parseOwns('x\nOwns: ./src/api/, `src/models/`', { repoRoot: REPO }).owns,
    ['src/api', 'src/models']);

  check('parseOwns: a `- Owns:` / `* owns:` bullet prefix is recognised, case-insensitively',
    OWN.parseOwns('- Owns: a.ts\n* owns: b.ts', { repoRoot: REPO }).owns,
    ['a.ts', 'b.ts']);

  const many = OWN.parseOwns(`x\nOwns: ${Array.from({ length: 80 }, (_, i) => `f${i}.ts`).join(', ')}`, { repoRoot: REPO });
  check('parseOwns: capped at 64 items', many.owns.length, 64);
}

// --- ownership.cjs: ownsOverlap (>= 15 cases) --------------------------------

{
  const cases = [
    ['literal/literal: identical', 'src/api/user.ts', 'src/api/user.ts', true],
    ['literal/literal: unrelated files', 'src/api/user.ts', 'src/api/order.ts', false],
    ['literal/literal: directory is a prefix of a file inside it', 'src/api', 'src/api/user.ts', true],
    ['literal/literal: file inside vs directory (order swapped)', 'src/api/user.ts', 'src/api', true],
    ['literal/literal: sibling directory that merely shares a string prefix', 'src/api', 'src/api2/user.ts', false],
    ['literal/literal: nested directories, one inside the other', 'src/api', 'src/api/v2', true],
    ['glob/literal: file matches the glob', 'src/api/**', 'src/api/user.ts', true],
    ['glob/literal (swapped): file matches the glob', 'src/api/user.ts', 'src/api/**', true],
    ['glob/literal: the bare directory itself overlaps its own glob', 'src/api', 'src/api/**', true],
    ['glob/literal: file outside the glob\'s directory', 'src/models/**', 'src/api/user.ts', false],
    // Even though the literal doesn't match the glob's regex, it still shares the glob's
    // own directory, so the "directory-prefix of the glob's literal prefix" fallback fires
    // (a deliberate err-toward-conflict per the design) — only a genuinely different
    // directory (sibling, not nested) escapes it, as the next case shows.
    ['glob/literal: a non-matching file in the SAME directory as the glob still conflicts (directory-prefix fallback)',
      'src/api/*.ts', 'src/api/sub/user.ts', true],
    ['glob/literal: single-star matches within one segment', 'src/api/*.ts', 'src/api/user.ts', true],
    ['glob/literal: a sibling directory that only shares a string prefix does not conflict',
      'src/api/*.ts', 'src/api-other/user.ts', false],
    ['glob/literal: question mark matches exactly one character', 'src/api/user?.ts', 'src/api/user1.ts', true],
    ['glob/literal: question mark literal mismatch in the SAME directory still conflicts (directory-prefix fallback)',
      'src/api/user?.ts', 'src/api/user.ts', true],
    ['glob/literal: brace alternation', 'src/api/{user,order}.ts', 'src/api/order.ts', true],
    ['glob/literal: brace alternation, no exact match, but SAME directory still conflicts (directory-prefix fallback)',
      'src/api/{user,order}.ts', 'src/api/ticket.ts', true],
    ['glob/literal: brace alternation in a different directory does not conflict',
      'src/api/{user,order}.ts', 'src/models/ticket.ts', false],
    ['glob/glob: nested glob directories conflict', 'src/api/**', 'src/api/user/**', true],
    ['glob/glob: sibling glob directories do not conflict', 'src/api/**', 'src/models/**', false],
    ['glob/glob: identical globs conflict', 'src/api/*.ts', 'src/api/*.ts', true],
    ['`**` conflicts with everything else', '**', 'src/api/user.ts', true],
    ['`**` conflicts with another `**`', '**', '**', true],
  ];
  for (const [name, a, b, want] of cases) {
    check(`ownsOverlap: ${name}`, OWN.ownsOverlap(a, b), want);
    check(`ownsOverlap (symmetric): ${name}`, OWN.ownsOverlap(b, a), want);
  }
}

// --- ownership.cjs: workspaceKey ----------------------------------------------

check('workspaceKey: non-isolated, no --worktree value, is "<root>|current"',
  OWN.workspaceKey({ repoRootDir: '/work/proj', worktreeValue: null, isolated: false }),
  '/work/proj|current');
check('workspaceKey: non-isolated with a named worktree',
  OWN.workspaceKey({ repoRootDir: '/work/proj', worktreeValue: 'feature-x', isolated: false }),
  '/work/proj|feature-x');
{
  const a = OWN.workspaceKey({ repoRootDir: '/work/proj', worktreeValue: 'new-child', isolated: true });
  const b = OWN.workspaceKey({ repoRootDir: '/work/proj', worktreeValue: 'new-child', isolated: true });
  check('workspaceKey: isolated keys are unique per call (never conflict)', a === b, false);
  check('workspaceKey: isolated keys are tagged iso:', a.startsWith('iso:'), true);
}

// --- worker-groups.cjs: countLiveGroups (Section 0 bug #1: triple worker records) --

{
  // One worker-start reply naming dispatch id, task id AND terminal handle for the SAME
  // worker must count as ONE live codex group, not three.
  const workers = {
    ctx_a: { status: 'live', agent: 'codex', group: 'ctx_a' },
    task_a: { status: 'live', agent: 'codex', group: 'ctx_a' },
    term_a: { status: 'live', agent: 'codex', group: 'ctx_a' },
  };
  check('countLiveGroups: triple ids from one worker-start count once', WG.countLiveGroups(workers, 'codex'), 1);

  const twoWorkers = {
    ...workers,
    ctx_b: { status: 'live', agent: 'codex', group: 'ctx_b' },
  };
  check('countLiveGroups: a second, distinct group counts separately', WG.countLiveGroups(twoWorkers, 'codex'), 2);

  const withPending = { ...workers, 'pending-1': { status: 'live', agent: 'codex' } }; // no `group` (legacy) -> own group
  check('countLiveGroups: a pending/legacy entry without `group` counts as its own group',
    WG.countLiveGroups(withPending, 'codex'), 2);

  const withClaude = { ...workers, ctx_c: { status: 'live', agent: 'claude', group: 'ctx_c' } };
  check('countLiveGroups: a non-codex agent is never counted', WG.countLiveGroups(withClaude, 'codex'), 1);

  const withSettled = { ...workers, ctx_d: { status: 'settled', agent: 'codex', group: 'ctx_d' } };
  check('countLiveGroups: a settled entry is never counted', WG.countLiveGroups(withSettled, 'codex'), 1);
}

check('worker-groups: canonicalGroup prefers ctx_ over task_/term_',
  WG.canonicalGroup(new Set(['term_z', 'task_y', 'ctx_x'])), 'ctx_x');
check('worker-groups: canonicalGroup falls back to task_ when no ctx_',
  WG.canonicalGroup(new Set(['term_z', 'task_y'])), 'task_y');
check('worker-groups: canonicalGroup falls back to term_ when only a handle is present',
  WG.canonicalGroup(new Set(['term_z'])), 'term_z');
check('worker-groups: kindOf a terminal handle', WG.kindOf('term_x'), 'terminal');
check('worker-groups: kindOf a dispatch id', WG.kindOf('ctx_x'), 'worker');

// --- worker-groups.cjs: releaseTarget / settleGroup (Section 0 bug #2) -------

{
  const flagValue = gate.flagValue;
  const releaseInv = (cmd) => orcaInvocations(cmd).find((inv) => WG.RELEASE_SUBS.has(inv.sub));

  check('releaseTarget: --dispatch flag, trailing --json never mistaken for the target',
    WG.releaseTarget(releaseInv('orca orchestration worker-release --dispatch ctx_x --json'), flagValue),
    'ctx_x');
  check('releaseTarget: =-joined --dispatch',
    WG.releaseTarget(releaseInv('orca orchestration worker-release --dispatch=ctx_x --json'), flagValue),
    'ctx_x');
  check('releaseTarget: positional fallback for worker-stop',
    WG.releaseTarget(releaseInv('orca orchestration worker-stop ctx_x'), flagValue),
    'ctx_x');
  check('releaseTarget: positional fallback for worker-abandon',
    WG.releaseTarget(releaseInv('orca orchestration worker-abandon ctx_x'), flagValue),
    'ctx_x');
  check('releaseTarget: terminal close, positional handle after the subcommand words',
    WG.releaseTarget(releaseInv('orca terminal close term_x'), flagValue),
    'term_x');
  check('releaseTarget: a release command with nothing after it targets nothing',
    WG.releaseTarget(releaseInv('orca orchestration worker-release --json'), flagValue),
    null);
  check('releaseTarget: a non-release invocation is never a release target',
    WG.releaseTarget(orcaInvocations('orca orchestration worker-start --task t')[0], flagValue),
    null);

  const workers = {
    ctx_a: { status: 'live', group: 'ctx_a' },
    task_a: { status: 'live', group: 'ctx_a' },
    term_a: { status: 'live', group: 'ctx_a' },
    ctx_b: { status: 'live', group: 'ctx_b' },
  };
  check('settleGroup: settling one id settles every entry sharing its group',
    (() => { WG.settleGroup(workers, WG.groupOf(workers.ctx_a, 'ctx_a')); return [workers.ctx_a.status, workers.task_a.status, workers.term_a.status, workers.ctx_b.status]; })(),
    ['settled', 'settled', 'settled', 'live']);
}

// --- ownership-claims.cjs -----------------------------------------------------

{
  const s = { workers: {}, reservations: {}, agentClaims: {} };
  check('liveClaims: empty state has no claims', OC.liveClaims(s, 120, null).length, 0);

  s.workers.ctx_a = { status: 'live', group: 'ctx_a', owns: ['src/api/**'], ws: '/r|current', started: Date.now() };
  s.reservations['r1'] = { ts: Date.now(), owns: ['src/models/x.ts'], ws: '/r|current' };
  s.agentClaims['tu_1'] = { owns: ['docs/**'], ws: '/r|current', ts: Date.now() };
  const claims = OC.liveClaims(s, 120, null);
  check('liveClaims: gathers all three sources', claims.map((c) => c.id).sort(), ['ctx_a', 'r1', 'tu_1'].sort());

  check('liveClaims: excludeGroup omits that worker group',
    OC.liveClaims(s, 120, 'ctx_a').map((c) => c.id).sort(), ['r1', 'tu_1'].sort());

  const conflict = OC.findOverlap(claims, '/r|current', ['src/api/handler.ts']);
  check('findOverlap: finds the conflicting worker claim', conflict && conflict.id, 'ctx_a');
  check('findOverlap: no conflict in a different workspace',
    OC.findOverlap(claims, '/other|current', ['src/api/handler.ts']), null);
  check('findOverlap: no conflict when nothing overlaps',
    OC.findOverlap(claims, '/r|current', ['totally/unrelated.ts']), null);

  const oldAgentClaim = { workers: {}, reservations: {}, agentClaims: { tu_2: { owns: ['x.ts'], ws: 'w', ts: Date.now() - 130 * 60 * 1000 } } };
  check('claimExpired: an agent claim past ownershipClaimTtlMinutes is expired',
    OC.liveClaims(oldAgentClaim, 120, null).length, 0);
  const freshAgentClaim = { workers: {}, reservations: {}, agentClaims: { tu_3: { owns: ['x.ts'], ws: 'w', ts: Date.now() - 60 * 1000 } } };
  check('claimExpired: a fresh agent claim within TTL is live',
    OC.liveClaims(freshAgentClaim, 120, null).length, 1);

  const oldReservation = { workers: {}, reservations: { r2: { ts: Date.now() - 11 * 60 * 1000, owns: ['x.ts'], ws: 'w' } }, agentClaims: {} };
  check('reservationExpired: a reservation past the 10-minute TTL is expired',
    OC.liveClaims(oldReservation, 120, null).length, 0);

  check('countPendingCodexReservations: only unexpired reservations with codexSlot count',
    OC.countPendingCodexReservations({ reservations: {
      a: { ts: Date.now(), codexSlot: true },
      b: { ts: Date.now(), codexSlot: false },
      c: { ts: Date.now() - 20 * 60 * 1000, codexSlot: true }, // expired
    } }),
    1);
}

// --- gate.cjs: resolveWorkerStartAgent / liveCodexGroupIds --------------------

{
  const inv = (cmd) => orcaInvocations(cmd)[0];
  check('resolveWorkerStartAgent: explicit --agent wins',
    gate.resolveWorkerStartAgent(inv('orca orchestration worker-start --agent codex --task t'), { workers: {} }), 'codex');
  check('resolveWorkerStartAgent: explicit non-codex agent is respected',
    gate.resolveWorkerStartAgent(inv('orca orchestration worker-start --agent claude --task t'), { workers: {} }), 'claude');
  check('resolveWorkerStartAgent: no --agent, no --terminal defaults to codex',
    gate.resolveWorkerStartAgent(inv('orca orchestration worker-start --task t'), { workers: {} }), 'codex');
  {
    const s = { workers: { term_x: { status: 'live', group: 'term_x', agent: 'claude' } } };
    check('resolveWorkerStartAgent: --terminal of a tracked non-codex group uses its stored agent',
      gate.resolveWorkerStartAgent(inv('orca orchestration worker-start --terminal term_x'), s), 'claude');
  }
  {
    const s = { workers: {} };
    check('resolveWorkerStartAgent: --terminal of an UNtracked handle defaults to codex',
      gate.resolveWorkerStartAgent(inv('orca orchestration worker-start --terminal term_unknown'), s), 'codex');
  }

  check('liveCodexGroupIds: names distinct live codex groups',
    gate.liveCodexGroupIds({ workers: { ctx_a: { status: 'live', agent: 'codex', group: 'ctx_a' }, task_a: { status: 'live', agent: 'codex', group: 'ctx_a' } }, reservations: {} }),
    ['ctx_a']);
}

// --- file-lock.cjs -------------------------------------------------------------

{
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-lock-'));
  const lockDir = path.join(lockRoot, 'l');
  const first = acquireLock(lockDir, { timeoutMs: 200 });
  check('file-lock: first acquire succeeds', first, true);
  const second = acquireLock(lockDir, { timeoutMs: 200, retryMs: 10 });
  check('file-lock: a second acquire times out while the first still holds it', second, false);
  releaseLock(lockDir);
  const third = acquireLock(lockDir, { timeoutMs: 200 });
  check('file-lock: acquire succeeds again after release', third, true);
  releaseLock(lockDir);

  // A lock directory older than staleMs is presumed abandoned and cleared.
  fs.mkdirSync(lockDir);
  const old = Date.now() / 1000 - 60;
  fs.utimesSync(lockDir, old, old);
  const afterStale = acquireLock(lockDir, { timeoutMs: 500, retryMs: 10, staleMs: 1000 });
  check('file-lock: a stale lock directory is cleared and re-acquired', afterStale, true);
  releaseLock(lockDir);

  fs.rmSync(lockRoot, { recursive: true, force: true });
}

// --- config.cjs: maxParallelCodexWorkers / ownershipClaimTtlMinutes -----------

{
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-config2-'));
  const cfgFile = path.join(cfgDir, 'orchestration.config.json');
  const withConfig = (obj, fn) => {
    fs.writeFileSync(cfgFile, JSON.stringify(obj));
    const prev = process.env.ORCH_CONFIG_PATH;
    process.env.ORCH_CONFIG_PATH = cfgFile;
    try { return fn(); } finally { process.env.ORCH_CONFIG_PATH = prev; }
  };

  const defaults = withConfig({}, () => config.loadConfig());
  check('default maxParallelCodexWorkers is 3', defaults.maxParallelCodexWorkers, 3);
  check('default ownershipClaimTtlMinutes is 120', defaults.ownershipClaimTtlMinutes, 120);
  check('GATE_NAMES includes the new gates',
    ['max-parallel-codex-workers', 'code-brief-needs-owns', 'ownership-overlap'].every((g) => config.GATE_NAMES.includes(g)),
    true);

  const badCap = withConfig({ maxParallelCodexWorkers: 99 }, () => config.loadConfig());
  check('an out-of-range maxParallelCodexWorkers falls back to the default', badCap.maxParallelCodexWorkers, 3);
  check('an out-of-range maxParallelCodexWorkers produces a warning', badCap.warnings.length > 0, true);

  const zeroCap = withConfig({ maxParallelCodexWorkers: 0 }, () => config.loadConfig());
  check('maxParallelCodexWorkers: 0 (unlimited) is kept as-is', zeroCap.maxParallelCodexWorkers, 0);
  check('maxParallelCodexWorkers: 0 produces no warning', zeroCap.warnings, []);

  const badTtl = withConfig({ ownershipClaimTtlMinutes: -5 }, () => config.loadConfig());
  check('an out-of-range ownershipClaimTtlMinutes falls back to the default', badTtl.ownershipClaimTtlMinutes, 120);
  check('an out-of-range ownershipClaimTtlMinutes produces a warning', badTtl.warnings.length > 0, true);

  const before = process.env.ORCH_MAX_PARALLEL_CODEX_WORKERS;
  process.env.ORCH_MAX_PARALLEL_CODEX_WORKERS = '5';
  check('ORCH_MAX_PARALLEL_CODEX_WORKERS overrides the config value', config.maxParallelCodexWorkers(defaults), 5);
  process.env.ORCH_MAX_PARALLEL_CODEX_WORKERS = 'nope';
  check('an invalid override falls back to the config value', config.maxParallelCodexWorkers(defaults), defaults.maxParallelCodexWorkers);
  if (before === undefined) delete process.env.ORCH_MAX_PARALLEL_CODEX_WORKERS; else process.env.ORCH_MAX_PARALLEL_CODEX_WORKERS = before;

  const beforeTtl = process.env.ORCH_CLAIM_TTL_MINUTES;
  process.env.ORCH_CLAIM_TTL_MINUTES = '30';
  check('ORCH_CLAIM_TTL_MINUTES overrides the config value', config.ownershipClaimTtlMinutes(defaults), 30);
  if (beforeTtl === undefined) delete process.env.ORCH_CLAIM_TTL_MINUTES; else process.env.ORCH_CLAIM_TTL_MINUTES = beforeTtl;

  fs.rmSync(cfgDir, { recursive: true, force: true });
}

// --- worker-groups.cjs: splitJsonReplies / idsFromOutput on a nested Orca envelope (item 2) --

{
  // A real Orca reply is a nested envelope, not the flat {"dispatchId":"..."} shape the
  // pre-fix regex-only extraction happened to also work against — the fields the gate
  // actually reads still have to be found no matter how deep they're nested.
  const nested = JSON.stringify({
    id: 'req_1', ok: true,
    result: {
      dispatchId: 'ctx_nested_1',
      mutation: { taskId: 'task_nested_1', resource: { id: 'res_1', kind: 'worker' } },
    },
    _meta: { latencyMs: 12 },
  });
  const ids = WG.idsFromOutput(nested);
  check('idsFromOutput: finds dispatchId nested under result{}', ids.has('ctx_nested_1'), true);
  check('idsFromOutput: finds taskId nested two levels under result.mutation{}', ids.has('task_nested_1'), true);
  check('worker-groups: a nested envelope\'s ids still resolve to ONE canonical group',
    WG.canonicalGroup(ids), 'ctx_nested_1');

  const workerListShaped = JSON.stringify({ result: { workers: [{ dispatchId: 'ctx_should_be_skipped' }] } });
  check('splitJsonReplies: a worker-list-shaped reply (carries a workers[] array) is excluded',
    WG.splitJsonReplies(workerListShaped).length, 0);

  const twoReplies = [
    JSON.stringify({ ok: true, result: { dispatchId: 'ctx_first' } }),
    JSON.stringify({ ok: true, result: { dispatchId: 'ctx_second' } }),
  ].join('\n');
  const replies = WG.splitJsonReplies(twoReplies);
  check('splitJsonReplies: two JSON reply lines split into two objects, in order',
    replies.map((r) => r.result.dispatchId), ['ctx_first', 'ctx_second']);

  const nonJsonBanner = 'Dispatching worker...\n' + JSON.stringify({ dispatchId: 'ctx_after_banner' }) + '\ndone';
  check('splitJsonReplies: non-JSON banner lines around a reply are skipped, not misparsed',
    WG.splitJsonReplies(nonJsonBanner).map((r) => r.dispatchId), ['ctx_after_banner']);

  // Second review round, item 2: a line-based splitter cannot separate PRETTY-PRINTED
  // (multi-line, JSON.stringify(x, null, 2)) replies — real `orca --json` output is
  // pretty-printed, not compact NDJSON. Two pretty-printed nested envelopes concatenated in
  // one Bash call's stdout must still split into exactly two reply objects, in order.
  const prettyEnvelope = (ctx, task, term) => JSON.stringify({
    id: 'req', ok: true,
    result: { dispatchId: ctx, taskId: task, handle: term, mutation: { requestId: 'r' } },
    _meta: { runtimeId: 'x' },
  }, null, 2);
  const twoPretty = prettyEnvelope('ctx_p1', 'task_p1', 'term_p1') + '\n' + prettyEnvelope('ctx_p2', 'task_p2', 'term_p2');
  const prettyReplies = WG.splitJsonReplies(twoPretty);
  check('splitJsonReplies: two pretty-printed (multi-line) nested envelopes split into two objects, in order',
    prettyReplies.map((r) => r.result.dispatchId), ['ctx_p1', 'ctx_p2']);
  check('splitJsonReplies: each pretty-printed reply keeps its own taskId/handle (not merged)',
    prettyReplies.map((r) => `${r.result.taskId}/${r.result.handle}`), ['task_p1/term_p1', 'task_p2/term_p2']);

  // A single pretty-printed reply (the common case) must still parse as exactly one object,
  // via the "whole blob is one JSON value" fast path.
  const onePretty = prettyEnvelope('ctx_solo', 'task_solo', 'term_solo');
  check('splitJsonReplies: a single pretty-printed reply is still exactly one object',
    WG.splitJsonReplies(onePretty).map((r) => r.result.dispatchId), ['ctx_solo']);

  // Third review round, item 2: realistic mixed log+JSON stdout must not break the
  // balanced-brace fallback (pass 3) — a log line containing `[3]`/`[==`/a stray `"` must
  // never shift, corrupt, or swallow the real replies around it.
  const r1 = JSON.stringify({ ok: true, result: { dispatchId: 'ctx_1', taskId: 'task_1' } });
  const r2 = JSON.stringify({ ok: true, result: { dispatchId: 'ctx_2', taskId: 'task_2' } });
  const dispatchIds = (text) => WG.splitJsonReplies(text).map((r) => r.result.dispatchId);
  check('splitJsonReplies: a `retry [3]` log line before two replies does not shift or misattribute them',
    dispatchIds(`retry [3]\n${r1}\n${r2}\n`), ['ctx_1', 'ctx_2']);
  check('splitJsonReplies: a bare `{}` log artifact between real replies is rejected as signal-less noise',
    dispatchIds(`${r1}\nnote\n${r2}\n`), ['ctx_1', 'ctx_2']);
  check('splitJsonReplies: a bare `{}` line on its own is never counted as a dispatch reply',
    WG.splitJsonReplies('{}\n').length, 0);
  check('splitJsonReplies: a stray unterminated quote in a log line before any chunk opens is inert',
    dispatchIds(`Starting "phase\n${r1}\n${r2}\n`), ['ctx_1', 'ctx_2']);
  check('splitJsonReplies: an unbalanced `[` in a log line never derails bracket-depth for what follows',
    dispatchIds(`progress [==\n${r1}\n${r2}\n`), ['ctx_1', 'ctx_2']);
  check('splitJsonReplies: trailing log noise (with its own stray bracket/quote) after real replies is ignored',
    dispatchIds(`${r1}\n${r2}\nwarn: [x "y\n`), ['ctx_1', 'ctx_2']);
  check('splitJsonReplies: an array value (e.g. a stray `[3]`) is never accepted as a dispatch reply',
    WG.splitJsonReplies('[3]\n').length, 0);

  // Fourth Opus 5.5 review round, item 1: two real replies printed back-to-back on the SAME
  // line, with no separator between them at all, must still both split (a chunk closing must
  // itself re-open the "start of line" flag, not only an actual `\n`).
  check('splitJsonReplies: two real replies with no separator on the same line (`{...}{...}`) both split',
    dispatchIds(`${r1}${r2}`), ['ctx_1', 'ctx_2']);

  // Fifth Opus 5.5 review round, optional LOW item: a real reply closing must re-arm chunk
  // detection for a following `{` on the same line (proven above), but must NOT also let a `[`
  // reopen right there — a dispatch reply is always a JSON object, never a top-level array. This
  // is not just a filtering nicety: an UNTERMINATED stray `[` mid-line (e.g. `{...}[unterminated`
  // with no matching `]` before the next real reply) would, if opened as a chunk, consume every
  // character up to end-of-text as "still inside that chunk" — silently swallowing the next real
  // reply entirely. Before this fix a `[` right after a closing `}` (no newline) was still
  // eligible to reopen, so exactly this happened. A `[` immediately after an actual newline is
  // still a legitimate chunk opener (the existing "an array value is never accepted as a
  // dispatch reply" case above already proves a well-formed, terminated `[3]\n` on its own line
  // is rejected for lacking dispatch signal — a separate, later filtering step — not because it
  // failed to open at all).
  check('splitJsonReplies: an unterminated `[` right after a closing `}` on the same line does not swallow the next real reply',
    dispatchIds(`${r1}[unterminated\n${r2}`), ['ctx_1', 'ctx_2']);
  check('splitJsonReplies: a well-formed `[1,2,3]` right after a closing `}` on the same line is still not reopened',
    dispatchIds(`${r1}[1,2,3]`), ['ctx_1']);
}

// --- ownership.cjs: ownsOverlap regression cases for the fix-round-1 false negatives (item 3) --

{
  const cases = [
    ["literal 'src' vs glob 'src/api/**' (directory-prefix, both directions)", 'src', 'src/api/**', true],
    ["empty-prefix glob '**/*.ts' matches a nested file", 'foo/bar.ts', '**/*.ts', true],
    ["empty-prefix glob '**/*.ts' matches a top-level file (zero directories)", 'bar.ts', '**/*.ts', true],
    ["empty-prefix glob '*.ts' conflicts (err-toward-conflict for an empty literal prefix)", 'foo/bar.ts', '*.ts', true],
    ["empty-prefix brace glob '{a,b}/x' matches directly via regex", 'a/x.ts', '{a,b}/x.ts', true],
    ["'**/x.ts' matches the bare zero-directory file 'x.ts'", 'x.ts', '**/x.ts', true],
    ["'**/x.ts' matches a nested 'a/b/x.ts'", 'a/b/x.ts', '**/x.ts', true],
    ["two empty-prefix globs both match everywhere, so they conflict", '*.ts', '*.js', true],
    ["unrelated literal directories never conflict", 'src/api', 'lib/api', false],
  ];
  for (const [name, a, b, want] of cases) {
    check(`ownsOverlap (item 3): ${name}`, OWN.ownsOverlap(a, b), want);
    check(`ownsOverlap (item 3, symmetric): ${name}`, OWN.ownsOverlap(b, a), want);
  }
}

// --- ownership.cjs: normalizeOwnsItem / MAX_ITEM_LENGTH / wildcard cap (item 11) -------------

{
  const REPO = '/work/proj';
  check('normalizeOwnsItem: a bare "." normalizes to a whole-repo claim ("**"), same as "./" (item 4, round 2)',
    OWN.normalizeOwnsItem('.', REPO), '**');
  check('normalizeOwnsItem: "./" also normalizes to the whole-repo claim',
    OWN.normalizeOwnsItem('./', REPO), '**');
  check('normalizeOwnsItem: an absolute path equal to the repo root also normalizes to "**"',
    OWN.normalizeOwnsItem(REPO, REPO), '**');
  check('parseOwns: "Owns: ." overlaps any other claim (it is a whole-repo claim, not "claims nothing")',
    !!OWN.anyOverlap(OWN.parseOwns('x\nOwns: .', { repoRoot: REPO }).owns, ['src/a.ts']), true);
  check('parseOwns: an item over 256 chars is refused',
    OWN.parseOwns(`x\nOwns: ${'a'.repeat(300)}.ts`, { repoRoot: REPO }).owns, []);
  check('parseOwns: an item with more than 8 wildcard characters is refused',
    OWN.parseOwns(`x\nOwns: ${'*/'.repeat(9)}x.ts`, { repoRoot: REPO }).owns, []);

  // ReDoS timing: globToRegExp must never exhibit a backtracking-regex-shaped cost, even
  // against an adversarial run of `**` segments matched against a long non-matching string.
  const adversarial = OWN.normalizeOwnsItem('**a'.repeat(12) + 'b', REPO);
  const longMiss = 'x'.repeat(20000);
  const t0 = process.hrtime.bigint();
  const matched = adversarial ? OWN.globToRegExp(adversarial).test(longMiss) : false;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (ms < 200) pass += 1; else failures.push(`adversarial '**a'x12+'b' pattern took ${ms}ms against a 20000-char miss, want <200ms`);
  check('ReDoS probe: the adversarial pattern does not match an unrelated long string', matched, false);

  // Second review round, item 5: the FIRST test above never actually exercised the risky
  // regex path, because its 24-wildcard pattern is rejected outright by MAX_WILDCARDS before
  // reaching any matcher. `*a*a*a*a*a*a*a*b` has exactly 8 wildcards — AT, not over, the
  // cap — so it passes normalizeOwnsItem unchanged and previously reached
  // `globToRegExp(...).test(...)` inside ownsOverlap, compiling to the textbook
  // catastrophic-backtracking shape `^[^/]*a[^/]*a...[^/]*a[^/]*b$` against a long run of
  // 'a' with no trailing 'b'. ownsOverlap must now go through the linear (DP-based) matcher
  // instead, which cannot blow up regardless of input. Exercised through the REAL reachable
  // path (ownsOverlap/anyOverlap), not globToRegExp directly, since that is what a live
  // ownership-overlap check (possibly running under the state-file lock) actually calls.
  const atCapWildcard = OWN.normalizeOwnsItem('*a*a*a*a*a*a*a*b', REPO);
  check('normalizeOwnsItem: an 8-wildcard pattern is AT the cap, not rejected by it', atCapWildcard, '*a*a*a*a*a*a*a*b');
  const longA = 'a'.repeat(60);
  const t1 = process.hrtime.bigint();
  const overlapHit = OWN.anyOverlap([atCapWildcard], [longA]);
  const ms1 = Number(process.hrtime.bigint() - t1) / 1e6;
  if (ms1 < 200) pass += 1; else failures.push(`ownsOverlap('*a*a*a*a*a*a*a*b', 'a'.repeat(60)) took ${ms1}ms, want <200ms (real ReDoS via the reachable overlap path)`);
  // This pattern's literal prefix is empty (it starts with `*`), so it correctly conflicts
  // with everything per the round-1 "empty literal prefix matches everywhere" rule — the
  // point of this assertion is that computing the answer is FAST, not that it's `false`.
  check('ownsOverlap: an empty-literal-prefix glob still resolves to a definite (fast) answer', typeof overlapHit === 'object' || overlapHit === null, true);
  // The linear matcher's own correctness (independent of the literal-prefix shortcut above)
  // is proven directly: this concrete pattern must NOT match a same-length string missing
  // the required trailing 'b'.
  check('globMatchesLiteral: the at-cap-boundary pattern does not match a trailing-b-less string',
    OWN.globMatchesLiteral(atCapWildcard, longA), false);
  check('globMatchesLiteral: the same pattern DOES match when the trailing b is present',
    OWN.globMatchesLiteral(atCapWildcard, `${longA}b`), true);
  // A longer adversarial chain (more segments than the pattern itself has, well beyond the
  // wildcard cap for a SINGLE item, so this exercises the linear matcher directly rather than
  // relying on the cap) must also stay fast, proving this isn't a fluke of the exact size above.
  const longerAdversarial = '*a'.repeat(20) + '*b';
  const t2 = process.hrtime.bigint();
  OWN.globMatchesLiteral(longerAdversarial, 'a'.repeat(500));
  const ms2 = Number(process.hrtime.bigint() - t2) / 1e6;
  if (ms2 < 200) pass += 1; else failures.push(`globMatchesLiteral with 20 wildcard segments against a 500-char miss took ${ms2}ms, want <200ms`);
}

// --- ownership.cjs: splitOwnsLine / parseOwns brace-depth-aware comma split (item 14) --------

{
  const REPO = '/work/proj';
  check('parseOwns: a brace glob with an internal ", " survives as one item',
    OWN.parseOwns('x\nOwns: src/{a, b}.ts', { repoRoot: REPO }).owns,
    ['src/{a, b}.ts']);
  check('parseOwns: whitespace-only separation (no commas) still splits into two items',
    OWN.parseOwns('x\nOwns: src/api/** src/models/*.ts', { repoRoot: REPO }).owns,
    ['src/api/**', 'src/models/*.ts']);
  check('parseOwns: mixed comma-and-space list outside any brace splits on both, as before',
    OWN.parseOwns('x\nOwns: src/api/**, src/models/user.ts foo/bar.py', { repoRoot: REPO }).owns,
    ['src/api/**', 'src/models/user.ts', 'foo/bar.py']);
}

// --- orca-heartbeat.cjs: H1 leftover false positive, against a REAL git repo (round 3, item 3) --
//
// The fakeGit-based tests above prove the mechanism (hasOwnCommit reads the reflog); these
// prove it against an actual git worktree, which is the only way to really produce the false
// positive's precondition: a worktree with zero commits of its own whose HEAD nonetheless ends
// up with a commit TIME that postdates its own `.git` marker, because the BASE branch (not the
// worktree) advanced after the worktree was created, and the worktree was then rebased/
// fast-forwarded onto it. A synthetic mtime/commit-time pair can assert the same outcome, but
// only a real rebase/fast-forward actually exercises the code path that produces it.
{
  const gitAvailable = (() => {
    try { return spawnSync('git', ['--version']).status === 0; } catch { return false; }
  })();
  if (!gitAvailable) {
    console.log('H1 real-git tests skipped: no git binary on PATH');
  } else {
    function sh(args, cwd) {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr || r.stdout}`);
      return (r.stdout || '').trim();
    }
    const realGit = (args, cwd) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      if (r.error || r.status === null || r.status === undefined) return null;
      return { status: r.status, stdout: (r.stdout || '').trim() };
    };
    const rowFor = (wtPath) => ({
      path: wtPath, displayName: path.basename(wtPath), isMainWorktree: false, isArchived: false, liveTerminalCount: 0,
    });
    const realCtx = () => ({ now: Date.now(), idleSeconds: 60, git: realGit, stat: heartbeat.statMtimeMs });
    // `hasProducedMergedWork` compares a commit's %ct (whole SECONDS) against a `.git` marker's
    // mtime (sub-second precision) — a real worktree-add followed immediately by a commit can
    // otherwise land in the same wall-clock second, making the commit's truncated-to-the-second
    // timestamp read as EARLIER than the marker's own more precise mtime. A short real sleep
    // between "create the worktree" and "commit something that should postdate it" removes that
    // ordering ambiguity; this is over-1s, not a busy loop, so it costs real time but no CPU.
    const sleepPastSecondBoundary = () => { spawnSync('sleep', ['1.2']); };

    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-h1-realgit-'));
    const base = path.join(ROOT, 'base');
    fs.mkdirSync(base);
    sh(['init', '-q', '-b', 'main'], base);
    sh(['config', 'user.email', 'orch-test@example.invalid'], base);
    sh(['config', 'user.name', 'Orch Test'], base);
    fs.writeFileSync(path.join(base, 'f.txt'), 'a\n');
    sh(['add', '.'], base);
    sh(['commit', '-q', '-m', 'initial'], base);
    const commitA = sh(['rev-parse', 'HEAD'], base);

    // Case 1 — fresh: a worktree just branched off base, zero commits of its own -> not done.
    const freshPath = path.join(ROOT, 'wt-fresh');
    sh(['worktree', 'add', '-q', '-b', 'feature-fresh', freshPath, commitA], base);
    check('H1 real-git: a fresh worktree with zero commits of its own is never done-but-open',
      heartbeat.isDoneButOpen(rowFor(freshPath), realCtx()), false);

    // Case 2 — rebased/fast-forwarded, no own commits: the worktree branches off A, base then
    // advances to B, and the worktree is fast-forwarded onto B WITHOUT ever gaining a commit of
    // its own. HEAD (B) now postdates the worktree's own `.git` marker (created before B
    // existed) — the OLD heuristic (`hasProducedMergedWork`) alone reads this as "done"; this is
    // the exact false positive item 3 fixes.
    const rebasedPath = path.join(ROOT, 'wt-rebased');
    sh(['worktree', 'add', '-q', '-b', 'feature-rebased', rebasedPath, commitA], base);
    sleepPastSecondBoundary();
    fs.writeFileSync(path.join(base, 'f.txt'), 'b\n');
    sh(['commit', '-q', '-am', 'advance base'], base);
    sh(['merge', '-q', '--ff-only', 'main'], rebasedPath);
    check('H1 real-git: a worktree rebased/fast-forwarded onto a moved base with no commits of its own is never done-but-open (the false-positive case)',
      heartbeat.isDoneButOpen(rowFor(rebasedPath), realCtx()), false);

    // Case 3 — own commit merged into base: a real commit made ON the worktree's own branch,
    // then fast-forward-merged back into base -> done.
    const ownPath = path.join(ROOT, 'wt-own');
    sh(['worktree', 'add', '-q', '-b', 'feature-own', ownPath, 'main'], base);
    sleepPastSecondBoundary();
    fs.writeFileSync(path.join(ownPath, 'g.txt'), 'own work\n');
    sh(['add', '.'], ownPath);
    sh(['commit', '-q', '-m', 'real work'], ownPath);
    sh(['merge', '-q', '--ff-only', 'feature-own'], base);
    check('H1 real-git: a worktree whose own commit is merged into base is done-but-open',
      heartbeat.isDoneButOpen(rowFor(ownPath), realCtx()), true);

    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}

// --- report -----------------------------------------------------------------

// A clean installer copy must contain the complete runtime dependency closure. Running
// the copied gate with orchestration disabled still loads every top-level helper, so a
// missing HOOK_FILES entry fails here with MODULE_NOT_FOUND instead of after installation.
{
  const installer = fs.readFileSync(path.join(__dirname, '..', 'install.mjs'), 'utf8');
  const block = installer.match(/const HOOK_FILES = \[([\s\S]*?)\n\];/);
  const files = block ? [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-installed-smoke-'));
  for (const rel of files) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'hooks', rel), target);
  }
  const result = spawnSync(process.execPath, [path.join(root, 'orchestrator-gate.cjs')], {
    input: JSON.stringify({ session_id: 'installed-smoke', hook_event_name: 'SessionStart' }),
    encoding: 'utf8',
    env: {
      ...process.env,
      ORCHESTRATOR_GATE: 'off',
      ORCH_STATE_DIR: path.join(root, 'state'),
      ORCH_CONFIG_PATH: path.join(root, 'no-config.json'),
    },
  });
  check('installer hook file list has a loadable runtime dependency closure', result.status, 0);
  const codexStub = path.join(__dirname, 'fixtures', 'codex-app-server-stub.cjs');
  try { fs.chmodSync(codexStub, 0o755); } catch {}
  const liveResult = spawnSync(process.execPath, ['-e',
    'const q=require(process.argv[1]);process.exit(q.liveQuota() ? 0 : 1)',
    path.join(root, 'lib', 'exec-route-by-quota.cjs')], {
    encoding: 'utf8',
    env: { ...process.env, ORCH_CODEX_BIN: codexStub, STUB_CODEX_PRIMARY_USED: '20' },
  });
  check('installer hook file list includes the dynamically spawned live quota probe', liveResult.status, 0);
  fs.rmSync(root, { recursive: true, force: true });
}

fs.rmSync(STATE_DIR, { recursive: true, force: true });

console.log(`${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
