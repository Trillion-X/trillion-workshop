import test from 'node:test';
import assert from 'node:assert/strict';
import { negotiatedOfferRequest } from '../read-data/negotiated-offer-per-deal.mjs';

const checkout = {
  terms: { label: 'Coaching', amount_cents: 9000, currency: 'usd', line_items: [{ label: 'Coaching', amount_cents: 9000 }] },
  entitlements: { grants: ['access:calls'], limits: [] },
  allowPromotionCodes: false,
  promotionCodeId: undefined,
};
const saved = { id: 'sales-contract:a', contract: { funnel_id: 'funnel:spring' } };
const grant = { share_id: 'share_1', expires_at: '2026-12-01T00:00:00.000Z' };
const base = {
  code: 'code/with slash', grant, recordId: 'sales-contract:a', saved, checkout, entitlementOfferId: 'offer:coaching', origin: 'https://app.example.test/',
};

test('a deal link gets an offer with its record, share, offer, funnel and end time', () => {
  const request = negotiatedOfferRequest(base);
  assert.equal(request.contract_id, 'sales-contract:a');
  assert.equal(request.entitlement_offer_id, 'offer:coaching');
  assert.equal(request.share_id, 'share_1');
  assert.equal(request.funnel_id, 'funnel:spring');
  assert.equal(request.expires_at, '2026-12-01T00:00:00.000Z');
  assert.deepEqual(request.entitlements, { grants: ['access:calls'], limits: [] });
});

test('the return addresses go back to the share page, with the paid mark on success', () => {
  const { checkout: urls } = negotiatedOfferRequest(base);
  assert.equal(urls.cancel_url, 'https://app.example.test/share/code%2Fwith%20slash');
  assert.equal(urls.success_url, `${urls.cancel_url}?paid=1`);
});

test('a price given replaces the amount on the terms and its one line', () => {
  const request = negotiatedOfferRequest({ ...base, amount_cents: 4900 });
  assert.equal(request.terms.amount_cents, 4900);
  assert.deepEqual(request.terms.line_items, [{ label: 'Coaching', amount_cents: 4900 }]);
  assert.equal(checkout.terms.amount_cents, 9000, 'the deal terms are not changed');
});

test('no price given keeps the deal terms', () => {
  assert.equal(negotiatedOfferRequest({ ...base, amount_cents: null }).terms, checkout.terms);
});

test('a price that is not a whole number of cents above zero is refused', () => {
  for (const amount_cents of [0, -3, 1.5, '4900']) {
    assert.throws(() => negotiatedOfferRequest({ ...base, amount_cents }), { message: 'A price is a whole number of cents above zero.' });
  }
});

test('a link that is not a sales contract is refused', () => {
  assert.throws(() => negotiatedOfferRequest({ ...base, recordId: 'note:n1' }), { message: 'This link is not a sales contract.' });
});

test('an origin that is not a secure https address is refused', () => {
  assert.throws(() => negotiatedOfferRequest({ ...base, origin: 'http://app.example.test' }), { message: 'Open the contract from its secure service address before creating a checkout link.' });
  assert.throws(() => negotiatedOfferRequest({ ...base, origin: undefined }), { message: 'Open the contract from its secure service address before creating a checkout link.' });
});

test('promotion codes and the end time are added only when there are some; no funnel or grants leave those keys out', () => {
  const request = negotiatedOfferRequest({
    ...base,
    checkout: { ...checkout, allowPromotionCodes: true, promotionCodeId: 'promo_1', entitlements: { grants: [], limits: [] } },
    grant: { share_id: 'share_1' },
    saved: { contract: {} },
  });
  assert.equal(request.checkout.allow_promotion_codes, true);
  assert.equal(request.checkout.promotion_code_id, 'promo_1');
  assert.equal('expires_at' in request, false);
  assert.equal('funnel_id' in request, false);
  assert.equal(request.entitlements, undefined);
});
