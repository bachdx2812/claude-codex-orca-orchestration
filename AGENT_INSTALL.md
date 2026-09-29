# AGENT_INSTALL.md

Exact steps for an AI coding agent installing this repo on a teammate's machine.
Read `rules/orchestration-contract.md` first for what gets enforced and why.

## Who does what

```
Request -> main panel -> Opus 5.5 plans + red-teams -> Codex (gpt-5.6-sol) writes code
[Sonnet once Codex has used >= 40%] -> Opus 5.5 reviews -> main panel reports
```

| Role | Model | Dispatched as | Config key |
|---|---|---|---|
| Main panel | session default; never writes code | — | `activation` |
| Planner / red-team / reviewer / verifier | Opus 5.5 (`claude-opus-5-5`) | `Agent` with `model: "opus"` | `models.review` |
| Coder (default) | Codex `gpt-5.6-sol` | Orca worker (`worker-start --agent codex --model gpt-5.6-sol`) | `models.codex` |
| Coder (handoff) | Sonnet, once Codex used >= `codexHandoffUsedPercent` (40) or `orca`/`codex` missing | `Agent` with `model: "sonnet"` | `codexHandoffUsedPercent`, `models.code` |
| Lookups | Haiku (advised, not enforced) | `Agent` with `model: "haiku"` | `models.lookup` |
| Escalation | Fable 5.1 (`claude-fable-5-1`), only after Opus 5.5 failed at high effort | `Agent` with `model: "fable"` | `models.escalation` |

Operator override: `--code-model opus|sonnet|haiku|fable|codex|codex:<model>|auto`. Full
detail: `README.md#who-does-what` and `rules/orchestration-contract.md`.

**Subagents and parallel work.** In-session subagents (`Agent` tool) return their result
directly and are never tracked by these hooks for supervision purposes — no heartbeat
needed. Orca workers (Codex) run in their own terminal/worktree and must be supervised by
`orca-heartbeat.cjs`, which wakes the panel on a state change, IDLE, a finished-but-held
terminal, an orphan, a rate limit, or a worktree whose PR already merged/closed with no
live terminal left on it; `Stop` refuses to end the session with one live and
unwatched, or finished and unreleased. No more than `maxParallelCodexWorkers` (default 3)
live Codex workers at once; on top of that, a MACHINE-wide `maxParallelAgents` budget
(default `max(1, floor(0.8 x cores))`, `0` = unlimited) caps every live Orca worker group
(any agent) plus every live in-session Agent/Task dispatch, summed across every recent
session on this machine — this one IS registered for every main-panel Agent/Task dispatch
(`s.agents[toolUseId]`), even though it is never tracked for supervision. Any
shared-workspace code brief must declare `Owns: <files>` (or `Owns: n/a <reason>`) so
overlapping claims are caught before either dispatch starts — isolate with
`--worktree new-child` / Agent `isolation:"worktree"` to skip both ownership checks (not
the parallel-agents budget, which every dispatch counts against regardless of isolation).
Full detail: `README.md#subagents-and-parallel-work`.

**Close finished worker panels.** After a worker finishes: read its result, then `orca
orchestration worker-release --dispatch <id>`. Once its PR is merged/closed and the
worktree is clean (no uncommitted or unpushed work), close it too: `orca worktree rm
--worktree path:<path>`. Never remove a worktree with an open PR or unsaved work; sweep
with `orca worktree ps --json`. `closeDoneWorktrees` (default `true`, or
`ORCH_CLOSE_DONE_WORKTREES` set to `1`/`true`/`0`/`false`) controls whether
`orca-heartbeat.cjs` reminds about this automatically — it judges a worktree as
done-but-open only once it is idle, **accepted** (a merged/closed linked GitHub PR or
GitLab MR, or — with neither linked — a real `git merge-base --is-ancestor` confirming HEAD
is already in the worktree's own upstream default branch), and **clean** (`git status
--porcelain` empty, nothing unpushed, or, lacking an upstream, HEAD contained in that same
base). A page Orca itself reports truncated is never acted on, and a daemon restart within
the same session reports a worktree that became done-but-open while it was not running as
a real reminder rather than silently folding it into pre-existing backlog. See
`README.md#subagents-and-parallel-work` for the full acceptance/idle/clean breakdown.

## 1. Prerequisite checks

```bash
node -v                              # need >= 18
claude --version                     # Claude Code CLI
codex --version && ls ~/.codex       # Codex CLI; presence of ~/.codex/auth.json suggests a login, not a guarantee
orca --version                       # or: orca orchestration --help
```

None of these are hard requirements to *install* — `node install.mjs --check` reports
which are missing and what that implies (see "No Orca / no Codex" below). Node >= 18 is
the one hard requirement; the installer refuses to run without it.

## 2. Install

```bash
git clone https://github.com/bachdx2812/claude-codex-orca-orchestration
cd claude-codex-orca-orchestration
node install.mjs --dry-run     # review the plan; writes nothing
node install.mjs               # install
npm test                       # 791 tests, fully hermetic
```

What it does, each step recorded in `~/.claude/hooks/orchestration/install-manifest.json`
so `--uninstall` can reverse exactly this and nothing else:

1. Copies `hooks/*.cjs` (+ `hooks/lib/`) to `~/.claude/hooks/orchestration/` — its own
   directory; no other hook is touched.
2. Copies `rules/orchestration-contract.md` to `~/.claude/rules/` (backs up and asks for
   `--force` if a different file is already there; never silently overwrites).
3. Seeds `~/.claude/orchestration.config.json` from the example, only if absent.
4. Merges hook entries into `~/.claude/settings.json` (backed up first — only when the
   content actually changes, and only the *first* backup this installer ever makes is
   recorded as the rollback target; the command points at the current `node` found via
   `which`/`where`, not a version-manager path that can vanish on a Node upgrade):
   `SessionStart`/`UserPromptSubmit`/`PostToolUse`/`PostToolUseFailure`/`Stop` on matcher
   `*` (`PostToolUseFailure` drops a failed tool call's reservation/ownership claim instead
   of leaking it until the TTL), `PreToolUse` on
   matcher `Edit|Write|MultiEdit|NotebookEdit|Bash|Agent|Task`. Idempotent — re-running
   install detects its own entries by their exact command string and does not duplicate
   them; if the resolved `node` path changed since the last install, the old command
   entries are removed first so the two never coexist.
5. Pins both model versions by default: `env.ANTHROPIC_DEFAULT_OPUS_MODEL` to
   `models.review.id` (**Opus 5.5** / `claude-opus-5-5` in the shipped example config) and
   `env.ANTHROPIC_DEFAULT_FABLE_MODEL` to `models.escalation.id` (**Fable 5.1** /
   `claude-fable-5-1`) in `settings.json`, **each only if that key is not already set to
   something else** — if it is, the installer warns and leaves it alone. `--no-pin-models`
   skips both. Skipped with a warning when `CLAUDE_CODE_USE_BEDROCK` or
   `CLAUDE_CODE_USE_VERTEX` is set (those providers resolve model IDs differently).
6. Appends the orchestration section to `~/.claude/CLAUDE.md` between
   `<!-- orchestration:start -->` / `<!-- orchestration:end -->` markers (replacing the
   block in place on a re-install; creates the file if missing).

If `settings.json` already registers a different `orchestrator-gate.cjs`, install warns
prominently and leaves it in place. Inspect it, then rerun with
`node install.mjs --replace-foreign-gate` to remove only those foreign registrations; the
normal pre-mutation settings backup covers that replacement. `--help`/`-h` and invalid
options never install (`--help` exits 0; invalid options print usage and exit 2).

Steps 1-6 are validated *before* anything is written (settings.json parses, CLAUDE.md
markers are balanced): if either check fails, install aborts with nothing written at all
— never a partial install with hook files on disk but no manifest to account for or
`--uninstall` them.

## 3. Verify

```bash
node install.mjs --check
```

Expect:

- `node`, `claude` versions printed; `orca`/`codex` presence and, for codex, whether an
  auth file is present (not a guarantee it's valid — `codex login` is the real check).
- Install status: every hook file, the rules file, the config file, and settings.json
  present at their recorded paths; the Node path recorded at install still exists, with a
  warning if it sits inside a version-numbered directory (`.../Cellar/node/23.11.0/...`,
  `.../nvm/versions/node/...`) that a later Node upgrade could remove — run `--repair` to
  re-point at the current PATH node if so.
- Hook entries: each of the six events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `PostToolUseFailure`, `Stop`) is checked for real presence in
  `settings.json` — not just that the manifest claims to have added it.
- Foreign gate check: any other registered `orchestrator-gate.cjs` is reported as a
  `PROBLEM`, even when this package is not installed yet.
- Effective environment: whether `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_FABLE_MODEL`
  are set in `settings.json`'s `env` block, a warning if `CLAUDE_CODE_SUBAGENT_MODEL` is
  set (it overrides subagent model routing and can fight this gate's instructions), and
  the effective config (activation mode, Codex handoff threshold, disabled gates, exact
  model ids) as the installed hooks would actually read it.

**Verifying the gate is live requires an Orca terminal**, because the default
`activation: "orca-only"` only governs sessions that carry `ORCA_TERMINAL_HANDLE` (see
"Activation" in `rules/orchestration-contract.md`) — a plain `claude` session outside Orca
is deliberately left ungated. Two ways to confirm:

- Inside an actual Orca-managed terminal: start a fresh Claude Code session there and
  confirm `SessionStart` prints an "ORCHESTRATION CONTRACT" banner naming
  `model "opus" (claude-opus-5-5)`, that any prompt gets a one-line "Model routing: ..."
  reminder appended, and that `/model` (or `settings.json`'s
  `env.ANTHROPIC_DEFAULT_OPUS_MODEL`, which `--check` already prints) shows the pinned
  review model behind its alias.
- A direct, no-session smoke test that exercises the installed hook exactly as Claude Code
  would invoke it, without needing a real Orca terminal open:
  ```bash
  echo '{"hook_event_name":"SessionStart","session_id":"t"}' \
    | ORCA_TERMINAL_HANDLE=x node ~/.claude/hooks/orchestration/orchestrator-gate.cjs \
    | grep "ORCHESTRATION CONTRACT"
  ```
  Prints the banner and exits 0 when the gate is correctly installed and (per
  `activation: "orca-only"`) would apply to any session presented with a terminal handle.
  With `"activation": "always"` in the config, the `ORCA_TERMINAL_HANDLE=x` prefix is not
  needed — every session is gated regardless.

## 4. Customise

Edit `~/.claude/orchestration.config.json` — every hook invocation is its own process and
re-reads this file, so **no restart is needed**:

The file is plain JSON — no comments — parsed as-is:

```json
{
  "codexHandoffUsedPercent": 60,
  "codexQuotaCacheSeconds": 60,
  "replyLanguage": "Vietnamese",
  "disabledGates": ["code-brief-needs-verify"]
}
```

(`codexHandoffUsedPercent: 60` is up from the default 40; `codexQuotaCacheSeconds`
controls the live-reading cache TTL and accepts `0` to disable reuse; `replyLanguage`
accepts any language name, or `null` for no language sentence at all.)

Several more keys gate parallel work: `maxParallelCodexWorkers` (integer 0-32, default 3,
`0` = unlimited) caps how many live Codex `worker-start` dispatches this session may hold
at once — a `--terminal`/`--retry-of` that replaces an existing worker does not count as
new, and a non-Codex agent is never counted; `parallelCoreFraction` (number 0.1-1, default
0.8) and `maxParallelAgents` (integer 0-256 or `null`, default `null`) together derive the
MACHINE-wide `max-parallel-agents` budget — `null` means `max(1, floor(parallelCoreFraction
x cores))`, an explicit integer overrides that derivation outright, `0` means unlimited;
`ownershipClaimTtlMinutes` (default 120) is how long a background in-session Agent's
`Owns:` file claim survives without an explicit release before it auto-expires. All four
are overridable for one process with `ORCH_MAX_PARALLEL_CODEX_WORKERS` /
`ORCH_PARALLEL_CORE_FRACTION` / `ORCH_MAX_PARALLEL_AGENTS` / `ORCH_CLAIM_TTL_MINUTES`. One
more, `closeDoneWorktrees` (default `true`), controls whether `orca-heartbeat.cjs` reminds
about a worktree that is idle, accepted (PR/MR merged or closed, or — when neither is linked
— a git-confirmed ancestor whose own HEAD commit postdates the worktree's creation AND whose
per-worktree HEAD reflog actually records a commit, so a freshly-branched worktree with zero new
commits, or one merely rebased/fast-forwarded onto a base that itself advanced after the
worktree was created, is never mistaken for done-but-open work) and clean, with no live
terminal on it; disable with `false` or `ORCH_CLOSE_DONE_WORKTREES`
set to `0`/`false` (`1`/`true` forces it on; anything else, including empty, defers to the
config). `parallelCoreFraction`/`maxParallelAgents`'s env overrides treat an empty or
whitespace-only value as unset (never coerced to `0`), and their config-file values accept
only an actual JSON number (or `null` for `maxParallelAgents`) — never a numeric string. Every code brief that already
needs a verify command (a Codex `--spec`, or an in-session exec `Agent`/`Task` dispatch)
running in a *shared* workspace must also declare `Owns: <repo-relative paths>` or
`Owns: n/a <reason>` on its own line, unless it is isolated
(`--worktree new-child`/`new-top-level`, or Agent `isolation:"worktree"`) — full detail in
`rules/orchestration-contract.md#parallel-codex-workers-and-file-ownership`.

## 5. Override the coding model from the main panel

The operator can pick who writes code for the rest of the session directly from a prompt:

```
--code-model opus            # the configured review model, for code work specifically
--code-model sonnet          # the configured code model (same as --exec-sonnet)
--code-model haiku           # the configured lookup model, for code work specifically
--code-model fable           # the configured escalation model, for code work specifically
--code-model codex           # Codex in an Orca worker (same as --exec-codex)
--code-model codex:gpt-5-custom   # Codex in an Orca worker, pinned to this model
--code-model auto            # back to automatic routing (same as --exec-auto)
```

The last matching flag in a prompt wins; an invalid value (unknown word, or any character
outside `[a-z0-9._:-]` — so a stray `/` is rejected, never silently truncated) is ignored
with a notice and changes nothing. Picking a Claude alias for code work exempts that
dispatch from the review-model/escalation-model scope gates for code specifically. **With
a `codex`/`codex:<model>` override while the Orca-unreachable fallback is active,
in-session code still runs on the configured code model** — the fallback exists because
Orca cannot be reached at all, so it cannot honor "use Codex" either, regardless of the
standing override.

## 6. No Orca / no Codex

If `orca` is not on `PATH`, or Codex quota is unknown after the live app-server probe and
session-log fallback, automatic routing keeps defaulting to Codex (an unknown Codex quota
is not evidence Codex is unusable) — which will then refuse in-session code dispatches
until you either:

- pass `--exec-sonnet` (or `--code-model <your configured code alias>`) — an honest,
  session-scoped preference that never claims Orca is down, or
- declare the Orca fallback: `date -u +%Y-%m-%dT%H:%M:%SZ >
  ~/.claude/orchestrator-gate/orca-unavailable` (expires after 15 minutes on purpose).

`node install.mjs --check` reports both binaries' presence and codex's apparent login
state up front so this is diagnosed before it becomes a mid-session refusal.

## 7. Escape hatches, uninstall, rollback

```bash
ORCHESTRATOR_GATE=off <your command>     # disables the gate for one invocation/session
# or, inside a Claude Code prompt:
--no-orchestrate
--release-claims <toolUseId>             # manually frees one stuck Owns: claim
--release-claims all                     # manually frees every tracked Owns: claim

node install.mjs --uninstall             # removes hooks, settings.json entries, CLAUDE.md block; keeps config.json
node install.mjs --uninstall --purge     # also removes config.json
node install.mjs --repair                # re-records the current `node` path after a Node upgrade/move
```

Rollback without the uninstaller: every settings.json mutation is preceded by a
`settings.json.bak-<timestamp>` backup in `~/.claude/`; copy the newest one back over
`settings.json` to undo by hand.

## Known limits

- **Codex quota** is queried live through `codex app-server` JSON-RPC
  `account/rateLimits/read`, with no model call, a 5-second parent timeout, and a
  4.5-second helper deadline that SIGKILLs an app-server child which ignores SIGTERM.
  Successful values and failed probes are cached as `codex-quota-live.json` in the gate state directory for
  `codexQuotaCacheSeconds` (default 60); `ORCH_CODEX_QUOTA_CACHE_SECONDS` overrides the
  TTL and `0` disables file-cache reuse while retaining one-hook-process memoization.
  Expired-cache refreshes are single-flight through a short state-directory lease; peers
  use the refreshed or stale value instead of stampeding app-server. If the live probe fails, the gate falls back to
  `~/.codex/sessions/**/*.jsonl` `rate_limits` events no older than six hours
  (`CODEX_HOME` honoured), then reports `unknown`, which keeps Codex as the default.
  Cached live reminders include their age; `rateLimitReachedType` or
  `ordinaryUsageAllowed=false` is labelled `limit reached` and treated as 100% used.
  `ORCH_CODEX_BIN` selects both the probe executable and the binary checked for routing;
  legacy `CODEX_BIN` is still accepted as a lower-priority alias.
- **Orca worker detection** uses `orca orchestration worker-list --json`'s
  `resource.id` field; a context-only `orchestration dispatch --to <handle>` (no
  `resource`) is never treated as a worker, so it stays gated like the main panel.
  The heartbeat likewise excludes `workerState: "unsupervised"` context-only rows and its
  own panel terminal handle from the set it supervises.
- **File ownership (`Owns:`) is declared, not observed** — nothing checks that a worker's
  actual edits stayed within what it claimed. Workers started by a subagent, not the main
  panel, are not tracked or capped by `maxParallelCodexWorkers` or `maxParallelAgents`, the
  same boundary every other gate here respects; a subagent that itself spawns further
  subagents is likewise invisible to `max-parallel-agents` — only the main panel's own
  `Agent`/`Task` dispatches are ever registered.
- **Main-panel gating requires an Orca terminal environment** under the default
  `activation: "orca-only"` config: the gate only governs a session that carries
  `ORCA_TERMINAL_HANDLE` at all (i.e., one launched inside Orca). A plain `claude` session
  outside Orca is left completely alone by default — set `"activation": "always"` to gate
  every session regardless of environment.
- **`orcaInvocations()` (`hooks/lib/shell-orca-invocations.cjs`) is a real linear-time
  shell tokenizer, not a full shell interpreter.** Three known detection gaps (never false
  positives — a real invocation can pass unnoticed): `! orca ...` (negation is not a
  recognized wrapper), `time -p orca ...` (the `time` builtin's own flags are not
  skipped; bare `time orca ...` is), and an orca invocation inside a heredoc body that is
  itself piped into another shell interpreter (heredoc bodies are deliberately treated as
  opaque data). See "Known limitations" in `README.md`.

## `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_FABLE_MODEL` — verified against current docs

Confirmed via <https://code.claude.com/docs/en/model-config> (fetched 2026-09-29, the
`docs.claude.com/en/docs/claude-code/model-config` URL 301-redirects there): both are
real, currently-documented Claude Code environment variables — `ANTHROPIC_DEFAULT_OPUS_MODEL`
is "the model to use for the `opus` alias," `ANTHROPIC_DEFAULT_FABLE_MODEL` is "the model
to use for the `fable` alias, and the model ID Claude Code recognizes as a Fable model for
automatic model fallback." The same page also documents `ANTHROPIC_DEFAULT_SONNET_MODEL`
and `ANTHROPIC_DEFAULT_HAIKU_MODEL` — cross-checked with a web search that returned the
same four variables independently. This installer pins **both** by default (step 5 above):
`ANTHROPIC_DEFAULT_OPUS_MODEL` to `models.review.id`, `ANTHROPIC_DEFAULT_FABLE_MODEL` to
`models.escalation.id`, each independently skipped if already set to something else, and
both together skipped by `--no-pin-models`.
