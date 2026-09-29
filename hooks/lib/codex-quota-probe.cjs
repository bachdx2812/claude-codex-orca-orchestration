#!/usr/bin/env node
/**
 * Interactive JSON-RPC adapter used by exec-route-by-quota.cjs. The hook itself must
 * stay synchronous, so its parent runs this helper with spawnSync and a 5s timeout.
 */

const { spawn } = require('child_process');

const codexBin = process.argv[2] || 'codex';
const child = spawn(codexBin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
let buffer = '';
let finished = false;

function stop(code, value) {
  if (finished) return;
  finished = true;
  if (value !== undefined) process.stdout.write(`${JSON.stringify(value)}\n`);
  try { child.kill(); } catch {}
  process.exit(code);
}

function send(message) {
  try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { stop(1); }
}

child.on('error', () => stop(1));
child.on('exit', (code) => { if (!finished) stop(code === 0 ? 1 : (code || 1)); });
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
      if (!message.result || message.error) stop(1);
      else stop(0, message.result);
    }
  }
});

process.on('SIGTERM', () => stop(1));
process.on('SIGINT', () => stop(1));
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'orchestrator-quota', version: '1' } } });
