// tools/take-payments/read-data/suggestion-lists.mjs
//
// PURPOSE
//   The rows of each suggestion list an offer names. The tools in do-work/take-payments.mjs take the rows in their request,
//   and the buyer checkout screen (web/src/workspace/checkout-targets.ts) hands in the offer-amount-choice rows it read, so
//   `suggestionListsFrom` is the one reader of them. It reads no store.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { suggestionKey } from '../../funnels-and-offers/read-data/read-offers.ts';
import { resolveOfferVariants } from '../../funnels-and-offers/read-data/offer-variants.mjs';

// Every offer's suggested amounts are rows of one kind, offer-amount-choice: one list holds the choices of every offer, and a
// row links the offer it belongs to in the field the offer's `suggestion_rows.offer_field` names (a link holds a list of ids).

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

