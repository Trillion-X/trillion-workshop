// tools/connected-drives/read-data/drive-cache.mjs
//
// The three things a drive keeps between asks, ported from the Mac's drive tools (computer/drive-tools at b6ae0ebf815f's
// parent of 3239bd7fb7, drive-icon.mjs and drive-inventory.mjs):
//   1. The icon Finder shows for one drive, drawn once per exact volume and size, kept under <key>-<size>.png.
//   2. The walk's progress file, <key>.progress.json, written about once a second while a walk reads, and removed when it ends.
//   3. The walk's lock, <key>.lock, holding the pid of the walk, so one drive is read by one walk at a time.
// The key names the exact volume (its device identifier, or name, and its mount folder's device and inode numbers), so a
// different drive mounted at the same place is drawn and walked afresh. Files are written through a temporary name and renamed.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** The key of one exact volume: its name or device identifier with its mount folder's device and inode numbers. */
export function volumeKey({ identifier, name, dev, ino }) {
  return `${String(identifier || name || 'drive').replace(/[^A-Za-z0-9._-]/g, '-')}-${dev}-${ino}`;
}

const safeName = key => String(key).replace(/[^A-Za-z0-9._-]/g, '-');

/** The square icon size a drive may be drawn at, 32 to 512 whole pixels; anything else is refused before anything runs. */
export function iconSize(value, { smallest = 32, largest = 512, usual = 256 } = {}) {
  const size = value === null || value === undefined || value === '' ? usual : Number(value);
  return Number.isInteger(size) && size >= smallest && size <= largest ? size : null;
}

/** A PNG drawn once per exact volume and size. `draw(mount, size, outFile)` draws it; a kept drawing is read back as is. */
export function createIconCache({ folder, draw }) {
  async function png({ mount, key, size }) {
    const cached = path.join(folder, `${safeName(key)}-${size}.png`);
    try { return await fsp.readFile(cached); } catch {}
    fs.mkdirSync(folder, { recursive: true });
    const partial = `${cached}.${process.pid}.partial.png`;
    await draw(mount, size, partial);
    await fsp.rename(partial, cached);
    return fsp.readFile(cached);
  }
  return { png };
}

const writeAtomic = async (file, value) => {
  const partial = `${file}.${process.pid}.partial`;
  await fsp.writeFile(partial, JSON.stringify(value));
  await fsp.rename(partial, file);
};

const isAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

/** The walk of one drive, run through `walk(mount, { onProgress })` (the caller's walk: walkDrive). It holds the drive's lock
 *  while it runs; a second ask while a walk holds it is refused as already reading, and a stale lock (its pid gone) is taken over. */
export function createDriveWalks({ folder, walk }) {
  const paths = key => ({
    result: path.join(folder, `${safeName(key)}.json`),
    progress: path.join(folder, `${safeName(key)}.progress.json`),
    lock: path.join(folder, `${safeName(key)}.lock`),
  });
  async function readPid(lockFile) {
    try { return Number((await fsp.readFile(lockFile, 'utf8')).trim()); } catch { return null; }
  }
  /** Walks the drive if no walk holds its lock. Returns { reading: true } while another walk holds it, otherwise the walk's result. */
  async function read(mount, key) {
    const files = paths(key);
    fs.mkdirSync(folder, { recursive: true });
    if (isAlive(await readPid(files.lock))) return { reading: true, progress: await progressOf(files.progress) };
    await fsp.writeFile(files.lock, String(process.pid));
    try {
      const result = await walk(mount, { onProgress: files_seen => writeAtomic(files.progress, { files_seen, updated_at: new Date().toISOString() }) });
      await writeAtomic(files.result, result);
      return result;
    } finally {
      await fsp.rm(files.progress, { force: true });
      await fsp.rm(files.lock, { force: true });
    }
  }
  async function progressOf(file) {
    try { const value = JSON.parse(await fsp.readFile(file, 'utf8')); return { files_seen: Number.isInteger(value.files_seen) ? value.files_seen : 0 }; } catch { return { files_seen: 0 }; }
  }
  return { read, paths };
}

/** A short stable digest of a key, for a log line or test name. */
export const keyDigest = key => createHash('sha256').update(String(key)).digest('hex').slice(0, 12);
