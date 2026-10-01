#!/usr/bin/env node
'use strict';

/**
 * Loopback stand-in for `GET https://api.deepseek.com/user/balance`, run as a SEPARATE
 * process (a probe spawned via spawnSync blocks this process's event loop, so an in-process
 * server could never answer it). Prints `PORT <n>` on stdout then the configured body.
 *
 * STUB_DEEPSEEK_BODY overrides the default `{ is_available: false }`; STUB_DEEPSEEK_TOKEN
 * makes it print whether the probe's Authorization header matched.
 */

const http = require('http');

const token = process.env.STUB_DEEPSEEK_TOKEN || '';
let hits = 0;

const server = http.createServer((req, res) => {
  hits += 1;
  const authorization = req.headers.authorization || '';
  process.stdout.write(`HIT ${hits} AUTH ${token ? authorization === `Bearer ${token}` : 'n/a'}\n`);
  const body = process.env.STUB_DEEPSEEK_BODY !== undefined
    ? process.env.STUB_DEEPSEEK_BODY
    : JSON.stringify({ is_available: false });
  res.writeHead(Number(process.env.STUB_DEEPSEEK_STATUS || 200), { 'content-type': 'application/json' });
  res.end(body);
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT ${server.address().port}\n`);
});

function close() { server.close(() => process.exit(0)); }
process.on('SIGTERM', close);
process.on('SIGINT', close);
