// src/quoted-words.mjs
//
// Purpose: a tool answer that carries other people's words puts them in front of an AI as a quoted block: every line
// prefixed, the block closed with a marker naming where they came from. The cleaning of the words is the one
// quoteUntrusted (src/untrusted-text.mjs); this file only shapes the block and walks an answer.
//
// Non-negotiable invariants
//   1. The cleaned copy is only what the AI reads: the owner's record keeps the original bytes.
//   2. Line breaks of every kind become \n before cleaning, so none is lost as a control character.
//   3. Every number and word comes from src/quoted-words.json; nothing here names a sender or a service.
import settings from './quoted-words.json' with { type: 'json' };
import { quoteUntrusted as clean } from './untrusted-text.mjs';

const LINE_BREAKS = /\r\n|[\r\v\f\u0085\u2028\u2029]/g;

/** A quoted block: each line prefixed, closed with the end marker naming `source`. → { quoted, truncated } */
export function quoteBlock(value, { source = 'a third party', limit = settings.limit } = {}) {
  const text = String(value ?? '').replace(LINE_BREAKS, '\n');
  const cleaned = clean(text, { max: limit });
  const truncated = Array.from(text).length > limit;
  const quoted = cleaned.split('\n').map(line => settings.line_prefix + line).join('\n');
  return { quoted: `${quoted}\n${settings.end_marker.replace('{source}', source)}`, truncated };
}

/** A name or title beside the words: one line, cleaned and cut. */
export function cleanLabel(value, limit = settings.label_limit) {
  return clean(String(value ?? '').replace(/\s+/g, ' ').trim(), { max: limit });
}

/** A tool answer with every string under a DATA field name quoted in place (arrays and objects walked); the owner's record is untouched. */
export function quoteFieldsIn(answer, { source = 'a third party', fields = settings.fields } = {}) {
  const walk = value => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, inner]) => {
      if (fields.includes(key) && typeof inner === 'string') {
        const { quoted, truncated } = quoteBlock(inner, { source });
        return [[key, quoted], ...(truncated ? [[`${key}_truncated`, true]] : [])];
      }
      return [[key, walk(inner)]];
    }));
  };
  return walk(answer);
}
