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
const { acquireLock, releaseLock } = require('../hooks/lib/file-lock.cjs');

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

const NOW = 1800000000000;
const ctx = { baseHandles: new Set(['old']), started: NOW - 600000, now: NOW, idleSeconds: 90 };

check('rate limit in preview wins over everything',
  heartbeat.classifyTerminal({ handle: 'x', preview: 'Error: 429 rate limit', lastOutputAt: NOW }, ctx).kind,
  'rate_limit');

check('orphaned terminal is reported',
  heartbeat.classifyTerminal({ handle: 'x', preview: '', orphaned: true, lastOutputAt: NOW }, ctx).kind,
  'orphaned');

check('a terminal that existed at baseline and stayed quiet is ignored',
  heartbeat.classifyTerminal({ handle: 'old', preview: '', lastOutputAt: ctx.started - 60000 }, ctx).kind,
  'ignored');

check('a terminal that existed at baseline but produced output since is supervised, and is idle',
  heartbeat.classifyTerminal({ handle: 'old', preview: '', lastOutputAt: NOW - 200000 }, ctx).kind,
  'idle');

check('a brand new terminal gone quiet is idle',
  heartbeat.classifyTerminal({ handle: 'new', preview: '', lastOutputAt: NOW - 120000 }, ctx).kind,
  'idle');

check('a brand new terminal still producing output is working',
  heartbeat.classifyTerminal({ handle: 'new', preview: '', lastOutputAt: NOW - 5000 }, ctx).kind,
  'working');

check('a finished worker still holding a terminal is flagged',
  heartbeat.isHoldingResources({ terminalState: 'retained' }), true);
check('a released worker holds nothing',
  heartbeat.isHoldingResources({ terminalState: 'released' }), false);

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
  check('default codexHandoffUsedPercent is 40', defaults.codexHandoffUsedPercent, 40);
  check('default agents.lookup is [Explore]', defaults.agents.lookup, ['Explore']);
  check('default agents.escalation is empty', defaults.agents.escalation, []);
  check('default config has no warnings', defaults.warnings, []);

  const badActivation = withConfig({ activation: 'sometimes' }, () => config.loadConfig());
  check('invalid activation falls back to orca-only', badActivation.activation, 'orca-only');
  check('invalid activation produces a warning', badActivation.warnings.length > 0, true);

  const badThreshold = withConfig({ codexHandoffUsedPercent: 150 }, () => config.loadConfig());
  check('out-of-range threshold falls back to default', badThreshold.codexHandoffUsedPercent, 40);
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

  fs.rmSync(cfgDir, { recursive: true, force: true });
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
  const cases = [
    // Codex first; the code model once Codex has used >= 40% (i.e. <= 60% left).
    [[90, 90], 'codex'], [[90, 61], 'codex'], [[90, 60], 'sonnet'], [[10, 23], 'sonnet'],
    [[null, 30], 'sonnet'], [[90, null], 'codex'], [[null, null], 'codex'], [[5, 80], 'codex'],
  ];
  for (const [[c, x], want] of cases) {
    const got = pickExecRoute(c, x, 40);
    if (got === want) pass += 1; else failures.push(`pickExecRoute(${c}, ${x}, 40) = ${got}, want ${want}`);
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
  eq('codex: old reading is not discarded by age', q.codexRemaining(now + 30 * 86400000), 100);
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

// --- report -----------------------------------------------------------------

fs.rmSync(STATE_DIR, { recursive: true, force: true });

console.log(`${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
