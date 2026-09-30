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
 *   3. Execution and token-heavy work goes to Codex in Orca workers, or the configured
 *      in-session code model once Codex has used the handoff percentage of its quota,
 *      or whichever model the operator explicitly picked with --code-model.
 *   4. Everything is delegated, parallel wherever ownership allows.
 *   5. Parallel Codex workers hit rate limits; the heartbeat must detect that and retry
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
  maxParallelCodexWorkers, ownershipClaimTtlMinutes, parallelCoreFraction, maxParallelAgents,
} = require('./lib/config.cjs');
const WG = require('./lib/worker-groups.cjs');
const PAC = require('./lib/parallel-agent-cap.cjs');
const HBL = require('./lib/heartbeat-liveness.cjs');
const OWN = require('./lib/ownership.cjs');
const OC = require('./lib/ownership-claims.cjs');
const { acquireLock, releaseLock } = require('./lib/file-lock.cjs');
const { hasRateLimitError } = require('./lib/terminal-signals.cjs');

const DIR = stateDir();
const LOG = path.join(DIR, 'violations.log');
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

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `model "opus" (claude-opus-5-5)` when an exact id is configured, else just the alias. */
function modelLabel(role) {
  return role && role.id ? `"${role.alias}" (${role.id})` : `"${role && role.alias}"`;
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
const PLAN_REVIEW_INTENT = /\b(plan|planning|design|review|reviewer|verify|verification|audit|red.?team|critique|assess|architect)\b/i;
const EXEC_INTENT = /(?<!\w)(?<!\b(?:review|plan|design|audit|verify|red.?team)-)(implement|implementation|build|refactor|migrate|scaffold|execute|fix\s|write\s+(the\s+)?code|codegen|generate\s+(code|assets|components))\b/i;
const PLAN_REVIEW_FIRST_VERB = /^(plan|design|review|verify|audit|red.?team|critique|assess|architect)\b/i;
const EXEC_FIRST_VERB = /^(implement|build|refactor|migrate|scaffold|execute|fix|codegen|generate\s+(code|assets|components))\b/i;
const NEUTRAL_FIRST_VERB = /^(commit|push|merge|publish|rebase|tag|release|deploy|update|write)\b/i;
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
    execAgent: null,        // null (auto by quota) | 'code' | 'codex' | 'codex:<model>' | 'claude:<alias>'
    execAgentSince: null,
    workers: {},            // label -> { role, started, status, last_seen, rate_limited_until,
                             //            group, kind, agent, owns, ws }
    reservations: {},       // "<toolUseId>#<idx>" -> { ts, agent, owns, ws, codexSlot, newSlot, commandHash } —
                             // the gap between a Bash dispatch being admitted and its PostToolUse resolving it
    agentClaims: {},        // toolUseId -> { owns, ws, ts } — in-session Agent/Task Owns: claims
    agents: {},             // toolUseId -> { ts, background, type, model } — EVERY main-panel
                             // Agent/Task dispatch (not only code briefs), for the machine-wide
                             // max-parallel-agents budget; see lib/parallel-agent-cap.cjs
    tasks: {},              // taskId -> { owns, ws } — recorded when `task-create` resolves its id
    last_heartbeat: 0,      // epoch ms of the last worker-status poll
    rate_limit_hits: 0,
  };
}

function load(sid) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(sid), 'utf8'));
    // Back-fill fields a state file written before this gate's ownership/parallel-limit
    // work existed would not have, so an in-progress session never crashes on upgrade.
    if (!s.reservations) s.reservations = {};
    if (!s.agentClaims) s.agentClaims = {};
    if (!s.agents) s.agents = {};
    if (!s.tasks) s.tasks = {};
    return s;
  } catch {
    return blank(sid);
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
  if (x === String(cfg.models.code.alias || '').toLowerCase()) return 'code';
  if (x === String(cfg.models.review.alias || '').toLowerCase()) return `claude:${cfg.models.review.alias}`;
  if (x === String(cfg.models.escalation.alias || '').toLowerCase()) return `claude:${cfg.models.escalation.alias}`;
  if (x === String(cfg.models.lookup.alias || '').toLowerCase()) return `claude:${cfg.models.lookup.alias}`;
  if (x === 'codex') return 'codex';
  if (x.startsWith('codex:') && x.length > 6) return `codex:${x.slice(6)}`;
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
  if (o === 'code') return `in-session Agent with model "${cfg.models.code.alias}"`;
  return `in-session Agent with model "${o.slice(7)}"`;
}

/**
 * Who writes code for this session. An operator override wins:
 *   s.execAgent = 'code' | 'codex' | 'codex:<model>' | 'claude:<alias>'
 * (set by --code-model <value>, or the --exec-sonnet / --exec-codex shortcuts);
 * otherwise automatic: Codex first, the configured code model once Codex has used the
 * handoff percentage. Returns { route: 'code' | 'codex' | 'claude', alias?, codexModel?, why }.
 */
function currentExecRoute(cfg, s) {
  const a = s.execAgent;
  if (a === 'code') return { route: 'code', alias: cfg.models.code.alias, why: `operator override (${cfg.models.code.alias})` };
  if (a === 'codex') return { route: 'codex', why: 'operator override (codex)' };
  if (typeof a === 'string' && a.startsWith('codex:')) {
    return { route: 'codex', codexModel: a.slice(6), why: `operator override (codex ${a.slice(6)})` };
  }
  if (typeof a === 'string' && a.startsWith('claude:')) {
    return { route: 'claude', alias: a.slice(7), why: `operator override (${a.slice(7)})` };
  }
  try {
    const r = require('./lib/exec-route-by-quota.cjs').execRoute(handoffUsed(cfg));
    if (r.route === 'sonnet') return { route: 'code', alias: cfg.models.code.alias, why: `auto: ${r.summary}` };
    // execFallbackWhenCodexUnavailable fires only when Codex genuinely cannot be
    // dispatched to at all - `orca` or `codex` itself missing from PATH - never merely
    // because its quota reading is unknown (e.g. a fresh Codex install that has not run a
    // first turn yet). Codex is the deliberately-preferred default: an unknown quota is
    // not evidence Codex is unusable, only a missing binary is. (A quota that IS known and
    // simply under the handoff threshold already returned 'codex' above via r.route.)
    if (cfg.execFallbackWhenCodexUnavailable === 'sonnet' && (!orcaOnPath() || !codexOnPath())) {
      const missing = [!orcaOnPath() && 'orca', !codexOnPath() && 'codex'].filter(Boolean).join('/');
      return {
        route: 'code', alias: cfg.models.code.alias,
        why: `auto: ${r.summary}; ${missing} not on PATH, falling back to "${cfg.models.code.alias}" per execFallbackWhenCodexUnavailable`,
      };
    }
    return { route: 'codex', why: `auto: ${r.summary}` };
  } catch {
    return { route: 'codex', why: 'auto: quota unreadable, default Codex' };
  }
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
          const rows = PARALLEL_OWNERSHIP.fetchOrcaWorkerRows(ORCA_BIN);
          locked = acquireLock(lockDir, CAP_LOCK_OPTS);
          if (locked === null) return;
          if (locked === false) { violation = PAC.LOCK_CONTENTION_MESSAGE; break; }
          fresh = load(s.session_id);
          Object.assign(fresh.reservations, localReservations);
          if (rows !== null) PARALLEL_OWNERSHIP.applyOrcaReconciliation(fresh, rows);
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
      hasFlag, flagValue, briefText, EXEC_INTENT, DIR, ORCA_BIN, maxParallelCodexWorkers, ownershipClaimTtlMinutes, save, load, gateDisabled,
      agentParallelLimit, maxParallelAgents, machineWideLiveUnits: PAC.machineWideLiveUnits,
      formatParallelAgentsRefusal: PAC.formatParallelAgentsRefusal, cores: PAC.cores, parallelCoreFraction,
      lockContentionMessage: PAC.LOCK_CONTENTION_MESSAGE, capLockOpts: CAP_LOCK_OPTS,
    },
  });
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
    if (s.execAgent === 'code') {
      target = cfg.models.code.alias[0].toUpperCase() + cfg.models.code.alias.slice(1);
      flag = '--exec-sonnet';
    } else if (s.execAgent === 'codex') {
      target = 'Codex';
      flag = '--exec-codex';
    } else if (s.execAgent.startsWith('codex:')) {
      target = `Codex (${s.execAgent.slice(6)})`;
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
  if (!fs.existsSync(stateFile(s.session_id))) save(s);
  const review = cfg.models.review.alias;
  const escalation = cfg.models.escalation.alias;
  const lookup = cfg.models.lookup.alias;
  const code = cfg.models.code.alias;
  const threshold = handoffUsed(cfg);
  const warnings = (cfg.warnings || []).map((w) => `- CONFIG WARNING: ${w}\n`).join('');
  const overrideWarnings = activeOverrideLines(cfg, s).map((line) => `- ACTIVE OVERRIDE: ${line}\n`).join('');
  process.stdout.write(
    'ORCHESTRATION CONTRACT (enforced by orchestrator-gate.cjs):\n' +
    warnings +
    overrideWarnings +
    languageSentence(cfg, true) +
    '- The main panel may read and dispatch only. It may not Edit/Write outside .claude/, plans/, docs/, scratch,\n' +
    '  and may not run mutating shell commands. Delegate those to a worker.\n' +
    `- Model routing: ${modelLabel(cfg.models.review)} plans + red-teams -> Codex (${code} once Codex >= ${threshold}% used) codes -> ${review} reviews.\n` +
    `- Planning / red-team / review / verification -> in-session subagent on model ${modelLabel(cfg.models.review)}.\n` +
    `  Model ${modelLabel(cfg.models.escalation)} only after "${review}" failed even at high effort; say both in the dispatch.\n` +
    `- Light lookups (find/locate code, read logs or test output, explore) -> model ${modelLabel(cfg.models.lookup)}.\n` +
    '- Every code brief (Codex spec or in-session prompt) names the exact test / build command to run green.\n' +
    `- Code: Codex first; "${code}" once Codex has used >= ${threshold}% of its live-read quota ` +
    '(configure codexHandoffUsedPercent / ORCH_CODEX_HANDOFF_USED):\n' +
    '    Codex  -> Orca worker: orca orchestration task-create ... && worker-start ...\n' +
    '             then worker-list | worker-read | worker-release\n' +
    `    ${code[0].toUpperCase()}${code.slice(1)} -> in-session Agent with model "${code}".\n` +
    `  Operator-only override from the main panel: --code-model <${review}|${code}|${lookup}|${escalation}|codex|codex:<model>|auto>\n` +
    '  (session-scoped, last flag wins; --exec-sonnet / --exec-codex are shortcuts, --exec-auto = --code-model auto).\n' +
    '  If Orca itself is unreachable: `touch ~/.claude/orchestrator-gate/orca-unavailable` (15 min) permits in-session code\n' +
    `  (even a codex override falls back to "${code}" while that flag is active).\n` +
    `- Poll every live worker at least every ${cfg.heartbeat.idleSeconds}s. Never let one sit IDLE unattended.\n` +
    '- Codex workers get rate limited when run in parallel: on a rate-limit signal, back off and retry\n' +
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
const NON_OPERATOR_TURN = /<task-notification>|<cross-session-message|\[SYSTEM NOTIFICATION|<system-reminder>/i;
// A flag counts only as a standalone token, not inside backticks or a longer word.
const operatorFlag = (prompt, flag) => new RegExp(`(^|\\s)${flag}(?=\\s|$)`, 'i').test(prompt);

function onUserPromptSubmit(p, s, cfg) {
  // CRITICAL: reload fresh under the lock, same reasoning as onPostToolUse — this handler
  // both reads and mutates (bypass, code-model override, --release-claims, task-notification
  // release) and must never operate on a stale pre-lock snapshot.
  const lockDir = path.join(DIR, '.lock');
  const locked = acquireLock(lockDir, {});
  try {
    s = load(p.session_id);
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
    }
    if (releasedAny) save(s);
  }

  // Backstop: sweep leaked FOREGROUND (`background: false`) `s.agents` registrations on
  // every genuine operator turn. Bash reservations are deliberately NOT swept here: a Bash
  // tool call can still be in flight when another operator prompt is submitted, and its
  // eventual PostToolUse needs the reservation to transfer Owns/cap metadata to the worker.
  // Stop remains the safe backstop for unresolved Bash reservations.
  if (!NON_OPERATOR_TURN.test(raw)) {
    let purgedAny = false;
    for (const [id, a] of Object.entries(s.agents || {})) {
      if (a && a.background === false) { delete s.agents[id]; purgedAny = true; }
    }
    if (purgedAny) save(s);
  }

  const prompt = NON_OPERATOR_TURN.test(raw) ? '' : raw;
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
  // --exec-codex are shortcuts for the configured code model / Codex. Whichever of these
  // appears last in the prompt wins.
  const flagAt = (f) => (operatorFlag(prompt, f) ? promptLower.lastIndexOf(f) : -1);
  const cm = [...prompt.matchAll(/(^|\s)--code-model(?:=|\s+)(\S+)/gi)].pop();
  const bareCm = !cm && /(^|\s)--code-model(?:=)?\s*$/i.test(prompt);
  if (bareCm) {
    process.stdout.write(`orchestrator-gate: --code-model needs a value (${cfg.models.review.alias} | ${cfg.models.code.alias} | ${cfg.models.lookup.alias} | ${cfg.models.escalation.alias} | codex | codex:<model> | auto); nothing changed.\n`);
  }
  const cmAt = cm ? cm.index + cm[1].length : -1;
  const lastFlag = ['--exec-sonnet', '--exec-codex', '--exec-auto']
    .map((f) => [f, flagAt(f)]).concat(cm ? [['--code-model', cmAt]] : [])
    .filter(([, i]) => i >= 0).sort((a, b) => b[1] - a[1]).map(([f]) => f)[0];
  let override;
  if (lastFlag === '--exec-sonnet') override = 'code';
  else if (lastFlag === '--exec-codex') override = 'codex';
  else if (lastFlag === '--exec-auto') override = null;
  else if (lastFlag === '--code-model') override = parseCodeModel(cfg, cm[2]);
  if (override !== undefined && override !== 'invalid') {
    s.execAgent = override;
    s.execAgentSince = override === null ? null : new Date().toISOString();
    save(s);
    process.stdout.write(override === null
      ? `orchestrator-gate: coding model back to automatic (Codex first, "${cfg.models.code.alias}" past the Codex handoff %).\n`
      : `orchestrator-gate: coding model set by the operator for this session: ${describeOverride(cfg, override)}. Revert with --code-model auto.\n`);
  } else if (override === 'invalid') {
    process.stdout.write(`orchestrator-gate: ignored --code-model ${cm[2]} (use ${cfg.models.review.alias} | ${cfg.models.code.alias} | ${cfg.models.lookup.alias} | ${cfg.models.escalation.alias} | codex | codex:<model> | auto).\n`);
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
  const roleByAlias = (alias) => Object.values(cfg.models).find((m) => m.alias === alias) || { alias, id: null };
  const codeRoute = ex.route === 'codex'
    ? `Codex in an Orca worker${codexModelShown ? ` (worker-start --agent codex --model ${codexModelShown})` : ''}`
    : `in-session subagent (Agent model ${modelLabel(ex.route === 'claude' ? roleByAlias(ex.alias) : cfg.models.code)})`;
  parts.push(`Model routing: plan/red-team/review -> model ${modelLabel(cfg.models.review)}; code -> ${codeRoute} [${ex.why}].`);
  parts.push(`${parallelBudgetLine(cfg, s)}.`);
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
  const rows = PARALLEL_OWNERSHIP.fetchOrcaWorkerRows(ORCA_BIN);
  const reacquired = acquireLock(lockDir, CAP_LOCK_OPTS);
  if (reacquired === null) return { state, violation: null, locked: null };
  if (reacquired === false) return { state, violation: PAC.LOCK_CONTENTION_MESSAGE, locked: false };
  const fresh = load(sessionId);
  if (rows !== null) PARALLEL_OWNERSHIP.applyOrcaReconciliation(fresh, rows);
  return { state: fresh, violation: checkParallelAgentCapacity(fresh, cfg), locked: true };
}

function onPreToolUse(p, s, cfg) {
  if (s.bypass) return;
  if (!isMainPanel(p)) return; // subagents do the real work; never gate them (Orca workers: see deny())
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
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
        additionalContext: `orchestrator-gate advice: pin the Codex model explicitly - add --model ${cfg.models.codex.id} ` +
          'to this worker-start so the fleet cannot silently drift onto a different default.' } }));
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
    // "plan the refactor" is planning, "implement the plan" is execution. Whichever
    // intent word appears first in the task's own summary wins.
    const description = String(input.description || '').trim();
    const type = String(input.subagent_type || '');
    const hay = `${type} ${description}`.trim() || String(input.prompt || '').slice(0, 400);
    const firstIntent = PLAN_REVIEW_FIRST_VERB.test(description) ? 'review'
      : EXEC_FIRST_VERB.test(description) ? 'exec'
        : NEUTRAL_FIRST_VERB.test(description) ? 'neutral'
          : null;
    const planAt = hay.search(PLAN_REVIEW_INTENT);
    const execAt = hay.search(EXEC_INTENT);
    const wantsExec = firstIntent === 'exec' ||
      (firstIntent !== 'review' && execAt >= 0 &&
        (firstIntent === 'neutral' || planAt < 0 || execAt < planAt));
    const typeWantsPlanReview = PLAN_REVIEW_INTENT.test(type);
    const wantsPlanReview = !wantsExec && (firstIntent === 'review' ||
      (firstIntent !== 'exec' && typeWantsPlanReview) ||
      (!firstIntent && planAt >= 0 && (execAt < 0 || planAt < execAt)));
    const model = String(input.model || '');
    const reviewAlias = cfg.models.review.alias;
    const escalationAlias = cfg.models.escalation.alias;
    const isEscalation = new RegExp(escapeRegex(escalationAlias), 'i').test(model)
      || cfg.agents.escalation.some((n) => n.toLowerCase() === type.toLowerCase());
    const isReviewModel = new RegExp(escapeRegex(reviewAlias), 'i').test(model);

    if (wantsPlanReview && !isEscalation && !isReviewModel) {
      d('route-review',
        `Planning / review / verification must run on model "${reviewAlias}".\n` +
        `Re-dispatch with model: "${reviewAlias}". ` +
        `Current dispatch: subagent_type="${type}" model="${model || 'inherited'}".`);
    }
    // The review model is reserved for the work it took over from the escalation model:
    // planning / review / verification — unless the operator explicitly picked it to code.
    const exNow = currentExecRoute(cfg, s);
    const operatorPicked = wantsExec && exNow.route === 'claude' && !!exNow.alias &&
      (exNow.alias === escalationAlias ? isEscalation : model.toLowerCase().includes(String(exNow.alias).toLowerCase()));
    if (isReviewModel && !wantsPlanReview && !operatorPicked) {
      d('review-model-scope',
        `model "${reviewAlias}" is reserved for planning / review / verification.\n` +
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
      const inSession = ex.route !== 'codex' || orcaFallbackActive();
      const wantAlias = ex.route === 'claude' ? ex.alias : cfg.models.code.alias;
      if (!inSession) {
        d('route-execution-to-codex',
          `Code goes to Codex in an Orca worker right now [${ex.why}].\n` +
          'Use: orca orchestration task-create -> worker-start -> worker-read/worker-list -> worker-release.\n' +
          'If Orca genuinely cannot open a worker, declare the fallback first:\n' +
          '  date -u +%Y-%m-%dT%H:%M:%SZ > ~/.claude/orchestrator-gate/orca-unavailable\n' +
          `That declaration expires after ${Math.round(ORCA_DOWN_TTL_SECONDS / 60)} minutes, on purpose.\n` +
          'The operator (only) can pick the coding model with --code-model <alias|codex|codex:<model>|auto>.');
      }
      if (!model.toLowerCase().includes(String(wantAlias || '').toLowerCase())) {
        d('execution-model-mismatch',
          `In-session code work must run on model "${wantAlias}" [${ex.why}]. Re-dispatch with model: "${wantAlias}". ` +
          `Current dispatch: subagent_type="${type}" model="${model || 'inherited'}".`);
      }
      if (!VERIFY_COMMAND.test(`${input.description || ''}\n${input.prompt || ''}`)) {
        d('code-brief-needs-verify', CODE_BRIEF_HELP);
      }

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
    const wantsLookup = cfg.agents.lookup.some((n) => n.toLowerCase() === type.toLowerCase())
      || (LOOKUP_INTENT.test(hay) && !wantsExec && !wantsPlanReview);
    if (wantsLookup && !new RegExp(escapeRegex(cfg.models.lookup.alias), 'i').test(model) && !isEscalation) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
        additionalContext: `orchestrator-gate advice: this looks like a light lookup (find/locate/read logs/explore). ` +
          `Prefer model "${cfg.models.lookup.alias}" for such dispatches - cheaper and faster; keep the code model for heavier reading.` } }));
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
function registerDispatchReplies(s, p, cmd, out, { assumeDispatched }) {
  const dispatchInvs = orcaInvocations(cmd).filter((inv) => DISPATCH_SUBS.has(inv.sub) && !hasFlag(inv.args, '--help'));
  if (!dispatchInvs.length) return false;
  const toolUseId = p.tool_use_id || p.toolUseId || null;
  const rawReplies = dispatchInvs.length > 1 ? WG.splitJsonReplies(out) : null;
  // A count mismatch (e.g. one invocation's reply got swallowed by a log-line prefix that
  // defeated the line-start discriminator, or a stray object was miscounted as a reply) means
  // positional zipping (`replies[idx]` <-> `dispatchInvs[idx]`) cannot be trusted AT ALL — it
  // would silently credit one invocation's ids/owns/agent to a completely different
  // invocation. Rather than guess which index is "really" which, every invocation in this
  // command is treated as id-less: each falls through to its own "no ids found" handling
  // (a pending placeholder on the success path, an untouched reservation on the failure path),
  // which is always safe even when wrong, unlike a confident-but-incorrect attribution.
  const mismatched = !!rawReplies && rawReplies.length !== dispatchInvs.length;
  const replies = mismatched ? null : rawReplies;
  const replySlice = (idx) => {
    if (mismatched) return '';
    return replies ? (replies[idx] !== undefined ? JSON.stringify(replies[idx]) : '') : out;
  };
  let dirty = false;

  dispatchInvs.forEach((inv, idx) => {
    const resId = toolUseId ? `${toolUseId}#${idx}` : null;
    const reservation = resId ? s.reservations[resId] : null;
    const replyText = replySlice(idx);

    if (inv.sub === 'orchestration task-create') {
      const idMatch = replyText.match(/"taskId"\s*:\s*"([^"]+)"/) || replyText.match(/\b(task_[A-Za-z0-9_-]+)\b/);
      const taskId = idMatch && idMatch[1];
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
    const worktreeIds = [...replyText.matchAll(/"worktreeId"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);

    if (failed) {
      const readiness = inv.sub === 'orchestration worker-start' && readinessTimeoutDetails(replyText);
      if (readiness?.dispatch) {
        s.workers[readiness.dispatch] = {
          role: 'codex-exec', started: Date.now(), status: 'live', last_seen: Date.now(),
          rate_limited_until: 0, group: readiness.dispatch, kind: WG.kindOf(readiness.dispatch), agent,
          owns: reservation ? reservation.owns : null, ws: reservation ? reservation.ws : null,
          worktreeIds, readinessTimeout: true,
        };
        dirty = true;
      }
      if (resId && s.reservations[resId]) { delete s.reservations[resId]; dirty = true; }
      const readinessAdvice = readiness && readinessTimeoutAdvice(replyText);
      process.stdout.write(readinessAdvice ||
        'orchestrator-gate: orca worker-start reported "ok": false; nothing was registered.\n');
      return;
    }

    const ids = WG.idsFromOutput(replyText);
    if (!ids.size) {
      if (!assumeDispatched) return; // unknown outcome on a failure event: keep the reservation.
      const pendingId = `pending-${Date.now()}-${idx}`;
      s.workers[pendingId] = {
        role: 'codex-exec', started: Date.now(), status: 'live', last_seen: Date.now(),
        rate_limited_until: 0, unverified: true, group: pendingId, kind: 'worker', agent,
        owns: reservation ? reservation.owns : null, ws: reservation ? reservation.ws : null,
        worktreeIds,
      };
      dirty = true;
      process.stdout.write(
        'orchestrator-gate: orca worker-start ran but no dispatch id was found in its output; ' +
        `tracked as ${pendingId} until \`orca orchestration worker-list\` resolves it.\n`
      );
    } else {
      const group = WG.canonicalGroup(ids) || `start-${Date.now()}-${idx}`;
      for (const id of ids) {
        s.workers[id] = {
          role: 'codex-exec', started: Date.now(), status: 'live', last_seen: Date.now(),
          rate_limited_until: 0, group, kind: WG.kindOf(id), agent,
          owns: reservation ? reservation.owns : null, ws: reservation ? reservation.ws : null,
          worktreeIds,
        };
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
    if (p.tool_name === 'Bash') {
      const cmd = String((p.tool_input && p.tool_input.command) || '');
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
  const locked = acquireLock(lockDir, {});
  try {
    s = load(p.session_id);
    return onPostToolUseLocked(p, s, cfg);
  } finally {
    if (locked) releaseLock(lockDir);
  }
}

function onPostToolUseLocked(p, s, cfg) {
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
            s.workers[real] = { ...s.workers[pendingId], role: 'codex-exec', unverified: false };
            delete s.workers[pendingId];
          } else {
            s.workers[pendingId].status = 'settled';
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
      if (s.workers[target]) {
        if (WG.settleGroup(s.workers, WG.groupOf(s.workers[target], target))) dirty = true;
      } else {
        process.stdout.write(
          `orchestrator-gate: ${inv.sub} named "${target}", which this session is not tracking as a live worker; ` +
          'nothing was settled. Check `orca orchestration worker-list`.\n');
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
          if (!worker.readinessTimeout) worker.capExempt = true;
          dirty = true;
        }
      }
    }

    // Rate limiting: record it and set a backoff deadline instead of re-dispatching now.
    // Only worker/terminal output counts; the panel's own quota inspection ("rate_limits" JSON) does not.
    const readsWorkerOutput = /\borca\b/.test(cmd) && /(worker-read|terminal (read|show))\b/.test(cmd);
    if (readsWorkerOutput && hasRateLimitError(workerOutputSignalText(out).replace(/"rate_limits"/g, ''))) {
      s.rate_limit_hits += 1;
      const until = Date.now() + RATE_LIMIT_BACKOFF_SECONDS * 1000;
      for (const w of Object.values(s.workers)) if (w.status === 'live') w.rate_limited_until = until;
      dirty = true;
      process.stdout.write(
        'orchestrator-gate: Codex rate limit detected. Do NOT re-dispatch immediately — that deepens the limit.\n' +
        `Back off ~${RATE_LIMIT_BACKOFF_SECONDS}s, reduce the number of parallel Codex workers, then retry the same worker ` +
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
function unsettledPerOrca(ids) {
  if (!ids.length) return [];
  try {
    const out = require('child_process').execFileSync(
      ORCA_BIN, ['orchestration', 'worker-list', '--json'],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 32 * 1024 * 1024 }
    );
    const parsed = JSON.parse(out);
    const r = parsed.result ?? parsed;
    const workers = Array.isArray(r) ? r : r.workers || [];
    const wanted = new Set(ids);
    // Only this session's dispatches matter. The machine carries a long backlog
    // of retained terminals from earlier sessions; blocking on those would make
    // every future session unstoppable.
    return workers
      .filter((w) => wanted.has(w.dispatchId) || wanted.has(w.taskId) || wanted.has(w.agentTerminalHandle))
      .filter((w) => w.terminalState && w.terminalState !== 'released')
      .map((w) => `${w.dispatchId} [${w.workerState}/${w.terminalState}]`);
  } catch {
    return null;
  }
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
      if (purgedAny) { save(fresh); s = fresh; }
    } finally {
      if (locked) releaseLock(lockDir);
    }
  }

  const live = liveWorkers(s);
  if (!live.length) return;
  const d = (gate, reason) => { if (!gateDisabled(cfg, gate)) { logViolation(s, gate, reason); process.stderr.write(reason); process.exit(2); } };

  // "pending-<ts>" placeholders (a worker-start whose reply carried no dispatch id, see
  // onPostToolUse) are never in Orca's own worker-list by construction - Orca was never
  // given an id to answer about. They must never be auto-settled by an empty `confirmed`
  // result the way a real, Orca-confirmed-released id would be; they stay in the
  // "must be watched" path until a poll resolves them (adopts a real id, or settles them
  // once a poll comes back with nothing new to match).
  const pending = live.filter(([k]) => k.startsWith('pending-'));
  const trackable = live.filter(([k]) => !k.startsWith('pending-'));

  const ids = trackable.map(([k]) => k);
  const confirmed = trackable.length ? unsettledPerOrca(ids) : [];

  // Orca is the authority for trackable ids. If it says every one of ours is released,
  // the session's own bookkeeping was simply stale - settle those (never the pending
  // ones) and, if nothing pending remains either, let the panel go. The `unsettledPerOrca`
  // network round trip above deliberately runs OUTSIDE any lock (it can take up to 15s, and
  // holding the lock that long would stall every other concurrent hook process); this
  // mutation is the only state write onStop performs, so it alone is what needs the
  // acquire-lock -> reload-fresh -> mutate -> save discipline (item 1).
  if (confirmed && confirmed.length === 0) {
    const lockDir = path.join(DIR, '.lock');
    const locked = acquireLock(lockDir, {});
    try {
      s = load(p.session_id);
      const freshTrackable = liveWorkers(s).filter(([k]) => !k.startsWith('pending-') && ids.includes(k));
      for (const [, w] of freshTrackable) w.status = 'settled';
      save(s);
    } finally {
      if (locked) releaseLock(lockDir);
    }
    if (!pending.length) return;
  }

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
    ? confirmed.filter((c) => !DONE.test(c)).map((c) => explicitlyRetained(c) ? `${c} (retained)` : c)
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
  try { main(p); } catch (err) {
    process.stderr.write(`[orchestrator-gate] internal error, allowing: ${err.message}\n`);
    process.exit(0);
  }
  process.exit(0);
});

module.exports = {
  shellSyntaxOnly, redirectTargets, isExemptPath, movesOnlyExemptPaths, shellSegments,
  parseCodeModel, describeOverride, currentExecRoute, escapeRegex, activationApplies,
  hasFlag, flagValue, resolveWorkerStartAgent, liveCodexGroupIds,
};
