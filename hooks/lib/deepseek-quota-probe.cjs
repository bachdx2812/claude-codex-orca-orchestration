#!/usr/bin/env node
'use strict';

/**
 * Spawned by exec-route-by-quota.cjs (the hook itself must stay synchronous). Reports
 * DeepSeek's pay-per-use state as `{ ok, spendUsd, balanceExhausted }`:
 *   - spendUsd: today's spend for the deepseek provider per `opencode stats --json`
 *     (null when unreadable -> the caller treats headroom as unknown);
 *   - balanceExhausted: optional live balance check against
 *     GET https://api.deepseek.com/user/balance — only when DEEPSEEK_API_KEY is set, and
 *     the key only ever appears in this probe's own request header, never in output.
 * Output never contains the API key.
 */

const { spawnSync } = require('child_process');
const http = require('http');
const https = require('https');

const DEADLINE_MS = 3000;
let finished = false;

function finish(value, code = 0) {
  if (finished) return;
  finished = true;
  process.stdout.write(`${JSON.stringify(value)}\n`, () => process.exit(code));
}

/** Today's deepseek-provider spend in USD from `opencode stats --json`, or null. */
function spendTodayUsd(bin) {
  if (!bin) return null;
  let probe;
  try {
    probe = spawnSync(bin, ['stats', '--json'], {
      encoding: 'utf8', timeout: DEADLINE_MS, maxBuffer: 3 * 1024 * 1024,
      env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  if (probe.error || probe.status !== 0) return null;
  let parsed;
  try { parsed = JSON.parse(String(probe.stdout || '').trim()); } catch { return null; }
  return deepseekCost(parsed);
}

const COST_KEYS = new Set(['cost', 'totalCost', 'costUsd', 'spendUsd', 'spend', 'amountUsd']);

function costOf(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  for (const key of COST_KEYS) {
    const value = Number(block[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

/** Find the deepseek provider's cost in a tolerantly-shaped stats reply. */
function deepseekCost(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const containers = [parsed.providers, parsed.byProvider, parsed.perProvider, parsed];
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    for (const [name, block] of Object.entries(container)) {
      if (/deepseek/i.test(name)) {
        const cost = costOf(block);
        if (cost !== null) return cost;
      }
    }
  }
  // Stub-friendly flat form: {"spendUsd": 1.23} or {"cost": ...} at the top level.
  return costOf(parsed);
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
const spendUsd = spendTodayUsd(bin);
balanceExhausted((exhausted) => {
  finish({ ok: true, spendUsd, balanceExhausted: exhausted });
});

setTimeout(() => finish({ ok: true, spendUsd: null, balanceExhausted: null }), DEADLINE_MS + 25).unref();
