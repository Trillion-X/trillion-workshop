// tools/take-payments/test/suggestion-rows.test.mjs
// The one join: an offer's suggestion_rows names a list; suggestionListsOf reads the rows of the one suggestion row type
// (offer-amount-choice) through the person's records door, keeps for each offer the rows that name it, and
// readCheckoutOffers takes them. The reader itself reads no records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCheckoutOffers, suggestionKey } from '../../funnels-and-offers/read-data/read-offers.ts';
import { suggestionListsOf } from '../do-work/take-payments.mjs';

const offerNaming = (id, offerField) => ({
  kind: 'commercial-offer', id, label: id,
  price_options: [{
    id: `price:${id}:monthly`, label: 'Monthly', amount_cents: 5000, currency: 'usd', interval: 'month', payment_timing: 'recurring',
    voluntary_amount_policy: {
      allow_custom: true, currency: 'usd',
      price_discovery: { start_cents: 5000, sales_to_double: 1, target_win_rate: 0.05, sales: 0, reached_price: 0 },
      suggestion_rows: { list: 'list:offer-amount-choices', value_field: 'multiple', shown_field: 'shown', ...(offerField ? { offer_field: offerField } : {}) },
    },
  }],
});
const membershipOffer = offerNaming('offer:membership', 'offer');
const otherOffer = offerNaming('offer:other', 'offer');

const door = {
  async *list({ type }) {
    const records = [
      { id: 'record:offer-amount-choice:a', type: 'record:offer-amount-choice', value: { offer: 'offer:membership', multiple: 1, shown: true } },
      { id: 'record:offer-amount-choice:b', type: 'record:offer-amount-choice', value: { offer: 'offer:membership', multiple: 2, shown: false } },
      { id: 'record:offer-amount-choice:c', type: 'record:offer-amount-choice', value: { offer: 'offer:membership', multiple: 4, shown: true } },
      { id: 'record:offer-amount-choice:d', type: 'record:offer-amount-choice', value: { offer: ['offer:other'], multiple: 8, shown: true } },
      { id: 'record:other:x', type: 'record:other', value: { multiple: 16, shown: true } },
    ];
    for (const record of records) if (record.type === type) yield record;
  },
};

test('the rows that name an offer are read through the door and decide which suggestions show', async () => {
  const lists = await suggestionListsOf([membershipOffer, otherOffer], door);
  assert.deepEqual([...lists.keys()].sort(), [suggestionKey('offer:membership', 'list:offer-amount-choices'), suggestionKey('offer:other', 'list:offer-amount-choices')].sort());
  assert.equal(lists.get(suggestionKey('offer:membership', 'list:offer-amount-choices')).length, 3);
  assert.equal(lists.get(suggestionKey('offer:other', 'list:offer-amount-choices')).length, 1);
  const [offer] = readCheckoutOffers([membershipOffer], { suggestionLists: lists });
  assert.deepEqual(offer.price_options[0].voluntary_amount_policy.suggested_cents, [5000, 20000]);
});

test('an offer that names no list reads no list, and an offer whose list was not read is refused', async () => {
  assert.equal((await suggestionListsOf([{ kind: 'commercial-offer', id: 'offer:plain', label: 'Plain', price_options: [] }], door)).size, 0);
  assert.throws(() => readCheckoutOffers([membershipOffer], { suggestionLists: new Map() }), /whose rows were not read/);
});
