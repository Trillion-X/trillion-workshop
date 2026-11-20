#!/usr/bin/env node
// tools/keep-the-shared-checkout-current/do-work/keep-the-shared-checkout-current.mjs
//
// One pass that keeps a shared checkout on origin/main without losing anyone's work. The steps are in the tool's
// README: save the whole working state on a local rescue ref, keep every path someone changed, move HEAD and the
// index to origin/main, write the clean paths from origin, and move the clean paths origin deleted into the repository's git folder.
// Nothing is deleted: a file that cannot be moved stays where it is and is reported.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_ENV, blobsAt, dirtyPaths, git, gitOrNull, gitPathIn, refusingState, workingState } from './git-in-a-declared-folder.mjs';

const RECENT_MS = 120_000;
const STATE_FILE = 'keep-the-shared-checkout-current.json';
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

// The newest rescue ref holds this file with these bytes (an untracked file origin deleted is removed only when the
// rescue of this pass saved it first).
function rescueHolds(root, ref, p, oid) {
  return ref !== null && gitOrNull(root, ['rev-parse', '-q', '--verify', `${ref}:${p}`])?.trim() === oid;
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

// Every blob id each candidate path had in origin/main's history (each commit that changed it, both sides), as
// path -> Set of blob ids. Read once for all candidates, from the history git already holds.
function historyVersions(root, rev, paths) {
  const versions = new Map();
  for (let i = 0; i < paths.length; i += 200) {
    const out = git(root, ['log', '--raw', '--no-abbrev', '--no-renames', '--format=', rev, '--', ...paths.slice(i, i + 200)]);
    for (const line of out.split('\n')) {
      if (!line.startsWith(':')) continue;
      const tab = line.indexOf('\t');
      const [, , oldOid, newOid] = line.slice(0, tab).split(' ');
      const p = line.slice(tab + 1);
      if (!versions.has(p)) versions.set(p, new Set());
      for (const oid of [oldOid, newOid]) if (!/^0+$/.test(oid)) versions.get(p).add(oid);
    }
  }
  return versions;
}

// A removal entry for one file (its absolute path): its size, and the sha256 of its whole bytes as the blob in origin's history holds them.
// disk-guard reads the file back against this proof before it removes anything.
function removalProof(root, path, oid) {
  const data = execFileSync('git', ['-C', root, 'cat-file', 'blob', oid], { env: BASE_ENV, maxBuffer: 1 << 30 });
  return { path, size: data.length, proof: { samples: [{ offset: 0, length: data.length, sha256: createHash('sha256').update(data).digest('hex') }] } };
}

// Adds every readable file to the private index. A file git cannot read (a permission the sandbox refuses) is left out
// and named in `unsaved`; it is never touched, and its path is kept by the classification below. Any other failure stops
// the pass, since a rescue that misses bytes it could have saved is not a rescue.
function addWorkingState(root, env, result) {
  const added = spawnSync('git', ['-C', root, 'add', '-A', '--ignore-errors', '--', '.'], { env: { ...BASE_ENV, ...env }, encoding: 'utf8' });
  if (added.status === 0) return;
  const lines = (added.stderr ?? '').split('\n').filter(Boolean);
  const readFailures = /^error: (open|unable to index file|unable to read)/;
  if (lines.length === 0 || !lines.every((line) => readFailures.test(line) || line === 'fatal: adding files failed')) {
    throw new Error(`git add failed: ${lines.join(' | ')}`);
  }
  result.unsaved = lines.map((line) => line.match(/^error: open\("(.*)"\)/)?.[1]).filter(Boolean);
}

// The whole pass. Refusals and a moved HEAD return before anything in the working tree is written.
export function keepCurrent(root, { now = new Date(), beforeReset = () => {} } = {}) {
  const gitPath = (name) => gitPathIn(root, name);
  const result = { at: stampWords(now), outcome: 'ran', branch: null, head_before: null, head_after: null, origin: null, behind_before: null, behind_after: null, local_commits: [], rescue_ref: null, updated: [], removal_entries: [], unsaved: [], kept: [], skipped: [], why: null };
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
    addWorkingState(root, privateIndex, result);
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
  const versions = historyVersions(root, origin, candidates);
  const plan = { update: [], removal: [], keep: [], skip: [], marker: {} };
  for (const p of candidates) {
    const headOid = headBlobs.get(p) ?? null;
    const originOid = originBlobs.get(p) ?? null;
    const { oid: work, recent } = disk.get(p);
    if (work === originOid) continue;
    // Clean: the bytes are HEAD's, a skipped pass's, or an older version of this path that origin's history holds (a stale
    // copy left by a reset). Someone's edit is none of these.
    const known = work !== null && (versions.get(p)?.has(work) === true || work === headOid);
    const clean = work === headOid || (work !== null && marker[p] === work) || (headOid !== null && known);
    if (clean && recent) {
      plan.skip.push({ path: p, why: 'edited in the last 120 s; left for the next pass' });
      if (work !== null) plan.marker[p] = work;
    } else if (clean && originOid !== null) {
      plan.update.push({ path: p, was: work });
    } else if (originOid === null && work !== null && versions.get(p)?.has(work) === true && (clean || rescueHolds(root, result.rescue_ref, p, work))) {
      plan.removal.push({ path: p, was: work });
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

  // Step 5: a clean file origin deleted is not removed here: the pass names it with its removal proof, and disk-guard's
  // removal list removes it after reading the proof back. Nothing is moved or deleted by this pass.
  for (const r of plan.removal) {
    const now2 = workingState(root, [r.path], new Date()).get(r.path).oid;
    if (now2 !== r.was) {
      result.kept.push({ path: r.path, why: 'changed while the pass was running' });
      continue;
    }
    result.removal_entries.push(removalProof(root, join(root, r.path), r.was));
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
