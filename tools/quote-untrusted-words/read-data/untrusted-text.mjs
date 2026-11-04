// src/untrusted-text.mjs
//
// Purpose
//   The one way a stranger's words are quoted into a turn an AI reads. Mail, imported chats, web pages and titles other
//   people wrote can carry characters that hide text from the person (bidi overrides, zero-width characters) or that
//   write a tag around themselves (a "<" or one of its look-alikes). Every place such words reach an AI's job passes
//   through quoteUntrusted, so the steps exist once and a new carrier needs no private copy.
//
// Non-negotiable invariants
//   1. Order is fixed: normalise (NFC), strip control and format characters, escape "<" and its look-alikes, then
//      truncate by code points. Escaping before truncating means a cut can never leave half of an escape behind.
//   2. Truncation counts code points, never UTF-16 units, so a surrogate pair is never split; a cut ends with the
//      ellipsis from DATA, and the ellipsis is inside the limit.
//   3. Every step is a row of src/untrusted-text.json. Nothing here names a carrier, a tag or a character.
//   4. Words that are the person's own are never passed here; the caller decides whose words these are.
//   5. The kept original (src/messages.mjs) is never changed: only the copy handed to an AI is quoted.
//
import data from './untrusted-text.json' with { type: 'json' };

const categoryTest = new RegExp(`[${data.strip.categories.map(category => `\\p{${category}}`).join('')}]`, 'gu');
const kept = new Set(data.strip.keep);
const escapes = new Map(data.escape.rows.map(row => [row.from, row.to]));
const escapePattern = new RegExp(`[${[...escapes.keys()].map(char => `\\u{${char.codePointAt(0).toString(16)}}`).join('')}]`, 'gu');

/**
 * text: the other party's words (anything else answers an empty string).
 * max:  the most code points the quote may hold, ellipsis included (DATA default).
 * → the words made safe to quote.
 */
export function quoteUntrusted(text, { max = data.default_max_code_points } = {}) {
  if (typeof text !== 'string') return '';
  const clean = text.normalize(data.normalize)
    .replace(categoryTest, char => (kept.has(char) ? char : ''))
    .replace(escapePattern, char => escapes.get(char));
  const points = [...clean];
  if (points.length <= max) return clean;
  const room = Math.max(0, max - [...data.ellipsis].length);
  // Never cut inside an escape: back up to before an unfinished "&lt;".
  let cut = points.slice(0, room).join('');
  const open = cut.lastIndexOf('&');
  if (open >= 0 && !cut.slice(open).includes(';') && cut.length - open < 4) cut = cut.slice(0, open);
  return `${cut}${data.ellipsis}`;
}
