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

// Where one entry of a row lands, as keys: a packages entry lays each named package at its folder (a trailing slash dropped, a
// node_modules/ prefix dropped, so split2 and node_modules/split2 at one folder are one landing); a paths entry lays each path at
// its place under `at`. The engine refuses a run when a file is already where an entry puts it (trillion-rust container.rs
// copy_file), so a key laid twice by one row is refused.
const folderOf = at => {
  const plain = String(at).replace(/\/+$/, '');
  return plain.startsWith('/opt/node_modules/') ? `/opt/${plain.slice('/opt/node_modules/'.length)}` : plain;
};
const landingsOf = item => item.packages
  ? item.packages.map(key => ({ key: `package ${folderOf(item.at)} ${String(key).replace(/^node_modules\//, '')}`, at: item.at }))
  : (item.paths ?? []).map(path => {
    // `.` (or an empty path) lays the folder itself, at `at`.
    const rel = String(path).replace(/\/+$/, '').replace(/^\.$/, '');
    return { key: `path ${folderOf(rel ? `${String(item.at).replace(/\/+$/, '')}/${rel}` : item.at)}`, at: item.at, path };
  });

/** The landings one row makes more than once, from a package-files.json object ({row id: items}): each as {row, key, at, path}, where
 *  `at` is the repeated entry's own folder and `path` its path when it lays a path. Two entries that land on one place are one
 *  duplicate, whichever spelling each uses, and a path laid inside a folder the same row lays as a path is one too (`inside`
 *  names that folder). A package folder and a path at one folder stay two landings. */
export function duplicateLayouts(rows) {
  const duplicates = [];
  for (const [row, items] of Object.entries(rows)) {
    const seen = new Set();
    // The places this row lays a path at: a path laid inside one of them is laid twice too, once by the folder laid whole
    // (17dedb039 laid Workshop folders whole beside hand-declared files inside them, and every workflow run on the Mac failed
    // from about 6:55 to 7:17 PM CST Nov 19 2026, Failure::Unavailable at the second copy).
    const pathPlaces = new Set();
    for (const item of items) for (const landing of landingsOf(item)) if (landing.path !== undefined) pathPlaces.add(landing.key.slice('path '.length));
    for (const item of items) for (const landing of landingsOf(item)) {
      if (seen.has(landing.key)) duplicates.push({ row, key: landing.key, at: landing.at, ...(landing.path === undefined ? {} : { path: landing.path }) });
      seen.add(landing.key);
      if (landing.path === undefined) continue;
      const place = landing.key.slice('path '.length);
      for (let cut = place.lastIndexOf('/'); cut > 0; cut = place.lastIndexOf('/', cut - 1)) {
        const folder = place.slice(0, cut);
        if (pathPlaces.has(folder)) { duplicates.push({ row, key: landing.key, at: landing.at, path: landing.path, inside: folder }); break; }
      }
    }
  }
  return duplicates;
}

/** The container tool rows of the commit, read from every top-level record of each tools/<tool>/tool-rows.json, each as {id,
 *  packageFiles, packages}: the items of invoke.files.package_files, and the package names of invoke.packages (a list, or the keys
 *  of an object). A row that cannot be read is skipped here, as the tool's own loader reports it. */
export function containerRows(files) {
  const rows = [];
  for (const [path, bytes] of files) {
    if (!/^tools\/[^/]+\/tool-rows\.json$/.test(path)) continue;
    let records;
    try { records = JSON.parse(bytes.toString('utf8')).records ?? []; } catch { continue; }
    for (const { payload } of records) {
      if (payload?.kind !== 'ai-tool-descriptor' || payload.invoke?.kind !== 'container') continue;
      const { invoke } = payload;
      const packages = Array.isArray(invoke.packages) ? invoke.packages : Object.keys(invoke.packages ?? {});
      // A package_files written as one object, not a list, is one item.
      const packageFiles = [invoke.files?.package_files ?? []].flat();
      rows.push({ id: payload.id, packageFiles, packages });
    }
  }
  return rows;
}

/** A package name as package_files lays it: a node_modules/ prefix is dropped, as folderOf drops it from a folder. */
const plainPackage = name => String(name).replace(/^node_modules\//, '');

/** What in the commit's package-files.json would stop a run, as readable lines: a container tool row that names package files and
 *  has no key of its own in package-files.json (the Mac then fails its run with Cannot find module), a container row whose
 *  invoke.packages names a package that no package_files item of its own lays (the run dies with Cannot find package), a laid-out
 *  path of a package item that is neither a file of the commit nor a folder holding one, and a place one row lays twice
 *  (duplicateLayouts). The same rules as test/package-files.test.mjs, judged on the commit's own files. */
export function layoutProblems(files) {
  const layout = files.find(([path]) => path === LAYOUT_FILE);
  const rows = layout ? JSON.parse(layout[1].toString('utf8')) : {};
  const problems = [];
  for (const tool of containerRows(files)) {
    if (tool.packageFiles.length && !(tool.id in rows)) problems.push(`${tool.id} is a container tool that names package files, and package-files.json has no key for it`);
    const laid = new Set(tool.packageFiles.flatMap(item => (item.packages ?? []).map(plainPackage)));
    for (const name of tool.packages) if (!laid.has(plainPackage(name))) problems.push(`${tool.id} declares the package ${plainPackage(name)}, and no package_files item of its own lays it`);
  }
  if (!layout) return problems;
  const paths = new Set(files.map(([path]) => path));
  const folders = new Set();
  for (const path of paths) for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) folders.add(path.slice(0, cut));
  for (const [row, items] of Object.entries(rows)) {
    for (const item of items) {
      if (item.package) for (const path of item.paths ?? []) {
        const full = `tools/${item.package}/${path}`.replace(/\/+$/, '');
        if (!paths.has(full) && !folders.has(full)) problems.push(`${row} is laid out with ${full}, which this commit does not hold`);
      }
    }
  }
  for (const duplicate of duplicateLayouts(rows)) {
    problems.push(duplicate.path === undefined
      ? `${duplicate.row} places the package folder ${duplicate.at} twice`
      : duplicate.inside === undefined
        ? `${duplicate.row} lays ${duplicate.key.slice('path '.length)} twice`
        : `${duplicate.row} lays ${duplicate.key.slice('path '.length)} inside ${duplicate.inside}, which it lays whole`);
  }
  return problems;
}

/** The files of `commit` in `repository`, read from git's archive in memory (none when the commit has no parent, for its parent). */
function archiveFiles(repository, commit) {
  return tarFiles(execFileSync('git', ['-C', repository, 'archive', '--format=tar', commit], { maxBuffer: 1 << 30 }));
}

/** What a commit adds against its parent: `added` are the problems its files have and its parent's do not, `existing` the ones
 *  its parent already has (the same text on both). A landing is judged by `added` only. */
export function layoutReport(files, parentFiles = []) {
  const parent = new Set(layoutProblems(parentFiles));
  const problems = layoutProblems(files);
  return { added: problems.filter(problem => !parent.has(problem)), existing: problems.filter(problem => parent.has(problem)) };
}

/** The pin of `commit` in `repository`, served at `address` (`{commit}` stands for the commit): what tools:update takes. */
export function pinOf(repository, commit, address) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Give the full commit identity (40 hex): a branch or a short name moves.');
  const at = String(address ?? '').replaceAll('{commit}', commit);
  if (!/^https:\/\/[^/\s]+\/\S*$/.test(at)) throw new Error('Give the https address of the commit\'s archive, with {commit} where the commit goes.');
  const files = archiveFiles(repository, commit);
  const problems = layoutProblems(files);
  if (problems.length) throw Object.assign(new Error(`Not pinned: ${commit} would stop runs, because the engine refuses a run whose layout names a missing file or places one package twice.\n${problems.join('\n')}`), { problems });
  return { address: at, files_blake3: manifestIdentity(files), files: files.length };
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  const [repository, commit, address] = process.argv.slice(2);
  if (!repository || !commit || !address) { console.error('Give the repository folder, the full commit and the archive address: node pin-a-commit-by-its-files.mjs REPOSITORY COMMIT ADDRESS'); process.exit(2); }
  // The landing check: the commit's problems judged against its parent's. Exit 1 only for a problem the commit adds.
  const parentFiles = (() => { try { return archiveFiles(repository, `${commit}^`); } catch { return []; } })();
  const report = layoutReport(archiveFiles(repository, commit), parentFiles);
  console.error(`new in this commit: ${report.added.length}; already on origin: ${report.existing.length}`);
  for (const problem of report.added) console.error(`  new: ${problem}`);
  for (const problem of report.existing) console.error(`  already on origin: ${problem}`);
  if (report.added.length) process.exit(1);
  if (report.existing.length) { console.error('No pin written: the parent already has problems, so the commit cannot be pinned until they are fixed.'); process.exit(0); }
  process.stdout.write(`${JSON.stringify(pinOf(repository, commit, address))}\n`);
}
