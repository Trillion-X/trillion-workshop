// tools/funnels-and-offers/read-data/offer-variants.mjs
//
// PURPOSE
//   Offer rows with each variant resolved once. A row with `variant_of` is another offer that differs from the row it
//   names only where it says so: it inherits every field of that row except its identity (`id`, `earlier_ids`,
//   `public_offer_id`, which are its own), its own fields replace the inherited ones whole, and `replace_words`
//   ({ "$100": "$150" }) is applied to every inherited piece of text, so a price-test arm at another price reads its own
//   price everywhere the base row's words name it. An arm of a price experiment is one short row, never a copy of the
//   whole offer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The one offer reader (read-offers.ts) resolves variants here, so a variant is the same offer everywhere.
//   2. A variant names a row that exists and never reaches itself through other variants.
//   3. Nothing here names an offer, a price or a field: a variant's differences are its own DATA.
//
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const OWN = new Set(['id', 'earlier_ids', 'public_offer_id']);

function withWords(value, replace) {
  if (typeof value === 'string') return replace.reduce((text, [from, to]) => text.split(from).join(to), value);
  if (Array.isArray(value)) return value.map(item => withWords(item, replace));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withWords(item, replace)]));
  return value;
}

/** Every row with its variant resolved: { ...the row it varies, with replace_words applied, ...its own fields }. */
export function resolveOfferVariants(records) {
  const byId = new Map(records.filter(object).map(row => [row.id, row]));
  const resolve = (row, seen) => {
    if (!object(row) || !row.variant_of) return row;
    if (seen.has(row.id)) throw new Error(`${row.id} is a variant of itself through ${[...seen].join(', ')}.`);
    const base = byId.get(row.variant_of);
    if (!base) throw new Error(`${row.id} is a variant of ${row.variant_of}, which is not an offer row.`);
    const parent = resolve(base, new Set([...seen, row.id]));
    const { replace_words: words = {}, ...own } = row;
    const inherited = Object.fromEntries(Object.entries(parent).filter(([key]) => !OWN.has(key)));
    return { ...withWords(inherited, Object.entries(words)), ...own };
  };
  return records.map(row => resolve(row, new Set()));
}
