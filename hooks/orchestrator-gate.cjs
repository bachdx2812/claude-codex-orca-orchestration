#!/usr/bin/env node
/**
 * orchestrator-gate.cjs — enforces the orchestration contract described in
 * rules/orchestration-contract.md, generated from `config/orchestration.config.json`.
 *
 * Contract (defaults; every noun below is config-driven, see hooks/lib/config.cjs):
 *   1. The main panel is an orchestrator only: it dispatches and supervises. It never
 *      edits or mutates anything itself (outside .claude/, plans/, docs/, scratch, tmp).
 *   2. Planning / review / verification go to the configured review model in-session;
 *      the escalation model only after the review model failed, even at higher effort.
 *   3. Execution and token-heavy work is spread across Codex and Kimi Orca workers, or the configured
 *      in-session code model once neither external coder is eligible,
 *      or whichever model the operator explicitly picked with --code-model.
 *   4. Everything is delegated, parallel wherever ownership allows.
 *   5. Parallel external coder workers hit rate limits; the heartbeat must detect that and retry
 *      with backoff rather than leaving a worker wedged.
 *
 * Main-vs-subagent detection is empirical, not guessed: a main-panel hook payload
 * carries no `agent_id`; an in-session subagent payload carries `agent_id` + `agent_type`.
 * Gates apply to the main panel only — subagents must stay free to do the actual work.
 *
 * Activation (`config.activation`): 'orca-only' (default) gates only sessions that carry
 * `ORCA_TERMINAL_HANDLE` — i.e. sessions actually running inside an Orca-managed
 * terminal, since only those have a worker fleet to delegate to. 'always' gates every
 * session regardless of environment. 'off' disables the gate entirely (same effect as
 * `ORCHESTRATOR_GATE=off`, which always wins regardless of config).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  loadConfig, gateDisabled, handoffUsed, stateDir,
  codexQuotaCacheSeconds, maxParallelCodexWorkers, ownershipClaimTtlMinutes, parallelCoreFraction, maxParallelAgents,
  kimiHandoffUsed, kimiQuotaCacheSeconds, coderAvailabilityCacheSeconds, maxParallelKimiWorkers,
  deepseekRole, deepseekDailySpendCapUsd, deepseekHandoffUsed, deepseekQuotaCacheSeconds,
  maxParallelDeepseekWorkers, reviewModelForCoder, verifyModelAlias,
} = require('./lib/config.cjs');
const WG = require('./lib/worker-groups.cjs');
const PAC = require('./lib/parallel-agent-cap.cjs');
const HBL = require('./lib/heartbeat-liveness.cjs');
const OWN = require('./lib/ownership.cjs');
const OC = require('./lib/ownership-claims.cjs');
const { acquireLock, releaseLock } = require('./lib/file-lock.cjs');
const { hasRateLimitError, hasKimiUsageExhausted, kimiUsageLimitHours, hasDeepseekBalanceExhausted } = require('./lib/terminal-signals.cjs');
const CODER_AVAILABILITY = require('./lib/coder-availability.cjs');
const CODER_POOL = require('./lib/coder-pool-route.cjs');
const EXEC_QUOTA = require('./lib/exec-route-by-quota.cjs');
const HANDOVER = require('./lib/worker-quota-handover.cjs');

const DIR = stateDir();
const LOG = path.join(DIR, 'violations.log');
const CODER_ROUTE_STATE = path.join(DIR, 'coder-route-state.json');
// ORCA_DOWN_FLAG_PATH lets the test suite use a temp flag instead of the real one.
const ORCA_DOWN_FLAG = process.env.ORCA_DOWN_FLAG_PATH || path.join(DIR, 'orca-unavailable');
// ORCA_BIN lets the test suite point at a stub instead of a real `orca` on PATH.
const ORCA_BIN = process.env.ORCA_BIN || 'orca';
// ORCH_CODEX_BIN is the documented override for both reachability and live quota probing.
// CODEX_BIN remains a backwards-compatible alias so existing hermetic setups keep working.
const CODEX_BIN = process.env.ORCH_CODEX_BIN || process.env.CODEX_BIN || 'codex';

// --- tunables ---------------------------------------------------------------
const RATE_LIMIT_BACKOFF_SECONDS = 120; // wait before retrying a rate-limited worker
const ORCA_DOWN_TTL_SECONDS = 900;      // how long an "Orca is down" declaration stays valid
const BACKGROUND_SHELL_STARTUP_GRACE_MS = 10 * 1000;
// Review round 3, item 2: file-lock's own stale-lock detection (staleMs, default 10s) only
// ever fires for a caller whose OWN acquire attempt is still retrying when the lock crosses
// that age. The max-parallel-agents cap paths used to acquire with the library's 2s default
// timeoutMs, which is shorter than staleMs itself - any caller whose attempt started less than
// (staleMs - timeoutMs) = ~8s after a dead holder's lock was created would time out and refuse
// as "contended" before ever living long enough to see it go stale. Every cap-path acquire
// (initial and reconcile-reacquire alike) uses this timeout instead, deliberately longer than
// the default staleMs, so the worst case (a caller starting at the same instant the lock was
// created) still lives long enough to observe and clear a truly abandoned lock itself.
const CAP_LOCK_OPTS = { timeoutMs: 10500 };
const BACKGROUND_SHELL_TTL_MS = 6 * 60 * 60 * 1000;
const hookAdditionalContext = [];

function addHookContext(text) {
  if (text) hookAdditionalContext.push(text);
}

function emitHookNotice(text, eventName) {
  const line = String(text || '').replace(/\n$/, '');
  if (!line) return;
  if (eventName === 'PreToolUse') addHookContext(line);
  else process.stdout.write(`${line}\n`);
}

function flushHookContext(eventName) {
  if (!hookAdditionalContext.length) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: eventName,
    additionalContext: hookAdditionalContext.join('\n'),
  } }));
  hookAdditionalContext.length = 0;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `model "opus" (claude-opus-5-5)` when an exact id is configured, else just the alias. */
function modelLabel(role) {
  return role && role.id ? `"${role.alias}" (${role.id})` : `"${role && role.alias}"`;
}

/**
 * The model a code review / verify dispatch should run on right now, as reminder / banner
 * text: the reviewer mapped to the last code author, e.g. `sonnet (coder: kimi)`, or the
 * configured review model when no code author is known yet.
 */
function reviewRouteText(cfg, s) {
  const mapped = s.lastCodeAuthor ? reviewModelForCoder(cfg, s.lastCodeAuthor) : null;
  const alias = mapped || cfg.models.review.alias;
  return s.lastCodeAuthor ? `${alias} (coder: ${s.lastCodeAuthor})` : alias;
}

/**
 * How to dispatch in-session code on the configured code model (Fix 7), e.g.
 * `sonnet (claude-sonnet-5-5), effort medium: Agent subagent_type sonnet-coder + model sonnet`
 * — plus, when an exact model id is configured, the Orca Claude-worker equivalent
 * (`--model <id> --effort <effort>`). Everything derives from `models.code`.
 */
function codeModelDispatchText(cfg) {
  const code = cfg.models.code;
  const effort = code.effort || 'medium';
  const name = code.id ? `${code.alias} (${code.id})` : `${code.alias}`;
  const base = `${name}, effort ${effort}: Agent subagent_type ${code.agentType || code.alias} + model ${code.alias}`;
  return code.id ? `${base}; Orca Claude worker: --model ${code.id} --effort ${effort}` : base;
}

/**
 * `orcaInvocations()` args are shell words, not a parsed flag table: `--spec=x.md` is one
 * word, not `--spec` followed by `x.md`. `args.includes('--spec')` therefore misses the
 * `=` form entirely - the same gap applies to `--model=`, `--terminal=`, `--agent=codex`.
 * hasFlag/flagValue understand both the space-separated and `=`-joined forms.
 */
function hasFlag(args, flag) {
  return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}
function flagValue(args, flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) return args[i + 1];
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
  }
  return undefined;
}

// --- classification ---------------------------------------------------------

// Paths the main panel may always write: the harness itself, plans, docs, scratch.
// `.claude/` is exempt so the gate can never lock the operator out of repairing it.
const EXEMPT_SEGMENTS = [
  `${path.sep}.claude${path.sep}`,
  `${path.sep}plans${path.sep}`,
  `${path.sep}docs${path.sep}`,
  `${path.sep}scratchpad${path.sep}`,
  `${path.sep}.git${path.sep}`,
];

function isExemptPath(p) {
  if (!p) return true;
  const abs = path.resolve(String(p));
  if (abs.startsWith(os.tmpdir()) || abs.startsWith('/tmp/') || abs.startsWith('/private/tmp/')) return true;
  return `${abs}${path.sep}`.split(path.sep).length > 0 && EXEMPT_SEGMENTS.some((s) => `${abs}${path.sep}`.includes(s));
}

// Bash forms that mutate the repository or the machine.
const MUTATING_BASH = /\b(git\s+(commit|push|merge|rebase|reset\s+--hard|checkout\s+-b)|npm\s+(i|install)\b|pnpm\s+(i|install|add)\b|yarn\s+add\b|pip\s+install\b|sed\s+-i\b|make\b|docker\s+(build|run))/;

// File-moving commands are only a problem when they touch a real workspace;
// shuffling scratch files is ordinary orchestration bookkeeping.
const FILE_MOVING_BASH = /\b(rm\s+-rf?|mv|cp\s+-r)\b/;

/**
 * Split a command line into the individual commands the shell would run.
 * A compound line must be judged per command: one `rm` of a scratch file does
 * not become dangerous because a later `echo` in the same line mentions a path.
 */
function shellSegments(cmd) {
  return shellSyntaxOnly(cmd)
    .replace(/"[^"]*"|'[^']*'/g, ' ') // quoted text is data, not arguments to judge
    .split(/(?:&&|\|\||[;\n|])/)
    .map((seg) => seg.trim())
    .filter(Boolean);
}

/**
 * True when every file-moving command in this line touches only scratch or
 * harness paths, so `rm -rf /tmp/...` stays allowed while `rm -rf src/...`
 * does not. Each segment is judged on its own arguments.
 */
function movesOnlyExemptPaths(cmd) {
  const movers = shellSegments(cmd).filter((seg) => FILE_MOVING_BASH.test(seg));
  if (!movers.length) return true; // nothing is being moved in this line
  return movers.every((seg) => {
    const targets = seg
      .split(/\s+/)
      .slice(1) // drop the command word itself
      .filter((w) => !w.startsWith('-') && /[/.]/.test(w));
    if (!targets.length) return false; // a mover with no visible target is unsafe
    return targets.every((w) => isExemptPath(w));
  });
}
// Shell redirection that writes a file without going through the Write tool.

/**
 * Strip everything that is data rather than shell syntax before looking for
 * redirects: a heredoc body is file content, and a `>` inside it is almost
 * always a comparison or an arrow in the code being written, not a redirection.
 * Without this, writing any script that contains `a > b` reads as a redirect to `b`.
 */
function shellSyntaxOnly(cmd) {
  let s = String(cmd);
  // Drop complete heredoc bodies: <<'TAG' ... TAG / <<TAG ... TAG / <<-TAG ... TAG
  s = s.replace(/<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm, ' <<HEREDOC ');
  // An unterminated heredoc drops from its marker onward.
  s = s.replace(/<<-?\s*(["']?)[A-Za-z_][A-Za-z0-9_]*\1[\s\S]*$/, ' <<HEREDOC ');
  // Comparison and arrow operators are not redirections.
  s = s.replace(/[-=!<>]=|=>|->/g, ' ');
  return s;
}

/**
 * Every path this command would write through a shell redirection.
 *
 * Done in two passes so quoting is respected the way the shell respects it:
 * a `>` inside a quoted string is literal text, while a quoted word after a
 * real operator is still a genuine target. One pass cannot do both.
 */
function redirectTargets(cmd) {
  const s = shellSyntaxOnly(cmd);
  const found = [];
  let m;

  // Pass 1: quoted target immediately after a redirection operator.
  const quoted = /(?:^|\s)(?:>>?|\|\s*tee(?:\s+-a)?)\s+(?:"([^"]+)"|'([^']+)')/g;
  while ((m = quoted.exec(s))) found.push(m[1] || m[2]);

  // Pass 2: blank out every quoted span, so only operators that the shell
  // actually treats as redirection survive, then take unquoted targets.
  const unquotedOnly = s.replace(/"[^"]*"|'[^']*'/g, ' "Q" ');
  const bare = /(?:^|\s)(?:>>?|\|\s*tee(?:\s+-a)?)\s+([^\s;|&()"']+)/g;
  while ((m = bare.exec(unquotedOnly))) found.push(m[1]);

  return found;
}

// Intent of a dispatched task. Generic English verbs — not tied to any operator's roster.
const PLAN_REVIEW_INTENT = /\b(plan|planning|design|review|reviewer|audit|red.?team|critique|assess|architect)\b/i;
// Review of code follows the code's author's mapped reviewer; planning and red-team stay on
// the review model (operator decision, 2026-10-01). Verify-run work (running existing
// checks) is a SEPARATE intent that runs on the verify model, not the review model (operator
// decision, 2026-10-02). A planning object anywhere in the dispatch is planning work whatever
// the first verb; only code nouns route by the code's author. See PLANNING_OBJECT,
// isPlanningReview and the VERIFY_* patterns below.
const PLANNING_FIRST_VERB = /^(plan|planning|design|architect|red.?team)\b/i;
const REVIEW_FIRST_VERB = /^(review|reviewer|audit|critique|assess)\b/i;
// A pure review verb (reading code and judging a diff) — distinct from planning nouns and
// from verify-run verbs. Used for the review-beats-verify rule: a dispatch that both reviews
// and verifies counts as review (the stronger model).
const REVIEW_VERB = /\b(review|reviewer|audit|critique|assess)\b/i;
// Verify-run work (operator decision, 2026-10-02): running checks that already exist — the
// CI gate (check-pr-ci / CI gate), UI screenshots (screenshot / capture UI), play-testing
// (play-test / playtest / play through), post-deploy smoke — rather than reading code and
// judging a diff. Routes to the verify model (models.verify, default sonnet), never the
// review model, which reads code and judges diffs. Only a dispatch that is NOT a plan review
// counts; a brief that both reviews and verifies is review (REVIEW_VERB wins).
const VERIFY_FIRST_VERB = /^(verify|verification|test|run\s+(?:the\s+)?(?:verify|tests?|ci)|smoke|re.?run|check[- ]?(?:pr[- ]?)?ci|screenshot|capture\s+ui|play[- ]?(?:test|through)|playtest)\b/i;
const VERIFY_INTENT = /\b(verify|verification|smoke|re.?run|play[- ]?test|playtest|play\s+through|post[- ]?deploy|deploy\s+verification|browser\s+verify|screenshot|capture\s+ui|check[- ]?pr[- ]?ci|ci\s+gate|run\s+(?:the\s+)?(?:verify|tests?|ci))\b/i;
// A subagent_type that is a verifier makes a dispatch verify-run even when its description
// has no verify verb: the declared role is running checks, not judging code.
const VERIFY_TYPE_HINT = /\b(?:tester|verifier|browser[- ]?verifier|e2e[- ]?runner)\b/i;
const PLANNING_INTENT = /\b(plan|planning|design|red.?team|architect|architecture)\b/i;
// A planning object ANYWHERE in the dispatch — a planning noun, or a `plans/**.md` / `plan.md`
// path — makes it planning work whatever the governing first verb. "Review the plan at
// plans/x/plan.md", "Audit the implementation plan" and "Verify plan claims" are plan reviews
// and must stay on the review model; only code nouns (diff, implementation, PR, commit,
// worker output, branch) route by the code's author. Operator decision, 2026-10-01.
const PLANNING_OBJECT = /\b(plan|planning|design|architecture|architect|phase|phases|red.?team)\b|(?:^|[\s`("'[])(?:plans\/[^\s`"')]+\.md|plan\.md)\b/i;
// A description that names CODE work is a review OF CODE that may merely cite a plan / phase /
// design doc for context. Then only a STRONG planning object in the description itself counts —
// and the prompt body is context, not the task — so a bare "phase"/"design" no longer flips such
// a review to the review model. It must be paired with plan / plans / plan.md / a phase file /
// red-team / design doc / architecture, or a red-team / planner / plan-reviewer subagent_type.
// Without this, a Sonnet review of external-coder code that happens to mention a plan
// or design doc was refused. Operator decision, 2026-10-01.
const CODE_WORK_OBJECT = /\b(diff|implementation|implement|pull\s+request|pr|commit|fix|worker\s+output|branch|code)\b/i;
// A bare plan word must NOT match inside a hyphenated word: "plan-detection narrowing
// commit" cites code work, not a plan. The lookarounds reject a `-`/word char on either
// side while still matching a whole word and the `plans/**.md` / `plan.md` path forms.
// `design doc` and `architecture` are strong planning words; a bare `design` is not.
const STRONG_PLANNING_OBJECT = /(?<![\w-])(plan|plans|planning)(?![\w-])|\bred[-\s]?team\b|\bdesign[\s-]+docs?\b|\barchitecture\b|\bphase[\s-]*(?:\d+[\s-]*)?file\b|(?:^|[\s`("'[])(?:plans\/[^\s`"')]+\.md|plan\.md)\b/i;
// A subagent_type that is red-team / planner / plan-reviewer makes a dispatch planning even
// when its description names code work: the type is the operator's declared role, so it wins.
const PLANNING_TYPE_HINT = /\bred-?team\b|planner|plan[- ]reviewer/i;
const EXEC_INTENT = /(?<!\w)(?<!\b(?:review|plan|design|audit|verify|red.?team)-)(implement|implementation|build|refactor|migrate|scaffold|execute|fix\s|write\s+(the\s+)?code|codegen|generate\s+(code|assets|components))\b/i;
// A code-review noun in the summary — something you JUDGE rather than run or do: a diff, a
// pull request, commit(s), an implementation. Sitting next to a verify verb it marks the
// dispatch as review (the stronger model) rather than verify-run, so "Verify the PR diff is
// correct" is review work, not running existing checks. Deliberately narrower than
// CODE_WORK_OBJECT: exec verbs (fix/implement) do not count here — they route to the coder,
// and a bare "code"/"branch" (or the "PR" abbreviation) does not either, so "Verify the code
// compiles" and "Run tests on the PR branch" stay verify-run (running checks, not judging).
const REVIEW_NOUN = /\b(diff|pull\s+request|commits?|implementation)\b/i;
// "Test and fix ...", "Run tests then implement ...", "Verify and fix ..." — a verify/test
// verb COORDINATED with a later exec action means the user wants code written, not just
// checks run ("verify the build" runs the build; it does not write code). The coordinator
// ("and"/"then"/"also", with the code verb right after it) is what separates a genuine exec
// action from the object of a verify verb, so the B1 exec-over-verify rule fires only on this
// coordinated shape (a bare comma is not a coordinator).
const VERIFY_THEN_EXEC = /\b(?:verify|verification|test|tests|check|checks|ci)\b[^.;]*?\b(?:and|then|also)\s+(?:then\s+)?(?:implement|refactor|migrate|scaffold|fix|write\s+(?:the\s+)?code|codegen|generate\s+(?:code|assets|components))\b/i;
const PLAN_REVIEW_FIRST_VERB = /^(plan|design|review|audit|red.?team|critique|assess|architect)\b/i;
const EXEC_FIRST_VERB = /^(implement|build|refactor|migrate|scaffold|execute|fix|codegen|generate\s+(code|assets|components))\b/i;
const NEUTRAL_FIRST_VERB = /^(commit|push|merge|publish|rebase|tag|release|deploy|update|write)\b/i;
// 'Write' + a CODE OBJECT is code intent, not the operational write (operator decision,
// 2026-10-02): "Write the payment module", "Write e2e tests for checkout" and "Write the
// cache layer" route to the coder (verify command + Owns in a shared workspace, author
// recorded), while "Write" + a document/plan object stays operational ("Write the release
// notes", "Write a plan for X", "Write docs for the API"). The object is decided from the
// NOUN being written — the words right after "write", up to the first preposition (for, of,
// on, about, in, to, from, with, against) or punctuation — never from any code word anywhere
// in the description, so a document brief whose modifiers merely mention code words
// ("Write a summary of the test run", "Write docs for the parser module", "Write a test
// plan for checkout") stays operational. It is CODE only when the LAST of those noun words
// is a code word AND none of them is a document word. Only the FIRST verb "write" counts,
// so a later write inside a verify-run summary ("Run tests and write a summary") stays
// verify-run.
const CODE_NOUNS = new Set([
  'module', 'modules', 'function', 'functions', 'class', 'classes',
  'component', 'components', 'test', 'tests', 'code', 'implementation', 'implementations',
  'endpoint', 'endpoints', 'handler', 'handlers', 'script', 'scripts',
  'migration', 'migrations', 'hook', 'hooks', 'parser', 'parsers',
  'layer', 'layers', 'service', 'services', 'feature', 'features',
]);
const DOC_NOUNS = new Set([
  'summary', 'summaries', 'docs', 'doc', 'notes', 'note', 'plan', 'plans',
  'report', 'reports', 'review', 'reviews', 'readme', 'changelog',
  'message', 'messages', 'design', 'designs', 'spec', 'specs', 'handover',
]);
const WRITE_OBJECT_STOP = /^(?:for|of|on|about|in|to|from|with|against)$/i;
const WRITE_OBJECT_PUNCT = /[,!?;:()[\]{}"'`]/g;

function writeCodeObject(desc) {
  const text = String(desc || '');
  if (!/^write\b/i.test(text)) return false;
  const words = [];
  for (const token of text.replace(/^write\b/i, '').split(/\s+/)) {
    if (!token) continue;
    const bare = token.replace(WRITE_OBJECT_PUNCT, '');
    const lower = bare.toLowerCase();
    if (WRITE_OBJECT_STOP.test(lower)) break;
    words.push(lower);
    if (bare.length !== token.length) break; // punctuation ends the noun phrase
  }
  if (!words.length) return false;
  const last = words[words.length - 1];
  return CODE_NOUNS.has(last) && !words.some((w) => DOC_NOUNS.has(w));
}
const LOOKUP_INTENT = /\b(find|locate|search|grep|scout|explore|look\s*up|where\s+is|list\s+(all|the)|read\s+(the\s+)?(log|logs|output)|summari[sz]e\s+(the\s+)?(log|logs|output|test\s+results?))\b/i;
// A code brief must let the coder check itself: a concrete test / build / lint command,
// or an explicit "verify: n/a <reason>".
const VERIFY_COMMAND = /(\b(pytest|vitest|jest|playwright|tsc|ruff|eslint|mypy|pyright|phpunit|rspec)\b|\bnpm\s+(run\s+)?(test|build|lint|typecheck|type-check|check)\b|\b(pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check)\b|\bgo\s+(test|build|vet)\b|\bcargo\s+(test|build|check|clippy)\b|\bmake\s+(test|check|build|lint)\b|\b(mvn|gradlew?|dotnet)\s+test\b|\bpython[\d.]*\s+-m\s+(pytest|unittest)\b|\bnode\s+\S*test\S*|\bverify:\s*n\/a\s+\S)/i;

// True when a dispatch to the escalation model carries an explicit reason that the
// review model already failed, at higher effort. Built from config so the exact review
// alias (default "opus") is never hard-coded.
function hasEscalationReason(cfg, input) {
  const reviewAlias = escapeRegex(cfg.models.review.alias || 'review');
  const effortTried = new RegExp(
    `\\b(high|max|xhigh|ultra)[\\s-]*(reasoning|effort|thinking)\\b|\\beffort\\s*[:=]?\\s*(high|max|xhigh)\\b|\\b(${reviewAlias}|--effort)\\W{0,3}(high|xhigh|max)\\b|\\bultrathink\\b|\\bextended\\s+thinking\\b|\\bthink(ing)?\\s+harder\\b`,
    'i'
  );
  const escalationMarker = new RegExp(
    `\\bescalation:\\s*\\S|\\b${reviewAlias}\\s+(was\\s+)?(failed|could\\s*n[o'’]t|cannot|can[’']t|unable|stuck)\\b`,
    'i'
  );
  const text = `${input.description || ''} ${String(input.prompt || '').slice(0, 300)}`;
  return escalationMarker.test(text) && effortTried.test(text);
}

// True when a review dispatch explicitly escalates to the review model after the mapped
// reviewer could not decide — the review ladder's "say why in the dispatch" rule (operator
// decision, 2026-10-01), mirroring hasEscalationReason's marker shape. `reviewerAlias` is
// the model the mapped review (e.g. sonnet for external-authored code) actually ran on.
function hasReviewEscalationReason(input, reviewerAlias) {
  const alias = escapeRegex(reviewerAlias || 'sonnet');
  const marker = new RegExp(
    `\\bescalation:\\s*\\S|\\b${alias}\\s+(?:review\\s+)?(?:was\\s+)?(?:failed|could\\s*n[o'’]t|cannot|can[’']t|unable|undecided|inconclusive|stuck)\\b`,
    'i'
  );
  const text = `${input.description || ''} ${String(input.prompt || '').slice(0, 300)}`;
  return marker.test(text);
}

/**
 * True when a verify-run dispatch escalates to the review model after the verify model could
 * not decide — the same "say why in the dispatch" shape as hasReviewEscalationReason, so an
 * Opus verify of a check the Sonnet verify already ran and could not conclude is allowed.
 */
function hasVerifyEscalationReason(input, verifyAlias) {
  const alias = escapeRegex(verifyAlias || 'sonnet');
  const marker = new RegExp(
    `\\bescalation:\\s*\\S|\\b${alias}\\s+(?:verify\\s+)?(?:was\\s+)?(?:failed|could\\s*n[o'’]t|cannot|can[’']t|unable|undecided|inconclusive|stuck)\\b`,
    'i'
  );
  const text = `${input.description || ''} ${String(input.prompt || '').slice(0, 300)}`;
  return marker.test(text);
}

/**
 * True when a plan/review-intent dispatch is PLANNING or red-team work (always the review
 * model) rather than a review of code (which follows the code's author). A planning object
 * (a planning noun, or a plans/**.md path) ANYWHERE in the description, subagent_type or
 * prompt head wins over the first verb, so a "Review / Audit / Verify the plan" dispatch
 * stays on the review model. With no planning object, the governing first verb decides.
 */
function isPlanningReview(description, type, prompt) {
  const head = String(prompt || '').slice(0, 400);
  const desc = String(description || '');
  // A review of code (the description names a diff, an implementation, a PR, a commit, a fix,
  // worker output, a branch or code) keeps the coder-mapped reviewer even when it cites a
  // plan / phase / design doc for context: only a STRONG planning object in the description
  // counts, and the prompt body is context. A bare "phase"/"design" mention is not planning.
  if (CODE_WORK_OBJECT.test(desc)) {
    // The description names code work, but a red-team / planner / plan-reviewer subagent_type
    // is ALWAYS planning: the declared role beats a code noun in the summary.
    return STRONG_PLANNING_OBJECT.test(desc) || PLANNING_FIRST_VERB.test(desc) ||
      STRONG_PLANNING_OBJECT.test(type) || PLANNING_TYPE_HINT.test(type);
  }
  if (PLANNING_OBJECT.test(desc) || PLANNING_OBJECT.test(type) || PLANNING_OBJECT.test(head)) return true;
  if (PLANNING_FIRST_VERB.test(desc)) return true;
  if (REVIEW_FIRST_VERB.test(desc)) return false;
  return PLANNING_INTENT.test(desc) || PLANNING_INTENT.test(type);
}

/**
 * Classify a dispatched Agent/Task into one routing intent. Precedence is deliberate and
 * matches the routing gates that consume the result:
 *
 *   1. EXEC — even behind a verify/test first verb. "Test and fix the login flow" /
 *      "Run tests then implement the fix" / "Verify and fix the failing parser test" all
 *      carry code intent and must route to the coder pool, never the verify model (B1).
 *   2. REVIEW — a reviewer subagent_type, a review verb, or a code noun (diff / PR /
 *      commit(s) / code) next to a verify verb beats verify (the stronger model): "Verify
 *      the PR diff is correct" is judging a diff, not running checks (B2).
 *   3. VERIFY — running existing checks on the verify model, never a lookup role type
 *      (agents.lookup), which is advisory lookup work and never blocks.
 *
 * Returns { firstIntent, wantsExec, wantsPlanReview, wantsVerify, planning }.
 */
function classifyDispatch(description, type, prompt, lookupTypes) {
  const desc = String(description || '').trim();
  const t = String(type || '');
  const hay = `${t} ${desc}`.trim() || String(prompt || '').slice(0, 400);
  // 'Write' + a code object is a code first verb (operator decision, 2026-10-02): the
  // verifier type hint must not override it, so "Write the payment module" from a tester /
  // "Write e2e tests for checkout" from an e2e-runner routes to the coder, never the verify
  // model. Only the FIRST verb "write" counts, so "Run tests and write a summary" stays
  // verify-run.
  const writeCodeFirstVerb = writeCodeObject(desc);
  const firstIntent = PLAN_REVIEW_FIRST_VERB.test(desc) ? 'review'
    : VERIFY_FIRST_VERB.test(desc) ? 'verify'
      : (EXEC_FIRST_VERB.test(desc) || writeCodeFirstVerb) ? 'exec'
        : NEUTRAL_FIRST_VERB.test(desc) ? 'neutral'
          : null;
  const planAt = hay.search(PLAN_REVIEW_INTENT);
  const verifyAt = hay.search(VERIFY_INTENT);
  const execAt = hay.search(EXEC_INTENT);
  const typeWantsPlanReview = PLAN_REVIEW_INTENT.test(t);
  const typeWantsVerify = VERIFY_TYPE_HINT.test(t);
  const typeIsLookup = Array.isArray(lookupTypes) &&
    lookupTypes.some((n) => String(n).toLowerCase() === t.toLowerCase());
  // Planning / red-team is always the review model (never verify), whatever the first verb.
  const planning = isPlanningReview(desc, t, prompt);
  const reviewVerbPresent = REVIEW_VERB.test(desc);
  const reviewNounPresent = REVIEW_NOUN.test(desc);

  // B1: exec intent behind a verify/test first verb is still execution, so it routes to the
  // coder pool, records the author, and requires a verify command — never the verify model.
  // A review first verb still wins over exec. Only a COORDINATED verify-then-exec action
  // counts: "verify the build" is verify-run (the build is the object), "Verify and fix ..."
  // is code (fix is a coordinated action). A verifier subagent_type (tester / verifier /
  // browser-verifier / e2e-runner) is never code from a neutral or verify-first summary, but
  // a code verb as the summary's FIRST verb is still code: "Implement the payment module"
  // from a tester is execution, not verify-run.
  const wantsExec = firstIntent === 'exec' || (!typeWantsVerify && (
    (firstIntent !== 'review' && firstIntent !== 'verify' && execAt >= 0 &&
      (firstIntent === 'neutral' || planAt < 0 || execAt < planAt)) ||
    (firstIntent === 'verify' && VERIFY_THEN_EXEC.test(hay))));

  // B2: review beats verify — a reviewer type, a review verb, or a code noun next to a
  // verify verb is review work (the stronger model), never verify. A code noun with a verify
  // verb but no governing first verb is also review ("Check the PR diff; verify tests pass").
  const wantsPlanReview = !wantsExec && (
    firstIntent === 'review' ||
    (firstIntent === 'verify' && (planning || reviewVerbPresent || typeWantsPlanReview || reviewNounPresent)) ||
    (firstIntent !== 'exec' && firstIntent !== 'verify' && typeWantsPlanReview) ||
    (!firstIntent && planAt >= 0 && (execAt < 0 || planAt < execAt)) ||
    (!firstIntent && reviewNounPresent && verifyAt >= 0 && (execAt < 0 || verifyAt < execAt))
  );

  // A lookup role type is advisory lookup work, never verify (and never exec/review): the
  // operator declared a find/locate role, so a verify verb in its summary must not force the
  // verify model.
  const wantsVerify = !typeIsLookup && !planning && !wantsExec && !wantsPlanReview && (
    firstIntent === 'verify' ||
    (firstIntent !== 'review' && typeWantsVerify) ||
    (!firstIntent && verifyAt >= 0 && (execAt < 0 || verifyAt < execAt) && (planAt < 0 || verifyAt < planAt))
  );

  return { firstIntent, wantsExec, wantsPlanReview, wantsVerify, planning };
}

// Markers that an orca command itself failed, which justifies the in-session fallback.
const ORCA_FAILURE = /(command not found|connection refused|runtime (not|un)reachable|ECONNREFUSED)/i;

// --- state ------------------------------------------------------------------

function stateFile(sid) {
  return path.join(DIR, `${String(sid || 'default').replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

function blank(sid) {
  return {
    session_id: sid || 'default',
    created: new Date().toISOString(),
    bypass: false,
    bypassSince: null,
    execAgent: null,        // null (auto by pool) | 'codex' | 'codex:<model>' | 'kimi' | 'kimi:<model>' | 'claude:<alias>'
    execAgentSince: null,
    workers: {},            // label -> { role, started, status, last_seen, rate_limited_until,
                             //            group, kind, agent, owns, ws }
    reservations: {},       // "<toolUseId>#<idx>" -> { ts, agent, owns, ws, codexSlot, newSlot, commandHash } —
                             // the gap between a Bash dispatch being admitted and its PostToolUse resolving it
    agentClaims: {},        // toolUseId -> { owns, ws, ts } — in-session Agent/Task Owns: claims
    agents: {},             // toolUseId -> { ts, background, type, model } — EVERY main-panel
                             // Agent/Task dispatch (not only code briefs), for the machine-wide
                             // max-parallel-agents budget; see lib/parallel-agent-cap.cjs
    backgroundShells: {},   // toolUseId -> { command, started, heartbeat, heartbeatPid } for Bash
                            // run_in_background launches still awaiting completion notice
    sessionStartedAt: Date.now(),
    tasks: {},              // taskId -> { owns, ws } — recorded when `task-create` resolves its id
    last_heartbeat: 0,      // epoch ms of the last worker-status poll
    lastCodeAuthor: null,   // author of this session's pending code: 'codex' | 'kimi' |
                            // 'deepseek' (the last external code worker group, opencode ->
                            // deepseek) | 'sonnet' (the last in-session code dispatch)
    lastCodeAuthorAt: 0,    // epoch ms of that author's dispatch/finish, so a late settle
                            // of an older group never clobbers a newer code event
    rate_limit_hits: 0,
  };
}

function validPersistedExecAgent(value) {
  return value === null || value === 'codex' || value === 'kimi' || value === 'deepseek' ||
    (typeof value === 'string' && (/^codex:.+/.test(value) || /^kimi:.+/.test(value) || /^deepseek:.+/.test(value) || /^claude:.+/.test(value)));
}

function load(sid) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(sid), 'utf8'));
    if (!Object.prototype.hasOwnProperty.call(s, 'execAgent')) {
      s.execAgent = null;
    } else if (!validPersistedExecAgent(s.execAgent)) {
      s.execAgent = null;
    }
    if (s.execAgent == null && s.execAgentSince != null) {
      s.execAgentSince = null;
    }
    if (!Object.prototype.hasOwnProperty.call(s, 'execAgentSince')) s.execAgentSince = null;
    if (!Object.prototype.hasOwnProperty.call(s, 'bypassSince')) s.bypassSince = null;
    // Back-fill fields a state file written before this gate's ownership/parallel-limit
    // work existed would not have, so an in-progress session never crashes on upgrade.
    if (!s.reservations) s.reservations = {};
    if (!s.agentClaims) s.agentClaims = {};
    if (!s.agents) s.agents = {};
    if (!s.backgroundShells) s.backgroundShells = {};
    if (!Number.isFinite(s.sessionStartedAt)) s.sessionStartedAt = Date.now();
    if (!s.tasks) s.tasks = {};
    if (!Object.prototype.hasOwnProperty.call(s, 'lastCodeAuthor')) s.lastCodeAuthor = null;
    if (!Object.prototype.hasOwnProperty.call(s, 'lastCodeAuthorAt')) s.lastCodeAuthorAt = 0;
    return s;
  } catch {
    return blank(sid);
  }
}

function repairInvalidPersistedExecAgent(sid, eventName) {
  let candidate;
  try { candidate = JSON.parse(fs.readFileSync(stateFile(sid), 'utf8')); } catch { return; }
  if (!Object.prototype.hasOwnProperty.call(candidate, 'execAgent') || validPersistedExecAgent(candidate.execAgent)) return;

  const lockDir = path.join(DIR, '.lock');
  const locked = acquireLock(lockDir, {});
  if (!locked) return;
  try {
    let fresh;
    try { fresh = JSON.parse(fs.readFileSync(stateFile(sid), 'utf8')); } catch { return; }
    if (!Object.prototype.hasOwnProperty.call(fresh, 'execAgent') || validPersistedExecAgent(fresh.execAgent)) return;
    const invalid = fresh.execAgent;
    fresh.execAgent = null;
    fresh.execAgentSince = null;
    writeJsonAtomic(stateFile(sid), fresh);
    emitHookNotice(
      `orchestrator-gate: invalid persisted execAgent ${JSON.stringify(invalid)}; using automatic quota routing.`,
      eventName);
  } finally {
    releaseLock(lockDir);
  }
}

// Atomic write: a concurrent hook must never read a half-written file and fall back to blank().
function writeJsonAtomic(file, value) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  } catch {}
}

function save(s) {
  writeJsonAtomic(stateFile(s.session_id), s);
}

function logViolation(s, gate, detail) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()}\t${s.session_id}\t${gate}\t${String(detail).split('\n')[0]}\n`);
  } catch {}
}

function deny(s, gate, reason) {
  // An Orca worker session is never gated. Asked only here, when a refusal is
  // about to happen, so allowed tool calls never pay for an orca round-trip.
  if (isOrcaWorkerSession(s)) process.exit(0);
  logViolation(s, gate, reason);
  process.stderr.write(`[orchestrator-gate:${gate}] ${reason}\n`);
  process.exit(2);
}

/**
 * True while the in-session execution fallback is legitimately open.
 *
 * The declaration **expires**. A permanent flag is the worst failure this gate
 * could have: one transient Orca hiccup would silently disable the Codex-in-Orca
 * rule forever, and nothing would ever say so. An expired flag is deleted, so
 * the next dispatch is judged against Orca's real availability again.
 */
function orcaFallbackActive() {
  let stamp;
  try {
    stamp = fs.readFileSync(ORCA_DOWN_FLAG, 'utf8').trim();
  } catch {
    return false;
  }
  const declaredAt = Date.parse(stamp);
  // An unparsable or missing timestamp is treated as "declared by hand, just now"
  // only if the file itself is recent; otherwise it has outlived its purpose.
  const at = Number.isNaN(declaredAt) ? (() => { try { return fs.statSync(ORCA_DOWN_FLAG).mtimeMs; } catch { return 0; } })() : declaredAt;
  if (Date.now() - at <= ORCA_DOWN_TTL_SECONDS * 1000) return true;
  try { fs.unlinkSync(ORCA_DOWN_FLAG); } catch {}
  return false;
}

/** Map a --code-model value to the stored override, or 'invalid'. null = automatic. */
function parseCodeModel(cfg, v) {
  const x = String(v || '').toLowerCase();
  if (!/^[a-z0-9._:-]+$/.test(x)) return 'invalid'; // e.g. codex:openai/gpt-5 - never truncate silently
  if (x === 'auto') return null;
  if (x === String(cfg.models.code.alias || '').toLowerCase()) return `claude:${cfg.models.code.alias}`;
  if (x === String(cfg.models.review.alias || '').toLowerCase()) return `claude:${cfg.models.review.alias}`;
  if (x === String(cfg.models.escalation.alias || '').toLowerCase()) return `claude:${cfg.models.escalation.alias}`;
  if (x === String(cfg.models.lookup.alias || '').toLowerCase()) return `claude:${cfg.models.lookup.alias}`;
  if (x === 'codex') return 'codex';
  if (x.startsWith('codex:') && x.length > 6) return `codex:${x.slice(6)}`;
  if (x === 'kimi') return 'kimi';
  if (x.startsWith('kimi:') && x.length > 5) return `kimi:${x.slice(5)}`;
  if (x === 'deepseek' || x === 'opencode') return 'deepseek';
  if ((x.startsWith('deepseek:') && x.length > 9) || (x.startsWith('opencode:') && x.length > 9)) return `deepseek:${x.slice(x.indexOf(':') + 1)}`;
  if (/^gpt-/.test(x) || (cfg.models.codex.id && x === String(cfg.models.codex.id).toLowerCase())) return `codex:${x}`;
  return 'invalid';
}

// Linear-time shell scanner: every real `orca <sub>` invocation a shell would actually
// execute in a command line (see lib/shell-orca-invocations.cjs for the tokenizer and why
// a previous regex-based detector was replaced - it had a plausible catastrophic-
// backtracking shape on adversarial input, among other correctness gaps).
const { orcaInvocations } = require('./lib/shell-orca-invocations.cjs');

function describeOverride(cfg, o) {
  if (o === 'codex') return 'Codex in an Orca worker';
  if (o.startsWith('codex:')) return `Codex (${o.slice(6)}) in an Orca worker`;
  if (o === 'kimi') return 'Kimi in an Orca worker';
  if (o.startsWith('kimi:')) return `Kimi (${o.slice(5)}, set as default_model in ~/.kimi-code/config.toml; Orca cannot pin it) in an Orca worker`;
  if (o === 'deepseek') return 'DeepSeek (opencode) in an Orca worker';
  if (o.startsWith('deepseek:')) return `DeepSeek (${o.slice(9)}, set as model in ~/.config/opencode/opencode.jsonc; Orca cannot pin it) in an Orca worker`;
  return `in-session Agent with model "${o.slice(7)}"`;
}

/** The pool coder name for a worker agent (opencode runs DeepSeek). */
function poolCoderForAgent(agent) {
  return agent === 'opencode' ? 'deepseek' : agent;
}

/** The pool coder whose code a worker group carried, or null for a non-code group (a
 * terminal create, an unknown agent). opencode counts as deepseek. */
function codeAuthorOfGroup(workers, group) {
  for (const [key, w] of Object.entries(workers || {})) {
    if (WG.groupOf(w, key) !== group) continue;
    const coder = poolCoderForAgent(w.agent);
    if (['codex', 'kimi', 'deepseek'].includes(coder)) return coder;
  }
  return null;
}

/** The latest `started` timestamp across `group`'s tracked entries, or null. */
function groupStartedAt(workers, group) {
  let started = -Infinity;
  for (const [key, w] of Object.entries(workers || {})) {
    if (WG.groupOf(w, key) !== group) continue;
    const t = Number.isFinite(w.started) ? w.started : NaN;
    if (t > started) started = t;
  }
  return Number.isFinite(started) ? started : null;
}

/**
 * Remember `coder` as this session's last code author when `at` is at least as recent as
 * any previously recorded code event — so a worker group that settles AFTER a newer
 * dispatch started never clobbers the newer author. Returns true when it changed.
 */
function recordCodeAuthor(s, coder, at) {
  if (!['codex', 'kimi', 'deepseek', 'sonnet'].includes(coder)) return false;
  const when = Number.isFinite(at) ? at : Date.now();
  if ((s.lastCodeAuthorAt || 0) > when) return false;
  s.lastCodeAuthor = coder;
  s.lastCodeAuthorAt = when;
  return true;
}

/**
 * Settle `group` and remember the code author it carried as this session's last code
 * author, dated at the group's own start so a late settle never clobbers a newer group —
 * the review / verify model follows whoever last wrote code (operator decision,
 * 2026-10-01). Only a real change records: an already-settled group does not re-stamp it.
 */
function settleCodeGroup(s, group) {
  const author = codeAuthorOfGroup(s.workers, group);
  const at = groupStartedAt(s.workers, group);
  const changed = WG.settleGroup(s.workers, group);
  if (changed && author) recordCodeAuthor(s, author, at);
  return changed;
}

function readLastCoder() {
  try {
    const value = JSON.parse(fs.readFileSync(CODER_ROUTE_STATE, 'utf8'));
    return value && ['codex', 'kimi', 'deepseek'].includes(value.lastCoder) ? value.lastCoder : null;
  } catch { return null; }
}

/** Called only while the shared state lock is held. */
function writeLastCoder(agent) {
  const coder = poolCoderForAgent(agent);
  if (!['codex', 'kimi', 'deepseek'].includes(coder)) return;
  writeJsonAtomic(CODER_ROUTE_STATE, { lastCoder: coder, updatedAt: Date.now() });
}

function machineWideCoderLive(s, now = Date.now()) {
  const result = { codex: 0, kimi: 0, deepseek: 0 };
  const currentName = `${String(s.session_id).replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
  for (const file of PAC.recentSessionStateFiles(DIR, now)) {
    if (path.basename(file) === currentName) continue;
    const other = PAC.readSessionState(file);
    if (!other) continue;
    result.codex += WG.countLiveGroups(other.workers, 'codex');
    result.kimi += WG.countLiveGroups(other.workers, 'kimi');
    result.deepseek += WG.countLiveGroups(other.workers, 'opencode');
  }
  result.codex += WG.countLiveGroups(s.workers, 'codex');
  result.kimi += WG.countLiveGroups(s.workers, 'kimi');
  result.deepseek += WG.countLiveGroups(s.workers, 'opencode');
  return result;
}

function sessionCoderLive(s) {
  return {
    codex: WG.countLiveGroups(s.workers, 'codex'),
    kimi: WG.countLiveGroups(s.workers, 'kimi'),
    deepseek: WG.countLiveGroups(s.workers, 'opencode'),
  };
}

function coderPoolRoute(cfg, s, now = Date.now()) {
  const availabilityTtlMs = coderAvailabilityCacheSeconds(cfg) * 1000;
  let authState = EXEC_QUOTA.codexAuthState(DIR, now, availabilityTtlMs);
  const orcaInstalled = orcaOnPath();
  const codexInstalled = binOnPath(process.env.ORCH_CODEX_BIN || CODEX_BIN);
  const kimiOverrideMissing = Object.prototype.hasOwnProperty.call(process.env, 'ORCH_KIMI_BIN') &&
    !binOnPath(process.env.ORCH_KIMI_BIN);
  const opencodeOverrideMissing = Object.prototype.hasOwnProperty.call(process.env, 'ORCH_OPENCODE_BIN') &&
    !binOnPath(process.env.ORCH_OPENCODE_BIN);
  let availability = CODER_AVAILABILITY.coderAvailability({
    stateDir: DIR, cacheSeconds: coderAvailabilityCacheSeconds(cfg), now,
    orcaInstalled, env: process.env, codexAuthState: authState,
    fresh: !orcaInstalled || !codexInstalled || kimiOverrideMissing || opencodeOverrideMissing,
  });
  const quotas = { codex: null, kimi: null, deepseek: null };
  if (availability.codex?.usable) {
    const reading = EXEC_QUOTA.codexQuota(now, { stateDir: DIR, cacheSeconds: codexQuotaCacheSeconds(cfg) });
    if (reading?.authState === 'logged-out') {
      authState = 'logged-out';
      availability = CODER_AVAILABILITY.coderAvailability({
        stateDir: DIR, cacheSeconds: coderAvailabilityCacheSeconds(cfg), now,
        orcaInstalled, env: process.env, codexAuthState: authState,
        fresh: true,
      });
    } else if (reading && !reading.failed) {
      quotas.codex = reading;
    }
  }
  if (availability.kimi?.usable) {
    const reading = EXEC_QUOTA.kimiQuota(now, {
      stateDir: DIR, cacheSeconds: kimiQuotaCacheSeconds(cfg), env: process.env,
    });
    if (reading && !reading.failed) quotas.kimi = reading;
  }
  if (availability.deepseek?.usable) {
    const reading = EXEC_QUOTA.deepseekQuota(now, {
      stateDir: DIR, cacheSeconds: deepseekQuotaCacheSeconds(cfg), env: process.env,
      dailyCapUsd: deepseekDailySpendCapUsd(cfg),
    });
    if (reading && !reading.failed) quotas.deepseek = reading;
  }
  return CODER_POOL.pickCoderPool({
    availability, quotas,
    thresholds: { codex: handoffUsed(cfg), kimi: kimiHandoffUsed(cfg), deepseek: deepseekHandoffUsed(cfg) },
    tieBand: cfg.coderHeadroomTieBand, unknownAssumed: cfg.unknownHeadroomAssumed,
    roles: { deepseek: deepseekRole(cfg) },
    exhaustion: CODER_AVAILABILITY.readCoderExhaustion(DIR, now),
    live: machineWideCoderLive(s, now),
    sessionLive: sessionCoderLive(s),
    caps: { codex: maxParallelCodexWorkers(cfg), kimi: maxParallelKimiWorkers(cfg), deepseek: maxParallelDeepseekWorkers(cfg) },
    lastCoder: readLastCoder(),
    fallbackEnabled: cfg.execFallbackWhenCodexUnavailable === 'sonnet' ? true : null,
  });
}

/**
 * Who writes code for this session. An operator override wins:
 *   s.execAgent = 'codex' | 'codex:<model>' | 'kimi' | 'kimi:<model>' | 'claude:<alias>'
 * (set by --code-model <value>, or an --exec-* shortcut); otherwise automatic: spread
 * work across eligible external coders, then use the configured in-session code model.
 */
function currentExecRoute(cfg, s) {
  const a = s.execAgent;
  if (typeof a === 'string' && a.startsWith('claude:')) {
    return { route: 'claude', alias: a.slice(7), why: `operator override (${a.slice(7)})` };
  }
  let pool;
  try {
    pool = coderPoolRoute(cfg, s);
  } catch {
    // No path may assume Codex: an unreadable pool fails toward ALLOW, i.e. the in-session
    // code route, so a machine with no coders (or a config error) never locks code out.
    pool = { route: 'code', pick: null, order: [], coders: {}, why: 'auto: coder pool unreadable' };
  }
  if (a === 'codex' || a === 'kimi' || a === 'deepseek' ||
      (typeof a === 'string' && /^(?:codex|kimi|deepseek):/.test(a))) {
    const pick = a.startsWith('kimi') ? 'kimi' : a.startsWith('deepseek') ? 'deepseek' : 'codex';
    const pickLabel = pick === 'codex' ? 'Codex' : pick === 'kimi' ? 'Kimi' : 'DeepSeek';
    const state = pool.coders[pick];
    const warning = state?.state === 'eligible' || !state ? '' : ` WARNING: ${pickLabel} unusable: ${state.reason || state.state || 'unavailable'}.`;
    return {
      route: 'external', pick, order: [pick], coders: pool.coders,
      ...(pick === 'codex' && a.startsWith('codex:') ? { codexModel: a.slice(6) } : {}),
      ...(pick === 'kimi' && a.startsWith('kimi:') ? { kimiModel: a.slice(5) } : {}),
      ...(pick === 'deepseek' && a.startsWith('deepseek:') ? { deepseekModel: a.slice(9) } : {}),
      why: `operator override (${a})${warning}`,
    };
  }
  if (pool.route === 'code') return { ...pool, route: 'code', alias: cfg.models.code.alias };
  return pool;
}

/**
 * True when `bin` (an ORCA_BIN/CODEX_BIN-style override, or the bare default name) is
 * reachable: an absolute/relative path (tests point this at a stub, or a deliberately
 * missing file) is checked directly; a bare name is resolved with `which`/`where`. Never
 * throws.
 */
function binOnPath(bin) {
  try {
    if (bin.includes(path.sep)) return fs.existsSync(bin);
    require('child_process').execFileSync(
      process.platform === 'win32' ? 'where' : 'which', [bin],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }
    );
    return true;
  } catch {
    return false;
  }
}
function orcaOnPath() { return binOnPath(ORCA_BIN); }
function codexOnPath() { return binOnPath(CODEX_BIN); }

/**
 * True when this hook payload came from the main panel rather than a subagent
 * or a standalone Orca-dispatched worker session.
 *
 * A Task-tool subagent is detected the normal way: its payload carries
 * `agent_id`/`agent_type`. An Orca `worker-start` dispatch is a SEPARATE
 * top-level Claude Code session, so it carries neither — the same shape as
 * the main panel. It is told apart by its Orca terminal: every Claude session
 * launched inside Orca inherits `ORCA_TERMINAL_HANDLE`, and a worker's handle
 * is listed as `agentTerminalHandle` by `orca orchestration worker-list`.
 */
function isMainPanel(p) {
  return !p.agent_id && !p.agent_type;
}

function roleFile(sid) {
  return stateFile(sid).replace(/\.json$/, '.role.json');
}

/**
 * Terminal handles of Orca workers still holding their terminal, or null when
 * Orca cannot answer. Released rows are excluded: an operator may keep typing in
 * a released worker's terminal, and that session must be gated like any other.
 */
function orcaWorkerHandles() {
  try {
    const out = require('child_process').execFileSync(
      ORCA_BIN, ['orchestration', 'worker-list', '--json'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024 }
    );
    const parsed = JSON.parse(out);
    const r = parsed.result ?? parsed;
    const workers = Array.isArray(r) ? r : r.workers || [];
    const handles = new Set();
    for (const w of workers) {
      if (w.terminalState === 'released') continue;
      if (w.projection && w.projection.role && w.projection.role !== 'worker') continue;
      // Only terminals Orca launched and owns for a worker (worker-start) carry a
      // resource id. A context-only `orchestration dispatch --to <handle>` also lists
      // as role "worker" with that handle, but has no resource - and may target the
      // coordinator's own terminal, which must stay gated.
      if (!w.resource || !w.resource.id) continue;
      if (w.agentTerminalHandle) handles.add(w.agentTerminalHandle);
    }
    return handles;
  } catch {
    return null;
  }
}

/**
 * True when this session runs in a terminal Orca dispatched as a worker.
 * Unknown (no Orca terminal, or Orca unreachable) counts as main panel, so the
 * gates stay on. A "worker" verdict is cached in its own file (never in the
 * shared state file, so it cannot race worker bookkeeping); "main" is never
 * cached, so a worker whose dispatch was not yet listed is re-checked next time.
 */
function isOrcaWorkerSession(s) {
  const handle = process.env.ORCA_TERMINAL_HANDLE;
  if (!handle) return false;
  const file = roleFile(s.session_id);
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cached.handle === handle && cached.role === 'worker') return true;
  } catch {}
  const handles = orcaWorkerHandles();
  if (!handles || !handles.has(handle)) return false;
  writeJsonAtomic(file, { handle, role: 'worker', checked_at: Date.now() });
  return true;
}

/**
 * The heartbeat daemon `sid` started, if it is alive: its liveness file exists, its pid
 * answers, and it ticked within three intervals. null otherwise. Thin wrapper over the
 * shared `heartbeatAliveAt` (also used cross-session by lib/parallel-agent-cap.cjs's M1
 * rule) bound to this file's own `DIR`.
 */
function heartbeatAlive(sid) {
  return HBL.heartbeatAliveAt(DIR, sid);
}

/** The exact command to start the heartbeat daemon, built from this install's own paths. */
function heartbeatStartCommand() {
  const node = JSON.stringify(process.execPath);
  const script = JSON.stringify(path.join(__dirname, 'orca-heartbeat.cjs'));
  return `${node} ${script}   (Bash with run_in_background: true; its exit wakes you on the first event)`;
}

const CODE_BRIEF_HELP =
  'A code brief must let the coder verify its own work before reporting done.\n' +
  'Include the exact command(s) it must run and get green, plus the pass criterion, e.g.\n' +
  '  "Verify: venv/bin/python -m pytest tests/foo -q (all pass) && npm run build (exit 0)".\n' +
  'If nothing can be checked mechanically, say so explicitly: "verify: n/a <reason>".\n' +
  '(Only code work is gated: a research / review / publish spec does not need a verify command.)';

/**
 * Text of an Orca brief: the command itself plus any file it inlines with $(cat <path>),
 * $(< <path>) or --spec @<path>, so a spec kept in a file is judged by its content.
 * Paths resolve against the session cwd; ~ and $HOME expand. Only regular files are
 * read, at most MAX_BRIEF_BYTES each, so a FIFO or device can never hang the hook.
 * Returns { text, unreadable } - unreadable paths are named in the refusal.
 */
const MAX_BRIEF_BYTES = 200 * 1024;
function briefText(cmd, cwd) {
  let text = cmd;
  const unreadable = [];
  const refs = [
    ...cmd.matchAll(/\$\(\s*cat\s+([^)]+)\)/g),       // $(cat a b)
    ...cmd.matchAll(/\$\(\s*<\s*([^)]+)\)/g),          // $(< a)
    ...cmd.matchAll(/--spec\s+@(["']?[^"'\s]+["']?)/g), // --spec @a
  ].flatMap((m) => m[1].trim().split(/\s+/));
  for (const ref of refs) {
    const raw = ref.replace(/^["']|["']$/g, '');
    if (!raw || raw.startsWith('-')) continue;
    const expanded = raw.replace(/^~(?=\/)/, os.homedir()).replace(/^\$(HOME|\{HOME\})(?=\/)/, os.homedir());
    if (/\$/.test(expanded)) { unreadable.push(raw); continue; } // unexpanded shell variable
    const file = path.resolve(cwd || process.cwd(), expanded);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) { unreadable.push(raw); continue; }
      const len = Math.min(st.size, MAX_BRIEF_BYTES);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, len, 0); } finally { fs.closeSync(fd); }
      text += `\n${buf.toString('utf8')}`;
    } catch {
      unreadable.push(raw);
    }
  }
  return { text, unreadable };
}

function liveWorkers(s) {
  return Object.entries(s.workers).filter(([, w]) => w.status === 'live');
}

// Gate A (max-parallel-codex-workers) + Gate B (code-brief-needs-owns / ownership-overlap)
// live in their own module (matches the existing hooks/lib/*.cjs boundary); this file
// still owns `d()`/deny() and supplies the small helpers below it as `deps`, so there is no
// import cycle back into this file.
const PARALLEL_OWNERSHIP = require('./lib/parallel-ownership-gates.cjs');
const OWNS_BRIEF_HELP = PARALLEL_OWNERSHIP.OWNS_BRIEF_HELP;
const resolveWorkerStartAgent = (inv, s) => PARALLEL_OWNERSHIP.resolveWorkerStartAgent(inv, s, flagValue);
const liveCodexGroupIds = PARALLEL_OWNERSHIP.liveCodexGroupIds;

/** The live machine-wide parallel-agents limit for this config (Infinity = unlimited). */
function agentParallelLimit(cfg) {
  return PAC.agentParallelLimit(cfg, { maxParallelAgents, parallelCoreFraction });
}

/**
 * max-parallel-agents for a real `orca terminal create` invocation in this Bash command —
 * the other trigger the gate spec names besides Agent/Task and `worker-start` (the latter
 * is handled inside handleOrcaDispatchGates/parallel-ownership-gates.cjs, alongside the
 * Codex-only cap and the ownership checks, since it already knows the resolved agent and
 * workspace). A bare `terminal create` has neither of those concepts, so this stays a
 * small, separately-keyed (`term:<toolUseId>#<idx>`) reservation that only needs to survive
 * the PreToolUse -> PostToolUse gap — see the cleanup at both of those events.
 */
function handleTerminalCreateAgentCap(p, s, cfg, cmd, d) {
  const invs = orcaInvocations(cmd).filter((inv) => inv.sub === 'terminal create' && !hasFlag(inv.args, '--help'));
  if (!invs.length || gateDisabled(cfg, 'max-parallel-agents')) return;
  // Review round 3, item 1: this whole function exists ONLY to protect the hard
  // max-parallel-agents cap (see the concurrency-review note below) — when that cap is
  // disabled or the derived limit is non-finite (unlimited, maxParallelAgents 0), there is
  // nothing here to refuse, so this returns allow BEFORE ever touching the lock. Checking
  // this ahead of the lock acquisition (not just ahead of `!locked`) also means a `.lock`
  // some other process happens to be holding, however long, can never masquerade as
  // "at capacity" for a cap that isn't actually capping anything.
  const limit = agentParallelLimit(cfg);
  if (!Number.isFinite(limit)) return;

  const lockDir = path.join(DIR, '.lock');
  const toolUseId = p.tool_use_id || p.toolUseId || null;
  const baseId = toolUseId || `sid-${s.session_id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let violation = null;
  let locked = acquireLock(lockDir, CAP_LOCK_OPTS);
  if (locked === null) return;
  // Reservations THIS command's own earlier invocations already added, re-applied after a
  // mid-loop reconcile reload wipes the in-memory `fresh` object (same reasoning as
  // parallel-ownership-gates.cjs's identical localReservations pattern).
  const localReservations = {};
  try {
    // Concurrency review, Low item: this whole function exists ONLY to protect the hard
    // max-parallel-agents cap (unlike handleOrcaDispatchGates, it has no other, softer
    // concern to fall back to) — a lock the caller could not acquire at all means nothing
    // here can be evaluated or saved safely, so it refuses immediately with a transient-
    // retry reason instead of silently registering unlocked.
    if (locked === false) { violation = PAC.LOCK_CONTENTION_MESSAGE; }
    else {
      let fresh = load(s.session_id);
      for (let idx = 0; idx < invs.length && !violation; idx++) {
        let usage = PAC.machineWideLiveUnits(DIR, Date.now(), { currentState: fresh, currentSessionId: fresh.session_id });
        if (usage.total >= limit) {
          // H3: reconcile THIS session's own Orca-tracked workers before refusing — the
          // same out-of-lock-fetch + locked-reapply pattern the worker-start path uses.
          releaseLock(lockDir); locked = false;
          const fetched = PARALLEL_OWNERSHIP.fetchOrcaWorkerRows(ORCA_BIN);
          locked = acquireLock(lockDir, CAP_LOCK_OPTS);
          if (locked === null) return;
          if (locked === false) { violation = PAC.LOCK_CONTENTION_MESSAGE; break; }
          fresh = load(s.session_id);
          Object.assign(fresh.reservations, localReservations);
          if (fetched !== null) PARALLEL_OWNERSHIP.applyOrcaReconciliation(
            fresh, fetched.rows, fetched.exhaustive, fetched.terminalHandles);
          usage = PAC.machineWideLiveUnits(DIR, Date.now(), { currentState: fresh, currentSessionId: fresh.session_id });
        }
        if (usage.total >= limit) {
          violation = PAC.formatParallelAgentsRefusal(usage, limit, PAC.cores(), parallelCoreFraction(cfg),
            { explicitLimit: maxParallelAgents(cfg) != null, stateDir: DIR });
          break;
        }
        const key = `term:${baseId}#${idx}`;
        const reservation = { ts: Date.now(), agent: 'terminal', owns: null, ws: null, codexSlot: false, newSlot: true };
        localReservations[key] = reservation;
        fresh.reservations[key] = reservation;
      }
      if (!violation) save(fresh);
    }
  } finally {
    if (locked) releaseLock(lockDir);
  }
  if (violation) d('max-parallel-agents', violation);
}

function handleOrcaDispatchGates(p, s, cfg, cmd, d) {
  return PARALLEL_OWNERSHIP.handleOrcaDispatchGates({
    p, s, cfg, cmd, d,
    deps: {
      hasFlag, flagValue, briefText, EXEC_INTENT, DIR, ORCA_BIN, maxParallelCodexWorkers, maxParallelKimiWorkers,
      maxParallelDeepseekWorkers,
      ownershipClaimTtlMinutes, save, load, gateDisabled,
      agentParallelLimit, maxParallelAgents, machineWideLiveUnits: PAC.machineWideLiveUnits,
      formatParallelAgentsRefusal: PAC.formatParallelAgentsRefusal, cores: PAC.cores, parallelCoreFraction,
      lockContentionMessage: PAC.LOCK_CONTENTION_MESSAGE, capLockOpts: CAP_LOCK_OPTS,
    },
  });
}

/**
 * Reconcile live "pending-*" placeholders (a worker-start whose reply carried no parseable
 * id) at most once per minute, on any gate event, so a placeholder cannot hold an Owns:
 * claim and a cap slot until a lucky manual poll. The Orca fetch runs OUTSIDE the lock (up
 * to 5s); only the apply mutates state, against a freshly reloaded copy under the lock —
 * the same split the cap reconciles use. The attempt is stamped even when Orca cannot
 * answer, so an unreachable Orca never makes every hook event pay for a 5s timeout; the
 * placeholder TTL (worker-groups.cjs) remains the backstop in that case.
 */
const PENDING_RECONCILE_INTERVAL_MS = 60 * 1000;
function maybeReconcilePendingPlaceholders(sessionId, eventName) {
  const snapshot = load(sessionId);
  const hasPending = Object.entries(snapshot.workers || {})
    .some(([k, w]) => k.startsWith('pending-') && w.status === 'live');
  if (!hasPending) return;
  const now = Date.now();
  if (now - (snapshot.last_pending_reconcile || 0) < PENDING_RECONCILE_INTERVAL_MS) return;
  const fetched = PARALLEL_OWNERSHIP.fetchOrcaWorkerRows(ORCA_BIN);
  const lockDir = path.join(DIR, '.lock');
  const locked = acquireLock(lockDir, {});
  if (!locked) return;
  try {
    const fresh = load(sessionId);
    fresh.last_pending_reconcile = now;
    if (fetched !== null) {
      const res = PARALLEL_OWNERSHIP.reconcilePendingPlaceholders(fresh, fetched.rows, now);
      for (const line of res.adopted) {
        emitHookNotice(`orchestrator-gate: resolved placeholder ${line} against orca worker-list.`, eventName);
      }
      for (const key of res.settled) {
        emitHookNotice(
          `orchestrator-gate: placeholder ${key} never matched a real dispatch within ` +
          `${Math.round(WG.PENDING_PLACEHOLDER_TTL_MS / 60000)}m; settled, releasing its Owns: claim and cap slot.`,
          eventName);
      }
    }
    save(fresh);
  } finally {
    releaseLock(lockDir);
  }
}

/** "Reply to the operator in <language>." — omitted entirely when replyLanguage is null. */
function languageSentence(cfg, forBanner) {
  if (!cfg.replyLanguage) return forBanner ? '' : '';
  return forBanner
    ? `- Talk to the operator in ${cfg.replyLanguage}. This panel orchestrates; it does not implement.\n`
    : `Reply to the operator in ${cfg.replyLanguage}. `;
}

// --- handlers ---------------------------------------------------------------

/** `parallel budget: <n>/<N> (<cores> cores x <fraction>%)` — the machine-wide
 * max-parallel-agents usage line shared by the SessionStart banner and the per-prompt
 * reminder. `<N>` reads "unlimited" when the derived/explicit limit is Infinity/0. */
function parallelBudgetLine(cfg, s) {
  const limit = agentParallelLimit(cfg);
  const usage = PAC.machineWideLiveUnits(DIR, Date.now(), { currentState: s, currentSessionId: s.session_id });
  const limitText = Number.isFinite(limit) ? limit : 'unlimited';
  return `parallel budget: ${usage.total}/${limitText} (${PAC.cores()} cores x ${Math.round(parallelCoreFraction(cfg) * 100)}%)`;
}

function activeOverrideLines(cfg, s) {
  const lines = [];
  if (s.bypass) {
    lines.push(`GATES OFF for this session since ${s.bypassSince || s.created} (--no-orchestrate); type --orchestrate to re-enable`);
  }
  if (s.execAgent != null) {
    let target;
    let flag;
    if (s.execAgent === `claude:${cfg.models.code.alias}`) {
      target = cfg.models.code.alias[0].toUpperCase() + cfg.models.code.alias.slice(1);
      flag = '--exec-sonnet';
    } else if (s.execAgent === 'codex') {
      target = 'Codex';
      flag = '--exec-codex';
    } else if (s.execAgent === 'kimi') {
      target = 'Kimi';
      flag = '--exec-kimi';
    } else if (s.execAgent === 'deepseek') {
      target = 'DeepSeek (opencode)';
      flag = '--exec-deepseek';
    } else if (s.execAgent.startsWith('codex:')) {
      target = `Codex (${s.execAgent.slice(6)})`;
      flag = `--code-model ${s.execAgent}`;
    } else if (s.execAgent.startsWith('kimi:')) {
      target = `Kimi (${s.execAgent.slice(5)}, set as default_model; Orca cannot pin it)`;
      flag = `--code-model ${s.execAgent}`;
    } else if (s.execAgent.startsWith('deepseek:')) {
      target = `DeepSeek (${s.execAgent.slice(9)}, set in ~/.config/opencode/opencode.jsonc; Orca cannot pin it)`;
      flag = `--code-model ${s.execAgent}`;
    } else {
      target = s.execAgent.slice(7);
      flag = `--code-model ${target}`;
    }
    lines.push(`code forced to ${target} since ${s.execAgentSince || s.created} (${flag}); --code-model auto to return to quota routing`);
  }
  return lines;
}

function onSessionStart(p, s, cfg) {
  if (p.source === 'startup' || p.source === 'resume') {
    const lockDir = path.join(DIR, '.lock');
    const locked = acquireLock(lockDir, {});
    if (locked) {
      try {
        s = load(p.session_id);
        s.backgroundShells = {};
        s.sessionStartedAt = Date.now();
        save(s);
      } finally {
        releaseLock(lockDir);
      }
    }
  }
  const review = cfg.models.review.alias;
  const escalation = cfg.models.escalation.alias;
  const lookup = cfg.models.lookup.alias;
  const code = cfg.models.code.alias;
  const codexThreshold = handoffUsed(cfg);
  const kimiThreshold = kimiHandoffUsed(cfg);
  const deepseekThreshold = deepseekHandoffUsed(cfg);
  const route = currentExecRoute(cfg, s);
  const warnings = (cfg.warnings || []).map((w) => `- CONFIG WARNING: ${w}\n`).join('');
  const overrideWarnings = activeOverrideLines(cfg, s).map((line) => `- ACTIVE OVERRIDE: ${line}\n`).join('');
  // Every coder is optional: the banner names only the coders usable on THIS machine
  // (operator decision, 2026-10-01) — a machine with none routes code in-session.
  const coderLabel = (c) => c === 'codex' ? 'Codex' : c === 'kimi' ? 'Kimi' : 'DeepSeek';
  const usableCoders = ['codex', 'kimi', 'deepseek'].filter((c) => route.coders?.[c]?.state === 'eligible');
  const thresholdText = { codex: codexThreshold, kimi: kimiThreshold, deepseek: deepseekThreshold };
  const peerList = usableCoders.length
    ? usableCoders.map((c) => `${coderLabel(c)} (handoff >= ${thresholdText[c]}% used${route.coders[c].standby ? ', overflow' : ''})`).join(', ')
    : 'no external coder usable on this machine';
  const dispatchLines = [
    usableCoders.includes('codex') ? '    Codex -> Orca worker: orca orchestration task-create ... && worker-start --agent codex --model ...\n' : '',
    usableCoders.includes('kimi') ? '    Kimi  -> Orca worker: orca orchestration task-create ... && worker-start --agent kimi (no --model)\n' : '',
    usableCoders.includes('deepseek') ? '    DeepSeek -> Orca worker: orca orchestration task-create ... && worker-start --agent opencode (no --model)\n' : '',
    usableCoders.length ? '             then worker-list | worker-read | worker-release\n' : '',
  ].join('');
  process.stdout.write(
    'ORCHESTRATION CONTRACT (enforced by orchestrator-gate.cjs):\n' +
    warnings +
    overrideWarnings +
    languageSentence(cfg, true) +
    '- The main panel may read and dispatch only. It may not Edit/Write outside .claude/, plans/, docs/, scratch,\n' +
    '  and may not run mutating shell commands. Delegate those to a worker.\n' +
    `- Model routing: ${modelLabel(cfg.models.review)} plans + red-teams -> ${usableCoders.map(coderLabel).join(' + ') || 'in-session'} coder${usableCoders.length === 1 ? '' : 's'} -> reviews; verify -> ${verifyModelAlias(cfg)}.\n` +
    `- Planning / red-team -> in-session subagent on model ${modelLabel(cfg.models.review)}. Review -> model ${reviewRouteText(cfg, s)} (review model follows the code's author). Verify -> model ${verifyModelAlias(cfg)}.\n` +
    `  Model ${modelLabel(cfg.models.escalation)} only after "${review}" failed even at high effort; say both in the dispatch.\n` +
    `- Light lookups (find/locate code, read logs or test output, explore) -> model ${modelLabel(cfg.models.lookup)}.\n` +
    '- Every code brief (external spec or in-session prompt) names the exact test / build command to run green.\n' +
    `- Code: split across ${peerList}; next -> ${route.pick ? coderLabel(route.pick) : code}.\n` +
    dispatchLines +
    `    ${code[0].toUpperCase()}${code.slice(1)} -> ${codeModelDispatchText(cfg)}.\n` +
    `  Operator-only override from the main panel: --code-model <${review}|${code}|${lookup}|${escalation}|codex|codex:<model>|kimi|kimi:<model>|deepseek|deepseek:<model>|auto>\n` +
    '  (session-scoped, last flag wins; --exec-sonnet / --exec-codex / --exec-kimi / --exec-deepseek are shortcuts, --exec-auto = --code-model auto).\n' +
    '  If Orca itself is unreachable: `touch ~/.claude/orchestrator-gate/orca-unavailable` (15 min) permits in-session code\n' +
    `  (even an external-coder override falls back to "${code}" while that flag is active).\n` +
    `- Poll every live worker at least every ${cfg.heartbeat.idleSeconds}s. Never let one sit IDLE unattended.\n` +
    '- External coder workers get rate limited when run in parallel: on a rate-limit signal, back off and retry\n' +
    `  after ~${RATE_LIMIT_BACKOFF_SECONDS}s instead of abandoning or re-dispatching immediately.\n` +
    '- Release or close a worker as soon as it is done and not reusable.\n' +
    `- ${parallelBudgetLine(cfg, s)}: machine-wide live Orca workers + subagents, summed across\n` +
    '  every recent session on this machine. Raise it with maxParallelAgents / ORCH_MAX_PARALLEL_AGENTS.\n'
  );
}

// Harness-injected turns (background-task results, cross-session messages, system
// reminders) also arrive as UserPromptSubmit. Their text is not the operator's, so
// it must never toggle a session-wide flag: a subagent report that merely quoted
// "--no-orchestrate" once switched every gate off.
const HARNESS_INJECTED_TURN = /<task-notification>|<cross-session-message|\[SYSTEM NOTIFICATION|<system-reminder>/i;
function isNonOperatorTurn(prompt) {
  if (HARNESS_INJECTED_TURN.test(prompt) || /^\s*This session is being continued\b/i.test(prompt)) return true;
  return /(?:^|\n)\s*Summary:(?=\s)/i.test(prompt) &&
    /\b(previous|prior|earlier)\s+(conversation|session|prompts?)\b/i.test(prompt);
}
// A flag counts only as a standalone token, not inside backticks or a longer word.
const operatorFlag = (prompt, flag) => new RegExp(`(^|\\s)${flag}(?=\\s|$)`, 'i').test(prompt);

function commandHead(command) {
  return String(command || '').trim().split(/\r?\n/, 1)[0].replace(/\s+/g, ' ').slice(0, 100) || '(empty command)';
}

function formatAge(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function formatBackgroundShellReminder(shells, now = Date.now()) {
  const running = Object.values(shells || {}).filter((shell) => shell && Number.isFinite(shell.started));
  if (running.length <= 3) return null;
  const oldest = running.reduce((a, b) => a.started <= b.started ? a : b);
  return `${running.length} background shells running (oldest: ${oldest.command}, ${formatAge(now - oldest.started)}) - ` +
    'stop finished/idle ones (TaskStop)';
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function pruneBackgroundShells(s, now = Date.now()) {
  const cutoff = Math.max(now - BACKGROUND_SHELL_TTL_MS,
    Number.isFinite(s.sessionStartedAt) ? s.sessionStartedAt : 0);
  let changed = false;
  for (const [id, shell] of Object.entries(s.backgroundShells || {})) {
    const trackedHeartbeatExited = shell?.heartbeat && Number.isInteger(shell.heartbeatPid) &&
      !processAlive(shell.heartbeatPid);
    const untrackedHeartbeatExpired = shell?.heartbeat && !Number.isInteger(shell.heartbeatPid) &&
      shell.started <= now - BACKGROUND_SHELL_STARTUP_GRACE_MS && !heartbeatAlive(s.session_id);
    const exitedHeartbeat = trackedHeartbeatExited || untrackedHeartbeatExpired;
    if (!shell || !Number.isFinite(shell.started) || shell.started < cutoff || exitedHeartbeat) {
      delete s.backgroundShells[id];
      changed = true;
    }
  }
  return changed;
}

function remindBackgroundShells(s) {
  const line = formatBackgroundShellReminder(s.backgroundShells);
  if (line) process.stdout.write(`${line}\n`);
}

function onUserPromptSubmit(p, s, cfg) {
  maybeReconcilePendingPlaceholders(p.session_id, p.hook_event_name);
  // CRITICAL: reload fresh under the lock, same reasoning as onPostToolUse — this handler
  // both reads and mutates (bypass, code-model override, --release-claims, task-notification
  // release) and must never operate on a stale pre-lock snapshot.
  const lockDir = path.join(DIR, '.lock');
  const locked = acquireLock(lockDir, {});
  try {
    s = load(p.session_id);
    if (pruneBackgroundShells(s)) save(s);
    return onUserPromptSubmitLocked(p, s, cfg);
  } finally {
    if (locked) releaseLock(lockDir);
  }
}

function onUserPromptSubmitLocked(p, s, cfg) {
  const raw = String(p.prompt || '');

  // Background-Agent ownership claims: best-effort release when a <task-notification>
  // names the id of the dispatch that just finished. This reads harness-injected content
  // ON PURPOSE (the opposite of the operator-flag rule right below) — a task-notification
  // is never the operator's own text, but it is exactly the signal this release path exists
  // to react to. TTL and --release-claims remain the safety nets when no id is found here.
  if (/<task-notification\b/i.test(raw)) {
    let releasedAny = false;
    // Only an id that appears INSIDE the notification's own <tool-use-id> tag identifies the
    // dispatch that just finished. Matching anywhere in the whole block (the pre-fix
    // behavior) also matched ids mentioned in the notification's free-text <result> body —
    // e.g. a finished task's own result text naming a still-running sibling task's id —
    // which wrongly released that sibling's claim while its work was still in flight.
    for (const m of raw.matchAll(/<tool-use-id>\s*(toolu_[A-Za-z0-9_-]+|agent_[A-Za-z0-9_-]+)\s*<\/tool-use-id>/gi)) {
      if (s.agentClaims[m[1]]) { delete s.agentClaims[m[1]]; releasedAny = true; }
      if (s.agents && s.agents[m[1]]) { delete s.agents[m[1]]; releasedAny = true; }
      if (s.backgroundShells && s.backgroundShells[m[1]]) { delete s.backgroundShells[m[1]]; releasedAny = true; }
    }
    if (releasedAny) save(s);
  }
  remindBackgroundShells(s);

  // Backstop: sweep leaked FOREGROUND (`background: false`) `s.agents` registrations on
  // every genuine operator turn. Bash reservations are deliberately NOT swept here: a Bash
  // tool call can still be in flight when another operator prompt is submitted, and its
  // eventual PostToolUse needs the reservation to transfer Owns/cap metadata to the worker.
  // Stop remains the safe backstop for unresolved Bash reservations.
  if (!isNonOperatorTurn(raw)) {
    let purgedAny = false;
    for (const [id, a] of Object.entries(s.agents || {})) {
      if (a && a.background === false) { delete s.agents[id]; purgedAny = true; }
    }
    if (purgedAny) save(s);
  }

  const prompt = isNonOperatorTurn(raw) ? '' : raw;
  const promptLower = prompt.toLowerCase();
  const bypassFlags = ['--no-orchestrate', '--orchestrate']
    .map((flag) => [flag, operatorFlag(prompt, flag) ? promptLower.lastIndexOf(flag) : -1])
    .filter(([, index]) => index >= 0)
    .sort((a, b) => b[1] - a[1]);
  if (bypassFlags.length) {
    s.bypass = bypassFlags[0][0] === '--no-orchestrate';
    s.bypassSince = s.bypass ? new Date().toISOString() : null;
    save(s);
    process.stdout.write(s.bypass
      ? 'orchestrator-gate: BYPASSED for this session by explicit user request.\n'
      : 'orchestrator-gate: orchestration gates re-enabled for this session.\n');
    if (s.bypass) {
      process.stdout.write(`${activeOverrideLines(cfg, s).join(' ')}\n`);
      return;
    }
  }
  if (s.bypass) {
    process.stdout.write(`${activeOverrideLines(cfg, s).join(' ')}\n`);
    return;
  }

  // Honest, explicit, session-scoped preference for execution routing. This is NOT the
  // orca-unavailable flag: it never claims Orca is unreachable, and it does not
  // self-expire — the operator sets it once and reverts it once, both by hand.
  // --code-model <value> lets the operator pick the coding model directly; --exec-sonnet /
  // --exec-codex / --exec-kimi are shortcuts for the configured code model / external coders. Whichever of these
  // appears last in the prompt wins.
  const flagAt = (f) => (operatorFlag(prompt, f) ? promptLower.lastIndexOf(f) : -1);
  const cm = [...prompt.matchAll(/(^|\s)--code-model(?:=|\s+)(\S+)/gi)].pop();
  const bareCm = !cm && /(^|\s)--code-model(?:=)?\s*$/i.test(prompt);
  if (bareCm) {
    process.stdout.write(`orchestrator-gate: --code-model needs a value (${cfg.models.review.alias} | ${cfg.models.code.alias} | ${cfg.models.lookup.alias} | ${cfg.models.escalation.alias} | codex | codex:<model> | kimi | kimi:<model> | deepseek | deepseek:<model> | auto); nothing changed.\n`);
  }
  const cmAt = cm ? cm.index + cm[1].length : -1;
  const lastFlag = ['--exec-sonnet', '--exec-codex', '--exec-kimi', '--exec-deepseek', '--exec-auto']
    .map((f) => [f, flagAt(f)]).concat(cm ? [['--code-model', cmAt]] : [])
    .filter(([, i]) => i >= 0).sort((a, b) => b[1] - a[1]).map(([f]) => f)[0];
  let override;
  if (lastFlag === '--exec-sonnet') override = `claude:${cfg.models.code.alias}`;
  else if (lastFlag === '--exec-codex') override = 'codex';
  else if (lastFlag === '--exec-kimi') override = 'kimi';
  else if (lastFlag === '--exec-deepseek') override = 'deepseek';
  else if (lastFlag === '--exec-auto') override = null;
  else if (lastFlag === '--code-model') override = parseCodeModel(cfg, cm[2]);
  if (override !== undefined && override !== 'invalid') {
    s.execAgent = override;
    s.execAgentSince = override === null ? null : new Date().toISOString();
    save(s);
    process.stdout.write(override === null
      ? `orchestrator-gate: coding model back to automatic (external coders load-balanced, "${cfg.models.code.alias}" when none is eligible).\n`
      : `orchestrator-gate: coding model set by the operator for this session: ${describeOverride(cfg, override)}. Revert with --code-model auto.\n`);
  } else if (override === 'invalid') {
    process.stdout.write(`orchestrator-gate: ignored --code-model ${cm[2]} (use ${cfg.models.review.alias} | ${cfg.models.code.alias} | ${cfg.models.lookup.alias} | ${cfg.models.escalation.alias} | codex | codex:<model> | kimi | kimi:<model> | deepseek | deepseek:<model> | auto).\n`);
  }

  // Operator-only manual release of a stuck ownership claim (foreground release is
  // automatic at PostToolUse; background release is best-effort via <task-notification> or
  // the ownershipClaimTtlMinutes safety net — this is the deliberate manual override).
  const rc = prompt.match(/(^|\s)--release-claims(?:=|\s+)(\S+)/i);
  if (rc) {
    const target = rc[2];
    let released = 0;
    if (target.toLowerCase() === 'all') {
      // Clears every source of a live claim/registration (item 12, extended for
      // max-parallel-agents): in-session Agent Owns: claims, Bash-dispatch reservations —
      // just as capable of holding a stuck Owns: claim (and a parallel-Codex or
      // max-parallel-agents opening) as an agentClaims entry — AND the max-parallel-agents
      // Agent/Task registry itself.
      released = Object.keys(s.agentClaims).length + Object.keys(s.reservations).length + Object.keys(s.agents || {}).length;
      s.agentClaims = {};
      s.reservations = {};
      s.agents = {};
    } else {
      // Low item: a single `target` id can legitimately hold MORE than one kind of claim at
      // once — e.g. an in-session code dispatch's `agentClaims[toolUseId]` (its Owns: claim)
      // AND `agents[toolUseId]` (its max-parallel-agents registration) under the very same
      // toolUseId. The old if/else-if chain stopped at whichever matched first, silently
      // leaving the others behind — a `--release-claims <id>` that looked like it worked
      // could still leave a parallel-agents slot (or a reservation) stuck. Every kind is now
      // checked and released independently.
      if (s.agentClaims[target]) { delete s.agentClaims[target]; released += 1; }
      if (s.agents && s.agents[target]) { delete s.agents[target]; released += 1; }
      // A reservation is keyed `<toolUseId>#<idx>`, not the bare id — releasing by the
      // bare toolUseId should still reach every reservation it owns (and an exact bare-key
      // match too, for the rarer reservation shapes that are not multi-invocation-indexed).
      for (const key of Object.keys(s.reservations)) {
        if (key === target || key.startsWith(`${target}#`)) { delete s.reservations[key]; released += 1; }
      }
    }
    if (released) { save(s); process.stdout.write(`orchestrator-gate: released ${released} ownership claim(s).\n`); }
    else process.stdout.write(`orchestrator-gate: --release-claims ${target} matched no tracked claim.\n`);
  }

  const live = liveWorkers(s);
  const parts = [languageSentence(cfg, false) + 'Delegate; do not implement here.'];
  parts.push(...activeOverrideLines(cfg, s));
  const ex = currentExecRoute(cfg, s);
  const codexModelShown = ex.codexModel || cfg.models.codex.id;
  const coderName = (c) => c === 'codex' ? 'Codex' : c === 'kimi' ? 'Kimi' : 'DeepSeek';
  const roleByAlias = (alias) => Object.values(cfg.models).find((m) => m && m.alias === alias) || { alias, id: null };
  let codeRoute;
  if (ex.route === 'external' && ex.pick === 'codex') {
    codeRoute = `Codex in an Orca worker${codexModelShown ? ` (worker-start --agent codex --model ${codexModelShown})` : ''}`;
  } else if (ex.route === 'external' && ex.pick === 'kimi') {
    codeRoute = `Kimi in an Orca worker (worker-start --agent kimi, no --model)${ex.kimiModel ? ` (${ex.kimiModel} via default_model; Orca cannot pin it)` : ''}`;
  } else if (ex.route === 'external' && ex.pick === 'deepseek') {
    codeRoute = `DeepSeek in an Orca worker (worker-start --agent opencode, no --model)${ex.deepseekModel ? ` (${ex.deepseekModel} via ~/.config/opencode/opencode.jsonc; Orca cannot pin it)` : ''}`;
  } else if (ex.route === 'claude') {
    codeRoute = ex.alias === cfg.models.code.alias
      ? `in-session: ${codeModelDispatchText(cfg)}`
      : `in-session subagent (Agent model ${modelLabel(roleByAlias(ex.alias))})`;
  } else {
    const reasons = ex.coders
      ? ['codex', 'kimi', 'deepseek'].map((coder) => `${coderName(coder)} ${ex.coders[coder]?.reason || ex.coders[coder]?.state}`).join(', ')
      : ex.why;
    codeRoute = `${codeModelDispatchText(cfg)} [${reasons}]`;
  }
  if (ex.route === 'external' && ex.order?.length > 1 && ex.coders) {
    const coderText = (coder) => {
      const c = ex.coders[coder];
      const liveText = `${c.live} live`;
      let quotaText;
      if (c.headroom === null || c.headroom === undefined) {
        quotaText = 'quota unknown';
      } else if (c.estimated) {
        const readAgo = c.quotaFetchedAt ? EXEC_QUOTA.formatAge(Math.max(0, Date.now() - c.quotaFetchedAt)) : 'unknown';
        quotaText = `~${Math.max(0, Math.round(100 - c.leftPct))}% used (est., read ${readAgo} ago)`;
      } else {
        quotaText = `${Math.max(0, Math.round(c.headroom))}% headroom`;
      }
      return `${coderName(coder)} (${liveText}, ${quotaText})`;
    };
    codeRoute = `split: ${['codex', 'kimi', 'deepseek'].filter((c) => ex.order.includes(c)).map(coderText).join(' + ')}; next -> ${coderName(ex.pick)}`;
  } else if (ex.route === 'external' && ex.coders) {
    const others = ['codex', 'kimi', 'deepseek'].filter((c) => c !== ex.pick);
    codeRoute += `; ${others.map((c) => `${coderName(c)} ${ex.coders[c]?.standby ? 'overflow standby' : (ex.coders[c]?.reason || ex.coders[c]?.state || 'unavailable')}`).join('; ')}; next -> ${coderName(ex.pick)}`;
  }
  parts.push(`Model routing: plan/red-team -> model ${modelLabel(cfg.models.review)}; review -> ${reviewRouteText(cfg, s)}; verify -> ${verifyModelAlias(cfg)}; code -> ${codeRoute} [${ex.why}].`);
  parts.push(`${parallelBudgetLine(cfg, s)}.`);
  const activeHandoverIds = new Set(live.flatMap(([key, worker]) => [
    key, worker.group, worker.dispatchId, worker.taskId, worker.terminalHandle,
  ].filter(Boolean)));
  const handoverReminder = HANDOVER.reminder(DIR, s.session_id, activeHandoverIds);
  if (handoverReminder) parts.push(handoverReminder);
  if (live.length) {
    const baseline = s.last_heartbeat || Math.min(...live.map(([, w]) => w.started || Date.now()));
    const stale = Math.round((Date.now() - baseline) / 1000);
    parts.push(`${live.length} live worker(s): ${live.map(([k, w]) => `${k}(${w.role})`).join(', ')}.`);
    const hb = heartbeatAlive(s.session_id);
    if (hb) {
      parts.push(`Heartbeat daemon alive (pid ${hb.pid}, last tick ${Math.round((Date.now() - hb.last_tick) / 1000)}s ago): keep working on other things; it wakes you on any worker event.`);
    } else {
      parts.push(`NO heartbeat daemon: start it now so no worker waits on you unnoticed: ${heartbeatStartCommand()}.`);
      parts.push(s.last_heartbeat ? `Last manual poll ${stale}s ago.` : `Never polled since dispatch (${stale}s).`);
    }
    if (!hb && stale > cfg.heartbeat.idleSeconds) {
      parts.push('OVERDUE: run `orca orchestration worker-list` and `worker-read` on each now; a worker sitting IDLE is wasted wall-clock.');
    }
    const limited = live.filter(([, w]) => w.rate_limited_until && w.rate_limited_until > Date.now());
    if (limited.length) {
      parts.push(`Rate-limited, retry after backoff: ${limited.map(([k]) => k).join(', ')}.`);
    }
  }
  process.stdout.write(`${parts.join(' ')}\n`);
}

/** Not gated at all: activation says this session is out of scope. */
function activationApplies(cfg) {
  if (cfg.activation === 'off') return false;
  if (cfg.activation === 'orca-only') return !!process.env.ORCA_TERMINAL_HANDLE;
  return true; // 'always'
}

/**
 * Read-only max-parallel-agents capacity check against an already-loaded, already-fresh
 * `state` — returns a refusal string, or null when there is room (or the gate is disabled,
 * or the derived/explicit limit is unlimited). Never mutates `state` and never registers
 * anything: shared by the EARLY fast-fail pass in `onPreToolUse` and the FINAL re-check
 * immediately before registering a slot (C1 — see both call sites), so the two can never
 * drift apart on what counts as "at capacity".
 */
function checkParallelAgentCapacity(state, cfg) {
  if (gateDisabled(cfg, 'max-parallel-agents')) return null;
  const limit = agentParallelLimit(cfg);
  if (!Number.isFinite(limit)) return null;
  const usage = PAC.machineWideLiveUnits(DIR, Date.now(), { currentState: state, currentSessionId: state.session_id });
  if (usage.total < limit) return null;
  return PAC.formatParallelAgentsRefusal(usage, limit, PAC.cores(), parallelCoreFraction(cfg),
    { explicitLimit: maxParallelAgents(cfg) != null, stateDir: DIR });
}

/**
 * H3: when `checkParallelAgentCapacity` finds the caller's session at/over the machine-wide
 * limit, reconcile THIS session's own Orca-tracked workers against Orca's live worker-list
 * before accepting that as final — the same out-of-lock-fetch + locked-reapply pattern the
 * max-parallel-codex-workers gate (and, since H3, the worker-start/terminal-create paths)
 * already use. `fetchOrcaWorkerRows` does no state I/O, so it is safe to run with the lock
 * released; only the reapply, against a freshly reloaded state, ever mutates anything. A
 * worker this session's own bookkeeping still shows live, but that Orca has already
 * confirmed released or done, would otherwise refuse an Agent/Task dispatch that could
 * actually proceed right now.
 *
 * `sessionId`/`lockDir` identify what to reload/relock; `locked` is this call's current view
 * of whether the lock is held. Returns `{ state, violation, locked }` — the caller must
 * adopt the returned `locked` for its own eventual `finally`, and keep operating on the
 * returned `state` (reconciled when a reconcile actually ran, unchanged otherwise).
 */
function reconcileParallelAgentsAtCap(state, sessionId, cfg, lockDir, locked) {
  // Review round 3, item 1: disabled or non-finite (unlimited) means there is nothing this
  // cap could ever refuse — checked BEFORE `!locked` so a `.lock` some other process happens
  // to be holding can never masquerade as "at capacity" for a cap that isn't capping anything.
  if (gateDisabled(cfg, 'max-parallel-agents') || !Number.isFinite(agentParallelLimit(cfg))) {
    return { state, violation: null, locked };
  }
  // Concurrency review, Low item: a hard resource cap must never be evaluated unlocked — a
  // lock the caller could not acquire (contention timeout) means this check cannot trust
  // `state` against every other racing process, so it refuses with a transient-retry reason
  // instead of silently "degrading to allow" the way policy gates elsewhere in this file do.
  if (locked === null) return { state, violation: null, locked };
  if (locked === false) return { state, violation: PAC.LOCK_CONTENTION_MESSAGE, locked };
  const violation = checkParallelAgentCapacity(state, cfg);
  if (!violation) return { state, violation: null, locked };
  releaseLock(lockDir);
  const fetched = PARALLEL_OWNERSHIP.fetchOrcaWorkerRows(ORCA_BIN);
  const reacquired = acquireLock(lockDir, CAP_LOCK_OPTS);
  if (reacquired === null) return { state, violation: null, locked: null };
  if (reacquired === false) return { state, violation: PAC.LOCK_CONTENTION_MESSAGE, locked: false };
  const fresh = load(sessionId);
  if (fetched !== null) PARALLEL_OWNERSHIP.applyOrcaReconciliation(
    fresh, fetched.rows, fetched.exhaustive, fetched.terminalHandles);
  return { state: fresh, violation: checkParallelAgentCapacity(fresh, cfg), locked: true };
}

function onPreToolUse(p, s, cfg) {
  if (s.bypass) return;
  if (!isMainPanel(p)) return; // subagents do the real work; never gate them (Orca workers: see deny())
  maybeReconcilePendingPlaceholders(p.session_id, p.hook_event_name);
  const tool = p.tool_name;
  const input = p.tool_input || {};
  const d = (gate, reason) => { if (!gateDisabled(cfg, gate)) deny(s, gate, reason); };

  // Gate 1: the main panel does not write.
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const target = input.file_path || input.notebook_path;
    if (isExemptPath(target)) return;
    d('main-no-write',
      `The main panel may not modify ${target}. This panel orchestrates only.\n` +
      'Dispatch the edit to a Codex worker:\n' +
      '  orca orchestration task-create --title "<task>" ...\n' +
      '  orca orchestration worker-start --task <id> ...\n' +
      'Exempt surfaces the panel may still write: .claude/, plans/, docs/, scratch, /tmp.');
  }

  // Gate 2: the main panel does not mutate through the shell either.
  if (tool === 'Bash') {
    const cmd = String(input.command || '');
    // Judge per command, and only on the parts the shell treats as syntax:
    // a mutating verb quoted inside an echo is text, not an action.
    const offending = shellSegments(cmd).find((seg) => MUTATING_BASH.test(seg));
    if (offending || !movesOnlyExemptPaths(cmd)) {
      d('main-no-mutate',
        `Refusing a mutating shell command from the main panel: ${(offending || cmd).slice(0, 120)}\n` +
        'Integration and repository mutations belong to a worker, not the orchestrator panel.\n' +
        'Moving or deleting files under .claude/, plans/, docs/ or a temp dir is still allowed.');
    }
    // Code briefs handed to Codex through Orca must let it check itself. Judged on each
    // real orca invocation's own args and its OWN --spec text (quoted mentions in
    // grep/echo never match, and one invocation's brief never leaks into another's — item
    // 6), and only for code work: research / review / publish specs are not code briefs.
    const orcaSpecInvs = orcaInvocations(cmd).filter((inv) =>
      (inv.sub === 'orchestration task-create' || inv.sub === 'orchestration worker-start') &&
      hasFlag(inv.args, '--spec') && !hasFlag(inv.args, '--help'));
    for (const orcaInv of orcaSpecInvs) {
      const brief = PARALLEL_OWNERSHIP.resolveSpecText(orcaInv, cmd, p.cwd, { flagValue, briefText });
      if (EXEC_INTENT.test(brief.text) && !VERIFY_COMMAND.test(brief.text)) {
        d('code-brief-needs-verify', CODE_BRIEF_HELP +
          (brief.unreadable.length ? `\nCould not read spec file(s): ${brief.unreadable.join(', ')}` : ''));
      }
    }
    for (const raw of redirectTargets(cmd)) {
      const target = raw.replace(/^["']|["']$/g, '');
      if (target !== '/dev/null' && !isExemptPath(target)) {
        d('main-no-write',
          `Refusing a shell redirect that writes ${target} from the main panel.\n` +
          'Writing a file through the shell is still writing. Dispatch it to a worker.');
      }
    }

    // Gate A (max-parallel-codex-workers) + Gate B (code-brief-needs-owns /
    // ownership-overlap) + max-parallel-agents (machine-wide, any agent) for every real
    // worker-start / task-create in this command line.
    handleOrcaDispatchGates(p, s, cfg, cmd, d);
    // max-parallel-agents for a bare `terminal create` (not handled above — see its own doc).
    handleTerminalCreateAgentCap(p, s, cfg, cmd, d);

    // Advisory only: a Codex worker-start that omits --model gets no model pin, so a
    // fleet can silently drift onto whatever Codex defaults to. Skipped when --terminal
    // targets an existing terminal (its model is already fixed) or --model is already given.
    const codexInv = orcaInvocations(cmd).find((inv) =>
      inv.sub === 'orchestration worker-start' && flagValue(inv.args, '--agent') === 'codex');
    if (codexInv && !hasFlag(codexInv.args, '--terminal') && !hasFlag(codexInv.args, '--model') && cfg.models.codex.id) {
      addHookContext(`orchestrator-gate advice: pin the Codex model explicitly - add --model ${cfg.models.codex.id} ` +
        'to this worker-start so the fleet cannot silently drift onto a different default.');
    }
    const kimiInv = orcaInvocations(cmd).find((inv) =>
      inv.sub === 'orchestration worker-start' && flagValue(inv.args, '--agent') === 'kimi');
    if (kimiInv && hasFlag(kimiInv.args, '--model')) {
      addHookContext('orchestrator-gate advice: drop --model for --agent kimi; Kimi uses default_model from ~/.kimi-code/config.toml and Orca cannot pin it.');
    }
    const opencodeInv = orcaInvocations(cmd).find((inv) =>
      inv.sub === 'orchestration worker-start' && flagValue(inv.args, '--agent') === 'opencode');
    if (opencodeInv && hasFlag(opencodeInv.args, '--model')) {
      addHookContext('orchestrator-gate advice: drop --model for --agent opencode; opencode uses the model from ~/.config/opencode/opencode.jsonc and Orca cannot pin it.');
    }

    if (input.run_in_background && /(?:^|[\s/])orca-heartbeat\.cjs(?:[\s"']|$)/.test(cmd)) {
      let fresh = load(p.session_id);
      if (pruneBackgroundShells(fresh)) {
        const lockDir = path.join(DIR, '.lock');
        const locked = acquireLock(lockDir, {});
        if (locked) {
          try {
            fresh = load(p.session_id);
            if (pruneBackgroundShells(fresh)) save(fresh);
          } finally {
            releaseLock(lockDir);
          }
        }
      }
      const previous = Object.entries(fresh.backgroundShells || {}).find(([, shell]) => shell?.heartbeat);
      if (previous) {
        addHookContext(`orchestrator-gate: stop previous heartbeat shell ${previous[0]} with TaskStop before starting another; only one heartbeat may run per session.`);
      }
    }
  }

  // Gate: max-parallel-agents — EARLY, READ-ONLY fast-fail. A MACHINE-wide budget (this
  // machine's cores, not any one session's own concurrency) on live Orca workers of any
  // agent plus live in-session Agent/Task subagents, on top of (never instead of) the
  // existing Codex-only cap. This check alone never registers a slot (C1 fix): the actual
  // registration happens at the very END of the routing/ownership gates below, after every
  // gate that could still refuse this exact dispatch has passed. Registering here, before
  // those later gates ran, used to leave a refused dispatch's slot claimed for up to
  // AGENT_REGISTRY_TTL_MS (120 minutes), since a refused dispatch never reaches PostToolUse
  // to release it. This early pass exists only so an already-over-budget dispatch gets the
  // max-parallel-agents refusal instead of walking through routing/ownership first.
  if ((tool === 'Agent' || tool === 'Task') &&
      !gateDisabled(cfg, 'max-parallel-agents') && Number.isFinite(agentParallelLimit(cfg))) {
    const lockDir = path.join(DIR, '.lock');
    let violation = null;
    let locked = acquireLock(lockDir, CAP_LOCK_OPTS);
    try {
      // CRITICAL: reload fresh now the lock is held — same reasoning as every other
      // lock-protected read-decide-reserve section in this file. H3: reconcile against
      // Orca before accepting an at-cap verdict as final.
      const result = reconcileParallelAgentsAtCap(load(s.session_id), s.session_id, cfg, lockDir, locked);
      violation = result.violation;
      locked = result.locked;
    } finally {
      if (locked) releaseLock(lockDir);
    }
    if (violation) d('max-parallel-agents', violation);
  }

  // Gates 3 and 4: role routing for dispatched work.
  if (tool === 'Agent' || tool === 'Task') {
    // Classify by the verb that governs the task, not by mere presence of a keyword:
    // "plan the refactor" is planning, "implement the plan" is execution, "verify the
    // build" is verify-run. Precedence: execution (even behind a verify/test first verb),
    // then review (a review verb / reviewer type / code noun beats a verify verb), then
    // verify. See classifyDispatch.
    const description = String(input.description || '').trim();
    const type = String(input.subagent_type || '');
    const hay = `${type} ${description}`.trim() || String(input.prompt || '').slice(0, 400);
    const { wantsExec, wantsPlanReview, wantsVerify, planning } =
      classifyDispatch(description, type, input.prompt, cfg.agents.lookup);
    // A lookup role type (agents.lookup, e.g. Explore/scout) is advisory lookup work: it never
    // blocks and never runs on the review/verify model, so it is exempt from review-model-scope
    // below. Only a CONFIGURED lookup subagent_type is exempt; a general-purpose summary that
    // merely reads like a lookup ("find where ...") is not, so it is still held to the opus-only
    // rule. The wording leg below (LOOKUP_INTENT) drives the lookup-model advice, never the
    // exemption.
    const typeIsLookup = cfg.agents.lookup.some((n) => n.toLowerCase() === type.toLowerCase());
    const wantsLookup = typeIsLookup || (LOOKUP_INTENT.test(hay) && !wantsExec && !wantsPlanReview);
    const model = String(input.model || '');
    const reviewAlias = cfg.models.review.alias;
    const escalationAlias = cfg.models.escalation.alias;
    const isEscalation = new RegExp(escapeRegex(escalationAlias), 'i').test(model)
      || cfg.agents.escalation.some((n) => n.toLowerCase() === type.toLowerCase());
    const isReviewModel = new RegExp(escapeRegex(reviewAlias), 'i').test(model);

    // Review of code follows the code's author (operator decision, 2026-10-01): code by an
    // external coder (codex/kimi/deepseek) is reviewed on the mapped model (all opus by
    // default, operator decision 2026-10-02), code by the code model itself on the review
    // model. Planning and red-team stay on the review model. Verify-run work is separate:
    // it always runs on the verify model (sonnet), never on the review model without an
    // escalation note. An unknown author allows either review model, so a review is never
    // blocked just because the gate cannot tell who wrote the code.
    const codeAlias = cfg.models.code.alias;
    const isCodeModel = new RegExp(escapeRegex(codeAlias), 'i').test(model);
    // Set by the exec branch when this is in-session code on the code model; the author is
    // recorded ONLY after every refusing gate below has run (review, blocker 6).
    let recordSonnetAuthor = false;
    const author = s.lastCodeAuthor || null;
    if (wantsPlanReview && !isEscalation) {
      if (planning || !author) {
        const allowed = isReviewModel || (!planning && isCodeModel);
        if (!allowed) {
          d('route-review',
            `Planning / red-team / review must run on model "${reviewAlias}"` +
            (planning ? '' : ` (or "${codeAlias}" when the code was written by an external coder)`) + '.\n' +
            `Re-dispatch with model: "${reviewAlias}". ` +
            `Current dispatch: subagent_type="${type}" model="${model || 'inherited'}".`);
        }
      } else {
        const mapped = reviewModelForCoder(cfg, author) || reviewAlias;
        const onMapped = new RegExp(escapeRegex(mapped), 'i').test(model);
        if (!onMapped) {
          if (isReviewModel && mapped !== reviewAlias) {
            if (!hasReviewEscalationReason(input, mapped)) {
              d('review-model-follows-coder',
                `Code here was written by ${author}: review it on model "${mapped}"` +
                (mapped === codeAlias ? ` at effort ${cfg.models.reviewEffort}` : '') +
                ` first, not "${reviewAlias}" ` +
                `(a model never reviews its own output; "${reviewAlias}" is reserved for code "${codeAlias}" wrote).\n` +
                `Escalate to "${reviewAlias}" only after the "${mapped}" review cannot decide — say so in the dispatch, e.g.\n` +
                `  "escalation: ${mapped} review could not decide ...".\n` +
                `Current dispatch: subagent_type="${type}" model="${model || 'inherited'}".`);
            }
          } else {
            d('route-review',
              `Review of ${author}-authored code must run on model "${mapped}"` +
              (mapped === codeAlias ? ` at effort ${cfg.models.reviewEffort}` : '') + '.\n' +
              `Re-dispatch with model: "${mapped}". ` +
              `Current dispatch: subagent_type="${type}" model="${model || 'inherited'}".`);
          }
        }
      }
    }
    // Verify-run work (CI, screenshots, play-test, post-deploy smoke) runs on the verify
    // model (sonnet), NOT the review model (opus) — operator decision, 2026-10-02. Opus may
    // run a verify only after the verify model already ran and could not decide, the same
    // "say why in the dispatch" escalation shape as review-follows-coder.
    if (wantsVerify && !isEscalation) {
      const verifyAlias = verifyModelAlias(cfg);
      const onVerify = new RegExp(escapeRegex(verifyAlias), 'i').test(model);
      if (!onVerify) {
        if (isReviewModel) {
          if (!hasVerifyEscalationReason(input, verifyAlias)) {
            d('verify-model',
              `Verify-run work must run on model "${verifyAlias}"` +
              ` at effort ${cfg.models.verify.effort || 'medium'} first, not "${reviewAlias}" ` +
              `(the review model reads code and judges diffs; it does not run checks).\n` +
              `Escalate to "${reviewAlias}" only after the "${verifyAlias}" verify cannot decide — say so in the dispatch, e.g.\n` +
              `  "escalation: ${verifyAlias} verify could not decide ...".\n` +
              `Current dispatch: subagent_type="${type}" model="${model || 'inherited'}".`);
          }
        } else {
          d('route-verify',
            `Verify-run work (CI, screenshots, play-test, post-deploy smoke) must run on model "${verifyAlias}"` +
            ` at effort ${cfg.models.verify.effort || 'medium'}.\n` +
            `Re-dispatch with model: "${verifyAlias}". ` +
            `Current dispatch: subagent_type="${type}" model="${model || 'inherited'}".`);
        }
      }
    }
    // The review model is reserved for the work it took over from the escalation model:
    // planning / review — unless the operator explicitly picked it to code. Verify-run work
    // with an escalation note is allowed on the review model and handled above; advisory
    // lookup work is exempt (it never blocks and may run on any model).
    const exNow = currentExecRoute(cfg, s);
    const operatorPicked = wantsExec && exNow.route === 'claude' && !!exNow.alias &&
      (exNow.alias === escalationAlias ? isEscalation : model.toLowerCase().includes(String(exNow.alias).toLowerCase()));
    if (isReviewModel && !wantsPlanReview && !wantsVerify && !typeIsLookup && !operatorPicked) {
      d('review-model-scope',
        `model "${reviewAlias}" is reserved for planning / review.\n` +
        `Code goes to Codex or "${cfg.models.code.alias}" per the current exec route; other in-session work runs on model "${cfg.models.code.alias}".\n` +
        `Current dispatch: subagent_type="${type}" description="${String(input.description || '').slice(0, 80)}".`);
    }
    // The escalation model is reserved for work the review model could not do, for any intent.
    if (isEscalation && !hasEscalationReason(cfg, input) && !operatorPicked) {
      d('escalation-scope',
        `model "${escalationAlias}" is reserved for work "${reviewAlias}" could not do, even at higher effort.\n` +
        `Ladder: model "${reviewAlias}" -> "${reviewAlias}" at high effort (say so in the prompt, or --effort high on Orca) -> "${escalationAlias}".\n` +
        'Re-dispatch with a reason in the description or prompt head that names the effort already tried, e.g.\n' +
        `  "escalation: ${reviewAlias} failed twice at high effort to ...".\n` +
        `Current dispatch: subagent_type="${type}" model="${model || 'inherited'}".`);
    }

    if (wantsExec) {
      const ex = currentExecRoute(cfg, s);
      const inSession = ex.route !== 'external' || orcaFallbackActive();
      const wantAlias = ex.route === 'claude' ? ex.alias : cfg.models.code.alias;
      if (!inSession) {
        const pickName = ex.pick === 'kimi' ? 'Kimi' : ex.pick === 'deepseek' ? 'DeepSeek (opencode)' : 'Codex';
        d('route-execution-to-codex',
          `Code goes to an external coder (${pickName}) in an Orca worker right now [${ex.why}].\n` +
          'Use: orca orchestration task-create -> worker-start -> worker-read/worker-list -> worker-release.\n' +
          'If Orca genuinely cannot open a worker, declare the fallback first:\n' +
          '  date -u +%Y-%m-%dT%H:%M:%SZ > ~/.claude/orchestrator-gate/orca-unavailable\n' +
          `That declaration expires after ${Math.round(ORCA_DOWN_TTL_SECONDS / 60)} minutes, on purpose.\n` +
          'The operator (only) can pick the coding model with --code-model <alias|codex|codex:<model>|kimi|kimi:<model>|deepseek|deepseek:<model>|auto>.');
      }
      if (!model.toLowerCase().includes(String(wantAlias || '').toLowerCase())) {
        const redispatch = wantAlias === cfg.models.code.alias
          ? `Re-dispatch as Agent subagent_type ${cfg.models.code.agentType || wantAlias} + model "${wantAlias}" (effort ${cfg.models.code.effort || 'medium'}).`
          : `Re-dispatch with model: "${wantAlias}".`;
        d('execution-model-mismatch',
          `In-session code work must run on model "${wantAlias}" [${ex.why}]. ${redispatch} ` +
          `Current dispatch: subagent_type="${type}" model="${model || 'inherited'}".`);
      }
      if (!VERIFY_COMMAND.test(`${input.description || ''}\n${input.prompt || ''}`)) {
        d('code-brief-needs-verify', CODE_BRIEF_HELP);
      }
      // In-session code on the configured code model makes the code's author "sonnet", so a
      // later review/verify of it is routed to the review model (never the same model). The
      // actual write happens after every refusing gate below (blocker 6).
      recordSonnetAuthor = inSession && wantAlias === cfg.models.code.alias;

      // Gate B for in-session code dispatches: isolated work (a fresh worktree, or a
      // remote sandbox) needs no Owns:; anything sharing this workspace does. Runs under
      // the same lock as the Bash-side check in handleOrcaDispatchGates, and — same
      // reasoning as there — always releases it via `finally` before `d()` can exit.
      if (!input.isolation) {
        const lockDir = path.join(DIR, '.lock');
        let violation = null;
        // Same caution as handleOrcaDispatchGates: only release the lock if we acquired it.
        const locked = acquireLock(lockDir, {});
        try {
          // CRITICAL: reload fresh now that the lock is held — `s` here is the snapshot
          // main() loaded before this lock was ever acquired, so a concurrent dispatch's
          // just-saved claim would otherwise be invisible to this check, and this call's own
          // save would then clobber it. See the identical fix in handleOrcaDispatchGates.
          const fresh = load(s.session_id);
          const repoRootDir = OWN.repoRoot(p.cwd);
          const ws = OWN.workspaceKey({ repoRootDir, worktreeValue: null, isolated: false });
          const brief = `${input.description || ''}\n${input.prompt || ''}`;
          const parsed = OWN.parseOwns(brief, { repoRoot: repoRootDir });
          if (!parsed.present && !gateDisabled(cfg, 'code-brief-needs-owns')) {
            violation = { gate: 'code-brief-needs-owns', reason: OWNS_BRIEF_HELP };
          } else if (parsed.present && !parsed.isNA && parsed.owns.length) {
            const ttl = ownershipClaimTtlMinutes(cfg);
            const claims = OC.liveClaims(fresh, ttl, null);
            const conflict = OC.findOverlap(claims, ws, parsed.owns);
            if (conflict && !gateDisabled(cfg, 'ownership-overlap')) {
              violation = { gate: 'ownership-overlap', reason:
                `Owns ${conflict.hit.b} overlaps ${conflict.hit.a} held by ${conflict.id} (since ${OC.ageString(conflict.ts)}) ` +
                `in workspace ${ws}.\nNarrow the claim, wait for or release that worker, or run it in its own worktree: ` +
                'Agent isolation:"worktree".' };
            } else {
              const toolUseId = p.tool_use_id || p.toolUseId;
              // `background`: a run_in_background dispatch's own PostToolUse fires as soon as
              // the LAUNCH returns, long before the actual work is done — this claim must
              // survive that event (see onPostToolUse) and instead release via a matching
              // <task-notification>, the TTL, or --release-claims.
              if (toolUseId) {
                fresh.agentClaims[toolUseId] = { owns: parsed.owns, ws, ts: Date.now(), background: !!input.run_in_background };
                save(fresh);
              }
            }
          }
        } finally {
          if (locked) releaseLock(lockDir);
        }
        if (violation) d(violation.gate, violation.reason);
      }
    }

    // Light lookups: advise the lookup model (never blocks).
    if (wantsLookup && !new RegExp(escapeRegex(cfg.models.lookup.alias), 'i').test(model) && !isEscalation) {
      addHookContext(`orchestrator-gate advice: this looks like a light lookup (find/locate/read logs/explore). ` +
        `Prefer model "${cfg.models.lookup.alias}" for such dispatches - cheaper and faster; keep the code model for heavier reading.`);
    }

    // max-parallel-agents: re-check + register the slot now, ONLY after every routing/
    // ownership gate above has passed (C1 fix). Registering earlier let a dispatch that
    // failed a LATER gate leak a slot for up to AGENT_REGISTRY_TTL_MS, because a refused
    // dispatch never fires PostToolUse to release it. The re-check (not just a bare write)
    // catches a slot that filled up while this dispatch's own routing/ownership checks were
    // running. Registration happens even when the gate itself is disabled (`gateDisabled`
    // check lives inside `checkParallelAgentCapacity`), so a disabled gate never silently
    // drops the accounting a re-enabled gate would need later.
    {
      const lockDir = path.join(DIR, '.lock');
      let violation = null;
      // A finite, enabled hard cap must outlive file-lock's stale threshold. When the cap
      // is disabled or unlimited this block only keeps best-effort bookkeeping, so retain
      // file-lock's short default instead of making an allowed dispatch wait 10.5 seconds.
      const hardCapActive = !gateDisabled(cfg, 'max-parallel-agents') && Number.isFinite(agentParallelLimit(cfg));
      let locked = acquireLock(lockDir, hardCapActive ? CAP_LOCK_OPTS : {});
      try {
        // CRITICAL: reload fresh now the lock is held — same reasoning as every other
        // lock-protected read-decide-reserve section in this file. H3: reconcile against
        // Orca before accepting an at-cap verdict as final.
        const result = reconcileParallelAgentsAtCap(load(s.session_id), s.session_id, cfg, lockDir, locked);
        let fresh = result.state;
        violation = result.violation;
        locked = result.locked;
        if (!violation) {
          const toolUseId = p.tool_use_id || p.toolUseId;
          if (toolUseId) {
            fresh.agents[toolUseId] = {
              ts: Date.now(), background: !!input.run_in_background,
              type: String(input.subagent_type || ''), model: String(input.model || ''),
            };
            save(fresh);
          }
        }
      } finally {
        if (locked) releaseLock(lockDir);
      }
      if (violation) d('max-parallel-agents', violation);
    }

    // Record the in-session code author LAST, after every gate that can refuse this
    // dispatch has run (review, blocker 6): a refused code dispatch must never flip
    // `lastCodeAuthor` to sonnet, which would wrongly refuse the next Sonnet review of an
    // external coder's code. Skip the write entirely when the lock cannot be held.
    if (recordSonnetAuthor) {
      const lockDir = path.join(DIR, '.lock');
      const locked = acquireLock(lockDir, {});
      if (locked) {
        try {
          const fresh = load(s.session_id);
          if (recordCodeAuthor(fresh, 'sonnet', Date.now())) save(fresh);
        } finally {
          releaseLock(lockDir);
        }
      }
    }
  }
}

/**
 * Drops `toolUseId`'s live reservation and/or in-session-Agent ownership claim. Shared by
 * the defense-in-depth `toolFailed` check inside `onPostToolUseLocked` and by
 * `onPostToolUseFailure` (the real, separate failure event) — a failed dispatch must never
 * hold a parallel-Codex-worker opening or an Owns: claim until its TTL just because it errored.
 * Returns true when anything was actually removed.
 */
function dropFailedToolState(s, toolUseId) {
  if (!toolUseId) return false;
  let dirty = false;
  for (const key of Object.keys(s.reservations)) {
    if (key === toolUseId || key.startsWith(`${toolUseId}#`) || key.startsWith(`term:${toolUseId}#`)) {
      delete s.reservations[key]; dirty = true;
    }
  }
  if (s.agentClaims[toolUseId]) { delete s.agentClaims[toolUseId]; dirty = true; }
  if (s.agents && s.agents[toolUseId]) { delete s.agents[toolUseId]; dirty = true; }
  if (s.backgroundShells && s.backgroundShells[toolUseId]) { delete s.backgroundShells[toolUseId]; dirty = true; }
  return dirty;
}

// Sub-commands whose reply must be scanned for a real dispatch id, shared by the success
// path (onPostToolUseLocked) and the failure path (onPostToolUseFailure) below — a command
// like `orca orchestration worker-start ... --json && false` genuinely dispatches a worker
// even though the overall Bash call reports non-zero, so both paths must recognise the same
// set of dispatch-shaped sub-commands.
const DISPATCH_SUBS = new Set(['orchestration worker-start', 'orchestration task-create', 'terminal create']);

/** Decode JSON command output before terminal-line classification so escaped newlines in
 * worker-read previews become real line boundaries. Only string values are terminal text;
 * object keys and numeric metadata must not create signal-shaped false positives. */
function workerOutputSignalText(out) {
  let parsed;
  try { parsed = JSON.parse(out); } catch { return out; }
  const strings = [];
  const visit = (value) => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(parsed);
  return strings.join('\n');
}

function readinessTimeoutDetails(replyText) {
  if (!/"stage"\s*:\s*"agent_readiness"/i.test(replyText) ||
      !/"lastError"\s*:\s*"timeout"/i.test(replyText)) return null;
  const terminal = replyText.match(/"(?:agentTerminalHandle|terminalHandle)"\s*:\s*"([A-Za-z0-9_.:-]+)"/i)?.[1];
  const dispatch = replyText.match(/"dispatchId"\s*:\s*"([A-Za-z0-9_.:-]+)"/i)?.[1];
  return { terminal, dispatch };
}

function readinessTimeoutAdvice(replyText) {
  const details = readinessTimeoutDetails(replyText);
  if (!details) return null;
  const { terminal, dispatch } = details;
  const terminalArg = terminal || '<terminalHandle>';
  const dispatchArg = dispatch || '<dispatchId>';
  return 'orchestrator-gate: worker-start timed out at agent readiness, but its terminal may become usable. ' +
    'Do not launch a replacement. Send the original spec, then retain the dispatch:\n' +
    `  orca terminal send --terminal ${terminalArg} --text "$(cat <spec-file>)" --enter\n` +
    `  orca orchestration worker-retain --dispatch ${dispatchArg}\n`;
}

/**
 * Scans `out` (stdout+stderr on a success, or the failure event's own `error` text on a
 * failure) for every DISPATCH_SUBS invocation in `cmd` and registers whatever it finds,
 * exactly like a successful dispatch would: a real id found anywhere in that invocation's
 * own reply registers the worker/task and clears its reservation, and an explicit
 * `"ok":false` clears the reservation without registering anything, in both cases regardless
 * of whether the overall tool call itself reported success or failure.
 *
 * The one place the two callers must differ is what happens when NEITHER a real id nor
 * `"ok":false` is found for an invocation: `assumeDispatched: true` (the ordinary success
 * path) treats that as "it definitely ran, Orca's reply just didn't carry an id" and tracks
 * an unverified `pending-*` placeholder; `assumeDispatched: false` (the failure path) means
 * we genuinely do not know whether it dispatched — silently under-counting a worker that IS
 * actually running would blow through the parallel-Codex cap, so it leaves the reservation
 * untouched and lets the existing 10-minute TTL be the safety net instead of guessing.
 *
 * Returns true when anything in `s` changed.
 */
/**
 * Parse fallback for a piped/redirected dispatch: when the invocation's own JSON reply is
 * unparseable, a `"dispatchId": "ctx_..."` line is often still present in the raw output
 * (e.g. `worker-start --json | grep dispatchId`), or — via `jq -r .result.dispatchId` — a
 * bare `ctx_...` token. Accept either ONLY when the whole output pins exactly one distinct
 * dispatch id — anything else (a second invocation's segment, a chained worker-list's many
 * ids) stays a pending placeholder, never a guessed registration. Optional single taskId /
 * terminal handle are picked up the same way. Returns a Set of ids, possibly empty.
 */
function singleDispatchIdsFromRawOutput(out, cmd) {
  const ids = new Set();
  const text = String(out || '');
  // Ids already named in the command line (--retry-of ctx_OLD, --dispatch ctx_X, ...) are
  // inputs to the dispatch, never its result — they must never be picked up from output.
  const inCommand = new Set([...String(cmd || '').matchAll(/\b((?:ctx|task|term)_[A-Za-z0-9_-]+)\b/g)].map((m) => m[1]));
  const fresh = (set) => new Set([...set].filter((id) => !inCommand.has(id)));
  let dispatchIds = fresh([...text.matchAll(/"dispatchId"\s*:\s*"(ctx_[A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  if (dispatchIds.size !== 1) {
    // A raw-mode formatter (`jq -r ...`) prints the id bare, with no field name around it.
    dispatchIds = fresh([...text.matchAll(/\b(ctx_[A-Za-z0-9_-]+)\b/g)].map((m) => m[1]));
  }
  if (dispatchIds.size !== 1) return ids;
  ids.add([...dispatchIds][0]);
  const taskIds = fresh([...text.matchAll(/"taskId"\s*:\s*"(task_[A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  if (taskIds.size === 1) ids.add([...taskIds][0]);
  const handles = fresh([...text.matchAll(/"(?:agentTerminalHandle|terminalHandle|handle)"\s*:\s*"(term_[A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  if (handles.size === 1) ids.add([...handles][0]);
  return ids;
}

function registerDispatchReplies(s, p, cmd, out, { assumeDispatched }) {

  const allInvs = orcaInvocations(cmd).filter((inv) => !hasFlag(inv.args, '--help'));
  const dispatchEntries = allInvs.map((inv, commandIndex) => ({ inv, commandIndex }))
    .filter(({ inv }) => DISPATCH_SUBS.has(inv.sub));
  const dispatchInvs = dispatchEntries.map(({ inv }) => inv);
  if (!dispatchInvs.length) return false;
  const toolUseId = p.tool_use_id || p.toolUseId || null;
  const rawReplies = WG.splitJsonReplies(out);
  const jsonStartsOutput = /^[\s\r\n]*\{/.test(String(out || ''));
  // A count mismatch (e.g. one invocation's reply got swallowed by a log-line prefix that
  // defeated the line-start discriminator, or a stray object was miscounted as a reply) means
  // positional zipping (`replies[idx]` <-> `dispatchInvs[idx]`) cannot be trusted AT ALL — it
  // would silently credit one invocation's ids/owns/agent to a completely different
  // invocation. Rather than guess which index is "really" which, every invocation in this
  // command is treated as id-less: each falls through to its own "no ids found" handling
  // (a pending placeholder on the success path, an untouched reservation on the failure path),
  // which is always safe even when wrong, unlike a confident-but-incorrect attribution.
  const fullCommandMapping = rawReplies.length === allInvs.length;
  // When another Orca invocation also ran, a surviving JSON object can belong to that
  // command after a formatter consumed worker-start's own reply. In the safe dispatch-only
  // case, worker-start --json is the first emitted value; any leading free text makes the
  // attribution ambiguous and leaves a pending reservation instead of stealing another id.
  const allDispatchOutputDirect = dispatchInvs.every((inv) =>
    !inv.stdoutPiped && !inv.stdoutRedirected && !inv.stdoutCaptured);
  const dispatchOnlyMapping = allDispatchOutputDirect && rawReplies.length === dispatchInvs.length &&
    (allInvs.length === dispatchInvs.length || jsonStartsOutput);
  const mismatched = !fullCommandMapping && !dispatchOnlyMapping;
  const replies = mismatched ? null : dispatchEntries.map(({ inv, commandIndex }, idx) =>
    (inv.stdoutPiped || inv.stdoutRedirected || inv.stdoutCaptured)
      ? null
      : (fullCommandMapping ? rawReplies[commandIndex] : rawReplies[idx]));
  const replyAt = (idx) => mismatched ? null : replies[idx] || null;
  let dirty = false;

  dispatchInvs.forEach((inv, idx) => {
    const resId = toolUseId ? `${toolUseId}#${idx}` : null;
    const reservation = resId ? s.reservations[resId] : null;
    // A piped single dispatch (the whole command is this one invocation) whose formatter
    // re-emitted the reply as JSON (| jq ., | tee): the one surviving reply is this
    // invocation's own for EVERY purpose — the "ok": false / readiness-timeout handling
    // below included, not only id extraction (N2). A captured (`$( )`/backtick) or
    // redirected reply never reaches the tool's stdout at all, and with any other orca
    // invocation in the command a surviving object could belong to its segment.
    const pipedSoleDispatch = assumeDispatched && dispatchInvs.length === 1 && allInvs.length === 1 &&
      inv.stdoutPiped && !inv.stdoutCaptured && !inv.stdoutRedirected;
    const reply = replyAt(idx) ||
      (pipedSoleDispatch && rawReplies.length === 1 ? rawReplies[0] : null);
    const replyText = reply ? JSON.stringify(reply) : '';

    if (inv.sub === 'orchestration task-create') {
      const taskId = reply && WG.fieldValuesFromReply(reply, 'taskId').find((id) => /^task_[A-Za-z0-9_-]+$/.test(id));
      if (taskId) {
        s.tasks[taskId] = { owns: reservation ? reservation.owns : null, ws: reservation ? reservation.ws : null };
        if (resId) delete s.reservations[resId];
        dirty = true;
      } else if (assumeDispatched && resId && s.reservations[resId]) {
        delete s.reservations[resId];
        dirty = true;
      } // failure path with no id at all: leave the reservation for the TTL to resolve.
      return;
    }

    // Only a MAIN-PANEL, reservation-backed dispatch is ever registered here (item 13).
    if (!isMainPanel(p)) return;

    const failed = /"ok"\s*:\s*false/i.test(replyText);
    const agent = reservation ? reservation.agent
      : (inv.sub === 'orchestration worker-start' ? resolveWorkerStartAgent(inv, s) : null);
    const worktreeIds = reply ? WG.fieldValuesFromReply(reply, 'worktreeId') : [];

    if (failed) {
      const readiness = inv.sub === 'orchestration worker-start' && readinessTimeoutDetails(replyText);
      if (readiness?.dispatch) {
        s.workers[readiness.dispatch] = {
          role: `${agent || 'worker'}-exec`, started: Date.now(), status: 'live', last_seen: Date.now(),
          rate_limited_until: 0, group: readiness.dispatch, kind: WG.kindOf(readiness.dispatch), agent,
          owns: reservation ? reservation.owns : null, ws: reservation ? reservation.ws : null,
          worktreeIds, readinessTimeout: true,
        };
        if (inv.sub === 'orchestration worker-start') {
          writeLastCoder(agent);
          recordCodeAuthor(s, poolCoderForAgent(agent), Date.now());
        }
        dirty = true;
      }
      if (resId && s.reservations[resId]) { delete s.reservations[resId]; dirty = true; }
      const readinessAdvice = readiness && readinessTimeoutAdvice(replyText);
      process.stdout.write(readinessAdvice ||
        'orchestrator-gate: orca worker-start reported "ok": false; nothing was registered.\n');
      return;
    }

    const ids = reply ? WG.idsFromReply(reply) : new Set();
    // Parse fallback only for the same PIPED single dispatch when NO JSON survived: the
    // pipe's downstream fragments (a grep/tail line, or a bare ctx_ from `jq -r`) still
    // derive from this invocation's own reply — but never an id that already appears in
    // the command line itself (e.g. --retry-of / --dispatch args, N3).
    if (!ids.size && pipedSoleDispatch && rawReplies.length === 0) {
      for (const id of singleDispatchIdsFromRawOutput(out, cmd)) ids.add(id);
    }
    if (!ids.size) {
      if (!assumeDispatched) return; // unknown outcome on a failure event: keep the reservation.
      const pendingId = `pending-${Date.now()}-${idx}`;
      s.workers[pendingId] = {
        role: `${agent || 'worker'}-exec`, started: Date.now(), status: 'live', last_seen: Date.now(),
        rate_limited_until: 0, unverified: true, group: pendingId, kind: 'worker', agent,
        owns: reservation ? reservation.owns : null, ws: reservation ? reservation.ws : null,
        worktreeIds,
      };
      recordCodeAuthor(s, poolCoderForAgent(agent), s.workers[pendingId].started);
      dirty = true;
      process.stdout.write(
        'orchestrator-gate: orca worker-start ran but no dispatch id was found in its output; ' +
        `tracked as ${pendingId} until \`orca orchestration worker-list\` resolves it.\n`
      );
    } else {
      const group = WG.canonicalGroup(ids) || `start-${Date.now()}-${idx}`;
      for (const id of ids) {
        s.workers[id] = {
          role: `${agent || 'worker'}-exec`, started: Date.now(), status: 'live', last_seen: Date.now(),
          rate_limited_until: 0, group, kind: WG.kindOf(id), agent,
          owns: reservation ? reservation.owns : null, ws: reservation ? reservation.ws : null,
          worktreeIds,
        };
      }
      if (inv.sub === 'orchestration worker-start') {
        writeLastCoder(agent);
        recordCodeAuthor(s, poolCoderForAgent(agent), Date.now());
      }
      dirty = true;
      if (!heartbeatAlive(s.session_id)) {
        process.stdout.write(
          'orchestrator-gate: worker dispatched. Start the heartbeat now so it cannot sit IDLE unnoticed:\n' +
          `  ${heartbeatStartCommand()}\n`
        );
      }
    }
    if (resId && s.reservations[resId]) { delete s.reservations[resId]; dirty = true; }
  });
  return dirty;
}

/**
 * `PostToolUseFailure` — Claude Code's actual event for a tool call that errored out
 * (code.claude.com/docs/en/hooks; claude-code issue #6371), distinct from `PostToolUse`.
 * Runs under the same lock-reload-mutate-save discipline as every other state write (item
 * 1 of the prior round).
 *
 * A Bash call that actually invoked a dispatch sub-command and then genuinely errored out
 * (non-zero exit — e.g. `orca orchestration worker-start ... --json && false`) may well have
 * dispatched a real worker before that failure; the exit code says nothing about whether the
 * dispatch itself succeeded. `p.error` carries the command's actual output on this event, so
 * it is scanned exactly like a successful reply would be via `registerDispatchReplies`. Only a
 * Bash call with NO dispatch sub-command at all, one whose error text contains neither a `{`
 * nor a bare ctx_/task_/term_ id token (a dispatch without `--json` can still print a plain-text
 * id line, so both are checked — there is no ambiguity left only once neither is present), or an
 * Agent/Task claim (no such ambiguity to begin with), gets its reservation/claim dropped
 * immediately.
 *
 * NOTE: cancelling/interrupting a still-running tool call does NOT fire this event at all
 * (Claude Code's hook docs) — that case never reaches this handler and is invisible to it.
 * It is handled correctly by the reservation's own TTL expiry instead, same as it always was.
 */
function onPostToolUseFailure(p, s, cfg) {
  const lockDir = path.join(DIR, '.lock');
  const locked = acquireLock(lockDir, {});
  try {
    s = load(p.session_id);
    const toolUseId = p.tool_use_id || p.toolUseId;
    let dirty = false;
    if (toolUseId && s.backgroundShells && s.backgroundShells[toolUseId]) {
      delete s.backgroundShells[toolUseId];
      dirty = true;
    }
    if (p.tool_name === 'Bash') {
      const cmd = String((p.tool_input && p.tool_input.command) || '');
      // A worker-stop/-release/-abandon whose command exited non-zero can still carry a
      // reply showing the worker already stopped/closed ("[stopped]", "process=closed",
      // "terminal [released]") — settle its group anyway, or a failed release command
      // leaves the group `live` and holding its Owns: claim forever.
      if (WG.replyShowsWorkerStopped(p.error)) {
        for (const inv of orcaInvocations(cmd)) {
          const target = WG.releaseTarget(inv, flagValue);
          if (!target || !s.workers[target]) continue;
          if (settleCodeGroup(s, WG.groupOf(s.workers[target], target))) dirty = true;
        }
      }
      const hasDispatch = orcaInvocations(cmd).some((inv) => DISPATCH_SUBS.has(inv.sub) && !hasFlag(inv.args, '--help'));
      const errorText = String(p.error || '');
      // Two different "no id was found" cases must NOT be treated the same:
      //  - errorText is NON-EMPTY, contains no `{` at all, AND no bare ctx_/task_/term_ token
      //    either (e.g. `--bad-flag`'s plain-text CLI usage error) — genuinely nothing to find.
      //    No ambiguity: drop now. A dispatch WITHOUT `--json` prints a plain-text id line
      //    (e.g. "Dispatched worker ctx_abc123 for task task_xyz") with no `{` anywhere, so the
      //    bare-`{`-check alone would wrongly treat a real, successful dispatch as "definitely
      //    nothing happened" and drop its reservation while the worker keeps running unmetered
      //    against the parallel-Codex cap — `WG.idsFromOutput` (the same generic ctx_/task_/
      //    term_ token scan the JSON path already relies on) is checked here too so a plain-text
      //    id is never missed.
      //  - errorText is EMPTY (no output was captured at all, e.g. before Orca could reply) —
      //    this is an absence of information, not evidence of anything; the outcome is
      //    genuinely unknown, so the reservation must be kept for the TTL exactly as before.
      const definitelyNoJson = errorText.length > 0 && !errorText.includes('{') && WG.idsFromOutput(errorText).size === 0;
      if (hasDispatch && !definitelyNoJson) {
        // Either the error text carries at least one `{` (scan it for a real id exactly like a
        // success would), or it's empty (registerDispatchReplies will find no ids either way
        // and, with assumeDispatched:false, correctly leave the reservation untouched).
        if (registerDispatchReplies(s, p, cmd, errorText, { assumeDispatched: false })) dirty = true;
      } else if (dropFailedToolState(s, toolUseId)) {
        // Either this command had no dispatch sub-command at all, or its error text
        // affirmatively contains no JSON whatsoever — drop the reservation now rather than
        // waiting out its TTL.
        dirty = true;
      }
    } else if (dropFailedToolState(s, toolUseId)) {
      dirty = true;
    }
    if (dirty) save(s);
  } finally {
    if (locked) releaseLock(lockDir);
  }
}

function onPostToolUse(p, s, cfg) {
  // CRITICAL: every mutation in this function runs against a copy of state reloaded fresh
  // AFTER the lock is held, never the stale snapshot main() loaded before any lock existed
  // — two PostToolUse events firing concurrently (e.g. two Bash tool calls completing at
  // once) would otherwise both mutate their own stale copy and the later save() would
  // silently clobber the earlier one's registration entirely.
  const lockDir = path.join(DIR, '.lock');
  // A release naming an id this session does not track may refer to a worker only tracked
  // as a "pending-*" placeholder. Deciding that safely needs the release target's agent
  // from Orca (see the settle branch below) — fetched OUTSIDE the lock (up to 5s), and only
  // when a cheap unlocked read says the situation could actually apply.
  let releaseRows;
  if (p.tool_name === 'Bash') {
    const preCmd = String((p.tool_input && p.tool_input.command) || '');
    const releaseTargets = orcaInvocations(preCmd)
      .map((inv) => WG.releaseTarget(inv, flagValue)).filter(Boolean);
    if (releaseTargets.length) {
      const snapshot = load(p.session_id);
      const livePendings = Object.entries(snapshot.workers || {})
        .filter(([k, w]) => k.startsWith('pending-') && w.status === 'live');
      if (livePendings.length === 1 && releaseTargets.some((t) => !snapshot.workers[t])) {
        releaseRows = PARALLEL_OWNERSHIP.fetchOrcaWorkerRows(ORCA_BIN);
      }
    }
  }
  const locked = acquireLock(lockDir, {});
  try {
    s = load(p.session_id);
    return onPostToolUseLocked(p, s, cfg, releaseRows);
  } finally {
    if (locked) releaseLock(lockDir);
  }
}

function onPostToolUseLocked(p, s, cfg, releaseRows) {
  const tool = p.tool_name;
  const input = p.tool_input || {};
  const resp = p.tool_response || {};
  let dirty = false;

  // A tool call that errored out never reaches any of the success-path cleanup below (no
  // Orca "ok":false JSON, no registered worker, no launched-then-finished Agent) — without
  // this, its PreToolUse reservation/claim would sit until the 10-minute reservation TTL
  // (or the much longer ownershipClaimTtlMinutes for an agentClaim), silently holding a
  // parallel-Codex opening or an ownership claim for nothing. Defense in depth only: on the
  // real harness a failed call fires the SEPARATE `PostToolUseFailure` event (see
  // onPostToolUseFailure below), not a `PostToolUse` with an error flag on `tool_response` —
  // but if some environment ever does shape it this way, still clean up rather than leak.
  const toolFailed = !!(resp && (resp.is_error === true || resp.error || resp.isError === true));
  if (toolFailed) {
    if (dropFailedToolState(s, p.tool_use_id || p.toolUseId)) dirty = true;
    // Same settle-on-stopped-marker rule as onPostToolUseFailure, for environments that
    // report a failed Bash call through PostToolUse with an error flag instead.
    if (tool === 'Bash' && WG.replyShowsWorkerStopped(`${resp.stdout || ''}\n${resp.stderr || ''}`)) {
      const failedCmd = String(input.command || '');
      for (const inv of orcaInvocations(failedCmd)) {
        const target = WG.releaseTarget(inv, flagValue);
        if (!target || !s.workers[target]) continue;
        if (settleCodeGroup(s, WG.groupOf(s.workers[target], target))) dirty = true;
      }
    }
    // Nothing below this point should be trusted on a failed call: a Bash failure's
    // stdout/stderr is not a real Orca reply and must never be scanned for ids (that would
    // register a phantom "pending" worker for a dispatch that never actually happened).
    if (dirty) save(s);
    return;
  }

  // Foreground Agent/Task dispatches release their Owns: claim as soon as the dispatch
  // itself returns — this event IS that return, since it carries no agent_id/agent_type
  // (a subagent's own tool calls do; see isMainPanel). A BACKGROUND dispatch's own launch
  // also fires this same PostToolUse immediately (the launch returns right away while the
  // work keeps running), so its claim must NOT be released here — only here for a
  // foreground (or a failed, already handled above) dispatch. A background claim is instead
  // released by a matching <task-notification> (best effort, in onUserPromptSubmit),
  // ownershipClaimTtlMinutes, or the operator's --release-claims.
  if (tool === 'Agent' || tool === 'Task') {
    const toolUseId = p.tool_use_id || p.toolUseId;
    const claim = toolUseId && s.agentClaims[toolUseId];
    if (claim && !claim.background) { delete s.agentClaims[toolUseId]; dirty = true; }
    // Same foreground-only rule for the max-parallel-agents registration: a background
    // dispatch's registration survives this event and is released by a matching
    // <task-notification>, its own TTL, or --release-claims instead (see onPreToolUse's
    // registration site, at the end of the Agent/Task routing gates, for the full reasoning).
    const reg = toolUseId && s.agents && s.agents[toolUseId];
    if (reg && !reg.background) { delete s.agents[toolUseId]; dirty = true; }
  }

  if (tool === 'Bash') {
    const cmd = String(input.command || '');
    const out = `${resp.stdout || ''}\n${resp.stderr || ''}`;
    const toolUseId = p.tool_use_id || p.toolUseId || null;

    if (input.run_in_background && toolUseId) {
      pruneBackgroundShells(s);
      const heartbeat = /(?:^|[\s/])orca-heartbeat\.cjs(?:[\s"']|$)/.test(cmd);
      const liveHeartbeat = heartbeat ? heartbeatAlive(s.session_id) : null;
      s.backgroundShells[toolUseId] = {
        command: commandHead(cmd),
        started: Date.now(),
        heartbeat,
        heartbeatPid: Number.isInteger(liveHeartbeat?.pid) ? liveHeartbeat.pid : null,
      };
      dirty = true;
    }

    // Any orca worker/terminal inspection counts as a heartbeat poll.
    if (/\borca\b/.test(cmd) && /(worker-list|worker-read|worker-show|terminal (list|read|show)|worktree ps|task-list|inbox|check)\b/.test(cmd)) {
      s.last_heartbeat = Date.now();
      dirty = true;

      // Resolve any "pending-<ts>" placeholders (a worker-start whose reply carried no
      // id) against this poll's real ids: adopt any id this poll surfaces that is not
      // already tracked, one placeholder per new id; a placeholder nothing resolves it
      // for settles instead of nagging forever, since it can never be reconciled once a
      // poll has already come back empty for it.
      const pendingIds = Object.entries(s.workers).filter(([k, w]) => k.startsWith('pending-') && w.status === 'live').map(([k]) => k);
      if (pendingIds.length) {
        const seenIds = new Set();
        for (const m of out.matchAll(/"(?:dispatchId|taskId|handle)"\s*:\s*"([^"]+)"/g)) seenIds.add(m[1]);
        for (const m of out.matchAll(/\b((?:ctx|task|term)_[A-Za-z0-9_-]+)\b/g)) seenIds.add(m[1]);
        const newIds = [...seenIds].filter((id) => !s.workers[id]);
        for (const pendingId of pendingIds) {
          const real = newIds.shift();
          if (real) {
            s.workers[real] = { ...s.workers[pendingId], role: `${s.workers[pendingId].agent || 'worker'}-exec`, unverified: false };
            delete s.workers[pendingId];
          } else {
            s.workers[pendingId].status = 'settled';
            recordCodeAuthor(s, poolCoderForAgent(s.workers[pendingId].agent), s.workers[pendingId].started);
          }
        }
      }
    }

    // Every real dispatch-shaped invocation in this command, in shell-execution order —
    // task-create, worker-start and terminal-create share one correlation pass so a
    // command chaining several of them (`task-create ... && worker-start --task "$ID"`,
    // or two worker-starts back to back) never has invocation N's reply attributed to
    // invocation M. `--help` is judged per invocation, never the whole command line.
    // Shared with the `PostToolUseFailure` path (see registerDispatchReplies above) so a
    // dispatch that actually succeeded despite the overall Bash call failing is still
    // recognised the same way there.
    if (registerDispatchReplies(s, p, cmd, out, { assumeDispatched: true })) dirty = true;

    // A successful worker-release/worker-abandon reply is authoritative even when Orca's
    // worker-list row remains `retained` (including `no_owned_resource`). Conversely, a
    // structured `ok:false` reply must not settle anything just because Bash itself exited
    // zero. A non-JSON success preserves the historical exit-zero behavior.
    const releaseReplyOutcome = WG.releaseReplyOutcome(out);

    // `terminal create`'s own max-parallel-agents reservation (see
    // handleTerminalCreateAgentCap) is a lightweight, separately-keyed placeholder that
    // only needs to survive the PreToolUse -> PostToolUse gap: by the time this event
    // fires, `registerDispatchReplies` above has already turned a successful create into a
    // real `s.workers` entry (terminal-create is in DISPATCH_SUBS), so the reservation's
    // job is done either way — clear it unconditionally rather than re-deriving success/
    // failure a second time.
    const toolUseIdForTerm = p.tool_use_id || p.toolUseId;
    if (toolUseIdForTerm) {
      for (const key of Object.keys(s.reservations)) {
        if (key.startsWith(`term:${toolUseIdForTerm}#`)) { delete s.reservations[key]; dirty = true; }
      }
    }

    // Stopping, releasing or closing a worker settles its whole group. Section 0 fix #2:
    // the target id comes from the SPECIFIC orca invocation's own parsed args
    // (`WG.releaseTarget`), never from "whatever the command line's last shell token
    // happened to be" — the old regex took `--json` as the target of
    // `worker-release --dispatch <id> --json`, matched nothing, and fell back to settling
    // every live worker in the session. An unrecognised label now settles nothing and
    // prints a hint instead of guessing.
    for (const inv of orcaInvocations(cmd)) {
      const target = WG.releaseTarget(inv, flagValue);
      if (!target) continue;
      if (releaseReplyOutcome === false) continue;
      if (s.workers[target]) {
        if (settleCodeGroup(s, WG.groupOf(s.workers[target], target))) dirty = true;
      } else {
        // The id may belong to a worker this session only tracks as a "pending-*"
        // placeholder (its start reply never yielded the real id). Settle it only when the
        // identification is sound (plan item 3's agent match): exactly one live placeholder
        // at least a few seconds old, and — when Orca lists the release target — of the
        // SAME agent (projection.provider.id). Without an Orca row for the target there is
        // nothing to check against, so uniqueness + age is the guard; more than one live
        // placeholder, a too-fresh one, or an agent mismatch settles nothing.
        const livePendings = Object.entries(s.workers)
          .filter(([k, w]) => k.startsWith('pending-') && w.status === 'live');
        let settledPending = null;
        if (livePendings.length === 1) {
          const [pendingKey, pendingWorker] = livePendings[0];
          let started = Number.isFinite(pendingWorker.started) ? pendingWorker.started : NaN;
          if (!Number.isFinite(started)) {
            const m = /^pending-(\d+)(?:-\d+)?$/.exec(pendingKey);
            started = m ? Number(m[1]) : NaN;
          }
          const oldEnough = Number.isFinite(started) && Date.now() - started >= 5000;
          let agentMatch = true;
          if (releaseRows) {
            const row = releaseRows.rows.find((r) =>
              [r.dispatchId, r.taskId, r.agentTerminalHandle].includes(target));
            const rowAgent = row && row.projection && row.projection.provider && row.projection.provider.id;
            if (rowAgent && pendingWorker.agent &&
                String(rowAgent).toLowerCase() !== String(pendingWorker.agent).toLowerCase()) {
              agentMatch = false;
            }
          }
          if (oldEnough && agentMatch) settledPending = pendingKey;
        }
        if (settledPending) {
          s.workers[settledPending].status = 'settled';
          recordCodeAuthor(s, poolCoderForAgent(s.workers[settledPending].agent), s.workers[settledPending].started);
          dirty = true;
          process.stdout.write(
            `orchestrator-gate: ${inv.sub} named untracked "${target}"; settled the one live placeholder ` +
            `${settledPending} it could only have referred to.\n`);
        } else {
          process.stdout.write(
            `orchestrator-gate: ${inv.sub} named "${target}", which this session is not tracking as a live worker; ` +
            'nothing was settled. Check `orca orchestration worker-list`.\n');
        }
      }
    }

    // `worker-retain` is an explicit operator decision to keep a failed/completed
    // dispatch's terminal alive and continue through it. Mark the whole tracked group so
    // Stop can distinguish that supervised terminal from an accidental resource leak.
    for (const inv of orcaInvocations(cmd)) {
      const target = WG.retainTarget(inv, flagValue);
      if (!target) continue;
      const retained = s.workers[target];
      if (!retained) {
        process.stdout.write(
          `orchestrator-gate: ${inv.sub} named "${target}", which this session is not tracking; ` +
          'nothing was marked retained. Check `orca orchestration worker-list`.\n');
        continue;
      }
      const group = WG.groupOf(retained, target);
      for (const [key, worker] of Object.entries(s.workers)) {
        if (worker.status === 'live' && WG.groupOf(worker, key) === group) {
          worker.retained = true;
          // When the (latest) retain ran, so the heartbeat can tell "retained for reuse
          // AFTER the worker finished" (blocks auto-close) apart from the Kimi readiness
          // recipe, which retains mid-run, before any done state (does not). Always
          // re-stamped: a second retain AFTER completion must move the timestamp past the
          // done transition even when an earlier mid-run retain already set it.
          worker.retainedAt = Date.now();
          if (!worker.readinessTimeout) worker.capExempt = true;
          dirty = true;
        }
      }
      // A retained code worker is finished-and-kept: its review model follows its author.
      if (recordCodeAuthor(s, codeAuthorOfGroup(s.workers, group), Date.now())) dirty = true;
    }

    // Rate limiting: record it and set a backoff deadline instead of re-dispatching now.
    // Only worker/terminal output counts; the panel's own quota inspection ("rate_limits" JSON) does not.
    const readsWorkerOutput = /\borca\b/.test(cmd) && /(worker-read|terminal (read|show))\b/.test(cmd);
    const readEntries = orcaInvocations(cmd)
      .map((inv) => ({ inv, target: WG.outputTarget(inv, flagValue) }))
      .filter(({ target }) => Boolean(target));
    const readTargets = readEntries.map(({ target }) => target);
    const readOutputDirect = readEntries.every(({ inv }) =>
      !inv.stdoutPiped && !inv.stdoutRedirected && !inv.stdoutCaptured);
    const parsedReadReplies = WG.splitJsonReplies(out);
    const readJsonStartsOutput = /^[\s\r\n]*\{/.test(String(out || ''));
    const parsedOutputIsAttributable = readOutputDirect && parsedReadReplies.length === readTargets.length &&
      (shellSegments(cmd).length === readTargets.length || readJsonStartsOutput);
    const scopedReadOutput = parsedOutputIsAttributable
      ? parsedReadReplies.map((reply) => workerOutputSignalText(JSON.stringify(reply))).join('\n')
      : (readOutputDirect && readTargets.length === 1 && shellSegments(cmd).length === 1
          ? workerOutputSignalText(out)
          : '');
    const signalText = scopedReadOutput.replace(/"rate_limits"/g, '');
    const trackedReadWorkers = readTargets.map((target) => [target, s.workers[target]]).filter(([, worker]) => worker);
    const kimiGroups = new Set(trackedReadWorkers
      .filter(([, worker]) => worker.agent === 'kimi')
      .map(([target, worker]) => WG.groupOf(worker, target)));
    const targetsKimiOnly = trackedReadWorkers.length > 0 &&
      trackedReadWorkers.length === readTargets.length && trackedReadWorkers.every(([, worker]) => worker.agent === 'kimi');
    if (readsWorkerOutput && targetsKimiOnly && hasKimiUsageExhausted(signalText)) {
      const markNow = Date.now();
      const windowHours = kimiUsageLimitHours(signalText);
      CODER_AVAILABILITY.markCoderExhausted(DIR, 'kimi', {
        now: markNow,
        ...(windowHours ? {
          until: EXEC_QUOTA.kimiWindowResetMs(DIR, windowHours * 60, markNow) || markNow + windowHours * 3600 * 1000,
        } : {}),
        reason: windowHours ? `${windowHours}-hour usage limit reached` : 'usage limit reached for this billing cycle',
      });
      const until = Date.now() + RATE_LIMIT_BACKOFF_SECONDS * 1000;
      for (const [key, worker] of Object.entries(s.workers)) {
        if (worker.status === 'live' && worker.agent === 'kimi' && kimiGroups.has(WG.groupOf(worker, key))) {
          worker.rate_limited_until = until;
        }
      }
      dirty = true;
      process.stdout.write(
        'orchestrator-gate: Kimi usage limit detected for the tracked Kimi worker. Route new code to Codex, ' +
        'or Sonnet if Codex is also unavailable; do not retry Kimi until reset.\n'
      );
    }
    const opencodeGroups = new Set(trackedReadWorkers
      .filter(([, worker]) => worker.agent === 'opencode')
      .map(([target, worker]) => WG.groupOf(worker, target)));
    const targetsOpencodeOnly = trackedReadWorkers.length > 0 &&
      trackedReadWorkers.length === readTargets.length &&
      trackedReadWorkers.every(([, worker]) => worker.agent === 'opencode');
    if (readsWorkerOutput && targetsOpencodeOnly && hasDeepseekBalanceExhausted(signalText)) {
      CODER_AVAILABILITY.markCoderExhausted(DIR, 'deepseek', {
        now: Date.now(),
        reason: 'insufficient balance (402)',
      });
      const until = Date.now() + RATE_LIMIT_BACKOFF_SECONDS * 1000;
      for (const [key, worker] of Object.entries(s.workers)) {
        if (worker.status === 'live' && worker.agent === 'opencode' && opencodeGroups.has(WG.groupOf(worker, key))) {
          worker.rate_limited_until = until;
        }
      }
      dirty = true;
      process.stdout.write(
        'orchestrator-gate: DeepSeek balance exhausted (402 Insufficient Balance) for the tracked opencode worker. ' +
        'Route new code to another usable coder, or Sonnet if none is eligible; do not retry DeepSeek until the balance is topped up.\n'
      );
    }
    if (readsWorkerOutput && hasRateLimitError(signalText)) {
      s.rate_limit_hits += 1;
      const until = Date.now() + RATE_LIMIT_BACKOFF_SECONDS * 1000;
      for (const w of Object.values(s.workers)) if (w.status === 'live') w.rate_limited_until = until;
      dirty = true;
      process.stdout.write(
        'orchestrator-gate: external coder rate limit detected. Do NOT re-dispatch immediately — that deepens the limit.\n' +
        `Back off ~${RATE_LIMIT_BACKOFF_SECONDS}s, reduce the number of parallel coder workers, then retry the same worker ` +
        'with `orca orchestration worker-read` before starting anything new.\n'
      );
    }

    // An orca command that cannot reach the runtime justifies the in-session fallback.
    if (/\borca\b/.test(cmd) && ORCA_FAILURE.test(out)) {
      try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(ORCA_DOWN_FLAG, new Date().toISOString()); } catch {}
      process.stdout.write('orchestrator-gate: Orca unreachable — in-session execution fallback is now permitted.\n');
    }
  }

  // Remind the panel to poll when it has been quiet with workers live.
  const live = liveWorkers(s);
  if (!s.bypass && live.length) {
    // Age the heartbeat from the oldest live worker when nothing has been polled yet,
    // so a never-polled session reports a real waiting time instead of epoch seconds.
    const baseline = s.last_heartbeat || Math.min(...live.map(([, w]) => w.started || Date.now()));
    const ageSeconds = Math.round((Date.now() - baseline) / 1000);
    if (ageSeconds > cfg.heartbeat.idleSeconds) {
      const how = s.last_heartbeat ? `unpolled for ${ageSeconds}s` : `never polled (${ageSeconds}s since dispatch)`;
      process.stdout.write(
        `orchestrator-gate: ${live.length} worker(s) live and ${how}. Run \`orca orchestration worker-list\` now.\n`
      );
    }
  }

  if (dirty) save(s);
}

/**
 * Ask Orca which of this session's workers are still holding resources.
 * Returns null when Orca cannot answer, so the caller can fall back to the
 * session's own record rather than either blocking blindly or waving it through.
 */
function unsettledPerOrca(ids, fetched = PARALLEL_OWNERSHIP.fetchOrcaWorkerRows(ORCA_BIN)) {
  if (!ids.length) return [];
  if (fetched === null) return null;
  const wanted = new Set(ids);
  // Only this session's dispatches matter. The machine carries a long backlog
  // of retained terminals from earlier sessions; blocking on those would make
  // every future session unstoppable.
  return fetched.rows
    .filter((w) => wanted.has(w.dispatchId) || wanted.has(w.taskId))
    .filter((w) => !PARALLEL_OWNERSHIP.rowReportsReconciled(
      w, fetched.rows, fetched.terminalHandles))
    .map((w) => `${w.dispatchId} [${w.workerState}/${w.terminalState}]`);
}

function onStop(p, s, cfg) {
  if (s.bypass || p.stop_hook_active) return;

  // Backstop: sweep every unresolved Bash reservation and FOREGROUND (`background: false`)
  // `s.agents` registration at every Stop, regardless of whether any Orca worker is live.
  // A later hook may have denied an admitted tool call before it ran, so no PostToolUse
  // event exists to release that reservation. Reload fresh under the lock, since `s` is
  // main()'s pre-lock snapshot.
  {
    const lockDir = path.join(DIR, '.lock');
    const locked = acquireLock(lockDir, {});
    try {
      const fresh = load(p.session_id);
      let purgedAny = false;
      if (Object.keys(fresh.reservations || {}).length) {
        fresh.reservations = {};
        purgedAny = true;
      }
      for (const [id, a] of Object.entries(fresh.agents || {})) {
        if (a && a.background === false) { delete fresh.agents[id]; purgedAny = true; }
      }
      // A "pending-*" placeholder past its TTL no longer counts toward caps or ownership
      // (worker-groups.cjs) and must not keep the panel from stopping either.
      for (const [key, w] of Object.entries(fresh.workers || {})) {
        if (w.status === 'live' && WG.pendingPlaceholderExpired(key, w)) {
          w.status = 'settled';
          recordCodeAuthor(fresh, poolCoderForAgent(w.agent), w.started);
          purgedAny = true;
        }
      }
      if (purgedAny) { save(fresh); s = fresh; }
    } finally {
      if (locked) releaseLock(lockDir);
    }
  }

  let live = liveWorkers(s);
  if (!live.length) return;
  const d = (gate, reason) => { if (!gateDisabled(cfg, gate)) { logViolation(s, gate, reason); process.stderr.write(reason); process.exit(2); } };

  // Fetch outside the state lock, then reconcile against a freshly reloaded snapshot.
  // Besides released terminals, this settles terminal rows that explicitly own no
  // resource, whose terminal has closed, or whose handle belongs to a newer dispatch.
  // Running rows never satisfy the shared predicate and remain supervised below.
  const fetched = PARALLEL_OWNERSHIP.fetchOrcaWorkerRows(ORCA_BIN);
  if (fetched !== null) {
    const lockDir = path.join(DIR, '.lock');
    const locked = acquireLock(lockDir, {});
    try {
      s = load(p.session_id);
      const changed = PARALLEL_OWNERSHIP.applyOrcaReconciliation(
        s, fetched.rows, fetched.exhaustive, fetched.terminalHandles);
      if (changed) save(s);
    } finally {
      if (locked) releaseLock(lockDir);
    }
    live = liveWorkers(s);
    if (!live.length) return;
  }

  // "pending-<ts>" placeholders (a worker-start whose reply carried no dispatch id, see
  // onPostToolUse) are never in Orca's own worker-list by construction - Orca was never
  // given an id to answer about. They must never be auto-settled by an empty `confirmed`
  // result the way a real, Orca-confirmed-released id would be; they stay in the
  // "must be watched" path until a poll resolves them (adopts a real id, or settles them
  // once a poll comes back with nothing new to match).
  const pending = live.filter(([k]) => k.startsWith('pending-'));
  const trackable = live.filter(([k]) => !k.startsWith('pending-'));

  const ids = trackable.map(([k]) => k);
  const confirmed = trackable.length ? unsettledPerOrca(ids, fetched) : [];

  // Workers still running are a legitimate wait - but only while the heartbeat daemon
  // watches them, so the panel is woken on the first event instead of going AFK.
  // Finished workers still holding a terminal must be released first, heartbeat or not.
  const DONE = /\[(succeeded|failed|completed|stopped|cancelled|canceled)\//;
  const explicitlyRetained = (confirmation) => {
    const id = String(confirmation).split(' ')[0];
    return /\/retained\]$/.test(confirmation) && !!s.workers[id]?.retained;
  };
  const finished = confirmed ? confirmed.filter((c) => DONE.test(c) && !explicitlyRetained(c)) : [];
  const runningList = confirmed
    ? (confirmed.length ? confirmed : ids)
      .filter((c) => !DONE.test(c)).map((c) => explicitlyRetained(c) ? `${c} (retained)` : c)
    : ids;
  const stillRunning = runningList.length;
  if (stillRunning > 0 || pending.length) {
    if (heartbeatAlive(s.session_id)) return;
    const pendingList = pending.map(([k]) => `${k} (no dispatch id yet - run \`orca orchestration worker-list\` to resolve)`);
    const allShown = [...runningList, ...pendingList];
    d('workers-unwatched',
      `[orchestrator-gate:workers-unwatched] ${allShown.length} worker(s) still running: ${allShown.join(', ')}.\n` +
      'You may wait for them, but not unwatched. Start the heartbeat first, then end the turn:\n' +
      `  ${heartbeatStartCommand()}\n`);
    return;
  }

  // Explicitly retained workers that Orca reports done are informational: their terminal
  // may stay open for reuse, but no live execution remains for the heartbeat to supervise.
  if (!finished.length) return;

  const shown = confirmed ? finished : ids;
  const source = confirmed ? 'confirmed by orca worker-list' : 'per this session\'s record; orca did not answer';
  d('workers-unreconciled',
    `[orchestrator-gate:workers-unreconciled] ${shown.length} worker(s) still holding resources ` +
    `(${source}): ${shown.join(', ')}.\n` +
    'Before finishing: read each one, then either keep it (`orca orchestration worker-retain`) if it will be ' +
    'reused, or free the machine (`worker-release`, or `orca terminal close`).\n' +
    'Leaving workers live is how ghost processes accumulate.\n');
}

// --- entry ------------------------------------------------------------------

function main(p) {
  const cfg = loadConfig();
  if (!activationApplies(cfg)) return;
  repairInvalidPersistedExecAgent(p.session_id, p.hook_event_name);
  const s = load(p.session_id);
  switch (p.hook_event_name) {
    case 'SessionStart': return onSessionStart(p, s, cfg);
    case 'UserPromptSubmit': return onUserPromptSubmit(p, s, cfg);
    case 'PreToolUse': return onPreToolUse(p, s, cfg);
    case 'PostToolUse': return onPostToolUse(p, s, cfg);
    case 'PostToolUseFailure': return onPostToolUseFailure(p, s, cfg);
    case 'Stop': return onStop(p, s, cfg);
    default: return;
  }
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  if (process.env.ORCHESTRATOR_GATE === 'off') process.exit(0);
  let p;
  try { p = JSON.parse(raw || '{}'); } catch { process.exit(0); }
  try {
    main(p);
    flushHookContext(p.hook_event_name);
  } catch (err) {
    process.stderr.write(`[orchestrator-gate] internal error, allowing: ${err.message}\n`);
    process.exit(0);
  }
  process.exit(0);
});

module.exports = {
  shellSyntaxOnly, redirectTargets, isExemptPath, movesOnlyExemptPaths, shellSegments,
  parseCodeModel, describeOverride, currentExecRoute, escapeRegex, activationApplies,
  hasFlag, flagValue, resolveWorkerStartAgent, liveCodexGroupIds,
  isPlanningReview, hasReviewEscalationReason, hasVerifyEscalationReason, classifyDispatch,
  commandHead, formatAge, formatBackgroundShellReminder, pruneBackgroundShells,
};
