# Fix round for commit 4be4a06 (kimi-exhausted-fix)

Work in THIS worktree (branch bachdx2812/kimi-exhausted-fix). Read the review first:
/Users/macos/apps/kerberos/slot-game/ai-agentic-slot/slot-creating-agent/plans/261001-0450-kimi-exhausted-misread/review.md

Owns: hooks/orca-heartbeat.cjs, hooks/lib/exec-route-by-quota.cjs, hooks/lib/coder-pool-route.cjs, hooks/orchestrator-gate.cjs, tests/test-kimi-exhausted-misread.cjs, tests/test-kimi-signals-caps.cjs, tests/test-worker-stall.cjs, rules/orchestration-contract.md

## 1. BLOCKER (hooks/orca-heartbeat.cjs ~1266-1271, untracked-terminal path)
The untracked-terminal Kimi-403 path currently matches any terminal whose agent is absent (other sessions' Codex/Claude
panes, the operator panel, plain shells). Fix:
- A terminal outside this session's own fleet counts ONLY when positively identified as Kimi: via a machine-wide
  handle->agent map (unscoped `worker-list`, or all state files' `workers[*].agent`) requiring `=== 'kimi'`, or a
  Kimi-identifying title. NEVER on a missing/unknown agent.
- Exclude the panel's own handle (`panelHandle` / ORCA_TERMINAL_HANDLE), same as `classifyTerminal`'s `ownHandles` guard (~:985).
- For such a non-own terminal: write the marker (call `onCoderExhausted`) but do NOT push the wake event
  (events are limited to this session's own fleet).
- Tests (tests/test-kimi-exhausted-misread.cjs): (a) untracked NON-Kimi terminal showing an indented
  `403 You've reached your 5-hour usage limit` line -> no marker, no event; (b) another session's Kimi terminal
  (identified positively) -> marker written, NO event.

## 2. Non-blocking
- `kimiWindowResetMs` (hooks/lib/exec-route-by-quota.cjs ~:314) must also read `kimi-quota-last-known.json`
  when the live cache is failed/expired, so the marker ends at the real reset instead of now+5h.
- `persistLastKnownQuota` (~:395) must persist `durationMinutes` per window (and the read path must round-trip it).
- Re-arm exhaustion reports after a reset: `reportedUsageExhausted` (per handle) must clear/re-arm once the coder's
  exhaustion marker has expired or a fresh below-threshold reading arrived, so a reused Kimi terminal that hits the
  limit again re-marks/re-reports.
- Add focused tests for each of the three items.
- Update rules/orchestration-contract.md only where behavior text changed (keep minimal).

## Constraints
- Code comments explain invariants; NO plan ids / finding labels / review refs in code, test names, or commit message.
- Match surrounding style. No new deps.

## Verify
Verify: npm test (all suites pass, exit 0)

Run in the FOREGROUND, wait for completion, never background anything:
`npm test` (from the worktree root) until ALL green. Fix failures, do not weaken tests.

## Finish
Commit with a conventional message (e.g. `fix(gate): scope untracked kimi 403 path to positively identified kimi terminals`),
NO AI/co-author references. DO NOT push. Then print a short summary (files changed, tests run + counts, commit sha).
