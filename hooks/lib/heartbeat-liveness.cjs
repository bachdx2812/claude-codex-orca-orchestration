#!/usr/bin/env node
/**
 * heartbeat-liveness.cjs — the single "is this session's heartbeat daemon actually alive"
 * check, shared by orchestrator-gate.cjs (its own session, for the Stop gate + reminders)
 * and lib/parallel-agent-cap.cjs (OTHER sessions, for the M1 cross-session counting rule —
 * see that file's doc comment). Extracted here rather than importing orchestrator-gate.cjs
 * from parallel-agent-cap.cjs, which would be a circular require (orchestrator-gate.cjs
 * already requires parallel-agent-cap.cjs).
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The heartbeat daemon `sid` started, if it is alive: its liveness file exists, its pid
 * answers, and it ticked within three intervals (plus a 30s grace margin). Returns the
 * parsed liveness record, or null when any of that is not true — a missing file, a dead
 * pid, or a stale `last_tick` are all treated identically as "not alive", never a crash.
 */
function heartbeatAliveAt(dir, sid) {
  try {
    const f = path.join(dir, `heartbeat-${String(sid || 'default').replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
    const b = JSON.parse(fs.readFileSync(f, 'utf8'));
    process.kill(b.pid, 0); // throws when the process is gone
    const maxAge = (Number(b.interval) || 20) * 3000 + 30000;
    return Date.now() - Number(b.last_tick || 0) <= maxAge ? b : null;
  } catch {
    return null;
  }
}

module.exports = { heartbeatAliveAt };
