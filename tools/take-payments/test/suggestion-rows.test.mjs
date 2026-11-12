// tools/take-payments/test/suggestion-rows.test.mjs
// The one join: an offer's suggestion_rows names a list; suggestionListsOf reads that list's rows through the person's
// records door (the list's definition gives the row type; its rows are the records of that type under its row prefix),
// and readCheckoutOffers takes them. The reader itself reads no records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCheckoutOffers } from '../../funnels-and-offers/read-data/read-offers.ts';
import { suggestionListsOf } from '../do-work/take-payments.mjs';

const membershipOffer = {
  kind: 'commercial-offer', id: 'offer:membership', label: 'Membership',
  price_options: [{
    id: 'price:membership:monthly', label: 'Monthly', amount_cents: 5000, currency: 'usd', interval: 'month', payment_timing: 'recurring',
    voluntary_amount_policy: {
      allow_custom: true, currency: 'usd',
      price_discovery: { start_cents: 5000, sales_to_double: 1, target_win_rate: 0.05, sales: 0, reached_price: 0 },
      suggestion_rows: { list: 'list:membership-multiples', value_field: 'multiple', shown_field: 'shown' },
    },
  }],
};

const door = {
  async read(type, id) {
    return type === 'list' && id === 'list:membership-multiples' ? { row_type: 'membership-multiple', indexes: [] } : null;
  },
  async *list({ type, prefix }) {
    const records = [
      { id: 'record:membership-multiple:a', type: 'record:membership-multiple', value: { multiple: 1, shown: true } },
      { id: 'record:membership-multiple:b', type: 'record:membership-multiple', value: { multiple: 2, shown: false } },
      { id: 'record:membership-multiple:c', type: 'record:membership-multiple', value: { multiple: 4, shown: true } },
      { id: 'record:other:x', type: 'record:other', value: { multiple: 8, shown: true } },
    ];
    for (const record of records) {
      if (record.type === type && (prefix === undefined || record.id.startsWith(prefix))) yield record;
    }
  },
};

test('the list rows the offer names are read through the door and decide which suggestions show', async () => {
  const lists = await suggestionListsOf([membershipOffer], door);
  assert.deepEqual([...lists.keys()], ['list:membership-multiples']);
  assert.equal(lists.get('list:membership-multiples').length, 3);
  const [offer] = readCheckoutOffers([membershipOffer], { suggestionLists: lists });
  assert.deepEqual(offer.price_options[0].voluntary_amount_policy.suggested_cents, [5000, 20000]);
});

test('an offer that names no list reads no list, and a named list the person does not keep is refused', async () => {
  assert.equal((await suggestionListsOf([{ kind: 'commercial-offer', id: 'offer:plain', label: 'Plain', price_options: [] }], door)).size, 0);
  await assert.rejects(suggestionListsOf([membershipOffer], { read: async () => null, list: door.list }), /not a list the person keeps/);
});
