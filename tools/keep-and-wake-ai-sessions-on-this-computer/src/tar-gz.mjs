// A gzipped tar of named files, byte for byte the same for the same files: sorted names, zero times and owners, so the
// same files always have the same BLAKE3 identity. Used by the deploy to bundle a shared tool's package files, and by
// the Workshop to keep a tool an AI sends as plain text files. Runs in Node and in the Worker (nodejs_compat).
import { Buffer } from 'node:buffer';
import { gunzipSync, gzipSync } from 'node:zlib';

const BLOCK = 512;

function field(header, offset, length, text) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > length) throw new Error(`"${text}" does not fit a ${length}-byte tar field.`);
  bytes.copy(header, offset);
}
const octal = (value, length) => `${value.toString(8).padStart(length - 1, '0')}\0`;

// One ustar header. A name longer than 100 bytes is split at a slash into prefix (155) and name (100).
function header(name, size, mode) {
  const block = Buffer.alloc(BLOCK);
  let prefix = '';
  let rest = name;
  if (Buffer.byteLength(name) > 100) {
    const at = [...name.matchAll(/\//g)].map(match => match.index).find(index => Buffer.byteLength(name.slice(index + 1)) <= 100 && Buffer.byteLength(name.slice(0, index)) <= 155);
    if (at === undefined) throw new Error(`${name} is too long for a tar name.`);
    prefix = name.slice(0, at);
    rest = name.slice(at + 1);
  }
  field(block, 0, 100, rest);
  field(block, 100, 8, octal(mode, 8));
  field(block, 108, 8, octal(0, 8));
  field(block, 116, 8, octal(0, 8));
  field(block, 124, 12, octal(size, 12));
  field(block, 136, 12, octal(0, 12));
  block.fill(0x20, 148, 156);
  field(block, 156, 1, '0');
  field(block, 257, 6, 'ustar\0');
  field(block, 263, 2, '00');
  field(block, 345, 155, prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  field(block, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

/** A gzipped tar of `entries` ({ name, bytes, executable }), in name order, with no times or owners in it. */
export function tarGz(entries) {
  const parts = [];
  for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    parts.push(header(entry.name, entry.bytes.length, entry.executable ? 0o755 : 0o644), entry.bytes);
    const pad = (BLOCK - (entry.bytes.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  // Level 6: 1% larger than level 9 and four times faster on the shipped tool bundles (16.5 s to 3.6 s for 21 bundles,
  // paid on every deploy and every simulated store).
  return new Uint8Array(gzipSync(Buffer.concat(parts), { level: 6 }));
}

/** The files in a gzipped tar: { name, size, text } where text is the file's UTF-8 text, or null for other bytes; with
 *  `withBytes` each also carries its exact `bytes`, for a caller that writes the files out. */
export function untarGz(bytes, { withBytes = false, maxBytes } = {}) {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new TypeError('Archive maxBytes must be a positive integer.');
  const tar = gunzipSync(Buffer.from(bytes), maxBytes === undefined ? {} : { maxOutputLength: maxBytes });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const cut = (offset, length) => tar.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/s, '');
  const files = [];
  // A pax extended header ('x') names the next entry's whole path when it is too long for the ustar fields, as git
  // archives write them; a global one ('g') says nothing about any one file.
  let paxPath = null;
  for (let at = 0; at + BLOCK <= tar.length;) {
    const name = cut(at, 100);
    if (!name) break;
    const size = parseInt(cut(at + 124, 12).trim() || '0', 8);
    if (maxBytes !== undefined && (!Number.isSafeInteger(size) || size < 0 || at + BLOCK + size > tar.length)) throw new Error('The archive has an invalid or truncated file.');
    const prefix = cut(at + 345, 155);
    const type = cut(at + 156, 1);
    const body = tar.subarray(at + BLOCK, at + BLOCK + size);
    if (type === 'x') {
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? null;
    } else if (type === '0' || type === '') {
      let text = null;
      try { text = decoder.decode(body); } catch {}
      files.push({ name: paxPath ?? (prefix ? `${prefix}/${name}` : name), size, text, ...(withBytes ? { bytes: new Uint8Array(body) } : {}) });
      paxPath = null;
    } else if (type !== 'g') {
      paxPath = null;
    }
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
