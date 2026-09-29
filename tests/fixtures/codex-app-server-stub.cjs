#!/usr/bin/env node

const fs = require('fs');

if (process.env.STUB_CODEX_CALLS_LOG) {
  fs.appendFileSync(process.env.STUB_CODEX_CALLS_LOG, `${Date.now()}\t${process.pid}\n`);
}
if (process.env.STUB_CODEX_PID_FILE) {
  fs.writeFileSync(process.env.STUB_CODEX_PID_FILE, String(process.pid));
}
if (process.env.STUB_CODEX_MODE === 'ignore-signals') {
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
}

let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === 1) {
      if (process.env.STUB_CODEX_MODE === 'timeout' || process.env.STUB_CODEX_MODE === 'ignore-signals') continue;
      process.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    } else if (message.id === 2) {
      if (process.env.STUB_CODEX_MODE === 'malformed') {
        process.stdout.write(`${JSON.stringify({ id: 2, result: { nope: true } })}\n`);
        continue;
      }
      const now = Math.floor(Date.now() / 1000);
      const primaryUsed = Number(process.env.STUB_CODEX_PRIMARY_USED || 0);
      const secondaryRaw = process.env.STUB_CODEX_SECONDARY_USED;
      const primaryReset = Number(process.env.STUB_CODEX_PRIMARY_RESET || now + 3600);
      const secondaryReset = Number(process.env.STUB_CODEX_SECONDARY_RESET || now + 86400);
      const rateLimits = {
        primary: { usedPercent: primaryUsed, resetsAt: primaryReset },
      };
      if (secondaryRaw !== undefined) {
        rateLimits.secondary = { usedPercent: Number(secondaryRaw), resetsAt: secondaryReset };
      }
      process.stdout.write(`${JSON.stringify({ id: 2, result: { rateLimits } })}\n`);
    }
  }
});
