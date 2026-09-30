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
      if (process.env.STUB_CODEX_MODE === 'logged-out' ||
          process.env.STUB_CODEX_MODE === 'account-read-unsupported') {
        process.stdout.write(`${JSON.stringify({ id: 2, error: { message: 'rate limits unavailable' } })}\n`);
        continue;
      }
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
      const result = { rateLimits };
      if (process.env.STUB_CODEX_RATE_LIMIT_REACHED_TYPE) {
        result.rateLimitReachedType = process.env.STUB_CODEX_RATE_LIMIT_REACHED_TYPE;
      }
      if (process.env.STUB_CODEX_ORDINARY_USAGE_ALLOWED === 'false') result.ordinaryUsageAllowed = false;
      process.stdout.write(`${JSON.stringify({ id: 2, result })}\n`);
    } else if (message.id === 3) {
      if (process.env.STUB_CODEX_MODE === 'logged-out') {
        process.stdout.write(`${JSON.stringify({ id: 3, result: { account: null, requiresOpenaiAuth: true } })}\n`);
      } else if (process.env.STUB_CODEX_MODE === 'account-read-unsupported') {
        process.stdout.write(`${JSON.stringify({ id: 3, error: { message: 'method not found' } })}\n`);
      } else {
        // Keep the default id 1/id 2 behaviour unchanged while answering unexpected id 3 promptly.
        process.stdout.write(`${JSON.stringify({ id: 3, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } })}\n`);
      }
    }
  }
});
