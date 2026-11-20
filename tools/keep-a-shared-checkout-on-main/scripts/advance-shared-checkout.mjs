#!/usr/bin/env node
// scripts/advance-shared-checkout.mjs
//
// Purpose
//   Moves a checkout's HEAD forward to origin/main without losing a byte of anyone's work. scripts/commit-paths.sh
//   pushes onto origin/main from a private index, so the shared checkout's own HEAD and files stayed behind; sessions
//   then copied newer main files in by hand, and from 2026-10-13 to 2026-10-27 that drift became two histories
//   (the two-histories rescue note of 2026-10-27, kept in the control repository).
//   commit-paths.sh runs this after every push from the shared checkout; a person or a chat runs it by hand:
//     node scripts/advance-shared-checkout.mjs [--checkout <dir>] [--expect-head <commit>] [--preserved-by <origin/ref>] [--if-shared] [--if-idle]
//   --checkout   the checkout to advance (default: the one holding this script)
//   --expect-head refuse unless HEAD is still this commit (the HEAD the caller looked at)
//   --preserved-by a pushed branch (origin/<name>) that holds HEAD: with it, a HEAD that is not an ancestor of origin/main may still
//                advance, because every commit it would leave is kept on that branch (see invariant 1)
//   --if-shared  do nothing, and say nothing, unless the checkout is the main worktree of its repository
//   --if-idle    refuse at once, changing nothing, while another git command holds index.lock or a path main changed is
//                staged: the run after a push (commit-paths.sh) never moves HEAD under a session that is mid-change
//
// Non-negotiable invariants
//   1. It refuses, and changes nothing, when the repository is shallow, when HEAD does not descend to origin/main (an
//      ancestor of it) unless --preserved-by names a remote-tracking branch (refs/remotes/origin/*) that holds HEAD, so
//      every commit of HEAD not on main is reachable from a pushed branch (the branch is printed and never touched), or when a changed path has a content filter or line-ending conversion (bytes on disk would
//      not be the bytes git stores).
//   2. It holds index.lock from before it reads HEAD until the index is written, so no git command stages or commits
//      in between, and two advances run one after the other.
//   3. Only paths that differ between HEAD and origin/main are touched. For each one: a file whose disk bytes equal
//      HEAD's gets main's bytes (the disk is read again right before the write; if it changed, it is kept); a file
//      equal to main's is left; anything else is a local version and is kept and listed. A path whose index entry
//      differs from HEAD (staged) is kept as it is, disk and index alike.
//   4. Before a file is written, every changed path whose disk differs from both HEAD and main is saved in a commit on HEAD at
//      refs/rescue/advance-<local time>-<old head>, and that ref is printed.
//   5. HEAD (or the branch HEAD is on) moves with compare-and-swap on its old value. If that fails, every file written
//      is put back (only where it still holds main's bytes) and nothing else changes. The reference-transaction hook
//      judges the move like any other: origin/main descends from origin/main.
//   6. The index then holds main's entry for every changed path that was not staged, with fresh stat data, so
//      `git status` shows exactly the local versions that were kept.
//
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync,
  renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isSharedCheckout } from './commit-on-current-main.mjs';
import { hooksFromMain } from './hooks-from-main.mjs';
import { fileURLToPath } from 'node:url';

const MAIN = 'refs/remotes/origin/main';
const FETCH_TIMEOUT_MS = 15_000;
const LOCK_WAIT_MS = 10_000;
const ZERO = /^0+$/;

/** One checkout's git, run at its root with no inherited index or work tree pointing elsewhere. */
function gitAt(root) {
  const env = { ...process.env, GIT_WORK_TREE: root };
  delete env.GIT_INDEX_FILE; delete env.GIT_DIR;
  const run = (args, { input, index, timeout, encoding = 'utf8' } = {}) => spawnSync('git', args, {
    cwd: root, input: typeof input === 'string' ? Buffer.from(input) : input, timeout, encoding, maxBuffer: 1 << 30, env: index ? { ...env, GIT_INDEX_FILE: index } : env,
  });
  const read = (args, options) => {
    const done = run(args, options);
    if (done.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(done.stderr).trim()}`);
    return options?.encoding === 'buffer' ? done.stdout : done.stdout.trim();
  };
  return { run, read };
}

/** The entries `git diff --raw -z` gives between two commits: path -> { from, to }, each { mode, blob } or null. */
function changedEntries(git, from, to) {
  const fields = git.read(['diff', '--raw', '-z', '--no-renames', '--no-abbrev', from, to]).split('\0');
  const changed = new Map();
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const [oldMode, newMode, oldBlob, newBlob] = fields[at].slice(1).split(' ');
    const entry = (mode, blob) => (ZERO.test(mode) ? null : { mode, blob });
    changed.set(fields[at + 1], { from: entry(oldMode, oldBlob), to: entry(newMode, newBlob) });
  }
  return changed;
}

/** The bytes of many blobs in one `git cat-file --batch`. */
function blobBytes(git, blobs) {
  const wanted = [...new Set(blobs)];
  const bytes = new Map();
  if (!wanted.length) return bytes;
  const out = git.read(['cat-file', '--batch'], { input: `${wanted.join('\n')}\n`, encoding: 'buffer' });
  let at = 0;
  for (const blob of wanted) {
    const end = out.indexOf(10, at);
    const size = Number(out.toString('latin1', at, end).split(' ')[2]);
    bytes.set(blob, out.subarray(end + 1, end + 1 + size));
    at = end + 1 + size + 1;
  }
  return bytes;
}

/** What is on disk at `path`, as a git entry: { mode, blob, bytes }, null when absent, or { mode: 'other' }. */
function diskEntry(root, path, hashBlob, trustMode) {
  let stat;
  try { stat = lstatSync(join(root, path)); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    const bytes = Buffer.from(readlinkSync(join(root, path), { encoding: 'buffer' }));
    return { mode: '120000', blob: hashBlob(bytes), bytes };
  }
  if (!stat.isFile()) return { mode: 'other' };
  const bytes = readFileSync(join(root, path));
  const mode = trustMode ? ((stat.mode & 0o100) ? '100755' : '100644') : null;
  return { mode, blob: hashBlob(bytes), bytes };
}

const same = (disk, entry) => (disk === null || entry === null
  ? disk === entry
  : disk.mode !== 'other' && disk.blob === entry.blob && (disk.mode === null ? entry.mode !== '120000' : disk.mode === entry.mode));

/** Put `entry` (or nothing) at `path`, replacing whatever is there in one rename. */
function place(root, path, entry, bytes) {
  const full = join(root, path);
  if (entry === null) {
    unlinkSync(full);
    for (let dir = dirname(full); dir.length > root.length; dir = dirname(dir)) {
      try { rmdirSync(dir); } catch { break; }
    }
    return;
  }
  mkdirSync(dirname(full), { recursive: true });
  const temp = join(dirname(full), `.advance-${process.pid}-${Date.now()}.tmp`);
  try {
    if (entry.mode === '120000') symlinkSync(bytes.toString(), temp);
    else { writeFileSync(temp, bytes); chmodSync(temp, entry.mode === '100755' ? 0o755 : 0o644); }
    renameSync(temp, full);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Create `lock` exclusively, waiting up to `waitMs` for another git command to let it go. */
function takeLock(lock, waitMs) {
  const until = Date.now() + waitMs;
  for (;;) {
    try { return openSync(lock, 'wx'); } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() > until) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const localTime = () => {
  const now = new Date(), two = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
};

/** The remote-tracking branch `name` when it is a pushed origin branch that holds `head` (head is an ancestor of it), else null. */
function preservingBranch(git, name, head) {
  const full = git.run(['rev-parse', '--symbolic-full-name', name]).stdout.trim();
  const commit = git.run(['rev-parse', '--verify', '-q', `${name}^{commit}`]).stdout.trim();
  if (!full.startsWith('refs/remotes/origin/') || !commit || git.run(['merge-base', '--is-ancestor', head, commit]).status !== 0) return null;
  return { name: full.slice('refs/remotes/'.length), commit };
}

/**
 * Advance the checkout at `root` to origin/main. Returns { ok, lines } (lines say what happened, refusals included).
 * `beforeMove` runs after the files are written and before HEAD moves; tests use it to move HEAD underneath.
 */
export function advanceCheckout(root, { expectHead = null, fetch = true, beforeMove = null, ifIdle = false, preservedBy = null } = {}) {
  const git = gitAt(root);
  const lines = [];
  const refuse = why => ({ ok: false, lines: [...lines, `Refused: ${why} Nothing was changed.`] });

  const [shallow, format, indexPath] = git.read(['rev-parse', '--is-shallow-repository', '--show-object-format', '--git-path', 'index']).split('\n');
  if (shallow === 'true') {
    return refuse('this checkout is a shallow repository, so git cannot see whether HEAD descends to origin/main. Run git fetch --unshallow origin first.');
  }
  const config = new Map(git.run(['config', '-z', '--get-regexp', '^core\\.(splitindex|autocrlf|filemode)$']).stdout.split('\0').filter(Boolean)
    .map(row => { const [key, value = 'true'] = row.split('\n'); return [key, /^(true|yes|on|1|input)$/i.test(value)]; }));
  if (config.get('core.splitindex')) return refuse('this checkout uses a split index (core.splitIndex), which this step does not write.');
  if (config.get('core.autocrlf')) return refuse('core.autocrlf converts line endings, so disk bytes are not stored bytes.');
  const trustMode = config.get('core.filemode') ?? true;
  if (fetch && git.run(['fetch', '-q', '--no-tags', 'origin', 'main'], { timeout: FETCH_TIMEOUT_MS }).status !== 0) {
    lines.push('Fetching origin main failed; advancing to the last-fetched origin/main.');
  }
  const main = git.run(['rev-parse', '--verify', '-q', `${MAIN}^{commit}`]).stdout.trim();
  if (!main) return refuse('this checkout has no origin/main. Run git fetch origin main.');

  const index = resolve(root, indexPath);
  const lock = `${index}.lock`;
  let lockFd;
  try { lockFd = takeLock(lock, ifIdle ? 0 : LOCK_WAIT_MS); } catch (error) {
    return refuse(`${lock} is held by another git command (${error.code}); run this again when it is done.`);
  }
  const temp = `${index}.advance-${process.pid}`;
  let lockOurs = true;
  try {
    const branch = git.run(['symbolic-ref', '-q', 'HEAD']).stdout.trim();
    const head = git.run(['rev-parse', '--verify', '-q', 'HEAD^{commit}']).stdout.trim();
    if (!head) return refuse('this checkout has no commit checked out.');
    if (expectHead && git.run(['rev-parse', '--verify', '-q', `${expectHead}^{commit}`]).stdout.trim() !== head) {
      return refuse(`HEAD is ${head.slice(0, 10)}, not ${expectHead.slice(0, 10)} as expected: someone moved it.`);
    }
    if (head === main) return { ok: true, lines: [...lines, `Already at origin/main ${main.slice(0, 10)}.`] };
    const ancestor = git.run(['merge-base', '--is-ancestor', head, main]);
    if (ancestor.status !== 0) {
      const holder = preservedBy ? preservingBranch(git, preservedBy, head) : null;
      if (!holder) {
        return refuse(`HEAD ${head.slice(0, 10)} is not an ancestor of origin/main ${main.slice(0, 10)}, so moving it would drop commits; land them with scripts/commit-paths.sh first${preservedBy ? `, or name a pushed origin/ branch that holds HEAD (${preservedBy} does not)` : ''}.`);
      }
      lines.push(`HEAD ${head.slice(0, 10)} is not on origin/main; every commit of it is held by ${holder.name} (${holder.commit.slice(0, 10)}), which is left as it is.`);
    }

    const changed = changedEntries(git, head, main);
    const paths = [...changed.keys()];
    const attributes = git.read(['check-attr', '-z', '--stdin', 'filter', 'text', 'eol', 'ident', 'working-tree-encoding'], { input: paths.join('\0') }).split('\0');
    for (let at = 0; at + 2 < attributes.length; at += 3) {
      if (attributes[at + 2] !== 'unspecified' && attributes[at + 2] !== 'unset') {
        return refuse(`${attributes[at]} has ${attributes[at + 1]}=${attributes[at + 2]}, so its disk bytes are not its stored bytes.`);
      }
    }

    const hashBlob = bytes => createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

    copyFileSync(index, temp);
    const staged = new Set(git.read(['diff-index', '--cached', '--no-renames', '--name-only', '-z', head], { index: temp }).split('\0').filter(Boolean));
    const stagedChanged = paths.filter(path => staged.has(path));
    if (ifIdle && stagedChanged.length) {
      return refuse(`${count(stagedChanged.length, 'path')} main changed ${stagedChanged.length === 1 ? 'is' : 'are'} staged here (${stagedChanged.slice(0, 5).join(', ')}${stagedChanged.length > 5 ? ', ...' : ''}), so a session is mid-change; run node scripts/advance-shared-checkout.mjs when it is done.`);
    }

    // Sort every changed path: write main's bytes, already main's, or keep (a local version, staged, or a submodule).
    const write = [], kept = [], dirty = [];
    let already = 0;
    for (const [path, { from, to }] of changed) {
      const disk = diskEntry(root, path, hashBlob, trustMode);
      if (!same(disk, from) && !same(disk, to)) dirty.push({ path, disk });
      if (staged.has(path)) kept.push({ path, why: 'staged (index differs from HEAD)' });
      else if (from?.mode === '160000' || to?.mode === '160000') kept.push({ path, why: 'submodule (not checked out by this step)' });
      else if (same(disk, to)) already += 1;
      else if (same(disk, from)) write.push({ path, from, to });
      else kept.push({ path, why: disk === null ? 'deleted here, changed on main' : from === null ? 'untracked here, and main adds different bytes' : 'local version (differs from HEAD and from main)' });
    }

    // Save every local version (disk differs from HEAD and from main) before any file is written.
    if (dirty.length) {
      const saved = `${index}.advance-saved-${process.pid}`;
      try {
        git.read(['read-tree', head], { index: saved });
        // Files are stored in one `hash-object --stdin-paths`; a symbolic link's target, which that would follow, alone.
        const files = dirty.filter(({ path, disk }) => disk && disk.mode !== 'other' && disk.mode !== '120000' && !path.includes('\n'));
        const stored = git.read(['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: files.map(({ path }) => `${path}\n`).join('') }).split('\n');
        const blobs = new Map(files.map(({ path }, at) => [path, stored[at]]));
        const records = [];
        for (const { path, disk } of dirty) {
          if (disk === null) { records.push(`0 ${'0'.repeat(main.length)}\t${path}`); continue; }
          if (disk.mode === 'other') continue;
          const blob = blobs.get(path) ?? git.read(['hash-object', '-w', '--stdin', '--no-filters'], { input: disk.bytes });
          records.push(`${disk.mode ?? changed.get(path).from?.mode ?? '100644'} ${blob}\t${path}`);
        }
        git.read(['update-index', '-z', '--index-info'], { index: saved, input: records.map(record => `${record}\0`).join('') });
        const tree = git.read(['write-tree'], { index: saved });
        const commit = git.read(['commit-tree', tree, '-p', head, '-m', `Local versions kept by advance-shared-checkout before moving ${head.slice(0, 10)} to ${main.slice(0, 10)}`]);
        const ref = `refs/rescue/advance-${localTime()}-${head.slice(0, 10)}`;
        git.read(['update-ref', ref, commit, '0'.repeat(main.length)]);
        lines.push(`Saved ${count(dirty.length, 'local version')} (disk differs from HEAD and from main) as ${ref} (commit ${commit.slice(0, 10)}); read one with git show ${ref}:<path>.`);
      } finally { rmSync(saved, { force: true }); }
    }

    // Write main's bytes where the disk still holds HEAD's, reading the disk again right before each write.
    const bytes = blobBytes(git, write.map(({ to }) => to?.blob).filter(Boolean));
    const written = [];
    let removed = 0;
    for (const change of write) {
      const { path, from, to } = change;
      if (!same(diskEntry(root, path, hashBlob, trustMode), from)) { kept.push({ path, why: 'changed during the advance' }); continue; }
      try { place(root, path, to, to && bytes.get(to.blob)); } catch (error) {
        kept.push({ path, why: `could not write: ${error.code ?? error.message}` });
        continue;
      }
      written.push(change);
      if (!to) removed += 1;
    }

    const putBack = () => {
      const old = blobBytes(git, written.map(({ from }) => from?.blob).filter(Boolean));
      for (const { path, from, to } of written.reverse()) {
        if (same(diskEntry(root, path, hashBlob, trustMode), to)) place(root, path, from, from && old.get(from.blob));
      }
    };

    // The index: main's entry for every changed path not staged, then fresh stat data.
    const records = [];
    for (const [path, { to }] of changed) {
      if (staged.has(path)) continue;
      records.push(to ? `${to.mode} ${to.blob}\t${path}` : `0 ${'0'.repeat(main.length)}\t${path}`);
    }
    git.read(['update-index', '-z', '--index-info'], { index: temp, input: records.map(record => `${record}\0`).join('') });
    git.run(['update-index', '-q', '--refresh'], { index: temp });

    beforeMove?.();
    const target = branch || 'HEAD';
    const moved = git.run(['update-ref', ...(branch ? [] : ['--no-deref']), '-m', 'advance-shared-checkout: to origin/main', target, main, head]);
    if (moved.status !== 0) {
      putBack();
      return refuse(`moving ${target} from ${head.slice(0, 10)} to ${main.slice(0, 10)} failed (${moved.stderr.trim()}); the ${written.length} files written were put back.`);
    }

    const next = readFileSync(temp);
    writeSync(lockFd, next);
    fsyncSync(lockFd);
    closeSync(lockFd); lockFd = null;
    renameSync(lock, index); lockOurs = false;

    lines.push(`Advanced ${target} from ${head.slice(0, 10)} to origin/main ${main.slice(0, 10)}: ${count(changed.size, 'changed path')}; wrote ${written.length - removed}, removed ${removed}, ${already} already matched main, ${kept.length} kept.`);
    for (const { path, why } of kept) lines.push(`  kept ${path}: ${why}`);
    return { ok: true, lines };
  } finally {
    if (lockFd != null) closeSync(lockFd);
    if (lockOurs) rmSync(lock, { force: true });
    rmSync(temp, { force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(new URL(import.meta.url)))) {
  const args = process.argv.slice(2);
  const option = name => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
  const root = resolve(option('--checkout') ?? fileURLToPath(new URL('..', import.meta.url)));
  process.chdir(root);
  if (args.includes('--if-shared') && !isSharedCheckout()) process.exit(0);
  try {
    const { ok, lines } = advanceCheckout(gitAt(root).read(['rev-parse', '--show-toplevel']), { expectHead: option('--expect-head'), ifIdle: args.includes('--if-idle'), preservedBy: option('--preserved-by') });
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`advance-shared-checkout stopped: ${error.message}\n`);
    process.exitCode = 1;
  }
  // The hooks follow main as well: git runs them from the export of origin/main's tree (scripts/hooks-from-main.mjs), so
  // after the push that moved main they run main's new checks, whether or not the files above could advance.
  try {
    const hooks = hooksFromMain();
    if (hooks) process.stdout.write(`Hooks run from ${hooks}.\n`);
  } catch (error) {
    process.stderr.write(`hooks-from-main: ${error.message} (the hooks still run from the export they ran from before)\n`);
  }
}