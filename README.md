# claude-codex-orca-orchestration

Installable [Claude Code](https://claude.com/claude-code) hooks that turn a described
orchestration workflow into a mechanically enforced one: a main panel that only
dispatches and supervises, planning/review/verification pinned to one model, code spread
across Codex and Kimi peers in [Orca](https://orca.dev) workers (or an in-session model
once neither coder is eligible), every code brief required to name how it will be
verified, and a supervision
loop that will not let the session end with an Orca worker still live and unwatched.

Repo: <https://github.com/bachdx2812/claude-codex-orca-orchestration>

## Who does what

```
Request -> main panel -> Opus 5.5 plans + red-teams -> Codex (gpt-5.6-sol) | Kimi writes code
[Sonnet only once BOTH coders are unusable or have used >= their handoff threshold of quota,
 read live; separate, configurable thresholds via codexHandoffUsedPercent /
 ORCH_CODEX_HANDOFF_USED and kimiHandoffUsedPercent / ORCH_KIMI_HANDOFF_USED]
-> Opus 5.5 reviews -> main panel reports
```

| Role | What it does | Model (exact version) | How it is dispatched | Config key |
|---|---|---|---|---|
| Main panel (orchestrator) | Takes the request, delegates, supervises workers, reports; never writes code | Session default model | — | `activation` |
| Planner / red-team | Plans, red-teams plans | Opus 5.5 (`claude-opus-5-5`) | `Agent` with `model: "opus"` | `models.review` |
| Reviewer / verifier | Code review, verification | Opus 5.5 (`claude-opus-5-5`) | `Agent` with `model: "opus"` | `models.review` |
| Coder pool (peers) | Every task class previously handled by Codex: code, builds, refactors, tests, bulk conversions, and fix loops | Codex `gpt-5.6-sol` + Kimi (`default_model` in `~/.kimi-code/config.toml`) | Spread across eligible Orca workers. Pick fewer live workers, then more headroom below that coder's own threshold, then the coder other than `lastCoder`, then Codex as the final tie-break. Codex uses `worker-start --agent codex --model gpt-5.6-sol`; Kimi uses `worker-start --agent kimi` without `--model`. | `models.codex`, `models.kimi`, per-coder caps and thresholds |
| Coder (handoff) | Same work once every usable coder has used >= its handoff threshold of its live-read quota (Codex: `codexHandoffUsedPercent`, default 95, override `ORCH_CODEX_HANDOFF_USED`; Kimi: `kimiHandoffUsedPercent`, default 95, override `ORCH_KIMI_HANDOFF_USED`) or is unusable on this machine | Sonnet | `Agent` with `model: "sonnet"` (brief must name a verify command) | `codexHandoffUsedPercent`, `kimiHandoffUsedPercent`, `models.code`, `execFallbackWhenCodexUnavailable` |
| Lookups | Find code, read logs / test output, explore | Haiku | `Agent` with `model: "haiku"` (advised, not enforced) | `models.lookup` |
| Escalation | Only after Opus 5.5 failed even at higher effort; the dispatch must say both | Fable 5.1 (`claude-fable-5-1`) | `Agent` with `model: "fable"` + "escalation: opus failed ... at high effort ..." | `models.escalation` |

An eligible coder is usable on this machine (installed, signed in, and launchable), below
its own handoff threshold, and has a free cap slot. Unusable coders are excluded; if both
coders are exhausted or unusable, code goes to Sonnet. Each threshold defaults to 95 and
is independently configurable in `~/.claude/orchestration.config.json` or with
`ORCH_CODEX_HANDOFF_USED` / `ORCH_KIMI_HANDOFF_USED`.

### Override from the main panel

`--code-model opus|sonnet|haiku|fable|codex|codex:<model>|kimi|kimi:<model>|auto` (session-scoped, last flag
wins; shortcuts `--exec-sonnet`, `--exec-codex`, `--exec-kimi`, `--exec-auto`). The per-prompt "Model
routing" line always shows the current coder and why. Active overrides also show when
they were set and how to return to automatic quota routing, both per prompt and in the
`SessionStart` banner.

For Agent/Task descriptions, a recognized first verb governs intent before later nouns do:
`Review ...` and `Plan ...` route to review, while `Implement ...` and `Generate code/assets/components ...`
route to code. Operational verbs (`commit`, `push`, `merge`, `publish`, `rebase`, `tag`,
`release`, `deploy`, `update`, `write`) suppress later review nouns, so `Commit review-fix round`
is not mistaken for review work; they do not suppress later code intent (`Update the parser to fix X`).
Code intent in ordinary hyphenated verbs such as `Re-implement` and `Hot-fix` still counts; only
review-style compounds such as `review-fix` are excluded. Code intent also overrides a
review-oriented `subagent_type` when both signals are present.

## Subagents and parallel work

Two kinds of workers do the actual work; only Orca workers need supervision:

| Kind | Examples | Where it runs | How the panel learns it finished |
|---|---|---|---|
| In-session subagent | Opus 5.5 review/red-team, Sonnet code (handoff), Haiku lookups | Inside the Claude Code session, via the `Agent` tool | The `Agent` call returns its result to the panel when it completes. These hooks never track or gate subagents, so no heartbeat is needed. |
| Orca worker | Codex (`gpt-5.6-sol`) or Kimi | A separate session in its own Orca-managed terminal/worktree | `orca-heartbeat.cjs` polls Orca and exits — waking the panel — on a worker state change, this session's own worker terminal going IDLE past `heartbeat.idleSeconds`, making no real progress past its configured stall threshold, losing its Codex app-server connection, a finished worker still holding a terminal, this session's terminal becoming orphaned, a rate-limit signal, or one of this session's worktrees whose PR already merged/closed with no live terminal on it (see "Close finished worker panels" below). Context-only `unsupervised` rows, other sessions' worktrees, and the panel's own terminal are excluded. |

**Parallel work.** These hooks gate the main panel's writes and model routing, not task
scheduling, so running things in parallel is the operator's call, not something the gate
checks: keep file ownership disjoint between anything running at once, and remember
read-only work (review, red-team, lookups) is always safe to parallelize since nothing is
written. The gate has no visibility into which files a worker touches or whether two
workers collide on one.

**Codex rate limits under parallel load.** On a rate-limit signal (`rate limit`, `429`,
`quota exceeded`, `usage limit`, `too many requests`, `retry-after`, `overloaded_error` in
a worker's output), `orca-heartbeat.cjs` marks every live worker as backing off for ~120s.
The correct response is to wait, then retry the *same* dispatch — never re-dispatch
immediately or start a replacement, both of which deepen the limit:

```
orca orchestration worker-start --retry-of <dispatchId> ...
```

— and reduce how many Codex workers run in parallel.

**Readiness timeout with a live terminal.** `worker-start` can report
`stage: agent_readiness` / `lastError: timeout` even though the Codex terminal started and
is usable. The gate prints this recovery advice with any terminal/dispatch handles returned
by Orca. Do not launch a replacement. Send the original spec to that terminal, then mark the
worker explicitly retained:

```sh
orca terminal send --terminal <terminalHandle> --text "$(cat <spec-file>)" --enter
orca orchestration worker-retain --dispatch <dispatchId>
```

An explicitly retained row remains supervised even when its terminal was already quiet
before the daemon started: keep `orca-heartbeat.cjs` alive while waiting so it can wake the
panel when the terminal becomes IDLE. Each `handle` + `lastOutputAt` quiet stretch is persisted
for the session, so restarting the daemon does not wake the panel repeatedly for unchanged
output; new output re-arms the next quiet-stretch report. `Stop` refuses an explicitly retained
worker that is still running when no live heartbeat is watching it; a retained worker Orca
reports done is informational and does not need a heartbeat. A readiness-failure row Orca labels `retained` is not treated
as this operator decision unless this session actually ran `worker-retain`. Release it
normally when the work is done.

If Codex prints a lost/reconnect-failed app-server message, continuing TUI repaint output
does not count as progress. The heartbeat reports `WORKER STUCK` once for that terminal in
the session; release it and re-dispatch because work since the last commit may be lost. Once
reported disconnected, that terminal skips the idle and orphan checks for the same poll.

**Progress-based stall detection.** A busy-looking TUI is not necessarily making progress.
For each supervised worker, the heartbeat fingerprints the worker worktree's `HEAD`,
`git status --porcelain`, full `git diff`, and changed/untracked file size and mtime together
with meaningful terminal output from the rendered screen (`orca terminal read --terminal
<handle> --screen`), not the lossy one-line list preview. Reads are bounded and limited to this
session's supervised terminals; a failed read reuses the last good screen, falling back to
the list preview only before any read succeeds. A timed-out git probe likewise reuses that
terminal's last good git sample, so transient repository slowness is not mistaken for progress.
Spinner frames, elapsed-time counters, rotating `Tip:` lines, context/token counters, and
prompt box chrome are ignored; Kimi's completed-tool count remains progress. Rate-limit,
disconnect, and usage-limit diagnoses continue to use the live list preview so stale
scrollback cannot retrigger them. If that fingerprint does not change for
`heartbeat.stallSeconds` (default 900 seconds), or the agent-specific value in
`heartbeat.stallSecondsByAgent` (Kimi defaults to 600 seconds), the daemon emits one
`WORKER STALLED` wake event. Nudge the terminal with `continue`, or stop it and re-dispatch
the same brief to the other coder; the daemon never kills it automatically. The report is
persisted once per unchanged episode across daemon restarts and is re-armed by a file or
meaningful-output change. Disconnected, rate-limited, and usage-exhausted workers keep their
more specific diagnosis instead of also being labeled stalled. Set `ORCH_STALL_SECONDS` to
override the global threshold for one process; blank or invalid values fall back to config.
An active `Waiting for background terminal` / `background terminal running` status gets a
grace period of twice the applicable stall threshold; if neither the child status nor any
other progress changes by then, the same informational stall event fires. Workers Orca
already reports succeeded, failed, stopped, or completed are excluded.

Interactive worker screens wake the panel immediately instead of waiting for either IDLE
or the stall threshold. Kimi/Codex permission menus, approval questions, and selection UI
such as `Select permission mode`, `Allow`/`Deny`, or `↑↓ navigate · Enter select` emit
`WORKER WAITING FOR APPROVAL <dispatch|terminal> (<agent>)`. The detector requires prompt
shape—such as numbered choices, confirm/cancel key help, selection navigation, or a prompt
box—rather than isolated keywords, so normal output discussing “allow”, “deny”, or “approve”
is ignored. Codex's `Would you like to run the following command?` / `make the following
edits?` confirmations are included. Only the normalized prompt block, including the
question and command, forms the episode
signature, so rotating tips, timers, and spinners cannot re-fire it. Reports persist once
per unchanged prompt episode across heartbeat restarts and re-arm after the prompt
disappears; the heartbeat never answers automatically.

**Mid-task quota handover.** While a supervised Codex or Kimi worker is live, the heartbeat
reuses that coder's cached single-flight quota probe. At
`handoverWarnMarginPercent` (default 5) below the coder's own handoff threshold it emits a
once-per-episode warning; at the threshold, or on a terminal usage-exhaustion signal, it
emits `WORKER HANDOVER <dispatch|terminal> (<agent> <used>% >= <threshold>%)`. Kimi hands
over to eligible Codex, and Codex hands over to eligible Kimi; either direction falls back
to Sonnet when the other external coder is unavailable or exhausted. The gate repeats
persisted pending handovers in each prompt reminder.

If the old worker still responds, send it: `Stop now: commit all work-in-progress as wip:
handover and write HANDOVER.md (done / remaining / next step / how to verify), commit it,
then stop.` Wait up to about three minutes, then stop and release it without deleting its
worktree or branch. Dispatch the same brief to the selected coder in that same worktree and
branch, prefixed: `Continue a task handed over from <agent>. Read HANDOVER.md and git log
first; do not redo finished steps.` For Sonnet, point the in-session Agent at that worktree.

**Park and resume after quota reset.** When a worker is fully exhausted and neither the
other external coder nor the in-session Sonnet panel is available, the heartbeat emits
`WORKER PARKED <id> (<agent> limit, resets <local time>) - will auto-resume`. It starts one
detached scheduler per parked terminal, persisted with its PID and reset time. At the known
reset plus 90 seconds—or every 15 minutes when reset time is unknown—the scheduler rechecks
quota and, once it is below the coder's handoff threshold, sends the worker the guarded
continue message and verifies that the terminal started another turn. Kimi permission mode
is returned to Never Ask first when its screen shows another mode. Claude worker screens use
the same parking path as the panel. Reset hints also accept month/day and an explicit IANA
timezone, for example `resets Oct 3, 5pm (Asia/Saigon)`. Only live, supervised, non-released
terminal handles from this session are eligible.

If Kimi presents its long-idle session menu after the resume message, the scheduler verifies
the menu cursor, moves it to `Compact and continue` when necessary, presses Enter once, and
then verifies that compaction or the resumed turn started.

The scheduler persists its attempt count and first-attempt time and stops after 768 attempts
or eight days. It never retypes a resume after a successful terminal send: if no new turn can
be confirmed—or a scheduler dies after persisting its pre-send marker—the heartbeat reports
`WORKER RESUME UNVERIFIED ... do not retype` for manual
inspection. If Claude responds to that send with a fresh limit banner, that is a new quota
episode and is parked at the newly parsed reset instead. Expired schedulers are also reported,
and reported/finished scheduler records are removed after one day. Until that cleanup,
`resumed-unverified` and `expired` deliberately block automatic re-parking of the same
terminal for up to 24 hours; inspect and resolve the reported terminal manually.

`autoResumeAfterReset` defaults to `true`; `ORCH_AUTO_RESUME=false` disables scheduling for
one process (blank is unset). `autoResumePanel` also defaults to `true`: when the exact panel
terminal shows a Claude limit message such as `resets 5pm`, `resets at 17:00`, or `try again
in 2h`, it gets its own scheduler and orchestration-specific resume message. Set it to
`false` to opt the panel out. In-session Agent subagents cannot survive a rate-limited panel
turn, so the resumed panel must re-dispatch them; prefer Orca workers for long resumable code
tasks.

**Close finished worker panels.** After a worker finishes: read its result, then `orca
orchestration worker-release --dispatch <id>`. Once its PR is merged or closed and the
worktree is clean (`git status --porcelain` empty, nothing unpushed) — close the worktree
too: `orca worktree rm --worktree path:<path>`. Never remove a worktree with an open PR or
unsaved work; sweep periodically with `orca worktree ps --json`. `orca-heartbeat.cjs`
backs this up: each tick it also checks `orca worktree ps --json` (`--limit 500`) and joins
its `worktreeId` values to this session's nested worker resources/projections, worker-start
replies, and tracked terminal rows (falling back to the path suffix after `::`). Another
session's worktree can never produce its summary or wake event. A page
Orca itself reports `truncated` is never acted on — a partial page can neither confirm nor
rule out a transition — and reports a worktree that is not main, not archived; **accepted**
(a linked GitHub PR or GitLab MR already merged/closed — an open one never counts, whatever
git alone might say — or, only when NEITHER is linked at all, a real `git merge-base
--is-ancestor HEAD <base>` confirms HEAD is already in the worktree's own upstream default
branch, resolved from `refs/remotes/origin/HEAD` with no `git fetch` ever run, AND HEAD's own
commit postdates the worktree's creation (a worktree freshly branched off that base with
zero new commits is trivially an "ancestor" too, and must not be mistaken for done-but-open
work) AND the worktree's per-worktree HEAD reflog (`git reflog show --format=%gs HEAD`)
actually records a `commit` entry — a worktree that only ever got rebased or fast-forwarded onto a
base that itself advanced after the worktree was created can satisfy the commit-time check
above without ever recording a commit action, so both signals are required); **idle**
(no live terminal at all, or `worktree ps`'s own aggregate `lastOutputAt` already past the
heartbeat's idle threshold); and **clean** (`git status --porcelain` empty and no unpushed
commits — or, lacking an upstream entirely, HEAD contained in that same resolved base) —
naming which of these fired in its message, and the exact, quoted `orca worktree rm`
command, but never running it itself. Every git call only ever runs for a worktree that
already passed the idle check, each bounded to ~3s, and any git failure or uncertainty
(unreadable repo, timeout, no resolvable base, empty reflog) means "not a candidate", never
a guess. The very FIRST (seeding) pass never truncates its evaluation to the per-tick git
budget (~10s) — every row is checked once so nothing pre-existing is silently left off the
one-time backlog summary only to fire as a false "new" wake event once a later tick happens
to reach it.
Only a worktree that *becomes* done-but-open after the daemon's own session-scoped record
of what it already reported wakes the panel; genuine backlog at a session's first-ever
daemon start is listed once in a summary line instead — a LATER restart within the same
session that finds something newly done-but-open (it became so while no daemon was
watching) reports it as a real wake event, not silently-reabsorbed backlog. Disable with
`closeDoneWorktrees: false` or `ORCH_CLOSE_DONE_WORKTREES` set to `1`/`true` (enable) or
`0`/`false` (disable) — any other value, including empty, defers to the config.

**Enforced vs advisory.** Enforced: gates apply to the main panel only (subagents and
Orca-worker sessions are never gated); `Stop` refuses to end the session while a worker is
running and unwatched (`workers-unwatched` — no live heartbeat) or finished but still
holding a terminal (`workers-unreconciled` — needs `worker-retain` or `worker-release`);
**no more than `maxParallelCodexWorkers` (default 3) live Codex workers at once**
(`max-parallel-codex-workers`) **and no more than `maxParallelKimiWorkers` (default 3)
live Kimi workers at once** (`max-parallel-kimi-workers`); **no more than a MACHINE-wide budget of live Orca workers
(any agent) plus live in-session subagents, summed across every recent session on this
machine** (`max-parallel-agents` — the resource is this machine's cores, not any one
session's own concurrency: `max(1, floor(parallelCoreFraction x cores))` by default, an
explicit `maxParallelAgents` overrides that derivation, `0` = unlimited); **every code
brief in a shared workspace declares the files it will touch**
(`code-brief-needs-owns` — `Owns: <paths>` or `Owns: n/a <reason>`,
on its own line) **and a claim that overlaps another live one is refused**
(`ownership-overlap`, naming the holder and its age).

Prefer `--worktree new-child` (Orca) or Agent `isolation:"worktree"` for genuinely
parallel workers: isolated work needs no `Owns:` at all and can never conflict with
anything, since each isolated dispatch gets a unique workspace key — narrowing an `Owns:`
claim in a *shared* workspace only avoids that specific conflict, not the next one.

| Gate | Refuses when | Escape |
|---|---|---|
| `max-parallel-codex-workers` | a new Codex `worker-start` would exceed `maxParallelCodexWorkers` | release/reuse/retry an existing worker; raise the cap; `ORCH_MAX_PARALLEL_CODEX_WORKERS=0` |
| `max-parallel-kimi-workers` | a new Kimi `worker-start` would exceed `maxParallelKimiWorkers` | release/reuse/retry an existing worker; raise the cap; `ORCH_MAX_PARALLEL_KIMI_WORKERS=0` |
| `max-parallel-agents` | a new Agent/Task dispatch, `worker-start`, or `terminal create` would exceed the machine-wide budget | wait for one to finish and release it, or ask the operator to release a claim, delete a dead session's state file, or raise/disable the cap — never the model's own call |
| `code-brief-needs-owns` | a shared-workspace code brief has no `Owns:`/`Owns: n/a` | declare it, or isolate the dispatch |
| `ownership-overlap` | a claim overlaps another live claim in the same workspace | narrow the claim, wait/release the holder, or isolate |

`max-parallel-agents` counts every live Orca worker group (any agent, not only Codex — the
Codex-only cap above still applies on top, never instead) plus every live in-session
Agent/Task dispatch this main panel has registered (`s.agents[toolUseId]`, for every
dispatch — not only code briefs), summed across every session's state file modified in the
last 6h — and, for every OTHER session (the caller's own always counts), only while it also
has a recent liveness signal: its heartbeat daemon alive, or its state file touched in the
last 30 minutes. For an Agent/Task dispatch, registration happens only at the very END of
routing/ownership gate checks, after every gate that could still refuse it has passed — an
early, read-only capacity check runs first so an already-over-budget dispatch still gets
this refusal promptly. At capacity, the gate first reconciles the caller's own session
against a live Orca worker-list before refusing (a stale local "still live" entry Orca has
already confirmed released frees its slot); if the state lock itself is contended, it
refuses with a transient "retry" reason rather than risk over-admitting under load — but
ONLY while the cap is actually finite: a disabled gate or an unlimited (`maxParallelAgents:
0`) cap returns allow before ever looking at the lock, so a `.lock` some other process
happens to be holding can never masquerade as "at capacity" for a cap that isn't capping
anything. The lock acquisition on this path also deliberately outlives file-lock's own
staleMs (10s) — a caller whose attempt starts less than ~8s after a dead holder's lock was
created used to time out and refuse before ever living long enough to see it go stale;
it now waits long enough to break and reclaim a truly abandoned lock itself. A genuine
lock filesystem failure (missing/unwritable state path, disk error) is distinct from
contention and degrades to allow, as infrastructure failures must. A
dispatch registered as `run_in_background: true` survives its own launch-returning
`PostToolUse` and is instead released by a matching `<task-notification><tool-use-id>`, a
120-minute TTL, or `--release-claims`, the same pattern `code-brief-needs-owns`'s `Owns:`
claims already use. A `--terminal <h>` / `--retry-of <id>` replacement of an already-tracked
live group is not a new slot. The refusal labels each unit `<sid8>:<id>` (its owning
session's id, truncated to 8 characters), names the real `ORCH_STATE_DIR`-aware state dir in
its recovery hint (never a hardcoded `~/.claude/orchestrator-gate/`), and shows `(<cores>
cores x <fraction>%)` only when the limit was actually DERIVED from the machine's core
count — an operator-set explicit `maxParallelAgents`/`ORCH_MAX_PARALLEL_AGENTS` never went
through that math, so the refusal says `(explicit limit)` instead. The `SessionStart` banner
and every per-prompt reminder show `parallel budget: <n>/<N> (<cores> cores x <fraction>%)`.

Advisory only, never blocked by the gate: whether the files a worker actually touched
matched what it declared (ownership is *declared*, not observed).

## What it is

Claude Code hooks are just scripts your settings.json wires to lifecycle events
(`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
`Stop`). This repo ships
two of them, both zero-dependency Node:

- **`hooks/orchestrator-gate.cjs`** — refuses (exit code 2) a main-panel tool call that
  violates the contract, and prints per-turn reminders (model routing, live-worker
  status). Subagents and Orca-worker sessions are never gated — they do the actual work.
- **`hooks/orca-heartbeat.cjs`** — a background supervision loop the panel starts after
  dispatching a worker. It polls Orca and exits the instant something needs a decision
  (a worker finished, went idle, hit a rate limit, was orphaned, or a worktree's PR merged/
  closed with no live terminal left on it), which is itself the wake-up signal for the
  panel — no polling loop the model has to remember to run.

Everything either enforces is **configured**, not hard-coded: which model plans/reviews,
which model escalates to, which model codes, the Codex-quota handoff threshold, the reply
language, which gates are active. See `rules/orchestration-contract.md` for the full
contract and `config/orchestration.config.example.json` for every knob.

Exact model versions are listed once, in "Who does what" above. `install.mjs` pins both
`ANTHROPIC_DEFAULT_OPUS_MODEL` and `ANTHROPIC_DEFAULT_FABLE_MODEL` to the review and
escalation versions by default (`--no-pin-models` skips both); edit
`~/.claude/orchestration.config.json` to point at different versions or providers.

## Quickstart

```bash
git clone https://github.com/bachdx2812/claude-codex-orca-orchestration
cd claude-codex-orca-orchestration
node install.mjs --dry-run   # see what would change, writes nothing
node install.mjs             # install
npm test                     # 913 tests, hermetic (no live Orca/Codex needed)
```

Start a new Claude Code session; its `SessionStart` should print an "ORCHESTRATION
CONTRACT" banner. `node install.mjs --check` reports install status, prerequisite
binaries, the effective model-pin environment variable, and any foreign
`orchestrator-gate.cjs` registration. Install warns and leaves a foreign gate intact by
default; rerun with `--replace-foreign-gate` to remove those registrations under the
normal `settings.json` backup. `--help`/`-h` only prints usage, and an unknown option exits
2 without installing. Check mode exits 1 whenever it reports a `MISS`, `FAIL`, or `PROBLEM`.

Full agent-facing install/verify/customise/rollback steps: `AGENT_INSTALL.md`.

## Workflow (text diagram)

```
operator prompt
      |
      v
[main panel]  ---- Edit/Write/mutating Bash outside .claude/,plans/,docs/,scratch ----X  refused
      |
      | dispatches
      v
  plan / review / verify  ---->  in-session subagent, model = models.review.alias
      |
      | (or, after the review model failed at high effort)
      v
  escalation work  ------------>  in-session subagent, model = models.escalation.alias
      |
      v
  code  ---->  Codex in an Orca worker  (default, while Codex quota allows)
      |            |
      |            v
      |     worker-list / worker-read / worker-release, supervised by orca-heartbeat.cjs
      |
      +--->  in-session subagent, model = models.code.alias
                 (once Codex has used codexHandoffUsedPercent, or via --code-model / --exec-sonnet)
```

Automatic routing reads Codex quota live from `codex app-server` without making a model
call. Successful and failed probes are cached for 60 seconds in the gate state directory
and memoized inside one hook process. Expired-cache refreshes use a short state-directory
lease, so parallel hooks produce one app-server probe while peers consume the refreshed or
stale value. If the live probe fails, routing falls back to the
newest local Codex session-log rate-limit event no older than six hours, then to `unknown`
(which deliberately keeps Codex as the default). The helper has its own 4.5-second deadline
and escalates a child that ignores SIGTERM to SIGKILL. Per-turn reminders label a reading
`(live, <age> ago)`, `(session log, <age> old)`, `(limit reached, live, <age> ago)`, or
`(unknown)` and show the age of the optional Claude usage cache.

## Customise

Edit `~/.claude/orchestration.config.json` (created from
`config/orchestration.config.example.json` on first install; re-read on every hook call,
no restart needed):

The file is plain JSON — no comments — parsed as-is:

```json
{
  "codexHandoffUsedPercent": 90,
  "kimiHandoffUsedPercent": 95,
  "handoverWarnMarginPercent": 5,
  "autoResumeAfterReset": true,
  "autoResumePanel": true,
  "codexQuotaCacheSeconds": 60,
  "kimiQuotaCacheSeconds": 60,
  "coderAvailabilityCacheSeconds": 600,
  "replyLanguage": "Vietnamese",
  "maxParallelCodexWorkers": 5,
  "maxParallelKimiWorkers": 3,
  "ownershipClaimTtlMinutes": 60,
  "disabledGates": ["code-brief-needs-verify"],
  "parallelCoreFraction": 0.8,
  "maxParallelAgents": null
}
```

(`codexHandoffUsedPercent: 90` hands off slightly earlier than the default 95;
`kimiHandoffUsedPercent` is Kimi's own, separate threshold (default 95) — both are
used for new routing and live-worker handover. `handoverWarnMarginPercent` warns that many
percentage points before either threshold (default 5; set 0 to disable the early warning).
tunable via this file or env (`ORCH_CODEX_HANDOFF_USED` / `ORCH_KIMI_HANDOFF_USED`);
`kimiQuotaCacheSeconds` and `coderAvailabilityCacheSeconds` (default 600, the per-machine
"is this coder installed and signed in?" probe TTL) mirror the Codex cache key;
`codexQuotaCacheSeconds` controls the cross-process live-reading
cache TTL (`0` disables file-cache reuse but retains memoization inside one hook process);
`replyLanguage` accepts any language name, or `null` for no
language instruction at all; `maxParallelCodexWorkers` / `maxParallelKimiWorkers` raise or
lower how many live
workers of each coder this session may hold at once (`0` = unlimited); `ownershipClaimTtlMinutes`
changes how long a background Agent's `Owns:` claim survives before it auto-expires;
`parallelCoreFraction` (default `0.8`) is the share of this machine's cores the
machine-wide `max-parallel-agents` budget derives its limit from; `maxParallelAgents`
(default `null`, meaning derive it from `parallelCoreFraction x cores`) overrides that
derivation outright, `0` meaning unlimited.)

For every numeric env override — `ORCH_CODEX_HANDOFF_USED` / `ORCH_KIMI_HANDOFF_USED`,
`ORCH_MAX_PARALLEL_CODEX_WORKERS` / `ORCH_MAX_PARALLEL_KIMI_WORKERS`, and the
`ORCH_*_CACHE_SECONDS` TTLs — an empty or whitespace-only value counts as unset (never
coerced to `0`), and a `null` or other non-number in this file for a numeric key falls
back to that key's default with a banner warning.

See `rules/orchestration-contract.md#config` for every field.

## Uninstall / rollback

```bash
node install.mjs --uninstall           # removes hooks, settings.json entries, CLAUDE.md block; keeps config.json
node install.mjs --uninstall --purge   # also removes config.json
```

Every settings.json write is preceded by a timestamped backup
(`settings.json.bak-<timestamp>`) in `~/.claude/`; `--uninstall` also does a surgical,
exact-match removal (never a blind restore, so edits you made after installing survive).

## Escape hatches

- `ORCHESTRATOR_GATE=off` (env var) disables every gate for that session, for CI or
  headless `claude -p`.
- A standalone `--no-orchestrate` flag in an operator prompt disables the gates for that
  session;
  `--orchestrate` re-enables them. If both appear, the last flag wins. While disabled,
  every prompt and the `SessionStart` banner show when bypass began and how to re-enable.
- `--exec-sonnet` / `--exec-codex` / `--exec-kimi` / `--exec-auto` and `--code-model <value>` (see
  `rules/orchestration-contract.md`) let the operator override coding-model routing
  without a full bypass.
- Harness-injected notifications and compaction summaries are never interpreted as fresh
  operator flags, even when they quote an earlier `--no-orchestrate`, `--exec-*`, or
  `--code-model` prompt.
- `--release-claims <toolUseId>` / `--release-claims all` manually frees a stuck `Owns:`
  claim OR a stuck `max-parallel-agents` registration; `maxParallelCodexWorkers: 0`
  (config) or `ORCH_MAX_PARALLEL_CODEX_WORKERS=0` (env) makes the parallel-Codex-worker cap
  unlimited; `maxParallelKimiWorkers: 0` (config) or `ORCH_MAX_PARALLEL_KIMI_WORKERS=0`
  (env) makes the parallel-Kimi-worker cap unlimited; `maxParallelAgents: 0` (config) or `ORCH_MAX_PARALLEL_AGENTS=0` (env) makes
  the machine-wide max-parallel-agents budget unlimited.

## Known limitations

`hooks/lib/shell-orca-invocations.cjs`'s `orcaInvocations()` is a real linear-time shell
tokenizer (no backtracking-capable regex; see its own header comment for the design and
what it replaced), not a regex heuristic — but it is still not a full shell interpreter.
Three shapes it does not detect, each covered by a code comment at the relevant point in
the scanner rather than a blanket disclaimer:

- **`! orca ...`** — the `!` negation keyword is not in its recognized wrapper list, so a
  negated orca invocation is not detected.
- **`time -p orca ...`** — `time` is recognized and skipped, but the flags some shells'
  `time` accepts (`-p`, etc.) are not, so `time -p orca ...` is not detected (bare
  `time orca ...` is).
- **Heredoc bodies fed to another interpreter** — e.g. `bash <<'EOF'` / `orca ...` /
  `EOF`. The scanner deliberately treats heredoc bodies as opaque data (see
  `skipHeredocBodies`), which is correct when the body is just text (a markdown code
  span, a config file) but means an orca invocation inside a heredoc that is itself piped
  into a shell is not detected.

None of these are false positives (nothing is wrongly flagged); they are detection gaps
where a real orca invocation could pass the code-brief-verify and worker-registration
checks unnoticed. Widening the wrapper/keyword list, or fully parsing heredoc bodies
handed to a shell interpreter, is future work.

File ownership is *declared*, not observed: `Owns:` is trusted at face value, and nothing
checks that a worker's actual edits stayed within what it claimed. Workers started by a
subagent (not the main panel) are not tracked and do not count toward
`maxParallelCodexWorkers` or `maxParallelAgents`, the same boundary every other gate here
respects — these hooks gate the main panel's own dispatches, both at `worker-start` time
and again when that dispatch's own result is registered, so a subagent's Codex worker is
never counted twice or once by accident. `orchestration dispatch --to <handle>` (a
context-only send to an existing terminal, not a new worker) is out of scope for both the
parallel-limit and ownership gates. Likewise, a **subagent that itself spawns further
subagents** is invisible to `max-parallel-agents`: only the main panel's own `Agent`/`Task`
dispatches are registered, so nested fan-out from inside a subagent is not charged against
the machine-wide budget — the same boundary, stated once here rather than per gate.

Cross-session `max-parallel-agents` counting has its own trade-off (operator decision): a
session with neither a live heartbeat daemon nor a state-file write in the last 30 minutes is
presumed abandoned and its units are dropped from the shared count, even if it is technically
still working — the alternative (a genuinely dead session eating into the budget forever)
was judged worse. The caller's own session is never subject to this filter.

Only an `Owns:` line that starts the line (optionally after `-`/`*`) is read — a markdown-
bold `**Owns:**` or an `Owns:` appearing mid-sentence is not recognized, and the refusal
message says so rather than guessing at prose. `code-brief-needs-owns` is enforced at
`worker-start`, where the workspace is actually known; a `task-create --spec` with no
`Owns:` is not refused by itself, since it doesn't yet know whether its eventual
`worker-start` will be isolated. When a Bash command chains more than one
`worker-start`/`task-create` invocation, each is matched to its own JSON reply
positionally (in command order) to keep them from being merged into one group — a command
whose spec text uses `$(cat file)`/`` `cat file` `` command substitution degrades to
judging the whole command's text instead of just that invocation's own spec, since the
substituted content isn't visible to the per-invocation argument scanner.

## Development

```bash
npm test   # unit + hook e2e + multi-process concurrency + installer tests
```

All four suites are fully hermetic: state lives under a fresh temp `ORCH_STATE_DIR`, `orca`
is always a deterministic local stub selected via `ORCA_BIN`, and every path judged by the
gate is synthetic — nothing depends on, or touches, your real `~/.claude/`. Most git-backed
done-worktree checks use an equally deterministic `git` stub (`ORCH_GIT_BIN`); a handful
specifically exercising the ancestor-plus-real-new-commit check instead drive a real,
throwaway git repo and worktrees under the test's own temp directory, since that check's
whole point is real git semantics a stub cannot faithfully stand in for.

## License

MIT — see `LICENSE`.
