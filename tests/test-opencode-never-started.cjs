#!/usr/bin/env node
/**
 * Tests for the opencode "worker never started" heartbeat signal: the welcome/home screen
 * classifier (with ANSI codes and box gutter), the `▣` turn-marker detector, and the
 * once-per-episode report that fires after NEVER_STARTED_SECONDS on the welcome screen and
 * re-arms when a turn marker appears.
 *
 * Hermetic: state lives under a fresh ORCH_STATE_DIR; no real orca/opencode binary, no
 * network.
 *
 * Run: node tests/test-opencode-never-started.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-never-started-'));
process.env.ORCH_STATE_DIR = STATE_DIR;
process.env.ORCH_CONFIG_PATH = path.join(STATE_DIR, 'no-such-config.json'); // -> defaults
process.env.CLAUDE_CODE_SESSION_ID = 'never-started-test';

const heartbeat = require('../hooks/orca-heartbeat.cjs');
const SIGNALS = require('../hooks/lib/terminal-signals.cjs');
const { opencodeWelcomeScreen, opencodeTurnMarker } = SIGNALS;

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass += 1;
  else failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
}

const welcome = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'screen-opencode-welcome.txt'), 'utf8');
const turnStarted = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'screen-opencode-turn-started.txt'), 'utf8');

// --- screen classifier ---------------------------------------------------------

check('the welcome screen (ANSI + gutter) is the opencode home screen',
  opencodeWelcomeScreen(welcome), true);
check('the welcome screen shows no turn marker', opencodeTurnMarker(welcome), false);
check('a screen after a turn started is NOT the welcome screen',
  opencodeWelcomeScreen(turnStarted), false);
check('a screen after a turn started has a turn marker', opencodeTurnMarker(turnStarted), true);

// The three-dot spelling of the placeholder matches the same as the ellipsis.
check('the three-dot "Ask anything..." placeholder also matches',
  opencodeWelcomeScreen('│  Ask anything...\n│  ● Tip: hello'), true);
check('a placeholder with a trailing hint still matches',
  opencodeWelcomeScreen('│  Ask anything, / for commands, @ for context\n│  opencode v1.0.0'), true);
check('a screen without the placeholder is NOT welcome', opencodeWelcomeScreen('│  ● Tip: hello'), false);
check('a placeholder WITH a turn marker is NOT welcome',
  opencodeWelcomeScreen('│  ▣  Build · 2s · 3 tokens\n│  Ask anything…'), false);
check('empty/blank screen is NOT welcome', opencodeWelcomeScreen(''), false);
check('a turn marker alone does not count as welcome', opencodeWelcomeScreen('▣  Build · 1s · 1 token'), false);

// --- once-per-episode report ---------------------------------------------------

const NOW = 1800000000000;
const reported = new Map();

check('the first welcome observation records the episode and does not fire',
  heartbeat.reportNeverStarted({ reported, handle: 'term_o1', now: NOW, identity: 'ctx_o1' }), null);
check('the episode is persisted for a daemon restart',
  heartbeat.loadPersistedNeverStarted().get('term_o1'),
  { firstSeenAt: NOW, reported: false });
check('before 90s the episode still does not fire',
  heartbeat.reportNeverStarted({ reported, handle: 'term_o1', now: NOW + 89 * 1000, identity: 'ctx_o1' }), null);
check('at exactly 90s the episode fires the WORKER NEVER STARTED event',
  typeof heartbeat.reportNeverStarted({ reported, handle: 'term_o1', now: NOW + 90 * 1000, identity: 'ctx_o1' }),
  'string');
const event = heartbeat.reportNeverStarted(
  { reported: heartbeat.loadPersistedNeverStarted(), handle: 'term_o1', now: NOW + 91 * 1000, identity: 'ctx_o1' });
check('the event is not re-emitted once reported', event, null);
check('the persisted record marks the episode reported',
  heartbeat.loadPersistedNeverStarted().get('term_o1').reported, true);

const firstEvent = (() => {
  const r = new Map();
  return heartbeat.reportNeverStarted({ reported: r, handle: 'term_o1', now: NOW, identity: 'ctx_o1' }) ||
    heartbeat.reportNeverStarted({ reported: r, handle: 'term_o1', now: NOW + 90 * 1000, identity: 'ctx_o1' });
})();
check('the event text names the dispatch, coder and resend recipe',
  firstEvent,
  "WORKER NEVER STARTED ctx_o1 (opencode, brief not delivered) - resend the brief: " +
  "orca terminal send --terminal term_o1 --text '<one-line brief>' --enter");

// Re-arm: a turn marker clears the episode, so a later welcome screen is a fresh episode.
heartbeat.rearmNeverStarted({ reported, handle: 'term_o1' });
check('re-arm clears the persisted episode',
  heartbeat.loadPersistedNeverStarted().has('term_o1'), false);
check('a fresh welcome observation after re-arm starts a new episode',
  heartbeat.reportNeverStarted({ reported, handle: 'term_o1', now: NOW + 200 * 1000, identity: 'ctx_o1' }), null);
check('the new episode fires again after its own 90s',
  typeof heartbeat.reportNeverStarted({ reported, handle: 'term_o1', now: NOW + 290 * 1000, identity: 'ctx_o1' }),
  'string');
check('re-arm is a no-op for a handle with no episode',
  heartbeat.rearmNeverStarted({ reported, handle: 'term_never_seen' }), undefined);

// --- summary -------------------------------------------------------------------

fs.rmSync(STATE_DIR, { recursive: true, force: true });

if (failures.length) {
  console.error(`${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log(`${pass} passed, 0 failed`);
