#!/usr/bin/env node
/**
 * shell-orca-invocations.cjs — linear-time shell scanner that finds every real
 * `orca <sub>` invocation a shell would actually execute in a command line.
 *
 * Replaces a previous regex-based `invokesOrca`/`orcaCandidates` pair in
 * orchestrator-gate.cjs, which had several problems: (1) a nested alternation
 * inside a repeated group could backtrack exponentially on adversarial input;
 * (2) it read `$( )`/backtick text sitting inside single quotes, heredoc
 * bodies, or after an escaping backslash as real substitutions; (3)
 * `--help`/`--spec` were tested against the whole command line instead of the
 * specific orca invocation's own argument words; (4) a nested `$( )` inside a
 * double-quoted arg (e.g. `id="$(orca ... --task "$(cat f)")"`) was never
 * found; (5) wrapper forms (`sudo`, `xargs`, `env -u X`, `{ ...; }`,
 * `if ...; then orca ...; fi`) were not recognized.
 *
 * Design: a single left-to-right character scan (no backtracking-capable
 * regex; the only regexes used are a linear character-class assignment test
 * and a linear character-class "run of ordinary characters" matcher, both
 * with a single quantifier and no alternation). Command substitutions
 * (`$( )` and backticks) are scanned recursively, because their bodies
 * execute — whether they sit in unquoted text or inside double quotes.
 * Single-quoted text is always literal and is never scanned. Heredoc bodies
 * are skipped verbatim, whatever they contain. Input is capped at 64 KB so a
 * pathological command line cannot make this scan (or its caller) slow, and
 * command-substitution recursion is capped at a fixed depth as a safety
 * valve against adversarial nesting.
 *
 * Exports `orcaInvocations(cmd)` -> Array<{
 *   sub: string, args: string[], stdoutPiped: boolean,
 *   stdoutRedirected: boolean, stdoutCaptured: boolean
 * }>,
 * one entry per real orca invocation, in the order the shell would run them.
 * `sub` is 'orchestration worker-start' | 'orchestration task-create' |
 * 'terminal create' | the first one or two words after `orca` otherwise.
 * `args` is every word after `orca` itself, quotes removed.
 */

'use strict';

const MAX_LEN = 64 * 1024;
const MAX_DEPTH = 200; // recursion cap for nested $( )/backticks — a safety valve, not a real limit

// Reserved words that act as pure command separators when they are the sole
// word collected so far for the command being built ("in command position").
const KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until']);

// A leading NAME=value assignment. Linear: one character class, one quantifier.
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

// A run of characters that need no special handling. Linear: one character
// class (negated), one quantifier, sticky so it only matches at `lastIndex`.
const WORD_RUN = /[^'"\\$`(){}\n;&|>\s]+/y;

// A bare heredoc delimiter word.
const HEREDOC_WORD = /[A-Za-z0-9_]+/y;

const SUDO_ARG_OPTS = new Set(['-u', '-g', '-p', '-h', '-C', '-U', '-r', '-t', '-T']);
const XARGS_ARG_OPTS = new Set(['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a']);

function basename(w) {
  if (!w) return '';
  const idx = w.lastIndexOf('/');
  return idx === -1 ? w : w.slice(idx + 1);
}

/**
 * `orchestration worker-start` / `orchestration task-create` / `terminal create`
 * are named explicitly because the gate routes on them; anything else is
 * named by its first one or two words, e.g. `worker-list`, `doctor`.
 */
function deriveSub(rest) {
  if (!rest.length) return '';
  if (rest[0] === 'orchestration' && (rest[1] === 'worker-start' || rest[1] === 'task-create')) {
    return `orchestration ${rest[1]}`;
  }
  if (rest[0] === 'terminal' && rest[1] === 'create') return 'terminal create';
  return rest.length > 1 ? `${rest[0]} ${rest[1]}` : rest[0];
}

/**
 * Strip leading NAME=value assignments and known wrapper commands
 * (env/command/exec/nohup/time/sudo/xargs, each possibly chained) from a
 * simple command's word list, then register it as an orca invocation when
 * the remaining first word's basename is `orca`.
 */
function processSimpleCommand(ctx, words, output = {}) {
  if (!words.length) return;
  let i = 0;
  for (;;) {
    let advanced = false;
    while (i < words.length && ASSIGNMENT_RE.test(words[i])) { i += 1; advanced = true; }
    if (i >= words.length) return;
    const base = basename(words[i]);

    if (base === 'env') {
      i += 1; advanced = true;
      while (i < words.length && words[i].startsWith('-') && words[i] !== '--') {
        i += words[i] === '-u' ? 2 : 1;
      }
      if (i < words.length && words[i] === '--') i += 1;
      continue;
    }
    if (base === 'command' || base === 'exec' || base === 'nohup' || base === 'time') {
      i += 1; advanced = true;
      continue;
    }
    if (base === 'sudo') {
      i += 1; advanced = true;
      while (i < words.length && words[i].startsWith('-') && words[i] !== '--') {
        i += SUDO_ARG_OPTS.has(words[i]) ? 2 : 1;
      }
      if (i < words.length && words[i] === '--') i += 1;
      continue;
    }
    if (base === 'xargs') {
      i += 1; advanced = true;
      while (i < words.length && words[i].startsWith('-') && words[i] !== '--') {
        i += XARGS_ARG_OPTS.has(words[i]) ? 2 : 1;
      }
      if (i < words.length && words[i] === '--') i += 1;
      continue;
    }
    if (!advanced) break;
  }
  if (i >= words.length) return;
  if (basename(words[i]) !== 'orca') return;
  const rest = words.slice(i + 1);
  ctx.invocations.push({
    sub: deriveSub(rest),
    args: rest,
    stdoutPiped: output.stdoutPiped === true,
    stdoutRedirected: output.stdoutRedirected === true,
    stdoutCaptured: output.stdoutCaptured === true,
  });
}

/** Output operators applied to a completed `( ... )` or `{ ...; }` group. */
function groupOutputSemantics(s, start, end) {
  let i = start;
  let stdoutRedirected = false;
  const whitespace = () => { while (i < end && (s[i] === ' ' || s[i] === '\t' || s[i] === '\r')) i += 1; };
  const skipTarget = () => {
    whitespace();
    if (s[i] === '&') {
      i += 1;
      while (i < end && (/[0-9]/.test(s[i]) || s[i] === '-')) i += 1;
      return;
    }
    if (s[i] === '"' || s[i] === "'") {
      const quote = s[i++];
      while (i < end && s[i] !== quote) i += s[i] === '\\' ? 2 : 1;
      if (s[i] === quote) i += 1;
      return;
    }
    while (i < end && !/[\s;&|]/.test(s[i])) i += 1;
  };
  whitespace();
  for (;;) {
    if (s[i] === '|' && s[i + 1] !== '|') return { stdoutPiped: true, stdoutRedirected };
    if (s[i] === '&' && s[i + 1] === '>') {
      stdoutRedirected = true;
      i += s[i + 2] === '>' ? 3 : 2;
      skipTarget(); whitespace();
      continue;
    }
    let j = i;
    while (j < end && /[0-9]/.test(s[j])) j += 1;
    const fd = j > i ? s.slice(i, j) : null;
    if (s[j] !== '>') break;
    if (fd === null || fd === '1') stdoutRedirected = true;
    i = j + (s[j + 1] === '>' ? 2 : 1);
    skipTarget(); whitespace();
  }
  return { stdoutPiped: false, stdoutRedirected };
}

/** Skip heredoc bodies queued for the line that just ended, verbatim. */
function skipHeredocBodies(ctx, start, end, pending) {
  const { s } = ctx;
  let i = start;
  for (const { delim, strip } of pending) {
    let matched = false;
    while (i < end) {
      let lineEnd = s.indexOf('\n', i);
      const hasNL = lineEnd !== -1 && lineEnd <= end;
      if (!hasNL) lineEnd = end;
      let line = s.slice(i, lineEnd);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const cmp = strip ? line.replace(/^\t+/, '') : line;
      i = hasNL ? lineEnd + 1 : end;
      if (cmp === delim) { matched = true; break; }
    }
    if (!matched) { i = end; break; } // unterminated heredoc: drop the rest, same as an unterminated substitution
  }
  return i;
}

/**
 * Scan double-quoted text: only `"` (close), `\` (escape) and `$( )`/backtick
 * (still execute) are special; everything else — including `;`, `|`, spaces —
 * is literal content of the current word. Bulk-slices ordinary runs so a long
 * quoted string is still O(n).
 */
function scanDoubleQuoted(ctx, start, end, onText) {
  const { s } = ctx;
  let i = start;
  let segStart = i;
  const flush = (upTo) => { if (upTo > segStart) onText(s.slice(segStart, upTo)); };
  while (i < end) {
    const c = s[i];
    if (c === '"') { flush(i); return i + 1; }
    if (c === '\\') {
      flush(i);
      i += 1;
      if (i < end) { onText(s[i]); i += 1; }
      segStart = i;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      flush(i);
      i = scanRegion(ctx, i + 2, end, 'paren', { stdoutCaptured: true });
      segStart = i;
      continue;
    }
    if (c === '`') {
      flush(i);
      i = scanRegion(ctx, i + 1, end, 'backtick', { stdoutCaptured: true });
      segStart = i;
      continue;
    }
    i += 1;
  }
  flush(end);
  return end; // unterminated double quote: consume to end
}

/**
 * Depth-limited, non-recursive fallback for pathological nesting beyond
 * MAX_DEPTH: skip to the matching close without further word/command
 * extraction inside. Never runs on realistic input.
 */
function skipRegionShallow(ctx, start, end, mode) {
  const { s } = ctx;
  let i = start;
  let depth = mode === 'paren' ? 1 : 0;
  while (i < end) {
    const c = s[i];
    if (c === "'") { i += 1; const close = s.indexOf("'", i); i = close === -1 ? end : close + 1; continue; }
    if (c === '"') { i += 1; const close = s.indexOf('"', i); i = close === -1 ? end : close + 1; continue; }
    if (c === '\\') { i += 2; continue; }
    if (mode === 'backtick' && c === '`') { return i + 1; }
    if (c === '(' && mode === 'paren') { depth += 1; i += 1; continue; }
    if (c === ')' && mode === 'paren') { depth -= 1; i += 1; if (depth === 0) return i; continue; }
    i += 1;
  }
  return end;
}

/**
 * Scan one shell region (top level, or the body of a `$( )` / backtick),
 * splitting it into simple commands at `;`, `&&`, `||`, `|`, `&`, newline,
 * `(`, `)`, `{`, `}` and the listed keywords in command position, and
 * registering every orca invocation found via processSimpleCommand.
 *
 * mode: 'top' (runs to `end`), 'paren' (body of `$( )`; started with depth 1,
 * stops and returns just past the matching `)`), or 'backtick' (stops and
 * returns just past the next unescaped, unquoted backtick).
 *
 * Returns the index just past this region's close (or `end` for 'top', or on
 * an unterminated 'paren'/'backtick').
 */
function scanRegion(ctx, start, end, mode, inheritedOutput = {}) {
  if (mode !== 'top') {
    ctx.depth += 1;
    if (ctx.depth > MAX_DEPTH) { ctx.depth -= 1; return skipRegionShallow(ctx, start, end, mode); }
  }
  const { s } = ctx;
  let i = start;
  let words = [];
  let curWord = '';
  let wordOpen = false;
  let stdoutRedirected = false;
  let pendingHeredocs = [];
  const groupStarts = [];
  const braceGroupStarts = [];
  let depth = mode === 'paren' ? 1 : 0;

  const flushWord = () => {
    if (!wordOpen) return;
    words.push(curWord);
    curWord = '';
    wordOpen = false;
    if (words.length === 1 && KEYWORDS.has(words[0])) words.length = 0;
  };
  const flushCommand = ({ stdoutPiped = false } = {}) => {
    if (words.length) {
      processSimpleCommand(ctx, words, {
        stdoutPiped: stdoutPiped || inheritedOutput.stdoutPiped === true,
        stdoutRedirected: stdoutRedirected || inheritedOutput.stdoutRedirected === true,
        stdoutCaptured: inheritedOutput.stdoutCaptured === true,
      });
      words = [];
    }
    stdoutRedirected = false;
  };

  while (i < end) {
    const c = s[i];

    if (c === "'") {
      wordOpen = true;
      i += 1;
      const close = s.indexOf("'", i);
      if (close === -1 || close >= end) { curWord += s.slice(i, end); i = end; }
      else { curWord += s.slice(i, close); i = close + 1; }
      continue;
    }

    if (c === '"') {
      wordOpen = true;
      i = scanDoubleQuoted(ctx, i + 1, end, (t) => { curWord += t; });
      continue;
    }

    if (c === '\\') {
      wordOpen = true;
      i += 1;
      if (i < end) { curWord += s[i]; i += 1; }
      continue;
    }

    if (c === '$' && s[i + 1] === '(') {
      wordOpen = true;
      i = scanRegion(ctx, i + 2, end, 'paren', { stdoutCaptured: true });
      continue;
    }

    if (c === '`') {
      if (mode === 'backtick') { flushWord(); flushCommand(); if (mode !== 'top') ctx.depth -= 1; return i + 1; }
      wordOpen = true;
      i = scanRegion(ctx, i + 1, end, 'backtick', { stdoutCaptured: true });
      continue;
    }

    if (c === '<' && s[i + 1] === '<') {
      flushWord();
      i += 2;
      let strip = false;
      if (s[i] === '-') { strip = true; i += 1; }
      while (i < end && (s[i] === ' ' || s[i] === '\t')) i += 1;
      let delim = '';
      if (s[i] === '"' || s[i] === "'") {
        const q = s[i]; i += 1;
        const close = s.indexOf(q, i);
        if (close === -1 || close >= end) { delim = s.slice(i, end); i = end; }
        else { delim = s.slice(i, close); i = close + 1; }
      } else {
        HEREDOC_WORD.lastIndex = i;
        const m = HEREDOC_WORD.exec(s);
        if (m) { delim = m[0]; i = HEREDOC_WORD.lastIndex; }
      }
      if (delim) pendingHeredocs.push({ delim, strip });
      continue;
    }

    // Process substitutions execute their body in a separate asynchronous shell with
    // a FIFO standing in for its output/input. Captured hook output cannot be zipped
    // positionally back to that nested invocation, so mark it indirect just like `$()`.
    if ((c === '<' || c === '>') && s[i + 1] === '(') {
      wordOpen = true;
      curWord += `${c}(...)`;
      i = scanRegion(ctx, i + 2, end, 'paren', { stdoutCaptured: true });
      continue;
    }

    // A caller that needs to attribute captured output to this exact command cannot
    // trust a reply once stdout is transformed by a pipeline or sent somewhere else.
    // Keep redirection targets in the word stream for backward-compatible argument
    // parsing, but record the provenance loss on the invocation itself.
    if (c === '>' || (c === '&' && s[i + 1] === '>')) {
      // In `2>file`, only stderr moved; bare `>file`, `1>file`, and `&>file`
      // all move stdout. Shell fd prefixes are unquoted decimal words immediately
      // adjacent to the operator, so inspect the open word before flushing it.
      const fd = c === '>' && wordOpen && /^\d+$/.test(curWord) ? curWord : null;
      flushWord();
      if (c === '&' || fd === null || fd === '1') stdoutRedirected = true;
      if (c === '&') i += s[i + 2] === '>' ? 3 : 2;
      else i += s[i + 1] === '>' ? 2 : 1;
      if (c === '>' && s[i] === '&') {
        i += 1;
        while (i < end && (/[0-9]/.test(s[i]) || s[i] === '-')) i += 1;
      }
      continue;
    }

    if (c === '(') {
      flushWord(); flushCommand();
      groupStarts.push(ctx.invocations.length);
      if (mode === 'paren') depth += 1;
      i += 1;
      continue;
    }
    if (c === ')') {
      flushWord(); flushCommand();
      const groupStart = groupStarts.pop();
      if (groupStart != null) {
        const output = groupOutputSemantics(s, i + 1, end);
        for (let j = groupStart; j < ctx.invocations.length; j += 1) {
          if (output.stdoutPiped) ctx.invocations[j].stdoutPiped = true;
          if (output.stdoutRedirected) ctx.invocations[j].stdoutRedirected = true;
        }
      }
      i += 1;
      if (mode === 'paren') {
        depth -= 1;
        if (depth === 0) { if (mode !== 'top') ctx.depth -= 1; return i; }
      }
      continue;
    }
    if (c === '{') {
      flushWord(); flushCommand();
      braceGroupStarts.push(ctx.invocations.length);
      i += 1;
      continue;
    }
    if (c === '}') {
      flushWord(); flushCommand();
      const groupStart = braceGroupStarts.pop();
      if (groupStart != null) {
        const output = groupOutputSemantics(s, i + 1, end);
        for (let j = groupStart; j < ctx.invocations.length; j += 1) {
          if (output.stdoutPiped) ctx.invocations[j].stdoutPiped = true;
          if (output.stdoutRedirected) ctx.invocations[j].stdoutRedirected = true;
        }
      }
      i += 1;
      continue;
    }

    if (c === '\n') {
      flushWord(); flushCommand();
      i += 1;
      if (pendingHeredocs.length) { i = skipHeredocBodies(ctx, i, end, pendingHeredocs); pendingHeredocs = []; }
      continue;
    }
    if (c === ';') { flushWord(); flushCommand(); i += 1; continue; }
    if (c === '&' && s[i + 1] === '&') { flushWord(); flushCommand(); i += 2; continue; }
    if (c === '|' && s[i + 1] === '|') { flushWord(); flushCommand(); i += 2; continue; }
    if (c === '|') { flushWord(); flushCommand({ stdoutPiped: true }); i += 1; continue; }
    if (c === '&') { flushWord(); flushCommand(); i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { flushWord(); i += 1; continue; }

    WORD_RUN.lastIndex = i;
    const m = WORD_RUN.exec(s);
    if (m) { wordOpen = true; curWord += m[0]; i += m[0].length; continue; }
    // A lone special char WORD_RUN excludes but nothing above claimed (e.g. a bare '<' or '>').
    wordOpen = true; curWord += c; i += 1;
  }

  flushWord();
  flushCommand();
  if (mode !== 'top') ctx.depth -= 1;
  return end;
}

/**
 * Every real `orca <sub>` invocation this command line would execute.
 * Never throws: malformed input degrades to an empty result.
 */
function orcaInvocations(cmd) {
  try {
    const s = String(cmd == null ? '' : cmd).slice(0, MAX_LEN);
    const ctx = { s, invocations: [], depth: 0 };
    scanRegion(ctx, 0, s.length, 'top');
    return ctx.invocations;
  } catch {
    return [];
  }
}

module.exports = { orcaInvocations };
