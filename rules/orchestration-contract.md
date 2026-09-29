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
10. **No more than a MACHINE-wide budget of live Orca workers plus live in-session
    subagents at once.** The resource being budgeted is this machine's cores, not any one
    session's own concurrency: `max(1, floor(parallelCoreFraction x cores))` by default
    (`parallelCoreFraction` default `0.8`), or an explicit `maxParallelAgents` (`0` =
    unlimited). Summed across every recent session's state file on this machine — every
    live Orca worker group of any agent (on top of, never instead of, the Codex-only cap
    above) plus every live main-panel `Agent`/`Task` dispatch. A dispatch that would exceed
    it is refused; wait for one to finish and release it, or raise the limit.

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
  "disabledGates": [],
  "closeDoneWorktrees": true,
  "parallelCoreFraction": 0.8,
  "maxParallelAgents": null
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
- `closeDoneWorktrees`: boolean, default `true`. Whether the heartbeat daemon reminds the
  panel about a worktree that is idle, accepted, and clean (see "Close finished worker
  panels" above for the full definition), and that holds no live terminal. Overridable for
  one process with `ORCH_CLOSE_DONE_WORKTREES` set to `1`/`true` (force on) or `0`/`false`
  (force off) — any other value, including an empty string or the variable being unset,
  defers to the config rather than being read as "set at all, so true".
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
for tests), `ORCH_CODEX_HANDOFF_USED`, `ORCH_CLOSE_DONE_WORKTREES`. An invalid or missing config value never crashes
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

**Close finished worker panels.** A released worker still leaves its Orca worktree behind.
After a worker finishes: read its result, then `orca orchestration worker-release
--dispatch <id>`; once its PR is merged or closed and the worktree is clean (`git status
--porcelain` empty, nothing unpushed), close the worktree too: `orca worktree rm
--worktree path:<path>`. Never remove a worktree with an open PR or unsaved work — sweep
periodically with `orca worktree ps --json` to find worktrees nobody closed.

The heartbeat daemon backs this up automatically: each tick it also reads `orca worktree
ps --json --limit 500` (a page Orca itself marks `truncated` is never acted on — a partial
page can neither confirm nor rule out a transition) and flags a worktree that is not the
main worktree, not already archived, and that is:
  - **idle** — no live terminal at all, or `worktree ps`'s own aggregate `lastOutputAt`
    (one timestamp per worktree, not per terminal) already past `heartbeat.idleSeconds`;
  - **accepted** — a linked GitHub PR or GitLab MR already `merged`/`closed` (an open one
    never counts, whatever git alone might say), or — only when NEITHER is linked at all —
    a real `git merge-base --is-ancestor HEAD <base>` confirms HEAD is already contained in
    the worktree's own upstream default branch, resolved from `refs/remotes/origin/HEAD`
    (falling back to `origin/main` then `main`; `git fetch` is never run), AND (no-PR/MR
    path only) HEAD's own commit postdates the worktree's creation (the mtime of its `.git`
    file) — a worktree freshly branched off that base with zero new commits is trivially an
    "ancestor" of it too, and must not be mistaken for done-but-open work;
  - **clean** — `git status --porcelain` empty and no commits the branch holds that its
    upstream does not (`git rev-list @{u}..HEAD` empty), or, lacking an upstream entirely,
    HEAD contained in that same resolved base branch.

Every git call here runs only for a worktree that already passed the idle check, each
bounded to ~3s, and any git failure or uncertainty (unreadable repo, a timeout, no
resolvable base) means "not a candidate" — never a guess. A worktree already reported once
is skipped entirely on later ticks (its git calls are never re-run), and one tick's whole
git-evaluating pass is capped at ~10s with the heartbeat's own liveness file refreshed
between rows, so a fleet with many worktrees can never starve that file into looking dead.
The event line, `DONE worktree <name> (<reason>, no live terminal|quiet terminal(s)) — ...
orca worktree rm --worktree 'path:<path>'` (control characters stripped, the path
single-quote-escaped), names which of the above fired and which idle leg actually applied.
It never removes anything itself — only
the panel decides, after checking `git status` and unpushed commits, same as the manual
sweep above. Only a worktree that *becomes* done-but-open after the daemon's own
session-scoped record of what it has already reported wakes the panel; backlog already
done-but-open at a session's first-ever daemon start is listed once in a startup summary
instead. A LATER restart within the same session is judged against that same persisted
record: anything newly done-but-open — it became so while no daemon in this session was
watching — is reported as a real wake event, not silently re-absorbed as if it had always
been backlog. Disable it with `closeDoneWorktrees: false` in the config, or
`ORCH_CLOSE_DONE_WORKTREES` set to `0`/`false` for one process (`1`/`true` forces it on;
any other value defers to the config).

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
and one process's save can never silently overwrite another's.

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
would let every contending process fall through uncounted and all be admitted at once.

The check-and-reserve critical section runs under the SAME shared file lock every other
reservation-taking gate here uses, and always reloads state fresh from disk once the lock is
held, exactly like the Codex-only cap — the whole point being genuine cross-SESSION mutual
exclusion, not merely cross-Bash-call. The refusal names the live total, the limit, the
cores/fraction it was derived from, and up to 8 of the oldest live units labeled
`<sid8>:<id>` (an 8-character session-id prefix, so two sessions' ids can never be confused
in the same list): `<n>/<N> parallel units live on this machine (<cores> cores x
<fraction>%): <k> Orca workers, <m> subagents [<sid8>:<id>, ...]`. Recovery is framed as the
OPERATOR's call, never an invitation for the model to raise the limit itself: release a
specific claim (`--release-claims <id>|all`, this session only — see below), delete a dead
session's state file, or disable the gate (`disabledGates: ["max-parallel-agents"]`).

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

## State

Per session, at `<ORCH_STATE_DIR>/<session_id>.json`:

```json
{ "session_id": "...", "created": "<ISO-8601>", "bypass": false,
  "execAgent": null,
  "workers": { "<label>": { "role": "codex-exec", "started": 0,
                             "status": "live|settled", "last_seen": 0,
                             "rate_limited_until": 0,
                             "group": "ctx_x", "kind": "worker|terminal", "agent": "codex",
                             "owns": ["src/api/**"], "ws": "<repoRoot>|current",
                             "capExempt": false } },
  "reservations": { "<toolUseId>#<idx>": { "ts": 0, "agent": "codex",
                                            "owns": ["src/api/**"], "ws": "<repoRoot>|current",
                                            "codexSlot": true } },
  "agentClaims": { "<toolUseId>": { "owns": ["src/api/**"], "ws": "<repoRoot>|current", "ts": 0,
                                     "background": false } },
  "tasks": { "<taskId>": { "owns": ["src/api/**"], "ws": "<repoRoot>|current" } },
  "last_heartbeat": 0, "rate_limit_hits": 0 }
```

`execAgent` is one of `null` (automatic, by quota), `"code"` (the configured code model),
`"codex"`, `"codex:<model>"`, or `"claude:<alias>"`.

`group`/`kind`/`agent`/`owns`/`ws` on a worker entry, `reservations`, `agentClaims` and
`tasks` are the parallel-Codex-worker cap and file-ownership bookkeeping (see "Parallel
Codex workers and file ownership" above). `reservations` and `agentClaims` are both
transient — a reservation is consumed by the matching `PostToolUse` (dropped outright on a
failed tool call or an Orca `"ok":false` reply, or expires after 10 minutes if nothing ever
resolves it), and an `agentClaims` entry is removed at release, whichever of the paths
above fires first. A worker Orca reports done but still holding its terminal is marked
`capExempt: true` — it no longer counts toward `maxParallelCodexWorkers`, but stays `live`
so the Stop gate still catches it as an unreleased resource. An `agentClaims` entry from a
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
- `--no-orchestrate` anywhere in a user prompt disables the gates for the rest of that
  session. Harness-injected turns (task notifications, cross-session messages, system
  reminders) never count as the operator's own prompt, so a subagent's report that merely
  quotes `--no-orchestrate` can never toggle this.
- `--exec-sonnet` / `--exec-codex` / `--exec-auto` and `--code-model <value>` toggle only
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
npm test                                             # all three suites
node tests/test-orchestrator-gate.cjs                # classifiers, pure functions, config
node tests/test-orchestrator-gate-e2e.cjs            # real payloads through the hook
node tests/test-concurrency.cjs                      # genuine multi-process races (both caps)
```

Every false positive found in real use became a permanent case in these suites: a `>`
inside a heredoc body, a `>` inside a quoted string, a compound line whose scratch cleanup
was poisoned by an unrelated echo, a fallback flag that never expired, an `orca` invocation
hidden inside `$( )`/backticks/an `env`/`exec`/`nohup` wrapper, and an auto-routed banner
that once printed the model name as `"undefined"`. A gate that refuses legitimate work
gets switched off, so its false-positive rate is as load-bearing as what it catches.
