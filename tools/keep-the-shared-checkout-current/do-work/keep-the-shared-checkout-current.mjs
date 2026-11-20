#!/usr/bin/env node
// tools/keep-the-shared-checkout-current/do-work/keep-the-shared-checkout-current.mjs
//
// One pass that keeps a shared checkout on origin/main without losing anyone's work. The steps are in the tool's
// README: save the whole working state on a local rescue ref, keep every path someone changed, move HEAD and the
// index to origin/main, write the clean paths from origin, and move the clean paths origin deleted to the Trash.
// Nothing is deleted: a file that cannot be moved stays where it is and is reported.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECENT_MS = 120_000;
const STATE_FILE = 'keep-the-shared-checkout-current.json';
const INDEX_FILE = 'keep-the-shared-checkout-current.index';
const RESCUE_PREFIX = 'refs/rescue/workshop-shared-';
const REFUSING_STATE = ['MERGE_HEAD', 'REVERT_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply'];
const GIT_AUTHOR = { GIT_AUTHOR_NAME: 'keep-the-shared-checkout-current', GIT_AUTHOR_EMAIL: 'keep-current@localhost', GIT_COMMITTER_NAME: 'keep-the-shared-checkout-current', GIT_COMMITTER_EMAIL: 'keep-current@localhost' };

// Inherited GIT_* variables (an index or a repository a shell exported) would point git at the wrong files.
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') || key.includes('SSH')));

function git(root, args, { env = {}, input } = {}) {
  return execFileSync('git', ['-C', root, ...args], { env: { ...BASE_ENV, ...env }, input, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] });
}

// Returns null instead of throwing: a missing ref, a detached HEAD or a failed command is an answer here.
function gitOrNull(root, args, options) {
  try {
    return git(root, args, options);
  } catch {
    return null;
  }
}

const pad = (n) => String(n).padStart(2, '0');
const stampFile = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const stampWords = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// path -> blob id of every file in a commit (directories and submodules are not files here).
function blobsAt(root, rev) {
  const blobs = new Map();
  for (const entry of git(root, ['ls-tree', '-r', '-z', rev]).split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [, type, oid] = entry.slice(0, tab).split(' ');
    if (type === 'blob') blobs.set(entry.slice(tab + 1), oid);
  }
  return blobs;
}

// Blob ids of the bytes on disk, hashed as they are (no clean filters). A symlink is hashed as its target text.
function workingState(root, paths, now) {
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
      state.set(p, { oid: git(root, ['hash-object', '--no-filters', '--stdin'], { input: readlinkSync(full) }).trim(), recent });
    } else {
      state.set(p, { oid: 'not-a-file', recent });
    }
  }
  if (regular.length) {
    const oids = git(root, ['hash-object', '--no-filters', '--stdin-paths'], { input: `${regular.join('\n')}\n` }).trim().split('\n');
    regular.forEach((p, i) => state.set(p, { oid: oids[i], recent: state.get(p).recent }));
  }
  return state;
}

function dirtyPaths(root) {
  const out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  return out.split('\0').filter(Boolean).map((entry) => entry.slice(3));
}

function reasonToKeep({ head, origin, work, clash }) {
  const parts = [];
  if (head === null) parts.push('untracked here');
  else if (work === null) parts.push('deleted here');
  else if (origin === null) parts.push('changed here; origin deleted it');
  else if (head !== origin) parts.push('changed here; origin changed it too');
  else parts.push('changed here');
  if (clash) parts.push("origin adds this path too: its version is not written over this file");
  return parts.join('; ');
}

function uniqueDestination(path) {
  let candidate = path;
  for (let n = 1; existsSync(candidate); n += 1) candidate = `${path}.${n}`;
  return candidate;
}

function readMarker(stateFile) {
  if (!existsSync(stateFile)) return {};
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8')).skipped ?? {};
  } catch {
    return {};
  }
}

// The whole pass. Refusals and a moved HEAD return before anything in the working tree is written.
export function keepCurrent(root, { trashRoot = join(homedir(), '.Trash'), now = new Date(), beforeReset = () => {} } = {}) {
  const gitPath = (name) => resolve(root, git(root, ['rev-parse', '--git-path', name]).trim());
  const result = { at: stampWords(now), outcome: 'ran', branch: null, head_before: null, head_after: null, origin: null, behind_before: null, behind_after: null, local_commits: [], rescue_ref: null, updated: [], trashed: [], kept: [], skipped: [], why: null };
  const refuse = (why, outcome = 'refused') => ({ ...result, outcome, why });

  const branch = gitOrNull(root, ['symbolic-ref', '-q', '--short', 'HEAD'])?.trim();
  if (branch !== 'main') return refuse(`HEAD is not on branch main (${branch ?? 'no branch or not a git checkout'})`);
  result.branch = branch;
  const lock = REFUSING_STATE.find((name) => existsSync(gitPath(name)));
  if (existsSync(gitPath('index.lock'))) return refuse('.git/index.lock exists: a git command is running in this checkout');
  if (lock) return refuse(`${lock} exists: a merge, rebase, cherry-pick or revert is in progress`);
  if (gitOrNull(root, ['fetch', '-q', 'origin']) === null) return refuse('git fetch origin failed');

  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const origin = git(root, ['rev-parse', 'origin/main']).trim();
  result.head_before = head;
  result.origin = origin;
  result.behind_before = Number(git(root, ['rev-list', '--count', 'HEAD..origin/main']).trim());
  result.local_commits = git(root, ['rev-list', 'origin/main..HEAD']).split('\n').filter(Boolean);

  // Step 1: the whole working state, as a local ref only. Working bytes win over the real index.
  const dirty = dirtyPaths(root);
  const privateIndex = { GIT_INDEX_FILE: gitPath(INDEX_FILE) };
  if (dirty.length || result.local_commits.length) {
    const ref = `${RESCUE_PREFIX}${stampFile(now)}`;
    if (gitOrNull(root, ['rev-parse', '--verify', '-q', ref]) !== null) return refuse(`${ref} already exists; a second pass in the same second is refused`);
    copyFileSync(gitPath('index'), privateIndex.GIT_INDEX_FILE);
    git(root, ['add', '-A', '--', '.'], { env: privateIndex });
    const tree = git(root, ['write-tree'], { env: privateIndex }).trim();
    if (tree !== git(root, ['rev-parse', `${head}^{tree}`]).trim() || result.local_commits.length) {
      const message = `Rescue of the shared checkout at ${result.at}: its uncommitted and untracked files, and any commits not on origin/main. Local only.`;
      const commit = git(root, ['commit-tree', tree, '-p', head, '-m', message], { env: GIT_AUTHOR }).trim();
      git(root, ['update-ref', ref, commit]);
      result.rescue_ref = ref;
    }
  }

  // Step 2: classify every path that differs between HEAD, origin, the disk, or a skipped path from the last pass.
  const headBlobs = blobsAt(root, head);
  const originBlobs = blobsAt(root, origin);
  const stateFile = gitPath(STATE_FILE);
  const marker = readMarker(stateFile);
  const incoming = git(root, ['diff', '--name-only', '--no-renames', '-z', head, origin]).split('\0').filter(Boolean);
  const candidates = [...new Set([...incoming, ...dirty, ...Object.keys(marker)])].sort();
  const disk = workingState(root, candidates, now);
  const plan = { update: [], trash: [], keep: [], skip: [], marker: {} };
  for (const p of candidates) {
    const headOid = headBlobs.get(p) ?? null;
    const originOid = originBlobs.get(p) ?? null;
    const { oid: work, recent } = disk.get(p);
    if (work === originOid) continue;
    const clean = work === headOid || (work !== null && marker[p] === work);
    if (clean && recent) {
      plan.skip.push({ path: p, why: 'edited in the last 120 s; left for the next pass' });
      if (work !== null) plan.marker[p] = work;
    } else if (clean && originOid !== null) {
      plan.update.push({ path: p, was: work });
    } else if (clean) {
      plan.trash.push({ path: p, was: work });
    } else {
      const clash = headOid === null && originOid !== null;
      plan.keep.push({ path: p, why: `${reasonToKeep({ head: headOid, origin: originOid, work, clash })}${recent ? ' (edited in the last 120 s)' : ''}` });
    }
  }
  result.kept.push(...plan.keep.map(({ path, why }) => ({ path, why })));
  result.skipped.push(...plan.skip);

  // Step 3: HEAD and the index move to origin/main; the working tree is not touched by this step.
  beforeReset();
  if (git(root, ['rev-parse', 'HEAD']).trim() !== head) return refuse('HEAD moved during the pass; nothing was reset, the next pass retries', 'stopped');
  git(root, ['reset', '-q', '--mixed', 'origin/main']);

  // Step 4: a clean path takes origin's bytes, if it still holds the bytes classified above.
  for (const u of plan.update) {
    const now2 = workingState(root, [u.path], new Date()).get(u.path).oid;
    if (now2 !== u.was) {
      result.kept.push({ path: u.path, why: 'changed while the pass was running' });
      continue;
    }
    git(root, ['checkout', 'origin/main', '--', u.path]);
    result.updated.push(u.path);
  }

  // Step 5: a clean path origin deleted moves to the Trash, never deleted.
  const trashDir = join(trashRoot, `keep-the-shared-checkout-current-${stampFile(now)}`);
  for (const t of plan.trash) {
    const now2 = workingState(root, [t.path], new Date()).get(t.path).oid;
    if (now2 !== t.was) {
      result.kept.push({ path: t.path, why: 'changed while the pass was running' });
      continue;
    }
    try {
      const destination = uniqueDestination(join(trashDir, t.path));
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(join(root, t.path), destination);
      result.trashed.push({ path: t.path, to: destination });
    } catch (error) {
      result.kept.push({ path: t.path, why: `origin deleted it and it could not be moved to the Trash: ${error.message}` });
    }
  }

  writeFileSync(stateFile, `${JSON.stringify({ at: result.at, skipped: plan.marker }, null, 2)}\n`);
  result.head_after = git(root, ['rev-parse', 'HEAD']).trim();
  result.behind_after = Number(git(root, ['rev-list', '--count', 'HEAD..origin/main']).trim());
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex === -1 ? null : process.argv[rootIndex + 1];
  try {
    if (!root) throw new Error('--root <checkout folder> is required');
    process.stdout.write(`${JSON.stringify(keepCurrent(root))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ outcome: 'error', why: error.message })}\n`);
    process.exitCode = 1;
  }
}
