// scripts/workspace-source-record.mjs
//
// What the web client was built from, written beside it (built/workspace.source.json), and the refusal that keeps a client built
// from uncommitted bytes out of the Mac app. The installed client (Resources/local-workspace) was built from a working folder that
// many sessions were editing at once; no commit holds those bytes, so the app could not be rebuilt, audited or rolled back to
// what a person is running (2026-10-30). The build lists every input it read (workspace.inputs.json); this file says, for the
// commit the build names, which of them the commit does not hold byte for byte.
//
// Non-negotiable invariants
//   1. The record is made by the build from the bytes it read, never by the caller: an input is "held" only when the named
//      commit's blob has the same BLAKE3 as the file on disk.
//   2. Dependencies (node_modules/) are not source: the lockfile pins them and the app carries them separately.
//   3. The app carries a client only when its record names a full commit and lists no differing input. No flag skips this.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const SOURCE_RECORD_FILE = 'workspace.source.json';
const VERSION = 'workspace-source/v1';
const COMMIT = /^[0-9a-f]{40}$/;
const SHOWN = 5;

/** The blobs of `commit:path` for each path, in order, from one `git cat-file --batch`; null where the commit has none. */
function blobsAt(repo, commit, paths) {
  const out = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], { input: paths.map(path => `${commit}:${path}\n`).join(''), maxBuffer: 1 << 30 });
  const blobs = [];
  let at = 0;
  for (let index = 0; index < paths.length; index++) {
    const end = out.indexOf(10, at);
    const header = out.toString('utf8', at, end).split(' ');
    if (header[1] === 'blob') {
      const size = Number(header[2]);
      blobs.push(out.subarray(end + 1, end + 1 + size));
      at = end + 1 + size + 1;
    } else { blobs.push(null); at = end + 1; }
  }
  return blobs;
}

/** The commit a build names: `WORKSPACE_SOURCE_COMMIT`, else the HEAD of the checkout it runs in, else none (an export
 *  has no .git, and a repository made with no commit, such as visual-check's Linux copy, has no HEAD). */
export function buildCommit(root, env = process.env) {
  if (env.WORKSPACE_SOURCE_COMMIT) return env.WORKSPACE_SOURCE_COMMIT;
  if (!existsSync(join(root, '.git'))) return null;
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (error) {
    // rev-parse --verify --quiet exits 1, saying nothing, only when HEAD names no commit; anything else is a real failure.
    if (error.status === 1 && !String(error.stdout ?? '').trim()) return null;
    throw error;
  }
}

/** The record for a build in `root` that read `inputs` (paths relative to `root`), judged against `commit` in `repo`.
 *  `prefix` is the folder `root` is inside the repository ('' when the build runs at its top, 'web/' for a client kept
 *  in web/), so each input is asked of the commit at its repository path and named by it when it differs. */
export function sourceRecord({ root, inputs, commit, repo, prefix = '' }) {
  if (!COMMIT.test(commit ?? '')) return { version: VERSION, commit: null, differing: null };
  if (prefix && (!/^([A-Za-z0-9._-]+\/)+$/.test(prefix) || prefix.split('/').some(part => part === '.' || part === '..'))) throw new Error(`The build folder inside the repository must be folder names ending in /, not ${JSON.stringify(prefix)}.`);
  const paths = inputs.filter(path => !path.startsWith('node_modules/') && !path.includes('/node_modules/')).sort();
  const blobs = blobsAt(repo, commit, paths.map(path => `${prefix}${path}`));
  const differing = paths.filter((path, index) => {
    const held = blobs[index];
    if (!held || !existsSync(join(root, path))) return true;
    return bytesToHex(blake3(held)) !== bytesToHex(blake3(readFileSync(join(root, path))));
  }).map(path => `${prefix}${path}`);
  return { version: VERSION, commit, differing };
}

/** Throws unless the built client in `built` says it was built from a commit that holds every input byte for byte. */
export function refuseUnrecordedSource(built) {
  const file = join(built, SOURCE_RECORD_FILE);
  const how = 'Build it from a clean commit: WORKSPACE_SOURCE_COMMIT=<commit> WORKSPACE_SOURCE_REPO=<repository> node scripts/build-workspace.mjs.';
  if (!existsSync(file)) throw new Error(`The web client has no ${SOURCE_RECORD_FILE}, so what it was built from is unknown. ${how}`);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (record.version !== VERSION || !COMMIT.test(record.commit ?? '') || !Array.isArray(record.differing)) {
    throw new Error(`The web client was built from no commit (${SOURCE_RECORD_FILE}). ${how}`);
  }
  if (record.differing.length) {
    const shown = record.differing.slice(0, SHOWN).join(', ');
    throw new Error(`The web client was built from ${record.differing.length} input${record.differing.length === 1 ? '' : 's'} that commit ${record.commit.slice(0, 10)} does not hold (${shown}${record.differing.length > SHOWN ? ', ...' : ''}). ${how}`);
  }
  return record;
}
