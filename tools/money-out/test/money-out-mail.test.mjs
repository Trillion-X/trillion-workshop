// What a payment mail says it cost (src/money-out-mail.mjs): the merchant, the amount paid, when, and the plan, from the
// rules in src/money-sources.json. A mail that says no amount paid, or that is a refund, is not a payment.
import assert from 'node:assert/strict';
import test from 'node:test';
import { paymentFromMail } from '../src/money-out-mail.mjs';
import moneySources from '../src/money-sources.json' with { type: 'json' };

const rules = moneySources.mail;
const at = '2026-10-02T09:00:00Z';

// A Gmail message as read in full (format=full): its headers, and its parts' bodies in base64url.
const b64 = text => Buffer.from(text).toString('base64url');
function gmail({ id = 'm-1', from, subject, plain, html, date = at }) {
  const headers = [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Date', value: date }];
  const parts = [];
  if (plain !== undefined) parts.push({ mimeType: 'text/plain', body: { data: b64(plain) } });
  if (html !== undefined) parts.push({ mimeType: 'text/html', body: { data: b64(html) } });
  const multi = parts.length > 1;
  return {
    id,
    internalDate: String(Date.parse(date)),
    payload: multi
      ? { mimeType: 'multipart/alternative', headers, body: {}, parts }
      : { mimeType: parts[0].mimeType, headers, body: parts[0].body },
  };
}

test('a Stripe receipt names the merchant from its subject and the amount paid', () => {
  const payment = paymentFromMail(gmail({
    id: 'stripe-1',
    from: 'Stripe <receipts@stripe.com>',
    subject: 'Your receipt from Linear #1234-5678',
    plain: 'Receipt number 1234-5678\nAmount paid $16.00\nDate paid October 2, 2026\n',
  }), rules);
  assert.deepEqual(payment, { id: 'stripe-1', merchant: 'Linear', amount: 16, at: '2026-10-02T09:00:00.000Z', plan: null });
});

test('an Apple receipt reads its TOTAL line', () => {
  const payment = paymentFromMail(gmail({
    id: 'apple-1',
    from: 'Apple <no_reply@email.apple.com>',
    subject: 'Your receipt from Apple.',
    plain: 'Apple Music Individual\nSubtotal $9.99\nTOTAL $9.99\nBilled to Visa ending 4242\n',
  }), rules);
  assert.equal(payment.merchant, 'Apple');
  assert.equal(payment.amount, 9.99);
});

test('a Google Play receipt reads its total in US dollars and names the merchant from the subject', () => {
  const payment = paymentFromMail(gmail({
    id: 'play-1',
    from: 'Google Play <googleplay-noreply@google.com>',
    subject: 'Your receipt from Google Play',
    plain: 'Order total: US$4.99\nPaid with Visa\n',
  }), rules);
  assert.equal(payment.merchant, 'Google Play');
  assert.equal(payment.amount, 4.99);
});

test('an invoice names the vendor and reads Amount due', () => {
  const payment = paymentFromMail(gmail({
    id: 'inv-1',
    from: 'Vercel <billing@vercel.com>',
    subject: 'Invoice from Vercel #A1B2-0009',
    plain: 'Your invoice for October is ready.\nAmount due $20.00 USD\n',
  }), rules);
  assert.deepEqual([payment.merchant, payment.amount, payment.plan], ['Vercel', 20, null]);
});

test('a shipping notice with no amount is not a payment', () => {
  const shipping = gmail({
    id: 'ship-1',
    from: 'Shop <orders@shop.example>',
    subject: 'Your order has shipped',
    plain: 'Your parcel left the warehouse.\nTracking 1Z999AA10123456784\n',
  });
  assert.equal(paymentFromMail(shipping, rules), null);
});

test('a refund is not a payment, even when it names a total', () => {
  const refund = gmail({
    id: 'refund-1',
    from: 'Stripe <receipts@stripe.com>',
    subject: 'Refund issued: Linear',
    plain: 'Total refunded $16.00\nThe money returns to Visa ending 4242.\n',
  });
  assert.equal(paymentFromMail(refund, rules), null);
});

test('a credit or balance line does not stand for the amount paid; the total does', () => {
  const payment = paymentFromMail(gmail({
    id: 'credit-1',
    from: 'Notion <team@mail.notion.so>',
    subject: 'Your receipt from Notion',
    plain: 'Amount paid after credit $5.00\nBalance remaining $0.00\nTotal $10.00\n',
  }), rules);
  assert.equal(payment.amount, 10);
});

test('an html-only mail reads its table cells as one line', () => {
  const payment = paymentFromMail(gmail({
    id: 'html-1',
    from: 'Notion <team@mail.notion.so>',
    subject: 'Your receipt from Notion',
    html: '<html><head><style>td { color: red }</style></head><body><table>'
      + '<tr><td>Plan</td><td>Plus&nbsp;monthly</td></tr>'
      + '<tr><td>Amount paid</td><td>$12.00</td></tr></table></body></html>',
  }), rules);
  assert.deepEqual([payment.merchant, payment.amount, payment.plan], ['Notion', 12, null]);
});

test('a mail with a plain part reads the plain part before the html', () => {
  const payment = paymentFromMail(gmail({
    id: 'both-1',
    from: 'Stripe <receipts@stripe.com>',
    subject: 'Your receipt from Linear #1234-5678',
    plain: 'Amount paid $16.00\n',
    html: '<p>Amount paid $18.00</p>',
  }), rules);
  assert.equal(payment.amount, 16);
});

test('with no merchant in the subject, the sender display name without its billing words names the merchant', () => {
  const payment = paymentFromMail(gmail({
    id: 'name-1',
    from: 'Acme Billing <billing@acme.io>',
    subject: 'Thanks for your payment',
    plain: 'Amount charged $30.00 to your card.\n',
  }), rules);
  assert.deepEqual([payment.merchant, payment.amount], ['Acme', 30]);
});

test('a sender with no display name is named by its domain', () => {
  const payment = paymentFromMail(gmail({
    id: 'domain-1',
    from: 'billing@widgets.io',
    subject: 'Payment confirmation',
    plain: 'Total $7.50\n',
  }), rules);
  assert.deepEqual([payment.merchant, payment.amount], ['widgets', 7.5]);
});

test('the plan is what the subject names beside the merchant', () => {
  const payment = paymentFromMail(gmail({
    id: 'plan-1',
    from: 'Netflix <info@netflix.com>',
    subject: 'Your Netflix subscription',
    plain: 'Total $15.49\n',
  }), rules);
  assert.deepEqual([payment.merchant, payment.plan], ['Netflix', 'subscription']);
});

test('a mail with no message id is not a payment', () => {
  assert.equal(paymentFromMail({ payload: {} }, rules), null);
});
