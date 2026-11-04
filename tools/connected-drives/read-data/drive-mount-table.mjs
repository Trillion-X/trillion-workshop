// tools/connected-drives/read-data/drive-mount-table.mjs
//
// The second drive reader: a kernel mount table (mountinfo lines, as /proc/self/mountinfo gives them) on a place that
// has no diskutil. Only a mount of a block device (`/dev/...`) whose mount point lies strictly inside one of the
// reader's `mount_roots` is a connected drive; the system disk, which is mounted at `/`, never is. This reader has no
// icon and no safe eject, so every drive it lists answers `ejectable: false`.
import fs from 'node:fs';
import path from 'node:path';

// mountinfo escapes space, tab, newline and backslash in paths as three octal digits.
const unescape = text => text.replace(/\\([0-7]{3})/g, (_all, octal) => String.fromCharCode(parseInt(octal, 8)));

/** Each mount in mountinfo text: `{ mount, fstype, source, options }`. A line that is not mountinfo is skipped. */
export function parseMountTable(text) {
  const mounts = [];
  for (const line of String(text).split('\n')) {
    const fields = line.trim().split(' ');
    const dash = fields.indexOf('-');
    if (dash < 6 || fields.length < dash + 3) continue;
    mounts.push({ mount: unescape(fields[4]), options: fields[5].split(','), fstype: fields[dash + 1], source: unescape(fields[dash + 2]) });
  }
  return mounts;
}

const inside = (child, parent) => child !== parent && child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** The connected drives a mount table names, inside the reader's mount roots, one per real mount. */
export async function readMountTableDrives(reader, { readFile = file => fs.promises.readFile(file, 'utf8'), realpath = value => fs.promises.realpath(value), statVolume }) {
  let text;
  try { text = await readFile(reader.mount_table ?? reader.at); } catch { return []; }
  const roots = [];
  for (const root of reader.mount_roots ?? []) {
    try { roots.push(await realpath(root)); } catch {}
  }
  const devices = new Map();
  for (const entry of parseMountTable(text)) {
    if (!entry.source.startsWith('/dev/')) continue;
    let canonical;
    try { canonical = await realpath(entry.mount); } catch { continue; }
    if (canonical === path.sep || !roots.some(root => inside(canonical, root))) continue;
    if (devices.has(canonical)) continue;
    const device = {
      id: entry.mount, name: path.basename(entry.mount), mount: entry.mount, canonical_mount: canonical,
      ...(await statVolume(entry.mount)),
      internal: false, kind: 'Storage device', ejectable: false, file_system: entry.fstype,
      read_only: entry.options.includes('ro'), reader: reader.id,
    };
    devices.set(canonical, device);
  }
  return [...devices.values()];
}
