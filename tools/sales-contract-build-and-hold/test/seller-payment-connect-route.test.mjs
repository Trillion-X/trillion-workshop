import test from 'node:test';
import assert from 'node:assert/strict';
import { sellerPaymentLink, sellerPaymentRequest } from '../read-data/seller-payment-connect-route.mjs';

test('the setup request is a POST of an empty JSON body to the setup path', () => {
  assert.deepEqual(sellerPaymentRequest(), {
    path: '/work/api/seller-payments',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
});

test('a successful answer with a secure link gives that link', () => {
  assert.equal(sellerPaymentLink({ ok: true, result: { url: 'https://connect.example.test/setup/abc' } }), 'https://connect.example.test/setup/abc');
});

test('a failed answer gives its own error, else the old words', () => {
  assert.throws(() => sellerPaymentLink({ ok: false, result: { error: 'Your account is not ready.' } }), { message: 'Your account is not ready.' });
  assert.throws(() => sellerPaymentLink({ ok: false, result: {} }), { message: 'Payments could not be opened.' });
});

test('a link that is not a secure https address is refused', () => {
  assert.throws(() => sellerPaymentLink({ ok: true, result: { url: 'http://connect.example.test/x' } }), { message: 'Stripe did not return a secure setup link.' });
  assert.throws(() => sellerPaymentLink({ ok: true, result: { url: 'not a url' } }), { message: 'Stripe did not return a secure setup link.' });
  assert.throws(() => sellerPaymentLink({ ok: true, result: {} }), { message: 'Stripe did not return a secure setup link.' });
});
