#!/usr/bin/env node
/**
 * Interactive JSON-RPC adapter used by exec-route-by-quota.cjs. The hook itself must
 * stay synchronous, so its parent runs this helper with spawnSync and a 5s timeout.
 */

const { spawn } = require('child_process');

const codexBin = process.argv[2] || 'codex';
const child = spawn(codexBin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
const DEADLINE_MS = 4500;
const STOP_GRACE_MS = 150;
let buffer = '';
let finished = false;
let exitCode = 1;
let forceTimer = null;
let rateLimitError = '';

const deadline = setTimeout(() => stop(1), DEADLINE_MS);

function exitNow() {
  clearTimeout(deadline);
  if (forceTimer) clearTimeout(forceTimer);
  process.exit(exitCode);
}

function stop(code, value) {
  if (finished) return;
  finished = true;
  exitCode = code;
  clearTimeout(deadline);
  if (value !== undefined) process.stdout.write(`${JSON.stringify(value)}\n`);
  try { child.stdin.end(); } catch {}
  try { child.kill('SIGTERM'); } catch {}
  forceTimer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
    // An `error` event can mean no child process was ever created, in which case no `exit`
    // event is guaranteed. Give a killed child one event-loop turn, then leave regardless.
    setTimeout(exitNow, 25);
  }, STOP_GRACE_MS);
}

function send(message) {
  try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { stop(1); }
}

child.on('error', () => stop(1));
child.on('exit', (code) => {
  if (!finished) {
    finished = true;
    // Never forward a child exit code: exit 3 is reserved for our exact logged-out payload.
    exitCode = 1;
  }
  exitNow();
});
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === 1 && message.result) {
      send({ method: 'initialized' });
      send({ id: 2, method: 'account/rateLimits/read', params: {} });
    } else if (message.id === 2) {
      if (!message.result || message.error) {
        rateLimitError = String(message.error && message.error.message || '');
        send({ id: 3, method: 'account/read', params: { refreshToken: false } });
      }
      else stop(0, message.result);
    } else if (message.id === 3) {
      const result = message.result;
      if (result && result.account === null && result.requiresOpenaiAuth === true) {
        stop(3, { authState: 'logged-out' });
      } else if ((message.error || !result) &&
          /not\s+(?:logged|signed)\s+in|authentication\s+required/i.test(rateLimitError)) {
        // The rateLimits error text only counts as a logged-out signal when
        // account/read itself errored; a successful account/read answer wins.
        stop(3, { authState: 'logged-out' });
      } else {
        stop(1);
      }
    }
  }
});

process.on('SIGTERM', () => stop(1));
process.on('SIGINT', () => stop(1));
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'orchestrator-quota', version: '1' } } });
