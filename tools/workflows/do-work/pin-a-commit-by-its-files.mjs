// tools/workflows/do-work/pin-a-commit-by-its-files.mjs
//
// Purpose: The pin an engine installs a commit of a repository by: the BLAKE3 identity of the commit's files, computed here
// from the publisher's own checkout, never from the host that serves the archive. An engine's tools:update takes
// {commit, manifest_blake3} (and a launcher entry `first_start_manifest`); it reads the host's archive, records every file's
// path and BLAKE3, and installs the copy only when the identity of that record is this pin. So the host cannot hand over
// other files under the commit, and a host that compresses the same files differently still matches (the files are pinned,
// not the archive's bytes, as Nix pins an unpacked tree).
//
//   node tools/workflows/do-work/pin-a-commit-by-its-files.mjs REPOSITORY COMMIT
//     prints {"commit", "manifest_blake3", "files"}: the input of tools:update for that commit
//
// The identity is the engine's own (the engine's src/tool_runs/tools/install.rs `manifest_identity`): BLAKE3 of the JSON text
// of {path: BLAKE3 hex of the file's bytes} for every regular file of the archive, keys in byte order, no spaces. The files
// are what `git archive` of the commit holds, the same command a host such as codeload runs, so attributes like
// export-ignore are honoured the same way; links are left out, as the engine's unpack leaves them out.
//
// Non-Negotiable Invariants:
// - Only a full commit identity is pinned (a branch or a short name moves; a pin must not).
// - Nothing is written: the archive is read from git's output in memory.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import { execFileSync } from 'node:child_process';
import { blake3 } from '@noble/hashes/blake3.js';

const hex = bytes => Buffer.from(bytes).toString('hex');

/** The regular files of a tar archive (ustar, with pax `x` and GNU `L` long names), as [path, bytes]. */
export function tarFiles(archive) {
  const files = [];
  let longName = null;
  for (let at = 0; at + 512 <= archive.length;) {
    const header = archive.subarray(at, at + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (from, length) => header.subarray(from, from + length).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(text(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = archive.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'L') {
      const named = type === 'L' ? body.toString('utf8').replace(/\0.*$/s, '')
        : body.toString('utf8').split('\n').map(line => line.match(/^\d+ path=(.*)$/s)?.[1]).find(Boolean);
      longName = named ?? longName;
      continue;
    }
    if (type === 'g') continue;
    const prefix = text(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
    longName = null;
    if (type === '0') files.push([name, Buffer.from(body)]);
  }
  return files;
}

/** The engine's manifest identity of `files`: BLAKE3 of {path: BLAKE3 hex} as JSON text, keys in byte order. */
export function manifestIdentity(files) {
  const entries = files.map(([path, bytes]) => [path, hex(blake3(bytes))]);
  entries.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const text = `{${entries.map(([path, digest]) => `${JSON.stringify(path)}:${JSON.stringify(digest)}`).join(',')}}`;
  return hex(blake3(Buffer.from(text, 'utf8')));
}

/** The pin of `commit` in `repository`: what tools:update takes. */
export function pinOf(repository, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Give the full commit identity (40 hex): a branch or a short name moves.');
  const archive = execFileSync('git', ['-C', repository, 'archive', '--format=tar', commit], { maxBuffer: 1 << 30 });
  const files = tarFiles(archive);
  return { commit, manifest_blake3: manifestIdentity(files), files: files.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [repository, commit] = process.argv.slice(2);
  if (!repository || !commit) { console.error('Give the repository folder and the full commit: node pin-a-commit-by-its-files.mjs REPOSITORY COMMIT'); process.exit(2); }
  process.stdout.write(`${JSON.stringify(pinOf(repository, commit))}\n`);
}
