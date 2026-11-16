// tools/check-against-a-persons-rules-and-verdicts/do-work/pieces.mjs
//
// Purpose
//   The row for each piece of a document, shaped for the person's one Checks list (list:checks, row type `check`,
//   `kind: "piece"`), so every check can name the exact piece it came from. This file keeps nothing: the person's AI
//   keeps the rows. The pieces themselves are old trillion's
//   scripts/method-atoms.mjs `atomsOf`, which has one home: tools/documents-as-list-rows/read-data/atoms.mjs (ported
//   there in #104); it is imported, never copied. A piece is one paragraph, list item, table row or fenced block under
//   its headings; its key is the heading path plus its lead; its identity is "1f:" + the BLAKE3 of its
//   whitespace-folded text.
//
// Non-negotiable invariants
//   1. A piece row's id is "piece-" + the first 24 hex of its identity: the same words are the same row wherever they
//      stand, never one row per file and never a byte slice.
//   2. Two files (or two places of one file) holding the same text are one row with one source for each place.
//   3. Nothing here names a person, a file or a check: the caller passes the text and where it came from.
//
// Shapes
//   atomsOf(markdown) -> [{ key, heading_path, text, identity, line }]          (re-exported from its home)
//   pieceRow(atom, { file?, file_identity? }) -> { id, kind: "piece", says, text, identity, key,
//     sources: [{ file, section, file_identity, at }], tags: [], kinds: [], checked_by: [] }
//     section: the piece's key in that file; at: the line of that file where the piece starts
//   pieceRows([{ text, file?, file_identity? }]) -> piece rows, one per identity, sources in reading order
//   splitIntoPieces({ text? | name?, file?, file_identity?, after?, most_bytes? }, door) -> { file, file_identity, total, pieces, next,
//     too_large, lines }
//
// Splitting a whole file in one call (tool:split-a-document-into-pieces)
//   4. The document comes as `text`, or by reference as `name`, one of the person's files read through the run's files
//      door (read_file, page after page, every page of the same identity), so a file larger than one request body
//      (the door refuses bodies over 64 KiB) is never sent in one.
//   5. The answer holds the piece rows (one per identity, a repeated text a second source of its row) and keeps nothing:
//      the person's AI keeps them in whatever store it chooses. Nothing is read from or written to the person's rows.
//   6. A run's answer is carried twice in one 65,536-byte door message (the pieces of a 31 KB file are about 280 KB of
//      JSON), so the pieces come a page per call, `after` the last id of the page before, each page within `most_bytes`.
import { atomsOf, lead } from '../../documents-as-list-rows/read-data/atoms.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import SETTINGS from '../read-data/pieces.json' with { type: 'json' };

export { atomsOf };

const PIECE_HEX = 24;

/** The row a person keeps for one piece of one file. No `no_check`: that is the person's to record. */
export function pieceRow(atom, source = {}) {
  return {
    id: `piece-${atom.identity.slice(3, 3 + PIECE_HEX)}`,
    kind: 'piece',
    says: lead(atom.text),
    text: atom.text,
    identity: atom.identity,
    key: atom.key,
    sources: [{ file: source.file ?? null, section: atom.key, file_identity: source.file_identity ?? null, at: atom.line ?? null }],
    tags: [],
    kinds: [],
    checked_by: [],
  };
}

/** Every piece of every document, one row per identity. A document's file_identity defaults to its bytes' identity. */
export function pieceRows(documents) {
  const rows = new Map();
  for (const document of documents) {
    const file_identity = document.file_identity ?? makeHashCodeHexFromBytes(new TextEncoder().encode(document.text));
    for (const atom of atomsOf(document.text)) {
      const row = pieceRow(atom, { file: document.file ?? null, file_identity });
      if (rows.has(row.id)) rows.get(row.id).sources.push(...row.sources);
      else rows.set(row.id, row);
    }
  }
  return [...rows.values()];
}

const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
export class SplitRefusal extends Error {}

// A value's bytes as a door may carry it: its JSON with every character past ASCII as a \u escape, quoted once more.
// Each non-ASCII UTF-16 unit becomes seven carried bytes (\\uXXXX); an ASCII quote or backslash gains its one escape byte.
export function carriedBytes(value) {
  const json = JSON.stringify(value);
  let bytes = 2; // The outer quotes.
  for (let at = 0; at < json.length; at += 1) {
    const unit = json.charCodeAt(at);
    bytes += unit > 0x7f ? 7 : unit === 0x22 || unit === 0x5c ? 2 : 1;
  }
  return bytes;
}

// One of the person's files, read whole by name through the files door, every page of one identity.
async function readByName(door, name, { read_bytes: readBytes, most_file_bytes: most } = SETTINGS.split) {
  const parts = [];
  let offset = 0, identity = null;
  for (;;) {
    let page;
    try { page = await door.files('read_file', { name_or_identity: name, offset, length: readBytes }); }
    catch (error) { throw new SplitRefusal(fill(SETTINGS.words.file_unreadable, { name, why: error.message })); }
    if (page.byte_length > most) throw new SplitRefusal(fill(SETTINGS.words.file_too_large, { name, bytes: page.byte_length, most }));
    if (identity !== null && page.identity !== identity) throw new SplitRefusal(fill(SETTINGS.words.file_changed, { name }));
    identity = page.identity ?? null;
    const part = Buffer.from(page.content ?? '', page.encoding === 'base64' ? 'base64' : 'utf8');
    parts.push(part);
    offset += part.length;
    if (!part.length || offset >= page.byte_length) break;
  }
  const bytes = Buffer.concat(parts);
  return { text: bytes.toString('utf8'), identity: identity ?? makeHashCodeHexFromBytes(bytes) };
}

/**
 * A document's pieces, a page of them per call: the pieces after `after` (a piece id; the start when left out), in
 * reading order, as many as fit `most_bytes` as the door carries them. `next` is the id to send as `after` for the next
 * page, null on the last. A piece too large for any page is named in `too_large`, not carried.
 */
export async function splitIntoPieces(input, door, settings = SETTINGS.split) {
  const hasText = typeof input?.text === 'string', hasName = typeof input?.name === 'string' && input.name.length > 0;
  if (hasText === hasName) throw new SplitRefusal(SETTINGS.words.text);
  if (input.file !== undefined && typeof input.file !== 'string') throw new SplitRefusal(SETTINGS.words.file_name);
  if (input.after !== undefined && typeof input.after !== 'string') throw new SplitRefusal(SETTINGS.words.after);
  const room = input.most_bytes ?? settings.most_bytes;
  if (!Number.isInteger(room) || room < settings.least_bytes || room > settings.most_bytes) throw new SplitRefusal(fill(SETTINGS.words.room, settings));
  const read = hasName ? await readByName(door, input.name, settings) : { text: input.text, identity: null };
  const file = input.file ?? (hasName ? input.name : null);
  const file_identity = input.file_identity ?? read.identity ?? makeHashCodeHexFromBytes(new TextEncoder().encode(read.text));
  const all = pieceRows([{ text: read.text, file, file_identity }]);
  const start = input.after === undefined ? 0 : all.findIndex(row => row.id === input.after) + 1;
  if (input.after !== undefined && start === 0) throw new SplitRefusal(fill(SETTINGS.words.no_such_piece, { id: input.after }));
  const pieces = [], too_large = [];
  let used = settings.shell_bytes, at = start;
  for (; at < all.length; at += 1) {
    const size = carriedBytes(all[at]) + 1;
    if (size > room - settings.shell_bytes) { too_large.push({ id: all[at].id, section: all[at].key, bytes: size }); continue; }
    if (used + size > room) break;
    used += size;
    pieces.push(all[at]);
  }
  const next = at < all.length ? all[at - 1].id : null;
  return {
    file, file_identity, total: all.length, pieces, next, too_large,
    lines: [fill(SETTINGS.words.split, { file: file ?? SETTINGS.no_file, pieces: all.length, here: pieces.length }), ...too_large.map(item => fill(SETTINGS.words.too_large_piece, item))],
  };
}
