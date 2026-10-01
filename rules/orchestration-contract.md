# Orchestration Contract (enforced)

This file documents the workflow `hooks/orchestrator-gate.cjs` enforces on every session,
generated from the source of truth: the gate's code plus
`~/.claude/orchestration.config.json`. Every noun below (model aliases, the Codex handoff
threshold, the reply language) is a config value, not a literal baked into this file — if
you change the config, re-read the SessionStart banner rather than this file for the
exact current numbers - it now names both the alias and the exact id, e.g.
`model "opus" (claude-opus-5-5)`.

**Shipped versions** (the example config; override in `~/.claude/orchestration.config.json`):
planning/red-team on **Opus 5.5** (`claude-opus-5-5`); review/verify on the model mapped to
the code's author — the code model **Sonnet** for external coders, Opus for code Sonnet
itself wrote; escalation on **Fable 5.1** (`claude-fable-5-1`); Codex worker dispatches on
**`gpt-5.6-sol`**; DeepSeek runs through `opencode` with the model from
`~/.config/opencode/opencode.jsonc` (Orca cannot pin it).

## The contract

1. **The main panel orchestrates and nothing else.** It takes the operator's input,
   dispatches work, and supervises it. It does not implement. Edit/Write/MultiEdit/
   NotebookEdit and mutating shell commands are refused outside `.claude/`, `plans/`,
   `docs/`, scratch, and a temp dir.
2. **Planning and red-team run on the configured review model**
   (`models.review.alias`, default `opus`), as an in-session subagent (`Agent` with
   `model: "<review alias>"`). **Review and verification follow the code's author**
   (`models.reviewByCoder`, default `{ "codex": "sonnet", "kimi": "sonnet",
   "deepseek": "sonnet", "sonnet": "opus" }`): code written by an external coder (Codex,
   Kimi, DeepSeek/opencode) is reviewed on the code model, code the code model itself wrote
   on the review model — a model never reviews its own output. When no code author is known
   yet the gate allows either, so a review is never blocked for lack of an author. The
   configured escalation model (`models.escalation.alias`, default `fable`) is reserved for
   work the review model could not do, even at higher effort — a dispatch to it must say so.
   An Opus review of external-coder code is refused unless the dispatch says the mapped
   (Sonnet) review already ran and could not decide
   (`escalation: sonnet review could not decide ...`).
3. **Code goes to an external coder (Codex, Kimi or DeepSeek) in an Orca worker first**, and
   to the configured in-session code
   model (`models.code.alias`, default `sonnet`) only once every usable coder has exhausted
   its quota — Codex at `codexHandoffUsedPercent` (default 95), Kimi at the separate
   `kimiHandoffUsedPercent` (default 95) of its tightest live-read rate-limit window, DeepSeek
   at `deepseekHandoffUsedPercent` (default 95) of its daily spend cap (default unlimited, so
   it stops only on an exhausted balance). Routing
   spreads every Codex task class — code, builds, refactors, tests, bulk conversions, and
   fix loops — across the peers. Among eligible coders, pick the coder with MORE QUOTA
   LEFT: a free per-session slot first, then more
   headroom below the coder's own threshold; within `coderHeadroomTieBand` (default 10
   headroom points) of each other, fewer live worker groups across every recent session on
   this machine, then the coder other than `lastCoder`, and finally Codex as the last
   tie-break. A quota-unknown coder ranks as `unknownHeadroomAssumed` (default 30) headroom
   points; a reset-aware estimate of the last successful reading counts as known. Each coder
   is optional: one not installed, signed in, or
   launchable on this machine is excluded; all coders exhausted or unusable means Sonnet.
   DeepSeek defaults to the `overflow` role — picked only once no subscription coder (Codex,
   Kimi) is eligible, before Sonnet — and is a full peer once `deepseekRole` is `peer`. The
   operator can pick the coding model directly with `--code-model
   <alias|codex|codex:<model>|kimi|kimi:<model>|deepseek|deepseek:<model>|auto>`,
   or use the `--exec-sonnet` / `--exec-codex` / `--exec-kimi` / `--exec-deepseek` /
   `--exec-auto` shortcuts.
   A `worker-start --agent kimi` is dispatched WITHOUT `--model` (Kimi uses
   `default_model` from `~/.kimi-code/config.toml`); a `worker-start --agent opencode`
   (DeepSeek) is likewise dispatched WITHOUT `--model`, using the model from
   `~/.config/opencode/opencode.jsonc`.
4. **Light lookups** (find/locate code, read logs or test output, explore) are advised
   toward the configured lookup model (`models.lookup.alias`, default `haiku`) — this is
   advisory only and never blocks.
5. **Every code brief names a verify command** (or `verify: n/a <reason>`) — a Codex
   `--spec` or an in-session code prompt whose intent reads as implementation work must
   let the coder check its own output before reporting done.
6. **A continuous heartbeat daemon supervises live Orca workers.** `Stop` refuses to end
   the session while a worker is live and unwatched. The daemon reports a worker whose
   agent process vanished back to a shell prompt immediately as `WORKER EXITED` — the
   common cause is an `--agent claude` worker started in an untrusted worktree stopping
   at Claude Code's "trust this folder?" dialog (default `No, exit`). Prefer Kimi/Codex
   workers in new worktrees, or a headless `claude -p --dangerously-skip-permissions`
   brief launched via `worker-start` (a bare `orca terminal create` terminal is gated as
   a main panel, not a worker).
7. **Codex rate-limits under parallel load.** On a rate-limit signal the correct response
   is to back off and retry the *same* dispatch (`worker-start --retry-of <id>`), never to
   re-dispatch immediately or start a replacement.
8. **No more than `maxParallelCodexWorkers` (default 3) live Codex workers at once** — and
   no more than `maxParallelKimiWorkers` (default 3) live Kimi workers at once. A
   `worker-start` that would exceed its coder's cap is refused; wait for one to finish and release it,
   reuse its terminal (`--terminal <handle>`), or retry it (`--retry-of <id>`) — neither
   replaces an existing group, so neither counts as a new dispatch against the cap.
9. **A code brief in a shared workspace declares the files it will touch.** `Owns: <paths>`
   (repo-relative, globs ok) or `Owns: n/a <reason>`, on its own line, for every code
   brief that already needs a verify command (an Orca `--spec` or an in-session code
   dispatch) — unless the work is isolated (`--worktree new-child`/`new-top-level`, or
   Agent `isolation:"worktree"`), which needs no `Owns:` at all. A claim that overlaps
   another live claim in the same workspace is refused.
10. **No more than a MACHINE-wide budget of live Orca workers plus live in-session
    subagents at once.** The resource being budgeted is this machine's cores, not any one
    session's own concurrency: `max(1, floor(parallelCoreFraction x cores))` by default
    (`parallelCoreFraction` default `0.8`), or an explicit `maxParallelAgents` (`0` =
    unlimited). Summed across every recent session's state file on this machine — every
    live Orca worker group of any agent (on top of, never instead of, the Codex-only cap
    above) plus every live main-panel `Agent`/`Task` dispatch. A dispatch that would exceed
    it is refused; wait for one to finish and release it, or raise the limit.

Agent/Task intent classification gives a recognized first verb in the description priority
over later nouns: `Review ...`/`Plan ...` are review work, while `Implement ...` and
`Generate code/assets/components ...` are code work.
The operational first verbs `commit`, `push`, `merge`, `publish`, `rebase`, `tag`, `release`,
`deploy`, `update`, and `write` suppress later `review`, `plan`, or `design` tokens, but later
code intent still routes to code. Review-oriented `subagent_type` values remain review signals
unless the description contains code intent, which wins when both signals are present. Code intent
inside ordinary hyphenated verbs such as `Re-implement` and `Hot-fix` counts; only review-style
prefixes such as `review-fix` are excluded, so `Commit review-fix round` remains operational.

A review-intent dispatch is then routed by author. Plan, red-team and design work — a
planning noun (`plan`/`planning`/`design`/`architecture`/`architect`/`red-team`) or a
`plans/**.md` / `plan.md` path, ANYWHERE in the description, `subagent_type` or prompt head —
always stays on the review model, whatever the first verb: `Review the plan at
plans/x/plan.md`, `Audit the implementation plan` and `Verify plan claims` are plan reviews,
never code reviews. Only a review of code (`review`/`verify`/`audit`/`critique`/`assess` with
no planning object) follows `models.reviewByCoder` for the session's last code author, so a
plan review can never silently migrate off the review model to the code model.

## Activation

`config.activation` decides which sessions this gate governs at all:

- `"orca-only"` (default): gates only a session that carries `ORCA_TERMINAL_HANDLE` — i.e.
  one actually running inside an Orca-managed terminal, since only those sessions have a
  worker fleet to delegate to. A plain `claude` session with no Orca underneath it is left
  alone.
- `"always"`: gates every session regardless of environment.
- `"off"`: disables the gate entirely (same effect as the `ORCHESTRATOR_GATE=off`
  environment variable, which always wins regardless of config).

`ORCHESTRATOR_GATE=off` is meant for CI and headless `claude -p` invocations that must
never be gated, independent of the installed config.

## Main-vs-subagent vs Orca-worker detection

A hook payload from the main panel carries no `agent_id`/`agent_type`; an in-session
subagent's payload carries both — subagents are never gated, since they are what actually
does the work. An Orca `worker-start` dispatch is a *separate* top-level Claude Code
session with the same shape as the main panel; it is told apart by its Orca terminal:
every session launched inside Orca inherits `ORCA_TERMINAL_HANDLE`, and a worker's handle
is listed as `agentTerminalHandle` by `orca orchestration worker-list`. Unknown (no
terminal handle, or Orca unreachable) counts as main panel, so the gate fails toward
enforcing, never toward silently disabling itself.

## Overriding the coding model from the main panel

The operator (only) can pick who writes code for the rest of the session:

```
--code-model opus          # the configured review model, for code work specifically
--code-model sonnet        # the configured code model (same as --exec-sonnet)
--code-model haiku         # the configured lookup model, for code work specifically
--code-model fable         # the configured escalation model, for code work specifically
--code-model codex         # Codex in an Orca worker, no pinned model (same as --exec-codex)
--code-model codex:gpt-5-custom   # Codex in an Orca worker, pinned to this model
--code-model kimi          # Kimi in an Orca worker (same as --exec-kimi); no --model — Kimi uses default_model from ~/.kimi-code/config.toml
--code-model kimi:<model>  # Kimi, recorded model preference shown in reminders (Orca cannot pin it)
--code-model deepseek      # DeepSeek via opencode in an Orca worker (same as --exec-deepseek); no --model
--code-model deepseek:<model>  # DeepSeek, recorded model preference (the real pin is "model" in ~/.config/opencode/opencode.jsonc)
--code-model opencode      # alias of deepseek (the Orca agent name)
--code-model auto          # back to automatic routing (same as --exec-auto)
```

The last matching flag in a prompt wins. An invalid value (unknown word, or anything
outside `[a-z0-9._:-]`, so a slash or space is never silently truncated) is ignored with a
notice; nothing changes. Picking a Claude alias for code work exempts that dispatch from
the review-model/escalation-model scope gates for code specifically — the operator asked
for it by name, so the gate does not then refuse it for being the "wrong" model doing code.
Every active override is repeated on each prompt and in the `SessionStart` banner with
the time it was set and the command that returns routing to automatic quota selection.

**With a `codex` (or `codex:<model>`) override while the Orca-unreachable fallback is
active**, in-session code still runs on the configured code model, not Codex — the
fallback exists precisely because Orca cannot be reached, so it cannot honor "use Codex"
either, regardless of what the operator's standing override says.

## Coder availability (no Orca / no Codex / no Kimi / no DeepSeek)

Codex and Kimi are peers; DeepSeek (via `opencode`) is an `overflow` coder by default
(picked only once no subscription coder is eligible, before Sonnet) and a full peer when
`deepseekRole` is `peer`. Every coder is optional: any machine may have none of them.
Automatic routing first establishes which coders are usable,
then applies the load-balancing order in rule 3; Codex is chosen first only at the final
tie-break. A quota-unknown reading does not by itself make a usable coder ineligible.
Codex quota discovery first uses a fresh state-dir live cache (including cached failures), then queries `codex app-server`
JSON-RPC `account/rateLimits/read` (5-second parent timeout, 4.5-second helper deadline,
no model call), then scans local Codex session logs no older than six hours. A helper that
must stop its app-server child escalates from SIGTERM to SIGKILL. If all three sources are
unavailable, the reading falls back to a reset-aware ESTIMATE of the last successful
reading: each coder's last known quota (used% per window, resetAt per window, readAt) is
persisted in `codex-quota-last-known.json` / `kimi-quota-last-known.json` in the state dir,
and a window whose reset time has passed counts as 0% used while every other window keeps
its last reading (marked "est., read <age> ago" in the reminder). Only a coder that was
never read successfully is unknown rather than evidence that it is unusable. If only
one coder is eligible, all code goes to it; if neither coder is eligible,
`execFallbackWhenCodexUnavailable: "sonnet"` (the default) routes to the configured code
model. Setting the legacy-named option to `null` disables that automatic in-session
fallback; it does not make an unusable coder eligible.

Each coder's **availability** (binary present? signed in?) is probed per machine and cached
in `coder-availability.json` in the gate state directory for `coderAvailabilityCacheSeconds`
(default 600; `ORCH_CODER_AVAILABILITY_CACHE_SECONDS` overrides for one process). Availability
is distinct from quota: **unusable** (excluded from routing) means the binary is missing,
Codex is logged out, Kimi's credentials file (`~/.kimi-code/credentials/kimi-code.json`) is
missing/unparseable/has no token, or `orca` itself is missing (which excludes both). A
**quota-unknown** reading (read failed, timeout, HTTP 401/403, expired token) still counts
as usable — Kimi's CLI refreshes its own short-lived token, so the gate never refreshes it.
Kimi's live quota comes from `GET ${KIMI_CODE_BASE_URL:-https://api.kimi.com/coding/v1}/usages`
with the access token sent only as an `Authorization` header inside the spawned probe helper —
**the token is never written to stdout, stderr, state, or any log** — cached in
`kimi-quota-live.json` for `kimiQuotaCacheSeconds` (default 60;
`ORCH_KIMI_QUOTA_CACHE_SECONDS` overrides). A worker whose output shows Kimi's billing-cycle
403 ("You've reached your usage limit for this billing cycle", error-shaped lines only, and
only for terminals whose tracked agent is `kimi`) is recorded in `coder-exhausted.json` with
an `until` time (the reported reset, else 6 hours); that coder is excluded from routing
until the marker expires or a fresh quota reading shows it below its threshold. A terminal
**outside** the session's own fleet marks Kimi exhausted only when positively identified as
a Kimi terminal (another session's worker records or a Kimi-identifying title) — never on an
absent agent — and writes the marker silently, without a wake event. A reported terminal
re-arms once its episode's `until` passes, so a Kimi terminal re-used after the window reset
marks again on the next limit.

DeepSeek runs through the `opencode` agent and is **unusable** (excluded from routing) unless
all three hold: the `opencode` binary is present (`ORCH_OPENCODE_BIN` overrides which binary
is checked), a DeepSeek credential is configured in opencode (`opencode auth list` shows
DeepSeek, or `DEEPSEEK_API_KEY` is set), and opencode's default `model` is a `deepseek/*`
model — otherwise a worker would silently run Claude. DeepSeek is pay-per-use with no
rate-limit window: its headroom is the remaining share of a **daily spend cap**
(`deepseekDailySpendCapUsd`, default `0` = unlimited, env `ORCH_DEEPSEEK_DAILY_CAP_USD`),
computed from today's DeepSeek spend read from what opencode really exposes — first its
sqlite store (`~/.local/share/opencode/opencode.db`, rows with `providerID = deepseek`
created since local midnight; `ORCH_OPENCODE_DB` overrides the path), then the `deepseek/*`
model blocks of `opencode stats --days 1 --models` (opencode 1.18 has no `stats --json`).
When neither can be read the spend is not computable, so with a **non-zero** cap DeepSeek
reads quota-unknown (ranked `unknownHeadroomAssumed`, never exhausted) and the cap stops
nothing; the default unlimited cap is unaffected. An optional balance check
`GET https://api.deepseek.com/user/balance` (the API key travels only in the spawned probe's
header, never in output, state, or logs) treats a zero balance or `is_available: false` as
exhausted. A worker whose output shows DeepSeek's 402 `Insufficient Balance` (error-shaped
lines only, and only for terminals whose tracked agent is `opencode`) is recorded in
`coder-exhausted.json` with a `reason`, mirroring Kimi's billing-cycle limit. No state
file ever contains a token or an API key.

The gate checks `orca`/`codex`/`opencode` reachability itself (an absolute
`ORCA_BIN`/`ORCH_CODEX_BIN`/`ORCH_OPENCODE_BIN` path is checked with a file-exists test; a
bare default name via `which`/`where`) — no per-invocation cost beyond those lookups, and
never a live `worker-list` call just to decide routing.

Live-cache refresh is single-flight across hook processes through a short lease in the
state directory. The lease winner probes app-server; peers consume the refreshed value or
the prior stale value instead of starting parallel probes. Process-local memoization stays
enabled even when the file-cache TTL is `0`.

Independent of that automatic fallback, the operator can always route explicitly:

- `--exec-sonnet` (or `--code-model <code alias>`): an explicit, session-scoped operator
  preference. It does not claim Orca is down.
- Declaring the Orca fallback: `date -u +%Y-%m-%dT%H:%M:%SZ >
  ~/.claude/orchestrator-gate/orca-unavailable`. This *does* claim Orca is unreachable,
  and expires after 15 minutes on purpose — a permanent flag would silently disable the
  Codex-in-Orca rule forever after one transient failure.

`node install.mjs --check` reports whether `orca`, `codex` and `opencode` are on `PATH`,
whether Codex looks logged in, whether opencode is set up for DeepSeek, and the effective
config (including `execFallbackWhenCodexUnavailable`) as the installed hooks would actually
read it. It also reports any registered foreign
`orchestrator-gate.cjs` as a problem. Install preserves such registrations with a warning
unless the operator explicitly supplies `--replace-foreign-gate`; the ordinary settings
backup precedes their removal. Help and unknown options never enter the install path.

## Config

`~/.claude/orchestration.config.json` (see
`config/orchestration.config.example.json`), all fields optional:

```json
{
  "replyLanguage": null,
  "activation": "orca-only",
  "models": {
    "review": { "alias": "opus", "id": "claude-opus-5-5" },
    "escalation": { "alias": "fable", "id": "claude-fable-5-1" },
    "code": { "alias": "sonnet", "id": null, "effort": "medium", "agentType": "sonnet-coder" },
    "lookup": { "alias": "haiku", "id": null },
    "codex": { "alias": null, "id": "gpt-5.6-sol" },
    "kimi": { "alias": null, "id": null },
    "deepseek": { "alias": null, "id": null },
    "reviewByCoder": { "codex": "sonnet", "kimi": "sonnet", "deepseek": "sonnet", "sonnet": "opus" },
    "reviewEffort": "medium"
  },
  "agents": { "escalation": [], "lookup": ["Explore"] },
  "codexHandoffUsedPercent": 95,
  "kimiHandoffUsedPercent": 95,
  "deepseekHandoffUsedPercent": 95,
  "handoverWarnMarginPercent": 5,
  "autoResumeAfterReset": true,
  "autoResumePanel": true,
  "codexQuotaCacheSeconds": 60,
  "kimiQuotaCacheSeconds": 60,
  "deepseekQuotaCacheSeconds": 60,
  "coderAvailabilityCacheSeconds": 600,
  "coderHeadroomTieBand": 10,
  "unknownHeadroomAssumed": 30,
  "deepseekRole": "overflow",
  "deepseekDailySpendCapUsd": 0,
  "execFallbackWhenCodexUnavailable": "sonnet",
  "heartbeat": {
    "intervalSeconds": 20,
    "idleSeconds": 60,
    "maxSeconds": 3600,
    "stallSeconds": 900,
    "stallSecondsByAgent": { "kimi": 600 }
  },
  "maxParallelCodexWorkers": 3,
  "maxParallelKimiWorkers": 3,
  "maxParallelDeepseekWorkers": 3,
  "ownershipClaimTtlMinutes": 120,
  "disabledGates": [],
  "closeDoneWorktrees": "remove",
  "parallelCoreFraction": 0.8,
  "maxParallelAgents": null
}
```

- `replyLanguage`: e.g. `"Vietnamese"`; `null` (default) omits the language sentence from
  every reminder entirely — nothing is hard-coded to a specific language.
- `models.<role>.alias`: the Claude Code model alias the gate matches against and
  instructs dispatches to use. `models.<role>.id`: the exact model ID, used only in banner
  text and in `orca ... --model <id>` examples — the gate itself matches on alias.
  `models.code` also carries `effort` (one of `low|medium|high|xhigh|max`, default
  `medium`) and `agentType` (default `sonnet-coder`): the effort and subagent_type the
  in-session code route is dispatched with — reminder and refusal advice say e.g.
  "sonnet (claude-sonnet-5-5), effort medium: Agent subagent_type sonnet-coder + model
  sonnet" and, for an Orca Claude worker, `--model claude-sonnet-5-5 --effort medium`. The
  matching agent definition ships as `agents/sonnet-coder.md` (installed only when absent;
  a user-edited file is never overwritten).
- `agents.escalation` / `agents.lookup`: agent names (by `subagent_type`) that count as
  that role even without a matching `model`. Both default to a minimal, non-operator-
  specific set (`agents.lookup` ships with `["Explore"]`; `agents.escalation` ships
  empty) — add your own team's advisory-agent names here rather than expecting the gate
  to guess them.
- `codexHandoffUsedPercent`: integer 0-100, default 95. Codex leaves the eligible peer
  pool once it has used this much of its tightest quota window. Overridable for one
  process with `ORCH_CODEX_HANDOFF_USED`.
- `kimiHandoffUsedPercent`: integer 0-100, default 95. Kimi's own, independent threshold:
  Kimi leaves the eligible peer pool once it has used this much of its
  tightest quota window. Overridable for one process with `ORCH_KIMI_HANDOFF_USED`.
- `deepseekHandoffUsedPercent`: integer 0-100, default 95. DeepSeek leaves the eligible
  coder pool once it has used this much of its daily spend cap. Overridable for one process
  with `ORCH_DEEPSEEK_HANDOFF_USED`.
- `deepseekRole`: `"overflow"` (default) or `"peer"`. `overflow` picks DeepSeek only when no
  subscription coder (Codex, Kimi) is eligible, before the Sonnet fallback; `peer` gives it
  the same headroom / tie-band / live-count / `lastCoder` rules as Codex and Kimi.
  Overridable for one process with `ORCH_DEEPSEEK_ROLE`.
- `deepseekDailySpendCapUsd`: number 0-100000, default `0` (= unlimited). DeepSeek's
  pay-per-use "quota" is the remaining share of this daily cap; at `0` only an exhausted
  balance (or a 402 `Insufficient Balance`) stops it. Overridable for one process with
  `ORCH_DEEPSEEK_DAILY_CAP_USD`.
- `handoverWarnMarginPercent`: integer 0-100, default 5. A live worker gets a persisted
  early-warning episode this many percentage points before its coder's threshold; `0`
  disables the early warning while retaining threshold/exhaustion handover.
- `autoResumeAfterReset`: boolean, default `true`. When no handover target exists, park an
  exhausted supervised worker and launch its detached reset scheduler. `ORCH_AUTO_RESUME`
  accepts true/false, 1/0, yes/no, or on/off for one process; blank is unset.
- `autoResumePanel`: boolean, default `true`. Apply the same reset scheduling to the exact
  panel terminal in `ORCA_TERMINAL_HANDLE` when its screen shows a Claude limit message.
- `codexQuotaCacheSeconds`: integer 0-3600, default 60. How long a successful live
  `codex app-server` quota reading or a failed probe is reused from `codex-quota-live.json` in the gate
  state directory; `0` disables cross-process file reuse but not the memo inside one hook
  process. Overridable for one process with
  `ORCH_CODEX_QUOTA_CACHE_SECONDS`.
- `kimiQuotaCacheSeconds`: integer 0-3600, default 60. Same as `codexQuotaCacheSeconds`,
  for the Kimi `/usages` reading cached in `kimi-quota-live.json`. Overridable for one
  process with `ORCH_KIMI_QUOTA_CACHE_SECONDS`.
- `deepseekQuotaCacheSeconds`: integer 0-3600, default 60. Same as `codexQuotaCacheSeconds`,
  for the DeepSeek spend/balance reading. Overridable for one process with
  `ORCH_DEEPSEEK_QUOTA_CACHE_SECONDS`.
- `coderAvailabilityCacheSeconds`: integer 0-86400, default 600. How long a per-machine
  coder availability probe (binary present? signed in?) is reused from
  `coder-availability.json`. Overridable for one process with
  `ORCH_CODER_AVAILABILITY_CACHE_SECONDS`.
- `coderHeadroomTieBand`: integer 0-100, default 10 (blank/unset = default). The
  headroom-point band within which two eligible coders tie; inside it the pick falls back
  to fewer live workers machine-wide, outside it the coder with MORE QUOTA LEFT wins.
- `unknownHeadroomAssumed`: integer 0-100, default 30 (blank/unset = default). The headroom
  a quota-unknown coder is ranked as: below any coder with known headroom >= this value,
  above one with less. A reset-aware estimate of the last successful reading counts as
  known, not unknown.
- `models.kimi`: `{ "alias": null, "id": null }` by default; `id` is shown in banner text
  only — Orca cannot pin a Kimi model on `worker-start`, so the real pin is
  `default_model` in `~/.kimi-code/config.toml`.
- `models.deepseek`: `{ "alias": null, "id": null }` by default; shown in banner text only.
  Orca cannot pin a model for `--agent opencode`, so the real pin is `model` in
  `~/.config/opencode/opencode.jsonc`, and that model must be a `deepseek/*` one for the
  coder to count as usable.
- `models.reviewByCoder`: author coder -> review model alias (a string per entry). Default
  `{ "codex": "sonnet", "kimi": "sonnet", "deepseek": "sonnet", "sonnet": "opus" }` — code
  by an external coder is reviewed on the code model, code by the code model on the review
  model. `ORCH_REVIEW_MODEL_EXTERNAL` / `ORCH_REVIEW_MODEL_SONNET` override the external
  and sonnet mappings for one process. An entry that is not a non-empty string falls back to
  its own default with a banner warning.
- `models.reviewEffort`: one of `low|medium|high|xhigh|max`, default `medium` — the effort
  the in-session (code-model) reviewer runs at.
- `heartbeat.stallSeconds`: integer 1-86400, default 900. With no worktree change or new
  meaningful terminal output for this long, a supervised worker produces an informational
  stall wake event. `ORCH_STALL_SECONDS` overrides the global value for one process; blank
  is unset and invalid values fall back to config.
- `heartbeat.stallSecondsByAgent`: object of per-agent integer thresholds 1-86400. These
  take precedence over the global value; the default is `{ "kimi": 600 }`.
- `disabledGates`: gate ids to skip entirely (e.g. `["code-brief-needs-verify"]`). Unknown
  names are kept (in case a future gate adds that id) but produce a one-line warning in
  the SessionStart banner.
- `maxParallelCodexWorkers`: integer 0-32, default 3. How many live Codex worker *groups*
  (see "Section 0 fixes" below — one worker-start reply's dispatch id, task id and
  terminal handle together are one group, never three) this session may hold at once; `0`
  is unlimited. Only Codex-agent worker-starts are counted — a `--terminal <h>` or
  `--retry-of <id>` that replaces an existing tracked group is not a new dispatch and does
  not count, and a non-Codex agent is never counted at all. Overridable for one process
  with `ORCH_MAX_PARALLEL_CODEX_WORKERS`.
- `maxParallelKimiWorkers`: integer 0-32, default 3. The same per-session group cap for
  Kimi-agent worker-starts; `0` is unlimited. Overridable for one process with
  `ORCH_MAX_PARALLEL_KIMI_WORKERS`.
- `maxParallelDeepseekWorkers`: integer 0-32, default 3. The same per-session group cap for
  DeepSeek (`opencode`-agent) worker-starts; `0` is unlimited. Overridable for one process
  with `ORCH_MAX_PARALLEL_DEEPSEEK_WORKERS`.
- `ownershipClaimTtlMinutes`: integer 1-10080, default 120. How long a background
  in-session Agent's `Owns:` claim survives without an explicit release before it
  auto-expires. Overridable for one process with `ORCH_CLAIM_TTL_MINUTES`.
- `closeDoneWorktrees`: `remove` | `remind` | `off`, default `remind` — check the live
  `~/.claude/orchestration.config.json` for this installation's actual value. What the
  heartbeat does about a worktree that is idle, accepted, and clean (see "Close finished
  worker panels" above for the full definition): `remove` runs
  `orca worktree rm --worktree path:<path> --json` itself and logs an informational
  `WORKTREE REMOVED` line (no panel decision needed) — but ONLY when the worktree holds no
  live terminal at all; a live-but-quiet terminal falls back to `remind` instead, and a
  failed `rm` call is reported once as `WORKTREE RM FAILED` (with the same `remind`
  fallback) and retried on a bounded cooldown rather than recorded as done; `remind` wakes
  the panel with the exact, quoted rm command and never runs it; `off` does nothing. The
  never-remove guards are identical in both modes: never an open PR/MR, never uncommitted
  or unpushed work, never the main worktree, never another session's worktree. Legacy
  booleans still load (`true` -> `remind`, `false` -> `off`). Overridable for one process
  with `ORCH_CLOSE_DONE_WORKTREES` set to `remove`/`remind`/`off`, or the legacy
  `1`/`true` (= remind) and `0`/`false` (= off) — any other value, including an empty
  string or the variable being unset, defers to the config rather than being read as
  "set at all, so true".
- `parallelCoreFraction`: number 0.1-1, default `0.8`. The share of this machine's cores
  (`os.availableParallelism?.() || os.cpus().length`, read fresh at every check) the
  machine-wide `max-parallel-agents` budget derives its limit from when `maxParallelAgents`
  is `null`. Overridable for one process with `ORCH_PARALLEL_CORE_FRACTION` — an empty or
  whitespace-only override is treated as unset (falls back to config), never coerced to `0`.
  The config file itself only accepts an actual JSON number; anything else (including `""`)
  falls back to the default with a warning.
- `maxParallelAgents`: `null` (default) or integer 0-256. `null` derives the limit as
  `max(1, floor(parallelCoreFraction x cores))`; an explicit integer overrides that
  derivation outright; `0` means unlimited. See "Parallel Codex workers and file
  ownership" below for what counts against it. Overridable for one process with
  `ORCH_MAX_PARALLEL_AGENTS` — same empty/whitespace-is-unset and number-only-in-config
  rules as `parallelCoreFraction` above (an empty override coercing to `0` would otherwise
  silently turn the cap unlimited).

Env overrides: `ORCH_CONFIG_PATH` (which file to read), `ORCH_STATE_DIR` (where session
state, the violations log and heartbeat liveness files live — default
`~/.claude/orchestrator-gate/`), `ORCA_BIN` (which `orca` executable to invoke — mainly
for tests), `ORCH_CODEX_BIN` (which `codex` executable the live quota probe invokes —
and which executable the routing fallback checks; legacy `CODEX_BIN` remains a lower-priority
alias), `ORCH_CODEX_HANDOFF_USED`, `ORCH_CODEX_QUOTA_CACHE_SECONDS`,
`ORCH_KIMI_HANDOFF_USED`, `ORCH_KIMI_QUOTA_CACHE_SECONDS`,
`ORCH_DEEPSEEK_HANDOFF_USED`, `ORCH_DEEPSEEK_QUOTA_CACHE_SECONDS`,
`ORCH_DEEPSEEK_ROLE`, `ORCH_DEEPSEEK_DAILY_CAP_USD`,
`ORCH_REVIEW_MODEL_EXTERNAL`, `ORCH_REVIEW_MODEL_SONNET`,
`ORCH_CODER_AVAILABILITY_CACHE_SECONDS`, `ORCH_MAX_PARALLEL_KIMI_WORKERS`,
`ORCH_MAX_PARALLEL_DEEPSEEK_WORKERS`,
`ORCH_STALL_SECONDS`, `ORCH_CLOSE_DONE_WORKTREES`. Non-config env for tests/ops only: `ORCH_KIMI_BIN` (which
`kimi` executable the availability probe checks — authoritative when set, no `which`
fallback), `ORCH_KIMI_HOME` (default `~/.kimi-code`; where the credentials file is read),
`ORCH_KIMI_USAGE_URL` (full quota URL; must be `https:` unless the host is loopback),
`ORCH_OPENCODE_BIN` (which `opencode` executable and the DeepSeek credential probe are
checked). An invalid or missing config value never crashes
the gate; it falls back to the default for that field alone and reports the fallback as a
warning in the SessionStart banner. Config is re-read on every hook invocation (each is
its own Node process), so an edit takes effect on the very next tool call — no restart
needed.

## Supervision loop

The gate prints the exact command to start the heartbeat daemon the moment it sees a
worker start (built from this install's own `process.execPath` and `__dirname`, so it is
correct wherever the hooks were installed). The daemon polls Orca and exits the moment
something needs a decision — a worker changing state, a failed/stopped worker still
holding a terminal, a supervised terminal quiet longer than `heartbeat.idleSeconds`, a Codex session
that lost its app-server connection, a supervised worker making no real progress for its
stall threshold, an orphaned terminal, or a rate-limit marker. A background process exiting re-invokes the panel, so
its exit is the wake-up: the panel does not have to remember to poll, and it costs nothing
while everything is healthy.

A worker Orca reports successfully done (`workerState`/`dispatchStatus`
succeeded/completed, in either field — never when either field says
failed/stopped/cancelled, so a contradictory row never closes) no longer needs that
decision at all (binding operator decision, 2026-10-01): when its worktree is provably
clean (`git status --porcelain` empty) with nothing unpushed (`git rev-list @{u}..HEAD`
empty, or — with no upstream — HEAD contained in the resolved base branch), AND its agent
terminal has been quiet past the idle threshold (a done worker may still be mid-turn), the
daemon itself runs `orca orchestration worker-release --dispatch <id> --json` then
`orca terminal close --terminal <handle> --json` and logs an informational `WORKER CLOSED
<id> (done, terminal closed, worktree kept)` line without waking the panel. The worktree
path is resolved from the real worker-list row shape (`resource.worktreeId` /
`projection.workspace.id`, `<repoId>::<abs path>`) the same way a terminal's worktree
path is resolved; when it cannot be resolved at all, the row falls back to the
retain-or-release event below instead of being silently dropped. A release or
terminal-close call Orca answers `ok: false` to (or cannot answer at all) is never logged
or persisted as a success — the daemon reports `AUTO-CLOSE FAILED <id>` once and retries on
a bounded cooldown. It never touches the panel's own terminal (`ORCA_TERMINAL_HANDLE`); a
worker the panel explicitly `worker-retain`ed for reuse *after* it was already done stays
blocked. Orca's `resource.retainedReason` distinguishes an automatic retain from an
operator one, but `"user_requested"` is ambiguous by itself: the standard Kimi
readiness-recovery recipe (`orca terminal send` + `worker-retain`) runs that same retain
call on a worker that has not finished yet, and Orca records the identical
`"user_requested"` reason for it as for a deliberate "keep this finished worker open"
decision. The two are told apart by comparing this session's own gate-recorded
`retainedAt` (written by `worker-retain`) against the heartbeat's own first-seen-done
timestamp for that worker: `"identity_unproven"` (Orca's automatic readiness-timeout
retain) is always eligible; `"user_requested"` is eligible only when the gate recorded a
retain that ran strictly *before* the done transition (`retainedAt < doneAt`) — the
recovery recipe's shape; no gate record at all, or one that ran at or after done, fails
CLOSED exactly like `"user_takeover"` or any other/unknown reason; a failed, stopped, or
cancelled worker (those keep the retain-or-release event below); or one whose worktree is
dirty or unpushed — the latter wakes the panel once, on the transition into that state,
with `WORKER DONE BUT UNSAVED <id>` and keeps the terminal open; re-evaluation continues,
so a worktree later committed and pushed still closes without re-waking the panel for the
state it already reported.

IDLE, orphan and rate-limit terminal events are limited to this session's own fleet: the
run-scoped `worker-list` terminal handles plus bare terminals registered in this session's
gate state. Output from another session's terminal never wakes this panel. Context-only
worker rows marked `unsupervised`, and the panel's own `ORCA_TERMINAL_HANDLE`, are not
supervised as worker terminals.

If `worker-start` reports `stage: agent_readiness` / `lastError: timeout` but its terminal
is live, the gate prints the following recovery advice with any returned terminal/dispatch
handles. Do not create a replacement. Send the original spec into the existing terminal and
retain the dispatch explicitly:

```sh
orca terminal send --terminal <terminalHandle> --text "$(cat <spec-file>)" --enter
orca orchestration worker-retain --dispatch <dispatchId>
```

An explicitly retained row is supervised work, not a finished-terminal leak. The heartbeat
continues watching its terminal for IDLE even when it was already quiet before daemon
startup. Reported quiet stretches are persisted per session as `handle` + `lastOutputAt`, so
an unchanged terminal is not re-reported after every daemon restart; new output re-arms it.
While Orca still reports the retained worker running, `Stop` is allowed only while that
heartbeat is alive; without a live daemon the worker is refused as `workers-unwatched`.
A retained worker Orca reports done (`succeeded`, `failed`, or `completed`) is informational
and needs no heartbeat at `Stop`. Orca's automatic
`terminalState: retained` on a readiness failure does not get this exemption unless this
session recorded an explicit `worker-retain`. Release the worker when it is no longer needed.

Codex connection-lost/reconnect-failed messages are terminal even when the TUI keeps
repainting. The heartbeat reports that terminal as `WORKER STUCK` once per session,
persisted across daemon restarts; release and re-dispatch it because uncommitted work may
have been lost. A reported disconnected terminal skips its idle and orphan checks.

Terminal repaint activity alone is not progress. For every supervised worker terminal, the
heartbeat combines meaningful terminal text with a bounded fingerprint of that worker's
worktree (`HEAD`, `git status --porcelain`, full `git diff`, and changed/untracked file size
and mtime). Terminal text comes from a bounded `orca terminal read --terminal <handle> --screen` of
the rendered screen, only for this session's supervised terminals; a failed read reuses the
last good screen and only an initial failure falls back to the lossy list preview. A timed-out
git probe reuses the terminal's last good git sample. Spinner/moon frames,
`Thinking…` / elapsed `Working (...)` lines, rotating tips, context/token counters, and prompt chrome are
removed before terminal text is compared; Kimi's completed-tool count is retained as
progress. Rate-limit, disconnect, and Kimi usage-limit classification remains scoped to the
live list preview, preventing stale rendered scrollback from retriggering old failures. If
neither side changes for the applicable
`heartbeat.stallSeconds` / `heartbeat.stallSecondsByAgent` threshold, it emits:

```text
WORKER STALLED <dispatch|terminal> (<agent>, no file change or new output for Nm) - nudge it (terminal send "continue ..."), or stop it and re-dispatch the same brief to the other coder
```

This is informational and never auto-kills the worker. The handle, fingerprint, progress
time, and reported marker are persisted per session, so an unchanged episode is reported
once even across daemon restarts; a file or meaningful-output change re-arms it. A worker
already classified disconnected, rate-limited, or usage-exhausted retains that more
specific diagnosis and is not also reported stalled.
An active child-process status (`Waiting for background terminal` or `background terminal
running`) re-arms progress once and doubles the applicable threshold for that episode; it
still produces `WORKER STALLED` at 2x when no file or meaningful output changes. Worker rows
Orca already reports `succeeded`, `failed`, `stopped`, or `completed` are excluded.

A supervised terminal showing an interactive permission, approval, question, or selection
screen wakes the panel immediately with `WORKER WAITING FOR APPROVAL <dispatch|terminal>
(<agent>)`; it does not wait for IDLE or `stallSeconds`, and the heartbeat never selects an
answer. Prompt-shaped evidence includes permission-menu headers, question-shaped
Allow/Approve requests paired with UI structure, Codex `Would you like to run ...?` / `make
... edits?` questions with numbered choices or confirm/cancel help, opposing exact
Allow/Deny options, and `↑↓ navigate · Enter select` (optionally `· Esc cancel`). Ordinary
prose that merely mentions those words is not a match. Only normalized prompt-block lines
form the persisted signature, including the normalized question and command, so surrounding
tips, spinners, timers, and ordinary output do not create new episodes while consecutive
prompts for different commands remain distinct. It is re-armed when the prompt disappears.

For every live supervised Codex or Kimi worker, the heartbeat reuses the existing cached,
single-flight quota probe. It warns once at `handoverWarnMarginPercent` below that coder's
own handoff threshold, then emits a new persisted episode at the threshold or immediately
on a terminal usage-exhaustion signal:

```text
WORKER HANDOVER <dispatch|terminal> (<agent> <used>% >= <threshold>%) -> hand over to <other eligible coder, else Sonnet>
```

Selection is symmetric across every other eligible coder and excludes the current one:
Kimi -> Codex/DeepSeek -> Sonnet fallback, Codex -> Kimi/DeepSeek -> Sonnet fallback,
DeepSeek -> Codex/Kimi -> Sonnet fallback (DeepSeek's "quota" being its daily spend cap /
balance). The per-prompt gate reminder lists persisted workers that
still need handover. If responsive, tell the worker to stop after committing all WIP as
`wip: handover` and writing/committing `HANDOVER.md` with done, remaining, next step, and
verification instructions; wait up to about three minutes. Then `worker-stop` and
`worker-release` without deleting the worktree/branch. Dispatch the same brief in the same
worktree/branch, prefixed `Continue a task handed over from <agent>. Read HANDOVER.md and
git log first; do not redo finished steps.` For Sonnet, point the in-session Agent at that
worktree.

When the current coder is fully exhausted (100% or a usage-limit signal) and the other
external coder plus the in-session panel are unavailable, handover is impossible. With
`autoResumeAfterReset` enabled the heartbeat persists and emits once:

```text
WORKER PARKED <dispatch|terminal> (<agent> limit, resets <local time>) - will auto-resume
```

Reset time comes from Kimi `/usages`, Codex app-server `resetsAt`, or a Claude screen hint
(`resets 5pm`, `resets at 17:00`, `try again in 2h`, or `resets Oct 3, 5pm
(Asia/Saigon)`). An explicit IANA timezone is honored; otherwise local machine time is used.
The latest recent limit line remains authoritative until a newer prompt or active-turn line
appears. Unknown reset times are re-probed every 15 minutes without typing into a terminal
that still visibly shows the limit. Claude worker terminals use this same screen-based path,
not only the panel. One detached `orca-resume-scheduler.cjs` process is persisted per parked worker
(PID and reset time), deduped across heartbeat restarts, and does not depend on the panel
remaining alive. At reset plus 90 seconds it re-probes; once quota is below the coder's
handoff threshold it sends `Quota has reset. Continue the task from where you stopped;
check git status/log (and HANDOVER.md if present) first; do not redo finished steps.` and
verifies a new terminal turn. A Kimi screen in another permission mode is returned to Never
Ask first.

When Kimi places a long-idle session menu in front of the delivered resume message, the
scheduler must recognize the full `has been idle for` / `Compact and continue` / `Enter
select` shape, verify the current cursor, move to `Compact and continue` if necessary, press
Enter once, and verify that compaction or the resumed turn starts.

Attempts and the first-attempt time are persisted. A scheduler expires after 768 attempts or
eight days. A successfully delivered resume is never typed again when turn verification is
inconclusive. A send-attempt marker is persisted before terminal input, so a scheduler crash
is also recovered conservatively without retyping. The job becomes `resumed-unverified`, exits, and wakes the panel with `WORKER
RESUME UNVERIFIED ... inspect the terminal; do not retype`. A fresh Claude limit response to
the one allowed send is instead re-parked at its new reset. `expired` jobs likewise wake the
panel for a manual decision. Settled records and abandoned lock directories are cleaned after
one day. During that retention window, `resumed-unverified` and `expired` block automatic
re-parking of the same terminal for up to 24 hours so the report-only decision cannot turn
into an automatic retry. A pending job is not deleted merely because a quota probe recovers before its timer;
only a real handover or the worker leaving supervision cancels it.

With `autoResumePanel`, the exact `ORCA_TERMINAL_HANDLE` gets the analogous message `Quota
has reset - continue the orchestration from where you stopped (check worker-list, plans)`.
Schedulers recheck authorization and exclude unsupervised, released, and finished workers;
they never type into foreign terminals. In-session Agent
subagents die with the panel turn and cannot be resumed; the panel re-dispatches them after
it resumes. Prefer Orca workers for long-running resumable code tasks.

Manual polling counts as a heartbeat too: any `orca orchestration worker-list` /
`worker-read` / `task-list`, or `orca worktree ps`. If more than `heartbeat.idleSeconds`
seconds pass with a live worker and no poll of either kind, the gate says so on every turn.

When a worker is finished: retain it if it will be reused, otherwise release it. `Stop`
refuses to end a session with workers still live and unwatched.

**Close finished worker panels.** A released worker still leaves its Orca worktree behind.
After a worker finishes: read its result, then `orca orchestration worker-release
--dispatch <id>`; once its PR is merged or closed and the worktree is clean (`git status
--porcelain` empty, nothing unpushed), close the worktree too: `orca worktree rm
--worktree path:<path>`. Never remove a worktree with an open PR or unsaved work — sweep
periodically with `orca worktree ps --json` to find worktrees nobody closed.

The heartbeat daemon backs this up automatically: each tick it also reads `orca worktree
ps --json --limit 500`, then filters that machine-wide page by joining the real
`worktreeId` to this session's run-scoped worker rows (`resource.worktreeId` or
`projection.workspace.id`), worker-start replies, and tracked terminal rows; the absolute
path suffix after `::` is the compatibility fallback. Another session's worktree is never
summarized or emitted as a wake event. A page Orca itself marks `truncated` is never acted on — a partial
page can neither confirm nor rule out a transition — and flags a worktree that is not the
main worktree, not already archived, and that is:
  - **idle** — no live terminal at all, or `worktree ps`'s own aggregate `lastOutputAt`
    (one timestamp per worktree, not per terminal) already past `heartbeat.idleSeconds`;
  - **accepted** — a linked GitHub PR or GitLab MR already `merged`/`closed` (an open one
    never counts, whatever git alone might say), or — only when NEITHER is linked at all —
    a real `git merge-base --is-ancestor HEAD <base>` confirms HEAD is already contained in
    the worktree's own upstream default branch, resolved from `refs/remotes/origin/HEAD`
    (falling back to `origin/main` then `main`; `git fetch` is never run), AND (no-PR/MR
    path only) HEAD's own commit postdates the worktree's creation (the mtime of its `.git`
    file — a worktree freshly branched off that base with zero new commits is trivially an
    "ancestor" of it too, and must not be mistaken for done-but-open work) AND the
    worktree's per-worktree HEAD reflog (`git reflog show --format=%gs HEAD`) actually
    records a `commit` entry — a worktree merely rebased or fast-forwarded onto a base that itself
    advanced after the worktree was created can satisfy the commit-time check alone without
    the worktree ever recording a commit action, so both signals are required together;
  - **clean** — `git status --porcelain` empty and no commits the branch holds that its
    upstream does not (`git rev-list @{u}..HEAD` empty), or, lacking an upstream entirely,
    HEAD contained in that same resolved base branch.

Every git call here runs only for a worktree that already passed the idle check, each
bounded to ~3s, and any git failure or uncertainty (unreadable repo, a timeout, no
resolvable base, an empty reflog) means "not a candidate" — never a guess. A worktree
already reported once is skipped entirely on later ticks (its git calls are never re-run),
and one tick's whole git-evaluating pass is capped at ~10s (`ORCH_GIT_BUDGET_MS` overrides
it for tests) with the heartbeat's own liveness file refreshed between rows, so a fleet with
many worktrees can never starve that file into looking dead — EXCEPT the very first
(seeding) pass, which never truncates on that budget: a row the seeding pass could not
reach in time used to fall through to a later tick's steady-state branch and fire as a
brand-new wake event, even though it had been part of the original backlog all along.
What happens next depends on `closeDoneWorktrees` (`remove`|`remind`|`off`, default
`remind` — read the live `~/.claude/orchestration.config.json` for this installation's
actual value rather than assuming it). In `remove` mode, and only when the worktree
currently holds no live terminal at all (a live-but-quiet terminal — e.g. one sitting on
an approval prompt — falls back to the `remind` behavior below instead of an irreversible
removal), the daemon runs `orca worktree rm --worktree path:<path> --json` itself and logs
an informational `WORKTREE REMOVED <name> (<reason>) — <path>` line — no panel decision is
needed, and the same never-remove guards above (open PR/MR, uncommitted or unpushed work,
the main worktree, another session's worktree) still apply before anything is removed. A
failed `rm` (Orca answers `ok: false`, or cannot answer at all) is never logged or
persisted as removed: the daemon reports `WORKTREE RM FAILED <path>` once, falls back to
the `remind` event in the same tick, and retries on a bounded cooldown rather than every
tick. In `remind`
mode the event line, `DONE worktree <name> (<reason>, no live terminal|quiet terminal(s)) — ...
orca worktree rm --worktree 'path:<path>'` (control characters stripped, the path
single-quote-escaped), names which of the above fired and which idle leg actually applied,
and never removes anything itself — only
the panel decides, after checking `git status` and unpushed commits, same as the manual
sweep above. Only a worktree that *becomes* done-but-open after the daemon's own
session-scoped record of what it has already reported produces a line; backlog already
done-but-open at a session's first-ever daemon start is listed once in a startup summary
instead (in `remove` mode, removed right away). A LATER restart within the same
session is judged against that same persisted
record: anything newly done-but-open — it became so while no daemon in this session was
watching — is reported as a real wake event, not silently re-absorbed as if it had always
been backlog. Disable it with `closeDoneWorktrees: "off"` in the config, or
`ORCH_CLOSE_DONE_WORKTREES` set to `0`/`false`/`off` for one process (`1`/`true` forces
remind mode; `remove` forces remove mode; any other value defers to the config).

## Parallel Codex workers and file ownership

**Section 0 fixes (pre-existing bugs).** Two bugs in the worker-tracking state predate
this feature and are fixed as part of it: (1) a single `worker-start` reply can name a
dispatch id (`ctx_*`), a task id (`task_*`) and a terminal handle (`term_*`) for the SAME
worker — every tracked entry now carries a `group` (shared by every id from one reply) and
a `kind` (`'worker'` or `'terminal'`), so a worker *count* counts distinct groups, never
distinct keys; a legacy entry with no `group` is its own group. (2)
`worker-release --dispatch <id> --json` used to be matched by taking the command line's
*last shell token* — `--json` — which matched no worker and fell back to settling every
live worker in the session. The release matcher (`worker-stop`/`worker-release`/
`worker-abandon`/`terminal close`) now reads the specific orca invocation's own parsed
`--dispatch`/positional argument; an unrecognised label settles nothing and prints a hint.

A related gap closed in the same round: a real Orca reply is a nested envelope
(`{"id","ok","result":{...,"mutation":{...}}}`), and a Bash command can chain more than one
`worker-start`/`task-create` in one call (`task-create ... && worker-start --task "$ID"`,
or two `worker-start`s back to back). Each invocation's own reply is now matched
positionally (one JSON reply line per dispatch invocation, in command order, skipping
anything shaped like a `worker-list` reply) rather than scanning the whole command's
concatenated stdout as a single blob — otherwise two chained dispatches would merge into
one group, and releasing one would silently settle the other too.

**`max-parallel-codex-workers`.** Every real `orchestration worker-start` invocation with
agent Codex (explicit `--agent codex`, or `--terminal <h>` with no `--agent` when `<h>`
does not belong to a tracked non-Codex group) counts against `maxParallelCodexWorkers`. The
count is this session's own state, reconciled against `orca orchestration worker-list
--json` (5s timeout) only once the local count is at or over the cap — a healthy session
under the cap never pays that round trip, and that round trip itself runs OUTSIDE the state
lock (acquired again only to recheck and reserve afterward), so an at-cap session never
blocks every other concurrent hook process for its full duration. A worker Orca reports
done (`workerState`/`dispatchStatus` succeeded/failed/stopped/cancelled/completed) but
still holding its terminal (`terminalState` not `released`) is cap-exempt — it frees capacity
without being settled, since settling it here would make the still-unreleased terminal
invisible to the `workers-unreconciled` Stop gate. A race between two parallel `Bash` calls
is closed by a file lock around "reload the state fresh from disk under the lock, then
count, then reserve, then save" — every process that races this section reads the
PREVIOUS winner's just-saved reservation, not a stale pre-lock snapshot, so the losing
call sees the winner's reservation and is refused before either registers a real worker,
and one process's save can never silently overwrite another's. A byte-identical command is
only treated as a retry that may replace its unresolved same-hash reservation once that
reservation is at least two seconds old; a fresh one can be a second call in the same
parallel batch and must still see the first reservation. A same-command reservation with no
numeric timestamp is treated as old and replaced. When a fresh identical retry conflicts
with its own reservation, the refusal explicitly says to retry in a few seconds.

**`max-parallel-kimi-workers` / `max-parallel-deepseek-workers`.** The same per-session
group cap and cap-exempt / reconcile / retry-replacement rules apply to Kimi
(`maxParallelKimiWorkers`) and DeepSeek (`maxParallelDeepseekWorkers`, the `opencode`
agent), each counted independently of Codex.

**`max-parallel-agents`.** A MACHINE-wide budget, on top of (never instead of) the
Codex-only cap above: the resource is this machine's cores, not any one session's own
concurrency, so the count sums every recent session's own state file under the shared
`~/.claude/orchestrator-gate/` directory, not just the caller's own — subject to two
liveness filters (see "Known limits" below): a 6h absolute age ceiling, and (for every
OTHER session; the caller's own always counts) a recent-activity check. Two kinds of live
unit are counted:
  - every live Orca worker GROUP of any agent (codex, claude, ...) — never a `capExempt`
    one, same reasoning as the Codex-only cap — plus its still-unresolved worker-start
    reservation (`newSlot: true`, set only for a genuinely new dispatch — never a
    `task-create`, which launches nothing by itself, and never a `--terminal`/`--retry-of`
    replacement of an already-tracked live group);
  - every live in-session `Agent`/`Task` dispatch the main panel has made, registered as
    `s.agents[toolUseId] = { ts, background, type, model }` (not only code briefs needing
    `Owns:`) — even one the gate would otherwise be disabled for still gets registered, so a
    later re-enable never silently missed accounting for it.
Fires at `PreToolUse` of every `Agent`/`Task` dispatch, every real `orchestration
worker-start`, and every real `terminal create` (a bare `terminal create` carries neither an
ownership-relevant workspace nor a resolved agent, so it holds its own small, separately-
keyed reservation — `term:<toolUseId>#<idx>` — that only needs to survive the PreToolUse ->
PostToolUse gap, since a successful create is already registered as a real worker by the
existing `terminal create` reply-scanning path). For an `Agent`/`Task` dispatch, the capacity
check runs TWICE: an early, read-only pass before the routing/ownership gates below (so an
already-over-budget dispatch gets this refusal rather than a confusing routing one), and the
actual registration only at the very END, after every one of those later gates has passed —
registering any earlier would leave a dispatch refused by a LATER gate holding a slot for up
to its 120-minute TTL, since a refused dispatch never reaches `PostToolUse` to release it.
Two backstops sweep out any foreground (`background: false`) registration that still
somehow survives: every genuine operator `UserPromptSubmit` (never an injected
notification/reminder), and every `Stop`.

At capacity, before refusing, the gate reconciles the CALLER's OWN session's Orca-tracked
workers against a fresh `orca orchestration worker-list --json` (the same out-of-lock-fetch
+ locked-reapply pattern the Codex-only cap's own at-cap reconcile uses) and re-counts — a
worker this session's bookkeeping still shows live, but that Orca has already confirmed
released or done, would otherwise refuse a dispatch that could actually proceed right now.
This runs for the `Agent`/`Task`, `worker-start`, and `terminal create` paths alike. If the
state-file lock itself cannot be acquired at all (contended by many concurrent dispatches —
exactly the condition this cap exists to catch), the check refuses with a distinct,
transient "retry the same dispatch" reason rather than evaluating capacity unlocked, which
would let every contending process fall through uncounted and all be admitted at once — but
ONLY once the gate has confirmed the cap is actually finite and enabled: a disabled gate or
an unlimited (`maxParallelAgents: 0`) cap returns allow BEFORE ever inspecting `locked`, on
every one of these paths, so a `.lock` some other process happens to be holding (however
long) can never masquerade as "at capacity" for a cap that isn't capping anything. These
same paths also acquire the lock with a longer timeout than file-lock's own `staleMs`
default (10s) specifically so a merely-abandoned lock (not a genuinely live holder) is
outlived and reclaimed instead of refused: the library's ordinary 2s acquire timeout used to
give up well before a dead holder's lock ever looked stale, refusing for roughly
`staleMs - timeoutMs` (~8s) after every such lock was created. A non-`EEXIST` filesystem
failure is not contention and degrades to allow rather than producing that refusal.
When both caps are unlimited or disabled, `worker-start` uses the ordinary 2-second lock
timeout instead. When a finite cap's long initial acquisition cannot obtain a genuinely
held lock, the dispatch is refused immediately after that one attempt rather than paying a
second long wait in the reconcile path.

The check-and-reserve critical section runs under the SAME shared file lock every other
reservation-taking gate here uses, and always reloads state fresh from disk once the lock is
held, exactly like the Codex-only cap — the whole point being genuine cross-SESSION mutual
exclusion, not merely cross-Bash-call. The refusal names the live total, the limit, and up
to 8 of the oldest live units labeled `<sid8>:<id>` (an 8-character session-id prefix, so two
sessions' ids can never be confused in the same list): `<n>/<N> parallel units live on this
machine (<cores> cores x <fraction>%): <k> Orca workers, <m> subagents [<sid8>:<id>, ...]` —
the `(<cores> cores x <fraction>%)` part reads `(explicit limit)` instead whenever the limit
came from an operator-set `maxParallelAgents`/`ORCH_MAX_PARALLEL_AGENTS` rather than that
derivation, since an explicit number never went through the cores/fraction math at all.
Recovery is framed as the OPERATOR's call, never an invitation for the model to raise the
limit itself: release a specific claim (`--release-claims <id>|all`, this session only — see
below), delete a dead session's state file under the real, `ORCH_STATE_DIR`-aware state dir
(never a hardcoded `~/.claude/orchestrator-gate/`), or disable the gate (`disabledGates:
["max-parallel-agents"]`).

A registered `Agent`/`Task` dispatch releases exactly like an ownership claim does: a
foreground dispatch frees it at the matching `PostToolUse`; a background
(`run_in_background: true`) dispatch survives that same-turn launch-return event and is
instead released by a matching `<task-notification><tool-use-id>`, a fixed 120-minute TTL
(distinct from the configurable `ownershipClaimTtlMinutes` — this is "is the dispatch still
running at all," not a file-ownership lock), or the operator's `--release-claims <id>` /
`--release-claims all`. `--release-claims all` clears every kind at once (`agentClaims`,
`reservations`, and this registry); `--release-claims <id>` for one specific id releases
whichever of the three that same id actually holds — a single toolUseId can carry an
`agentClaims` entry AND an `agents` registration AND an indexed reservation at once (e.g. an
in-session code dispatch with an `Owns:` claim), and all of them are released together, not
just whichever one an id happened to match first.

**`code-brief-needs-owns` / `ownership-overlap`.** The same code briefs that already need a
verify command (an Orca `--spec`, or an in-session `Agent`/`Task` exec dispatch) — when
running in a *shared* workspace, not an isolated worktree/Agent — must also declare
`Owns: <repo-relative paths, globs ok>` or `Owns: n/a <reason>`, **on its own line** (a
markdown-bold `**Owns:**` or a mid-sentence `Owns:` is not recognized — the refusal names
this explicitly rather than guessing at prose). A claim that overlaps another live claim in
the same workspace (`repoRoot|--worktree value`, or `repoRoot|current` with no
`--worktree`, and `--worktree active`/`current` normalize onto that same "current" key
rather than becoming their own workspace) is refused, naming the holder and its age. The
requirement is enforced at `worker-start`, where the workspace is actually known — a
`task-create --spec` with no `Owns:` is never refused by itself, since it doesn't yet know
whether its eventual `worker-start` will be isolated; `task-create`'s `Owns:` (or its
absence) is recorded and inherited by a later `worker-start --task <id>` that supplies no
`--spec` of its own, and THAT is where a missing claim is finally refused if the dispatch
turns out non-isolated. An unresolvable `--task` value (an unexpanded shell variable) is
allowed with an advisory note, UNLESS the same command line contains exactly one
`task-create`, in which case its claim resolves the reference directly (the one-liner
`ID=$(orca orchestration task-create ...) && orca orchestration worker-start --task "$ID"`
pattern). Isolated work (`--worktree new-child`/`new-top-level`, or Agent
`isolation:"worktree"`) needs no `Owns:` at all and never conflicts with anything, since
each isolated dispatch gets a unique workspace key. A disabled `code-brief-needs-owns` or
`ownership-overlap` only skips THAT check — the parallel-Codex cap check and the
dispatch's own reservation still run for the same invocation, never silently skipped
alongside it.

A claim releases when its holder does: a settled worker group frees its claim; a
foreground `Agent`/`Task` dispatch frees it at the matching `PostToolUse`; a background
dispatch is released best-effort by a `<task-notification>` naming its id, by
`ownershipClaimTtlMinutes` if nothing else ever does, or by the operator's
`--release-claims <id>` / `--release-claims all`.

**Known limits.** Ownership is *declared*, not observed — nothing checks that a worker
actually only touched the files it claimed. Workers started by a subagent (not the main
panel) are not tracked or capped, the same boundary every other gate here respects — and,
specific to `max-parallel-agents`, a subagent that itself spawns further subagents is
invisible to the budget: only the main panel's own `Agent`/`Task` dispatches are ever
registered, so nested fan-out from inside a subagent is not charged against it. Also
specific to `max-parallel-agents` (operator decision): another session's units count toward
the shared budget only while there is a recent liveness signal for it — its heartbeat daemon
alive, OR its state file modified within the last 30 minutes — on top of the existing 6h
absolute staleness cutoff every cross-session read here already applies; the caller's own
session always counts regardless. A session that is genuinely still working, but whose
heartbeat daemon is not running and has not touched its state file in 30 minutes, will have
its units silently dropped from the count — a deliberate trade-off (a session presumed dead
must not permanently eat into a live budget) accepted knowing it can occasionally
under-count a real, if quiet, session.

## Codex rate limits

When a worker's output matches a rate-limit signal (`rate limit`, `429`, `quota
exceeded`, `usage limit`, `too many requests`, `retry-after`, `overloaded_error`), the
gate marks every live worker as backing off for ~120s. The correct response is to wait,
then retry the *same* dispatch:

```
orca orchestration worker-start --retry-of <dispatchId> ...
```

Re-dispatching immediately deepens the limit; starting a *replacement* worker doubles the
load that caused it.

Kimi has one stronger, terminal signal: an error-shaped line (never plain prose, and only
on a terminal whose tracked agent is `kimi`) reading "You've reached your usage limit for
this billing cycle" marks Kimi **exhausted for the billing cycle** — the heartbeat reports
it once per terminal per session (persisted, so a daemon restart does not re-report or
re-mark) and records an exhaustion marker (`coder-exhausted.json`, until the reported reset
or 6 hours). Routing then excludes Kimi until the marker expires or a fresh quota reading
shows it back below `kimiHandoffUsedPercent`. Do not retry that worker; route new code to
Codex (or the in-session code model if Codex is also out).

## State

Per session, at `<ORCH_STATE_DIR>/<session_id>.json`:

```json
{ "session_id": "...", "created": "<ISO-8601>", "bypass": false,
  "bypassSince": null, "execAgent": null, "execAgentSince": null,
  "workers": { "<label>": { "role": "<agent>-exec", "started": 0,
                             "status": "live|settled", "last_seen": 0,
                             "rate_limited_until": 0,
                             "group": "ctx_x", "kind": "worker|terminal", "agent": "codex",
                             "owns": ["src/api/**"], "ws": "<repoRoot>|current",
                             "capExempt": false } },
  "reservations": { "<toolUseId>#<idx>": { "ts": 0, "agent": "codex",
                                            "owns": ["src/api/**"], "ws": "<repoRoot>|current",
                                            "codexSlot": true, "kimiSlot": false,
                                            "deepseekSlot": false, "newSlot": true } },
  "agentClaims": { "<toolUseId>": { "owns": ["src/api/**"], "ws": "<repoRoot>|current", "ts": 0,
                                     "background": false } },
  "tasks": { "<taskId>": { "owns": ["src/api/**"], "ws": "<repoRoot>|current" } },
  "lastCodeAuthor": "kimi|codex|deepseek|sonnet|null", "lastCodeAuthorAt": 0,
  "last_heartbeat": 0, "rate_limit_hits": 0 }
```

`execAgent` is one of `null` (automatic, by coder pool), `"codex"`, `"codex:<model>"`,
`"kimi"`, `"kimi:<model>"`, `"deepseek"`, `"deepseek:<model>"`, or `"claude:<alias>"`. A Kimi
or DeepSeek model suffix is a persisted
preference shown in reminders; Orca cannot pin either, so the worker still launches without
`--model`. Any other persisted value is reset to `null` and reported once. The
`*Since` fields contain ISO-8601 timestamps only while their corresponding override is
active.

`lastCodeAuthor` records who wrote this session's pending code — the last external coder
group (opencode counts as `deepseek`), the `sonnet` code model for an in-session code
dispatch, or `null` before any code work — and `lastCodeAuthorAt` is its epoch-ms ordering
stamp, so a worker group that settles after a newer dispatch started never clobbers the
newer author. A review / verify dispatch is routed by this value (`models.reviewByCoder`);
a `null` author allows either the review or the code model.

Machine-wide coder routing state lives at `<ORCH_STATE_DIR>/coder-route-state.json` as
`{ "lastCoder": "codex|kimi|deepseek", "updatedAt": 0 }`. The gate writes `lastCoder`
atomically
under the shared state lock only when a `worker-start` reply registers a real coder worker.
Automatic routing uses it after the machine-wide live-count and per-coder headroom
ties, so equal peers alternate without trusting free-text command output.

`group`/`kind`/`agent`/`owns`/`ws` on a worker entry, `reservations`, `agentClaims` and
`tasks` are the parallel-Codex-worker cap and file-ownership bookkeeping (see "Parallel
Codex workers and file ownership" above). `reservations` and `agentClaims` are both
transient — a reservation is consumed by the matching `PostToolUse` (dropped outright on a
failed tool call or an Orca `"ok":false` reply, or expires after 10 minutes if nothing ever
resolves it). A genuine `UserPromptSubmit` does not sweep Bash reservations because the
tool call may still be in flight; `Stop`, explicit release, reply consumption, and TTL are
the safe cleanup paths. An `agentClaims` entry is removed at release, whichever of the paths
above fires first. A worker Orca reports done but still holding its terminal is marked
`capExempt: true` — it no longer counts toward `maxParallelCodexWorkers`, but stays `live`
so the Stop gate still catches it as an unreleased resource. A reservation's `codexSlot` /
`kimiSlot` / `deepseekSlot` flags record which per-coder cap (`maxParallelCodexWorkers` /
`maxParallelKimiWorkers` / `maxParallelDeepseekWorkers`) it holds capacity against;
`newSlot` is set for any agent's
genuinely new dispatch and counts toward the machine-wide `max-parallel-agents` budget.
Cross-session, machine-wide files in the same state directory: `codex-quota-live.json`,
`kimi-quota-live.json`, `deepseek-quota-live.json` (cached live quota readings, never a token
or API key),
`coder-availability.json` (cached per-coder usable/unusable probe), `coder-exhausted.json`
(billing-cycle exhaustion markers per coder, each with `at`/`until`/`reason`). An `agentClaims` entry from a
`run_in_background: true` dispatch is marked `background: true` and is deliberately NOT
released at its own launch `PostToolUse` (that event fires as soon as the dispatch is
sent, long before the background work finishes) — only a matching
`<task-notification><tool-use-id>`, the TTL, or `--release-claims` frees it. Every state
mutation above happens after the state file's `.lock` directory is held and the state is
re-read fresh from disk, never against the snapshot loaded before the lock — two hook
processes racing the same session id can otherwise silently drop each other's write.

## Escape hatches

- `ORCHESTRATOR_GATE=off` in the environment disables every gate for that session,
  regardless of config.
- `--no-orchestrate` in an operator prompt disables the gates for the session;
  `--orchestrate` turns them back on. If both appear, the last flag wins. Harness-injected
  turns (task notifications, cross-session messages, system reminders) and compaction
  summaries never count as the operator's own prompt, so quoted flags cannot toggle
  bypass or execution routing. While bypass is active, every prompt and the `SessionStart`
  banner show when it began and name `--orchestrate` as the recovery command.
- `--exec-sonnet` / `--exec-codex` / `--exec-kimi` / `--exec-auto` and `--code-model <value>` toggle only
  execution routing, honestly — narrower than a full bypass.
- `--release-claims <toolUseId>` / `--release-claims all` manually frees one or every
  tracked `Owns:` claim OR `max-parallel-agents` registration — the deliberate manual
  override alongside the automatic release paths (matching `PostToolUse`, a
  `<task-notification>`, `ownershipClaimTtlMinutes` / the fixed 120-minute agent-registry
  TTL). It clears `agentClaims`, `agents`, and any matching Bash-dispatch `reservations`
  (by exact id or by `<id>#<idx>` prefix), so a stuck reservation or registration can be
  freed the same way a stuck `agentClaims` entry can.
- `maxParallelCodexWorkers: 0` (config) or `ORCH_MAX_PARALLEL_CODEX_WORKERS=0` (env, one
  process) makes the parallel-Codex-worker cap unlimited.
- `maxParallelKimiWorkers: 0` (config) or `ORCH_MAX_PARALLEL_KIMI_WORKERS=0` (env, one
  process) makes the parallel-Kimi-worker cap unlimited.
- `maxParallelDeepseekWorkers: 0` (config) or `ORCH_MAX_PARALLEL_DEEPSEEK_WORKERS=0` (env,
  one process) makes the parallel-DeepSeek-worker cap unlimited.
- `maxParallelAgents: 0` (config) or `ORCH_MAX_PARALLEL_AGENTS=0` (env, one process) makes
  the machine-wide `max-parallel-agents` budget unlimited.

Only the operator invokes these from the main panel's own prompt.

## Failure behavior

Malformed hook input, a missing state file, an unreadable config, or a crash inside the
gate all degrade to **allow** — the gate must never be the reason a session is stuck.
Refusals are appended to `<ORCH_STATE_DIR>/violations.log`
(`timestamp, session, gate, reason`).

## Tests

```
npm test                                             # every suite below, in order
node tests/test-orchestrator-gate.cjs                # classifiers, pure functions, config
node tests/test-orchestrator-gate-e2e.cjs            # real payloads through the hook
node tests/test-concurrency.cjs                      # genuine multi-process races (caps + quota probe)
node tests/test-install.cjs                          # CLI safety + foreign-gate handling
node tests/test-coder-availability.cjs               # per-coder usability probes (no Orca/Codex/Kimi/DeepSeek)
node tests/test-kimi-signals-caps.cjs                # Kimi signals + caps
node tests/test-gate-kimi-wiring.cjs                 # gate wiring for coder dispatches
node tests/test-worker-stall.cjs                     # heartbeat stall/liveness
node tests/test-kimi-exhausted-misread.cjs           # Kimi exhaustion false-positive guards
node tests/test-released-groups.cjs                  # released-group accounting
```

Every false positive found in real use became a permanent case in these suites: a `>`
inside a heredoc body, a `>` inside a quoted string, a compound line whose scratch cleanup
was poisoned by an unrelated echo, a fallback flag that never expired, an `orca` invocation
hidden inside `$( )`/backticks/an `env`/`exec`/`nohup` wrapper, and an auto-routed banner
that once printed the model name as `"undefined"`. A gate that refuses legitimate work
gets switched off, so its false-positive rate is as load-bearing as what it catches.
