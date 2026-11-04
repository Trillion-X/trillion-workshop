// tools/quote-untrusted-words/read-data/quote-tools.mjs
//
// The row over quoteUntrusted (untrusted-text.mjs, moved unchanged): a stranger's words in, the copy safe to quote
// into a turn an AI reads out. Nothing here changes a step; every step is a row of untrusted-text.json.
import { quoteUntrusted } from './untrusted-text.mjs';

/** tool:quote-untrusted-words: { text, max? } -> { quoted, code_points }. */
export function quoteForTurn(input) {
  const { text, max } = input ?? {};
  const quoted = quoteUntrusted(text, max == null ? {} : { max });
  return { quoted, code_points: [...quoted].length };
}
