// tools/cross-techniques-with-a-goal/do-work/vocabulary.mjs
//
// Purpose
//   The shared words techniques are described in, kept as DATA that grows by itself: a vocabulary is a list of terms,
//   each with what it means (`says`) and its meaning vector. A new term is admitted only when no existing term means
//   the same thing; otherwise the existing term is used and the proposal's words are kept as its alias. This is what
//   lets every technique cross with every other: two rows that say "curiosity gap" and "open loop" end up holding the
//   same term, so a join finds them both.
//
// Non-negotiable invariants
//   1. No term is named in code. A vocabulary is { says, reuse_at, new_below, terms: [{ term, says, aliases, from,
//      vector }] }; which row fields hold which vocabulary's terms is the caller's DATA.
//   2. Admission, in order: the same words (a term or an alias, compared by `termKey`) are the same term. Else the
//      nearest term at least `reuse_at` close in meaning is the same term ("same-meaning"). Else, when terms are at
//      least `new_below` close, a judge decides among them ("judged-same" or "judged-new"; a judge with no answer yet
//      leaves the proposal "waiting" and changes nothing). Else the proposal is a new term ("new"). Both lines are
//      measured from hand-labelled pairs (measure-reuse-line.mjs) and kept in the vocabulary, never in code: closeness
//      in meaning alone misplaces some pairs (two terms sharing a word sit close), so only the uncertain band is judged.
//   3. `admit` handles one proposal at a time, so terms admitted earlier in a fold are compared with the ones after
//      them: two rows coining one idea get one term.
//   4. A proposal waiting on a judgment enters the vocabulary as a provisional term, so every proposal after it is
//      judged against it too and a judgment made now still holds when the waiting one is settled. An outcome that
//      lands on a provisional term says so (`provisional: true`); the caller holds that row, and a vocabulary is kept
//      only `withoutProvisional`.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { cosine, kept, meaningOf } from './meaning.mjs';

export const termKey = term => term.toLowerCase().replace(/[\s_-]+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();

const keysOf = entry => [entry.term, ...(entry.aliases ?? [])].map(termKey);

export function findTerm(vocabulary, term) {
  const key = termKey(term);
  return vocabulary.terms.find(entry => keysOf(entry).includes(key));
}

// The k terms closest to a vector, closest first.
export function nearest(vocabulary, vector, k) {
  return vocabulary.terms
    .map(entry => ({ entry, closeness: cosine(vector, entry.vector) }))
    .sort((a, b) => b.closeness - a.closeness)
    .slice(0, k);
}

const rounded = value => Math.round(value * 1000) / 1000;

const alias = (entry, words) => {
  if (!keysOf(entry).includes(termKey(words))) entry.aliases = [...(entry.aliases ?? []), words.trim().toLowerCase()];
};

// One proposal { term, says, from } with its vector (null when its words already match a term). `judge` is
// async ({ proposal, candidates: [{ term, says, closeness }] }) -> an existing term, '' for none, or undefined for
// "not judged yet".
export async function admit(vocabulary, proposal, vector, judge) {
  const held = entry => (entry.provisional ? { provisional: true } : {});
  const same = findTerm(vocabulary, proposal.term);
  if (same) return { term: same.term, how: 'same-words', ...held(same) };
  const close = nearest(vocabulary, vector, 5).filter(item => item.closeness >= vocabulary.new_below);
  if (close[0] && close[0].closeness >= vocabulary.reuse_at) {
    alias(close[0].entry, proposal.term);
    return { term: close[0].entry.term, how: 'same-meaning', closeness: rounded(close[0].closeness), proposed: proposal.term, ...held(close[0].entry) };
  }
  const coin = extra => {
    const term = proposal.term.trim().toLowerCase();
    vocabulary.terms.push({ term, says: proposal.says ?? '', aliases: [], from: proposal.from, vector: kept(vector), ...extra });
    return term;
  };
  if (close.length) {
    const chosen = await judge({ proposal, candidates: close.map(({ entry, closeness }) => ({ term: entry.term, says: entry.says, closeness: rounded(closeness) })) });
    // Invariant 5: a proposal waiting on a judgment is a provisional term, so the proposals after it are judged against it.
    if (chosen === undefined) return { term: coin({ provisional: true }), how: 'waiting', provisional: true, proposed: proposal.term };
    const match = close.find(({ entry }) => entry.term === chosen);
    if (match) {
      alias(match.entry, proposal.term);
      return { term: match.entry.term, how: 'judged-same', closeness: rounded(match.closeness), proposed: proposal.term, ...held(match.entry) };
    }
  }
  return { term: coin({}), how: close.length ? 'judged-new' : 'new' };
}

// A vocabulary without its provisional terms: what is kept once a fold ends.
export const withoutProvisional = vocabulary => ({ ...vocabulary, terms: vocabulary.terms.filter(entry => !entry.provisional) });

// A lexicon with no terms yet: the meaning its vectors will be made by, and each vocabulary's says and measured lines.
export const emptyLexicon = (meaning, vocabularies, lines) => ({
  kind: 'technique-vocabulary',
  meaning: meaningOf(meaning),
  vocabularies: Object.fromEntries(Object.entries(vocabularies).map(([name, { says }]) => [name, { says, ...lines, terms: [] }])),
});

// The row fields that hold vocabulary terms, from conventions `bound`: [{ role, field, vocabulary }] for why, changes.
export const boundFields = bound => ['why', 'changes'].map(role => ({ role, ...bound[role] }));
