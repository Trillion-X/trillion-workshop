// tools/check-against-a-persons-rules-and-verdicts/do-work/pieces.mjs
//
// Purpose
//   The row a person keeps for each piece of a document, in their one Checks list (list:checks, row type `check`,
//   `kind: "piece"`), so every check can name the exact piece it came from. The pieces themselves are old trillion's
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
//   keepPieces({ text? | name?, file?, file_identity? }, door) -> { file, file_identity, pieces, new, sources_added,
//     unchanged, writes, ids, more_ids, too_large, lines }
//
// Keeping a whole file in one call (tool:split-a-document-into-pieces)
//   4. The document comes as `text`, or by reference as `name`, one of the person's files read through the run's files
//      door (read_file, page after page, every page of the same identity), so a file larger than one request body
//      (the door refuses bodies over 64 KiB) is never sent in one.
//   5. Its pieces are kept as the person's piece rows, merged over what is kept: a row already kept keeps its
//      checked_by, no_check, tags and kinds, and gains only the source this file gives it (a source of the same file
//      and section is replaced, never repeated). Every write is conditional on what was read (absent, or the exact value
//      read), and the writes are cut so each fits one door message as the door carries it. A piece too large for one
//      write is not kept and is named.
//   6. The answer is counts and a bounded list of ids, never the pieces themselves: the pieces of a 31 KB file came to
//      about 280 KB of JSON, and the door carries a run's answer twice in one 65,536-byte message, which is why a whole
//      file answered with an unknown outcome while its 3 KB chunks did not. The split took 146 ms and 58 MB at 31 KB.
import { atomsOf, lead } from '../../documents-as-list-rows/read-data/atoms.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { writeBatches } from '../../records-door/read-data/write-batches.mjs';
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
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export class SplitRefusal extends Error {}

// A record's bytes as a door may carry it: its JSON with every character past ASCII as a \u escape, quoted once more.
export const carriedBytes = record => Buffer.byteLength(JSON.stringify(JSON.stringify(record)
  .replace(/[\u0080-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)));

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

// `work` over every item, `at_once` at a time, answers in order.
async function each(items, atOnce, work) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, async () => {
    while (next < items.length) { const at = next++; out[at] = await work(items[at]); }
  }));
  return out;
}

/** A document's pieces kept as the person's piece rows, in one call: see invariants 4 to 6. */
export async function keepPieces(input, door, settings = SETTINGS.split) {
  const hasText = typeof input?.text === 'string', hasName = typeof input?.name === 'string' && input.name.length > 0;
  if (hasText === hasName) throw new SplitRefusal(SETTINGS.words.text);
  if (input.file !== undefined && typeof input.file !== 'string') throw new SplitRefusal(SETTINGS.words.file_name);
  const read = hasName ? await readByName(door, input.name, settings) : { text: input.text, identity: null };
  const file = input.file ?? (hasName ? input.name : null);
  const file_identity = input.file_identity ?? read.identity ?? makeHashCodeHexFromBytes(new TextEncoder().encode(read.text));
  const rows = pieceRows([{ text: read.text, file, file_identity }]);
  const type = SETTINGS.check_type;
  const held = await each(rows, settings.reads_at_once, row => door.read(type, `${SETTINGS.record_prefix}${row.id}`));
  const records = [], too_large = [];
  let added = 0, sourcesAdded = 0, unchanged = 0;
  rows.forEach((row, at) => {
    const id = `${SETTINGS.record_prefix}${row.id}`;
    const was = object(held[at]) ? held[at] : null;
    let record;
    if (!was) record = { id, type, value: row, expected: null };
    else {
      const sources = Array.isArray(was.sources) ? [...was.sources] : [];
      let changed = false;
      for (const source of row.sources) {
        const same = sources.findIndex(kept => kept?.file === source.file && kept?.section === source.section);
        if (same < 0) { sources.push(source); changed = true; }
        else if (JSON.stringify(sources[same]) !== JSON.stringify(source)) { sources[same] = source; changed = true; }
      }
      // A row kept before pieces carried tags held `groups`, a judge-words selector: it becomes `tags` when rewritten.
      const { groups, ...rest } = was;
      const renamed = groups !== undefined;
      if (renamed && rest.tags === undefined) rest.tags = groups;
      if (!changed && !renamed) { unchanged += 1; return; }
      record = { id, type, value: { ...rest, sources }, expected: { type, value: was } };
    }
    const size = carriedBytes(record);
    if (size > settings.write_bytes) { too_large.push({ id: row.id, section: row.key, bytes: size }); return; }
    records.push(record);
    if (was) sourcesAdded += 1; else added += 1;
  });
  const batches = writeBatches(records, { rows: settings.write_rows, bytes: settings.write_bytes, measure: carriedBytes });
  for (const batch of batches) {
    await door.write(batch, { key: `${settings.key_prefix}:${makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(batch))).slice(3)}` });
  }
  const counts = { file: file ?? SETTINGS.no_file, pieces: rows.length, new: added, sources_added: sourcesAdded, unchanged };
  return {
    file, file_identity, pieces: rows.length, new: added, sources_added: sourcesAdded, unchanged, writes: batches.length,
    ids: rows.slice(0, settings.named_at_most).map(row => row.id), more_ids: Math.max(0, rows.length - settings.named_at_most),
    too_large: too_large.slice(0, settings.named_at_most),
    lines: [fill(SETTINGS.words.kept, counts), ...too_large.slice(0, settings.named_at_most).map(item => fill(SETTINGS.words.too_large_piece, item))],
  };
}
