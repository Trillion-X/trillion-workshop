// tools/work-on-connected-drives/read-data/drive-inventory.mjs
//
// Purpose: what is on a drive, by kind (Videos, Audio, Pictures, ...), how much of each, and its largest files.
//
// Two halves in one file:
//   - the walk, run as its own utility-priority process so the server never waits on a drive:
//       node drive-inventory.mjs --mount <folder> --out <folder>/<key>.json
//     It walks every file under the mount (never following a symlink, skipping the system folders file-kinds.json
//     lists), writes <key>.progress.json ({ files_seen, updated_at }) about once a second while reading, and at the end
//     writes <key>.json atomically:
//       { mount, read_at, files, bytes, kinds: [{ kind, label, files, bytes }], largest: [{ path, bytes }] }
//     <key>.lock holds its pid while it runs, so one drive is read by one walk at a time.
//   - createDriveInventory({ folder, spawnWalk }): the server's reader. read(device) returns the kept result with its
//     state (ready | reading | not-read) and progress while reading, and starts a walk when there is no result or the
//     kept one is older than `maxAgeMs` (6 hours).
//
// A drive's key is its name and size (BLAKE3 of both), which stay the same across unplugging and plugging back in,
// where its device number does not.
//
// Invariants:
// - Nothing here lists an extension or a kind: both come from file-kinds.json.
// - The route never walks: it reads files this walk wrote.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { blake3 } from '@noble/hashes/blake3.js';
import { fileKinds, kindOf, kindLabel } from '../../connected-drives/read-data/file-kinds.mjs';
import { isAlive, readPid } from './work-control.mjs';

const LARGEST = 10;
const PROGRESS_EVERY_MS = 1000;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const WALKER = fileURLToPath(new URL('./drive-inventory.mjs', import.meta.url));

export const inventoryKey = device => Buffer.from(blake3(Buffer.from(`${device.name}\0${device.size_bytes ?? ''}`))).toString('hex').slice(0, 32);

async function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.partial`;
  await fsp.writeFile(temporary, JSON.stringify(value));
  await fsp.rename(temporary, file);
}

/** Walks `mount` and returns the inventory. `onProgress(files_seen)` is called at most once a second. */
export async function walkDrive(mount, { onProgress = () => {} } = {}) {
  const skip = new Set(fileKinds.skip_folders);
  const totals = new Map();
  const largest = [];
  let files = 0, bytes = 0, reportedAt = 0;
  const folders = [mount];
  while (folders.length) {
    const folder = folders.pop();
    let directory;
    try { directory = await fsp.opendir(folder); } catch { continue; }
    try {
      for await (const entry of directory) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) { if (!(folder === mount && skip.has(entry.name))) folders.push(full); continue; }
        if (!entry.isFile()) continue;
        let size;
        try { size = (await fsp.lstat(full)).size; } catch { continue; }
        files += 1; bytes += size;
        const kind = kindOf(entry.name);
        const row = totals.get(kind) ?? { kind, label: kindLabel(kind), files: 0, bytes: 0 };
        row.files += 1; row.bytes += size;
        totals.set(kind, row);
        if (largest.length < LARGEST || size > largest[largest.length - 1].bytes) {
          largest.push({ path: full, bytes: size });
          largest.sort((left, right) => right.bytes - left.bytes);
          if (largest.length > LARGEST) largest.pop();
        }
        if (Date.now() - reportedAt >= PROGRESS_EVERY_MS) { reportedAt = Date.now(); await onProgress(files); }
      }
    } catch {}
  }
  return { mount, read_at: new Date().toISOString(), files, bytes, kinds: [...totals.values()].sort((left, right) => right.bytes - left.bytes), largest };
}

export function createDriveInventory({ folder, maxAgeMs = MAX_AGE_MS, spawnWalk = defaultSpawnWalk }) {
  const paths = key => ({ result: path.join(folder, `${key}.json`), progress: path.join(folder, `${key}.progress.json`), lock: `${key}.lock` });
  const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

  function read(device) {
    const key = inventoryKey(device), files = paths(key);
    const kept = readJson(files.result);
    let reading = isAlive(readPid(folder, files.lock));
    if (!reading && (!kept || Date.now() - Date.parse(kept.read_at) > maxAgeMs)) {
      fs.mkdirSync(folder, { recursive: true });
      reading = spawnWalk({ mount: device.mount, out: files.result, lock: path.join(folder, files.lock) });
    }
    const progress = reading ? readJson(files.progress) : null;
    return {
      mount: device.mount,
      state: reading ? 'reading' : kept ? 'ready' : 'not-read',
      read_at: kept?.read_at ?? null,
      files: kept?.files ?? null,
      bytes: kept?.bytes ?? null,
      kinds: kept?.kinds ?? [],
      largest: kept?.largest ?? [],
      progress: reading ? { files_seen: Number.isInteger(progress?.files_seen) ? progress.files_seen : 0 } : null,
    };
  }
  return { read };
}

// Starts the walk detached at utility priority; the walk writes its own lock, so the answer is "started".
function defaultSpawnWalk({ mount, out, lock }) {
  try {
    fs.writeFileSync(lock, '0');
    const child = spawn('/usr/sbin/taskpolicy', ['-c', 'utility', process.execPath, WALKER, '--mount', mount, '--out', out], { detached: true, stdio: 'ignore' });
    child.unref();
    fs.writeFileSync(lock, String(child.pid));
    return true;
  } catch { return false; }
}

async function main() {
  const argv = process.argv.slice(2);
  const option = name => { const at = argv.indexOf(name); if (at < 0) throw new Error(`${name} is required`); return argv[at + 1]; };
  const mount = option('--mount'), out = option('--out');
  const lock = out.replace(/\.json$/, '.lock'), progressFile = out.replace(/\.json$/, '.progress.json');
  await fsp.writeFile(lock, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(lock); } catch {} try { fs.unlinkSync(progressFile); } catch {} });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
  const result = await walkDrive(mount, { onProgress: files_seen => writeAtomic(progressFile, { files_seen, updated_at: new Date().toISOString() }) });
  await writeAtomic(out, result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
