import test from 'node:test';
import assert from 'node:assert/strict';
import { isComparedPlan, planFeatures, recommendedPlanId } from '../src/plan-comparison.mjs';
import { resolveOffers } from '../../shared-code/src/offer-rows.mjs';
import comparison from '../src/plan-comparison.json' with { type: 'json' };

// Synthetic offer rows the test passes in; the plan read takes them from its caller, so no catalogue file is loaded.
const workshop = comparison.features.find(row => row.id === 'workshop');
const rows = resolveOffers([
  { id: 'offer:plan', label: 'Plan', price_options: [{ amount_cents: 10000 }], access_refs: [workshop.access], allowances: [] },
  { id: 'offer:plan-arm', variant_of: 'offer:plan', label: 'Plan arm', price_options: [{ amount_cents: 15000 }] },
  { id: 'offer:limited', label: 'Limited', price_options: [{ amount_cents: 0 }], access_refs: [workshop.access], allowances: [{ access: workshop.access, count: 5, per: 'month' }] },
  { id: 'offer:team', label: 'Team seat', allocation: { grants_offer: 'offer:plan', payer_units: 1 }, price_options: [{ amount_cents: 5000 }] },
]);
const byId = id => rows.find(row => row.id === id);

test('a plan is judged by the offer rows the caller passes in', () => {
  assert.equal(isComparedPlan(byId('offer:plan'), rows), true);
  const line = planFeatures(byId('offer:plan'), rows).find(row => row.id === 'workshop');
  assert.equal(line.included, true);
});

test('a limited plan does not include the unlimited feature, judged from its own allowance row', () => {
  const line = planFeatures(byId('offer:limited'), rows).find(row => row.id === 'workshop');
  assert.equal(line.included, false);
});

test('a seat allocation is judged through the granted plan row', () => {
  assert.equal(isComparedPlan(byId('offer:team'), rows), true);
});

test('the recommended plan is chosen from the passed rows, including a price arm', () => {
  assert.equal(recommendedPlanId(rows, 'offer:plan-arm'), 'offer:plan-arm');
  assert.notEqual(recommendedPlanId(rows), 'offer:limited');
});
