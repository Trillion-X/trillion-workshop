// test-helpers/pinned-files.mjs
//
// Purpose: the Workshop's pinned files (`pinned-files.json` at the top of the tree): the programs, packages and Python
// compile command its tools share, each pinned by the BLAKE3 of its archive, which the engine reads from a source and
// fetches at the run that needs them (trillion-rust src/tool_runs/tools/pinned_files.rs). The engine names no package
// system: this file is where the Workshop's own npm lockfile becomes pins. Its npm packages are the lockfile's
// installed ones (not development-only, not links, not bundled), each under its lockfile key (`node_modules/<name>`,
// `node_modules/<a>/node_modules/<b>` for a nested one), as a `tgz` package whose address is the lockfile's `resolved`.
//
//   treeOf(packages, name)              the lockfile keys of a module and everything it needs to run, sorted
//   manifestProblems(manifest, lock)    where the manifest and the lockfile disagree, one line each (none: they agree)
//   writePinnedFiles({ lock, previous, fetchBytes })   the manifest for `lock`: an npm package already pinned at the same
//                                       address and version is kept; a new one is fetched, checked against the lockfile's
//                                       sha512 integrity and pinned by its BLAKE3
//
// Non-Negotiable Invariants:
//   1. A package is pinned only by bytes whose sha512 is the lockfile's integrity, so a pin is never a guess.
//   2. A module tree holds the lockfile's resolution (nested folder first, then each folder up, as Node looks them up).
//      A required dependency the lockfile does not install, or a package that runs an install script, refuses the tree
//      by name: nothing the engine fetches runs a script. The one exception is a package install-scripts-not-needed.json
//      names, whose script was read and changes no file the package runs with (a Node version check, a printed warning). An optional package for one platform only is left out.
//   3. Entries that are not npm packages (programs, wheels, models, the compile command) are kept as they are.

import { createHash } from 'node:crypto';
import { makeHashCodeHexFromBytes } from '../tools/content-identity/read-data/identity.mjs';
import scriptsNotNeeded from './install-scripts-not-needed.json' with { type: 'json' };

export const PINNED_FILES = 'pinned-files.json';
export const MODULES = 'node_modules/';

/** A lockfile entry that installs: it has an address and an integrity, and is not development-only, a link or bundled. */
export const installs = entry => Boolean(entry && entry.resolved && entry.integrity && !entry.dev && !entry.link && !entry.inBundle);

/** The package name a lockfile key ends in. */
export const nameOf = key => key.slice(key.lastIndexOf(MODULES) + MODULES.length);

/** The lockfile key `dependency` resolves to for the package at `from`: its own nested folder, then each folder up. */
export function resolveDependency(packages, from, dependency) {
  let base = from;
  for (;;) {
    const candidate = `${base}/${MODULES}${dependency}`;
    if (packages[candidate]) return candidate;
    const at = base.lastIndexOf(`/${MODULES}`);
    if (at < 0) break;
    base = base.slice(0, at);
  }
  const top = `${MODULES}${dependency}`;
  return packages[top] ? top : null;
}

/** The packages whose install script the engine may leave unrun (install-scripts-not-needed.json), each with why. */
export const SCRIPTS_NOT_NEEDED = Object.freeze({ ...scriptsNotNeeded.packages });

/** The lockfile keys of the module `name` and everything it needs to run, sorted. A package that runs an install script refuses
 *  the tree unless `notNeeded` names it (its script was read and changes no file the package runs with). */
export function treeOf(packages, name, notNeeded = SCRIPTS_NOT_NEEDED) {
  const top = `${MODULES}${name}`;
  if (!installs(packages[top])) throw new Error(`the lockfile does not install ${name}`);
  const seen = new Set();
  const queue = [top];
  while (queue.length) {
    const key = queue.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = packages[key];
    if (entry.hasInstallScript && !Object.hasOwn(notNeeded, key)) throw new Error(`${key} runs an install script, and nothing the engine fetches runs one`);
    for (const [field, required] of [['dependencies', true], ['optionalDependencies', false], ['peerDependencies', false]]) {
      for (const dependency of Object.keys(entry[field] ?? {})) {
        const found = resolveDependency(packages, key, dependency);
        const wanted = found && installs(packages[found]) && !packages[found].os && !packages[found].cpu;
        if (wanted) queue.push(found);
        else if (required) throw new Error(`${key} needs ${dependency}, which the lockfile does not install`);
      }
    }
  }
  return [...seen].sort();
}

/** The address of the registry's own record of a package version: where its integrity was read from. */
const checkedAgainst = (entry, key) => `${new URL(entry.resolved).origin}/${nameOf(key)}/${entry.version}`;

/** The `fetch.any` pin of an lockfile package whose archive bytes are `bytes`. */
const pinOf = (entry, key, bytes) => ({ url: entry.resolved, blake3: makeHashCodeHexFromBytes(bytes).slice('1f:'.length), checked_against: checkedAgainst(entry, key) });

/** Where `manifest` and `lock` (a parsed package-lock.json) disagree, one line each. */
export function manifestProblems(manifest, lock) {
  const problems = [];
  const have = manifest.packages ?? {};
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key || !installs(entry)) continue;
    const pinned = have[key];
    if (!pinned) problems.push(`${key} is installed by the lockfile and pinned by no package`);
    else if (pinned.archive !== 'tgz' || pinned.version !== entry.version || pinned.fetch?.any?.url !== entry.resolved) problems.push(`${key} is pinned at another version or address than the lockfile's`);
  }
  for (const key of Object.keys(have)) {
    if (key.startsWith(MODULES) && !installs(lock.packages?.[key])) problems.push(`${key} is pinned and the lockfile does not install it`);
  }
  return problems;
}

/** The manifest for `lock`, given the one before it and a function that reads an address's bytes. */
export async function writePinnedFiles({ lock, previous, fetchBytes }) {
  const packages = {};
  for (const [name, row] of Object.entries(previous.packages ?? {})) if (!name.startsWith(MODULES)) packages[name] = row;
  for (const [key, entry] of Object.entries(lock.packages ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!key || !installs(entry)) continue;
    const old = previous.packages?.[key];
    if (old && old.version === entry.version && old.fetch?.any?.url === entry.resolved) { packages[key] = old; continue; }
    const bytes = await fetchBytes(entry.resolved);
    const expected = entry.integrity.split(/\s+/).find(part => part.startsWith('sha512-'))?.slice('sha512-'.length);
    if (!expected || createHash('sha512').update(bytes).digest('base64') !== expected) throw new Error(`${key}: the bytes at its address are not the lockfile's sha512`);
    packages[key] = { version: entry.version, archive: 'tgz', fetch: { any: pinOf(entry, key, bytes) } };
  }
  const sorted = Object.fromEntries(Object.entries(packages).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { ...previous, packages: sorted };
}
