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
function normalizeOwnsItem(raw, repoRootDir) {
  let item = stripQuotes(String(raw || '').trim());
  if (!item) return null;
  item = item.replace(/\\/g, '/');
  if (path.isAbsolute(item)) {
    if (!repoRootDir) return null;
    const rel = path.relative(repoRootDir, item).split(path.sep).join('/');
    if (rel === '' || rel === '.') return null; // the repo root itself is not a file claim
    if (rel.startsWith('..')) return null; // outside the repo root
    item = rel;
  }
  item = item.replace(/^\.\//, '');
  item = item.replace(/\/+$/, '');
  if (!item) return null;
  if (item.split('/').includes('..')) return null;
  return item;
}

// `Owns:` / `- Owns:` / `* owns:` (case-insensitive), the rest of the line is the value.
const OWNS_LINE = /^[ \t]*[-*]?[ \t]*owns[ \t]*:[ \t]*(.+)$/gim;

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
    for (const raw of line.split(/[,\s]+/)) {
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

/** Small, dependency-free glob -> RegExp: `**` -> `.*`, `*` -> `[^/]*`, `?` -> `[^/]`,
 * `{a,b}` -> `(?:a|b)`, everything else escaped literally. Anchored full-string match. */
function globToRegExp(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
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
  if (aGlob && !bGlob) return globToRegExp(a).test(b) || directoryPrefixRelated(literalPrefix(a), b);
  if (!aGlob && bGlob) return globToRegExp(b).test(a) || directoryPrefixRelated(literalPrefix(b), a);
  return directoryPrefixRelated(literalPrefix(a), literalPrefix(b));
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
  globToRegExp, literalPrefix, directoryPrefixRelated, isGlobPattern,
};
