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
//     sources: [{ file, section, file_identity, at }], groups: [], kinds: [], checked_by: [] }
//     section: the piece's key in that file; at: the line of that file where the piece starts
//   pieceRows([{ text, file?, file_identity? }]) -> piece rows, one per identity, sources in reading order
import { atomsOf, lead } from '../../documents-as-list-rows/read-data/atoms.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

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
    groups: [],
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
