// tools/content-identity/read-data/manifest.mjs
//
// The identity of a folder of files: the engine's manifest identity (trillion-rust src/tool_runs/tools/install.rs
// `manifest_identity`), BLAKE3 of the JSON text of {path: BLAKE3 hex of the file's bytes}, keys in byte order, no spaces,
// written as bare 64 hex (the engine's pin format), and the regular files of a tar archive that `git archive` makes.
// Moved here from tools/workflows/do-work/pin-a-commit-by-its-files.mjs so the pin of a commit, a registry pointer's
// files_blake3 and a project's record of a copied tool folder are one identity from one owner.
//
// Non-Negotiable Invariants:
// - Keys are compared as UTF-8 bytes, never as numbers or by locale, so a name that looks like a number is not moved first.
// - A file's digest is bare 64 hex (no `1f:`): this is the engine's pin text, read by every record file and registry pointer (the engine's tools:update that once read it is deleted with its install, Nov 28 2026).
// - Pure: no file, account or network operation; a reader hands in bytes or digests.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import { blake3 } from './blake3.mjs';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * The bare 64 hex BLAKE3 of one file's bytes, as a manifest names it.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function fileDigest(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('A file digest requires bytes.');
  return bytesToHex(blake3(bytes));
}

/**
 * The regular files of a tar archive (ustar, with pax `x` and GNU `L` long names), as [path, bytes].
 * @param {Buffer} archive
 * @returns {Array<[string, Buffer]>}
 */
export function tarFiles(archive) {
  /** @type {Array<[string, Buffer]>} */
  const files = [];
  let longName = null;
  for (let at = 0; at + 512 <= archive.length;) {
    const header = archive.subarray(at, at + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (from, length) => header.subarray(from, from + length).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(text(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = archive.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'L') {
      const named = type === 'L' ? body.toString('utf8').replace(/\0.*$/s, '')
        : body.toString('utf8').split('\n').map(line => line.match(/^\d+ path=(.*)$/s)?.[1]).find(Boolean);
      longName = named ?? longName;
      continue;
    }
    if (type === 'g') continue;
    const prefix = text(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
    longName = null;
    if (type === '0') files.push([name, Buffer.from(body)]);
  }
  return files;
}

/**
 * The manifest identity of {path: digest}: BLAKE3 of the map as JSON text, keys in byte order. A path named twice is refused.
 * @param {Record<string, string> | Array<[string, string]>} digests
 * @returns {string}
 */
export function identityOfDigests(digests) {
  const entries = Array.isArray(digests) ? digests : Object.entries(digests);
  const seen = new Set();
  for (const [path] of entries) {
    if (seen.has(path)) throw new Error(`The path ${JSON.stringify(path)} is named twice; a manifest names each file once.`);
    seen.add(path);
  }
  const sorted = [...entries].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const text = `{${sorted.map(([path, digest]) => `${JSON.stringify(path)}:${JSON.stringify(digest)}`).join(',')}}`;
  return bytesToHex(blake3(new TextEncoder().encode(text)));
}

/**
 * The engine's manifest identity of `files` ([path, bytes]): BLAKE3 of {path: BLAKE3 hex} as JSON text, keys in byte order.
 * @param {Array<[string, Uint8Array]>} files
 * @returns {string}
 */
export function manifestIdentity(files) {
  return identityOfDigests(files.map(([path, bytes]) => [path, fileDigest(bytes)]));
}
