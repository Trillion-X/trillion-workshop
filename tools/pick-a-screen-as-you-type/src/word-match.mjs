// src/word-match.mjs
//
// PURPOSE
//   The one way Trillion compares words without a model: what words a text holds and how much of one text another
//   holds. Every search that matches by words (src/meaning-or-words.mjs when meaning cannot be had, a tool search, the
//   instant screen a person's words pick in their browser, src/instant-screens.mjs) reads words through here, so a
//   word counts the same everywhere. Pure: no page, no store, no model; it runs in the Worker and in the browser.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One tokenizer and one ending rule: wordsOf, wordShare and termsOf all cut words the same way.
//   2. Pure and bounded by its input: nothing is read or kept here.
//
// Shapes
//   wordsOf(text) -> Set<string>          lower-case words of three letters or more, common words dropped, endings cut
//   wordShare(asked: Set, offered: text) -> 0..1   the share of the asked words the offered text holds
//   termsOf(text) -> [{ word, at, end }]  every word of the text in order (letters and digits of any script), as typed
//                                          positions, with its cut form in `word`; short and common words included
//   stemOf(word) -> string                the cut form of one lower-case word
//   isCommonWord(word) -> boolean

const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'some', 'these', 'those', 'please', 'want', 'need', 'using']);

/** The cut form of one lower-case word (invariant 1). */
export const stemOf = word => word.replace(/(ing|ed|es|s)$/, '') || word;

/** A word every search leaves out. */
export const isCommonWord = word => STOP.has(word);

/** The words a text holds, as every search compares them. */
export const wordsOf = text => new Set((String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(word => word.length > 2 && !STOP.has(word)).map(stemOf));

/** The share of the asked words (a set from wordsOf) that `offered` holds: 1 when it holds them all, 0 when none. */
export function wordShare(asked, offered) {
  if (!asked.size) return 0;
  const theirs = wordsOf(offered);
  return [...asked].filter(word => theirs.has(word)).length / asked.size;
}

/** Every word of `text` in order, with where it sits in the text and its cut form. */
export function termsOf(text) {
  const source = String(text ?? '');
  const terms = [];
  for (const match of source.matchAll(/[\p{L}\p{N}]+/gu)) {
    const raw = match[0].toLowerCase();
    terms.push({ raw, word: stemOf(raw), at: match.index, end: match.index + match[0].length });
  }
  return terms;
}
