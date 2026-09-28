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

/** Distinct live Codex group ids, for naming them in the parallel-limit refusal. A
 * cap-exempt group (done per Orca, still holding its terminal) is named with a suffix so
 * the operator knows RELEASING it — not waiting on it — is what frees a slot; it is never
 * counted toward the cap number itself (see countLiveGroups). */
function liveCodexGroupIds(s) {
  const groups = new Map(); // group -> capExempt
  for (const [key, w] of Object.entries(s.workers)) {
    if (w.status === 'live' && w.agent === 'codex') {
      const g = WG.groupOf(w, key);
      if (!groups.has(g) || w.capExempt) groups.set(g, !!w.capExempt);
    }
  }
  const names = [...groups.entries()].map(([g, exempt]) => (exempt ? `${g} (done, release it)` : g));
  if (OC.countPendingCodexReservations(s) && !names.length) names.push('(reserved, not yet listed by orca)');
  return names;
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
  const DONE = /^(succeeded|failed|stopped|cancelled|canceled|completed)$/i;
  const liveIds = new Set();
  const releasedIds = new Set();
  const doneButHeldIds = new Set();
  for (const w of workers) {
    const ids = [w.dispatchId, w.taskId, w.agentTerminalHandle].filter(Boolean);
    const isDone = DONE.test(String(w.workerState || w.dispatchStatus || ''));
    if (w.terminalState === 'released') {
      // Fully released: free its slot AND drop it from tracking (below).
      for (const id of ids) releasedIds.add(id);
    } else if (isDone) {
      // Done, but still holding its terminal: a resource leak the Stop gate
      // (workers-unreconciled) must still catch. Cap-exempt (it is not doing work
      // anymore, so it must not block a new dispatch) but NOT settled/untracked — settling
      // it here would make it invisible to that later check and it would never get
      // released.
      for (const id of ids) doneButHeldIds.add(id);
    } else {
      for (const id of ids) liveIds.add(id);
    }
  }
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  for (const [key, w] of Object.entries(s.workers)) {
    if (w.status !== 'live') continue;
    if (releasedIds.has(key)) { w.status = 'settled'; continue; }
    if (doneButHeldIds.has(key)) { w.capExempt = true; continue; }
    if (!liveIds.has(key) && !doneButHeldIds.has(key) && (w.started || 0) < tenMinAgo) w.status = 'settled';
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
/**
 * This invocation's OWN spec text, scoped as tightly as the shell scanner allows — never
 * the whole command's `briefText()` blob. `flagValue()` already returns exactly the word
 * that followed THIS invocation's own `--spec` (quotes stripped, other invocations'
 * argv never mixed in); an `@path` value is resolved by reading exactly that one file. Only
 * when the value is empty (the shell scanner cannot capture a `$(cat f)`/`$(< f)`
 * substitution's replaced text into a word — see shell-orca-invocations.cjs) does this fall
 * back to the whole-command `briefText()`, same as the pre-fix behavior, so that pattern is
 * still degraded-but-checked rather than silently skipped.
 */
function resolveSpecText(inv, cmd, cwd, deps) {
  // A `--spec` argument containing a `$( )`/backtick command substitution has its
  // substituted content silently dropped by the shell scanner (see
  // shell-orca-invocations.cjs — it recurses into the substitution to find nested orca
  // invocations, but never re-emits its text into the enclosing word), so `flagValue` alone
  // would see only a truncated fragment and could miss content entirely (e.g. an unreadable
  // file reference). Whenever the whole command contains ANY such substitution, degrade
  // to the pre-fix, whole-command `briefText()` scoping rather than risk silently
  // dropping part of a brief — this only costs precision for the (rarer) case of multiple
  // invocations that ALSO use command substitution in their specs; a plain multi-invocation
  // command with inline text or `@file` specs (the common case) still gets full per-
  // invocation scoping via the fast path below.
  if (/\$\(|`/.test(cmd)) return deps.briefText(cmd, cwd);
  const raw = deps.flagValue(inv.args, '--spec');
  if (raw && raw.length) {
    if (raw.startsWith('@')) {
      const rel = raw.slice(1);
      try {
        const expanded = rel.replace(/^~(?=\/)/, require('os').homedir());
        const abs = path.resolve(cwd || process.cwd(), expanded);
        return { text: require('fs').readFileSync(abs, 'utf8'), unreadable: [] };
      } catch {
        return { text: '', unreadable: [rel] };
      }
    }
    return { text: raw, unreadable: [] };
  }
  return deps.briefText(cmd, cwd);
}

function handleOrcaDispatchGates({ p, s, cfg, cmd, d, deps }) {
  const {
    hasFlag, flagValue, briefText, EXEC_INTENT, DIR, ORCA_BIN,
    maxParallelCodexWorkers, ownershipClaimTtlMinutes, save, load, gateDisabled,
  } = deps;

  const invs = orcaInvocations(cmd).filter((inv) =>
    (inv.sub === 'orchestration worker-start' || inv.sub === 'orchestration task-create') &&
    !hasFlag(inv.args, '--help'));
  if (!invs.length) return;

  const lockDir = path.join(DIR, '.lock');
  const repoRootDir = OWN.repoRoot(p.cwd);
  const sessionId = s.session_id;
  const toolUseId = p.tool_use_id || p.toolUseId || null;
  const baseId = toolUseId || `sid-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const cap = maxParallelCodexWorkers(cfg);
  const ttl = ownershipClaimTtlMinutes(cfg);
  let violation = null;
  // Reservations made by earlier invocations IN THIS SAME command line, kept locally so a
  // mid-loop reconcile reload (item 10) never loses them, and so a later invocation in the
  // same command (e.g. `task-create ... && worker-start --task "$ID"`) can resolve an
  // unexpanded `$ID` against the one task-create this command itself just created (item 8).
  const localReservations = {};
  const taskCreatesInThisCommand = []; // { owns } per task-create invocation seen so far

  // Only release the lock if THIS call actually acquired it — acquireLock() can return
  // false on timeout (degrade to allow, per the file-lock design), and unconditionally
  // rmdir-ing the lock directory then would tear down another process's still-held lock.
  let locked = acquireLock(lockDir, {});
  try {
    // CRITICAL: reload state fresh from disk now that the lock is held. `s` as passed in
    // was loaded by main() *before* this lock was acquired, so under concurrent hook
    // processes it is stale — a second process racing the first would otherwise compute
    // its cap/overlap check against a snapshot that doesn't see the first process's
    // still-uncommitted-to-disk reservation, and its own save() would then clobber the
    // first process's save entirely, losing that reservation (not merely "double-admit":
    // an outright dropped write). Every read and mutation below must go through this
    // freshly-loaded copy, never the stale `s` parameter.
    s = load(sessionId);
    for (let idx = 0; idx < invs.length && !violation; idx++) {
      const inv = invs[idx];
      const isTaskCreate = inv.sub === 'orchestration task-create';
      const worktreeValue = flagValue(inv.args, '--worktree');
      // `--worktree active`/`--worktree current` are explicit spellings of "the current,
      // shared workspace" — they must normalize onto the same key as the flag being absent,
      // not become their own distinct (never-conflicting) workspace.
      const normalizedWorktree = (worktreeValue === 'active' || worktreeValue === 'current') ? null : worktreeValue;
      const isolated = normalizedWorktree === 'new-child' || normalizedWorktree === 'new-top-level';
      const ws = OWN.workspaceKey({ repoRootDir, worktreeValue: normalizedWorktree, isolated });

      // --- does this invocation need an Owns: declaration, and does it have one? ---
      let owns = null;       // resolved claim once known (empty array = explicit n/a)
      let ownsKnown = false; // an explicit Owns:/n/a was found, or inherited from a task
      let needsOwns = false; // this is code work, in a shared workspace

      if (hasFlag(inv.args, '--spec')) {
        // Ownership is enforced where the workspace is actually known: worker-start. A
        // task-create does not yet know whether its eventual worker-start will be isolated,
        // so it records whatever Owns:/n/a is present without REQUIRING one.
        const brief = resolveSpecText(inv, cmd, p.cwd, deps);
        needsOwns = !isolated && !isTaskCreate && EXEC_INTENT.test(brief.text);
        const parsed = OWN.parseOwns(brief.text, { repoRoot: repoRootDir });
        if (parsed.present) { ownsKnown = true; owns = parsed.isNA ? [] : parsed.owns; }
        if (isTaskCreate) taskCreatesInThisCommand.push({ owns: ownsKnown ? owns : null });
      } else if (!isTaskCreate) {
        const taskRef = flagValue(inv.args, '--task');
        if (taskRef) {
          if (/\$/.test(taskRef)) {
            // An unresolved shell variable usually can't be matched to a task — UNLESS this
            // very command line contains exactly one task-create, in which case it is the
            // only thing `$ID` could plausibly refer to.
            if (taskCreatesInThisCommand.length === 1) {
              owns = taskCreatesInThisCommand[0].owns;
              ownsKnown = owns !== null;
              needsOwns = !isolated && owns === null;
            } else {
              process.stdout.write(
                `orchestrator-gate advice: worker-start --task ${taskRef} looks unresolved (an unexpanded ` +
                'shell variable); ownership was not checked for it.\n');
            }
          } else if (s.tasks[taskRef]) {
            owns = s.tasks[taskRef].owns;
            // `owns === null` means the task-create that produced this task never recorded
            // a claim at all (no Owns:/n/a line, deferred per item 9) — that is NOT the
            // same as "known to claim nothing" (n/a, recorded as `[]`), so ownsKnown must
            // stay false here and let needsOwns actually refuse a non-isolated worker-start.
            ownsKnown = owns !== null;
            needsOwns = !isolated && owns === null;
          }
        }
      }

      if (needsOwns && !ownsKnown) {
        if (gateDisabled(cfg, 'code-brief-needs-owns')) {
          // Disabled: this specific check passes, but the rest of this invocation's gates
          // (ownership-overlap, the parallel-Codex cap) and its reservation must still run —
          // a disabled gate must never silently skip the cap accounting for the dispatch it
          // would otherwise have refused.
          owns = null; ownsKnown = true;
        } else {
          violation = { gate: 'code-brief-needs-owns', reason: OWNS_BRIEF_HELP };
          break;
        }
      }

      const replacesGroup =
        (WG.liveGroupByTerminal(s.workers, flagValue(inv.args, '--terminal')) || {}).group ||
        // `--retry-of` only replaces a group that is still LIVE (groupById matches any
        // status); a group that has already settled freed its slot when it settled, so
        // retrying it is a brand-new dispatch, not a same-slot replacement (item 8).
        (() => {
          const g = WG.groupById(s.workers, flagValue(inv.args, '--retry-of'));
          if (!g) return null;
          const entry = s.workers[flagValue(inv.args, '--retry-of')];
          return entry && entry.status === 'live' ? g.group : null;
        })() ||
        null;

      if (!isolated && owns && owns.length) {
        const claims = OC.liveClaims(s, ttl, replacesGroup);
        const conflict = OC.findOverlap(claims, ws, owns);
        if (conflict) {
          if (gateDisabled(cfg, 'ownership-overlap')) {
            // fall through: disabled, still reserve and still run the cap check below
          } else {
            violation = { gate: 'ownership-overlap', reason:
              `Owns ${conflict.hit.b} overlaps ${conflict.hit.a} held by ${conflict.id} (since ${OC.ageString(conflict.ts)}) ` +
              `in workspace ${ws}.\nNarrow the claim, wait for or release that worker, or run it in its own worktree: ` +
              'worker-start --worktree new-child.' };
            break;
          }
        }
      }

      // --- parallel-Codex-worker cap: worker-start only, and only a genuinely new dispatch ---
      let codexSlot = false;
      let agent = null;
      if (!isTaskCreate) {
        agent = resolveWorkerStartAgent(inv, s, flagValue);
        codexSlot = agent === 'codex' && !replacesGroup;
        if (codexSlot && cap > 0 && !gateDisabled(cfg, 'max-parallel-codex-workers')) {
          let live = WG.countLiveGroups(s.workers, 'codex') + OC.countPendingCodexReservations(s);
          if (live >= cap) {
            // Run the (up to 5s) Orca reconcile OUTSIDE the lock, so an at-cap check on one
            // session never blocks every other concurrent hook process for that long (item
            // 10). Reservations this same command already made (localReservations) are
            // re-applied onto the freshly reloaded state so they are never lost by the
            // reload, then the count is rechecked under the lock before proceeding.
            if (locked) { releaseLock(lockDir); locked = false; }
            const reconciled = load(sessionId);
            const changed = reconcileCodexGroupsWithOrca(reconciled, ORCA_BIN);
            if (changed) save(reconciled);
            locked = acquireLock(lockDir, {});
            s = load(sessionId);
            Object.assign(s.reservations, localReservations);
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

      const reservation = {
        ts: Date.now(), agent, owns: owns && owns.length ? owns : null, ws, codexSlot,
      };
      localReservations[`${baseId}#${idx}`] = reservation;
      s.reservations[`${baseId}#${idx}`] = reservation;
    }
    if (!violation) save(s);
  } finally {
    if (locked) releaseLock(lockDir);
  }

  if (violation) d(violation.gate, violation.reason);
}

module.exports = {
  OWNS_BRIEF_HELP, resolveWorkerStartAgent, liveCodexGroupIds, reconcileCodexGroupsWithOrca,
  handleOrcaDispatchGates, resolveSpecText,
};
