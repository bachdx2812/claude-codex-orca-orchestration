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
 *   STUB_GIT_HAS_UPSTREAM=1     `rev-parse @{u}` succeeds (a real upstream exists)
 *   STUB_GIT_UNPUSHED=1         `rev-list @{u}..HEAD` prints a commit (unpushed work)
 *   STUB_GIT_HEAD_COMMIT_TIME  `log -1 --format=%ct HEAD` prints this value (unix seconds);
 *                              unset means "could not confirm" (exit 1, no output) — same
 *                              conservative default as every other knob here, since H1's
 *                              no-linked-PR/MR acceptance path needs a real answer here to
 *                              ever accept a worktree.
 */
const args = process.argv.slice(2);
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

if (sub === 'rev-parse') {
  if (args.includes('@{u}')) {
    done(process.env.STUB_GIT_HAS_UPSTREAM === '1' ? 'origin/feature\n' : '', process.env.STUB_GIT_HAS_UPSTREAM === '1' ? 0 : 128);
  }
  const ref = args[args.length - 1];
  if (ref === 'origin/main') done('deadbeef\n', process.env.STUB_GIT_NO_ORIGIN === '1' ? 1 : 0);
  if (ref === 'main') done('deadbeef\n', process.env.STUB_GIT_HAS_MAIN === '1' ? 0 : 1);
  done('', 1);
}

if (sub === 'merge-base') {
  done('', process.env.STUB_GIT_ANCESTOR === '1' ? 0 : 1);
}

if (sub === 'status') {
  done(process.env.STUB_GIT_CLEAN === '1' ? '' : ' M some/file.txt\n', 0);
}

if (sub === 'rev-list') {
  done(process.env.STUB_GIT_UNPUSHED === '1' ? 'deadbeef1234\n' : '', 0);
}

if (sub === 'log') {
  const t = process.env.STUB_GIT_HEAD_COMMIT_TIME;
  if (t === undefined) done('', 1);
  done(`${t}\n`, 0);
}

process.stderr.write(`git-stub: unrecognised command ${sub}\n`);
process.exit(1);
