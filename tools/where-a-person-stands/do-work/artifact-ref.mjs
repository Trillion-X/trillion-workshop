// tools/where-a-person-stands/do-work/artifact-ref.mjs
//
// Purpose
//   The one identity of a thing a person judges, so a stand said on it once finds it again wherever it is checked. Text
//   (a title, a line, a part of a text the person named) is the same thing however it is typed: it is folded first (by
//   the fold the caller's DATA declares), then hashed. Anything else (a file, a JSON view such as a plan) is its bytes.
//   Every check that keys a stand on a thing calls this file; none keeps its own copy of the fold or the hash.
//
// Non-negotiable invariants
//   1. An identity is `1f:` and the 64 hex digits of BLAKE3-256: of the UTF-8 bytes of fold(text) for text, of the bytes
//      themselves for a file, of the UTF-8 bytes of JSON.stringify(view) for a JSON view.
//   2. The fold is DATA: { lowercase?, quotes?: [[from characters, to]], collapse_space?, strip_trailing?: <pattern> },
//      applied in that order: lowercase, quotes, every run of white space to one space, trim, then a trailing match of
//      strip_trailing cut and trimmed again. This file names no character, word or kind.
//   3. Text is never hashed unfolded: a text identity without a fold is refused.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** The fold a DATA block declares, as a function from text to folded text. */
export function foldWith(fold) {
  if (!fold || typeof fold !== 'object') throw new TypeError('A text identity needs the fold its owner declares.');
  const quotes = (fold.quotes ?? []).map(([from, to]) => [new RegExp(`[${from}]`, 'g'), to]);
  const strip = fold.strip_trailing ? new RegExp(`${fold.strip_trailing}$`) : null;
  return text => {
    let out = fold.lowercase ? text.toLowerCase() : text;
    for (const [from, to] of quotes) out = out.replace(from, to);
    if (fold.collapse_space) out = out.replace(/\s+/g, ' ');
    out = out.trim();
    return strip ? out.replace(strip, '').trim() : out;
  };
}

/** The identity of bytes. */
export const bytesRef = bytes => `1f:${bytesToHex(blake3(bytes))}`;

/** The identity of a text, folded by `fold` (a DATA block or a function foldWith made). */
export function textRef(text, fold) {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('A text identity needs nonempty text.');
  return bytesRef(utf8ToBytes((typeof fold === 'function' ? fold : foldWith(fold))(text)));
}

/** The identity of a JSON view: the bytes of its JSON text. */
export const viewRef = view => bytesRef(utf8ToBytes(JSON.stringify(view)));

/**
 * The identity of one artifact as a stand names it: `view` (any JSON) by its bytes, else `text` or `contains` (a part of
 * a text) folded. A caller with a file's bytes calls bytesRef.
 */
export function artifactRef({ text, contains, view } = {}, fold) {
  if (view !== undefined) return viewRef(view);
  return textRef(text ?? contains, fold);
}
