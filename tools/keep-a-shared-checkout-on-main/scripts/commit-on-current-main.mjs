#!/usr/bin/env node
// scripts/commit-on-current-main.mjs
//
// Purpose
//   Git runs this for every commit in the shared checkout (core.hooksPath scripts/git-hooks), whoever commits: Claude
//   Code, Codex, the ChatGPT app or a person. It refuses a commit, and any other move of HEAD or of the branch HEAD is
//   on, when the new commit does not descend from origin/main. From 2026-10-13 to 2026-10-27 the shared checkout sat
//   on a 13-day-old main while sessions copied newer main files into it, and five commits landed on that old line,
//   where no landing road could take them (the two-histories rescue note of 2026-10-27,
//   kept in the control repository).
//
//   scripts/git-hooks/pre-commit runs `pre-commit`: it fetches origin main (bounded) and refuses at once with the
//   reason. scripts/git-hooks/reference-transaction runs `reference-transaction <state>` with git's ref updates on
//   stdin, so a commit made with --no-verify, a cherry-pick, a merge, an update-ref or a checkout of an old commit is
//   refused too: git offers no flag that skips that hook.
//
// Non-negotiable invariants
//   1. Only the shared checkout is judged: the main worktree of its repository (git dir equals common git dir). A
//      linked worktree commits on its own branch, at its own base, and is never refused here; neither is the HEAD
//      `git worktree add` writes for a new one (the hook tells that command apart).
//   2. "Current main" is origin/main as last fetched. pre-commit fetches it first and, when the fetch fails or takes
//      longer than FETCH_TIMEOUT_MS, judges against the last-fetched one and says so.
//   3. A shallow repository cannot see whether a commit descends from main, so in one every judged move is refused,
//      with the one command that repairs it.
//   4. Nothing is written: no ref, no index, no file. Exit 1 refuses, exit 0 allows.
//
// Installed by npm install in this repository's checkout (package.json prepare runs scripts/hooks-from-main.mjs, which points core.hooksPath at an export of main); scripts/commit-paths.sh pushes with it whatever the checkout says.
//
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = 'refs/remotes/origin/main';
const FETCH_TIMEOUT_MS = 15_000;
const ZERO = /^0+$/;

const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });
const read = (...args) => { const run = git(...args); return run.status === 0 ? run.stdout.trim() : null; };
const real = path => { try { return realpathSync(path); } catch { return resolve(path); } };

/** True only in the main worktree of a repository: the one checkout every chat shares. */
export function isSharedCheckout() {
  const dir = read('rev-parse', '--git-dir'), common = read('rev-parse', '--git-common-dir');
  return Boolean(dir && common) && real(dir) === real(common);
}

/** Why moving the checkout to `commit` is refused, or null. `note` says how current origin/main is. */
export function refusalFor(commit, note = '', what = 'HEAD would move to') {
  if (read('rev-parse', '--is-shallow-repository') === 'true') {
    return `Refused: this checkout is a shallow repository, so git cannot see whether ${commit.slice(0, 10)} descends from origin/main. Run git fetch --unshallow origin, then commit again.`;
  }
  const main = read('rev-parse', '--verify', '-q', MAIN);
  if (!main) return 'Refused: this checkout has no origin/main to build on. Run git fetch origin main.';
  const ancestor = git('merge-base', '--is-ancestor', main, commit);
  if (ancestor.status === 0) return null;
  if (ancestor.status !== 1) return `Refused: git could not say whether ${commit.slice(0, 10)} descends from origin/main ${main.slice(0, 10)}: ${ancestor.stderr.trim()}`;
  return `Refused: ${what} ${commit.slice(0, 10)}, which does not descend from origin/main ${main.slice(0, 10)}${note}; the shared checkout holds only work built on current main. Commit with scripts/commit-paths.sh "<message>" path [path...] (it builds the commit on origin/main in a private index and pushes it), and read an older version with git show <commit>:<path>.`;
}

/** pre-commit: fetch origin main within FETCH_TIMEOUT_MS, then judge HEAD (the commit's parent). */
function preCommit() {
  const fetched = spawnSync('git', ['fetch', '-q', '--no-tags', 'origin', 'main'], { encoding: 'utf8', timeout: FETCH_TIMEOUT_MS });
  const note = fetched.status === 0 ? '' : ' (last fetched; fetching origin main just now failed, so main may be newer)';
  const head = read('rev-parse', '--verify', '-q', 'HEAD');
  return head ? refusalFor(head, note, 'this commit would be built on') : 'Refused: this checkout has no commit checked out to build on. Check out origin/main.';
}

/** reference-transaction: judge each update of HEAD, or of the branch HEAD is on, to a commit. */
function referenceTransaction(state, updates) {
  if (state !== 'prepared') return null;
  const branch = read('symbolic-ref', '-q', 'HEAD');
  for (const line of updates.split('\n')) {
    const [, next, ref] = line.trim().split(/\s+/);
    if (!ref || (ref !== 'HEAD' && ref !== branch) || !next || ZERO.test(next)) continue;
    if (read('cat-file', '-t', next) !== 'commit') continue;
    const refusal = refusalFor(next);
    if (refusal) return refusal;
  }
  return null;
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(new URL(import.meta.url)))) {
  const [mode, state] = process.argv.slice(2);
  let refusal = null;
  if (isSharedCheckout()) {
    if (mode === 'pre-commit') refusal = preCommit();
    else if (mode === 'reference-transaction') {
      let updates = '';
      for await (const chunk of process.stdin) updates += chunk;
      refusal = referenceTransaction(state, updates);
    } else refusal = `usage: commit-on-current-main.mjs pre-commit | reference-transaction <state>`;
  }
  if (refusal) { process.stderr.write(`${refusal}\n`); process.exit(1); }
}