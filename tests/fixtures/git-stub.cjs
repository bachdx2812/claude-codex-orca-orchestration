#!/usr/bin/env node
/**
 * Deterministic stand-in for the `git` binary, selected via ORCH_GIT_BIN so
 * orca-heartbeat.cjs's done-but-open worktree checks (acceptance-by-ancestor and the
 * clean check) never depend on a real git repository existing at a test's synthetic
 * worktree path.
 *
 * Every knob defaults to "the git call could not confirm anything" (the same posture a
 * real unreadable/nonexistent repo would produce), so a test only sets the env vars it
 * actually needs and everything else stays conservative.
 *
 *   STUB_GIT_NO_ORIGIN=1        symbolic-ref/rev-parse for origin/HEAD & origin/main fail
 *   STUB_GIT_HAS_MAIN=1         `rev-parse --verify main` succeeds (local-only fallback base)
 *   STUB_GIT_ANCESTOR=1         `merge-base --is-ancestor` exits 0 (HEAD is merged into base)
 *   STUB_GIT_CLEAN=1            `status --porcelain` prints nothing (a clean worktree)
 *   STUB_GIT_STATUS_FAIL=1      `status --porcelain` itself exits non-zero (a probe
 *                              failure distinct from a real dirty/clean verdict)
 *   STUB_GIT_HAS_UPSTREAM=1     `rev-parse @{u}` succeeds (a real upstream exists)
 *   STUB_GIT_UNPUSHED=1         `rev-list @{u}..HEAD` prints a commit (unpushed work)
 *   STUB_GIT_HEAD_COMMIT_TIME  `log -1 --format=%ct HEAD` prints this value (unix seconds);
 *                              unset means "could not confirm" (exit 1, no output) — same
 *                              conservative default as every other knob here, since H1's
 *                              no-linked-PR/MR acceptance path needs a real answer here to
 *                              ever accept a worktree.
 *   STUB_GIT_REFLOG_HAS_COMMIT=1  `reflog show --format=%gs HEAD` prints a line starting
 *                              with "commit" (review round 3, item 3 — the worktree's own
 *                              branch really gained a commit); unset means an empty reflog
 *                              (exit 0, no output), same conservative "could not confirm a
 *                              commit was ever made on this branch" default as every other
 *                              knob here.
 *   STUB_GIT_DELAY_MS          blocks this many milliseconds before answering ANY subcommand
 *                              (review round 3, item 4 — simulates a git-heavy done-worktree
 *                              pass so a test can exercise the GIT_BUDGET_MS cap without a
 *                              real 10s budget); unset/0 means no delay at all.
 */
const args = process.argv.slice(2);
const delayMs = Number(process.env.STUB_GIT_DELAY_MS) || 0;
if (delayMs > 0) {
  // Synchronous block (this stub is a short-lived one-shot process, so a busy-wait costs
  // nothing anyone else is waiting on) — Atomics.wait needs a SharedArrayBuffer, always
  // available in a plain Node process.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}
// A leading global flag (e.g. `--no-optional-locks`, see the real `status --porcelain` call
// in orca-heartbeat.cjs) must not be mistaken for the subcommand itself.
const sub = args.find((a) => !a.startsWith('--'));

function done(stdout, code) {
  if (stdout) process.stdout.write(stdout);
  process.exit(code);
}

if (sub === 'symbolic-ref') {
  if (process.env.STUB_GIT_NO_ORIGIN === '1') done('', 128);
  done('origin/main\n', 0);
}

if (sub === 'remote') {
  const origin = process.env.STUB_GIT_ORIGIN;
  done(origin ? `${origin}\n` : '', origin ? 0 : 2);
}

if (sub === 'branch') {
  const branch = process.env.STUB_GIT_BRANCH;
  done(branch ? `${branch}\n` : '', branch ? 0 : 0);
}

if (sub === 'for-each-ref') {
  done(process.env.STUB_GIT_UPSTREAM_GONE === '1' ? '[gone]\n' : '\n', 0);
}

if (sub === 'config') {
  const configured = process.env.STUB_GIT_CONFIGURED_UPSTREAM === '1';
  if (!configured) done('', 1);
  done(args[args.length - 1].endsWith('.remote') ? 'origin\n' : 'refs/heads/feature/work\n', 0);
}

if (sub === 'rev-parse') {
  if (args.includes('@{u}')) {
    if (process.env.STUB_GIT_UPSTREAM_SIGNAL === '1') process.kill(process.pid, 'SIGTERM');
    done(process.env.STUB_GIT_HAS_UPSTREAM === '1' ? 'origin/feature\n' : '', process.env.STUB_GIT_HAS_UPSTREAM === '1' ? 0 : 128);
  }
  if (args[args.length - 1] === 'HEAD') done(`${process.env.STUB_GIT_HEAD_OID || 'head123'}\n`, 0);
  const ref = args[args.length - 1];
  if (ref === 'origin/main') done('deadbeef\n', process.env.STUB_GIT_NO_ORIGIN === '1' ? 1 : 0);
  if (ref === 'main') done('deadbeef\n', process.env.STUB_GIT_HAS_MAIN === '1' ? 0 : 1);
  done('', 1);
}

if (sub === 'merge-base') {
  done('', process.env.STUB_GIT_ANCESTOR === '1' ? 0 : 1);
}

if (sub === 'status') {
  if (process.env.STUB_GIT_STATUS_FAIL === '1') done('', 128);
  if (process.env.STUB_GIT_CLEAN !== '1') done(' M some/file.txt\0', 0);
  const ignored = process.env.STUB_GIT_IGNORED;
  done(ignored ? ignored.split(',').map((file) => `!! ${file}\0`).join('') : '', 0);
}

if (sub === 'rev-list') {
  done(process.env.STUB_GIT_UNPUSHED === '1' ? 'deadbeef1234\n' : '', 0);
}

if (sub === 'log') {
  const t = process.env.STUB_GIT_HEAD_COMMIT_TIME;
  if (t === undefined) done('', 1);
  done(`${t}\n`, 0);
}

if (sub === 'reflog') {
  done(process.env.STUB_GIT_REFLOG_HAS_COMMIT === '1' ? 'commit: real work\n' : '', 0);
}

process.stderr.write(`git-stub: unrecognised command ${sub}\n`);
process.exit(1);
