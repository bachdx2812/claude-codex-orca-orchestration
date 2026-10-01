#!/usr/bin/env node
'use strict';

/**
 * Spawned by exec-route-by-quota.cjs (the hook itself must stay synchronous). Reports
 * DeepSeek's pay-per-use state as `{ ok, spendUsd, balanceExhausted }`:
 *   - spendUsd: today's spend for the deepseek provider, read from what opencode 1.18
 *     really exposes — first opencode's own sqlite store
 *     (`~/.local/share/opencode/opencode.db`, provider=deepseek, today), then the text of
 *     `opencode stats --days 1 --models`. There is NO `stats --json` in opencode 1.18.
 *     null when neither is readable -> the caller treats headroom as unknown;
 *   - balanceExhausted: optional live balance check against
 *     GET https://api.deepseek.com/user/balance — only when DEEPSEEK_API_KEY is set, and
 *     the key only ever appears in this probe's own request header, never in output.
 * Output never contains the API key.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const DEADLINE_MS = 3000;
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
let finished = false;

function finish(value, code = 0) {
  if (finished) return;
  finished = true;
  process.stdout.write(`${JSON.stringify(value)}\n`, () => process.exit(code));
}

/** opencode's sqlite store; ORCH_OPENCODE_DB overrides it, else XDG_DATA_HOME / ~/.local/share. */
function opencodeDbPath(env) {
  if (env.ORCH_OPENCODE_DB) return env.ORCH_OPENCODE_DB;
  const home = env.HOME || os.homedir();
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(dataHome, 'opencode', 'opencode.db');
}

function startOfDayMs(now) { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
function endOfDayMs(now) { const d = new Date(now); d.setHours(24, 0, 0, 0); return d.getTime(); }

/**
 * Today's deepseek spend in USD from opencode's sqlite store, or null when the store or
 * `sqlite3` is unavailable. Reads only the message rows' `data.cost` for provider deepseek
 * created since local midnight — no key material is involved.
 */
function spendFromDb(env, now) {
  const db = opencodeDbPath(env);
  try { if (!fs.statSync(db).isFile()) return null; } catch { return null; }
  const sql = "SELECT COALESCE(SUM(CAST(json_extract(data,'$.cost') AS REAL)),0) FROM message " +
    "WHERE json_extract(data,'$.providerID')='deepseek' " +
    `AND CAST(json_extract(data,'$.time.created') AS INTEGER)>=${startOfDayMs(now)} ` +
    `AND CAST(json_extract(data,'$.time.created') AS INTEGER)<${endOfDayMs(now)};`;
  try {
    const probe = spawnSync('sqlite3', [db, sql], {
      encoding: 'utf8', timeout: DEADLINE_MS, maxBuffer: 1024 * 1024,
      env: { PATH: env.PATH || '', HOME: env.HOME || '' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (probe.error || probe.status !== 0) return null;
    const value = Number(String(probe.stdout || '').trim());
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Sum the `Cost  $X` of every `deepseek/*` model block in `opencode stats --days 1
 * --models` text output. Returns null when no deepseek block is present.
 */
function parseStatsText(text) {
  const lines = String(text || '').replace(ANSI_ESCAPE, '').split(/\r?\n/);
  let inDeepseek = false;
  let found = false;
  let total = 0;
  for (const raw of lines) {
    const line = raw.replace(/^[\s│┃|]+/, '').replace(/[\s│┃|]+$/, '');
    if (!line) continue;
    const model = line.match(/^([\w.-]+\/[\w.-]+)\s*$/);
    if (model) {
      inDeepseek = /^deepseek\//i.test(model[1]);
      if (inDeepseek) found = true;
      continue;
    }
    const cost = line.match(/^Cost\s+\$?\s*([\d.]+)\s*$/i);
    if (cost && inDeepseek) total += Number(cost[1]);
  }
  return found ? total : null;
}

/** Today's deepseek-provider spend in USD, or null when unreadable. */
function spendTodayUsd(bin, env, now = Date.now()) {
  const fromDb = spendFromDb(env, now);
  if (fromDb !== null) return fromDb;
  if (!bin) return null;
  let probe;
  try {
    probe = spawnSync(bin, ['stats', '--days', '1', '--models'], {
      encoding: 'utf8', timeout: DEADLINE_MS, maxBuffer: 3 * 1024 * 1024,
      env: {
        PATH: env.PATH || '', HOME: env.HOME || '',
        ...(env.XDG_DATA_HOME ? { XDG_DATA_HOME: env.XDG_DATA_HOME } : {}),
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  if (probe.error || probe.status !== 0) return null;
  return parseStatsText(probe.stdout);
}

/**
 * Optional balance check (only when DEEPSEEK_API_KEY is set): true when the account is out
 * of funds (is_available false, or every balance info at zero), false when clearly funded,
 * null when the check could not run or parse. ORCH_DEEPSEEK_BALANCE_URL overrides the
 * endpoint (tests point it at a loopback stub; plain http is allowed only there).
 */
function balanceExhausted(done) {
  const key = typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.trim();
  if (!key) return done(null);
  let answered = false;
  const answer = (value) => { if (!answered) { answered = true; done(value); } };
  const requested = process.env.ORCH_DEEPSEEK_BALANCE_URL || 'https://api.deepseek.com/user/balance';
  let url;
  try { url = new URL(requested); } catch { return answer(null); }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return answer(null);
  const transport = url.protocol === 'https:' ? https : http;
  const req = transport.get(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { if (body.length <= 1024 * 1024) body += chunk; });
    response.on('end', () => {
      if (Number(response.statusCode || 0) < 200 || Number(response.statusCode || 0) >= 300) return answer(null);
      let parsed;
      try { parsed = JSON.parse(body); } catch { return answer(null); }
      if (parsed && parsed.is_available === false) return answer(true);
      const infos = Array.isArray(parsed && parsed.balance_infos) ? parsed.balance_infos : [];
      if (infos.length) {
        const total = infos.reduce((sum, info) => sum + (Number(info && info.total_balance) || 0), 0);
        return answer(total <= 0);
      }
      answer(null);
    });
  });
  req.setTimeout(DEADLINE_MS, () => { req.destroy(); answer(null); });
  req.on('error', () => answer(null));
}

const bin = process.env.ORCH_OPENCODE_BIN || 'opencode';
const spendUsd = spendTodayUsd(bin, process.env);
balanceExhausted((exhausted) => {
  finish({ ok: true, spendUsd, balanceExhausted: exhausted });
});

setTimeout(() => finish({ ok: true, spendUsd: null, balanceExhausted: null }), DEADLINE_MS + 25).unref();
