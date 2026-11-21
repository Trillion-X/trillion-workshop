// tools/take-payments/do-work/invoice-payment-intent.mjs
//
// The PaymentIntent a paid invoice was paid with. In this API version the invoice does not name it (its payment_intent is
// empty and its invoice.paid event carries no payments), so it is read from the invoice's payments. A subscription
// invoice is one payment: exactly one paid payment with a PaymentIntent is the answer. Anything else throws, so the
// caller keeps nothing and does not move its saved point (fail closed; there is no fallback key, which would count the
// payment twice).
//
// One read per paid invoice. The caller's `send` is the Stripe sender bound to the person's held key.

import { call } from '../../shared-code/src/build-provider-request.mjs';

/**
 * @param {string} invoiceId the invoice's Stripe id (in_…)
 * @param {Function} send the Stripe sender
 * @returns {Promise<string>} the PaymentIntent id (pi_…)
 */
export async function invoicePaymentIntent(invoiceId, send) {
  if (typeof invoiceId !== 'string' || !invoiceId) throw new Error('invoice payment: the invoice id is required.');
  const page = await call(send, 'operation:find-invoice-payments', { invoice: invoiceId, limit: '10' });
  const paid = (Array.isArray(page?.data) ? page.data : []).filter((row) => row?.status === 'paid');
  const intents = paid.map((row) => row?.payment?.payment_intent).filter((id) => typeof id === 'string' && id);
  if (paid.length !== 1 || intents.length !== 1) {
    throw new Error(`invoice ${invoiceId} has ${paid.length} paid payments with a PaymentIntent; exactly one is needed.`);
  }
  return intents[0];
}
