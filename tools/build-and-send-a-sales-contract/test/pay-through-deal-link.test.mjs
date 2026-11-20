import test from 'node:test';
import assert from 'node:assert/strict';
import { paySection, settleFirst } from '../read-data/pay-through-deal-link.mjs';

const terms = { label: 'Coaching', billing_cycles: null };
const paymentWords = t => `${t.label} at 29 dollars`;
const section = (owed, extra = {}) => paySection({ owed, paymentWords, proven: true, canSign: false, signed: false, ...extra });
const owedWith = (status, rest = {}) => ({ terms, status, amount_due_today_cents: 2900, ...rest });

test('no owed record shows no pay section', () => {
  assert.equal(section(null), null);
});

test('a paid line with nothing due says no payment is required', () => {
  assert.deepEqual(section(owedWith('paid', { amount_due_today_cents: 0 })).body, { copy: 'sharing.paying.no_payment_required' });
});

test('a paid numbered plan says which payment came, out of how many', () => {
  const answer = section({ terms: { label: 'Plan', billing_cycles: 3 }, status: 'paid', amount_due_today_cents: 2900, payments_received: 2 });
  assert.deepEqual(answer.body, { text: 'Payment 2 of 3 received. Plan at 29 dollars.' });
  assert.equal(section({ terms: { label: 'Plan', billing_cycles: 3 }, status: 'paid', amount_due_today_cents: 2900 }).body.text, 'Payment 1 of 3 received. Plan at 29 dollars.');
});

test('a paid single payment gives the paid copy key with its words', () => {
  assert.deepEqual(section(owedWith('paid')).body, { copy: 'sharing.paying.paid', words: 'Coaching at 29 dollars' });
});

test('a saved payment method and a payment that was refused or taken show their own words', () => {
  assert.deepEqual(section(owedWith('awaiting-payment')).body, { text: 'Your payment method is saved. Your first payment is being checked.' });
  assert.deepEqual(section(owedWith('awaiting-payment')).actions, [{ kind: 'check-again' }]);
  assert.deepEqual(section(owedWith('taken')).body, { text: 'This was already accepted by someone else.' });
});

test('an ended payment names the reason it ended, and refunds are the default', () => {
  assert.equal(section(owedWith('payment-ended', { payment_end_reason: 'disputed' })).body.copy, 'sharing.paying.disputed');
  assert.equal(section(owedWith('payment-ended', { payment_end_reason: 'subscription-ended' })).body.copy, 'sharing.paying.subscription_ended');
  assert.equal(section(owedWith('payment-ended', { payment_end_reason: 'other' })).body.copy, 'sharing.paying.refunded');
});

test('a received payment offers the check-again action', () => {
  const answer = section(owedWith('payment-received'));
  assert.equal(answer.body.copy, 'sharing.paying.received');
  assert.deepEqual(answer.actions, [{ kind: 'check-again' }]);
});

test('an unproven buyer sees the price and no action', () => {
  const answer = section(owedWith('open'), { proven: false });
  assert.deepEqual(answer.body, { words: 'Coaching at 29 dollars' });
  assert.deepEqual(answer.actions, []);
});

test('a deal that asks for a signature first asks for it before any payment', () => {
  const answer = section(owedWith('open'), { canSign: true, signed: false });
  assert.deepEqual(answer.body, { words: 'Coaching at 29 dollars', copy: 'sharing.paying.sign_first' });
  assert.deepEqual(answer.actions, []);
});

test('a proven buyer who may pay gets the pay action', () => {
  assert.deepEqual(section(owedWith('open')).actions, [{ kind: 'pay', method: 'POST' }]);
  assert.deepEqual(section(owedWith('open'), { canSign: true, signed: true }).actions, [{ kind: 'pay', method: 'POST' }]);
});

test('the heading is the terms label, and the words come from the paymentWords function', () => {
  const answer = section(owedWith('open'));
  assert.equal(answer.heading, 'Coaching');
  assert.equal(answer.words, 'Coaching at 29 dollars');
});

test('settling first happens only for a payment already received on a buyer link', () => {
  assert.equal(settleFirst({ status: 'payment-received' }, 'buyer_1'), true);
  assert.equal(settleFirst({ status: 'payment-received' }, undefined), false);
  assert.equal(settleFirst({ status: 'open' }, 'buyer_1'), false);
});
