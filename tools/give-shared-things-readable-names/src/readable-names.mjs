// src/readable-names.mjs
//
// PURPOSE
//   The one way Trillion names a link it hands out: words a person can read, never a long id. A share link's code, a
//   space invite (and the meeting link that is one), and a published page's address all come from here; the server
//   resolves the words to the long identity behind them. Settings and the word list: src/readable-names.json.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A secret name carries at least readable-names.json secret_bits of randomness, chosen without bias from the
//      word list, so words are exactly as hard to guess as the random code they replace.
//   2. A secret name never holds the shared thing's own words, so a link seen by a stranger never says what it opens.
//   3. Every name matches readable-names.json pattern, so any route that accepts one accepts all of them.
//   4. A public name (a share link's address, a published app's address) is claimed through claimPublicName in the
//      caller's own name list: a chosen name is the claimant's when free or already theirs and refused otherwise; a name
//      from the thing's own words takes the first free one of those words alone, then with one more list word, then
//      with three. One rule for every namespace, so every public address in Trillion reads and behaves the same way.
//
import names from './readable-names.json' with { type: 'json' };

export const READABLE_WORDS = names.words;
export const NAME_PATTERN = new RegExp(names.pattern);
/** How many words a secret name has: enough for readable-names.json secret_bits. */
export const SECRET_WORDS = Math.ceil(names.secret_bits / Math.log2(names.words.length));
// Existing links were made with five words. Keep accepting that shape when a
// person signs in from an old invite; only new links use the stronger count.
const LEGACY_SECRET_WORDS = 5;
const secretWordShape = count => `[a-z]+(?:-[a-z]+){${count - 1}}`;
const SECRET_PATTERN = new RegExp(`^(?:${secretWordShape(SECRET_WORDS)}|${secretWordShape(LEGACY_SECRET_WORDS)})$`);

/** `count` words from the list, each chosen uniformly (values past the last whole multiple of the list are drawn again). */
export function randomWords(count, random = n => crypto.getRandomValues(new Uint32Array(n))) {
  const size = names.words.length;
  const limit = Math.floor(0x100000000 / size) * size;
  const chosen = [];
  while (chosen.length < count) {
    for (const value of random(count - chosen.length)) if (value < limit && chosen.length < count) chosen.push(names.words[value % size]);
  }
  return chosen;
}

/** A new secret name made of enough random words for the configured security floor. */
export const secretName = random => randomWords(SECRET_WORDS, random).join('-');

/** Whether a value has a current or legacy secret-name shape (its words are not checked against the list). */
export const looksLikeSecretName = value => typeof value === 'string' && SECRET_PATTERN.test(value);

const LOOKS_LIKE_CODE = /^[0-9a-f]{20,}$/;

/**
 * A public name made from a thing's own words: the first `first` words, lowercased, accents and punctuation dropped,
 * joined by hyphens and cut to `longest`; null when nothing readable is left, the result fails `pattern`, or it looks
 * like a random code (so a name is never mistaken for one).
 */
export function nameFromWords(words, { first, longest, pattern }) {
  const slug = String(words ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, first).join('-')
    .slice(0, longest).replace(/-+$/, '');
  return pattern.test(slug) && !LOOKS_LIKE_CODE.test(slug) ? slug : null;
}

/**
 * Claims a public name in one name list (invariant 4). `holder(name)` reads who holds a name (null when free), `mine`
 * says whether a holder is the claimant, `taken` is the refusal a chosen name meets when someone else holds it.
 * Returns the name to keep; the caller writes it to its list.
 */
export async function claimPublicName(base, { chosen = false, holder, mine, longest, pattern, tries, taken, reserve = null, alternatives = null, exhausted = taken }) {
  const claim = async name => {
    if (reserve) return reserve(name);
    const held = await holder(name);
    return !held || mine(held);
  };
  if (chosen) {
    if (!(await claim(base))) throw new Error(taken);
    return base;
  }
  const fit = name => name.slice(0, longest).replace(/-+$/, '');
  const suffixes = alternatives ? alternatives(base, tries) : randomWords(tries).map(word => fit(`${base}-${word}`));
  for (const name of [base, ...suffixes]) {
    if (!pattern.test(name) || LOOKS_LIKE_CODE.test(name)) continue;
    if (await claim(name)) return name;
  }
  // An explicit alternative generator owns its collision policy. Never invent an unclaimed-looking fallback that
  // was not checked in the same namespace; for numbered readable names, exhaustion must fail closed.
  if (alternatives) throw new Error(exhausted);
  return fit(`${base.slice(0, longest - 24)}-${randomWords(3).join('-')}`);
}
