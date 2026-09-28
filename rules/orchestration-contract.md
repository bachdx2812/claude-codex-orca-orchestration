# Orchestration Contract (enforced)

This file documents the workflow `hooks/orchestrator-gate.cjs` enforces on every session,
generated from the source of truth: the gate's code plus
`~/.claude/orchestration.config.json`. Every noun below (model aliases, the Codex handoff
threshold, the reply language) is a config value, not a literal baked into this file — if
you change the config, re-read the SessionStart banner rather than this file for the
exact current numbers - it now names both the alias and the exact id, e.g.
`model "opus" (claude-opus-5-5)`.

**Shipped versions** (the example config; override in `~/.claude/orchestration.config.json`):
review/red-team/verify on **Opus 5.5** (`claude-opus-5-5`), escalation on **Fable 5.1**
(`claude-fable-5-1`), Codex worker dispatches on **`gpt-5.6-sol`**.

## The contract

1. **The main panel orchestrates and nothing else.** It takes the operator's input,
   dispatches work, and supervises it. It does not implement. Edit/Write/MultiEdit/
   NotebookEdit and mutating shell commands are refused outside `.claude/`, `plans/`,
   `docs/`, scratch, and a temp dir.
2. **Planning, review and verification run on the configured review model**
   (`models.review.alias`, default `opus`), as an in-session subagent (`Agent` with
   `model: "<review alias>"`). The configured escalation model
   (`models.escalation.alias`, default `fable`) is reserved for work the review model
   could not do, even at higher effort — a dispatch to it must say so.
3. **Code goes to Codex in an Orca worker first**, and to the configured in-session code
   model (`models.code.alias`, default `sonnet`) once Codex has used
   `codexHandoffUsedPercent` (default 40) of its tightest rate-limit window. The operator
   can pick the coding model directly with `--code-model <alias|codex|codex:<model>|auto>`,
   or use the `--exec-sonnet` / `--exec-codex` / `--exec-auto` shortcuts.
4. **Light lookups** (find/locate code, read logs or test output, explore) are advised
   toward the configured lookup model (`models.lookup.alias`, default `haiku`) — this is
   advisory only and never blocks.
5. **Every code brief names a verify command** (or `verify: n/a <reason>`) — a Codex
   `--spec` or an in-session code prompt whose intent reads as implementation work must
   let the coder check its own output before reporting done.
6. **A continuous heartbeat daemon supervises live Orca workers.** `Stop` refuses to end
   the session while a worker is live and unwatched.
7. **Codex rate-limits under parallel load.** On a rate-limit signal the correct response
   is to back off and retry the *same* dispatch (`worker-start --retry-of <id>`), never to
   re-dispatch immediately or start a replacement.
8. **No more than `maxParallelCodexWorkers` (default 3) live Codex workers at once.** A
   `worker-start` that would exceed it is refused; wait for one to finish and release it,
   reuse its terminal (`--terminal <handle>`), or retry it (`--retry-of <id>`) — neither
   replaces an existing group, so neither counts as a new dispatch against the cap.
9. **A code brief in a shared workspace declares the files it will touch.** `Owns: <paths>`
   (repo-relative, globs ok) or `Owns: n/a <reason>`, on its own line, for every code
   brief that already needs a verify command (an Orca `--spec` or an in-session code
   dispatch) — unless the work is isolated (`--worktree new-child`/`new-top-level`, or
   Agent `isolation:"worktree"`), which needs no `Owns:` at all. A claim that overlaps
   another live claim in the same workspace is refused.

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
--code-model auto          # back to automatic routing (same as --exec-auto)
```

The last matching flag in a prompt wins. An invalid value (unknown word, or anything
outside `[a-z0-9._:-]`, so a slash or space is never silently truncated) is ignored with a
notice; nothing changes. Picking a Claude alias for code work exempts that dispatch from
the review-model/escalation-model scope gates for code specifically — the operator asked
for it by name, so the gate does not then refuse it for being the "wrong" model doing code.

**With a `codex` (or `codex:<model>`) override while the Orca-unreachable fallback is
active**, in-session code still runs on the configured code model, not Codex — the
fallback exists precisely because Orca cannot be reached, so it cannot honor "use Codex"
either, regardless of what the operator's standing override says.

## No Orca / no Codex

Codex is the deliberately-preferred default, so **only a missing binary triggers the
fallback — never merely an unknown quota reading.** A fresh Codex install that has not
completed a first turn yet has no `rate_limits` event to read (see `codexRemaining()` in
`hooks/lib/exec-route-by-quota.cjs`); that unknown reading is not evidence Codex is
unusable, and routing still prefers it. If `orca` or `codex` itself is not on `PATH`,
though, Codex genuinely cannot be dispatched to at all, and with
`execFallbackWhenCodexUnavailable` at `"sonnet"` (the default) automatic routing falls
back to the configured code model instead. Set `execFallbackWhenCodexUnavailable` to
`null` to disable this and always prefer Codex regardless of either binary's presence.

The gate checks `orca`/`codex` reachability itself (an absolute `ORCA_BIN`/`CODEX_BIN`
path is checked with a file-exists test; the bare default name via `which`/`where`) — no
per-invocation cost beyond those two lookups, and never a live `worker-list` call just to
decide routing.

Independent of that automatic fallback, the operator can always route explicitly:

- `--exec-sonnet` (or `--code-model <code alias>`): an explicit, session-scoped operator
  preference. It does not claim Orca is down.
- Declaring the Orca fallback: `date -u +%Y-%m-%dT%H:%M:%SZ >
  ~/.claude/orchestrator-gate/orca-unavailable`. This *does* claim Orca is unreachable,
  and expires after 15 minutes on purpose — a permanent flag would silently disable the
  Codex-in-Orca rule forever after one transient failure.

`node install.mjs --check` reports whether `orca` and `codex` are on `PATH`, whether Codex
looks logged in, and the effective config (including `execFallbackWhenCodexUnavailable`)
as the installed hooks would actually read it.

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
    "code": { "alias": "sonnet", "id": null },
    "lookup": { "alias": "haiku", "id": null },
    "codex": { "alias": null, "id": "gpt-5.6-sol" }
  },
  "agents": { "escalation": [], "lookup": ["Explore"] },
  "codexHandoffUsedPercent": 40,
  "execFallbackWhenCodexUnavailable": "sonnet",
  "heartbeat": { "intervalSeconds": 20, "idleSeconds": 60, "maxSeconds": 3600 },
  "maxParallelCodexWorkers": 3,
  "ownershipClaimTtlMinutes": 120,
  "disabledGates": []
}
```

- `replyLanguage`: e.g. `"Vietnamese"`; `null` (default) omits the language sentence from
  every reminder entirely — nothing is hard-coded to a specific language.
- `models.<role>.alias`: the Claude Code model alias the gate matches against and
  instructs dispatches to use. `models.<role>.id`: the exact model ID, used only in banner
  text and in `orca ... --model <id>` examples — the gate itself matches on alias.
- `agents.escalation` / `agents.lookup`: agent names (by `subagent_type`) that count as
  that role even without a matching `model`. Both default to a minimal, non-operator-
  specific set (`agents.lookup` ships with `["Explore"]`; `agents.escalation` ships
  empty) — add your own team's advisory-agent names here rather than expecting the gate
  to guess them.
- `codexHandoffUsedPercent`: integer 0-100. Sonnet-or-whatever-your-code-model-is takes
  over once Codex has used this much of its tightest quota window. Overridable for one
  process with `ORCH_CODEX_HANDOFF_USED`.
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
- `ownershipClaimTtlMinutes`: integer 1-10080, default 120. How long a background
  in-session Agent's `Owns:` claim survives without an explicit release before it
  auto-expires. Overridable for one process with `ORCH_CLAIM_TTL_MINUTES`.

Env overrides: `ORCH_CONFIG_PATH` (which file to read), `ORCH_STATE_DIR` (where session
state, the violations log and heartbeat liveness files live — default
`~/.claude/orchestrator-gate/`), `ORCA_BIN` (which `orca` executable to invoke — mainly
for tests), `ORCH_CODEX_HANDOFF_USED`. An invalid or missing config value never crashes
the gate; it falls back to the default for that field alone and reports the fallback as a
warning in the SessionStart banner. Config is re-read on every hook invocation (each is
its own Node process), so an edit takes effect on the very next tool call — no restart
needed.

## Supervision loop

The gate prints the exact command to start the heartbeat daemon the moment it sees a
worker start (built from this install's own `process.execPath` and `__dirname`, so it is
correct wherever the hooks were installed). The daemon polls Orca and exits the moment
something needs a decision — a worker changing state, a finished worker still holding a
terminal, a supervised terminal quiet longer than `heartbeat.idleSeconds`, an orphaned
terminal, or a rate-limit marker. A background process exiting re-invokes the panel, so
its exit is the wake-up: the panel does not have to remember to poll, and it costs nothing
while everything is healthy.

Manual polling counts as a heartbeat too: any `orca orchestration worker-list` /
`worker-read` / `task-list`, or `orca worktree ps`. If more than `heartbeat.idleSeconds`
seconds pass with a live worker and no poll of either kind, the gate says so on every turn.

When a worker is finished: retain it if it will be reused, otherwise release it. `Stop`
refuses to end a session with workers still live and unwatched.

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

**`max-parallel-codex-workers`.** Every real `orchestration worker-start` invocation with
agent Codex (explicit `--agent codex`, or `--terminal <h>` with no `--agent` when `<h>`
does not belong to a tracked non-Codex group) counts against `maxParallelCodexWorkers`. The
count is this session's own state, reconciled against `orca orchestration worker-list
--json` (5s timeout) only once the local count is at or over the cap — a healthy session
under the cap never pays that round trip. A race between two parallel `Bash` calls is
closed by a short-lived file lock around "count, then reserve": the losing call sees the
winner's reservation and is refused before either registers a real worker.

**`code-brief-needs-owns` / `ownership-overlap`.** The same code briefs that already need a
verify command (an Orca `--spec`, or an in-session `Agent`/`Task` exec dispatch) — when
running in a *shared* workspace, not an isolated worktree/Agent — must also declare
`Owns: <repo-relative paths, globs ok>` or `Owns: n/a <reason>`, **on its own line**. A
claim that overlaps another live claim in the same workspace (`repoRoot|--worktree value`,
or `repoRoot|current` with no `--worktree`) is refused, naming the holder and its age. A
`task-create --spec`'s `Owns:` is inherited by a later `worker-start --task <id>` that
supplies no `--spec` of its own; an unresolvable `--task` value (an unexpanded shell
variable) is allowed with an advisory note rather than refused. Isolated work
(`--worktree new-child`/`new-top-level`, or Agent `isolation:"worktree"`) needs no `Owns:`
at all and never conflicts with anything, since each isolated dispatch gets a unique
workspace key.

A claim releases when its holder does: a settled worker group frees its claim; a
foreground `Agent`/`Task` dispatch frees it at the matching `PostToolUse`; a background
dispatch is released best-effort by a `<task-notification>` naming its id, by
`ownershipClaimTtlMinutes` if nothing else ever does, or by the operator's
`--release-claims <id>` / `--release-claims all`.

**Known limits.** Ownership is *declared*, not observed — nothing checks that a worker
actually only touched the files it claimed. Workers started by a subagent (not the main
panel) are not tracked or capped, the same boundary every other gate here respects.

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

## State

Per session, at `<ORCH_STATE_DIR>/<session_id>.json`:

```json
{ "session_id": "...", "created": "<ISO-8601>", "bypass": false,
  "execAgent": null,
  "workers": { "<label>": { "role": "codex-exec", "started": 0,
                             "status": "live|settled", "last_seen": 0,
                             "rate_limited_until": 0,
                             "group": "ctx_x", "kind": "worker|terminal", "agent": "codex",
                             "owns": ["src/api/**"], "ws": "<repoRoot>|current" } },
  "reservations": { "<toolUseId>#<idx>": { "ts": 0, "agent": "codex",
                                            "owns": ["src/api/**"], "ws": "<repoRoot>|current",
                                            "codexSlot": true } },
  "agentClaims": { "<toolUseId>": { "owns": ["src/api/**"], "ws": "<repoRoot>|current", "ts": 0 } },
  "tasks": { "<taskId>": { "owns": ["src/api/**"], "ws": "<repoRoot>|current" } },
  "last_heartbeat": 0, "rate_limit_hits": 0 }
```

`execAgent` is one of `null` (automatic, by quota), `"code"` (the configured code model),
`"codex"`, `"codex:<model>"`, or `"claude:<alias>"`.

`group`/`kind`/`agent`/`owns`/`ws` on a worker entry, `reservations`, `agentClaims` and
`tasks` are the parallel-Codex-worker cap and file-ownership bookkeeping (see "Parallel
Codex workers and file ownership" above). `reservations` and `agentClaims` are both
transient — a reservation is consumed by the matching `PostToolUse` (or expires after 10
minutes if nothing ever does), and an `agentClaims` entry is removed at release, whichever
of the paths above fires first.

## Escape hatches

- `ORCHESTRATOR_GATE=off` in the environment disables every gate for that session,
  regardless of config.
- `--no-orchestrate` anywhere in a user prompt disables the gates for the rest of that
  session. Harness-injected turns (task notifications, cross-session messages, system
  reminders) never count as the operator's own prompt, so a subagent's report that merely
  quotes `--no-orchestrate` can never toggle this.
- `--exec-sonnet` / `--exec-codex` / `--exec-auto` and `--code-model <value>` toggle only
  execution routing, honestly — narrower than a full bypass.
- `--release-claims <toolUseId>` / `--release-claims all` manually frees one or every
  tracked `Owns:` claim — the deliberate manual override alongside the automatic release
  paths (matching `PostToolUse`, a `<task-notification>`, `ownershipClaimTtlMinutes`).
- `maxParallelCodexWorkers: 0` (config) or `ORCH_MAX_PARALLEL_CODEX_WORKERS=0` (env, one
  process) makes the parallel-Codex-worker cap unlimited.

Only the operator invokes these from the main panel's own prompt.

## Failure behavior

Malformed hook input, a missing state file, an unreadable config, or a crash inside the
gate all degrade to **allow** — the gate must never be the reason a session is stuck.
Refusals are appended to `<ORCH_STATE_DIR>/violations.log`
(`timestamp, session, gate, reason`).

## Tests

```
npm test                                             # both suites
node tests/test-orchestrator-gate.cjs                # classifiers, pure functions, config
node tests/test-orchestrator-gate-e2e.cjs            # real payloads through the hook
```

Every false positive found in real use became a permanent case in these suites: a `>`
inside a heredoc body, a `>` inside a quoted string, a compound line whose scratch cleanup
was poisoned by an unrelated echo, a fallback flag that never expired, an `orca` invocation
hidden inside `$( )`/backticks/an `env`/`exec`/`nohup` wrapper, and an auto-routed banner
that once printed the model name as `"undefined"`. A gate that refuses legitimate work
gets switched off, so its false-positive rate is as load-bearing as what it catches.
