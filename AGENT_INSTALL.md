# AGENT_INSTALL.md

Exact steps for an AI coding agent installing this repo on a teammate's machine.
Read `rules/orchestration-contract.md` first for what gets enforced and why.

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
npm test                       # 194 tests, fully hermetic
```

What it does, each step recorded in `~/.claude/hooks/orchestration/install-manifest.json`
so `--uninstall` can reverse exactly this and nothing else:

1. Copies `hooks/*.cjs` (+ `hooks/lib/`) to `~/.claude/hooks/orchestration/` — its own
   directory; no other hook is touched.
2. Copies `rules/orchestration-contract.md` to `~/.claude/rules/` (backs up and asks for
   `--force` if a different file is already there; never silently overwrites).
3. Seeds `~/.claude/orchestration.config.json` from the example, only if absent.
4. Merges hook entries into `~/.claude/settings.json` (backed up first as
   `settings.json.bak-<timestamp>`): `SessionStart`/`UserPromptSubmit`/`PostToolUse`/`Stop`
   on matcher `*`, `PreToolUse` on matcher `Edit|Write|MultiEdit|NotebookEdit|Bash|Agent|Task`.
   Idempotent — re-running install detects its own entries by their exact command string
   and does not duplicate them. Aborts (does not touch the file) if `settings.json` exists
   but is not valid JSON.
5. Pins the review model by default: adds `env.ANTHROPIC_DEFAULT_OPUS_MODEL` (or whichever
   model the config's `models.review.id` says) to `settings.json`, **only if that key is
   not already set to something else** — if it is, the installer warns and leaves it
   alone. `--no-pin-models` skips this step entirely. Skipped with a warning when
   `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX` is set (those providers resolve
   model IDs differently).
6. Appends the orchestration section to `~/.claude/CLAUDE.md` between
   `<!-- orchestration:start -->` / `<!-- orchestration:end -->` markers (replacing the
   block in place on a re-install; creates the file if missing; aborts if the markers are
   unbalanced or duplicated, asking you to fix it by hand first).

## 3. Verify

```bash
node install.mjs --check
```

Expect:

- `node`, `claude` versions printed; `orca`/`codex` presence and, for codex, whether an
  auth file is present (not a guarantee it's valid — `codex login` is the real check).
- Install status: every hook file, the rules file, the config file, and settings.json
  present at their recorded paths; the Node path recorded at install still exists.
- Effective environment: whether `ANTHROPIC_DEFAULT_OPUS_MODEL` is set in
  `settings.json`'s `env` block, and a warning if `CLAUDE_CODE_SUBAGENT_MODEL` is set
  (it overrides subagent model routing and can fight this gate's instructions).

Then start a fresh Claude Code session and confirm:

- `SessionStart` prints an "ORCHESTRATION CONTRACT" banner.
- Any prompt gets a one-line "Model routing: ..." reminder appended.
- `/model` (or checking `settings.json`'s `env.ANTHROPIC_DEFAULT_OPUS_MODEL`, which
  `--check` already prints) shows the pinned review model behind its alias.

## 4. Customise

Edit `~/.claude/orchestration.config.json` — every hook invocation is its own process and
re-reads this file, so **no restart is needed**:

```jsonc
{
  "codexHandoffUsedPercent": 60,        // was 40
  "replyLanguage": "Vietnamese",        // or any language name; null = no language sentence
  "disabledGates": ["code-brief-needs-verify"]
}
```

## 5. Override the coding model from the main panel

The operator can pick who writes code for the rest of the session directly from a prompt:

```
--code-model opus            # the configured review model, for code work specifically
--code-model sonnet          # the configured code model (same as --exec-sonnet)
--code-model haiku           # the configured lookup model, for code work specifically
--code-model fable           # the configured escalation model, for code work specifically
--code-model codex           # Codex in an Orca worker (same as --exec-codex)
--code-model codex:gpt-5.6-luna   # Codex in an Orca worker, pinned to this model
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

If `orca` is not on `PATH`, or Codex has no readable `rate_limits` reading yet, automatic
routing keeps defaulting to Codex (an unknown Codex quota is not evidence Codex is
unusable) — which will then refuse in-session code dispatches until you either:

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

node install.mjs --uninstall             # removes hooks, settings.json entries, CLAUDE.md block; keeps config.json
node install.mjs --uninstall --purge     # also removes config.json
node install.mjs --repair                # re-records the current `node` path after a Node upgrade/move
```

Rollback without the uninstaller: every settings.json mutation is preceded by a
`settings.json.bak-<timestamp>` backup in `~/.claude/`; copy the newest one back over
`settings.json` to undo by hand.

## Known limits

- **Codex quota** is read from `~/.codex/sessions/**/*.jsonl` `rate_limits` events
  (`CODEX_HOME` honoured, defaults to `~/.codex`). No reading yet (a session that hasn't
  finished its first turn) is reported as "unknown," which keeps Codex as the default
  route rather than refusing to route at all.
- **Orca worker detection** uses `orca orchestration worker-list --json`'s
  `resource.id` field; a context-only `orchestration dispatch --to <handle>` (no
  `resource`) is never treated as a worker, so it stays gated like the main panel.
- **Main-panel gating requires an Orca terminal environment** under the default
  `activation: "orca-only"` config: the gate only governs a session that carries
  `ORCA_TERMINAL_HANDLE` at all (i.e., one launched inside Orca). A plain `claude` session
  outside Orca is left completely alone by default — set `"activation": "always"` to gate
  every session regardless of environment.
- **`invokesOrca()`/`orcaCandidates()` are regex-based**, not a proper shell parser — see
  the "Known limitation" note in `README.md` and the `TODO` comment in
  `hooks/orchestrator-gate.cjs`.

## `ANTHROPIC_DEFAULT_OPUS_MODEL` — verified against current docs

Confirmed via <https://code.claude.com/docs/en/model-config> (fetched 2026-09-29, the
`docs.claude.com/en/docs/claude-code/model-config` URL 301-redirects there): this is a
real, currently-documented Claude Code environment variable — "the model to use for the
`opus` alias." The same page also documents `ANTHROPIC_DEFAULT_SONNET_MODEL`,
`ANTHROPIC_DEFAULT_HAIKU_MODEL`, and, as of this writing, **`ANTHROPIC_DEFAULT_FABLE_MODEL`**
("the model to use for the `fable` alias, and the model ID Claude Code recognizes as a
Fable model for automatic model fallback") — cross-checked with a web search that returned
the same four variables independently. This installer only pins
`ANTHROPIC_DEFAULT_OPUS_MODEL` (the review model), per the shipped config's scope; it does
not pin a Fable model, even though the current docs indicate that variable now exists too
— extending the pin to escalation is a deliberate scope decision for a future change, not
a limitation of the underlying Claude Code mechanism.
