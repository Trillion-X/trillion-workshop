// tools/connected-drives/read-data/drive-folder.mjs
//
// Purpose: what is inside one folder on a connected drive, a page at a time, and the one check every drive route uses
// to decide that a path really is on a connected drive.
//
//   await driveOf(target, devices)  -> { real, mount, device } | null
//     `devices` is enumerateDevices(); the system disk (internal) is never a drive here. The real path of `target`
//     (every symlink resolved) must be the real path of a drive's mount or lie inside it.
//   await listFolder({ target, devices, offset, limit, hidden })
//     -> { path, name, parent, mount, entries: [{ name, path, kind, file_kind, bytes, modified_at }], total, has_more }
//     Folders first, then files, each by name as Finder orders them (numbers in names compare as numbers). Names that
//     start with a dot are left out unless `hidden`. Only the entries of the page asked for are measured. `parent` is
//     null at the drive's own top folder. A folder that is itself one document (a Final Cut library, an app) carries
//     the kind file-kinds.json gives its extension.
//
// Errors carry `status` (403 outside every drive, 404 missing, 400 not a folder) and a message the person can read.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { folderKindOf, kindOf } from './file-kinds.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

export async function driveOf(target, devices) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return null;
  let real;
  try { real = await fsp.realpath(target); } catch { return null; }
  for (const device of devices) {
    if (!device.mount || device.internal) continue;
    let mount;
    try { mount = await fsp.realpath(device.mount); } catch { continue; }
    if (mount !== path.sep && within(real, mount)) return { real, mount, device };
  }
  return null;
}

const byName = (left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });

export async function listFolder({ target, devices, offset = 0, limit = 200, hidden = false }) {
  try { await fsp.stat(target); } catch { throw fail(404, 'This folder is not there any more.'); }
  const found = await driveOf(target, devices);
  if (!found) throw fail(403, 'This folder is not on a connected drive.');
  if (!(await fsp.stat(found.real)).isDirectory()) throw fail(400, 'This is a file, not a folder.');
  const start = Math.max(0, Number.parseInt(offset, 10) || 0), count = Math.min(1000, Math.max(1, Number.parseInt(limit, 10) || 200));
  const names = (await fsp.readdir(found.real, { withFileTypes: true })).filter(entry => hidden || !entry.name.startsWith('.'));
  const folders = names.filter(entry => entry.isDirectory()).sort(byName), files = names.filter(entry => !entry.isDirectory()).sort(byName);
  const page = [...folders, ...files].slice(start, start + count);
  const entries = await Promise.all(page.map(async entry => {
    const full = path.join(found.real, entry.name);
    const stat = await fsp.lstat(full).catch(() => null);
    const folder = entry.isDirectory();
    return { name: entry.name, path: full, kind: folder ? 'folder' : 'file', file_kind: folder ? folderKindOf(entry.name) : kindOf(entry.name), bytes: folder || !stat ? null : stat.size, modified_at: stat ? stat.mtime.toISOString() : null };
  }));
  return {
    path: found.real,
    name: found.real === found.mount ? found.device.name : path.basename(found.real),
    parent: found.real === found.mount ? null : path.dirname(found.real),
    mount: found.device.mount,
    entries,
    total: names.length,
    has_more: start + page.length < names.length,
  };
}
