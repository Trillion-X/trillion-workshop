// tools/publish-an-engine-release/do-work/keep-room-to-build.mjs
//
// A publish run keeps room for its build. Cargo's output is the only thing on the builder that grows by itself, and
// every byte of it can be built again, so at the start of a run (before git fetch) this measures the free bytes of the
// work folder's filesystem and, when they are under settings.build_free_bytes_at_least, removes what the tool owns and
// can rebuild: first the folders its earlier layouts made (settings.retired_work_folders), then each target's
// build folder under work/target, the one used longest ago first, never the host target that this run's publish needs.
// When the bound still does not hold, the run is refused with the free bytes and what was removed, so a full disk is
// said plainly and not found in a cargo error. The same shape as an engine computer's own room (trillion-rust
// src/native_entry/computer/releases.rs: keep_free_bytes, required_extra_bytes).
import { lstatSync, mkdirSync, readdirSync, rmSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from './release-feed.mjs';

/** The folder under the work folder that holds one build folder per target triple. */
export const targetsFolderOf = work => join(work, 'target');

/** The bytes a program that is not root may still write on the filesystem holding `folder`. */
export const freeBytesOf = folder => { const stats = statfsSync(folder); return Number(stats.bavail) * Number(stats.bsize); };

const GIB = 2 ** 30;
const gib = bytes => `${(bytes / GIB).toFixed(1)} GiB`;

/** The refusal of a run that cannot make room: exit 5, `room` holds the numbers. */
export class NoRoom extends Error {
  constructor(room) {
    const removed = room.removed.length ? room.removed.map(one => `${one.folder} (${gib(one.freed_bytes)})`).join(', ') : 'nothing it could remove';
    super(`There is not enough room to build: the work folder's disk has ${room.free_bytes} bytes (${gib(room.free_bytes)}) free and a build needs ${room.bound} (${gib(room.bound)}). This run removed ${removed}; it keeps ${room.kept.join(', ') || 'no target'} because that target builds now. Free space on the builder through its owner (the feed folder and the work folder's other folders are not this tool's to remove).`);
    this.exit = 5;
    this.room = room;
  }
}

/** A name under the work folder: relative, no empty, `.` or `..` step. */
const checkRetired = name => {
  if (typeof name !== 'string' || !name || name.startsWith('/') || name.split('/').some(step => !step || step === '.' || step === '..')) throw new Error(`settings.retired_work_folders names ${JSON.stringify(name)}: each must be a path under the work folder, with no empty, . or .. step.`);
  return name;
};

/** When a folder was last used: its own change time or its newest immediate entry's (cargo writes inside `release/`, not in the folder itself). */
const lastUsed = folder => readdirSync(folder).reduce((newest, name) => Math.max(newest, lstatSync(join(folder, name)).mtimeMs), lstatSync(folder).mtimeMs);

/**
 * Makes room for a build in `work`. `keep` names the target triples whose folders stay (the one this run builds).
 * `freeBytes` measures the free bytes of a folder's filesystem (a test hands its own). Answers
 * `{ bound, free_bytes_before, free_bytes, removed: [{ folder, freed_bytes }], kept }`, or throws NoRoom.
 */
export function keepRoom({ work, keep = [], freeBytes = freeBytesOf, bound = settings.build_free_bytes_at_least, retired = settings.retired_work_folders, targetPattern = new RegExp(settings.target_pattern) }) {
  mkdirSync(work, { recursive: true });
  const before = freeBytes(work);
  const removed = [];
  const take = (folder, name) => {
    const was = freeBytes(work);
    rmSync(folder, { recursive: true, force: true });
    removed.push({ folder: name, freed_bytes: freeBytes(work) - was });
  };
  // What earlier layouts of this tool made and nothing builds in now: gone whenever it is there.
  for (const name of retired.map(checkRetired)) {
    const folder = join(work, name);
    if (lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) take(folder, name);
  }
  let free = freeBytes(work);
  if (free < bound) {
    const targets = targetsFolderOf(work);
    const built = (lstatSync(targets, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(targets, { withFileTypes: true }) : [])
      .filter(entry => entry.isDirectory() && targetPattern.test(entry.name) && !keep.includes(entry.name))
      .map(entry => ({ name: entry.name, used: lastUsed(join(targets, entry.name)) }))
      .sort((a, b) => a.used - b.used);
    for (const { name } of built) {
      if (free >= bound) break;
      take(join(targets, name), `target/${name}`);
      free = freeBytes(work);
    }
  }
  const room = { bound, free_bytes_before: before, free_bytes: free, removed, kept: keep };
  if (free < bound) throw new NoRoom(room);
  return room;
}
