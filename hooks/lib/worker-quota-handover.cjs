'use strict';

const fs = require('fs');
const path = require('path');

function stateFile(stateDir, session) {
  const safe = String(session || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(stateDir, `heartbeat-${safe}-quota-handover.json`);
}

function recordsFromJSON(value) {
  if (!Array.isArray(value)) return new Map();
  return new Map(value.filter((pair) => Array.isArray(pair) && pair.length === 2 &&
    typeof pair[0] === 'string' && pair[1] && typeof pair[1] === 'object'));
}

function loadRecords(stateDir, session) {
  try { return recordsFromJSON(JSON.parse(fs.readFileSync(stateFile(stateDir, session), 'utf8'))); }
  catch { return new Map(); }
}

function saveRecords(stateDir, session, records) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const file = stateFile(stateDir, session);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...records]));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function handoverStage({ usedPercent, threshold, warnMargin, exhausted = false }) {
  if (exhausted) return 'handover';
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return null;
  if (usedPercent >= threshold) return 'handover';
  return usedPercent >= Math.max(0, threshold - warnMargin) ? 'warning' : null;
}

function pickNextCoder(agent, pool) {
  const other = agent === 'kimi' ? 'codex' : agent === 'codex' ? 'kimi' : null;
  if (!other) return 'sonnet';
  if (pool?.coders?.[other]?.state === 'eligible' || pool?.order?.includes(other)) return other;
  return 'sonnet';
}

function targetLabel(target) {
  return target === 'codex' ? 'Codex' : target === 'kimi' ? 'Kimi' : 'Sonnet';
}

function handoverRecipe(agent, target, worktreePath) {
  const source = agent === 'codex' ? 'Codex' : 'Kimi';
  const destination = targetLabel(target);
  const sameTree = worktreePath ? ` at ${worktreePath}` : '';
  return 'If responsive, terminal send: "Stop now: commit all work-in-progress as `wip: handover` and write ' +
    'HANDOVER.md (done / remaining / next step / how to verify), commit it, then stop." Wait up to ~3m; ' +
    `worker-stop + worker-release without deleting the worktree/branch; dispatch the SAME brief to ${destination} ` +
    `in the SAME worktree/branch${sameTree}, prefixed "Continue a task handed over from ${source}. Read ` +
    'HANDOVER.md and `git log` first; do not redo finished steps."';
}

function formatEvent(record) {
  const used = Math.round(record.usedPercent);
  const destination = targetLabel(record.target);
  if (record.stage === 'warning') {
    return `WORKER HANDOVER WARNING ${record.identity} (${record.agent} ${used}% >= ` +
      `${record.warnAt}% warning; handover at ${record.threshold}%) -> prepare ${destination}; ` +
      'let the worker finish only a small safe step';
  }
  if (record.trigger === 'usage-limit') {
    return `WORKER HANDOVER ${record.identity} (${record.agent} usage-limit signal) -> ` +
      `hand over to ${destination}. ${handoverRecipe(record.agent, record.target, record.worktreePath)}`;
  }
  return `WORKER HANDOVER ${record.identity} (${record.agent} ${used}% >= ${record.threshold}%) -> ` +
    `hand over to ${destination}. ${handoverRecipe(record.agent, record.target, record.worktreePath)}`;
}

function observe(records, input) {
  const stage = handoverStage(input);
  if (!stage) {
    return { event: null, changed: records.delete(input.handle), record: null };
  }
  const usedPercent = input.exhausted && !(typeof input.usedPercent === 'number') ? 100 : input.usedPercent;
  // Destination availability may change while quota remains in the same episode. Update
  // the reminder target without waking the panel again until stage/threshold changes.
  const signature = `${input.agent}:${stage}:${input.threshold}`;
  const previous = records.get(input.handle);
  const record = {
    stage,
    signature,
    identity: input.identity || input.handle,
    agent: input.agent,
    usedPercent,
    threshold: input.threshold,
    warnAt: Math.max(0, input.threshold - input.warnMargin),
    target: input.target,
    trigger: input.exhausted ? 'usage-limit' : 'quota',
    aliases: [...new Set([input.handle, input.identity, ...(input.aliases || [])].filter(Boolean))],
    worktreePath: input.worktreePath || '',
    observedAt: previous?.signature === signature ? previous.observedAt : input.now,
  };
  const emit = previous?.signature !== record.signature;
  records.set(input.handle, record);
  return { event: emit ? formatEvent(record) : null, changed: emit || JSON.stringify(previous) !== JSON.stringify(record), record };
}

function reminder(stateDir, session, activeIds) {
  const persisted = loadRecords(stateDir, session);
  if (activeIds instanceof Set) {
    let changed = false;
    for (const [handle, record] of persisted) {
      const aliases = new Set([handle, record.identity, ...(record.aliases || [])].filter(Boolean));
      if (![...aliases].some((id) => activeIds.has(id))) {
        persisted.delete(handle);
        changed = true;
      }
    }
    if (changed) saveRecords(stateDir, session, persisted);
  }
  const records = [...persisted.values()];
  if (!records.length) return '';
  return 'Workers needing quota handover: ' + records.map((record) =>
    `${record.identity} (${record.agent} ${record.trigger === 'usage-limit' ? 'usage-limit signal' : `${Math.round(record.usedPercent)}%`}, ` +
    `${record.stage} -> ${targetLabel(record.target)})`
  ).join(', ') + '. Follow the heartbeat handover recipe; preserve the same worktree/branch.';
}

module.exports = {
  stateFile, recordsFromJSON, loadRecords, saveRecords, handoverStage, pickNextCoder,
  handoverRecipe, formatEvent, observe, reminder,
};
