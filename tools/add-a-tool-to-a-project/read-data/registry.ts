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
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

/** The registry's text: a folder holding tools-in-this-registry.json, the file itself, or an https address of the file. */
async function registryText(from: string): Promise<{ address: string; text: string }> {
  if (from.startsWith('https://')) {
    const answer = await fetch(from);
    if (!answer.ok) throw new BadFrom(`The registry at ${from} answered ${answer.status}.`);
    return { address: from, text: await answer.text() };
  }
  const at = resolve(from);
  if (!existsSync(at)) throw new BadFrom(`There is no registry at ${at}.`);
  const file = statSync(at).isDirectory() ? join(at, REGISTRY_FILE) : at;
  if (!existsSync(file)) throw new BadFrom(`${at} holds no ${REGISTRY_FILE}.`);
  return { address: at, text: readFileSync(file, 'utf8') };
}

/** Reads and checks a whole registry. Every needs_tools name must itself be a tool of the registry. */
export async function readRegistry(from: string): Promise<Registry> {
  const { address, text } = await registryText(from);
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
