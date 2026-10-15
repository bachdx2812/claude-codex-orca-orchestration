#!/usr/bin/env node
/**
 * test-heartbeat-coalesce.cjs - wake classification and done-notice coalescing in the
 * heartbeat daemon, exercised end to end: the real daemon is spawned against the orca stub
 * whose worker/terminal rows are files this test rewrites on a timeline.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const classes = require('../hooks/lib/heartbeat-event-classes.cjs');

const HEARTBEAT = path.join(__dirname, '..', 'hooks', 'orca-heartbeat.cjs');
const STUB = path.join(__dirname, 'fixtures', 'orca-stub.cjs');
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-hb-coalesce-'));

let pass = 0;
const failures = [];
function check(name, cond) {
  if (cond) pass += 1; else failures.push(name);
}

const row = (id, state) => ({
  dispatchId: id, taskId: `task_${id}`, agentTerminalHandle: `term_${id}`,
  workerState: state, dispatchStatus: state, terminalState: state === 'running' ? 'active' : 'released',
  projection: { role: 'worker' },
});

/**
 * Spawns the daemon with `--interval 1 --max 6`. `timeline` is [{at (ms), workers?, terminals?}]
 * rewrites applied after spawn; `killAt` SIGTERMs the daemon (a crash stand-in). Resolves with
 * the combined output, wall-clock ms, the heartbeat log and the state dir.
 */
function run({ name, initial, terminalsInitial = [], timeline = [], coalesce, extraArgs = [], killAt, dirName, session }) {
  return new Promise((resolve) => {
    const dir = path.join(RUN_DIR, dirName || name);
    fs.mkdirSync(dir, { recursive: true });
    const workersFile = path.join(dir, 'workers.json');
    const terminalsFile = path.join(dir, 'terminals.json');
    const cfgFile = path.join(dir, 'config.json');
    fs.writeFileSync(workersFile, JSON.stringify(initial));
    fs.writeFileSync(terminalsFile, JSON.stringify(terminalsInitial));
    fs.writeFileSync(cfgFile, JSON.stringify({ closeDoneWorktrees: 'off' }));
    const env = {
      ...process.env,
      ORCA_BIN: STUB, ORCH_STATE_DIR: dir, ORCH_CONFIG_PATH: cfgFile,
      CLAUDE_CODE_SESSION_ID: session || `hb-${name}`,
      STUB_WORKERS_JSON: `@${workersFile}`, STUB_TERMINALS_JSON: `@${terminalsFile}`,
      ORCH_HEARTBEAT_COALESCE_DONE_SECONDS: String(coalesce),
    };
    const start = Date.now();
    const child = spawn(process.execPath, [HEARTBEAT, '--interval', '1', '--max', '6', ...extraArgs], { env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    for (const step of timeline) {
      setTimeout(() => {
        if (step.workers) fs.writeFileSync(workersFile, JSON.stringify(step.workers));
        if (step.terminals) fs.writeFileSync(terminalsFile, JSON.stringify(step.terminals));
      }, step.at);
    }
    if (killAt) setTimeout(() => child.kill('SIGTERM'), killAt);
    const safety = setTimeout(() => child.kill('SIGKILL'), 12000);
    child.on('exit', () => {
      clearTimeout(safety);
      let log = '';
      try { log = fs.readFileSync(path.join(dir, 'heartbeat.log'), 'utf8'); } catch {}
      resolve({ out, ms: Date.now() - start, log, dir });
    });
  });
}

(async () => {
  // Pure classification and summary format.
  check('queued -> running is info', classes.classifyWorkerTransition('queued|queued|active', 'running|running|active') === 'info');
  check('running -> succeeded is done', classes.classifyWorkerTransition('running|running|active', 'succeeded|succeeded|released') === 'done');
  check('running -> failed is urgent', classes.classifyWorkerTransition('running|running|active', 'failed|failed|active') === 'urgent');
  check('summary lists ids and reminders',
    classes.formatDoneSummary([{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }, { text: 'wt reminder' }]) ===
    'DONE: 2 worker(s) finished: a, b (+ wt reminder)');

  // 1. Routine transitions never wake the panel; they land in the log.
  {
    const r = await run({
      name: 'info-only', coalesce: 300, initial: [row('A', 'queued')],
      timeline: [{ at: 1500, workers: [row('A', 'running')] }],
    });
    check('info: daemon ran to the quiet deadline', r.out.includes('quiet for 6s'));
    check('info: no wake event printed', !/event\(s\) after/.test(r.out));
    check('info: transition recorded in heartbeat.log', /worker A changed: queued.*-> running\|running\|active/.test(r.log));
  }

  // 2. Two workers finishing at different times produce one combined wake after the last.
  {
    const r = await run({
      name: 'two-done', coalesce: 300, initial: [row('A', 'running'), row('B', 'running')],
      timeline: [
        { at: 1500, workers: [row('A', 'succeeded'), row('B', 'running')] },
        { at: 3500, workers: [row('A', 'succeeded'), row('B', 'succeeded')] },
      ],
    });
    check('two-done: exits only after the last worker', r.ms >= 3500 && r.ms < 6000);
    check('two-done: a single wake', (r.out.match(/event\(s\) after/g) || []).length === 1);
    check('two-done: one summary line names both', /DONE: 2 worker\(s\) finished: A, B/.test(r.out));
  }

  // 3. The coalescing window flushes a lone done notice while another worker still runs.
  {
    const r = await run({
      name: 'window', coalesce: 2, initial: [row('A', 'running'), row('B', 'running')],
      timeline: [{ at: 1500, workers: [row('A', 'succeeded'), row('B', 'running')] }],
    });
    check('window: waits for the window, not the other worker', r.ms >= 3500 && r.ms < 6000);
    check('window: summary lists only A', /DONE: 1 worker\(s\) finished: A/.test(r.out) && !/finished: A, B/.test(r.out));
  }

  // 4. An urgent event flushes immediately with the buffered done notice appended.
  {
    const base = Date.now();
    const quiet = [{ handle: 'term_B', lastOutputAt: base + 100000 }];
    const stale = [{ handle: 'term_B', lastOutputAt: base + 1000 }];
    const r = await run({
      name: 'urgent-with-done', coalesce: 300, extraArgs: ['--idle', '1'],
      initial: [row('A', 'running'), row('B', 'running')], terminalsInitial: quiet,
      timeline: [
        { at: 1500, workers: [row('A', 'succeeded'), row('B', 'running')] },
        { at: 2500, terminals: stale },
      ],
    });
    check('urgent: exits well before the coalescing window', r.ms >= 2500 && r.ms < 6000);
    check('urgent: IDLE event present', /IDLE \d+s: term_B/.test(r.out));
    check('urgent: buffered done appended', /DONE: 1 worker\(s\) finished: A/.test(r.out));
  }

  // 5. Window 0 keeps the legacy immediate wake on the first done worker.
  {
    const r = await run({
      name: 'legacy', coalesce: 0, initial: [row('A', 'running'), row('B', 'running')],
      timeline: [{ at: 1500, workers: [row('A', 'succeeded'), row('B', 'running')] }],
    });
    check('legacy: exits on the first done worker', r.ms < 4000 && /worker A changed/.test(r.out));
  }

  // 6. A killed daemon's buffered notice is delivered by the restart once nothing is active.
  {
    const dirName = 'restart';
    const session = 'hb-restart';
    const first = await run({
      name: 'restart-1', dirName, session, coalesce: 300,
      initial: [row('A', 'running'), row('B', 'running')],
      timeline: [{ at: 1500, workers: [row('A', 'succeeded'), row('B', 'running')] }],
      killAt: 3200,
    });
    const pendingFile = path.join(first.dir, `heartbeat-${session}-pending.json`);
    check('restart: pending notice persisted', fs.existsSync(pendingFile) && fs.readFileSync(pendingFile, 'utf8').includes('"A"'));
    const second = await run({
      name: 'restart-2', dirName, session, coalesce: 300,
      initial: [row('A', 'succeeded'), row('B', 'succeeded')],
    });
    check('restart: flushed immediately at startup', second.ms < 2500 && /DONE: 1 worker\(s\) finished: A/.test(second.out));
    check('restart: pending file cleared after the flush', !fs.existsSync(pendingFile));
  }

  // 7. A failed worker wakes at once.
  {
    const r = await run({
      name: 'failed', coalesce: 300, initial: [row('A', 'running'), row('B', 'running')],
      timeline: [{ at: 1500, workers: [row('A', 'failed'), row('B', 'running')] }],
    });
    check('failed: immediate exit', r.ms < 4000 && /worker A changed: .*-> failed/.test(r.out));
  }

  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  if (failures.length) {
    console.error(`FAIL ${failures.length} (pass ${pass}):\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`test-heartbeat-coalesce: ${pass} checks passed`);
})();
