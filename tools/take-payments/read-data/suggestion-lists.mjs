// tools/take-payments/read-data/suggestion-lists.mjs
//
// PURPOSE
//   The rows of each suggestion list an offer names. The tools in do-work/take-payments.mjs take the rows in their request
//   (`suggestionListsFrom`); the buyer checkout screen (web/src/workspace/checkout-targets.ts) reads them through its records
//   door (`suggestionListsOf`), which hands them to the same function, so there is one reader of them.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { suggestionKey } from '../../funnels-and-offers/read-data/read-offers.ts';
import { resolveOfferVariants } from '../../funnels-and-offers/read-data/offer-variants.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The one row type every offer's suggested amounts are kept as (list `row_type` offer-amount-choice). A run's records
 *  right is a kind the tool row names, so the type is fixed here and one list holds the choices of every offer: a row links
 *  the offer it belongs to in the field the offer's `suggestion_rows.offer_field` names (a link holds a list of ids). */
const SUGGESTION_ROW_TYPE = 'record:offer-amount-choice';

/** The suggestion list each offer names (`voluntary_amount_policy.suggestion_rows`), kept per offer under
 *  `suggestionKey(offer id, list)` from the given rows of the one suggestion row type: the rows that name that offer. The
 *  offer reader takes these lists as given and reads no records. */
export function suggestionListsFrom(rows, values) {
  const lists = new Map();
  for (const offer of resolveOfferVariants(rows)) {
    for (const option of Array.isArray(offer?.price_options) ? offer.price_options : []) {
      const declaration = option?.voluntary_amount_policy?.suggestion_rows;
      if (typeof declaration?.list !== 'string') continue;
      const field = declaration.offer_field;
      lists.set(suggestionKey(offer.id, declaration.list), typeof field === 'string' ? values.filter(value => [value[field]].flat().includes(offer.id)) : values);
    }
  }
  return lists;
}

/** The same lists, read through a records door that lists records (the buyer checkout screen's door: it holds the person's
 *  rows in the browser). All rows of the one suggestion row type are read once, and only when an offer names a list. */
export async function suggestionListsOf(rows, door) {
  const named = resolveOfferVariants(rows).some(offer => (Array.isArray(offer?.price_options) ? offer.price_options : [])
    .some(option => typeof option?.voluntary_amount_policy?.suggestion_rows?.list === 'string'));
  if (!named) return new Map();
  const values = [];
  for await (const record of door.list({ type: SUGGESTION_ROW_TYPE })) if (object(record.value)) values.push(record.value);
  return suggestionListsFrom(rows, values);
}
