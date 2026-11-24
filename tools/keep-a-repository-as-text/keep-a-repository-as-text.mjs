// tools/keep-a-repository-as-text/keep-a-repository-as-text.mjs
//
// PURPOSE
//   Pulls one outside git repository into the person's pulled-files folder as ONE text bundle: a header with its address,
//   commit and licence, the list of its files, then each text file in full. The repository is only data. Nothing in it is
//   run, installed, built, imported or sourced.
//
//     node keep-a-repository-as-text.mjs < input.json
//
//   input.json: { "url": "https://github.com/OWNER/REPO", "ref": "optional branch, tag or commit" }
//   Prints one JSON line: the answer { url, commit, licence, bundle_path, bundle_bytes, bundle_blake3, files_kept,
//   files_skipped, description } or { error }.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only https addresses with no user name, password, query or fragment are fetched; the ref is a plain git name or id.
//   2. git runs with hooks off (core.hooksPath=/dev/null), no global or system config, no template folder, no LFS or
//      filter smudge, no prompt for a password, and no submodules. The repository's own config and hooks never run.
//   3. Symbolic links are never followed. Binary, oversized, non-UTF-8 and over-cap files are recorded as skipped, with why.
//   4. The clone folder is removed in every case; the bundle is the only thing that stays.
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readdir, readFile, rename, rm, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { text } from 'node:stream/consumers';
import { makeHashCodeHexFromBytes } from '../content-identity/read-data/identity.mjs';

const execFileAsync = promisify(execFile);
const limits = JSON.parse(await readFile(new URL('./read-data/limits.json', import.meta.url), 'utf8'));
const utf8 = new TextDecoder('utf-8', { fatal: true });

// git sees no global or system config, no templates, and no hooks: the repository is data and its hooks never run.
const GIT_ENV = { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_LFS_SKIP_SMUDGE: '1' };
const GIT_SAFETY = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'filter.lfs.required=false', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process='];

class PlainError extends Error {}

/** Checks the address and the ref before anything is fetched. Returns { url, host, segments, ref } or { error }. */
export function checkInput(input) {
  const raw = typeof input?.url === 'string' ? input.url.trim() : '';
  let address;
  try {
    address = new URL(raw);
  } catch {
    return { error: 'The address must be a full https address, for example https://github.com/OWNER/REPO.' };
  }
  if (address.protocol !== 'https:') return { error: 'The address must start with https://.' };
  if (address.username || address.password) return { error: 'The address must not carry a user name or password.' };
  if (address.search || address.hash) return { error: 'The address must be the repository address, with no query or fragment.' };
  const segments = address.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  if (segments.length < 2) return { error: 'The address must name an owner and a repository.' };
  const ref = input.ref ?? null;
  if (ref !== null && (typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) || ref.includes('..'))) {
    return { error: 'The ref must be a branch, tag or commit name of plain letters, digits, dots, dashes, underscores and slashes.' };
  }
  return { url: `https://${address.host}/${segments.join('/')}`, host: address.host, segments, ref };
}

async function git(args, { cwd, most_git_seconds = limits.most_git_seconds } = {}) {
  try {
    const { stdout } = await execFileAsync('git', [...GIT_SAFETY, ...args], { cwd, env: GIT_ENV, timeout: most_git_seconds * 1000, maxBuffer: 1_000_000 });
    return stdout.trim();
  } catch (error) {
    if (error.killed) throw new PlainError(`git did not finish within ${most_git_seconds} seconds.`);
    throw error;
  }
}

/**
 * Fetches the newest commit (or the named ref) with depth 1 into an empty folder and checks it out there.
 * Returns the commit id. Throws a PlainError with words for the person when the repository or ref cannot be read.
 */
export async function cloneShallow(remote, ref, dir) {
  await git(['init', '--quiet', '--template=', dir], { cwd: dir });
  await git(['remote', 'add', 'origin', remote], { cwd: dir });
  try {
    await git(['fetch', '--quiet', '--depth', '1', '--no-tags', '--no-recurse-submodules', 'origin', ref ?? 'HEAD'], { cwd: dir });
  } catch (error) {
    if (error instanceof PlainError) throw error;
    const says = String(error.stderr ?? error.message);
    if (/couldn't find remote ref/i.test(says)) throw new PlainError(`The ref ${ref} was not found in the repository.`);
    throw new PlainError('The repository was not found, or it needs a sign-in. Only public repositories can be kept as text.');
  }
  await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: dir });
  return git(['rev-parse', 'HEAD'], { cwd: dir });
}

/** Every entry under the folder, sorted by path. The .git folder is left out. */
export async function listFiles(root, rel = '') {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await listFiles(root, relPath));
    else if (entry.isSymbolicLink()) found.push({ path: relPath, kind: 'link' });
    else if (entry.isFile()) found.push({ path: relPath, kind: 'file' });
    else found.push({ path: relPath, kind: 'other' });
  }
  return rel ? found : found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The licence: the host's SPDX id when it gives one, else the licence file's words, else none declared. */
export async function licenceOf({ host, segments, files, root, fetchImpl = fetch }) {
  const fromFile = await licenceFromFile(files, root);
  if (host !== 'github.com') return fromFile.spdx ?? fromFile.answer;
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${segments[0]}/${segments[1]}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'keep-a-repository-as-text' },
      signal: AbortSignal.timeout(limits.most_licence_seconds * 1000),
    });
    if (response.ok) {
      const spdx = (await response.json())?.license?.spdx_id;
      if (spdx && spdx !== 'NOASSERTION') return spdx;
    }
  } catch {
    // The licence API did not answer; the licence file decides, below.
  }
  return fromFile.spdx ?? fromFile.answer;
}

// A licence file at any depth counts; the one nearest the root is read first.
async function licenceFromFile(files, root) {
  const found = files
    .filter(f => f.kind === 'file' && /^(LICENSE|LICENCE|COPYING)/i.test(path.posix.basename(f.path)))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || (a.path < b.path ? -1 : 1));
  if (found.length === 0) return { answer: 'none declared (all rights reserved by default)' };
  for (const file of found) {
    const bytes = await readFile(path.join(root, file.path));
    const body = Buffer.from(bytes.subarray(0, limits.most_bytes_per_file)).toString('utf8');
    const match = limits.licence_phrases.find(p => body.includes(p.phrase));
    if (match && !file.path.includes('/')) return { spdx: match.spdx };
    if (match) return { answer: `${match.spdx} only, in ${file.path} (no licence file at the repository root)` };
  }
  return { answer: `licence file ${found[0].path} present; its SPDX id was not identified (read the file in the bundle)` };
}

/** Reads each text file under the caps and returns the sections of the bundle, with what was skipped and why. */
export async function readFilesForBundle(root, files) {
  const sections = [];
  const skipped = [];
  const listing = [];
  let contentBytes = 0;
  let full = false;
  for (const file of files) {
    if (file.kind === 'link') { skipped.push({ path: file.path, why: 'symbolic link (not followed)' }); continue; }
    if (file.kind !== 'file') { skipped.push({ path: file.path, why: 'not a regular file' }); continue; }
    if (full) { skipped.push({ path: file.path, why: `total cap of ${limits.most_bundle_bytes} bytes reached` }); continue; }
    const size = (await lstat(path.join(root, file.path))).size;
    if (size > limits.most_bytes_per_file) {
      skipped.push({ path: file.path, why: `larger than the ${limits.most_bytes_per_file}-byte per-file cap (${size} bytes)` });
      continue;
    }
    const bytes = await readFile(path.join(root, file.path));
    if (bytes.subarray(0, limits.binary_sniff_bytes).includes(0)) { skipped.push({ path: file.path, why: 'binary (contains a NUL byte)' }); continue; }
    let body;
    try {
      body = utf8.decode(bytes);
    } catch {
      skipped.push({ path: file.path, why: 'not UTF-8 text' });
      continue;
    }
    if (contentBytes + bytes.length > limits.most_bundle_bytes) {
      full = true;
      skipped.push({ path: file.path, why: `total cap of ${limits.most_bundle_bytes} bytes reached` });
      continue;
    }
    contentBytes += bytes.length;
    listing.push(`  kept     ${file.path} (${bytes.length} bytes)`);
    sections.push(`===== ${file.path} (${bytes.length} bytes) =====\n${body.endsWith('\n') ? body : `${body}\n`}`);
  }
  for (const skip of skipped) listing.push(`  skipped  ${skip.path} - ${skip.why}`);
  return { sections, skipped, listing, keptCount: sections.length };
}

/** The bundle file's text: header, file list, then each kept file. */
export function bundleText({ url, commit, licence, kept, skipped, listing, sections }) {
  return [
    'Repository kept as text',
    `url: ${url}`,
    `commit: ${commit}`,
    `licence: ${licence}`,
    `files kept: ${kept}`,
    `files skipped: ${skipped}`,
    `per-file cap: ${limits.most_bytes_per_file} bytes; total cap on file contents: ${limits.most_bundle_bytes} bytes`,
    'Nothing in this repository was run, installed, built or imported.',
    '',
    'Files in the repository (kept or skipped):',
    ...listing,
    '',
    ...sections,
  ].join('\n');
}

function bundleNameFor(host, segments, commit) {
  const slug = host === 'github.com' ? segments.slice(0, 2).join('__') : [host, ...segments].join('__');
  return `${slug.replace(/[^A-Za-z0-9._-]/g, '-')}@${commit}.txt`;
}

/** The root from limits.json, with ~ read as the person's home folder. */
export function pullRoot() {
  return limits.root.startsWith('~/') ? path.join(homedir(), limits.root.slice(2)) : limits.root;
}

/**
 * Fetches, bundles and records one repository. `remote` is what git fetches; `host` and `segments` name it for the bundle
 * and the licence. Input checks happen in keepRepositoryAsText, so tests can point this at a local fixture.
 */
export async function pullAndBundle({ url, host, segments, ref = null, remote, root = pullRoot(), fetchImpl }) {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'clone-'));
  try {
    const commit = await cloneShallow(remote, ref, dir);
    const files = await listFiles(dir);
    const licence = await licenceOf({ host, segments, files, root: dir, fetchImpl });
    const { sections, skipped, listing, keptCount } = await readFilesForBundle(dir, files);
    const body = Buffer.from(bundleText({ url, commit, licence, kept: keptCount, skipped: skipped.length, listing, sections }), 'utf8');
    const bundlePath = path.join(root, bundleNameFor(host, segments, commit));
    const partial = `${bundlePath}.partial`;
    await writeFile(partial, body);
    await rename(partial, bundlePath);
    const identity = makeHashCodeHexFromBytes(body);
    return {
      url,
      commit,
      licence,
      bundle_path: bundlePath,
      bundle_bytes: body.length,
      bundle_blake3: identity,
      files_kept: keptCount,
      files_skipped: skipped,
      description: `Kept ${keptCount} text files and skipped ${skipped.length} from ${segments.slice(0, 2).join('/')} at commit ${commit.slice(0, 12)}; licence: ${licence}.`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The whole job: refuses a bad address, pulls the repository, and answers the answer or { error }. */
export async function keepRepositoryAsText(input, { root, fetchImpl } = {}) {
  const checked = checkInput(input);
  if (checked.error) return { error: checked.error };
  try {
    return await pullAndBundle({ ...checked, remote: checked.url, root, fetchImpl });
  } catch (error) {
    if (error instanceof PlainError) return { error: error.message };
    return { error: 'Keeping the repository as text failed before the bundle was written.' };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input;
  try {
    input = JSON.parse(await text(process.stdin));
  } catch {
    input = null;
  }
  console.log(JSON.stringify(input ? await keepRepositoryAsText(input) : { error: 'The input must be one JSON object with a url.' }));
}
