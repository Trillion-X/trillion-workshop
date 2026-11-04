// src/local-store-safety.mjs
//
// PURPOSE
//   Three safety nets for the decision store on this computer (src/local-store.mjs), each a few lines and each removing a
//   class of unrecoverable states: a copy taken before the store's shape changes, rolling snapshots, and a snapshot taken
//   before a restore. Counts and intervals are DATA (src/local-store-safety.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A snapshot is a consistent copy made by the database itself (VACUUM INTO), never a file copy of a live WAL store.
//   2. Rolling snapshots are written at most every `min_interval_hours` and the oldest beyond `snapshots_kept` go; a copy
//      before a change or restore is kept in its own folder, so rolling retention never pushes it out.
//   3. A restore first takes a copy of what it is about to replace, and only then replaces the store; the old -wal and
//      -shm files go with the file they belonged to. A snapshot that is not a readable store is refused before anything
//      is replaced.
import { blake3 } from '@noble/hashes/blake3.js';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import settings from './local-store-safety.json' with { type: 'json' };

const stamp = at => new Date(at).toISOString().replace(/[:.]/g, '-');
const quoted = path => `'${path.replaceAll("'", "''")}'`;
// Oldest first: by the time each copy was written, its name (which begins with its time) settling a tie.
const listed = folder => (existsSync(folder)
  ? readdirSync(folder).filter(name => name.endsWith('.sqlite')).map(name => ({ name, at: statSync(join(folder, name)).mtimeMs }))
    .sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : 1)).map(entry => entry.name)
  : []);

function copyOf(db, folder, label, at, kept) {
  mkdirSync(folder, { recursive: true });
  const target = join(folder, `${stamp(at)}${label ? `-${label}` : ''}.sqlite`);
  if (!existsSync(target)) db.exec(`VACUUM INTO ${quoted(target)}`);
  const names = listed(folder);
  for (const old of names.slice(0, Math.max(0, names.length - kept))) unlinkSync(join(folder, old));
  return target;
}

/** A rolling snapshot of the open store if the last is older than the interval; its path, or null when none is due. */
export function snapshotIfDue(db, file, { now = Date.now, config = settings } = {}) {
  const folder = `${file}${config.folder_suffix}`;
  const last = listed(folder).at(-1);
  if (last && now() - statSync(join(folder, last)).mtimeMs < config.min_interval_hours * 3_600_000) return null;
  return copyOf(db, folder, '', now(), config.snapshots_kept);
}

/** A copy of the open store taken just before the store's shape changes (or anything else that cannot be undone). */
export function copyBeforeChange(db, file, label, { now = Date.now, config = settings } = {}) {
  return copyOf(db, `${file}${config.before_folder_suffix}`, String(label ?? '').replace(/[^a-z0-9._-]/gi, '-'), now(), config.before_change_kept);
}

/** The shape of the store as this code makes it: a positive 31-bit number from the BLAKE3 of the files that define its tables. */
export function shapeOf(config = settings) {
  const hash = blake3(Buffer.concat(config.shape_sources.map(path => readFileSync(new URL(path, import.meta.url)))));
  return (hash[0] * 2 ** 24 + hash[1] * 2 ** 16 + hash[2] * 2 ** 8 + hash[3]) % 0x7fffffff || 1;
}

/**
 * Before the code changes the shape of an existing store: when the file already holds tables and the shape kept in it
 * (user_version) is not this code's, a copy of the store is taken first. Returns that copy's path, or null when the
 * store is new or already in this shape.
 */
export function guardShape(db, file, shape, { now = Date.now, config = settings } = {}) {
  const kept = db.prepare('PRAGMA user_version').get().user_version;
  if (kept === shape || !db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' LIMIT 1").get()) return null;
  return copyBeforeChange(db, file, kept ? `shape-${kept}-to-${shape}` : `unstamped-to-${shape}`, { now, config });
}

/** Records the shape the store now has, once the code's changes to it have been made. */
export const stampShape = (db, shape) => { db.exec(`PRAGMA user_version = ${Number(shape)}`); };

/** The rolling snapshots of a store file, newest first. */
export const snapshotsOf = (file, config = settings) => listed(`${file}${config.folder_suffix}`).reverse().map(name => join(`${file}${config.folder_suffix}`, name));

/** Puts a snapshot back as the store file, after taking a copy of the store it replaces. The store must not be open. */
export function restoreSnapshot(file, snapshot, { now = Date.now, config = settings } = {}) {
  const probe = new DatabaseSync(snapshot, { readOnly: true });
  try { probe.prepare('PRAGMA schema_version').get(); } finally { probe.close(); }
  let before = null;
  if (existsSync(file)) {
    const live = new DatabaseSync(file);
    try { before = copyBeforeChange(live, file, 'restore', { now, config }); } finally { live.close(); }
  }
  const staged = join(dirname(file), `.${basename(file)}.restoring`);
  copyFileSync(snapshot, staged);
  renameSync(staged, file);
  for (const suffix of ['-wal', '-shm']) if (existsSync(file + suffix)) unlinkSync(file + suffix);
  return { restored: snapshot, before };
}
