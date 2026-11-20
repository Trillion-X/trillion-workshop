import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOffers, spendingTermsForOffer, defaultSpendingTerms } from '../src/offer-rows.mjs';
import { entitlementOffer } from '../src/offer-allocation.mjs';

// Synthetic offer rows: the caller passes its own rows in, so the module loads no catalogue file.
const offers = [
  { id: 'offer:no-purchase', label: 'Free', access_refs: ['access:decision-method'], allowances: [{ access: 'access:decision-method', count: 5, per: 'month' }], spending: { daily_cap_dollars: 1, bill_overage: false } },
  { id: 'offer:base', label: 'Plan $100', price_options: [{ amount_cents: 10000 }], access_refs: ['access:decision-method'], spending: { daily_cap_dollars: 5, bill_overage: true } },
  { id: 'offer:arm', variant_of: 'offer:base', label: 'Plan $150', replace_words: { '$100': '$150' }, price_options: [{ amount_cents: 15000 }], public_offer_id: 'arm-public' },
  { id: 'offer:seat', label: 'Team seat', allocation: { grants_offer: 'offer:base', payer_units: 1 } },
];

test('a variant inherits its base row and replaces only its own fields and words', () => {
  const byId = new Map(resolveOffers(offers).map(row => [row.id, row]));
  const arm = byId.get('offer:arm');
  assert.equal(arm.label, 'Plan $150');
  assert.deepEqual(arm.access_refs, ['access:decision-method']);
  assert.equal(arm.public_offer_id, 'arm-public');
  assert.equal(arm.id, 'offer:arm');
  assert.equal(byId.get('offer:base').label, 'Plan $100');
});

test('a variant that reaches itself or names no row is refused', () => {
  assert.throws(() => resolveOffers([{ id: 'a', variant_of: 'b' }, { id: 'b', variant_of: 'a' }]), /variant of itself/);
  assert.throws(() => resolveOffers([{ id: 'a', variant_of: 'missing' }]), /not an offer row/);
});

test('spending terms come from the offer rows the caller passes in', () => {
  assert.deepEqual(spendingTermsForOffer(offers, 'offer:base'), { daily_cap_dollars: 5, bill_overage: true, offer_id: 'offer:base' });
  assert.equal(spendingTermsForOffer(offers, 'offer:none'), null);
  assert.equal(defaultSpendingTerms(offers, 'offer:no-purchase').daily_cap_dollars, 1);
  assert.throws(() => defaultSpendingTerms([], 'offer:no-purchase'), /must publish its spending terms/);
});

test('an allocation resolves through the offer rows the caller passes in', () => {
  const resolved = resolveOffers(offers);
  assert.deepEqual(entitlementOffer(resolved.find(row => row.id === 'offer:seat'), resolved).access_refs, ['access:decision-method']);
  assert.throws(() => entitlementOffer({ id: 'offer:seat', allocation: { grants_offer: 'offer:base' } }), /Offer allocations require an offer catalog/);
});
