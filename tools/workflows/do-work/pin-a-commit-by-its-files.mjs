// tools/workflows/do-work/pin-a-commit-by-its-files.mjs
//
// Purpose: The pin an engine installs a commit of a repository by: the BLAKE3 identity of the commit's files, computed here
// from the publisher's own checkout, never from the host that serves the archive. An engine's tools:update takes
// {address, files_blake3} (a launcher's `tool_sources` entry names the same two beside its `label`): the https address of an
// archive of the commit and this pin. The engine reads the archive at that address, records every file's path and BLAKE3, and
// installs the copy only when the identity of that record is this pin. So the host cannot hand over other files, the address
// may be any host's, and a host that compresses the same files differently still matches (the files are pinned, not the
// archive's bytes, as Nix pins an unpacked tree and Go's go.sum h1: pins a module's files).
//
//   node tools/workflows/do-work/pin-a-commit-by-its-files.mjs REPOSITORY COMMIT ADDRESS
//     ADDRESS is the https address of the commit's archive, where `{commit}` stands for the commit
//     prints {"address", "files_blake3", "files"}: the input of tools:update for that commit, and `files`, how many it holds
//
// The identity is the engine's own (the engine's src/tool_runs/tools/install.rs `manifest_identity`): BLAKE3 of the JSON text
// of {path: BLAKE3 hex of the file's bytes} for every regular file of the archive, keys in byte order, no spaces. The files
// are what `git archive` of the commit holds, the same command a host such as codeload runs, so attributes like
// export-ignore are honoured the same way; links are left out, as the engine's unpack leaves them out.
//
// Non-Negotiable Invariants:
// - Only a full commit identity is pinned (a branch or a short name moves; a pin must not), at an https address.
// - A commit whose package-files.json would stop runs is never pinned (layoutProblems): every file a row is laid out with
//   must be in the commit, and no row may place one package folder twice. The engine refuses a whole run for either
//   (trillion-rust container.rs: a missing file, or a file already at its place), and a pin is what every kept-running wake
//   restarts with, so a bad pin stopped every workflow on Nov 19 2026 at 4:30 PM CST and the four noticers at 5:27 PM.
// - Nothing is written: the archive is read from git's output in memory.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import { execFileSync } from 'node:child_process';
import { blake3 } from '@noble/hashes/blake3.js';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

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

const LAYOUT_FILE = 'package-files.json';

/** What in the commit's package-files.json would stop a run, as readable lines (none when it has no such file): a laid-out
 *  path of a package item that is neither a file of the commit nor a folder holding one, and a package folder (`at` of a
 *  `packages` item) one row places twice. The same rules as test/package-files.test.mjs, judged on the commit's own files. */
export function layoutProblems(files) {
  const layout = files.find(([path]) => path === LAYOUT_FILE);
  if (!layout) return [];
  const paths = new Set(files.map(([path]) => path));
  const folders = new Set();
  for (const path of paths) for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) folders.add(path.slice(0, cut));
  const problems = [];
  for (const [row, items] of Object.entries(JSON.parse(layout[1].toString('utf8')))) {
    for (const item of items) {
      if (item.package) for (const path of item.paths ?? []) {
        const full = `tools/${item.package}/${path}`.replace(/\/+$/, '');
        if (!paths.has(full) && !folders.has(full)) problems.push(`${row} is laid out with ${full}, which this commit does not hold`);
      }
    }
    const ats = items.filter(item => item.packages).map(item => item.at);
    for (const at of new Set(ats.filter((at, index) => ats.indexOf(at) !== index))) problems.push(`${row} places the package folder ${at} twice`);
  }
  return problems;
}

/** The pin of `commit` in `repository`, served at `address` (`{commit}` stands for the commit): what tools:update takes. */
export function pinOf(repository, commit, address) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Give the full commit identity (40 hex): a branch or a short name moves.');
  const at = String(address ?? '').replaceAll('{commit}', commit);
  if (!/^https:\/\/[^/\s]+\/\S*$/.test(at)) throw new Error('Give the https address of the commit\'s archive, with {commit} where the commit goes.');
  const archive = execFileSync('git', ['-C', repository, 'archive', '--format=tar', commit], { maxBuffer: 1 << 30 });
  const files = tarFiles(archive);
  const problems = layoutProblems(files);
  if (problems.length) throw Object.assign(new Error(`Not pinned: ${commit} would stop runs, because the engine refuses a run whose layout names a missing file or places one package twice.\n${problems.join('\n')}`), { problems });
  return { address: at, files_blake3: manifestIdentity(files), files: files.length };
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  const [repository, commit, address] = process.argv.slice(2);
  if (!repository || !commit || !address) { console.error('Give the repository folder, the full commit and the archive address: node pin-a-commit-by-its-files.mjs REPOSITORY COMMIT ADDRESS'); process.exit(2); }
  process.stdout.write(`${JSON.stringify(pinOf(repository, commit, address))}\n`);
}
