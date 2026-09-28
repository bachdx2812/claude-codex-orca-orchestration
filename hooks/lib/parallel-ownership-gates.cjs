#!/usr/bin/env node
/**
 * parallel-ownership-gates.cjs — Gate A (`max-parallel-codex-workers`) and Gate B
 * (`code-brief-needs-owns` / `ownership-overlap`) for every real `orchestration
 * worker-start` / `orchestration task-create` invocation in one Bash command line.
 *
 * Extracted out of orchestrator-gate.cjs (which stays the caller and owns `deny()`/`d()`)
 * so the two newest gates live in their own file, matching the existing
 * `hooks/lib/*.cjs` module boundary (config, exec-route-by-quota, shell-orca-invocations).
 * Small helpers the gate file already has (hasFlag/flagValue, briefText, EXEC_INTENT, the
 * ORCA_BIN override, state-dir path, save()) are passed in via `deps` rather than
 * re-implemented or required back from orchestrator-gate.cjs, so there is no import cycle.
 */

'use strict';

const path = require('path');
const WG = require('./worker-groups.cjs');
const OWN = require('./ownership.cjs');
const OC = require('./ownership-claims.cjs');
const { acquireLock, releaseLock } = require('./file-lock.cjs');
const { orcaInvocations } = require('./shell-orca-invocations.cjs');

const OWNS_BRIEF_HELP =
  'A code brief in a shared worktree must declare the files it will edit, on its own line:\n' +
  '  "Owns: src/api/**, src/models/user.ts" (repo-relative, globs ok), or\n' +
  '  "Owns: n/a <reason>".\n' +
  'Or isolate it: --worktree new-child / Agent isolation:"worktree".';

/**
 * The agent a `worker-start` invocation targets: the explicit `--agent`, else — only when
 * `--terminal <h>` names a still-live tracked group — that group's own stored agent, else
 * `'codex'` (this harness's default coder, per the contract's "Codex first" rule).
 */
function resolveWorkerStartAgent(inv, s, flagValue) {
  const explicit = flagValue(inv.args, '--agent');
  if (explicit) return explicit.toLowerCase();
  const terminal = flagValue(inv.args, '--terminal');
  if (terminal) {
    const g = WG.liveGroupByTerminal(s.workers, terminal);
    if (g) return g.agent || 'codex';
  }
  return 'codex';
}

/** Distinct live Codex group ids, for naming them in the parallel-limit refusal. */
function liveCodexGroupIds(s) {
  const groups = new Set();
  for (const [key, w] of Object.entries(s.workers)) {
    if (w.status === 'live' && w.agent === 'codex') groups.add(WG.groupOf(w, key));
  }
  if (OC.countPendingCodexReservations(s) && !groups.size) groups.add('(reserved, not yet listed by orca)');
  return [...groups];
}

/**
 * Reconciles `s.workers` against Orca's own `worker-list --json`, dropping rows Orca
 * reports released or done, and dropping an id Orca never mentions at all once it is
 * older than 10 minutes (a very recent dispatch Orca simply hasn't listed yet is kept).
 * Called only when the local count is at or over the parallel-Codex cap, so a healthy
 * session under the cap never pays this round trip. Returns false when Orca could not be
 * asked at all (malformed reply or unreachable) — the caller then trusts local state.
 */
function reconcileCodexGroupsWithOrca(s, orcaBin) {
  let out;
  try {
    out = require('child_process').execFileSync(
      orcaBin, ['orchestration', 'worker-list', '--json'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024 }
    );
  } catch {
    return false;
  }
  let workers;
  try {
    const parsed = JSON.parse(out);
    const r = parsed.result ?? parsed;
    workers = Array.isArray(r) ? r : r.workers || [];
  } catch {
    return false;
  }
  const DONE = /^(succeeded|failed|stopped|cancelled|canceled)$/i;
  const liveIds = new Set();
  const releasedIds = new Set();
  for (const w of workers) {
    const ids = [w.dispatchId, w.taskId, w.agentTerminalHandle].filter(Boolean);
    const isDone = w.terminalState === 'released' || DONE.test(String(w.workerState || w.dispatchStatus || ''));
    for (const id of ids) (isDone ? releasedIds : liveIds).add(id);
  }
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  for (const [key, w] of Object.entries(s.workers)) {
    if (w.status !== 'live') continue;
    if (releasedIds.has(key)) { w.status = 'settled'; continue; }
    if (!liveIds.has(key) && (w.started || 0) < tenMinAgo) w.status = 'settled';
  }
  return true;
}

/**
 * Gates A and B for every real `orchestration worker-start` / `orchestration task-create`
 * invocation in one Bash command line. Runs its whole read-decide-reserve critical section
 * under the shared state-file lock, but always releases the lock via a normal `finally`
 * BEFORE calling `d()` — `d()` may `process.exit()`, which does not run pending `finally`
 * blocks, so the lock must already be gone by the time that can happen. A denial in the
 * middle of a multi-invocation command line stops at the first offending invocation and
 * refuses the whole tool call; nothing past that point gets reserved.
 *
 * `deps`: `{ hasFlag, flagValue, briefText, EXEC_INTENT, DIR, ORCA_BIN,
 *            maxParallelCodexWorkers, ownershipClaimTtlMinutes, save }` — all lifted
 * straight from orchestrator-gate.cjs, which still owns `d()` (the actual refusal/exit).
 */
function handleOrcaDispatchGates({ p, s, cfg, cmd, d, deps }) {
  const { hasFlag, flagValue, briefText, EXEC_INTENT, DIR, ORCA_BIN, maxParallelCodexWorkers, ownershipClaimTtlMinutes, save } = deps;

  const invs = orcaInvocations(cmd).filter((inv) =>
    (inv.sub === 'orchestration worker-start' || inv.sub === 'orchestration task-create') &&
    !hasFlag(inv.args, '--help'));
  if (!invs.length) return;

  const lockDir = path.join(DIR, '.lock');
  const repoRootDir = OWN.repoRoot(p.cwd);
  const toolUseId = p.tool_use_id || p.toolUseId || null;
  const baseId = toolUseId || `sid-${s.session_id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const cap = maxParallelCodexWorkers(cfg);
  const ttl = ownershipClaimTtlMinutes(cfg);
  let violation = null;

  // Only release the lock if THIS call actually acquired it — acquireLock() can return
  // false on timeout (degrade to allow, per the file-lock design), and unconditionally
  // rmdir-ing the lock directory then would tear down another process's still-held lock.
  const locked = acquireLock(lockDir, {});
  try {
    for (let idx = 0; idx < invs.length && !violation; idx++) {
      const inv = invs[idx];
      const isTaskCreate = inv.sub === 'orchestration task-create';
      const worktreeValue = flagValue(inv.args, '--worktree');
      const isolated = worktreeValue === 'new-child' || worktreeValue === 'new-top-level';
      const ws = OWN.workspaceKey({ repoRootDir, worktreeValue, isolated });

      // --- does this invocation need an Owns: declaration, and does it have one? ---
      let owns = null;       // resolved claim once known (empty array = explicit n/a)
      let ownsKnown = false; // an explicit Owns:/n/a was found, or inherited from a task
      let needsOwns = false; // this is code work, in a shared workspace

      if (hasFlag(inv.args, '--spec')) {
        const brief = briefText(cmd, p.cwd);
        needsOwns = !isolated && EXEC_INTENT.test(brief.text);
        const parsed = OWN.parseOwns(brief.text, { repoRoot: repoRootDir });
        if (parsed.present) { ownsKnown = true; owns = parsed.isNA ? [] : parsed.owns; }
      } else if (!isTaskCreate) {
        const taskRef = flagValue(inv.args, '--task');
        if (taskRef) {
          if (/\$/.test(taskRef)) {
            process.stdout.write(
              `orchestrator-gate advice: worker-start --task ${taskRef} looks unresolved (an unexpanded ` +
              'shell variable); ownership was not checked for it.\n');
          } else if (s.tasks[taskRef]) {
            ownsKnown = true;
            owns = s.tasks[taskRef].owns;
            needsOwns = !isolated && owns === null;
          }
        }
      }

      if (needsOwns && !ownsKnown) {
        violation = { gate: 'code-brief-needs-owns', reason: OWNS_BRIEF_HELP };
        break;
      }

      const replacesGroup =
        (WG.liveGroupByTerminal(s.workers, flagValue(inv.args, '--terminal')) || {}).group ||
        (WG.groupById(s.workers, flagValue(inv.args, '--retry-of')) || {}).group ||
        null;

      if (!isolated && owns && owns.length) {
        const claims = OC.liveClaims(s, ttl, replacesGroup);
        const conflict = OC.findOverlap(claims, ws, owns);
        if (conflict) {
          violation = { gate: 'ownership-overlap', reason:
            `Owns ${conflict.hit.b} overlaps ${conflict.hit.a} held by ${conflict.id} (since ${OC.ageString(conflict.ts)}) ` +
            `in workspace ${ws}.\nNarrow the claim, wait for or release that worker, or run it in its own worktree: ` +
            'worker-start --worktree new-child.' };
          break;
        }
      }

      // --- parallel-Codex-worker cap: worker-start only, and only a genuinely new dispatch ---
      let codexSlot = false;
      let agent = null;
      if (!isTaskCreate) {
        agent = resolveWorkerStartAgent(inv, s, flagValue);
        codexSlot = agent === 'codex' && !replacesGroup;
        if (codexSlot && cap > 0) {
          let live = WG.countLiveGroups(s.workers, 'codex') + OC.countPendingCodexReservations(s);
          if (live >= cap && reconcileCodexGroupsWithOrca(s, ORCA_BIN)) {
            live = WG.countLiveGroups(s.workers, 'codex') + OC.countPendingCodexReservations(s);
          }
          if (live >= cap) {
            violation = { gate: 'max-parallel-codex-workers', reason:
              `${live}/${cap} Codex workers already live: ${liveCodexGroupIds(s).join(', ') || '(reserved)'}.\n` +
              'Codex rate-limits under parallel load. Wait for one to finish and release it (worker-read, then\n' +
              'worker-release --dispatch <id>), or reuse a finished worker\'s terminal with --terminal <handle>. Raise the\n' +
              'limit only with maxParallelCodexWorkers / ORCH_MAX_PARALLEL_CODEX_WORKERS.' };
            break;
          }
        }
      }

      s.reservations[`${baseId}#${idx}`] = {
        ts: Date.now(), agent, owns: owns && owns.length ? owns : null, ws, codexSlot,
      };
    }
    if (!violation) save(s);
  } finally {
    if (locked) releaseLock(lockDir);
  }

  if (violation) d(violation.gate, violation.reason);
}

module.exports = {
  OWNS_BRIEF_HELP, resolveWorkerStartAgent, liveCodexGroupIds, reconcileCodexGroupsWithOrca,
  handleOrcaDispatchGates,
};
