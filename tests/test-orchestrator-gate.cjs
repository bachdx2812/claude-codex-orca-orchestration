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

// --- report -----------------------------------------------------------------

fs.rmSync(STATE_DIR, { recursive: true, force: true });

console.log(`${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
