#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const DEADLINE_MS = 3000;
let finished = false;

function finish(value, code = 1) {
  if (finished) return;
  finished = true;
  process.stdout.write(`${JSON.stringify(value)}\n`, () => process.exit(code));
}

function failure(kind, status) {
  const value = { ok: false, kind };
  if (Number.isInteger(status)) value.status = status;
  finish(value, 1);
}

function expiryMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const home = Object.prototype.hasOwnProperty.call(process.env, 'ORCH_KIMI_HOME')
  ? process.env.ORCH_KIMI_HOME
  : path.join(os.homedir(), '.kimi-code');
const credentialsFile = path.join(home, 'credentials', 'kimi-code.json');
let credentials;
try { credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8')); } catch {}
if (!credentials || typeof credentials.access_token !== 'string' || !credentials.access_token) {
  failure('no-credentials');
} else {
  const expiresAt = expiryMs(credentials.expires_at);
  if (expiresAt !== null && expiresAt <= Date.now()) {
    failure('expired');
  } else {
    const defaultBase = process.env.KIMI_CODE_BASE_URL || 'https://api.kimi.com/coding/v1';
    const requested = process.env.ORCH_KIMI_USAGE_URL || `${defaultBase.replace(/\/$/, '')}/usages`;
    let url;
    try { url = new URL(requested); } catch { failure('parse'); }
    if (!finished) {
      const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        failure('insecure-url');
      } else {
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.get(url, {
          headers: { Authorization: `Bearer ${credentials.access_token}`, Accept: 'application/json' },
        }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            if (body.length <= 2 * 1024 * 1024) body += chunk;
          });
          response.on('end', () => {
            const status = Number(response.statusCode || 0);
            if (status === 401 || status === 403) return failure('unauthorized', status);
            if (status < 200 || status >= 300) return failure('http', status);
            try { finish({ ok: true, body: JSON.parse(body) }, 0); } catch { failure('parse', status); }
          });
        });
        req.setTimeout(DEADLINE_MS, () => {
          req.destroy();
          failure('timeout');
        });
        req.on('error', () => failure(finished ? 'timeout' : 'http'));
      }
    }
  }
}

setTimeout(() => failure('timeout'), DEADLINE_MS + 25).unref();
