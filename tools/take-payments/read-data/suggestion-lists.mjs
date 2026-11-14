// tools/take-payments/read-data/suggestion-lists.mjs
//
// PURPOSE
//   The rows of each suggestion list an offer names, read through a records door that lists records. Both the tools in
//   do-work/take-payments.mjs and the buyer checkout screen (web/src/workspace/checkout-targets.ts) read an offer's
//   suggested amounts here, so there is one reader of them.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { suggestionKey } from '../../funnels-and-offers/read-data/read-offers.ts';
import { resolveOfferVariants } from '../../funnels-and-offers/read-data/offer-variants.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The one row type every offer's suggested amounts are kept as (list `row_type` offer-amount-choice). A run's records
 *  right is a kind the tool row names, so the type is fixed here and one list holds the choices of every offer: a row links
 *  the offer it belongs to in the field the offer's `suggestion_rows.offer_field` names (a link holds a list of ids). */
const SUGGESTION_ROW_TYPE = 'record:offer-amount-choice';

/** The rows of each suggestion list an offer names (`voluntary_amount_policy.suggestion_rows`), read through the person's
 *  records door: all rows of the one suggestion row type, kept per offer under `suggestionKey(offer id, list)` for the rows
 *  that name that offer. This is the one place a list is read: the offer reader takes these rows as given and reads no records. */
export async function suggestionListsOf(rows, door) {
  const named = [];
  for (const offer of resolveOfferVariants(rows)) {
    for (const option of Array.isArray(offer?.price_options) ? offer.price_options : []) {
      const declaration = option?.voluntary_amount_policy?.suggestion_rows;
      if (typeof declaration?.list === 'string') named.push({ offerId: offer.id, declaration });
    }
  }
  const lists = new Map();
  if (named.length === 0) return lists;
  if (!door) throw new Error(`${named[0].declaration.list} is named by an offer, and the offers' suggestions are read through the records door.`);
  const values = [];
  for await (const record of door.list({ type: SUGGESTION_ROW_TYPE })) if (object(record.value)) values.push(record.value);
  for (const { offerId, declaration } of named) {
    const field = declaration.offer_field;
    lists.set(suggestionKey(offerId, declaration.list), typeof field === 'string' ? values.filter(value => [value[field]].flat().includes(offerId)) : values);
  }
  return lists;
}
