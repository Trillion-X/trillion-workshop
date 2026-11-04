// tools/conversations/read-data/json-array-stream.mjs
//
// The elements of the JSON array a file holds, read a piece at a time, so a ChatGPT conversations.json of several
// gigabytes is kept one conversation at a time without ever being in memory whole (a JavaScript string cannot hold
// more than about 500 MB, so JSON.parse of the whole file fails long before memory does).
//
// It reads bytes, not characters: the bytes it looks at ([ ] { } " \ and ,) never occur inside a multi-byte UTF-8
// character, so an element's bytes are cut out exactly and decoded on their own. Each element is handed over as its
// bytes with the byte offset just past it, so a run that stops can start again at that offset (`at`) without reading
// what came before.
import { closeSync, openSync, readSync } from 'node:fs';

export class NotAJsonArray extends Error {}

const SPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const BOM = [0xef, 0xbb, 0xbf];

/** The first byte of the file that is not a byte-order mark or white space, or null for an empty file. */
export function firstByteOf(path) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    let position = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (!read) return null;
      for (let index = 0; index < read; index += 1) {
        const byte = buffer[index];
        if (position + index < 3 && byte === BOM[position + index]) continue;
        if (!SPACE.has(byte)) return byte;
      }
      position += read;
    }
  } finally { closeSync(fd); }
}

/**
 * Yields { bytes, end } for each element of the top-level JSON array in the file at `path`: bytes is a Buffer of that
 * element's JSON (an object or an array), end the byte offset just past it. `at`, an end an earlier read gave, starts
 * inside the array just after that element. Throws NotAJsonArray when the file is not an array of objects or arrays, or
 * ends inside one.
 */
export function* jsonArrayElements(path, { at = null, piece_bytes: pieceBytes = 1 << 20 } = {}) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(pieceBytes);
    let position = at ?? 0;
    let inArray = at !== null;
    let start = -1;          // where the element being read starts in `buffer` (-1: between elements)
    let parts = [];          // its bytes from earlier pieces
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (;;) {
      const read = readSync(fd, buffer, 0, pieceBytes, position);
      if (!read) break;
      for (let index = 0; index < read; index += 1) {
        const byte = buffer[index];
        if (!inArray) {
          if (byte === 0x5b) inArray = true;
          else if (!SPACE.has(byte) && !(position + index < 3 && byte === BOM[position + index])) throw new NotAJsonArray('The file is not a JSON array.');
          continue;
        }
        if (start < 0 && parts.length === 0) {
          if (SPACE.has(byte) || byte === 0x2c) continue;
          if (byte === 0x5d) return;
          if (byte !== 0x7b && byte !== 0x5b) throw new NotAJsonArray(`The array holds something other than objects at byte ${position + index}.`);
          start = index; depth = 0; inString = false; escaped = false;
        }
        if (inString) {
          if (escaped) escaped = false;
          else if (byte === 0x5c) escaped = true;
          else if (byte === 0x22) inString = false;
          continue;
        }
        if (byte === 0x22) inString = true;
        else if (byte === 0x7b || byte === 0x5b) depth += 1;
        else if (byte === 0x7d || byte === 0x5d) {
          depth -= 1;
          if (depth === 0) {
            const tail = buffer.subarray(start < 0 ? 0 : start, index + 1);
            const bytes = parts.length ? Buffer.concat([...parts, tail]) : Buffer.from(tail);
            parts = []; start = -1;
            yield { bytes, end: position + index + 1 };
          }
        }
      }
      if (start >= 0 || parts.length) { parts.push(Buffer.from(buffer.subarray(start < 0 ? 0 : start, read))); start = -1; }
      position += read;
    }
    throw new NotAJsonArray(inArray ? 'The file ends inside its array.' : 'The file is not a JSON array.');
  } finally { closeSync(fd); }
}
