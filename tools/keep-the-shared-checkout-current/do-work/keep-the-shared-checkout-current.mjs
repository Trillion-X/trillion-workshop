#!/usr/bin/env node
// tools/keep-the-shared-checkout-current/do-work/keep-the-shared-checkout-current.mjs
//
// One pass that keeps a shared checkout on origin/main without losing anyone's work. The steps are in the tool's
// README: save the whole working state on a local rescue ref, keep every path someone changed, move HEAD and the
// index to origin/main, write the clean paths from origin, and move the clean paths origin deleted into the repository's git folder.
// Nothing is deleted: a file that cannot be moved stays where it is and is reported.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blobsAt, dirtyPaths, git, gitOrNull, gitPathIn, refusingState, workingState } from './git-in-a-declared-folder.mjs';

const RECENT_MS = 120_000;
const STATE_FILE = 'keep-the-shared-checkout-current.json';
const TRASH_DIR = 'keep-the-shared-checkout-current-trash';
const INDEX_FILE = 'keep-the-shared-checkout-current.index';
const RESCUE_PREFIX = 'refs/rescue/workshop-shared-';
const GIT_AUTHOR = { GIT_AUTHOR_NAME: 'keep-the-shared-checkout-current', GIT_AUTHOR_EMAIL: 'keep-current@localhost', GIT_COMMITTER_NAME: 'keep-the-shared-checkout-current', GIT_COMMITTER_EMAIL: 'keep-current@localhost' };

// Inherited GIT_* variables (an index or a repository a shell exported) would point git at the wrong files.
const pad = (n) => String(n).padStart(2, '0');
const stampFile = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const stampWords = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

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

// Rescue refs, newest first.
// The names carry the pass time, so the newest is the largest name (commit dates tie within a second).
function rescueRefs(root) {
  return git(root, ['for-each-ref', '--sort=-refname', '--format=%(refname)', 'refs/rescue/']).split('\n').filter((ref) => ref.startsWith(RESCUE_PREFIX));
}

// A second pass in the same second gets the next free name (-2, -3 ...), so no pass refuses for a name.
function uniqueRef(root, base) {
  let ref = base;
  for (let n = 2; gitOrNull(root, ['rev-parse', '--verify', '-q', ref]) !== null; n += 1) ref = `${base}-${n}`;
  return ref;
}

// A rescue ref goes only when its commit is origin's own tip plus itself (no commit of its own that origin lacks), and
// every file it holds is already on origin or in a newer rescue ref that is kept. The newest ref is never removed.
// Removing a ref moves no bytes: git keeps the objects until a gc, and nothing here runs one.
function pruneRescueRefs(root, origin) {
  const refs = rescueRefs(root);
  if (refs.length === 0) return;
  const known = new Set(blobsAt(root, origin).values());
  refs.forEach((ref, index) => {
    const blobs = [...new Set(blobsAt(root, ref).values())];
    if (index === 0) {
      blobs.forEach((oid) => known.add(oid));
      return;
    }
    const ownCommits = git(root, ['rev-list', ref, '--not', origin]).split('\n').filter(Boolean);
    const removable = ownCommits.length === 1 && blobs.every((oid) => known.has(oid));
    if (removable) git(root, ['update-ref', '-d', ref]);
    else blobs.forEach((oid) => known.add(oid));
  });
}

// The bytes each path had at the HEADs of the last RECENT_HEADS reflog entries, as path -> Set of blob ids. A file origin
// deleted that still holds one of them was clean when origin deleted it, so it may go to the trash.
const RECENT_HEADS = 20;
function recentHeadBlobs(root) {
  const byPath = new Map();
  const heads = [...new Set(git(root, ['reflog', '-n', String(RECENT_HEADS), '--format=%H', 'HEAD']).split('\n').filter(Boolean))];
  for (const head of heads) {
    for (const [p, oid] of blobsAt(root, head)) {
      if (!byPath.has(p)) byPath.set(p, new Set());
      byPath.get(p).add(oid);
    }
  }
  return byPath;
}

// The whole pass. Refusals and a moved HEAD return before anything in the working tree is written.
export function keepCurrent(root, { trashRoot = gitPathIn(root, TRASH_DIR), now = new Date(), beforeReset = () => {} } = {}) {
  const gitPath = (name) => gitPathIn(root, name);
  const result = { at: stampWords(now), outcome: 'ran', branch: null, head_before: null, head_after: null, origin: null, behind_before: null, behind_after: null, local_commits: [], rescue_ref: null, updated: [], trashed: [], kept: [], skipped: [], why: null };
  const refuse = (why, outcome = 'refused') => ({ ...result, outcome, why });
  const refusal = refusingState(root);
  if (refusal) return refuse(refusal);
  const branch = gitOrNull(root, ['symbolic-ref', '-q', '--short', 'HEAD'])?.trim();
  if (branch !== 'main') return refuse(`HEAD is not on branch main (${branch ?? 'no branch or not a git checkout'})`);
  result.branch = branch;
  if (gitOrNull(root, ['fetch', '-q', 'origin']) === null) return refuse('git fetch origin failed');

  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const origin = git(root, ['rev-parse', 'origin/main']).trim();
  result.head_before = head;
  result.origin = origin;
  result.behind_before = Number(git(root, ['rev-list', '--count', 'HEAD..origin/main']).trim());
  result.local_commits = git(root, ['rev-list', 'origin/main..HEAD']).split('\n').filter(Boolean);

  // Step 1: the whole working state, as a local ref, only when it differs from the newest rescue ref. Working bytes win
  // over the real index. Rescue refs that hold nothing the others and origin lack are removed; the newest is always kept.
  const dirty = dirtyPaths(root);
  const privateIndex = { GIT_INDEX_FILE: gitPath(INDEX_FILE) };
  if (dirty.length || result.local_commits.length) {
    copyFileSync(gitPath('index'), privateIndex.GIT_INDEX_FILE);
    git(root, ['add', '-A', '--', '.'], { env: privateIndex });
    const tree = git(root, ['write-tree'], { env: privateIndex }).trim();
    if (tree !== git(root, ['rev-parse', `${head}^{tree}`]).trim() || result.local_commits.length) {
      const newest = rescueRefs(root)[0] ?? null;
      if (newest !== null && git(root, ['rev-parse', `${newest}^{tree}`]).trim() === tree && gitOrNull(root, ['merge-base', '--is-ancestor', head, newest]) !== null) {
        result.rescue_ref = newest;
      } else {
        const ref = uniqueRef(root, `${RESCUE_PREFIX}${stampFile(now)}`);
        const message = `Rescue of the shared checkout at ${result.at}: its uncommitted and untracked files, and any commits not on origin/main. Local only.`;
        const commit = git(root, ['commit-tree', tree, '-p', head, '-m', message], { env: GIT_AUTHOR }).trim();
        git(root, ['update-ref', ref, commit]);
        result.rescue_ref = ref;
      }
    }
  }
  pruneRescueRefs(root, origin);

  // Step 2: classify every path that differs between HEAD, origin, the disk, or a skipped path from the last pass.
  const headBlobs = blobsAt(root, head);
  const originBlobs = blobsAt(root, origin);
  const stateFile = gitPath(STATE_FILE);
  const marker = readMarker(stateFile);
  const incoming = git(root, ['diff', '--name-only', '--no-renames', '-z', head, origin]).split('\0').filter(Boolean);
  const candidates = [...new Set([...incoming, ...dirty, ...Object.keys(marker)])].sort();
  const disk = workingState(root, candidates, now);
  const recentBlobs = recentHeadBlobs(root);
  const plan = { update: [], trash: [], keep: [], skip: [], marker: {} };
  for (const p of candidates) {
    const headOid = headBlobs.get(p) ?? null;
    const originOid = originBlobs.get(p) ?? null;
    const { oid: work, recent } = disk.get(p);
    if (work === originOid) continue;
    const clean = work === headOid || (work !== null && marker[p] === work) || (work !== null && originOid === null && recentBlobs.get(p)?.has(work) === true);
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

  // Step 5: a clean path origin deleted moves into the trash folder in the git folder, never deleted.
  const trashDir = join(trashRoot, stampFile(now));
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
      result.kept.push({ path: t.path, why: `origin deleted it and it could not be moved to the trash folder: ${error.message}` });
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
