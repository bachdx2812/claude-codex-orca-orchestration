'use strict';

/**
 * coder-pool-route.cjs — ranks the external coders (Codex, Kimi) and picks who takes
 * the next code dispatch.
 *
 * Config -> option mapping (`execFallbackWhenCodexUnavailable` -> `options.fallbackEnabled`):
 *   - config `null` => `fallbackEnabled: null`: Codex-only legacy behaviour per RT-4 —
 *     a Codex that is merely not installed (or Orca not installed) still routes to Codex,
 *     exactly like the pre-pool routing did.
 *   - config set (e.g. `"sonnet"`, the default) => `fallbackEnabled: true`: an unusable
 *     coder is excluded from the pool. An unusable Kimi is ALWAYS excluded, regardless
 *     of this option.
 *   - nothing usable => `route: 'code'`: the in-session code model (default alias sonnet).
 *
 * Ranking among eligible coders (binding operator decision, 2026-10-01 — MORE QUOTA LEFT
 * first, superseding the older "fewer live workers first" order):
 * free per-session concurrency slot (a ranking key, not a filter) -> MORE HEADROOM below
 * each coder's OWN resolved threshold -> within a tie band (`options.tieBand`, default 10
 * headroom points) fewer live workers machine-wide -> the coder other than
 * `options.lastCoder` -> Codex first. A coder whose quota is UNKNOWN ranks as if its
 * headroom were `options.unknownAssumed` (default 30) points: below any coder with known
 * headroom >= that value, above one with less. Headroom is known as often as possible —
 * quota readings may carry `estimated: true` (a reset-aware estimate of the last
 * successful live read, see exec-route-by-quota.cjs) and then count as known, surfaced
 * via `coders[coder].estimated` / `quotaFetchedAt` for the reminder text.
 *
 * `options.live` is MACHINE-wide live counts (the load-balancing ordering key);
 * `options.sessionLive` is THIS session's live counts, the basis of the free-slot key:
 * the caps in `options.caps` are per-session (maxParallel*Workers), so a slot is free
 * when this session's own count is below its own cap, regardless of what other
 * sessions are running. `sessionLive` defaults to `live` when omitted.
 */

const CODERS = ['codex', 'kimi'];

function label(coder) { return coder === 'codex' ? 'Codex' : 'Kimi'; }

function knownQuota(quota) {
  return quota && quota.failed !== true && typeof quota.usedPercent === 'number' && Number.isFinite(quota.usedPercent);
}

function legacyCodexUsable(availability, fallbackEnabled) {
  if (availability.usable) return true;
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
  return coder.cap === 0 ? `${coder.sessionLive} live` : `${coder.sessionLive}/${coder.cap} live`;
}

function pickCoderPool(options = {}) {
  const availability = options.availability || {};
  const quotas = options.quotas || {};
  const thresholds = options.thresholds || {};
  const exhaustion = options.exhaustion || {};
  const live = options.live || {};
  const sessionLive = options.sessionLive || live;
  const caps = options.caps || {};
  const lastCoder = CODERS.includes(options.lastCoder) ? options.lastCoder : null;
  const tieBand = Number.isInteger(options.tieBand) && options.tieBand >= 0 ? options.tieBand : 10;
  const unknownAssumed = Number.isInteger(options.unknownAssumed) &&
    options.unknownAssumed >= 0 && options.unknownAssumed <= 100 ? options.unknownAssumed : 30;
  const coders = {};
  const thresholdFor = (coder) => typeof thresholds[coder] === 'number' ? thresholds[coder] : 95;
  const headroomFor = (coder) => knownQuota(quotas[coder]) ? thresholdFor(coder) - quotas[coder].usedPercent : null;
  // The ranking headroom: known when a (possibly estimated) reading exists, the configured
  // assumed value when unknown — unknown ranks below known >= assumed and above known < assumed.
  const rankHeadroomFor = (coder) => {
    const h = headroomFor(coder);
    return h === null ? unknownAssumed : h;
  };

  for (const coder of CODERS) {
    const available = availability[coder] || { usable: false, reason: 'not installed' };
    const quota = quotas[coder] || null;
    const threshold = thresholdFor(coder);
    const usable = coder === 'codex'
      ? legacyCodexUsable(available, options.fallbackEnabled)
      : available.usable === true;
    const liveCount = Number.isInteger(live[coder]) && live[coder] >= 0 ? live[coder] : 0;
    const sessionLiveCount = Number.isInteger(sessionLive[coder]) && sessionLive[coder] >= 0 ? sessionLive[coder] : 0;
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
    coders[coder] = { state, leftPct, headroom: headroomFor(coder), live: liveCount, sessionLive: sessionLiveCount, cap, reason,
      estimated: knownQuota(quota) && quota.estimated === true,
      quotaFetchedAt: knownQuota(quota) && typeof quota.fetchedAt === 'number' ? quota.fetchedAt : null };
  }

  const order = CODERS.filter((coder) => coders[coder].state === 'eligible');
  const freeSlot = (coder) => coders[coder].cap === 0 || coders[coder].sessionLive < coders[coder].cap;
  order.sort((a, b) => {
    const aFree = freeSlot(a); const bFree = freeSlot(b);
    if (aFree !== bFree) return aFree ? -1 : 1;
    const ah = rankHeadroomFor(a); const bh = rankHeadroomFor(b);
    if (Math.abs(ah - bh) > tieBand) return bh - ah;
    if (coders[a].live !== coders[b].live) return coders[a].live - coders[b].live;
    if (lastCoder === a) return 1;
    if (lastCoder === b) return -1;
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
  let pickReason = 'only eligible coder';
  if (!freeSlot(pick)) {
    pickReason = 'all at cap, wait';
  } else if (order.length > 1) {
    const other = order[1];
    const pickH = rankHeadroomFor(pick); const otherH = rankHeadroomFor(other);
    if (freeSlot(pick) !== freeSlot(other)) pickReason = 'free capacity';
    else if (Math.abs(pickH - otherH) > tieBand) {
      pickReason = `more quota left: ${Math.round(pickH)} vs ${Math.round(otherH)}`;
    } else if (coders[pick].live !== coders[other].live) pickReason = 'fewer live';
    else if (lastCoder === other) pickReason = 'alternation';
    else pickReason = 'codex first';
  }
  const summary = `${CODERS.map((coder) => {
    const state = coders[coder];
    if (state.state !== 'eligible') return formatCoderState(coder, state);
    const quotaText = state.leftPct === null ? 'quota unknown, available'
      : state.estimated ? `~${Math.round(100 - state.leftPct)}% used (est.)`
        : `${Math.round(state.leftPct)}% left`;
    return `${label(coder)} ${quotaText} (${liveText(state)})`;
  }).join(' or ')}; pick ${label(pick)}`;
  return { route: 'external', order, pick, coders, summary, why: `auto: spread, pick ${label(pick)} (${pickReason})` };
}

module.exports = { pickCoderPool, formatCoderState };
