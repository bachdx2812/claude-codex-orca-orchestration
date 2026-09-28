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
const { loadConfig, gateDisabled, handoffUsed, stateDir } = require('./lib/config.cjs');

const DIR = stateDir();
const LOG = path.join(DIR, 'violations.log');
// ORCA_DOWN_FLAG_PATH lets the test suite use a temp flag instead of the real one.
const ORCA_DOWN_FLAG = process.env.ORCA_DOWN_FLAG_PATH || path.join(DIR, 'orca-unavailable');
// ORCA_BIN lets the test suite point at a stub instead of a real `orca` on PATH.
const ORCA_BIN = process.env.ORCA_BIN || 'orca';
// CODEX_BIN lets the test suite point at a stub or a deliberately missing path, exactly
// like ORCA_BIN, so "codex is not on PATH" is testable without touching a real install.
const CODEX_BIN = process.env.CODEX_BIN || 'codex';

// --- tunables ---------------------------------------------------------------
const RATE_LIMIT_BACKOFF_SECONDS = 120; // wait before retrying a rate-limited worker
const ORCA_DOWN_TTL_SECONDS = 900;      // how long an "Orca is down" declaration stays valid

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
const EXEC_INTENT = /\b(implement|implementation|build|refactor|migrate|scaffold|execute|fix\s|write\s+(the\s+)?code|codegen|generate\s+(code|assets))\b/i;
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

// Markers that a Codex worker is rate limited rather than working.
const RATE_LIMIT_MARKER = /(rate.?limit|429\b|quota\s+exceeded|usage\s+limit|too\s+many\s+requests|retry[- ]after|overloaded_error)/i;
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
    execAgent: null,        // null (auto by quota) | 'code' | 'codex' | 'codex:<model>' | 'claude:<alias>'
    workers: {},            // label -> { role, started, status, last_seen, rate_limited_until }
    last_heartbeat: 0,      // epoch ms of the last worker-status poll
    rate_limit_hits: 0,
  };
}

function load(sid) {
  try { return JSON.parse(fs.readFileSync(stateFile(sid), 'utf8')); } catch { return blank(sid); }
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
 * The heartbeat daemon this session started, if it is alive: its liveness file
 * exists, its pid answers, and it ticked within three intervals. null otherwise.
 */
function heartbeatAlive(sid) {
  try {
    const f = path.join(DIR, `heartbeat-${String(sid || 'default').replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
    const b = JSON.parse(fs.readFileSync(f, 'utf8'));
    process.kill(b.pid, 0); // throws when the process is gone
    const maxAge = (Number(b.interval) || 20) * 3000 + 30000;
    return Date.now() - Number(b.last_tick || 0) <= maxAge ? b : null;
  } catch {
    return null;
  }
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

/** "Reply to the operator in <language>." — omitted entirely when replyLanguage is null. */
function languageSentence(cfg, forBanner) {
  if (!cfg.replyLanguage) return forBanner ? '' : '';
  return forBanner
    ? `- Talk to the operator in ${cfg.replyLanguage}. This panel orchestrates; it does not implement.\n`
    : `Reply to the operator in ${cfg.replyLanguage}. `;
}

// --- handlers ---------------------------------------------------------------

function onSessionStart(p, s, cfg) {
  if (!fs.existsSync(stateFile(s.session_id))) save(s);
  const review = cfg.models.review.alias;
  const escalation = cfg.models.escalation.alias;
  const lookup = cfg.models.lookup.alias;
  const code = cfg.models.code.alias;
  const threshold = handoffUsed(cfg);
  const warnings = (cfg.warnings || []).map((w) => `- CONFIG WARNING: ${w}\n`).join('');
  process.stdout.write(
    'ORCHESTRATION CONTRACT (enforced by orchestrator-gate.cjs):\n' +
    warnings +
    languageSentence(cfg, true) +
    '- The main panel may read and dispatch only. It may not Edit/Write outside .claude/, plans/, docs/, scratch,\n' +
    '  and may not run mutating shell commands. Delegate those to a worker.\n' +
    `- Model routing: ${modelLabel(cfg.models.review)} plans + red-teams -> Codex (${code} once Codex >= ${threshold}% used) codes -> ${review} reviews.\n` +
    `- Planning / red-team / review / verification -> in-session subagent on model ${modelLabel(cfg.models.review)}.\n` +
    `  Model ${modelLabel(cfg.models.escalation)} only after "${review}" failed even at high effort; say both in the dispatch.\n` +
    `- Light lookups (find/locate code, read logs or test output, explore) -> model ${modelLabel(cfg.models.lookup)}.\n` +
    '- Every code brief (Codex spec or in-session prompt) names the exact test / build command to run green.\n' +
    `- Code: Codex first; "${code}" once Codex has used >= ${threshold}% of its quota (the per-prompt reminder names it):\n` +
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
    '- Release or close a worker as soon as it is done and not reusable.\n'
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
  const raw = String(p.prompt || '');
  const prompt = NON_OPERATOR_TURN.test(raw) ? '' : raw;
  if (operatorFlag(prompt, '--no-orchestrate')) {
    s.bypass = true; save(s);
    process.stdout.write('orchestrator-gate: BYPASSED for this session by explicit user request.\n');
    return;
  }
  if (s.bypass) return;

  // Honest, explicit, session-scoped preference for execution routing. This is NOT the
  // orca-unavailable flag: it never claims Orca is unreachable, and it does not
  // self-expire — the operator sets it once and reverts it once, both by hand.
  // --code-model <value> lets the operator pick the coding model directly; --exec-sonnet /
  // --exec-codex are shortcuts for the configured code model / Codex. Whichever of these
  // appears last in the prompt wins.
  const flagAt = (f) => (operatorFlag(prompt, f) ? prompt.toLowerCase().lastIndexOf(f) : -1);
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
    s.execAgent = override; save(s);
    process.stdout.write(override === null
      ? `orchestrator-gate: coding model back to automatic (Codex first, "${cfg.models.code.alias}" past the Codex handoff %).\n`
      : `orchestrator-gate: coding model set by the operator for this session: ${describeOverride(cfg, override)}. Revert with --code-model auto.\n`);
  } else if (override === 'invalid') {
    process.stdout.write(`orchestrator-gate: ignored --code-model ${cm[2]} (use ${cfg.models.review.alias} | ${cfg.models.code.alias} | ${cfg.models.lookup.alias} | ${cfg.models.escalation.alias} | codex | codex:<model> | auto).\n`);
  }

  const live = liveWorkers(s);
  const parts = [languageSentence(cfg, false) + 'Delegate; do not implement here.'];
  const ex = currentExecRoute(cfg, s);
  const codexModelShown = ex.codexModel || cfg.models.codex.id;
  const roleByAlias = (alias) => Object.values(cfg.models).find((m) => m.alias === alias) || { alias, id: null };
  const codeRoute = ex.route === 'codex'
    ? `Codex in an Orca worker${codexModelShown ? ` (worker-start --agent codex --model ${codexModelShown})` : ''}`
    : `in-session subagent (Agent model ${modelLabel(ex.route === 'claude' ? roleByAlias(ex.alias) : cfg.models.code)})`;
  parts.push(`Model routing: plan/red-team/review -> model ${modelLabel(cfg.models.review)}; code -> ${codeRoute} [${ex.why}].`);
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
    // Code briefs handed to Codex through Orca must let it check itself. Judged on the
    // real orca invocation's own args (quoted mentions in grep/echo never match), and
    // only for code work: research / review / publish specs are not code briefs.
    const orcaInv = orcaInvocations(cmd).find((inv) =>
      (inv.sub === 'orchestration task-create' || inv.sub === 'orchestration worker-start') &&
      hasFlag(inv.args, '--spec') && !hasFlag(inv.args, '--help'));
    if (orcaInv) {
      const brief = briefText(cmd, p.cwd);
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

  // Gates 3 and 4: role routing for dispatched work.
  if (tool === 'Agent' || tool === 'Task') {
    // Classify by the verb that governs the task, not by mere presence of a keyword:
    // "plan the refactor" is planning, "implement the plan" is execution. Whichever
    // intent word appears first in the task's own summary wins.
    const hay = `${input.subagent_type || ''} ${input.description || ''}`.trim() || String(input.prompt || '').slice(0, 400);
    const planAt = hay.search(PLAN_REVIEW_INTENT);
    const execAt = hay.search(EXEC_INTENT);
    const wantsPlanReview = planAt >= 0 && (execAt < 0 || planAt < execAt);
    const wantsExec = execAt >= 0 && (planAt < 0 || execAt < planAt);
    const model = String(input.model || '');
    const type = String(input.subagent_type || '');
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
    }

    // Light lookups: advise the lookup model (never blocks).
    const wantsLookup = cfg.agents.lookup.some((n) => n.toLowerCase() === type.toLowerCase())
      || (LOOKUP_INTENT.test(hay) && !wantsExec && !wantsPlanReview);
    if (wantsLookup && !new RegExp(escapeRegex(cfg.models.lookup.alias), 'i').test(model) && !isEscalation) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
        additionalContext: `orchestrator-gate advice: this looks like a light lookup (find/locate/read logs/explore). ` +
          `Prefer model "${cfg.models.lookup.alias}" for such dispatches - cheaper and faster; keep the code model for heavier reading.` } }));
    }
  }
}

function onPostToolUse(p, s, cfg) {
  const tool = p.tool_name;
  const input = p.tool_input || {};
  const resp = p.tool_response || {};
  let dirty = false;

  if (tool === 'Bash') {
    const cmd = String(input.command || '');
    const out = `${resp.stdout || ''}\n${resp.stderr || ''}`;

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

    // Starting a worker registers it as live. The identifier is taken from
    // Orca's own reply rather than parsed out of the command line, because the
    // operator does not use a fixed invocation - whatever flags the panel chose,
    // the dispatchId in the response is authoritative.
    // Only a real orca invocation counts: a grep/echo that merely mentions worker-start
    // (from the panel or a subagent) must not register a phantom worker. --help is judged
    // on that invocation's own args, not the whole command line.
    const startsWorker = orcaInvocations(cmd).some((inv) =>
      (inv.sub === 'orchestration worker-start' || inv.sub === 'terminal create') &&
      !hasFlag(inv.args, '--help'));
    if (startsWorker) {
      const ids = new Set();
      for (const m of out.matchAll(/"(?:dispatchId|taskId|handle)"\s*:\s*"([^"]+)"/g)) ids.add(m[1]);
      for (const m of out.matchAll(/\b((?:ctx|task|term)_[A-Za-z0-9_-]+)\b/g)) ids.add(m[1]);
      if (!ids.size) {
        // No id in Orca's own reply: track it as an explicitly-marked placeholder rather
        // than inventing a fake dispatch id or dropping it silently. `unverified: true`
        // means the Stop gate still refuses to end the session over it (a real worker may
        // well be running), and the next worker-list/worker-read poll resolves it - either
        // adopting a real id this poll surfaces, or settling it once a poll comes back
        // with nothing new to match it to.
        const pendingId = `pending-${Date.now()}`;
        s.workers[pendingId] = { role: 'codex-exec', started: Date.now(), status: 'live', last_seen: Date.now(), rate_limited_until: 0, unverified: true };
        dirty = true;
        process.stdout.write(
          'orchestrator-gate: orca worker-start ran but no dispatch id was found in its output; ' +
          `tracked as ${pendingId} until \`orca orchestration worker-list\` resolves it.\n`
        );
      } else {
        for (const id of ids) {
          s.workers[id] = { role: 'codex-exec', started: Date.now(), status: 'live', last_seen: Date.now(), rate_limited_until: 0 };
        }
        dirty = true;
        if (!heartbeatAlive(s.session_id)) {
          process.stdout.write(
            'orchestrator-gate: worker dispatched. Start the heartbeat now so it cannot sit IDLE unnoticed:\n' +
            `  ${heartbeatStartCommand()}\n`
          );
        }
      }
    }

    // Stopping, releasing or closing a worker settles it.
    const stop = cmd.match(/(?:worker-stop|worker-release|worker-abandon|terminal close)[^\n]*?("[^"]+"|'[^']+'|[^\s]+)\s*$/);
    if (stop) {
      const label = stop[1].replace(/^["']|["']$/g, '');
      if (s.workers[label]) { s.workers[label].status = 'settled'; dirty = true; }
      else { for (const w of Object.values(s.workers)) { if (w.status === 'live') { w.status = 'settled'; dirty = true; } } }
    }

    // Rate limiting: record it and set a backoff deadline instead of re-dispatching now.
    // Only worker/terminal output counts; the panel's own quota inspection ("rate_limits" JSON) does not.
    const readsWorkerOutput = /\borca\b/.test(cmd) && /(worker-read|terminal (read|show))\b/.test(cmd);
    if (readsWorkerOutput && RATE_LIMIT_MARKER.test(out.replace(/"rate_limits"/g, ''))) {
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
  // ones) and, if nothing pending remains either, let the panel go.
  if (confirmed && confirmed.length === 0) {
    for (const [, w] of trackable) w.status = 'settled';
    if (!pending.length) { save(s); return; }
    save(s);
  }

  // Workers still running are a legitimate wait - but only while the heartbeat daemon
  // watches them, so the panel is woken on the first event instead of going AFK.
  // Finished workers still holding a terminal must be released first, heartbeat or not.
  const DONE = /\[(succeeded|failed|stopped|cancelled|canceled)\//;
  const finished = confirmed ? confirmed.filter((c) => DONE.test(c)) : [];
  const stillRunning = confirmed ? confirmed.length - finished.length : ids.length;
  if (stillRunning > 0 || pending.length) {
    if (heartbeatAlive(s.session_id)) return;
    const runningList = confirmed ? confirmed.filter((c) => !DONE.test(c)) : ids;
    const pendingList = pending.map(([k]) => `${k} (no dispatch id yet - run \`orca orchestration worker-list\` to resolve)`);
    const allShown = [...runningList, ...pendingList];
    d('workers-unwatched',
      `[orchestrator-gate:workers-unwatched] ${allShown.length} worker(s) still running: ${allShown.join(', ')}.\n` +
      'You may wait for them, but not unwatched. Start the heartbeat first, then end the turn:\n' +
      `  ${heartbeatStartCommand()}\n`);
    return;
  }

  const shown = confirmed && confirmed.length ? confirmed : ids;
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
  hasFlag, flagValue,
};
