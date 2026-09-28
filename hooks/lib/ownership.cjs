#!/usr/bin/env node
/**
 * ownership.cjs — parses an `Owns:` declaration out of a code brief, normalizes each
 * claimed path to a repo-relative, `/`-separated pattern, and tests two claims for
 * overlap with zero runtime dependencies (no glob library; a small hand-rolled matcher).
 *
 * Used by the `code-brief-needs-owns` / `ownership-overlap` gates: a code brief dispatched
 * into a *shared* workspace (not an isolated worktree/Agent) must declare which files it
 * will touch, so two dispatches that would edit the same files are caught before either
 * starts, not after a merge conflict.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_ITEMS = 64;

/** Strip a wrapping quote/backtick pair (only ever one layer — briefs are plain text). */
function stripQuotes(s) {
  return s.replace(/^[`"']+/, '').replace(/[`"']+$/, '');
}

/**
 * Normalize one claimed path to a repo-relative, `/`-separated pattern:
 *  - backslashes become `/` (a brief may be typed on Windows);
 *  - an absolute path is relativized against `repoRoot` when known, refused otherwise
 *    (it cannot be made repo-relative without a root to relativize against);
 *  - a leading `./` and a trailing `/` are cosmetic and stripped;
 *  - any path containing a literal `..` segment is refused outright (never partially
 *    resolved) — a claim is never allowed to point outside the repo.
 * Returns null for anything that normalizes to nothing or is refused.
 */
// Bounds a single claimed pattern must stay within before it is even considered for glob
// translation — a defense-in-depth cap, not evidence the matcher is exploitable as built
// (globToRegExp translates each `**`/`*` into one flat, non-nested quantifier, so it has no
// classic ReDoS shape); still, an absurdly long pattern or wildcard count serves no
// legitimate Owns: claim and is refused outright rather than risking future regex changes
// reintroducing a real cost.
const MAX_ITEM_LENGTH = 256;
const MAX_WILDCARDS = 8;

/** Collapses consecutive `*`/`**` runs into a single `**` (they are equivalent for
 * matching purposes) before the item is stored or turned into a regex — simplifies the
 * pattern and further bounds the wildcard count a pathological input could carry. */
function collapseWildcardRuns(item) {
  return item.replace(/\*{2,}/g, '**').replace(/(\*\*)(\/\*\*)+/g, '$1');
}

/** Normalize `.` / `./` (a bare "current directory" reference, with nothing after it, or an
 * absolute path equal to the repo root itself) to `'**'` — a deliberate WHOLE-REPO claim,
 * since `ownsOverlap` already special-cases `'**'` to conflict with everything. Previously
 * this normalized to the empty string and was then dropped entirely, so `Owns: .` silently
 * claimed nothing while still satisfying the `code-brief-needs-owns` gate's "present"
 * check — a real ownership-bypass: the brief looked compliant but conflicted with nothing. */
function normalizeOwnsItem(raw, repoRootDir) {
  let item = stripQuotes(String(raw || '').trim());
  if (!item) return null;
  item = item.replace(/\\/g, '/');
  if (path.isAbsolute(item)) {
    if (!repoRootDir) return null;
    const rel = path.relative(repoRootDir, item).split(path.sep).join('/');
    if (rel === '' || rel === '.') return '**'; // the repo root itself IS a claim: everything
    if (rel.startsWith('..')) return null; // outside the repo root
    item = rel;
  }
  item = item.replace(/^\.\//, '');
  item = item.replace(/\/+$/, '');
  if (item === '.' || item === '') return '**';
  if (item.split('/').includes('..')) return null;
  if (item.length > MAX_ITEM_LENGTH) return null;
  const wildcardCount = (item.match(/[*?]/g) || []).length;
  if (wildcardCount > MAX_WILDCARDS) return null;
  return collapseWildcardRuns(item);
}

// `Owns:` / `- Owns:` / `* owns:` (case-insensitive), the rest of the line is the value.
const OWNS_LINE = /^[ \t]*[-*]?[ \t]*owns[ \t]*:[ \t]*(.+)$/gim;

/**
 * Splits one `Owns:` line's value into candidate items on any run of commas/whitespace,
 * exactly like the original `/[,\s]+/` split, EXCEPT that a comma or space INSIDE a
 * `{...}` brace-alternation group is protected (brace-depth-aware) rather than treated as
 * a separator — so a brace glob like `src/{a, b}.ts` (a space after the inner comma)
 * survives as ONE item instead of being shattered into two broken fragments, while an
 * ordinary comma-and-space-separated list (`a.ts, b.ts c.ts`) still splits exactly as
 * before.
 */
function splitOwnsLine(line) {
  const parts = [];
  let cur = '';
  let depth = 0;
  for (const ch of line) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,\s]/.test(ch)) {
      if (cur) { parts.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

/**
 * Parses every `Owns:` line out of `text` (a code brief, inline or read from a spec
 * file). Multiple lines contribute to one combined, de-duplicated list (a brief may
 * declare ownership over more than one line). `Owns: n/a <reason>` on ANY line claims
 * nothing for the whole brief — it is a deliberate "no files" declaration, not one item
 * among others.
 *
 * Returns `{ present, isNA, owns, reason }`:
 *   - `present`: at least one `Owns:` line was found at all.
 *   - `isNA`: the brief explicitly claims no files.
 *   - `owns`: normalized, deduped, repo-relative patterns (capped at 64).
 *   - `reason`: the text after `n/a` on an `isNA` brief, else null.
 */
function parseOwns(text, opts = {}) {
  const repoRootDir = opts.repoRoot || null;
  const lines = [];
  const re = new RegExp(OWNS_LINE.source, 'gim');
  let m;
  while ((m = re.exec(String(text || '')))) lines.push(m[1]);
  if (!lines.length) return { present: false, isNA: false, owns: [], reason: null };

  const naLine = lines.find((l) => /^\s*n\/a\b/i.test(l));
  if (naLine) {
    const reason = naLine.replace(/^\s*n\/a\b\s*/i, '').trim();
    return { present: true, isNA: true, owns: [], reason: reason || null };
  }

  const items = [];
  outer: for (const line of lines) {
    for (const raw of splitOwnsLine(line)) {
      if (!raw) continue;
      const norm = normalizeOwnsItem(raw, repoRootDir);
      if (norm) items.push(norm);
      if (items.length >= MAX_ITEMS) break outer;
    }
  }
  const seen = new Set();
  const owns = items.filter((i) => (seen.has(i) ? false : (seen.add(i), true)));
  return { present: true, isNA: false, owns, reason: null };
}

/** Walk up from `cwd` to the first directory holding a `.git` (file or dir) — fs only,
 * never a shell-out to `git`. Returns null when no repo root is found. */
function repoRoot(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  for (;;) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function escapeRegexStr(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasGlobChar(segment) {
  return /[*?{]/.test(segment);
}

function isGlobPattern(pattern) {
  return hasGlobChar(pattern);
}

/** The literal path up to (not including) the first path segment that contains a glob
 * character — the part of the pattern that is guaranteed real path text. */
function literalPrefix(pattern) {
  const segs = pattern.split('/');
  const idx = segs.findIndex(hasGlobChar);
  return idx === -1 ? pattern : segs.slice(0, idx).join('/');
}

/** Small, dependency-free glob -> RegExp: `**` immediately followed by a slash becomes an
 * optional "zero or more whole path segments" group (so `**` + `/x.ts` also matches the
 * zero-directory `x.ts`, not just something with at least one directory in front of it); a
 * bare/trailing `**` -> `.*`; `*` -> `[^/]*`; `?` -> `[^/]`; `{a,b}` -> an alternation group;
 * everything else escaped literally. Anchored full-string match. */
function globToRegExp(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue; }
    if (c === '*' && pattern[i + 1] === '*') { re += '.*'; i += 2; continue; }
    if (c === '*') { re += '[^/]*'; i += 1; continue; }
    if (c === '?') { re += '[^/]'; i += 1; continue; }
    if (c === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) { re += '\\{'; i += 1; continue; }
      const alts = pattern.slice(i + 1, close).split(',').map(escapeRegexStr).join('|');
      re += `(?:${alts})`;
      i = close + 1;
      continue;
    }
    re += escapeRegexStr(c);
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

// A brace-alternation group's combinations are expanded before matching (below); bounded so
// a pattern with many/nested `{...}` groups can never blow up the expansion itself — beyond
// this, the pattern is treated as matching everything (the same "err toward conflict"
// philosophy the rest of this matcher already uses), never silently checking only a subset.
const MAX_BRACE_EXPANSIONS = 64;

/**
 * Expands every `{a,b,c}` group in `pattern` into the list of concrete, brace-free patterns
 * obtained by picking one alternative per group (cartesian product) — each concrete pattern
 * then contains only literal characters, `*`/`**` and `?`. Returns null when the combination
 * count would exceed `MAX_BRACE_EXPANSIONS` (caller treats that as "matches everything").
 */
function expandBraces(pattern) {
  let results = [''];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) { results = results.map((r) => r + pattern.slice(i)); break; }
      const alts = pattern.slice(i + 1, close).split(',');
      const next = [];
      for (const r of results) {
        for (const a of alts) {
          next.push(r + a);
          if (next.length > MAX_BRACE_EXPANSIONS) return null;
        }
      }
      results = next;
      i = close + 1;
      continue;
    }
    results = results.map((r) => r + c);
    i += 1;
  }
  return results;
}

/** Tokenizes a brace-free glob into a flat token list: a literal character, `?` (exactly one
 * non-`/` character), a `*`/`**` run (`crossSlash` tells the matcher below whether the run
 * may include `/`), or `optSlash` — `**` immediately followed by `/`, matching the same
 * "zero or more whole path segments" semantics `globToRegExp` gives it: it may match nothing
 * at all (so a leading "star-star-slash" also matches the zero-directory `x.ts`), or any run of characters
 * (including `/`) that ends in exactly one literal `/`. */
function tokenizeGlob(pattern) {
  const tokens = [];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/') { tokens.push({ type: 'optSlash' }); i += 3; continue; }
    if (c === '*' && pattern[i + 1] === '*') { tokens.push({ type: 'anyN', crossSlash: true }); i += 2; continue; }
    if (c === '*') { tokens.push({ type: 'anyN', crossSlash: false }); i += 1; continue; }
    if (c === '?') { tokens.push({ type: 'any1' }); i += 1; continue; }
    tokens.push({ type: 'lit', ch: c });
    i += 1;
  }
  return tokens;
}

/**
 * Linear-time (dynamic programming, O(tokens.length * text.length), no regex backtracking)
 * match of a tokenized brace-free glob against a literal string.
 *
 * This replaces compiling `*`-heavy patterns into a single backtracking regex
 * (`^[^/]*a[^/]*a[^/]*a...[^/]*b$`), which is the textbook catastrophic-backtracking shape:
 * a claim like `*a*a*a*a*a*a*a*b` (8 wildcards — at, not over, the MAX_WILDCARDS cap, so it
 * is never rejected outright) tested against a long near-miss string of the repeated
 * character can force a regex engine's NFA to explore exponentially many paths before
 * concluding "no match" — a real denial-of-service, since this match happens while the
 * state-file lock may be held, hanging every other concurrent hook process with it. This
 * bounded DP can never cost more than tokens.length * text.length regardless of input.
 */
function tokensMatch(tokens, text) {
  const m = text.length;
  let dp = new Array(m + 1).fill(false);
  dp[0] = true;
  for (const tok of tokens) {
    const next = new Array(m + 1).fill(false);
    if (tok.type === 'anyN') {
      next[0] = dp[0];
      for (let j = 1; j <= m; j++) {
        const charOk = tok.crossSlash || text[j - 1] !== '/';
        next[j] = dp[j] || (charOk && next[j - 1]);
      }
    } else if (tok.type === 'optSlash') {
      // Matches empty, OR any run (any characters, any length) ending in exactly one '/'.
      // `orSoFar` tracks OR(dp[0..j-1]) as j scans upward, so "some position before the
      // trailing '/' was already a valid match start" is a running O(1) check per position
      // rather than an O(m) rescan — keeps the whole token linear.
      next[0] = dp[0];
      let orSoFar = dp[0];
      for (let j = 1; j <= m; j++) {
        next[j] = dp[j] || (text[j - 1] === '/' && orSoFar);
        orSoFar = orSoFar || dp[j];
      }
    } else if (tok.type === 'any1') {
      for (let j = 1; j <= m; j++) next[j] = dp[j - 1] && text[j - 1] !== '/';
    } else {
      for (let j = 1; j <= m; j++) next[j] = dp[j - 1] && text[j - 1] === tok.ch;
    }
    dp = next;
  }
  return dp[m];
}

/** True when glob `pattern` matches literal string `literal` — the safe (linear-time)
 * replacement for `globToRegExp(pattern).test(literal)` used by `ownsOverlap`. Brace
 * alternation is resolved by trying every expansion; a pattern whose expansion count would
 * exceed the cap is treated as matching everything. */
function globMatchesLiteral(pattern, literal) {
  const expansions = expandBraces(pattern);
  if (expansions === null) return true;
  for (const concrete of expansions) {
    if (tokensMatch(tokenizeGlob(concrete), literal)) return true;
  }
  return false;
}

/** True when `a` and `b` are the same path, or one is a directory prefix of the other
 * (matched at a path-segment boundary — "src/api" overlaps "src/api/x.ts" but not
 * "src/api2"). Both inputs are treated as plain literal path text. */
function directoryPrefixRelated(a, b) {
  if (a === b) return true;
  const aSlash = a.endsWith('/') ? a : `${a}/`;
  const bSlash = b.endsWith('/') ? b : `${b}/`;
  return bSlash.startsWith(aSlash) || aSlash.startsWith(bSlash);
}

/**
 * Zero-dependency overlap test between two normalized `Owns:` patterns. `**` alone is a
 * deliberate special case: it is a valid claim (blocks nothing on its own), but conflicts
 * with every other pattern in the same workspace, per design — the refusal message names
 * the holder so narrowing is an informed choice, not a guess.
 *
 *  - literal / literal: equal, or one is a directory prefix of the other.
 *  - literal / glob: the literal matches the glob's regex, OR the glob's literal prefix
 *    is a directory-prefix relative of the literal (covers "Owns: src/api" conflicting
 *    with a glob claim "src/api/**" even though "src/api" itself doesn't match the regex).
 *  - glob / glob: conflict when their literal prefixes are directory-prefix related.
 *    This errs toward conflict — two globs whose prefixes merely look related but whose
 *    full pattern space never actually intersects are still flagged, and the refusal
 *    message says to narrow the claim rather than trying to prove non-overlap exactly.
 */
function ownsOverlap(a, b) {
  if (a === '**' || b === '**') return true;
  const aGlob = isGlobPattern(a);
  const bGlob = isGlobPattern(b);
  if (!aGlob && !bGlob) return directoryPrefixRelated(a, b);
  // A glob whose literal prefix is empty (the very first path segment already contains a
  // glob character, e.g. `*.ts`, `**/*.ts`, `{a,b}/x`) has no real directory to anchor the
  // directory-prefix fallback to — its own pattern space starts at the repo root, so it is
  // treated as matching everywhere for conflict purposes (same "err toward conflict"
  // philosophy as the rest of this matcher), rather than the empty string being compared
  // as if it were a literal directory name that nothing can ever be "inside" of.
  if (aGlob && !bGlob) return globMatchesLiteral(a, b) || literalPrefix(a) === '' || directoryPrefixRelated(literalPrefix(a), b);
  if (!aGlob && bGlob) return globMatchesLiteral(b, a) || literalPrefix(b) === '' || directoryPrefixRelated(literalPrefix(b), a);
  return literalPrefix(a) === '' || literalPrefix(b) === '' || directoryPrefixRelated(literalPrefix(a), literalPrefix(b));
}

/** True when any pattern in `ownsA` overlaps any pattern in `ownsB`. */
function anyOverlap(ownsA, ownsB) {
  for (const a of ownsA || []) {
    for (const b of ownsB || []) {
      if (ownsOverlap(a, b)) return { a, b };
    }
  }
  return null;
}

/**
 * The workspace a claim applies to. Isolated work (a brand-new worktree, or an in-session
 * Agent explicitly isolated) gets a unique key every time — it can never conflict with
 * anything, by construction, since it is not sharing a working tree with anyone.
 * Non-isolated work shares one key per `(repo root, --worktree value or "current")` pair,
 * so two dispatches in the same existing worktree (or both un-worktreed, in the main
 * checkout) are compared against each other, but a dispatch in a *different* named
 * worktree is not.
 */
function workspaceKey({ repoRootDir, worktreeValue, isolated }) {
  if (isolated) return `iso:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  return `${repoRootDir || 'unknown-repo'}|${worktreeValue || 'current'}`;
}

module.exports = {
  parseOwns, normalizeOwnsItem, repoRoot, ownsOverlap, anyOverlap, workspaceKey,
  globToRegExp, globMatchesLiteral, expandBraces, tokenizeGlob, tokensMatch,
  literalPrefix, directoryPrefixRelated, isGlobPattern,
};
