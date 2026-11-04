import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutFromSalesContract } from '../src/contract-checkout.mjs';

const commitment = (label, amount, extra = {}) => ({
  type: 'Commitment', label, amount, currency: 'usd', recurrence: 'monthly',
  metadata: { payment_structure: 'simple' }, ...extra,
});
const saved = rules => ({ name: 'Coaching agreement', contract: { name: 'Coaching agreement', rules } });

test('every simple commitment reaches one Checkout offer and all direct grants survive', () => {
  const { terms, entitlements } = checkoutFromSalesContract(saved([
    commitment('Coaching', 150000), commitment('Research', 25000),
    { type: 'GrantAccess', resource: 'access:coaching', condition: 'conditional' },
    { type: 'Entitlement', item_name: 'access:research', quantity: 1 },
    { type: 'MeterUsage', resource: 'access:coaching-call', metric: 'call', period: 'month', pricing_rules: { included_units: 2 } },
  ]));
  assert.deepEqual(terms.line_items, [
    { label: 'Coaching', amount_cents: 150000 }, { label: 'Research', amount_cents: 25000 },
  ]);
  assert.equal(terms.amount_cents, 175000);
  assert.equal(terms.payment_timing, 'subscription');
  assert.deepEqual(terms.included, [
    { label: 'coaching' },
    { label: 'research', quantity: 1 },
    { label: 'coaching call', quantity: 2, unit: 'call', per: 'month' },
  ]);
  assert.deepEqual(entitlements.grants, ['access:coaching', 'access:coaching-call', 'access:research']);
  assert.deepEqual(entitlements.limits, [
    { key: 'access:research', quantity: 1 },
    { key: 'access:coaching-call', quantity: 2, unit: 'call', per: 'month' },
  ]);
  assert.equal(checkoutFromSalesContract({ ...saved([commitment('Coaching', 100)]), contract: { ...saved([commitment('Coaching', 100)]).contract, checkout: { allow_promotion_codes: true } } }).allowPromotionCodes, true);
  assert.equal(checkoutFromSalesContract({ ...saved([commitment('Coaching', 100)]), contract: { ...saved([commitment('Coaching', 100)]).contract, checkout: { promotion_code_id: 'promo_proof123' } } }).promotionCodeId, 'promo_proof123');
});

test('a finite recurring deal keeps the per-payment amount and the full agreed total separate', () => {
  const deal = saved([
    commitment('Coaching', 150000, { total_amount: 450000, metadata: { payment_structure: 'simple', billing_cycles: 3 } }),
    { type: 'MeterUsage', resource: 'access:coaching-call', metric: 'call', period: 'month', pricing_rules: { included_units: 2 } },
  ]);
  deal.contract.total_amount = 450000;
  const { terms, entitlements } = checkoutFromSalesContract(deal);
  assert.equal(terms.amount_cents, 150000);
  assert.equal(terms.billing_cycles, 3);
  assert.equal(terms.total_contract_amount_cents, 450000);
  assert.equal(terms.interval, 'month');
  assert.deepEqual(entitlements.limits, [{ key: 'access:coaching-call', quantity: 2, unit: 'call', per: 'month' }]);
  assert.throws(() => checkoutFromSalesContract(saved([
    commitment('Coaching', 150000, { total_amount: 450000, metadata: { payment_structure: 'simple', billing_cycles: 3 } }),
    commitment('Research', 10000),
  ])), /one payment schedule/);
});

test('terms Checkout cannot honor are refused before a contract is shared', () => {
  assert.throws(() => checkoutFromSalesContract(saved([commitment('Monthly', 100), commitment('Once', 200, { recurrence: 'one_time' })])), /one payment schedule/);
  assert.throws(() => checkoutFromSalesContract(saved([commitment('Simple', 100), commitment('Phased', 200, { metadata: { payment_structure: 'phased' } })])), /simple payment terms/);
  assert.throws(() => checkoutFromSalesContract(saved([commitment('Simple', 100), { type: 'Royalty', percentage: 10 }])), /royalties and transaction fees/);
  assert.throws(() => checkoutFromSalesContract(saved([commitment('Simple', 100), { type: 'MeterUsage', resource: 'access:call', pricing_rules: { included_units: 2, per_unit_cents: 100 } }])), /metered charges/);
  assert.throws(() => checkoutFromSalesContract(saved([commitment('Simple', 100), { type: 'GrantAccess', resource: 'access:coaching', constraint_rules: [{ operator: 'eq' }] }])), /access conditions/);
  assert.throws(() => checkoutFromSalesContract(saved([commitment('Simple', 100), { type: 'GrantAccess', resource: 'access:coaching', condition: 'time_limited', duration_amount: 1 }])), /time-limited access/);
  assert.throws(() => checkoutFromSalesContract(saved([commitment('Simple', 100), { type: 'Entitlement', item_name: 'access:coaching', quantity: 1, transferable: true }])), /transferable entitlements/);
  assert.throws(() => checkoutFromSalesContract(saved([commitment('Simple', 100, { total_amount: 200 })])), /amount match its total/);
  assert.throws(() => checkoutFromSalesContract(saved([commitment('Simple', 100, { metadata: { payment_structure: 'simple', billing_cycles: -2 } })])), /number of payments/);
  assert.throws(() => checkoutFromSalesContract(saved([commitment('Simple', 100, { metadata: { payment_structure: 'simple', billing_cycles: 2 }, total_amount: 100 })])), /amount match its total/);
  assert.throws(() => checkoutFromSalesContract({ ...saved([commitment('Simple', 100)]), contract: { ...saved([commitment('Simple', 100)]).contract, checkout: { promotion_code_id: 'not-a-promotion' } } }), /Stripe promotion code/);
  assert.throws(() => checkoutFromSalesContract({ ...saved([commitment('Simple', 100)]), contract: { ...saved([commitment('Simple', 100)]).contract, checkout: { promotion_code_id: 'promo_proof123', allow_promotion_codes: true } } }), /either a saved discount/);
});
