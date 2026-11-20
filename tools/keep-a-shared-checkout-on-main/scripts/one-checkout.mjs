#!/usr/bin/env node
// scripts/one-checkout.mjs
//
// Purpose
//   This repository has one checkout per machine: the primary one. A second checkout (a `git worktree add`, a second
//   `git clone`) is a second place where work becomes invisible and is lost; on 2026-10-27 about 390 of them were
//   retired, and a push from one with no hooks put a bad commit on main. Git runs this from scripts/git-hooks for
//   whoever works: Claude Code, Codex or a person.
//     post-checkout <old> <new> <flag>   A checkout that is not the primary one is refused. A worktree that
//                                        `git worktree add` has just made (old is the null commit) is removed again,
//                                        so the command fails and leaves nothing behind; any other checkout in a second
//                                        copy is refused and named, and nothing in it is deleted.
//     commit                             pre-commit and scripts/commit-paths.sh: refused in a checkout that is not the
//                                        primary one.
//     ref-update (git's updates on stdin) reference-transaction: the same for any move of HEAD or a branch, so
//                                        --no-verify skips nothing. Let through: an update that leaves a ref where it
//                                        is (the `git reset --hard` inside `git worktree add` writes one), and the
//                                        first HEAD a linked worktree is given (old value null), which only
//                                        `git worktree add` writes; its post-checkout then judges the new worktree.
//     push                               pre-push: the same.
//
// Non-negotiable invariants
//   1. No path is written here. The primary checkout is the machine's fact `git config --global
//      trillion.primaryCheckout <path>`, and a second clone is a checkout whose origin is the primary's origin. Every
//      linked worktree is refused. A repository with another origin (a test's fixture) is never judged as a clone, and
//      when no primary is declared a second clone cannot be told apart and is let through.
//   2. Paths are compared by their real path, so a symlink to the primary checkout is the primary checkout.
//   3. The one second checkout allowed is the temporary tree scripts/run-always-guards.mjs makes to test a pushed
//      commit: it declares itself with `git -c trillion.checkoutPurpose=pushed-commit-guards worktree add`, and it is
//      removed when its tests end. post-checkout lets only that through; commits and pushes are never let through.
//   4. Only a worktree made by the same `git worktree add` is deleted: a new checkout holds no one's work.
//   5. Exit 1 refuses, exit 0 allows. Nothing is sent anywhere.
//
// Installed by npm install (package.json prepare runs scripts/hooks-from-main.mjs, which points core.hooksPath at
// scripts/git-hooks in an export of main; no other script sets core.hooksPath).
// A fresh `git clone` runs no hooks until that install, so only server-side branch protection closes that road.
//
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GUARD_TREE_PURPOSE = 'pushed-commit-guards';
const NULL_COMMIT = /^0+$/;

const git = (args, options = {}) => spawnSync('git', args, { encoding: 'utf8', ...options });
const read = (...args) => { const run = git(args); return run.status === 0 ? run.stdout.trim() : null; };
const real = path => { try { return realpathSync(path); } catch { return resolve(path); } };
// A hook runs with the repository git named for it (GIT_DIR, GIT_WORK_TREE...); a command about another place needs its own.
const LOCATING = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY']);
const elsewhereEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !LOCATING.has(name)));

/** Where this checkout is, whether it is a linked worktree, and which checkout is primary (null: none declared). */
export function checkoutFacts() {
  const top = read('rev-parse', '--show-toplevel');
  const dir = read('rev-parse', '--absolute-git-dir');
  const common = read('rev-parse', '--path-format=absolute', '--git-common-dir');
  const declared = git(['config', '--global', '--get', 'trillion.primaryCheckout']);
  const primary = declared.status === 0 && declared.stdout.trim() ? real(declared.stdout.trim()) : null;
  const originOf = cwd => { const run = git(['-C', cwd, 'config', '--get', 'remote.origin.url'], { env: elsewhereEnv() }); return run.status === 0 ? run.stdout.trim() : null; };
  const origin = read('config', '--get', 'remote.origin.url');
  return {
    top: top && real(top),
    linked: Boolean(dir && common) && real(dir) !== real(common),
    common: common && real(common),
    primary,
    sameOrigin: Boolean(primary && origin) && originOf(primary) === origin,
  };
}

/** Why work in this checkout is refused, or null when it is the primary checkout. */
export function refusalFor(facts, what) {
  if (!facts.top) return null;
  const second = facts.linked || (facts.sameOrigin && facts.top !== facts.primary);
  if (!second) return null;
  const one = facts.sameOrigin ? facts.primary : facts.common ? dirname(facts.common) : 'the main worktree';
  return `Refused: ${what} in ${facts.top}, a second checkout of this repository. This repository has one checkout, ${one}: work there, commit with scripts/commit-paths.sh "<message>" path [path...], and read another version of a file with git show <commit>:<path>. A second checkout or clone hides work and has lost it.`;
}

/** post-checkout: refuse a second checkout, and take back a worktree `git worktree add` has just made. */
function postCheckout(facts, previous) {
  if (facts.linked && read('config', '--get', 'trillion.checkoutPurpose') === GUARD_TREE_PURPOSE) return null;
  const refusal = refusalFor(facts, 'a checkout');
  if (!refusal) return null;
  if (!(facts.linked && NULL_COMMIT.test(previous ?? ''))) return refusal;
  const removed = git(['worktree', 'remove', '--force', '--force', facts.top], { cwd: dirname(facts.common), env: elsewhereEnv() });
  return removed.status === 0
    ? `${refusal}\nThe new worktree ${facts.top} was removed again. A branch made for it with -b is kept; delete it with git branch -d.`
    : `${refusal}\nThe new worktree could not be removed (${removed.stderr.trim()}); remove it with git worktree remove ${facts.top}.`;
}

/** reference-transaction: an update that moves nothing, or a new worktree's first HEAD, passes; any other move is judged. */
export function refUpdateRefusal(facts, updates) {
  const moves = updates.split('\n').map(line => line.trim().split(/\s+/)).filter(words => words.length === 3 && words[0] !== words[1]);
  if (!moves.length) return null;
  if (facts.linked && moves.every(([old, , ref]) => ref === 'HEAD' && NULL_COMMIT.test(old))) return null;
  return refusalFor(facts, 'a move of HEAD or a branch');
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(new URL(import.meta.url)))) {
  const [mode, previous] = process.argv.slice(2);
  const facts = checkoutFacts();
  let updates = '';
  if (mode === 'ref-update') for await (const chunk of process.stdin) updates += chunk;
  const refusal = mode === 'post-checkout' ? postCheckout(facts, previous)
    : mode === 'commit' ? refusalFor(facts, 'a commit')
      : mode === 'ref-update' ? refUpdateRefusal(facts, updates)
        : mode === 'push' ? refusalFor(facts, 'a push')
          : 'usage: one-checkout.mjs post-checkout <old> <new> <flag> | commit | ref-update | push';
  if (refusal) { process.stderr.write(`${refusal}\n`); process.exit(1); }
}