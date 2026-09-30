#!/usr/bin/env node
'use strict';

const http = require('http');

const token = process.env.STUB_KIMI_TOKEN || 'fixture-token';
const status = Number(process.env.STUB_KIMI_STATUS || 200);
const delayMs = Number(process.env.STUB_KIMI_DELAY_MS || 0);
let hits = 0;

const server = http.createServer((req, res) => {
  hits += 1;
  const authorization = req.headers.authorization || '';
  process.stdout.write(`HIT ${hits} AUTH ${authorization === `Bearer ${token}`}\n`);
  const configured = process.env.STUB_KIMI_BODY;
  const body = process.env.STUB_KIMI_ECHO_AUTH === '1'
    ? JSON.stringify({ error: authorization })
    : configured !== undefined ? configured : JSON.stringify({
      usage: { limit: 100, remaining: 75, resetTime: new Date(Date.now() + 86400000).toISOString() },
    });
  setTimeout(() => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  }, delayMs);
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT ${server.address().port}\n`);
});

function close() { server.close(() => process.exit(0)); }
process.on('SIGTERM', close);
process.on('SIGINT', close);
