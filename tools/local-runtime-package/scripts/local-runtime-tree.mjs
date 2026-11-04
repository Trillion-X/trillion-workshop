// Bounded file-tree identity shared by packaging and artifact readers.
// This module does not load runtime builders, host settings, or account state.
import fs from 'node:fs';
import path from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';

const hex = bytes => Buffer.from(bytes).toString('hex');
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

/** Copy a caller-bounded artifact tree without letting the process umask
 * change its qualified permission bits. Callers retain their source/output
 * identity and custody checks; this does not grant a source authority. */
export function copyLocalRuntimeTree(source, target, rules) {
  if (!rules || !['max_files', 'max_bytes'].every(name => Number.isSafeInteger(rules[name]) && rules[name] >= 0))
    throw new Error('The file tree needs finite nonnegative bounds.');
  fs.cpSync(source, target, {recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false});
  let entries = 0, bytes = 0;
  const restore = relative => {
    const from = path.join(source, relative), to = path.join(target, relative);
    const original = fs.lstatSync(from), copied = fs.lstatSync(to);
    if (relative && ++entries > rules.max_files) throw new Error('The local runtime package exceeds its file bound.');
    const mode = original.mode & 0o777;
    if (original.isSymbolicLink() && copied.isSymbolicLink()) {
      if (fs.readlinkSync(from) !== fs.readlinkSync(to)) throw new Error('The copied artifact link changed.');
      if ((copied.mode & 0o777) !== mode) {
        if (typeof fs.lchmodSync !== 'function') throw new Error('The copied artifact link mode cannot be preserved.');
        fs.lchmodSync(to, mode);
      }
    } else if (original.isDirectory() && copied.isDirectory()) {
      fs.chmodSync(to, mode);
      for (const name of fs.readdirSync(from).sort()) restore(path.join(relative, name));
    } else if (original.isFile() && copied.isFile()) {
      bytes += original.size;
      if (!Number.isSafeInteger(bytes) || bytes > rules.max_bytes) throw new Error('The local runtime package exceeds its byte bound.');
      fs.chmodSync(to, mode);
    } else throw new Error('The copied artifact entry type changed.');
  };
  restore('');
}

/** Bounded, streaming identities and links confined to the package. No private
 * file contents enter a receipt. Signatures are handled later by CarriedCode. */
export function localRuntimeTree(root, rules, selected = fs.readdirSync(root)) {
  if (!rules || !['max_files', 'max_bytes'].every(name => Number.isSafeInteger(rules[name]) && rules[name] >= 0))
    throw new Error('The file tree needs finite nonnegative bounds.');
  if (!Array.isArray(selected) || selected.some(name => typeof name !== 'string' || !name || name.includes('\0')
    || path.isAbsolute(name) || name.split(path.sep).some(part => !part || part === '.' || part === '..')))
    throw new Error('The file tree selection must stay inside its root.');
  root = fs.realpathSync(root);
  const hasher = blake3.create(); let files = 0, bytes = 0;
  const walk = relative => {
    const full = path.join(root, relative), stat = fs.lstatSync(full);
    if (++files > rules.max_files) throw new Error('The local runtime package exceeds its file bound.');
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(full);
      if (path.isAbsolute(target) || !inside(root, path.resolve(path.dirname(full), target))
        || !inside(root, fs.realpathSync(full))) throw new Error('The local runtime package contains an escaping link.');
      hasher.update(Buffer.from(JSON.stringify([relative, 'link', mode, target]) + '\n'));
    } else if (stat.isDirectory()) {
      hasher.update(Buffer.from(JSON.stringify([relative, 'directory', mode]) + '\n'));
      for (const name of fs.readdirSync(full).sort()) walk(path.join(relative, name));
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (!Number.isSafeInteger(bytes) || bytes > rules.max_bytes) throw new Error('The local runtime package exceeds its byte bound.');
      const hash = blake3.create(), piece = Buffer.alloc(1 << 20), handle = fs.openSync(full, 'r');
      try { for (let n; (n = fs.readSync(handle, piece, 0, piece.length, null)) > 0;) hash.update(piece.subarray(0, n)); }
      finally { fs.closeSync(handle); }
      hasher.update(Buffer.from(JSON.stringify([relative, 'file', mode, stat.size, hex(hash.digest())]) + '\n'));
    } else throw new Error('The local runtime package contains a non-file entry.');
  };
  for (const name of [...selected].sort()) walk(name);
  return { identity: hex(hasher.digest()), entries: files, bytes };
}
