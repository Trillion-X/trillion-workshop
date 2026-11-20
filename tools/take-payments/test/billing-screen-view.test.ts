// tools/take-payments/test/billing-screen-view.test.ts
//
// The billing screen tells its empty cases apart: a host that names no purchase gets "no plan yet" and reads nothing;
// a read that failed gets the read-error words; a read that worked gets the purchase; and the words come from the
// screen's own words file, never from the screen's code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { billingScreenView } from '../packages/billing/show/billing-screen-view.ts';
import words from '../packages/billing/show/billing-words.json' with { type: 'json' };

test('no purchase is its own view, even when nothing loaded and nothing failed', () => {
  assert.equal(billingScreenView({ hasPurchase: false, loaded: false, failed: false }), 'no-purchase');
  assert.equal(billingScreenView({ hasPurchase: false, loaded: false, failed: true }), 'no-purchase');
});

test('a read that failed is a read error, and only when a purchase was named', () => {
  assert.equal(billingScreenView({ hasPurchase: true, loaded: false, failed: true }), 'read-error');
});

test('a purchase that is still being read is loading; one that loaded is the purchase', () => {
  assert.equal(billingScreenView({ hasPurchase: true, loaded: false, failed: false }), 'loading');
  assert.equal(billingScreenView({ hasPurchase: true, loaded: true, failed: false }), 'purchase');
});

test('the two empty cases say different things, from the words file', () => {
  assert.equal(words.no_purchase.title, 'No plan yet');
  assert.match(words.no_purchase.line, /after you join/);
  assert.notEqual(words.no_purchase.title, words.read_error);
  assert.match(words.read_error, /could not be read/);
});

test('the screen draws its empty copy from the words file, not from its own code', () => {
  const source = readFileSync(new URL('../packages/billing/show/BillingScreen.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /No plan yet|could not be read right now|after you join/);
  assert.match(source, /billing-words\.json/);
});
