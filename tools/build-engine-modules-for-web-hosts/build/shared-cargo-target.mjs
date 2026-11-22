// scripts/shared-cargo-target.mjs
//
// Purpose: give every cargo build on a computer ONE target folder, so the many copies of this repository that AIs build
// from at once share the compiled third-party crates instead of each keeping its own ~1 GB `target`, and keep
// that one folder under a size ceiling so it cannot fill the disk. Used by build-crate-for-a-web-host.mjs and
// build-compiled-modules.mjs, the two places that run cargo.
//
// Invariants:
// - The folder is TRILLION_CARGO_TARGET_DIR when set, else cargo-target in the computer's own cache folder
//   (tools/process-session/do-work/computer-cache-folder.mjs: $XDG_CACHE_HOME/trillion or ~/.cache/trillion, the same
//   rule on every computer). It carries a CACHEDIR.TAG, so backups skip it.
// - One build at a time holds it: `withSharedCargoTarget` takes `<folder>.lock` (a directory made atomically, holding
//   the holder's process id, `withFolderLock`) and keeps it until the work, including copying the built module out, is
//   done, so two copies building the same crate with different features never read each other's output. A lock whose
//   process has ended is taken over. Only work that runs cargo or reads its output takes it: a reader of modules already
//   built and published elsewhere guards that published folder with its own lock, so it never waits for a compile.
// - Before each build, while holding the lock, the folder is measured; past CARGO_TARGET_CEILING it is deleted whole and
//   cargo builds again from nothing. Everything in it is cargo's own regenerable output.
// - Work handed the folder must copy anything it keeps into its own copy of the repository before returning.
// - Cargo decides a crate of the workspace is unchanged by comparing file times, and every copy exported from git
//   carries its commit's time, so a copy whose crates differ from the last one built could be handed the other copy's
//   output. The BLAKE3 identity of the sources of the workspaces this copy builds (every file under each tool's
//   `crates/` folder but `target`) is kept beside the build as `workspace-sources.json`; when this copy's differs, its
//   source files are given the current time first, so cargo builds them again.
// - Every cargo run is given `--remap-path-prefix` for the computer's home, rustup, cargo and checkout folders (`cargoEnv`),
//   so no compiled module committed from here carries the path of whoever built it.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { computerCacheFolder as placeCacheFolder } from '../../process-session/do-work/computer-cache-folder.mjs';

// The most the shared folder may hold before it is cleared: enough for every crate built for every target several
// times over (one full build is about 1 GB), little enough that the disk keeps its room.
export const CARGO_TARGET_CEILING = { gigabytes: 40 };

const CACHEDIR_TAG = 'Signature: 8a477f597d28d172789f06886806bc55\n# The shared cargo target of Trillion builds (scripts/shared-cargo-target.mjs).\n';

/** The one cargo target folder of the place this runs on. */
export function sharedCargoTargetFolder(env = process.env) {
  if (env.TRILLION_CARGO_TARGET_DIR) return env.TRILLION_CARGO_TARGET_DIR;
  return join(placeCacheFolder(env), 'cargo-target');
}

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function holderIsRunning(lock) {
  let pid;
  try { pid = Number(readFileSync(join(lock, 'pid'), 'utf8')); } catch {
    // Made this instant and its id not yet written, or its maker stopped between the two steps.
    try { return Date.now() - statSync(lock).mtimeMs < 10_000; } catch { return false; }
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function takeLock(lock) {
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), String(process.pid));
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (!holderIsRunning(lock)) rmSync(lock, { recursive: true, force: true });
    else await pause(250);
  }
}

function workspaceSourceFiles(workspaceRoot) {
  const files = [];
  const walk = folder => {
    for (const name of readdirSync(folder)) {
      if (folder === workspaceRoot && (name === 'target' || name.startsWith('.compiled-modules-'))) continue;
      if (name === '.DS_Store') continue;
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path); else files.push(path);
    }
  };
  walk(workspaceRoot);
  return files.sort();
}

function identityOf(workspaceRoots, filesOf) {
  const hasher = blake3.create();
  workspaceRoots.forEach((workspaceRoot, at) => {
    for (const path of filesOf[at]) {
      const bytes = readFileSync(path);
      hasher.update(new TextEncoder().encode(`${at}\0${relative(workspaceRoot, path)}\0${bytes.length}\0`));
      hasher.update(bytes);
    }
  });
  return bytesToHex(hasher.digest());
}

function kilobytesIn(folder) {
  return Number(execFileSync('du', ['-sk', folder], { encoding: 'utf8' }).split(/\s/)[0]);
}

/**
 * Run `work()` holding the lock directory `lock` (made atomically, holding this process's id; a lock whose process has
 * ended is taken over), and give it back when the work ends or throws.
 * @template T
 * @param {string} lock
 * @param {() => T | Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withFolderLock(lock, work) {
  mkdirSync(dirname(lock), { recursive: true });
  await takeLock(lock);
  try { return await work(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

/**
 * Run `work(folder)` holding the shared cargo target folder, for the cargo workspaces at `workspaceRoots` (each tool's
 * `crates/` folder). Cargo started inside must be given `{ env: cargoEnv(folder) }`.
 * @template T
 * @param {string | string[]} workspaceRoots
 * @param {(folder: string) => T | Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withSharedCargoTarget(workspaceRoots, work) {
  const folder = sharedCargoTargetFolder();
  return withFolderLock(`${folder}.lock`, async () => {
    if (existsSync(folder) && kilobytesIn(folder) > CARGO_TARGET_CEILING.gigabytes * 1024 * 1024) rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    if (!existsSync(join(folder, 'CACHEDIR.TAG'))) writeFileSync(join(folder, 'CACHEDIR.TAG'), CACHEDIR_TAG);
    const builtFrom = join(folder, 'workspace-sources.json');
    const roots = [workspaceRoots].flat();
    const filesOf = roots.map(workspaceSourceFiles);
    const files = filesOf.flat();
    const identity = identityOf(roots, filesOf);
    let last = null;
    try { last = JSON.parse(readFileSync(builtFrom, 'utf8')).identity; } catch { /* nothing built yet */ }
    if (last !== identity) {
      const now = new Date();
      for (const path of files) utimesSync(path, now, now);
    }
    const answer = await work(folder);
    writeFileSync(builtFrom, `${JSON.stringify({ identity })}\n`);
    return answer;
  });
}

/**
 * The flags that keep the building computer's paths out of every compiled module: rustc writes the source path of each
 * panic and assertion into the module, which would carry the home folder (and so the person who built it) to everyone
 * who loads it. Where the mapped places are is read from this computer; what they become is fixed text. A path under
 * more than one of them takes the last mapping, so the narrowest places come last.
 */
export function pathRemapFlags(env = process.env) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const home = homedir();
  const cargoHome = env.CARGO_HOME || join(home, '.cargo');
  const rustupHome = env.RUSTUP_HOME || join(home, '.rustup');
  return [home, dirname(root), rustupHome, cargoHome, root].filter(Boolean)
    .map((from, at) => `--remap-path-prefix=${from}=${['/home', '/checkouts', '/rustup', '/cargo', '/trillion'][at]}`);
}

/** The environment cargo runs with inside `withSharedCargoTarget`: the shared target folder and the path remapping. */
export const cargoEnv = folder => {
  const { RUSTFLAGS, CARGO_ENCODED_RUSTFLAGS, ...rest } = process.env;
  // Encoded flags are separated by 0x1f, so a path with a space in it stays one flag.
  const kept = CARGO_ENCODED_RUSTFLAGS ? CARGO_ENCODED_RUSTFLAGS.split('\x1f') : (RUSTFLAGS ?? '').split(/\s+/).filter(Boolean);
  return { ...rest, CARGO_TARGET_DIR: folder, CARGO_ENCODED_RUSTFLAGS: [...kept, ...pathRemapFlags()].join('\x1f') };
};
