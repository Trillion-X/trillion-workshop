// tools/keep-the-shared-checkout-current/do-work/git-in-a-declared-folder.mjs
//
// The one way a Workshop tool runs git in a folder the person granted (its change-a-folder or read-a-folder folder):
// the environment is cleaned of inherited GIT_* repository variables, a refusal state is read, paths are classified by
// blob id, and nothing here writes a file. Keep-the-shared-checkout-current and keep-package-files-current both use it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RECENT_MS = 120_000;

export const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') || key.includes('SSH')));

// Runs git in the folder with stdin closed (no pipe a child can exit under). A failure throws with the arguments and
// git's own stderr, so the pass's `why` names the call that failed and the words git gave.
export function git(root, args, { env = {} } = {}) {
  const run = spawnSync('git', ['-C', root, ...args], { env: { ...BASE_ENV, ...env }, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.error || run.status !== 0) {
    const stderr = (run.stderr || run.error?.message || '').trim();
    throw new Error(`git ${args.join(' ')} failed (status ${run.status ?? run.signal}): ${stderr}`);
  }
  return run.stdout;
}

// Returns null instead of throwing: a missing ref, a detached HEAD or a failed command is an answer here.
export function gitOrNull(root, args, options) {
  try {
    return git(root, args, options);
  } catch {
    return null;
  }
}

// path -> blob id of every file in a commit (directories and submodules are not files here).
export function blobsAt(root, rev) {
  const blobs = new Map();
  for (const entry of git(root, ['ls-tree', '-r', '-z', rev]).split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [, type, oid] = entry.slice(0, tab).split(' ');
    if (type === 'blob') blobs.set(entry.slice(tab + 1), oid);
  }
  return blobs;
}

// Blob ids of regular files, in order, by path argument in chunks (no stdin). A file git cannot read, or one that vanished,
// is 'unreadable' and is kept by the pass; the rest of its chunk is hashed one file at a time.
function hashRegularFiles(root, paths) {
  const oids = [];
  for (let i = 0; i < paths.length; i += 200) {
    const chunk = paths.slice(i, i + 200);
    try {
      oids.push(...git(root, ['hash-object', '--no-filters', '--', ...chunk]).trim().split('\n'));
    } catch {
      oids.push(...chunk.map((p) => gitOrNull(root, ['hash-object', '--no-filters', '--', p])?.trim() ?? 'unreadable'));
    }
  }
  return oids;
}

// The git blob id of a symbolic link's target text, computed here (no git call, no pipe).
function linkBlobId(target) {
  const body = Buffer.from(target);
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])).digest('hex');
}

// Blob ids of the bytes on disk, hashed as they are (no clean filters). A symlink is hashed as its target text.
export function workingState(root, paths, now) {
  const state = new Map();
  const regular = [];
  for (const p of paths) {
    const full = join(root, p);
    let info;
    try {
      info = lstatSync(full);
    } catch {
      state.set(p, { oid: null, recent: false });
      continue;
    }
    const recent = now.getTime() - info.mtimeMs < RECENT_MS;
    if (info.isFile()) {
      regular.push(p);
      state.set(p, { oid: null, recent });
    } else if (info.isSymbolicLink()) {
      state.set(p, { oid: linkBlobId(readlinkSync(full)), recent });
    } else {
      state.set(p, { oid: 'not-a-file', recent });
    }
  }
  if (regular.length) {
    const oids = hashRegularFiles(root, regular);
    regular.forEach((p, i) => state.set(p, { oid: oids[i], recent: state.get(p).recent }));
  }
  return state;
}

export function dirtyPaths(root) {
  const out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  return out.split('\0').filter(Boolean).map((entry) => entry.slice(3));
}

// The git state that makes a pass refuse (a lock, or a merge, rebase, cherry-pick or revert in progress), or null.
export function refusingState(root) {
  const gitPath = (name) => resolve(root, git(root, ['rev-parse', '--git-path', name]).trim());
  if (existsSync(gitPath('index.lock'))) return '.git/index.lock exists: a git command is running in this checkout';
  const state = ['MERGE_HEAD', 'REVERT_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply'].find((name) => existsSync(gitPath(name)));
  return state ? `${state} exists: a merge, rebase, cherry-pick or revert is in progress` : null;
}

export const gitPathIn = (root, name) => resolve(root, git(root, ['rev-parse', '--git-path', name]).trim());
