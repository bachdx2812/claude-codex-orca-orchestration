#!/usr/bin/env node
/**
 * Tests for the opencode "worker never started" heartbeat signal: the welcome/home screen
 * classifier (with ANSI codes and box gutter), the `▣` turn-marker detector, the
 * once-per-episode report that fires after NEVER_STARTED_SECONDS of CONTINUOUS welcome-screen
 * time, the delivered flag (a turn marker / finished message suppresses the report for good),
 * and the prune of records for terminals no longer supervised.
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

const fixture = (name) => fs.readFileSync(
  path.join(__dirname, 'fixtures', name), 'utf8');
const welcome = fixture('screen-opencode-welcome.txt');
const turnStarted = fixture('screen-opencode-turn-started.txt');
const thinkingQuotedAsk = fixture('screen-opencode-thinking-quoted-ask.txt');
const readmeGrep = fixture('screen-opencode-readme-grep.txt');

// --- screen classifier ---------------------------------------------------------

check('the welcome screen (ANSI + gutter) is the opencode home screen',
  opencodeWelcomeScreen(welcome), true);
check('the welcome screen shows no turn marker', opencodeTurnMarker(welcome), false);
check('a screen after a turn started is NOT the welcome screen',
  opencodeWelcomeScreen(turnStarted), false);
check('a screen after a turn started has a turn marker', opencodeTurnMarker(turnStarted), true);

// Real opencode screens indent the box gutter (2 spaces, then the box char, then 2 spaces);
// the gutter must be stripped AFTER trimming so the anchored placeholder match still fires.
check('the indented box gutter (2 spaces + ┃ + 2 spaces) still matches',
  opencodeWelcomeScreen('  ┃  Ask anything…\n  ┃  ● Tip: hello\n  ┃  opencode v1.0.0'), true);

// The three-dot spelling of the placeholder matches the same as the ellipsis.
check('the three-dot "Ask anything..." placeholder also matches',
  opencodeWelcomeScreen('│  Ask anything...\n│  ● Tip: hello'), true);
check('a placeholder with the version footer still matches',
  opencodeWelcomeScreen('│  Ask anything…\n│  opencode v1.0.0'), true);
check('a screen without the placeholder is NOT welcome', opencodeWelcomeScreen('│  ● Tip: hello'), false);
check('a placeholder WITH a turn marker is NOT welcome',
  opencodeWelcomeScreen('│  ▣  Build · 2s · 3 tokens\n│  Ask anything…'), false);
check('empty/blank screen is NOT welcome', opencodeWelcomeScreen(''), false);
check('a turn marker alone does not count as welcome', opencodeWelcomeScreen('▣  Build · 1s · 1 token'), false);

// The placeholder must START its line: a quoted "Ask anything" mid-line (a Thinking step) or
// this repo's README/grep output can never look like the idle input box.
check('a quoted "Ask anything…" in a Thinking step above an esc-interrupt footer is NOT welcome',
  opencodeWelcomeScreen(thinkingQuotedAsk), false);
check('README grep output mentioning "Ask anything" is NOT welcome',
  opencodeWelcomeScreen(readmeGrep), false);
check('"Ask anything" not at the start of its line is NOT welcome',
  opencodeWelcomeScreen('│  the placeholder says "Ask anything…" when idle\n│  ● Tip: hello'), false);
check('a ● Tip line mentioning esc/interrupt does NOT suppress the welcome signal',
  opencodeWelcomeScreen('│  Ask anything…\n│  ● Tip: Press esc to interrupt'), true);
check('a real running footer (esc interrupt + ctrl+p) rejects the welcome screen',
  opencodeWelcomeScreen('│  Ask anything…\n│  ● Tip: hello\n│  esc interrupt · ctrl+p model'), false);
check('the placeholder alone (no version footer / tip line) is NOT welcome',
  opencodeWelcomeScreen('│  Ask anything…'), false);

// --- once-per-episode report ---------------------------------------------------

const NOW = 1800000000000;
const reported = new Map();

check('the first welcome observation records the episode and does not fire',
  heartbeat.reportNeverStarted({ reported, handle: 'term_o1', now: NOW, identity: 'ctx_o1' }), null);
check('the episode is persisted for a daemon restart',
  heartbeat.loadPersistedNeverStarted().get('term_o1'),
  { firstSeenAt: NOW, reported: false, delivered: false });
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

// The 90s must be continuous: leaving the welcome screen clears an UNREPORTED episode.
{
  const r = new Map();
  heartbeat.reportNeverStarted({ reported: r, handle: 'term_c', now: NOW, identity: 'ctx_c' });
  check('leaving the welcome screen clears the unreported episode',
    heartbeat.clearNeverStartedEpisode({ reported: r, handle: 'term_c' }), true);
  check('the cleared episode is gone from persistence',
    heartbeat.loadPersistedNeverStarted().has('term_c'), false);
  heartbeat.reportNeverStarted({ reported: r, handle: 'term_c', now: NOW + 30 * 1000, identity: 'ctx_c' });
  check('a fresh welcome observation after clearing restarts the clock',
    heartbeat.reportNeverStarted({ reported: r, handle: 'term_c', now: NOW + 30 * 1000 + 89 * 1000, identity: 'ctx_c' }), null);
  check('90s continuous after the restart fires again',
    typeof heartbeat.reportNeverStarted({ reported: r, handle: 'term_c', now: NOW + 30 * 1000 + 90 * 1000, identity: 'ctx_c' }),
    'string');
  check('clearing an already-reported episode is a no-op',
    heartbeat.clearNeverStartedEpisode({ reported: r, handle: 'term_c' }), false);
  check('clearing a never-seen handle is a no-op',
    heartbeat.clearNeverStartedEpisode({ reported: r, handle: 'term_never_seen' }), false);
}

// A finished message (the `▣` box-glyph line) marks the brief delivered: NEVER emit again,
// even after a later `/new` back to the welcome screen.
{
  const r = new Map();
  heartbeat.reportNeverStarted({ reported: r, handle: 'term_d', now: NOW, identity: 'ctx_d' });
  check('a turn marker marks the brief delivered',
    heartbeat.markNeverStartedDelivered({ reported: r, handle: 'term_d' }), true);
  check('the delivered record persists',
    heartbeat.loadPersistedNeverStarted().get('term_d'),
    { firstSeenAt: 0, reported: true, delivered: true });
  check('a welcome screen after delivery never fires again',
    heartbeat.reportNeverStarted({ reported: r, handle: 'term_d', now: NOW + 1000 * 1000, identity: 'ctx_d' }), null);
  check('marking an already-delivered handle is a no-op',
    heartbeat.markNeverStartedDelivered({ reported: r, handle: 'term_d' }), false);
}

// Prune records for terminals no longer supervised, so a later re-use starts fresh.
{
  const r = new Map();
  heartbeat.reportNeverStarted({ reported: r, handle: 'term_keep', now: NOW, identity: 'ctx_k' });
  heartbeat.reportNeverStarted({ reported: r, handle: 'term_drop', now: NOW, identity: 'ctx_x' });
  check('prune drops records for unsupervised handles',
    heartbeat.pruneNeverStarted({ reported: r, keepHandles: new Set(['term_keep']) }), true);
  check('the supervised handle is kept',
    heartbeat.loadPersistedNeverStarted().has('term_keep'), true);
  check('the unsupervised handle is dropped',
    heartbeat.loadPersistedNeverStarted().has('term_drop'), false);
  check('prune with nothing to drop is a no-op',
    heartbeat.pruneNeverStarted({ reported: r, keepHandles: new Set(['term_keep']) }), false);
}

// --- summary -------------------------------------------------------------------

fs.rmSync(STATE_DIR, { recursive: true, force: true });

if (failures.length) {
  console.error(`${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log(`${pass} passed, 0 failed`);
