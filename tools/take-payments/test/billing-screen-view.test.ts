// tools/take-payments/test/billing-screen-view.test.ts
//
// The billing screen's views: a person with no purchase is on the free plan and reads nothing; a read that failed is a read
// error; a read still going is loading; a read that worked is the purchase. The screen never says there is nothing here, and
// its copy comes from the screen's words file, never from the screen's code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { billingScreenView } from '../packages/billing/show/billing-screen-view.ts';
import words from '../packages/billing/show/billing-words.json' with { type: 'json' };

test('no purchase is the free plan, even when nothing loaded and nothing failed', () => {
  assert.equal(billingScreenView({ hasPurchase: false, loaded: false, failed: false }), 'free');
  assert.equal(billingScreenView({ hasPurchase: false, loaded: false, failed: true }), 'free');
});

test('a read that failed is a read error, and only when a purchase was named', () => {
  assert.equal(billingScreenView({ hasPurchase: true, loaded: false, failed: true }), 'read-error');
});

test('a purchase that is still being read is loading; one that loaded is the purchase', () => {
  assert.equal(billingScreenView({ hasPurchase: true, loaded: false, failed: false }), 'loading');
  assert.equal(billingScreenView({ hasPurchase: true, loaded: true, failed: false }), 'purchase');
});

test('the words file carries the plan, parts and read-error words', () => {
  assert.equal(words.free_plan, 'Free');
  assert.equal(words.other_plans, 'Other plans');
  assert.match(words.read_error, /could not be read/);
});

test('the screen draws its copy from the words file and never says there is nothing here', () => {
  const source = readFileSync(new URL('../packages/billing/show/BillingScreen.tsx', import.meta.url), 'utf8');
  assert.match(source, /billing-words\.json/);
  assert.doesNotMatch(source, /\bNo [a-z]+ yet\b|No card is on file|could not be read right now|after you join/);
  assert.doesNotMatch(source, /EmptyPlaceholder/);
});
