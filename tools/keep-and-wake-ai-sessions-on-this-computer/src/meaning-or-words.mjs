// src/meaning-or-words.mjs
//
// Every search that ranks by meaning also has the words asked to go on. This is the one place that decides whether
// meaning can be had right now and, when it cannot, how words are matched instead, so a search keeps answering on a
// day Trillion's model road is stopped (a budget row or the day spending stop reached, a shape Trillion does not pay
// for, no model binding) and says plainly that its results were matched by words.
//
// Why it exists: on 2026-10-07 the $1.00 a day stop on Trillion's model calls was reached, and tool search, the space
// Tools search and every other search that embeds the question failed with the stop's refusal instead of answering.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only the model road's own refusals (src/model-calls.mjs modelRoadStopped) become "no meaning now"; any other
//      error is the caller's fault and is thrown, never hidden as a words match.
//   2. The spending stop keeps holding: nothing here asks a model a second time or past a refusal.
//   3. One word matcher for every search that falls back (wordsOf, wordShare, kept in src/word-match.mjs), and one sentence telling the person
//      how the results were found (MATCHED_BY_WORDS, DATA in src/model-budgets.json).
//
// Shapes
//   meaningOrNone(work: () => Promise<T>) -> Promise<T | null>
//   wordsOf(text) -> Set<string>          lower-case words of three letters or more, common words dropped, endings cut
//   wordShare(asked: Set, offered: text) -> 0..1   the share of the asked words the offered text holds
//   MATCHED_BY_WORDS: string

import { modelRoadStopped } from './model-calls.mjs';
import data from './model-budgets.json' with { type: 'json' };

/** What `work` answers, or null when the model road will not answer now; any other failure is thrown. */
export async function meaningOrNone(work) {
  try { return await work(); } catch (error) {
    if (modelRoadStopped(error)) return null;
    throw error;
  }
}

/** The sentence a search's answer carries when its results were matched by words instead of meaning. */
export const MATCHED_BY_WORDS = data.words.matched_by_words;

/** The words a text holds and the share of them another text holds: the one word matcher (src/word-match.mjs). */
export { wordsOf, wordShare } from '../../pick-a-screen-as-you-type/src/word-match.mjs';
