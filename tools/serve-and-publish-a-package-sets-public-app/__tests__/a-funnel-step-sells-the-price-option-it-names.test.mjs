import assert from 'node:assert/strict';
import test from 'node:test';

import { namedPriceOption } from '../read-data/named-price-option.mjs';

// The fourth and last site of the price-option lane, and the one that had no test until now,
// because the rule sat inside `processes/public-entry-server-source.mjs`, a server program with
// zero exports. Nothing could import the expression that decides which price a funnel step charges.
//
// The rule this file pins is NOT the same as the sibling packages'. It returns null wherever the
// answer is not authored, and the caller falls back to `display_amount_cents`, the number the funnel
// author actually wrote. That local fallback is why the convergence verdict kept four
// implementations rather than one shared owner: what is shared is the DATA vocabulary.

const trialFirst = {
  id: 'offer:front',
  price_options: [
    { id: 'p:trial', amount_cents: 0, currency: 'usd' },
    { id: 'p:monthly', amount_cents: 25000, currency: 'usd', payment_timing: 'recurring', interval: 'month' },
  ],
};

test('a named id wins, and the $0 row is nameable like any other', () => {
  assert.equal(namedPriceOption(trialFirst, 'p:monthly').amount_cents, 25000);
  assert.equal(namedPriceOption(trialFirst, 'p:trial').amount_cents, 0);
});

test('a name nothing carries returns null instead of degrading into position', () => {
  // The failure this whole lane exists for: a named reference that silently becomes a positional
  // one. Position 0 here is the $0 trial, so the degradation is not merely wrong, it is free.
  assert.equal(namedPriceOption(trialFirst, 'p:deleted'), null);
});

test('several options and no name is null, so the caller uses the amount the author wrote', () => {
  assert.equal(namedPriceOption(trialFirst, undefined), null);
  assert.equal(namedPriceOption(trialFirst, ''), null);
});

test('a sole option needs no name, because nothing is being chosen between', () => {
  const sole = { id: 'offer:front', price_options: [{ id: 'p1', amount_cents: 4700, currency: 'usd' }] };
  assert.equal(namedPriceOption(sole, undefined).amount_cents, 4700);
  // Naming it is still obeyed, and naming something else still refuses.
  assert.equal(namedPriceOption(sole, 'p1').amount_cents, 4700);
  assert.equal(namedPriceOption(sole, 'p2'), null);
});

test('an offer with no options, or none at all, yields null rather than throwing', () => {
  assert.equal(namedPriceOption({ id: 'offer:front', price_options: [] }, undefined), null);
  assert.equal(namedPriceOption({ id: 'offer:front' }, 'p:monthly'), null);
  assert.equal(namedPriceOption(undefined, 'p:monthly'), null);
});
