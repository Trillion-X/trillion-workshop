// tools/work-on-connected-drives/read-data/file-places.mjs
//
// Finds every connected-drive path and every name in the person's own files that holds the same bytes as one file. The
// person's files are what the run is handed in `input.stored.files` ({ name: text | { base64 } | { text } | { identity } }),
// read by the caller from where the person keeps them; a name matches when its bytes have the file's BLAKE3 identity. This is
// a deliberately read-only projection: copy/move is owned by file-transfer.mjs, and archive/delete/restore is owned by
// namespace-set-aside.mjs. It never changes either surface and keeps nothing. A partial read (a folder it could not read,
// or no files handed in) is reported, never presented as a complete answer.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

async function connectedDevices() {
  const { enumerateDevices } = await import('../../connected-drives/read-data/drives.mjs');
  return (await enumerateDevices()).filter(device => device.mount && !device.internal);
}

async function onDrive(target, devices) {
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

async function contentIdentity(file) {
  const { blake3 } = await import('@noble/hashes/blake3.js');
  const hash = blake3.create();
  const before = await fsp.stat(file);
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(file, { highWaterMark: 8 * 1024 * 1024 });
    input.on('data', chunk => hash.update(chunk));
    input.on('error', reject);
    input.on('end', resolve);
  });
  const after = await fsp.stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw fail(409, `${path.basename(file)} changed while it was being read. Try again when it is no longer changing.`);
  return `1f:${Buffer.from(hash.digest()).toString('hex')}`;
}

// The names among the person's files it was handed whose bytes have this identity; null when it was handed no files.
function namesInStored(identity, { stored } = {}) {
  const files = stored?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) return null;
  const identityOfHeld = held => (typeof held === 'string' ? makeHashCodeHexFromBytes(Buffer.from(held, 'utf8'))
    : !held || typeof held !== 'object' ? null
    : typeof held.identity === 'string' ? held.identity
    : held.text !== undefined ? makeHashCodeHexFromBytes(Buffer.from(String(held.text), 'utf8'))
    : typeof held.base64 === 'string' ? makeHashCodeHexFromBytes(Buffer.from(held.base64, 'base64')) : null);
  return Object.entries(files).filter(([, held]) => identityOfHeld(held) === identity).map(([name]) => name).sort();
}

async function scanSameSize(devices, size) {
  const paths = [], unreadable = [];
  async function walk(folder) {
    let entries;
    try { entries = await fsp.readdir(folder, { withFileTypes: true }); }
    catch (error) { unreadable.push({ path: folder, error: error.code ?? error.message }); return; }
    for (const entry of entries) {
      const target = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) {
        try { if ((await fsp.stat(target)).size === size) paths.push(target); }
        catch (error) { unreadable.push({ path: target, error: error.code ?? error.message }); }
      }
    }
  }
  for (const device of devices) await walk(device.mount);
  return { paths, unreadable };
}

export function createFilePlaces({ devices = connectedDevices, identityOf = contentIdentity, candidates = scanSameSize, lookup = namesInStored } = {}) {
  return async function places({ path: asked, stored } = {}) {
    const current = await devices();
    const source = await onDrive(String(asked ?? ''), current);
    if (!source) throw fail(403, 'This file is not on a connected drive.');
    const stat = await fsp.stat(source.real);
    if (!stat.isFile()) throw fail(400, 'Choose one file, not a folder.');

    const identity = await identityOf(source.real);
    const found = await candidates(current, stat.size);
    const unreadable = [...(found.unreadable ?? [])];
    const local = [];
    for (const candidate of new Set([source.real, ...(found.paths ?? [])])) {
      let real;
      try { real = await fsp.realpath(candidate); } catch (error) { unreadable.push({ path: candidate, error: error.code ?? error.message }); continue; }
      try {
        if (await identityOf(real) !== identity) continue;
        const drive = await onDrive(real, current);
        if (drive) local.push({ kind: 'drive', path: real, mount: drive.mount, drive: drive.device.name ?? path.basename(drive.mount) });
      } catch (error) { unreadable.push({ path: real, error: error.code ?? error.message }); }
    }

    const names = await lookup(identity, { stored });
    const places = [...local.sort((a, b) => a.path.localeCompare(b.path))];
    if (names?.length) places.push({ kind: 'own-files', identity, names });
    return {
      path: source.real,
      identity,
      byte_length: stat.size,
      places,
      complete: unreadable.length === 0 && names !== null,
      ...(names === null ? { files_not_given: true } : {}),
      ...(unreadable.length ? { unreadable: unreadable.slice(0, 100), unreadable_more: Math.max(0, unreadable.length - 100) } : {}),
    };
  };
}

export const filePlaceTools = { places: createFilePlaces() };
// The row's runner calls it by this name, as fn(input); the person's files are input.stored.files (what-this-tool-does-and-how-to-run-it.json `stored`).
export const findEveryPlaceAFileIs = (input = {}) => filePlaceTools.places(input);
