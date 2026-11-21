// The builder's price lines, total and message, over the offer's own price-part shape (offer_price_parts rows).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quoteLines, fillTemplate, composeMessage } from '../do-work/contract-builder-quote.mjs';

const part = (piece, option_key, basis, extra = {}) => ({ piece, option_key, basis, label: `${piece} ${option_key}`, unit: null, amount_cents: 0, percent: null, shown_publicly: true, ...extra });
const parts = [
  part('format', 'online', 'flat'),
  part('length', 'per-hour', 'per_unit', { amount_cents: 50000, unit: 'hour' }),
  part('length', 'per-day', 'per_unit', { amount_cents: null, unit: 'day' }),
  part('publicity', 'private', 'flat', { shown_publicly: false }),
  part('publicity', 'public', 'percent', { percent: -25, shown_publicly: false }),
  part('testimonial', 'gives', 'percent', { percent: -10, shown_publicly: false }),
  part('testimonial', 'none', 'flat', { shown_publicly: false }),
  part('travel', 'at-cost', 'at_cost'),
];
const words = { at_cost: 'at cost', unpriced: 'not priced yet', link_not_yet: 'made when sent', payment_not_set_up: 'payment link not set up' };
const money = cents => `$${(cents / 100).toFixed(2)}`;

test('two hours at the hourly rate, a public discount and a testimonial discount: the total is the sum of the amount lines plus the percent lines on them', () => {
  const quote = quoteLines(parts, {
    format: { option: 'online' }, length: { option: 'per-hour', quantity: 2 }, publicity: { option: 'public' },
    testimonial: { option: 'gives' }, travel: { option: 'at-cost' },
  });
  assert.equal(quote.total_cents, 100000 - 25000 - 10000);
  assert.equal(quote.lines.find(line => line.piece === 'travel').kind, 'at_cost');
  assert.equal(quote.lines.find(line => line.piece === 'travel').total_cents, null);
});

test('an unpriced part makes the total null, not zero', () => {
  const quote = quoteLines(parts, {
    format: { option: 'online' }, length: { option: 'per-day', quantity: 1 }, publicity: { option: 'private' },
    testimonial: { option: 'none' }, travel: { option: 'at-cost' },
  });
  assert.equal(quote.total_cents, null);
});

test('an edited amount on the spot changes the line and the total', () => {
  const quote = quoteLines(parts, {
    format: { option: 'online' }, length: { option: 'per-hour', quantity: 1, amount_cents: 40000 }, publicity: { option: 'private' },
    testimonial: { option: 'none' }, travel: { option: 'at-cost' },
  });
  assert.equal(quote.lines.find(line => line.piece === 'length').total_cents, 40000);
  assert.equal(quote.total_cents, 40000);
});

test('a per-unit part needs a whole number of units', () => {
  assert.throws(() => quoteLines(parts, {
    format: { option: 'online' }, length: { option: 'per-hour', quantity: 0 }, publicity: { option: 'private' },
    testimonial: { option: 'none' }, travel: { option: 'at-cost' },
  }), /whole number/);
});

test('every piece needs one chosen option', () => {
  assert.throws(() => quoteLines(parts, { format: { option: 'online' } }), /exactly one chosen option/);
});

test('the message carries the customer, the lines, the total and the words where a value is not set', () => {
  const quote = quoteLines(parts, {
    format: { option: 'online' }, length: { option: 'per-hour', quantity: 2 }, publicity: { option: 'public' },
    testimonial: { option: 'gives' }, travel: { option: 'at-cost' },
  });
  const message = composeMessage({
    sender: { name: 'Sender', from_address: 'Sender <hello@example.test>', reply_to: 'hello@example.test', mailing_address: '1 Street' },
    customer: { name: 'Test Customer', email: 'customer@example.test' },
    template: { subject: 'Your offer, {name}', body: 'Offer: {offer}\n{lines}\nTotal: {total}\nLink: {link}\nPayment: {payment}\n{signature}' },
    offerLabel: 'Private coaching', lines: quote.lines, total_cents: quote.total_cents, link: null, money, words,
  });
  assert.equal(message.to, 'customer@example.test');
  assert.equal(message.subject, 'Your offer, Test Customer');
  assert.match(message.body, /Total: \$650\.00/);
  assert.match(message.body, /Link: made when sent/);
  assert.match(message.body, /Payment: payment link not set up/);
  assert.match(message.body, /at cost/);
});

test('an unknown placeholder stays as written', () => {
  assert.equal(fillTemplate('a {b} c {d}', { b: 'x' }), 'a x c {d}');
});
