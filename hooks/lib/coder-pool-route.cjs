'use strict';

const CODERS = ['codex', 'kimi'];

function label(coder) { return coder === 'codex' ? 'Codex' : 'Kimi'; }

function knownQuota(quota) {
  return quota && quota.failed !== true && typeof quota.usedPercent === 'number' && Number.isFinite(quota.usedPercent);
}

function legacyCodexUsable(availability, fallbackEnabled) {
  if (availability.usable) return true;
  if (fallbackEnabled === false) return true;
  return fallbackEnabled === null && (availability.reason === 'not installed' || availability.reason === 'orca not installed');
}

function markerActive(marker, quota, threshold) {
  if (!marker) return false;
  if (knownQuota(quota) && typeof quota.fetchedAt === 'number' &&
      quota.fetchedAt > Number(marker.at || 0) + 60_000 && quota.usedPercent < threshold) return false;
  return true;
}

function formatCoderState(coderName, coder) {
  const name = label(String(coderName).toLowerCase());
  if (coder.state === 'unusable') return `${name} (unusable: ${coder.reason})`;
  if (coder.state === 'exhausted') return `${name} (exhausted${coder.reason ? `: ${coder.reason}` : ''})`;
  if (coder.leftPct === null) return `${name} (quota unknown, available)`;
  return `${name} (${Math.round(coder.leftPct)}% left)`;
}

function liveText(coder) {
  return coder.cap === 0 ? `${coder.live} live` : `${coder.live}/${coder.cap} live`;
}

function pickCoderPool(options = {}) {
  const availability = options.availability || {};
  const quotas = options.quotas || {};
  const thresholds = options.thresholds || {};
  const exhaustion = options.exhaustion || {};
  const live = options.live || {};
  const caps = options.caps || {};
  const coders = {};

  for (const coder of CODERS) {
    const available = availability[coder] || { usable: false, reason: 'not installed' };
    const quota = quotas[coder] || null;
    const threshold = typeof thresholds[coder] === 'number' ? thresholds[coder] : 95;
    const usable = coder === 'codex'
      ? legacyCodexUsable(available, options.fallbackEnabled)
      : available.usable === true;
    const liveCount = Number.isInteger(live[coder]) && live[coder] >= 0 ? live[coder] : 0;
    const cap = Number.isInteger(caps[coder]) && caps[coder] >= 0 ? caps[coder] : 0;
    const leftPct = knownQuota(quota) ? Math.max(0, 100 - quota.usedPercent) : null;
    let state = 'eligible';
    let reason = null;
    if (!usable) {
      state = 'unusable';
      reason = available.reason || 'unavailable';
    } else if (knownQuota(quota) && quota.usedPercent >= threshold) {
      state = 'exhausted';
      reason = `quota ${Math.round(quota.usedPercent)}% used (threshold ${threshold}%)`;
    } else if (markerActive(exhaustion[coder], quota, threshold)) {
      state = 'exhausted';
      reason = exhaustion[coder].reason || 'quota exhaustion marker active';
    }
    coders[coder] = { state, leftPct, live: liveCount, cap, reason };
  }

  const order = CODERS.filter((coder) => coders[coder].state === 'eligible');
  order.sort((a, b) => {
    const ac = coders[a]; const bc = coders[b];
    const aFree = ac.cap === 0 || ac.live < ac.cap;
    const bFree = bc.cap === 0 || bc.live < bc.cap;
    if (aFree !== bFree) return aFree ? -1 : 1;
    if (knownQuota(quotas[a]) && knownQuota(quotas[b])) {
      const ah = thresholds[a] - quotas[a].usedPercent;
      const bh = thresholds[b] - quotas[b].usedPercent;
      if (ah !== bh) return bh - ah;
    } else if (ac.live !== bc.live) {
      return ac.live - bc.live;
    }
    if (ac.live !== bc.live) return ac.live - bc.live;
    return a === 'codex' ? -1 : 1;
  });

  if (!order.length) {
    const states = CODERS.map((coder) => `${label(coder)} ${coders[coder].reason || coders[coder].state}`);
    return {
      route: 'code', order, pick: null, coders,
      summary: CODERS.map((coder) => formatCoderState(coder, coders[coder])).join(' or '),
      why: `auto: ${states.join(', ')}`,
    };
  }
  const pick = order[0];
  const summary = `${CODERS.map((coder) => {
    const state = coders[coder];
    if (state.state !== 'eligible') return formatCoderState(coder, state);
    const quotaText = state.leftPct === null ? 'quota unknown, available' : `${Math.round(state.leftPct)}% left`;
    return `${label(coder)} ${quotaText} (${liveText(state)})`;
  }).join(' or ')}; pick ${label(pick)}`;
  return { route: 'external', order, pick, coders, summary, why: `auto: pick ${label(pick)}` };
}

module.exports = { pickCoderPool, formatCoderState };
