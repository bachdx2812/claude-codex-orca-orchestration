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
holding a terminal (`workers-unreconciled` — needs `worker-retain` or `worker-release`).
Advisory only, never checked by the gate: how much to parallelize, and whether two
workers' file ownership overlaps.

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
npm test                     # 194 tests, hermetic (no live Orca/Codex needed)
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
  "disabledGates": ["code-brief-needs-verify"]
}
```

(`codexHandoffUsedPercent: 60` means Codex keeps coding until 60% of its quota is used,
up from the default 40; `replyLanguage` accepts any language name, or `null` for no
language instruction at all.)

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

## Development

```bash
npm test   # node tests/test-orchestrator-gate.cjs && node tests/test-orchestrator-gate-e2e.cjs
```

Both suites are fully hermetic: state lives under a fresh temp `ORCH_STATE_DIR`, `orca` is
a deterministic local stub selected via `ORCA_BIN`, and every path judged by the gate is
synthetic — nothing depends on, or touches, your real `~/.claude/`.

## License

MIT — see `LICENSE`.
