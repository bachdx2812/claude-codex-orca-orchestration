#!/usr/bin/env node
/**
 * parallel-ownership-gates.cjs — the per-coder parallel caps (`max-parallel-codex-workers`,
 * `max-parallel-kimi-workers`) and Gate B
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
const { createHash } = require('crypto');
const WG = require('./worker-groups.cjs');
const OWN = require('./ownership.cjs');
const OC = require('./ownership-claims.cjs');
const { acquireLock, releaseLock } = require('./file-lock.cjs');
const { orcaInvocations } = require('./shell-orca-invocations.cjs');

const OWNS_BRIEF_HELP =
  'A code brief in a shared worktree must declare the files it will edit, on its own line:\n' +
  '  "Owns: src/api/**, src/models/user.ts" (repo-relative, globs ok), or\n' +
  '  "Owns: n/a <reason>".\n' +
  '(The line must START with Owns: — optionally after "-"/"*" — case-insensitively; a ' +
  'markdown-bold "**Owns:**" or an "Owns:" appearing mid-sentence is not read.)\n' +
  'Or isolate it: --worktree new-child / Agent isolation:"worktree".';

// A same-command reservation younger than this may belong to a genuinely parallel,
// byte-for-byte identical tool call. Only an older unresolved reservation is evidence of
// the later-hook-denial retry case this replacement path exists to recover from.
const SAME_COMMAND_RETRY_AGE_MS = 2000;

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

/** Distinct live group ids for `agent`, for naming them in the parallel-limit refusal. A
 * cap-exempt group (done per Orca, still holding its terminal) is named with a suffix so
 * the operator knows RELEASING it — not waiting on it — is what frees capacity; it is never
 * counted toward the cap number itself (see countLiveGroups). Every still-unresolved
 * reservation (a dispatch admitted at PreToolUse whose PostToolUse hasn't yet turned it into
 * a real registered worker or dropped it) is named individually, not folded into one generic
 * placeholder, so the operator can see exactly which reservation is holding capacity and when
 * it will self-expire if nothing ever resolves it. A legacy reservation that predates the
 * generalised `agent`/`newSlot` fields still counts for 'codex' via its `codexSlot`. */
function liveGroupIds(s, agent) {
  const groups = new Map(); // group -> capExempt
  for (const [key, w] of Object.entries(s.workers)) {
    if (w.status === 'live' && w.agent === agent) {
      const g = WG.groupOf(w, key);
      if (!groups.has(g) || w.capExempt) groups.set(g, !!w.capExempt);
    }
  }
  const names = [...groups.entries()].map(([g, exempt]) => (exempt ? `${g} (done, release it)` : g));
  for (const [id, r] of Object.entries(s.reservations || {})) {
    if (!r || OC.reservationExpired(r)) continue;
    const holdsSlot = (r.newSlot && r.agent === agent) || (agent === 'codex' && r.codexSlot);
    if (!holdsSlot) continue;
    const remainingMinutes = Math.max(0, Math.round((OC.RESERVATION_TTL_MS - (Date.now() - r.ts)) / 60000));
    names.push(`pending reservation ${id} (expires in ${remainingMinutes}m)`);
  }
  return names;
}

function liveCodexGroupIds(s) {
  return liveGroupIds(s, 'codex');
}

/**
 * Pure fetch: exec `orca orchestration worker-list --json` and return its parsed worker
 * rows, or null on any failure (unreachable, malformed reply). Does NO read or write of
 * session state, so it is safe to call with the file lock NOT held — this is the (up to 5s)
 * part of reconciliation that must never block every other concurrent hook process, and,
 * just as important, must never let its own before/after state snapshot race a concurrent
 * process's lock-protected write (see `handleOrcaDispatchGates`'s at-cap branch, which calls
 * this unlocked and only ever applies the result after re-acquiring the lock and reloading
 * fresh state — item 1 of the second review round).
 */
function fetchOrcaWorkerRows(orcaBin) {
  let out;
  try {
    out = require('child_process').execFileSync(
      orcaBin, ['orchestration', 'worker-list', '--json'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024 }
    );
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(out);
    const r = parsed.result ?? parsed;
    return Array.isArray(r) ? r : r.workers || [];
  } catch {
    return null;
  }
}

const DONE = /^(succeeded|failed|stopped|cancelled|canceled|completed)$/i;

/**
 * Pure apply: mutates `s.workers` in place against already-fetched Orca rows — dropping rows
 * Orca reports released, marking a done-but-still-terminal-held row cap-exempt (see below),
 * and dropping an id Orca never mentions at all once it is older than 10 minutes (a very
 * recent dispatch Orca simply hasn't listed yet is kept). Must only be called while the lock
 * IS held, and only against a state object freshly reloaded from disk — never a stale
 * snapshot taken before the (unlocked) fetch — so this mutation can never silently overwrite
 * a concurrent process's write made during the fetch's own round trip. Returns true when
 * anything changed.
 */
function applyOrcaReconciliation(s, rows) {
  const liveIds = new Set();
  const releasedIds = new Set();
  const doneButHeldIds = new Set();
  for (const w of rows || []) {
    const ids = [w.dispatchId, w.taskId, w.agentTerminalHandle].filter(Boolean);
    // Independent field checks (item 8): `workerState` being present but non-matching (e.g.
    // "running") must never short-circuit away from also checking `dispatchStatus` — a
    // worker can be reported done through either field alone.
    const isDone = DONE.test(String(w.workerState || '')) || DONE.test(String(w.dispatchStatus || ''));
    if (w.terminalState === 'released') {
      // Fully released: free its capacity AND drop it from tracking (below).
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
  let changed = false;
  for (const [key, w] of Object.entries(s.workers)) {
    if (w.status !== 'live') continue;
    // A "pending-<ts>" key is a placeholder registered when a worker-start's own reply
    // carried no id at all (see orchestrator-gate.cjs) — Orca was NEVER given this key as an
    // id, so it can never appear in `rows` under any status. Its only correct resolution is
    // a later worker-list/worker-read poll adopting a real id for it; the 10-minute
    // "Orca never mentioned it" rule below must not apply to it; a still-genuinely-running
    // worker would otherwise be settled out from under itself just because this particular
    // reconcile pass, by construction, could never have found it.
    if (key.startsWith('pending-')) continue;
    if (releasedIds.has(key)) { w.status = 'settled'; changed = true; continue; }
    if (doneButHeldIds.has(key)) { if (!w.capExempt) { w.capExempt = true; changed = true; } continue; }
    if (!liveIds.has(key) && (w.started || 0) < tenMinAgo) { w.status = 'settled'; changed = true; }
  }
  return changed;
}

/**
 * Convenience wrapper composing fetch+apply against the SAME state object, for callers (and
 * existing tests) that don't need the unlocked-fetch/locked-apply split `handleOrcaDispatchGates`
 * performs itself. Returns false when Orca could not be asked at all — the caller then trusts
 * local state, exactly as before.
 */
function reconcileCodexGroupsWithOrca(s, orcaBin) {
  const rows = fetchOrcaWorkerRows(orcaBin);
  if (rows === null) return false;
  applyOrcaReconciliation(s, rows);
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
 *            maxParallelCodexWorkers, ownershipClaimTtlMinutes, capLockOpts, save }` —
 * all lifted
 * straight from orchestrator-gate.cjs, which still owns `d()` (the actual refusal/exit).
 * `maxParallelKimiWorkers` may also be passed; when absent it falls back to config.cjs's
 * own accessor so the Kimi cap still works before the gate wires the dep through.
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
  // deps also carries (and this function reads directly, so not destructured above):
  // agentParallelLimit, maxParallelAgents, machineWideLiveUnits, formatParallelAgentsRefusal,
  // cores, parallelCoreFraction — the max-parallel-agents machine-wide budget's own helpers.

  const invs = orcaInvocations(cmd).filter((inv) =>
    (inv.sub === 'orchestration worker-start' || inv.sub === 'orchestration task-create') &&
    !hasFlag(inv.args, '--help'));
  if (!invs.length) return;

  const lockDir = path.join(DIR, '.lock');
  const repoRootDir = OWN.repoRoot(p.cwd);
  const sessionId = s.session_id;
  const toolUseId = p.tool_use_id || p.toolUseId || null;
  const baseId = toolUseId || `sid-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const commandHash = createHash('sha256').update(cmd).digest('hex');
  const cap = maxParallelCodexWorkers(cfg);
  // Lane B may not pass this dep yet (config.cjs is the single source of truth for it).
  const maxKimiWorkers = deps.maxParallelKimiWorkers || require('./config.cjs').maxParallelKimiWorkers;
  const kimiCap = maxKimiWorkers(cfg);
  const ttl = ownershipClaimTtlMinutes(cfg);
  const agentCapActive = !gateDisabled(cfg, 'max-parallel-agents') &&
    Number.isFinite(deps.agentParallelLimit(cfg));
  const codexCapActive = cap > 0 && !gateDisabled(cfg, 'max-parallel-codex-workers');
  const kimiCapActive = kimiCap > 0 && !gateDisabled(cfg, 'max-parallel-kimi-workers') &&
    // The Kimi cap only justifies the long cap lock timeout when this command actually
    // contains a Kimi dispatch — otherwise every Codex/Claude worker-start would pay the
    // ~10.5s stale-lock wait for a cap that can never apply to it.
    invs.some((inv) => inv.sub === 'orchestration worker-start' &&
      (flagValue(inv.args, '--agent') || '').toLowerCase() === 'kimi');
  const hardCapActive = agentCapActive || codexCapActive || kimiCapActive;
  let violation = null;
  // True once a mid-loop Orca reconcile (`applyOrcaReconciliation`) has actually changed
  // something real — a worker Orca confirmed released, or marked cap-exempt. That change
  // must be persisted even when THIS command's own dispatch attempt ends up refused (third
  // review round, item 3): it reflects reality independently of this command's outcome, and
  // discarding it just means the very next hook invocation pays for the same 5s reconcile
  // all over again for no reason.
  let reconcileChanged = false;
  // Reservations made by earlier invocations IN THIS SAME command line, kept locally so a
  // mid-loop reconcile reload (item 10) never loses them, and so a later invocation in the
  // same command (e.g. `task-create ... && worker-start --task "$ID"`) can resolve an
  // unexpanded `$ID` against the one task-create this command itself just created (item 8).
  const localReservations = {};
  const taskCreatesInThisCommand = []; // { owns, resKey } per task-create invocation seen so far

  // Only release the lock if THIS call actually acquired it — acquireLock() can return
  // false on timeout (degrade to allow, per the file-lock design), and unconditionally
  // rmdir-ing the lock directory then would tear down another process's still-held lock.
  // Ownership bookkeeping is best-effort under contention, so it keeps file-lock's short
  // default. Only an enabled, finite resource cap needs the long timeout that can outlive a
  // stale lock. This keeps an unlimited worker-start from waiting ~10.5s for no cap at all.
  let locked = acquireLock(lockDir, hardCapActive ? deps.capLockOpts : {});
  if (locked === null) return;
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
    // Another PreToolUse hook can deny the Bash call after this gate admitted it. Claude
    // Code then emits no PostToolUse event for this gate, leaving its reservation pending.
    // A later exact retry in the same session is the same attempted dispatch, not a
    // competing owner: replace its unresolved reservation before overlap/cap accounting.
    const freshSameCommandReservations = new Set();
    for (const [key, reservation] of Object.entries(s.reservations || {})) {
      if (!reservation || reservation.commandHash !== commandHash) continue;
      if (!Number.isFinite(reservation.ts) || Date.now() - reservation.ts >= SAME_COMMAND_RETRY_AGE_MS) {
        delete s.reservations[key];
      } else {
        freshSameCommandReservations.add(key);
      }
    }
    // A finite cap cannot be evaluated safely after its one long acquisition attempt failed.
    // Refuse now instead of entering the at-cap reconcile branch and paying the same long
    // timeout a second time against the same live holder.
    if (locked === false && hardCapActive) {
      violation = {
        gate: agentCapActive ? 'max-parallel-agents'
          : (codexCapActive ? 'max-parallel-codex-workers' : 'max-parallel-kimi-workers'),
        reason: deps.lockContentionMessage,
      };
    }
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
      // Set only when this invocation inherited its claim from a task-create EARLIER IN
      // THIS SAME command line (the `$ID` resolution below): that task-create's own
      // reservation is a still-live claim over the identical files, but it is this
      // worker-start's own predecessor, not a genuine second claimant — excluded from the
      // overlap check the same way a --retry-of/--terminal replacement is (item 8).
      let sourceTaskResKey = null;

      if (hasFlag(inv.args, '--spec')) {
        // Ownership is enforced where the workspace is actually known: worker-start. A
        // task-create does not yet know whether its eventual worker-start will be isolated,
        // so it records whatever Owns:/n/a is present without REQUIRING one.
        const brief = resolveSpecText(inv, cmd, p.cwd, deps);
        needsOwns = !isolated && !isTaskCreate && EXEC_INTENT.test(brief.text);
        const parsed = OWN.parseOwns(brief.text, { repoRoot: repoRootDir });
        if (parsed.present) { ownsKnown = true; owns = parsed.isNA ? [] : parsed.owns; }
        if (isTaskCreate) taskCreatesInThisCommand.push({ owns: ownsKnown ? owns : null, resKey: `${baseId}#${idx}` });
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
              sourceTaskResKey = taskCreatesInThisCommand[0].resKey;
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
        // status); a group that has already settled freed its capacity when it settled, so
        // retrying it is a brand-new dispatch, not a same-opening replacement (item 8).
        (() => {
          const g = WG.groupById(s.workers, flagValue(inv.args, '--retry-of'));
          if (!g) return null;
          const entry = s.workers[flagValue(inv.args, '--retry-of')];
          return entry && entry.status === 'live' ? g.group : null;
        })() ||
        null;

      if (!isolated && owns && owns.length) {
        const claims = OC.liveClaims(s, ttl, replacesGroup).filter((c) => c.id !== sourceTaskResKey);
        const conflict = OC.findOverlap(claims, ws, owns);
        if (conflict) {
          if (gateDisabled(cfg, 'ownership-overlap')) {
            // fall through: disabled, still reserve and still run the cap check below
          } else {
            const retryGuidance = freshSameCommandReservations.has(conflict.id)
              ? ' This is the same command as a fresh unresolved reservation; retry in a few seconds.'
              : '';
            violation = { gate: 'ownership-overlap', reason:
              `Owns ${conflict.hit.b} overlaps ${conflict.hit.a} held by ${conflict.id} (since ${OC.ageString(conflict.ts)}) ` +
              `in workspace ${ws}.\nNarrow the claim, wait for or release that worker, or run it in its own worktree: ` +
              `worker-start --worktree new-child.${retryGuidance}` };
            break;
          }
        }
      }

      // --- parallel-coder-worker caps: worker-start only, and only a genuinely new dispatch ---
      let codexSlot = false;
      let kimiSlot = false;
      let agent = null;
      // `newSlot`: this worker-start invocation is neither a task-create (never launches a
      // terminal by itself) nor a replacement of an already-tracked live group
      // (`--terminal <h>` / `--retry-of <id>`) — i.e. it is really about to consume one more
      // unit of the MACHINE-wide max-parallel-agents budget, whatever agent it targets.
      // `codexSlot`/`kimiSlot` are this same condition narrowed to the per-coder caps.
      const newSlot = !isTaskCreate && !replacesGroup;
      if (!isTaskCreate) {
        agent = resolveWorkerStartAgent(inv, s, flagValue);
        codexSlot = newSlot && agent === 'codex';
        kimiSlot = newSlot && agent === 'kimi';

        // Machine-wide max-parallel-agents budget: checked for EVERY agent's worker-start,
        // on top of (never instead of) the Codex-only cap below. Uses the in-memory `s` for
        // this session (already includes any reservation an earlier invocation in this same
        // command line just added) and the on-disk state of every other recent session.
        if (newSlot && !gateDisabled(cfg, 'max-parallel-agents')) {
          const limit = deps.agentParallelLimit(cfg);
          if (Number.isFinite(limit)) {
            // Concurrency review, Low item: this is a hard resource cap, not policy — an
            // unheld lock (`!locked`, e.g. this whole critical section's own initial
            // acquireLock already timed out) means `s` cannot be trusted against every other
            // racing process, so it is never treated as "under limit" by default; it is
            // forced into the same reconcile-or-refuse path an at-cap count would take,
            // rather than silently letting a lock-contention race admit uncounted.
            let usage = locked ? deps.machineWideLiveUnits(DIR, Date.now(), { currentState: s, currentSessionId: sessionId }) : null;
            if (!locked || usage.total >= limit) {
              // H3: reconcile THIS session's own Orca-tracked workers before refusing — the
              // same out-of-lock-fetch + locked-reapply pattern the max-parallel-codex-
              // workers cap below already uses. A worker this session's own bookkeeping
              // still shows live, but that Orca has already confirmed released or done,
              // would otherwise refuse a dispatch that could actually proceed right now.
              if (locked) { releaseLock(lockDir); locked = false; }
              const rows = fetchOrcaWorkerRows(ORCA_BIN);
              locked = acquireLock(lockDir, deps.capLockOpts);
              if (locked === null) return;
              if (locked === false) {
                violation = { gate: 'max-parallel-agents', reason: deps.lockContentionMessage };
                break;
              }
              s = load(sessionId);
              Object.assign(s.reservations, localReservations);
              if (rows !== null && applyOrcaReconciliation(s, rows)) reconcileChanged = true;
              usage = deps.machineWideLiveUnits(DIR, Date.now(), { currentState: s, currentSessionId: sessionId });
            }
            if (usage.total >= limit) {
              violation = { gate: 'max-parallel-agents', reason:
                deps.formatParallelAgentsRefusal(usage, limit, deps.cores(), deps.parallelCoreFraction(cfg),
                  { explicitLimit: deps.maxParallelAgents(cfg) != null, stateDir: DIR }) };
              break;
            }
          }
        }

        if (codexSlot && cap > 0 && !gateDisabled(cfg, 'max-parallel-codex-workers')) {
          let live = WG.countLiveGroups(s.workers, 'codex') + OC.countPendingCodexReservations(s);
          if (live >= cap) {
            // Run the (up to 5s) Orca reconcile's NETWORK CALL ONLY outside the lock, so an
            // at-cap check on one session never blocks every other concurrent hook process
            // for that long (item 10) — but never read-modify-write state while unlocked
            // (second review round, item 1): a concurrent process's lock-protected write
            // made during this round trip must never be clobbered by a stale save landing
            // after it. `fetchOrcaWorkerRows` does no state I/O at all; the fetched rows are
            // only ever applied to a FRESH post-reacquire `load()`, under the lock, so
            // whatever changed during the unlocked window (including this same command's own
            // earlier localReservations, re-applied here since the reload wiped them) is
            // never lost.
            if (locked) { releaseLock(lockDir); locked = false; }
            const rows = fetchOrcaWorkerRows(ORCA_BIN);
            locked = acquireLock(lockDir, deps.capLockOpts);
            if (locked === null) return;
            s = load(sessionId);
            Object.assign(s.reservations, localReservations);
            if (rows !== null && applyOrcaReconciliation(s, rows)) reconcileChanged = true;
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

        // Kimi cap: the same reconcile-then-recount path as the Codex cap above — the Orca
        // fetch happens outside the lock, its rows are applied to a fresh post-reacquire
        // load() under the lock, and only the recount decides.
        if (kimiSlot && kimiCap > 0 && !gateDisabled(cfg, 'max-parallel-kimi-workers')) {
          let live = WG.countLiveGroups(s.workers, 'kimi') + OC.countPendingReservations(s, 'kimi');
          if (live >= kimiCap) {
            if (locked) { releaseLock(lockDir); locked = false; }
            const rows = fetchOrcaWorkerRows(ORCA_BIN);
            locked = acquireLock(lockDir, deps.capLockOpts);
            if (locked === null) return;
            s = load(sessionId);
            Object.assign(s.reservations, localReservations);
            if (rows !== null && applyOrcaReconciliation(s, rows)) reconcileChanged = true;
            live = WG.countLiveGroups(s.workers, 'kimi') + OC.countPendingReservations(s, 'kimi');
          }
          if (live >= kimiCap) {
            violation = { gate: 'max-parallel-kimi-workers', reason:
              `${live}/${kimiCap} Kimi workers already live: ${liveGroupIds(s, 'kimi').join(', ') || '(reserved)'}.\n` +
              'Wait for one to finish and release it (worker-read, then\n' +
              'worker-release --dispatch <id>), or reuse a finished worker\'s terminal with --terminal <handle>. Raise the\n' +
              'limit only with maxParallelKimiWorkers / ORCH_MAX_PARALLEL_KIMI_WORKERS.' };
            break;
          }
        }
      }

      const reservation = {
        ts: Date.now(), agent, owns: owns && owns.length ? owns : null, ws, codexSlot, kimiSlot, newSlot,
        commandHash,
      };
      localReservations[`${baseId}#${idx}`] = reservation;
      s.reservations[`${baseId}#${idx}`] = reservation;
    }
    if (violation) {
      // All-or-nothing for THIS command's own reservations: an earlier, non-violating
      // invocation in the same multi-invocation command line must not keep its reservation
      // once a later invocation in that same command is refused (unchanged from before this
      // fix) — but a real, Orca-confirmed reconcile effect on OTHER, unrelated workers made
      // during this same critical section must survive independently of this command's own
      // outcome, since it reflects reality regardless of whether this dispatch was allowed.
      for (const key of Object.keys(localReservations)) delete s.reservations[key];
      // `locked` guard: a max-parallel-agents lock-contention refusal can leave `locked`
      // false right here — an earlier reconcile's real effect must still never be saved
      // without the lock actually held (concurrency review, Low item).
      if (reconcileChanged && locked) save(s);
    } else {
      save(s);
    }
  } finally {
    if (locked) releaseLock(lockDir);
  }

  if (violation) d(violation.gate, violation.reason);
}

module.exports = {
  OWNS_BRIEF_HELP, resolveWorkerStartAgent, liveGroupIds, liveCodexGroupIds, reconcileCodexGroupsWithOrca,
  fetchOrcaWorkerRows, applyOrcaReconciliation, handleOrcaDispatchGates, resolveSpecText,
};
