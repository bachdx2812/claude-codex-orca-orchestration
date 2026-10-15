# Orchestration Contract (enforced) - summary

Enforced by `~/.claude/hooks/orchestration/orchestrator-gate.cjs`. Every number is
config-driven (`~/.claude/orchestration.config.json`); the SessionStart banner prints the
live values, so trust it over this file. Full reference (config fields, state, heartbeat
events, janitor, edge cases): `~/.claude/docs/orchestration-contract.md` - read it only when
a refusal or event needs detail.

## Rules

1. **Main panel orchestrates only.** No Edit/Write/mutating shell outside `.claude/`,
   `plans/`, `docs/`, scratch, temp. Delegate real changes.
2. **Models.** Plan / red-team / review -> review model (`opus`), in-session `Agent` with
   `model: "opus"`. Verify-run (CI, screenshots, play-test, smoke) -> verify model (`sonnet`).
   `fable` only after opus failed even at high effort; the dispatch must say so. Light
   lookups -> `haiku` (advisory). Advice on opus needs a line starting `Read-only:`.
3. **Code -> in-session Sonnet 5.5 (medium) by default** (`sonnet-coder`, `model: "sonnet"`).
   Codex is opt-in only: `--exec-codex`, `--code-model codex[:<model>]` or
   `defaultCoder: "codex"`, then an Orca worker while usable and under its handoff
   percentage (default 95); unusable/exhausted -> falls back to Sonnet. No Kimi/DeepSeek.
   Overrides (operator-only): `--code-model <alias|codex|codex:<model>|auto>`,
   `--exec-sonnet|codex|auto`.
4. **Every code brief names a verify command** (or `verify: n/a <reason>`).
5. **Shared-workspace code briefs declare `Owns: <globs>`** on its own line (or
   `Owns: n/a <reason>`); isolated worktrees need none. Overlapping live claims are refused.
6. **Caps.** <= `maxParallelCodexWorkers` (default 3) live Codex workers per session;
   machine-wide budget of live Orca workers + subagents =
   `max(1, floor(parallelCoreFraction x cores))` unless `maxParallelAgents` is set.
7. **Heartbeat.** While any worker is live, run
   `node ~/.claude/hooks/orchestration/orca-heartbeat.cjs` in the background; it exits
   (waking the panel) on the first actionable event: state change, IDLE, STALLED, WAITING FOR
   APPROVAL, WORKER STUCK, HANDOVER, PARKED, rate limit, orphan. Done notices coalesce over
   300s (`heartbeat.coalesceDoneSeconds`). `Stop` is refused while a worker is live and
   unwatched. One heartbeat per session; never leave `sleep`/`until` wait loops running.
8. **Rate limits.** Back off ~120s, then `worker-start --retry-of <dispatchId>`; never
   re-dispatch immediately or start a replacement.
9. **Readiness timeout** with a live terminal: do not replace it - `orca terminal send
   --terminal <h> --text "<one-line brief>" --enter`, then `orca orchestration
   worker-retain --dispatch <id>`.
10. **Finish.** Release a finished worker unless reused. Close a worktree
    (`orca worktree rm --worktree path:<path>`) only when its PR is merged/closed and it is
    clean with nothing unpushed. The janitor removes accepted, clean worktrees.

## Token discipline

- Panel runs on Sonnet and orchestrates only; plan/review reasoning never happens in it.
- Batch 3+ independent subagents into ONE Workflow (one completion notice); otherwise
  dispatch them together in one message.
- Every subagent brief: results to `plans/reports/`, reply <= 10 lines + `Status:`.
- Opus: plans, red-team, unblock advice, final review. Haiku: lookups. Sonnet: code,
  verify-runs, driving the panel.
- Heartbeat only while a worker is live; never sleep/poll loops. Keep
  `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` equal to the gate's parallel budget.
- Workflows: hooks fire for their agents but the gate never gates them (no routing, `Owns`
  or verify checks). Read-only fan-out only (review, red-team, lookups, research); code goes
  through `Agent` dispatches or Orca workers. Always pass `model` (opus review, haiku lookups).

## Escape hatches (operator-only - never add them yourself)

`ORCHESTRATOR_GATE=off` (env), `--no-orchestrate` / `--orchestrate` (prompt),
`--release-claims <id>|all`, cap `0` = unlimited in config/env. Refusals are logged to
`<ORCH_STATE_DIR>/violations.log`.
