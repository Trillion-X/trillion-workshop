import test from 'node:test';
import assert from 'node:assert/strict';
import { stripeReadPlan } from '../read-data/stripe-price-and-customer-reads.mjs';

test('the plan has one read per Stripe source, offers first then customers', () => {
  const plan = stripeReadPlan();
  assert.deepEqual(plan.map(read => read.id), ['stripe-prices', 'stripe-customers']);
  assert.deepEqual(plan.map(read => read.group), ['offers', 'customers']);
});

test('each read runs its own list tool under the stripe connection, with an empty input', () => {
  const [prices, customers] = stripeReadPlan();
  assert.deepEqual(prices.run, { tool_id: 'tool:stripe-events-list_prices', input: {} });
  assert.deepEqual(customers.run, { tool_id: 'tool:stripe-events-list_customers', input: {} });
  assert.equal(prices.connection, 'stripe');
  assert.equal(customers.connection, 'stripe');
  assert.deepEqual(prices.items, ['data']);
});

test('the plan is a copy: changing it does not change the next plan', () => {
  stripeReadPlan()[0].run.input.changed = true;
  assert.deepEqual(stripeReadPlan()[0].run.input, {});
});
