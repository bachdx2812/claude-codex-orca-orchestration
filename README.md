# claude-codex-orca-orchestration

Installable [Claude Code](https://claude.com/claude-code) hooks that turn a described
orchestration workflow into a mechanically enforced one: a main panel that only
dispatches and supervises, planning/review/verification pinned to one model, code routed
to Codex in an [Orca](https://orca.dev) worker (or an in-session model once Codex quota
runs low), every code brief required to name how it will be verified, and a supervision
loop that will not let the session end with an Orca worker still live and unwatched.

Repo: <https://github.com/bachdx2812/claude-codex-orca-orchestration>

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

**Shipped model versions.** The example config pins exact versions, not just aliases:
review/red-team/verify runs on **Opus 5.5** (`claude-opus-5-5`, alias `opus`), escalation
on **Fable 5.1** (`claude-fable-5-1`, alias `fable`), and Codex worker dispatches default
to **`gpt-5.6-sol`**. `install.mjs` pins both `ANTHROPIC_DEFAULT_OPUS_MODEL` and
`ANTHROPIC_DEFAULT_FABLE_MODEL` to these by default (`--no-pin-models` skips both); edit
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
