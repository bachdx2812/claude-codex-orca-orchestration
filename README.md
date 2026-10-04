# claude-codex-orca-orchestration

Installable [Claude Code](https://claude.com/claude-code) hooks that turn a described
orchestration workflow into a mechanically enforced one: a main panel that only
dispatches and supervises, planning/red-team pinned to one model, review of code pinned
to Opus (regardless of which coder wrote it) while verify-run work (running existing
checks) runs on Sonnet, code spread across Codex, Kimi and DeepSeek peers in [Orca](https://orca.dev)
workers (or an in-session model
once no coder is eligible), every code brief required to name how it will be
verified, and a supervision
loop that will not let the session end with an Orca worker still live and unwatched.

Repo: <https://github.com/bachdx2812/claude-codex-orca-orchestration>

## Who does what

```
Request -> main panel -> Opus 5.5 plans + red-teams -> Codex (gpt-5.6-sol) | Kimi | DeepSeek writes code
[Sonnet only once every coder is unusable or has used >= its handoff threshold of quota,
 read live; separate, configurable thresholds via codexHandoffUsedPercent /
 ORCH_CODEX_HANDOFF_USED, kimiHandoffUsedPercent / ORCH_KIMI_HANDOFF_USED and
 deepseekHandoffUsedPercent / ORCH_DEEPSEEK_HANDOFF_USED]
-> review reads code and judges the diff on Opus; verify runs existing checks on Sonnet
-> main panel reports
```

| Role | What it does | Model (exact version) | How it is dispatched | Config key |
|---|---|---|---|---|
| Main panel (orchestrator) | Takes the request, delegates, supervises workers, reports; never writes code | Session default model | — | `activation` |
| Planner / red-team | Plans, red-teams plans | Opus 5.5 (`claude-opus-5-5`) | `Agent` with `model: "opus"` | `models.review` |
| Reviewer | Code review — reads code and judges the diff | Opus 5.5 (`claude-opus-5-5`), regardless of which coder wrote it | `Agent` with `model: "opus"` per `models.reviewByCoder` | `models.reviewByCoder`, `models.reviewEffort` |
| Verifier | Verify-run — runs existing checks (CI gate, screenshots, play-test, post-deploy smoke), not reading/judging the diff | Sonnet 5.5 (`claude-sonnet-5-5`) | `Agent` with `model: "sonnet"` at `models.verify.effort` | `models.verify` |
| Coder pool (peers) | Every task class previously handled by Codex: code, builds, refactors, tests, bulk conversions, and fix loops | Codex `gpt-5.6-sol` + Kimi (`default_model` in `~/.kimi-code/config.toml`) + DeepSeek (`model` in `~/.config/opencode/opencode.jsonc`) | Spread across eligible Orca workers. Pick the coder with MORE QUOTA LEFT first: a free per-session slot, then more headroom below that coder's own threshold; within `coderHeadroomTieBand` (default 10 points), fewer live workers machine-wide; then the coder other than `lastCoder`; then Codex. A quota-unknown coder ranks as `unknownHeadroomAssumed` (default 30) headroom points; a reset-aware estimate of the last successful reading counts as known. Codex uses `worker-start --agent codex --model gpt-5.6-sol`; Kimi uses `worker-start --agent kimi` without `--model`; DeepSeek uses `worker-start --agent opencode` without `--model`. DeepSeek defaults to `deepseekRole: "overflow"` — picked only once no subscription coder is eligible, before Sonnet. | `models.codex`, `models.kimi`, `models.deepseek`, `deepseekRole`, per-coder caps and thresholds, `coderHeadroomTieBand`, `unknownHeadroomAssumed` |
| Coder (handoff) | Same work once every usable coder has used >= its handoff threshold of its live-read quota (Codex: `codexHandoffUsedPercent`, default 95, override `ORCH_CODEX_HANDOFF_USED`; Kimi: `kimiHandoffUsedPercent`, default 95, override `ORCH_KIMI_HANDOFF_USED`; DeepSeek: `deepseekHandoffUsedPercent`, default 95, override `ORCH_DEEPSEEK_HANDOFF_USED`) or is unusable on this machine | Sonnet | `Agent` with `subagent_type: "sonnet-coder"` + `model: "sonnet"` at `models.code.effort` (default medium; brief must name a verify command) | `codexHandoffUsedPercent`, `kimiHandoffUsedPercent`, `deepseekHandoffUsedPercent`, `models.code` (incl. `effort` / `agentType`), `execFallbackWhenCodexUnavailable` |
| Lookups | Find code, read logs / test output, explore | Haiku | `Agent` with `model: "haiku"` (advised, not enforced) | `models.lookup` |
| Escalation | Only after Opus 5.5 failed even at higher effort; the dispatch must say both | Fable 5.1 (`claude-fable-5-1`) | `Agent` with `model: "fable"` + "escalation: opus failed ... at high effort ..." | `models.escalation` |

An eligible coder is usable on this machine (installed, signed in, and launchable), below
its own handoff threshold, and has a free cap slot. Every coder is optional — a machine
with none of them is fine. Unusable coders are excluded; if all coders are exhausted or
unusable, code goes to Sonnet. Each threshold defaults to 95 and
is independently configurable in `~/.claude/orchestration.config.json` or with
`ORCH_CODEX_HANDOFF_USED` / `ORCH_KIMI_HANDOFF_USED` / `ORCH_DEEPSEEK_HANDOFF_USED`.

### Override from the main panel

`--code-model opus|sonnet|haiku|fable|codex|codex:<model>|kimi|kimi:<model>|deepseek|deepseek:<model>|auto` (session-scoped, last flag
wins; shortcuts `--exec-sonnet`, `--exec-codex`, `--exec-kimi`, `--exec-deepseek`, `--exec-auto`). The per-prompt "Model
routing" line always shows the current coder and why. Active overrides also show when
they were set and how to return to automatic quota routing, both per prompt and in the
`SessionStart` banner.

**Review reads code and judges the diff, always on Opus** (`models.reviewByCoder`, default
all `opus`): code written by any coder (Codex, Kimi, DeepSeek/opencode, or Sonnet) is
reviewed on Opus 5.5 — "code by deepseek/kimi/codex MUST be reviewed by opus". Planning
and red-team stay on Opus. **Verify-run work runs existing checks and always runs on
Sonnet** (`models.verify`, default `{ alias: "sonnet", id: "claude-sonnet-5-5", effort:
"medium" }`): the CI gate, UI screenshots, play-testing, post-deploy smoke — not reading
or judging the diff. An Opus verify is refused unless the dispatch says the mapped Sonnet
verify already ran and could not decide (`escalation: sonnet verify could not decide ...`),
the same "say why" escalation shape as review. Before any code is written the author is
unknown and either review model is allowed.

For Agent/Task descriptions, a recognized first verb governs intent before later nouns do:
`Review ...` and `Plan ...` route to review, `Verify ...` / `Test ...` / `Smoke ...` /
`Re-run ...` route to verify (Sonnet), and `Implement ...` / `Generate code/assets/components ...`
route to code. Operational verbs (`commit`, `push`, `merge`, `publish`, `rebase`, `tag`,
`release`, `deploy`, `update`, `write`) suppress later review nouns, so `Commit review-fix round`
is not mistaken for review work; they do not suppress later code intent (`Update the parser to fix X`).
A brief that both reviews and verifies (`Review and verify X`) counts as review (the stronger
model). A `tester` / `verifier` / `browser-verifier` / `e2e-runner` `subagent_type` is
verify-run work. Code intent in ordinary hyphenated verbs such as `Re-implement` and `Hot-fix`
still counts; only review-style compounds such as `review-fix` are excluded. Code intent also
overrides a review-oriented `subagent_type` when both signals are present.

## Subagents and parallel work

Two kinds of workers do the actual work; only Orca workers need supervision:

| Kind | Examples | Where it runs | How the panel learns it finished |
|---|---|---|---|
| In-session subagent | Opus 5.5 planning/red-team and review, Sonnet verify-run, Sonnet code (handoff), Haiku lookups | Inside the Claude Code session, via the `Agent` tool | The `Agent` call returns its result to the panel when it completes. These hooks never track or gate subagents, so no heartbeat is needed. |
| Orca worker | Codex (`gpt-5.6-sol`), Kimi, or DeepSeek (`opencode`) | A separate session in its own Orca-managed terminal/worktree | `orca-heartbeat.cjs` polls Orca and exits — waking the panel — on a worker state change, this session's own worker terminal going IDLE past `heartbeat.idleSeconds`, making no real progress past its configured stall threshold, losing its Codex app-server connection, an opencode worker still sitting on its welcome screen with no turn marker (brief never delivered), a failed/stopped worker still holding a terminal (a successfully-done one is released and its terminal closed by the daemon itself), this session's terminal becoming orphaned, a rate-limit signal, or one of this session's worktrees whose PR already merged/closed with no live terminal on it (see "Close finished worker panels" below). Context-only `unsupervised` rows, other sessions' worktrees, and the panel's own terminal are excluded. |

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
edits?` confirmations and Claude Code's folder-trust dialogs (`Do you trust the files in
this folder?`, `Only proceed if you trust this configuration`, with the `Enter to confirm ·
Esc to cancel` hint) are included. Only the normalized prompt block, including the
question and command, forms the episode
signature, so rotating tips, timers, and spinners cannot re-fire it. The same approval
prompt is reported at most once per 120s (the report time is persisted, so it survives
daemon restarts); while it is still showing it is reported again after 120s, and a prompt
that disappears re-arms immediately. The heartbeat never answers automatically.

**Worker exited back to a shell prompt.** When a supervised worker's terminal ends at a
shell prompt with no agent TUI visible, the agent process is gone — the heartbeat emits
`WORKER EXITED <dispatch|terminal> (<agent> process gone, terminal at shell prompt)`
immediately (no stall threshold), once per episode, persisted across daemon restarts and
re-armed by fresh terminal output. This catches the recurring failure where an Orca
`--agent claude` worker started in an untrusted worktree stops at Claude Code's
"trust this folder?" dialog (default `No, exit`) and drops to the shell while
`worker-start` still reported success. Prefer Kimi/Codex workers in new worktrees, or a
headless `claude -p --dangerously-skip-permissions ...` launched via `worker-start`; a
bare `orca terminal create` terminal is treated as a main panel, not a worker.

**opencode worker never started.** A `worker-start --agent opencode --spec ...` can report
`input_accepted` while its terminal never runs a turn — the rendered screen stays on the
opencode welcome/home screen (the `Ask anything…` input placeholder, a `● Tip ...` line, the
version footer) with no `▣  Build ·` turn marker and no tool output. After 90 seconds of
continuous welcome-screen time, the heartbeat emits, once per episode (persisted across
daemon restarts):

```text
WORKER NEVER STARTED <dispatch|terminal> (opencode, brief not delivered) - resend the brief: orca terminal send --terminal <terminalHandle> --text '<one-line brief>' --enter
```

The placeholder only counts when it starts its line, so quoted "Ask anything" text (grep
output, this repo's README) is inert; the home screen must also show a `● Tip ...` line or the
`opencode v<digit>` version footer, and the real running footer (a line carrying both
`esc interrupt` and `ctrl+p`) rejects the match — a `● Tip` line that only mentions
esc/interrupt does not. Real opencode screens indent the box gutter, so the gutter is stripped
after the line is trimmed. The 90 seconds must be continuous — any non-welcome screen clears
an unreported episode. A `▣  Build ·` line marks the end of a message and the brief as
delivered: once one has been seen for a worker it is never reported again, even after a `/new`
back to home.

**Mid-task quota handover.** While a supervised Codex, Kimi or DeepSeek worker is live, the
heartbeat
reuses that coder's cached single-flight quota probe. At
`handoverWarnMarginPercent` (default 5) below the coder's own handoff threshold it emits a
once-per-episode warning; at the threshold, or on a terminal usage-exhaustion signal, it
emits `WORKER HANDOVER <dispatch|terminal> (<agent> <used>% >= <threshold>%)`. Handover is
symmetric across every other eligible coder (Codex, Kimi, DeepSeek); it falls back
to Sonnet when none is unavailable or exhausted. The gate repeats
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

**Close finished worker panels.** The heartbeat closes them itself (operator decision,
2026-10-01): when a worker Orca reports successfully done (succeeded/completed in either
`workerState` or `dispatchStatus` — never when either field says failed/stopped/cancelled,
so a contradictory row never closes) and its worktree is clean with nothing unpushed, and
its agent terminal has been quiet past the idle threshold (a done worker may still be
mid-turn), the daemon runs `orca orchestration worker-release --dispatch <id> --json` and
`orca terminal close --terminal <handle> --json` on its own and logs `WORKER CLOSED <id>
(done, terminal closed, worktree kept)` — no panel decision needed. The worktree path is
resolved from the real worker-list row shape (`resource.worktreeId` /
`projection.workspace.id`, `<repoId>::<abs path>`), the same way a terminal's worktree is
resolved; when it cannot be resolved at all, the row falls back to the retain-or-release
event below rather than going silent. A release or terminal-close call Orca answers
`ok: false` to (or cannot answer at all) is never logged or persisted as a success: the
daemon reports `AUTO-CLOSE FAILED <id>` once and retries on a bounded cooldown instead of
hammering Orca every tick. A worker the panel explicitly `worker-retain`ed for reuse
*after* it was already done is left alone. Orca's `resource.retainedReason` tells an
automatic retain apart from an operator one, but `"user_requested"` alone is ambiguous: the
standard Kimi readiness-recovery recipe (`orca terminal send` + `worker-retain`) issues
that same retain on a worker that has not finished yet, and Orca records the identical
`"user_requested"` reason for it as for a deliberate "keep this one open" decision. The
daemon tells them apart by comparing this session's own gate-recorded `retainedAt`
(written by `worker-retain`) against its own first-seen-done timestamp for that worker:
`"identity_unproven"` (Orca's automatic readiness-timeout retain) always stays eligible;
`"user_requested"` is eligible only when the gate recorded a retain that ran strictly
*before* the done transition (`retainedAt < doneAt`, the recovery recipe's shape) — no
gate record at all, or one recorded at or after done, fails CLOSED exactly like
`"user_takeover"` or any other/unknown reason. The panel's own terminal
(`ORCA_TERMINAL_HANDLE`) is never auto-closed. A done
worker with uncommitted or unpushed work wakes the panel once, on the transition into that
state, with `WORKER DONE BUT UNSAVED <id>` and keeps its terminal — re-evaluation
continues, so a worktree later committed and pushed still closes, but the panel is never
re-woken for a state it already saw; failed/stopped/cancelled workers keep the manual
flow: read the result, then `worker-release` yourself. Once a worker's PR is merged or closed and the
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
naming which of these fired in its message. What it does then depends on
`closeDoneWorktrees` (`remove`|`remind`|`off`, default `remind` — check the live
`~/.claude/orchestration.config.json` for this installation's actual value; it is not
necessarily `remove`): in `remove` mode, and ONLY when the worktree currently holds no
live terminal at all (`liveTerminalCount === 0` — a live-but-quiet terminal, such as one
sitting on an approval prompt, falls back to the `remind` behavior below instead of an
irreversible removal), it runs `orca worktree rm --worktree path:<path> --json` itself and
logs an informational `WORKTREE REMOVED <name> (<reason>) — <path>` line, subject to
exactly the never-remove guards above (open PR/MR, uncommitted or unpushed work, the main
worktree, another session's worktree). A failed `rm` (Orca answers `ok: false`, or cannot
answer at all) is never logged or persisted as removed: the daemon reports `WORKTREE RM
FAILED <path>` once, falls back to the `remind` wake event in the same tick, and retries
the removal on a bounded cooldown rather than every tick. In `remind` mode it wakes the
panel with the exact, quoted `orca worktree rm` command and never runs it itself. Every git call only ever runs for a worktree that
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
`closeDoneWorktrees: "off"` or `ORCH_CLOSE_DONE_WORKTREES` set to `remove`/`remind`/`off`
(or the legacy `1`/`true` = remind, `0`/`false` = off) — any other value, including empty,
defers to the config.

**Machine-wide worktree janitor.** The installer registers `hooks/orca-janitor.cjs` as a
macOS LaunchAgent that runs every `janitor.intervalMinutes` (default 10). Unlike the
session-owned heartbeat, it evaluates every local Orca worktree, so cleanup continues after
the panel that created a worktree exits. It removes only a non-main, non-archived worktree
whose `liveTerminalCount` is the known number `0`, which has no unreleased or retained Orca
worker row, has no tracked/untracked changes or non-rebuildable ignored files, and has
nothing unpushed. A deleted upstream is safe only when Git reports exactly `[gone]` and a
merged GitHub PR's `headRefOid` exactly equals local `HEAD`. `janitor.rebuildableIgnored`
configures the ignored-path allowlist (defaults cover dependency, build, cache, and coverage
outputs only). Acceptance includes Orca's linked PR/MR state, a bounded `gh pr list` lookup
by origin repository and branch (5-second timeout, 100-row limit; accepted results cached
for at most two minutes), or the existing ancestor plus reflog proof. Any open GitHub PR
for the head vetoes removal, including when Orca links an older closed PR. Missing or
unauthenticated `gh` falls back to the Git-only rules, but can never prove a deleted upstream
safe. Terminal state is checked again immediately before removal. Results are appended to
`<stateDir>/janitor.log` and rotate near 1 MB. Set `janitor.enabled` to `false` to disable
scheduled runs at execution time; `ORCH_JANITOR=0` affects manual runs (or use
`launchctl setenv ORCH_JANITOR 0`). Changing `janitor.intervalMinutes` requires reinstalling
so the LaunchAgent plist is regenerated; run `node install.mjs --check` after reinstalling.

**Background shell hygiene.** After a successful `PostToolUse`, the gate records this
session's `Bash` launches with `run_in_background: true` until their completion notification
arrives. Tracking clears at `SessionStart` and entries expire after six hours. At
`UserPromptSubmit`, more than three still-running shells produces one reminder
naming the oldest command and age and asking for `TaskStop`. Starting a second heartbeat
also identifies the previous heartbeat shell to stop: keep only one heartbeat per session.
Never leave `sleep`/`until` polling loops running; use the heartbeat instead of ad-hoc wait
loops.

**Enforced vs advisory.** Enforced: gates apply to the main panel only (subagents and
Orca-worker sessions are never gated); `Stop` refuses to end the session while a worker is
running and unwatched (`workers-unwatched` — no live heartbeat) or finished but still
holding a terminal (`workers-unreconciled` — needs `worker-retain` or `worker-release`);
**no more than `maxParallelCodexWorkers` (default 3) live Codex workers at once**
(`max-parallel-codex-workers`) **and no more than `maxParallelKimiWorkers` (default 3)
live Kimi workers at once** (`max-parallel-kimi-workers`) **and no more than
`maxParallelDeepseekWorkers` (default 3) live DeepSeek workers at once**
(`max-parallel-deepseek-workers`); **no more than a MACHINE-wide budget of live Orca workers
(any agent) plus live in-session subagents, summed across every recent session on this
machine** (`max-parallel-agents` — the resource is this machine's cores, not any one
session's own concurrency: `max(1, floor(parallelCoreFraction x cores))` by default, an
explicit `maxParallelAgents` overrides that derivation, `0` = unlimited); **every code
brief in a shared workspace declares the files it will touch**
(`code-brief-needs-owns` — `Owns: <paths>` or `Owns: n/a <reason>`,
on its own line) **and a claim that overlaps another live one is refused**
(`ownership-overlap`, naming the holder and its age).

A terminal worker is already reconciled when it is in a terminal worker/dispatch state and
Orca reports any conclusive resource-detachment signal: `terminalState` is `released` or
`closed`, top-level or `resource.retainedReason` is `no_owned_resource`, its `agentTerminalHandle` is
absent from a successful `orca terminal list`, or that handle now belongs to a different,
newer dispatch. Stop, heartbeat ownership cleanup, and at-cap reconciliation use this same
rule. A running row never settles from one of these signals. A completed
`user_requested` retain whose terminal is still live remains available for reuse, while a
successful `worker-release` or `worker-abandon` reply settles its tracked group immediately
without waiting for worker-list to change.

Prefer `--worktree new-child` (Orca) or Agent `isolation:"worktree"` for genuinely
parallel workers: isolated work needs no `Owns:` at all and can never conflict with
anything, since each isolated dispatch gets a unique workspace key — narrowing an `Owns:`
claim in a *shared* workspace only avoids that specific conflict, not the next one.

| Gate | Refuses when | Escape |
|---|---|---|
| `max-parallel-codex-workers` | a new Codex `worker-start` would exceed `maxParallelCodexWorkers` | release/reuse/retry an existing worker; raise the cap; `ORCH_MAX_PARALLEL_CODEX_WORKERS=0` |
| `max-parallel-kimi-workers` | a new Kimi `worker-start` would exceed `maxParallelKimiWorkers` | release/reuse/retry an existing worker; raise the cap; `ORCH_MAX_PARALLEL_KIMI_WORKERS=0` |
| `max-parallel-deepseek-workers` | a new DeepSeek (`opencode`) `worker-start` would exceed `maxParallelDeepseekWorkers` | release/reuse/retry an existing worker; raise the cap; `ORCH_MAX_PARALLEL_DEEPSEEK_WORKERS=0` |
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
npm test                     # 1852 checks, hermetic (no live Orca/Codex/Kimi/DeepSeek needed)
```

Start a new Claude Code session; its `SessionStart` should print an "ORCHESTRATION
CONTRACT" banner. `node install.mjs --check` reports install status, prerequisite
binaries (`orca`, `codex`, `opencode`), whether Codex looks logged in and whether opencode
is set up for DeepSeek, the effective model-pin environment variable, and any foreign
`orchestrator-gate.cjs` registration. Install warns and leaves a foreign gate intact by
default; rerun with `--replace-foreign-gate` to remove those registrations under the
normal `settings.json` backup. `--help`/`-h` only prints usage, and an unknown option exits
2 without installing. Check mode exits 1 whenever it reports a `MISS`, `FAIL`, or `PROBLEM`.

Both `--check` and the `SessionStart` banner also warn (never edit) when the operator's own
`~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) sets `service_tier = "priority"` —
shown as "fast" in the Codex footer — either as a bare top-level key or inside the
`[profiles.<name>]` section for the profile a top-level `profile = "<name>"` key names as
the default. Operator finding (2026-10-04): that tier burns Codex quota much faster than
the default; removing the line cut burn visibly. Silence the warning once it is a
deliberate choice with `codexAllowPriorityTier: true` in the config, or
`ORCH_CODEX_ALLOW_PRIORITY_TIER=1` for one process.

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
  plan / red-team / escalate  -->  in-session subagent, model = models.review.alias
      |                             (escalation model only after that failed at high effort)
      v
  code  ---->  Codex | Kimi | DeepSeek in an Orca worker  (while its quota allows)
      |            |
      |            v
      |     worker-list / worker-read / worker-release, supervised by orca-heartbeat.cjs
      |
      +--->  in-session subagent, model = models.code.alias
                 (once every coder is exhausted, or via --code-model / --exec-sonnet)
      |
      v
  review  ---->  in-session subagent, model = models.reviewByCoder[<code author>] (all opus)
  verify  ---->  in-session subagent, model = models.verify.alias (sonnet)
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
  "deepseekHandoffUsedPercent": 95,
  "deepseekRole": "overflow",
  "deepseekDailySpendCapUsd": 0,
  "handoverWarnMarginPercent": 5,
  "autoResumeAfterReset": true,
  "autoResumePanel": true,
  "codexQuotaCacheSeconds": 60,
  "kimiQuotaCacheSeconds": 60,
  "deepseekQuotaCacheSeconds": 60,
  "coderAvailabilityCacheSeconds": 600,
  "coderHeadroomTieBand": 10,
  "unknownHeadroomAssumed": 30,
  "models": { "verify": { "alias": "sonnet", "id": "claude-sonnet-5-5", "effort": "medium" }, "reviewByCoder": { "codex": "opus", "kimi": "opus", "deepseek": "opus", "sonnet": "opus" }, "reviewEffort": "medium" },
  "replyLanguage": "Vietnamese",
  "maxParallelCodexWorkers": 5,
  "maxParallelKimiWorkers": 3,
  "maxParallelDeepseekWorkers": 3,
  "ownershipClaimTtlMinutes": 60,
  "disabledGates": ["code-brief-needs-verify"],
  "parallelCoreFraction": 0.8,
  "maxParallelAgents": null
}
```

(`codexHandoffUsedPercent: 90` hands off slightly earlier than the default 95;
`kimiHandoffUsedPercent` and `deepseekHandoffUsedPercent` are each coder's own, separate
threshold (default 95) — all are
used for new routing and live-worker handover. `deepseekRole` (`overflow` default, or
`peer`) and `deepseekDailySpendCapUsd` (`0` = unlimited) control DeepSeek's pay-per-use
routing — in `overflow` mode DeepSeek also takes the dispatch when every eligible
subscription coder (Codex, Kimi) is already at its per-session worker cap; the cap reads
today's DeepSeek spend from opencode's sqlite store
(`~/.local/share/opencode/opencode.db`, `ORCH_OPENCODE_DB` overrides it) or the `deepseek/*`
blocks of `opencode stats --days 1 --models`, and when neither is readable a non-zero cap
makes DeepSeek quota-unknown rather than exhausted. `models.verify` is the model verify-run work (running existing checks)
runs on (default Sonnet 5.5; `ORCH_VERIFY_MODEL` overrides its alias); `models.reviewByCoder` maps the code's author to its review model (defaults shown, all opus);
`models.reviewEffort` sets the in-session reviewer's effort. `handoverWarnMarginPercent` warns that many
percentage points before either threshold (default 5; set 0 to disable the early warning).
tunable via this file or env (`ORCH_CODEX_HANDOFF_USED` / `ORCH_KIMI_HANDOFF_USED` /
`ORCH_DEEPSEEK_HANDOFF_USED`, and `ORCH_REVIEW_MODEL_EXTERNAL` / `ORCH_REVIEW_MODEL_SONNET`);
`kimiQuotaCacheSeconds` / `deepseekQuotaCacheSeconds` and `coderAvailabilityCacheSeconds`
(default 600, the per-machine
"is this coder installed and signed in?" probe TTL) mirror the Codex cache key;
`coderHeadroomTieBand` (default 10) is the headroom-point band within which two coders tie
and the pick falls back to fewer live workers; `unknownHeadroomAssumed` (default 30) is the
headroom a quota-unknown coder is ranked as — below any coder with known headroom >= that
value, above one with less (both blank/unset = default);
`codexQuotaCacheSeconds` controls the cross-process live-reading
cache TTL (`0` disables file-cache reuse but retains memoization inside one hook process);
`replyLanguage` accepts any language name, or `null` for no
language instruction at all; `maxParallelCodexWorkers` / `maxParallelKimiWorkers` /
`maxParallelDeepseekWorkers` raise or
lower how many live
workers of each coder this session may hold at once (`0` = unlimited); `ownershipClaimTtlMinutes`
changes how long a background Agent's `Owns:` claim survives before it auto-expires;
`parallelCoreFraction` (default `0.8`) is the share of this machine's cores the
machine-wide `max-parallel-agents` budget derives its limit from; `maxParallelAgents`
(default `null`, meaning derive it from `parallelCoreFraction x cores`) overrides that
derivation outright, `0` meaning unlimited.)

For every numeric env override — `ORCH_CODEX_HANDOFF_USED` / `ORCH_KIMI_HANDOFF_USED` /
`ORCH_DEEPSEEK_HANDOFF_USED`,
`ORCH_MAX_PARALLEL_CODEX_WORKERS` / `ORCH_MAX_PARALLEL_KIMI_WORKERS` /
`ORCH_MAX_PARALLEL_DEEPSEEK_WORKERS`, and the
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
- `--exec-sonnet` / `--exec-codex` / `--exec-kimi` / `--exec-deepseek` / `--exec-auto` and `--code-model <value>` (see
  `rules/orchestration-contract.md`) let the operator override coding-model routing
  without a full bypass.
- Harness-injected notifications and compaction summaries are never interpreted as fresh
  operator flags, even when they quote an earlier `--no-orchestrate`, `--exec-*`, or
  `--code-model` prompt.
- `--release-claims <toolUseId>` / `--release-claims all` manually frees a stuck `Owns:`
  claim OR a stuck `max-parallel-agents` registration; `maxParallelCodexWorkers: 0`
  (config) or `ORCH_MAX_PARALLEL_CODEX_WORKERS=0` (env) makes the parallel-Codex-worker cap
  unlimited; `maxParallelKimiWorkers: 0` (config) or `ORCH_MAX_PARALLEL_KIMI_WORKERS=0`
  (env) makes the parallel-Kimi-worker cap unlimited; `maxParallelDeepseekWorkers: 0`
  (config) or `ORCH_MAX_PARALLEL_DEEPSEEK_WORKERS=0` (env) makes the parallel-DeepSeek-worker
  cap unlimited; `maxParallelAgents: 0` (config) or `ORCH_MAX_PARALLEL_AGENTS=0` (env) makes
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
the per-coder caps or `maxParallelAgents`, the same boundary every other gate here
respects — these hooks gate the main panel's own dispatches, both at `worker-start` time
and again when that dispatch's own result is registered, so a subagent's coder worker is
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
npm test   # unit + hook e2e + multi-process concurrency + installer + coder-availability
           # + kimi signals/caps + gate wiring + worker-stall + released-groups tests
```

All suites are fully hermetic: state lives under a fresh temp `ORCH_STATE_DIR`, `orca`
is always a deterministic local stub selected via `ORCA_BIN`, and every path judged by the
gate is synthetic — nothing depends on, or touches, your real `~/.claude/`. Most git-backed
done-worktree checks use an equally deterministic `git` stub (`ORCH_GIT_BIN`); a handful
specifically exercising the ancestor-plus-real-new-commit check instead drive a real,
throwaway git repo and worktrees under the test's own temp directory, since that check's
whole point is real git semantics a stub cannot faithfully stand in for.

## License

MIT — see `LICENSE`.
