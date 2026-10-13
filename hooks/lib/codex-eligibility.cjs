'use strict';

function knownQuota(quota) {
  return quota && quota.failed !== true && typeof quota.usedPercent === 'number' &&
    Number.isFinite(quota.usedPercent);
}

function markerActive(marker, quota, threshold) {
  if (!marker) return false;
  if (knownQuota(quota) && typeof quota.fetchedAt === 'number' &&
      quota.fetchedAt > Number(marker.at || 0) + 60_000 && quota.usedPercent < threshold) return false;
  return true;
}

function codexEligibility({ availability, quota, threshold = 95, exhaustion } = {}) {
  const available = availability || { usable: false, reason: 'not installed' };
  const leftPct = knownQuota(quota) ? Math.max(0, 100 - quota.usedPercent) : null;
  const common = {
    leftPct,
    headroom: knownQuota(quota) ? threshold - quota.usedPercent : null,
    estimated: Boolean(knownQuota(quota) && quota.estimated === true),
    quotaFetchedAt: knownQuota(quota) && typeof quota.fetchedAt === 'number' ? quota.fetchedAt : null,
  };
  if (!available.usable) {
    return { state: 'unusable', reason: available.reason || 'unavailable', ...common };
  }
  if (knownQuota(quota) && quota.usedPercent >= threshold) {
    return {
      state: 'exhausted',
      reason: `quota ${Math.round(quota.usedPercent)}% used (threshold ${threshold}%)`,
      ...common,
    };
  }
  if (markerActive(exhaustion, quota, threshold)) {
    return {
      state: 'exhausted',
      reason: exhaustion.reason || 'quota exhaustion marker active',
      ...common,
    };
  }
  return { state: 'eligible', reason: null, ...common };
}

module.exports = { knownQuota, markerActive, codexEligibility };
