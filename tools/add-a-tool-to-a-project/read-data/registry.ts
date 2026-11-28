// tools/add-a-tool-to-a-project/read-data/registry.ts
//
// PURPOSE
//   Reads a registry of tool pointers (`tools-in-this-registry.json`) and checks every pointer's shape: a pointer names a
//   repository, a folder in it, a full commit, the BLAKE3 identity of the folder's files at that commit and the sibling
//   folders it needs. A pointer with `paths` takes only those files of its folder (a large shared folder is taken by the
//   files its users reach, not whole).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only a full 40-hex commit is a pointer's commit (a branch or a short name moves; a pointer must not).
//   2. `files_blake3` is bare 64 hex: the manifest identity of tools/content-identity/read-data/manifest.mjs.
//   3. A folder path or a `paths` entry never climbs (`..`), never starts at the root and never names an empty part.
//   4. A registry that is not this shape is refused whole (`BadFrom`): nothing is read from half a registry.
//   5. A registry's `address` (what a project record keeps) is an address every computer can reach, never a file path:
//      a registry read from a local folder or file is recorded as that folder's git `origin` address (`addressOf`), and
//      one with no origin is refused. An https address carrying a user or a password is refused, so no key is recorded.
//      The record travels in the project's git, so its locator means the same thing on every computer; a local folder is
//      only where this run read it.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const REGISTRY_FILE = 'tools-in-this-registry.json';
export const TOOL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const COMMIT = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export type Hex64 = string;
export type Pointer = {
  repo: string;
  path: string;
  commit: string;
  files_blake3: Hex64;
  what_it_does: string;
  needs_tools: string[];
  paths?: string[];
};
export type Registry = { address: string; tools: Record<string, Pointer> };

/** Refused because `from` is not a registry, or a pointer in it is not a pointer. */
export class BadFrom extends Error {}

/** A relative path inside a folder: no `..`, no leading `/`, no empty or `.` part. */
export function isInsidePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

/** The pointer's shape, checked; a wrong pointer throws BadFrom naming the field. */
export function checkPointer(name: string, value: unknown): Pointer {
  const bad = (why: string): never => { throw new BadFrom(`The pointer ${JSON.stringify(name)} ${why}.`); };
  if (!TOOL_NAME.test(name)) bad('is not a tool name (a-z, 0-9 and -)');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) bad('is not an object');
  const p = value as Record<string, unknown>;
  if (typeof p.repo !== 'string' || p.repo.length === 0) bad('names no repo');
  if (!isInsidePath(p.path)) bad('has a path that is empty, climbs out with .., or starts at the root');
  if (typeof p.commit !== 'string' || !COMMIT.test(p.commit)) bad('has a commit that is not a full 40-hex commit');
  if (typeof p.files_blake3 !== 'string' || !HEX64.test(p.files_blake3)) bad('has a files_blake3 that is not 64 hex');
  if (typeof p.what_it_does !== 'string') bad('says no what_it_does');
  if (!Array.isArray(p.needs_tools) || !p.needs_tools.every(n => typeof n === 'string' && TOOL_NAME.test(n))) bad('has needs_tools that are not tool names');
  if (p.paths !== undefined && (!Array.isArray(p.paths) || p.paths.length === 0 || !p.paths.every(isInsidePath))) bad('has paths that are not files inside its folder');
  return {
    repo: p.repo as string, path: p.path as string, commit: p.commit as string, files_blake3: p.files_blake3 as string,
    what_it_does: p.what_it_does as string, needs_tools: [...(p.needs_tools as string[])],
    ...(p.paths ? { paths: [...(p.paths as string[])] } : {}),
  };
}

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
const SCP_ADDRESS = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/;

/** True for an address another computer can reach: https://, ssh:// or git:// with no spaces, or user@host:path. */
export function isReachableAddress(location: string): boolean {
  return /^(https|ssh|git):\/\/[^\s]+$/.test(location) || SCP_ADDRESS.test(location);
}

/** A git repository's address rather than a file's: ssh, git or user@host:path, or an https address ending in .git. */
const isGitAddress = (address: string): boolean => /^(ssh|git):\/\//.test(address) || SCP_ADDRESS.test(address) || /\.git\/?$/.test(address);

/** A folder's git origin address, or null when it is not a git folder or has none. */
function originOf(folder: string): string | null {
  const origin = spawnSync('git', ['-C', folder, 'remote', 'get-url', 'origin'], { env: GIT_ENV, encoding: 'utf8' });
  return origin.error || origin.status !== 0 || !origin.stdout.trim() ? null : origin.stdout.trim();
}

/** The address a project record keeps for `location`: a reachable address as given, or a local folder's (or file's
 *  folder's) git origin address. Refused (BadFrom) when it has none, or when an https address carries a user or password. */
export function addressOf(location: string): string {
  let address = location;
  if (!isReachableAddress(location)) {
    const at = resolve(location);
    if (!existsSync(at)) throw new BadFrom(`There is nothing at ${at}.`);
    const folder = statSync(at).isDirectory() ? at : dirname(at);
    const origin = originOf(folder);
    if (origin === null) throw new BadFrom(`${at} has no git origin address; a project record names only an address every computer can reach.`);
    address = origin;
    if (!isReachableAddress(address)) throw new BadFrom(`The origin of ${at} is ${JSON.stringify(address)}, which is not an address every computer can reach.`);
  }
  if (address.startsWith('https://')) {
    const url = new URL(address);
    if (url.username || url.password) throw new BadFrom('A registry or repo address carries a user or password; only a plain address is recorded.');
  }
  return address;
}

/** The registry file at the newest commit of a git repository's default branch: a depth-1 fetch into a throwaway folder. */
function registryFromGit(address: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'registry-'));
  try {
    const git = (...args: string[]) => {
      const done = spawnSync('git', ['-C', dir, ...args], { env: GIT_ENV, maxBuffer: 1 << 26 });
      if (done.error || done.status !== 0) throw new BadFrom(`The registry at ${address} could not be read: ${done.stderr?.toString('utf8').trim() || done.error}.`);
      return done.stdout.toString('utf8');
    };
    git('init', '-q');
    git('fetch', '-q', '--no-tags', '--depth', '1', address, 'HEAD');
    return git('show', `FETCH_HEAD:${REGISTRY_FILE}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The registry's text and the address a record keeps for it: from a folder holding tools-in-this-registry.json or the
 *  file itself (read here, recorded as the folder's origin address), a git repository address (its default branch), or
 *  an https address of the file. */
async function registryText(from: string, clones: string[]): Promise<{ address: string; text: string }> {
  // An address one of the named local clones has as its origin is read from that clone, as a folder given directly is.
  const local = isReachableAddress(from) ? clones.find(clone => originOf(clone) === from && existsSync(join(clone, REGISTRY_FILE))) : undefined;
  if (local !== undefined) return { address: from, text: readFileSync(join(local, REGISTRY_FILE), 'utf8') };
  if (!isReachableAddress(from)) {
    const at = resolve(from);
    if (!existsSync(at)) throw new BadFrom(`There is no registry at ${at}.`);
    const file = statSync(at).isDirectory() ? join(at, REGISTRY_FILE) : at;
    if (!existsSync(file)) throw new BadFrom(`${at} holds no ${REGISTRY_FILE}.`);
    return { address: addressOf(at), text: readFileSync(file, 'utf8') };
  }
  const address = addressOf(from);
  if (isGitAddress(address)) return { address, text: registryFromGit(address) };
  const answer = await fetch(address);
  if (!answer.ok) throw new BadFrom(`The registry at ${address} answered ${answer.status}.`);
  return { address, text: await answer.text() };
}

/** Reads and checks a whole registry. Every needs_tools name must itself be a tool of the registry. */
export async function readRegistry(from: string, clones: string[] = []): Promise<Registry> {
  const { address, text } = await registryText(from, clones);
  let kept: unknown;
  try { kept = JSON.parse(text); } catch { throw new BadFrom(`The registry at ${address} is not JSON.`); }
  const tools = (kept as { tools?: unknown })?.tools;
  if (tools === null || typeof tools !== 'object' || Array.isArray(tools)) throw new BadFrom(`The registry at ${address} has no tools object.`);
  const checked: Record<string, Pointer> = {};
  for (const [name, value] of Object.entries(tools as Record<string, unknown>)) checked[name] = checkPointer(name, value);
  for (const [name, pointer] of Object.entries(checked)) {
    for (const need of pointer.needs_tools) if (!checked[need]) throw new BadFrom(`The pointer ${JSON.stringify(name)} needs ${JSON.stringify(need)}, which the registry does not hold.`);
  }
  return { address, tools: checked };
}
