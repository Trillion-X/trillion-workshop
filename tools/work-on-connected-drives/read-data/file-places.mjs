// computer/drive-tools/file-places.mjs
//
// Finds every connected-drive path and Trillion-space name that holds the same bytes as one file. This is a
// deliberately read-only projection: copy/move is owned by file-transfer.mjs, and archive/delete/restore is owned by
// namespace-set-aside.mjs. It never changes either surface. A partial filesystem read is reported, never presented as
// a complete answer.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const fail = (status, message) => Object.assign(new Error(message), { status });
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

async function connectedDevices() {
  const { enumerateDevices } = await import('./drives.mjs');
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

async function namespaceFile(identity, { origin, key } = {}) {
  if (!origin || !key) throw fail(401, 'This Mac is not connected to its Trillion space.');
  const response = await fetch(`${origin.replace(/\/$/, '')}/mcp/api/namespace/files/${encodeURIComponent(identity)}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (response.status === 404) return null;
  let answer = null;
  try { answer = await response.json(); } catch {}
  if (!response.ok) throw fail(response.status, answer?.error ?? `The Trillion space answered ${response.status}.`);
  return answer;
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

export function createFilePlaces({ devices = connectedDevices, identityOf = contentIdentity, candidates = scanSameSize, lookup = namespaceFile } = {}) {
  return async function places({ path: asked } = {}, context = {}) {
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

    const cloud = await lookup(identity, context);
    const places = [...local.sort((a, b) => a.path.localeCompare(b.path))];
    if (cloud) places.push({ kind: 'trillion-space', identity: cloud.identity ?? identity, names: Array.isArray(cloud.names) ? cloud.names : [] });
    return {
      path: source.real,
      identity,
      byte_length: stat.size,
      places,
      complete: unreadable.length === 0,
      ...(unreadable.length ? { unreadable: unreadable.slice(0, 100), unreadable_more: Math.max(0, unreadable.length - 100) } : {}),
    };
  };
}

export const filePlaceTools = { places: createFilePlaces() };
