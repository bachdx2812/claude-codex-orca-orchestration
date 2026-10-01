# Brief: Kimi exhausted 5h window misread (implement Fix items 1-3)

Read fully first: /Users/macos/apps/kerberos/slot-game/ai-agentic-slot/slot-creating-agent/plans/261001-0450-kimi-exhausted-misread/plan.md
Repo = this worktree (branch bachdx2812/kimi-exhausted-fix). Read README.md and skim hooks/lib/kimi-quota-probe.cjs,
hooks/lib/exec-route-by-quota.cjs, hooks/lib/coder-availability.cjs, hooks/lib/coder-pool-route.cjs,
hooks/lib/worker-quota-handover.cjs, hooks/orca-heartbeat.cjs, hooks/orchestrator-gate.cjs, existing tests/*.

Implement plan Fix items 1-3:
1. kimi-quota-probe.cjs: per-window usedPercent from `usage` (weekly) and `limits[].detail` (5h window, duration 300 min):
   used/limit*100 if `used` present, else (limit-remaining)/limit*100; ignore `usages.*.used_ratio` unless nothing else
   exists. Tightest window wins. resetAt from detail.resetTime.
2. A 403 "usage limit" (e.g. "You've reached your 5-hour usage limit") on ANY Kimi worker terminal seen by the heartbeat
   (tracked in this session or not - machine-wide fact) writes the machine-wide Kimi exhaustion marker (coder-exhausted.json)
   until the reported reset (for "5-hour": the 5h window resetTime from last /usages, else now+5h). Pool pick treats Kimi
   as exhausted while marker valid; handover then allows Sonnet (sonnet-coder) when Codex is also >= threshold.
3. When no coder is eligible, route-execution must ALLOW the in-session Sonnet dispatch (sonnet-coder); never refuse it
   in favour of an exhausted coder.

Tests (add to existing suites or a new tests/test-kimi-exhausted-misread.cjs wired into npm test): use the captured payload:
{"usage":{"limit":"100","used":"58","remaining":"42"},"limits":[{"window":{"duration":300},"detail":{"limit":"100","used":"100","resetTime":"2026-10-01T00:13:49Z"}}],"usages":{"limit_5h":{"used_ratio":0},"limit_7d":{"used_ratio":0}}}
Assert: Kimi 100% used / exhausted; marker written + honored; routing picks Sonnet when Codex also exhausted.
Do not put plan IDs / audit labels in code comments or test names.

HARD RULES: tests must NEVER call real kimi/codex/orca/network or read the real ~/.kimi-code (use ORCH_KIMI_HOME,
ORCH_STATE_DIR, ORCH_KIMI_BIN, ORCH_KIMI_USAGE_URL to local loopback stubs/tmp dirs as the existing tests do).
Never print tokens.

Owns: hooks/lib/**, hooks/orca-heartbeat.cjs, hooks/orchestrator-gate.cjs, tests/**, package.json
verify: npm test (all green)

When green: git add + commit (conventional, e.g. "fix(gate): read exhausted kimi windows from used/limit; mark 403 exhaustion; allow sonnet when no coder eligible"), no AI references. DO NOT push.
Final message: short summary of changes + npm test result.
