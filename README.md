# claude-codex-orca-orchestration

Installable [Claude Code](https://claude.com/claude-code) hooks that turn a described
orchestration workflow into a mechanically enforced one: a main panel that only
dispatches and supervises, planning/review/verification pinned to one model, code routed
to Codex in an [Orca](https://orca.dev) worker (or an in-session model once Codex quota
runs low), every code brief required to name how it will be verified, and a supervision
loop that will not let the session end with an Orca worker still live and unwatched.

Repo: <https://github.com/bachdx2812/claude-codex-orca-orchestration>

## Who does what

```
Request -> main panel -> Opus 5.5 plans + red-teams -> Codex (gpt-5.6-sol) writes code
[Sonnet once Codex has used >= 40%] -> Opus 5.5 reviews -> main panel reports
```

| Role | What it does | Model (exact version) | How it is dispatched | Config key |
|---|---|---|---|---|
| Main panel (orchestrator) | Takes the request, delegates, supervises workers, reports; never writes code | Session default model | — | `activation` |
| Planner / red-team | Plans, red-teams plans | Opus 5.5 (`claude-opus-5-5`) | `Agent` with `model: "opus"` | `models.review` |
| Reviewer / verifier | Code review, verification | Opus 5.5 (`claude-opus-5-5`) | `Agent` with `model: "opus"` | `models.review` |
| Coder (default) | Implement / fix / refactor | Codex `gpt-5.6-sol` | Orca worker: `orca orchestration worker-start --agent codex --model gpt-5.6-sol` (brief must name a verify command) | `models.codex` |
| Coder (handoff) | Same work once Codex has used >= `codexHandoffUsedPercent` (default 40) of its quota, or when `orca`/`codex` is not installed | Sonnet | `Agent` with `model: "sonnet"` (brief must name a verify command) | `codexHandoffUsedPercent`, `models.code`, `execFallbackWhenCodexUnavailable` |
| Lookups | Find code, read logs / test output, explore | Haiku | `Agent` with `model: "haiku"` (advised, not enforced) | `models.lookup` |
| Escalation | Only after Opus 5.5 failed even at higher effort; the dispatch must say both | Fable 5.1 (`claude-fable-5-1`) | `Agent` with `model: "fable"` + "escalation: opus failed ... at high effort ..." | `models.escalation` |

### Override from the main panel

`--code-model opus|sonnet|haiku|fable|codex|codex:<model>|auto` (session-scoped, last flag
wins; shortcuts `--exec-sonnet`, `--exec-codex`, `--exec-auto`). The per-prompt "Model
routing" line always shows the current coder and why.

## Subagents and parallel work

Two kinds of workers do the actual work; only Orca workers need supervision:

| Kind | Examples | Where it runs | How the panel learns it finished |
|---|---|---|---|
| In-session subagent | Opus 5.5 review/red-team, Sonnet code (handoff), Haiku lookups | Inside the Claude Code session, via the `Agent` tool | The `Agent` call returns its result to the panel when it completes. These hooks never track or gate subagents, so no heartbeat is needed. |
| Orca worker | Codex (`gpt-5.6-sol`) | A separate session in its own Orca-managed terminal/worktree | `orca-heartbeat.cjs` polls Orca and exits — waking the panel — on a worker state change, IDLE past `heartbeat.idleSeconds`, a finished worker still holding a terminal, an orphaned terminal, or a rate-limit signal. |

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

**Enforced vs advisory.** Enforced: gates apply to the main panel only (subagents and
Orca-worker sessions are never gated); `Stop` refuses to end the session while a worker is
running and unwatched (`workers-unwatched` — no live heartbeat) or finished but still
holding a terminal (`workers-unreconciled` — needs `worker-retain` or `worker-release`);
**no more than `maxParallelCodexWorkers` (default 3) live Codex workers at once**
(`max-parallel-codex-workers`); **every code brief in a shared workspace declares the
files it will touch** (`code-brief-needs-owns` — `Owns: <paths>` or `Owns: n/a <reason>`,
on its own line) **and a claim that overlaps another live one is refused**
(`ownership-overlap`, naming the holder and its age).

Prefer `--worktree new-child` (Orca) or Agent `isolation:"worktree"` for genuinely
parallel workers: isolated work needs no `Owns:` at all and can never conflict with
anything, since each isolated dispatch gets a unique workspace key — narrowing an `Owns:`
claim in a *shared* workspace only avoids that specific conflict, not the next one.

| Gate | Refuses when | Escape |
|---|---|---|
| `max-parallel-codex-workers` | a new Codex `worker-start` would exceed `maxParallelCodexWorkers` | release/reuse/retry an existing worker; raise the cap; `ORCH_MAX_PARALLEL_CODEX_WORKERS=0` |
| `code-brief-needs-owns` | a shared-workspace code brief has no `Owns:`/`Owns: n/a` | declare it, or isolate the dispatch |
| `ownership-overlap` | a claim overlaps another live claim in the same workspace | narrow the claim, wait/release the holder, or isolate |

Advisory only, never blocked by the gate: whether the files a worker actually touched
matched what it declared (ownership is *declared*, not observed).

## What it is

Claude Code hooks are just scripts your settings.json wires to lifecycle events
(`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`). This repo ships
two of them, both zero-dependency Node:

- **`hooks/orchestrator-gate.cjs`** — refuses (exit code 2) a main-panel tool call that
  violates the contract, and prints per-turn reminders (model routing, live-worker
  status). Subagents and Orca-worker sessions are never gated — they do the actual work.
- **`hooks/orca-heartbeat.cjs`** — a background supervision loop the panel starts after
  dispatching a worker. It polls Orca and exits the instant something needs a decision
  (a worker finished, went idle, hit a rate limit, or was orphaned), which is itself the
  wake-up signal for the panel — no polling loop the model has to remember to run.

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
npm test                     # 472 tests, hermetic (no live Orca/Codex needed)
```

Start a new Claude Code session; its `SessionStart` should print an "ORCHESTRATION
CONTRACT" banner. `node install.mjs --check` reports install status, prerequisite
binaries, and the effective model-pin environment variable.

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

## Customise

Edit `~/.claude/orchestration.config.json` (created from
`config/orchestration.config.example.json` on first install; re-read on every hook call,
no restart needed):

The file is plain JSON — no comments — parsed as-is:

```json
{
  "codexHandoffUsedPercent": 60,
  "replyLanguage": "Vietnamese",
  "maxParallelCodexWorkers": 5,
  "ownershipClaimTtlMinutes": 60,
  "disabledGates": ["code-brief-needs-verify"]
}
```

(`codexHandoffUsedPercent: 60` means Codex keeps coding until 60% of its quota is used,
up from the default 40; `replyLanguage` accepts any language name, or `null` for no
language instruction at all; `maxParallelCodexWorkers` raises or lowers how many live
Codex workers this session may hold at once (`0` = unlimited); `ownershipClaimTtlMinutes`
changes how long a background Agent's `Owns:` claim survives before it auto-expires.)

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
- `--no-orchestrate` anywhere in a prompt disables the gates for the rest of that session.
- `--exec-sonnet` / `--exec-codex` / `--exec-auto` and `--code-model <value>` (see
  `rules/orchestration-contract.md`) let the operator override coding-model routing
  without a full bypass.
- `--release-claims <toolUseId>` / `--release-claims all` manually frees a stuck `Owns:`
  claim; `maxParallelCodexWorkers: 0` (config) or `ORCH_MAX_PARALLEL_CODEX_WORKERS=0`
  (env) makes the parallel-Codex-worker cap unlimited.

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
`maxParallelCodexWorkers`, the same boundary every other gate here respects — these hooks
gate the main panel's own dispatches, both at `worker-start` time and again when that
dispatch's own result is registered, so a subagent's Codex worker is never counted twice
or once by accident. `orchestration dispatch --to <handle>` (a context-only send to an
existing terminal, not a new worker) is out of scope for both the parallel-limit and
ownership gates.

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
npm test   # node tests/test-orchestrator-gate.cjs && node tests/test-orchestrator-gate-e2e.cjs
```

Both suites are fully hermetic: state lives under a fresh temp `ORCH_STATE_DIR`, `orca` is
a deterministic local stub selected via `ORCA_BIN`, and every path judged by the gate is
synthetic — nothing depends on, or touches, your real `~/.claude/`.

## License

MIT — see `LICENSE`.
