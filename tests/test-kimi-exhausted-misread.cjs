#!/usr/bin/env node
'use strict';

/**
 * An exhausted Kimi 5-hour window must read as exhausted: quota parsing from used/limit
 * (numeric strings included), the machine-wide exhaustion marker written from any Kimi
 * terminal showing the limit, the pool pick honoring it, and the in-session code model
 * being allowed once no external coder is eligible.
 *
 * Hermetic: fresh ORCH_STATE_DIR, stub binaries, loopback-only usage URL, no real
 * ~/.kimi-code, no network, no tokens printed.
 *
 * Run: node tests/test-kimi-exhausted-misread.cjs
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GATE = path.join(ROOT, 'hooks', 'orchestrator-gate.cjs');
const ORCA_STUB = path.join(__dirname, 'fixtures', 'orca-stub.cjs');
const CODEX_STUB = path.join(__dirname, 'fixtures', 'codex-app-server-stub.cjs');
const KIMI_STUB = path.join(__dirname, 'fixtures', 'kimi-stub.cjs');
for (const file of [ORCA_STUB, CODEX_STUB, KIMI_STUB]) try { fs.chmodSync(file, 0o755); } catch {}

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-kimi-exhausted-'));
process.env.ORCH_STATE_DIR = STATE_DIR;
process.env.ORCH_CONFIG_PATH = path.join(STATE_DIR, 'no-such-config.json');
process.env.CLAUDE_CODE_SESSION_ID = 'kimi-exhausted-misread-test';

const QUOTA = require('../hooks/lib/exec-route-by-quota.cjs');
const { pickCoderPool } = require('../hooks/lib/coder-pool-route.cjs');
const AVAIL = require('../hooks/lib/coder-availability.cjs');
const { hasKimiUsageExhausted, kimiUsageLimitHours } = require('../hooks/lib/terminal-signals.cjs');
const heartbeat = require('../hooks/orca-heartbeat.cjs');

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}

const PAYLOAD = {
  usage: { limit: '100', used: '58', remaining: '42' },
  limits: [{ window: { duration: 300 }, detail: { limit: '100', used: '100', resetTime: '2026-10-01T00:13:49Z' } }],
  usages: { limit_5h: { used_ratio: 0 }, limit_7d: { used_ratio: 0 } },
};
const BEFORE_RESET = Date.parse('2026-09-30T23:00:00Z');
const RESET_SECONDS = Date.parse('2026-10-01T00:13:49Z') / 1000;

// --- quota parsing ------------------------------------------------------------

{
  const quota = QUOTA.parseKimiUsages(PAYLOAD, BEFORE_RESET);
  check('captured payload: the full 5h window makes Kimi 100% used', quota.usedPercent, 100);
  check('the reset comes from the window detail', quota.resetsAt, RESET_SECONDS);
  const windows = QUOTA.kimiQuotaWindows(PAYLOAD, BEFORE_RESET);
  check('weekly and 5h windows are both read from used/limit', windows.map((w) => w.usedPercent), [58, 100]);
  check('the 5h window carries its duration', windows[1].durationMinutes, 300);
  check('a window whose reset already passed counts as unused',
    QUOTA.parseKimiUsages(PAYLOAD, Date.parse('2026-10-01T01:00:00Z')).usedPercent, 58);
  check('remaining derives usage when used is absent',
    QUOTA.parseKimiUsages({ usage: { limit: '100', remaining: '25' } }, BEFORE_RESET).usedPercent, 75);
  check('the ratio-only form is used when nothing else exists',
    QUOTA.parseKimiUsages({ usages: { a: { used_ratio: 0.4 } } }, BEFORE_RESET).usedPercent, 40);
  check('the ratio is ignored when real counts exist',
    QUOTA.parseKimiUsages({ usage: { limit: 10, used: 9 }, usages: { a: { used_ratio: 0 } } }, BEFORE_RESET).usedPercent, 90);
}

// --- terminal signal ----------------------------------------------------------

const FIVE_HOUR_403 = "403 You've reached your 5-hour usage limit";
check('the 5-hour 403 line is a Kimi usage-exhausted signal', hasKimiUsageExhausted(FIVE_HOUR_403), true);
check('the window length is extracted', kimiUsageLimitHours(FIVE_HOUR_403), 5);
check('prose mentioning the 5-hour limit is inert',
  hasKimiUsageExhausted("note: You've reached your 5-hour usage limit"), false);
check('the billing-cycle form has no window length',
  kimiUsageLimitHours("403 You've reached your usage limit for this billing cycle"), null);

// --- marker written by the heartbeat, until the cached window reset -----------

{
  const now = Date.now();
  const resetsAt = Math.floor(now / 1000) + 2 * 3600;
  fs.writeFileSync(path.join(STATE_DIR, 'kimi-quota-live.json'), JSON.stringify({
    usedPercent: 100, resetsAt, fetchedAt: now,
    windows: [{ usedPercent: 58, resetsAt: resetsAt + 86400 }, { usedPercent: 100, resetsAt, durationMinutes: 300 }],
  }));
  check('the cached 5h window reset is found', QUOTA.kimiWindowResetMs(STATE_DIR, 300, now), resetsAt * 1000);
  heartbeat.setOnCoderExhausted(null);
  const event = heartbeat.reportUsageExhausted({
    reported: new Map(), handle: 'term_untracked_kimi', label: 'term_untracked_kimi (Kimi)',
    coder: 'kimi', windowHours: kimiUsageLimitHours(FIVE_HOUR_403), now,
  });
  check('the exhausted event is emitted', typeof event === 'string' && event.startsWith('KIMI USAGE LIMIT'), true);
  const marker = AVAIL.readCoderExhaustion(STATE_DIR, now).kimi;
  check('a machine-wide marker is written until the window reset', marker && marker.until, resetsAt * 1000);
  check('the same handle does not re-mark mid-episode',
    heartbeat.reportUsageExhausted({
      reported: heartbeat.loadPersistedUsageExhaustedReports(), handle: 'term_untracked_kimi',
      label: 'term_untracked_kimi (Kimi)', coder: 'kimi', windowHours: 5, now,
    }), null);
  check('the handle re-arms once its episode ends',
    typeof heartbeat.reportUsageExhausted({
      reported: heartbeat.loadPersistedUsageExhaustedReports(), handle: 'term_untracked_kimi',
      label: 'term_untracked_kimi (Kimi)', coder: 'kimi', windowHours: 5, now: resetsAt * 1000 + 1000,
    }) === 'string', true);

  const pool = pickCoderPool({
    availability: { codex: { usable: true }, kimi: { usable: true } },
    quotas: { codex: { usedPercent: 99 }, kimi: null },
    thresholds: { codex: 95, kimi: 95 },
    exhaustion: AVAIL.readCoderExhaustion(STATE_DIR, now),
    fallbackEnabled: true,
  });
  check('the pool treats Kimi as exhausted while the marker is valid', pool.coders.kimi.state, 'exhausted');
  check('with Codex also over threshold the pool routes to the in-session model', [pool.route, pool.pick], ['code', null]);
}

// --- last-known fallback for the window reset + durationMinutes persistence ---

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-last-known-'));
  const now = Date.now();
  const resetsAt = Math.floor(now / 1000) + 3 * 3600;
  // The live cache holds only a failed reading (the usual case once the token expires).
  fs.writeFileSync(path.join(dir, 'kimi-quota-live.json'), JSON.stringify({ failed: true, kind: 'expired', fetchedAt: now }));
  QUOTA.persistLastKnownQuota(dir, 'kimi', {
    usedPercent: 100, resetsAt, fetchedAt: now,
    windows: [{ usedPercent: 58, resetsAt: resetsAt + 86400 }, { usedPercent: 100, resetsAt, durationMinutes: 300 }],
  }, now);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'kimi-quota-last-known.json'), 'utf8'));
  check('the last-known reading keeps the window duration',
    persisted.windows[1].durationMinutes, 300);
  check('the window reset is found via the last-known file when the live cache is failed',
    QUOTA.kimiWindowResetMs(dir, 300, now), resetsAt * 1000);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- RT-3: untracked terminals never mark Kimi without positive Kimi identity ---

{
  const own = new Set(['term_mine']);
  const machineAgents = new Map([['term_other_kimi', 'kimi'], ['term_other_codex', 'codex']]);
  const orcaAgents = new Map([
    ['term_orca_kimi', 'kimi'], ['term_orca_codex', 'codex'], ['term_orca_claude', 'claude'],
  ]);
  check('an untracked terminal recorded as another session\'s Kimi worker counts',
    heartbeat.isNonOwnKimiTerminal({
      handle: 'term_other_kimi', ownHandles: own, panelHandle: 'term_panel', machineAgents, orcaAgents,
    }), true);
  check('an untracked terminal recorded as Codex does NOT count',
    heartbeat.isNonOwnKimiTerminal({
      handle: 'term_other_codex', ownHandles: own, panelHandle: 'term_panel', machineAgents, orcaAgents,
    }), false);
  check('an untracked terminal Orca identifies as Kimi counts',
    heartbeat.isNonOwnKimiTerminal({
      handle: 'term_orca_kimi', ownHandles: own, panelHandle: 'term_panel', machineAgents, orcaAgents,
    }), true);
  check('a terminal Orca identifies as Codex/Claude does NOT count',
    [
      heartbeat.isNonOwnKimiTerminal({
        handle: 'term_orca_codex', ownHandles: own, panelHandle: 'term_panel', machineAgents, orcaAgents,
      }),
      heartbeat.isNonOwnKimiTerminal({
        handle: 'term_orca_claude', ownHandles: own, panelHandle: 'term_panel', machineAgents, orcaAgents,
      }),
    ], [false, false]);
  check('an unknown terminal is NEVER identified by its title (RT-3: Claude titles itself after its topic)',
    heartbeat.isNonOwnKimiTerminal({
      handle: 'term_unknown', ownHandles: own, panelHandle: 'term_panel', machineAgents, orcaAgents,
    }), false);
  check('a Kimi-titled terminal with no identity record does NOT count',
    heartbeat.isNonOwnKimiTerminal({
      handle: 'term_unknown', ownHandles: own, panelHandle: 'term_panel',
      machineAgents: new Map(), orcaAgents: new Map(),
    }), false);
  check('an own terminal is never handled by the non-own path',
    heartbeat.isNonOwnKimiTerminal({
      handle: 'term_mine', ownHandles: own, panelHandle: 'term_panel', machineAgents, orcaAgents,
    }), false);
  check('the operator panel is never handled by the non-own path',
    heartbeat.isNonOwnKimiTerminal({
      handle: 'term_panel', ownHandles: own, panelHandle: 'term_panel', machineAgents, orcaAgents,
    }), false);

  // machineTerminalAgents rebuilds the cross-session map from gate state files.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-machine-agents-'));
  fs.writeFileSync(path.join(dir, 'other-session.json'), JSON.stringify({
    workers: {
      term_foreign_kimi: { agent: 'kimi', kind: 'terminal', status: 'live' },
      ctx_no_terminal: { agent: 'kimi' },
    },
  }));
  fs.writeFileSync(path.join(dir, 'kimi-quota-live.json'), JSON.stringify({ failed: true }));
  check('the machine-wide agent map reads other sessions\' terminal workers',
    heartbeat.machineTerminalAgents(dir).get('term_foreign_kimi'), 'kimi');
  check('non-terminal worker rows are not terminal agents',
    heartbeat.machineTerminalAgents(dir).has('ctx_no_terminal'), false);
  fs.rmSync(dir, { recursive: true, force: true });

  // An untracked NON-Kimi terminal showing the indented 403 (a displayed log/fixture)
  // must not mark; another session's Kimi terminal marks silently (no event).
  const indented403 = '    403 You\'ve reached your 5-hour usage limit';
  check('the indented 403 line still matches the exhausted signal', hasKimiUsageExhausted(indented403), true);
  const calls = [];
  heartbeat.setOnCoderExhausted((coder, info) => calls.push([coder, info]));
  const reported = new Map();
  const now = Date.now();
  if (heartbeat.isNonOwnKimiTerminal({
    handle: 'term_other_codex', ownHandles: own, panelHandle: 'term_panel', machineAgents, orcaAgents,
  })) {
    heartbeat.reportUsageExhausted({ reported, handle: 'term_other_codex', label: 'x', coder: 'kimi', windowHours: 5, now, silent: true });
  }
  check('an untracked non-Kimi terminal showing an indented 403 marks nothing', [calls.length, reported.size], [0, 0]);
  const silent = heartbeat.reportUsageExhausted({
    reported, handle: 'term_other_kimi', label: 'term_other_kimi (worker)', coder: 'kimi',
    windowHours: kimiUsageLimitHours(indented403), now, silent: true,
  });
  check('another session\'s Kimi terminal marks WITHOUT an event', silent, null);
  check('the exhaustion marker hook still fired for the other session\'s Kimi terminal',
    calls.map(([coder]) => coder), ['kimi']);
  check('the silent episode is persisted', reported.get('term_other_kimi').until > now, true);
  heartbeat.setOnCoderExhausted(null);
}

// --- gate: sonnet dispatch allowed when nothing external is eligible ----------

function gate(env, payload) {
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(payload), encoding: 'utf8', env });
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-kimi-exhausted-'));
  const stateDir = path.join(root, 'state');
  const kimiHome = path.join(root, 'kimi-home');
  fs.mkdirSync(path.join(kimiHome, 'credentials'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(kimiHome, 'credentials', 'kimi-code.json'),
    JSON.stringify({ access_token: 'fixture-token-never-print', expires_at: Date.now() + 3600_000 }));
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    activation: 'always', replyLanguage: null, maxParallelAgents: 0,
    models: { code: { alias: 'sonnet', id: null, effort: 'medium', agentType: 'sonnet-coder' } },
    execFallbackWhenCodexUnavailable: 'sonnet',
  }));
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(ORCHESTRATOR_GATE|ORCH_|ORCA_TERMINAL_HANDLE|CODEX_HOME|CLAUDE_CODE_|STUB_CODEX_)/.test(key)));
  const env = {
    ...base, ORCH_STATE_DIR: stateDir, ORCH_CONFIG_PATH: configFile, ORCA_BIN: ORCA_STUB,
    ORCH_CODEX_BIN: CODEX_STUB, CODEX_BIN: CODEX_STUB, ORCH_KIMI_HOME: kimiHome, ORCH_KIMI_BIN: KIMI_STUB,
    ORCH_KIMI_USAGE_URL: 'http://127.0.0.1:9/usages',
  };
  const now = Date.now();
  const resetsAt = Math.floor(now / 1000) + 3600;
  fs.writeFileSync(path.join(stateDir, 'codex-quota-live.json'),
    JSON.stringify({ usedPercent: 99, resetsAt, fetchedAt: now }));
  fs.writeFileSync(path.join(stateDir, 'kimi-quota-live.json'),
    JSON.stringify({ usedPercent: 100, resetsAt, fetchedAt: now }));
  const sid = 'exhausted-both';
  const reminder = gate(env, { session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'status' }).stdout;
  check('the reminder routes code to the in-session model', /code -> sonnet/.test(reminder), true);
  const dispatch = gate(env, {
    session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_sonnet_code', cwd: ROOT,
    tool_input: {
      description: 'Implement the parser change', subagent_type: 'sonnet-coder', model: 'sonnet',
      isolation: 'worktree', prompt: 'Implement the parser change.\nverify: npm test',
    },
  });
  check('the in-session sonnet-coder dispatch is allowed', dispatch.status, 0);
  check('no refusal in favour of an exhausted coder', /route-execution-to-codex/.test(`${dispatch.stderr}${dispatch.stdout}`), false);
  fs.rmSync(root, { recursive: true, force: true });
}

fs.rmSync(STATE_DIR, { recursive: true, force: true });
process.stdout.write(`${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.exitCode = 1;
}
