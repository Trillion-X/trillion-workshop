// Whether a deal may be sent at all: it is paid when it is free (signed, no checkout), when the person's own Stripe is
// connected, or when the platform payments are ready. A payment plan with a fixed number of payments needs the own
// Stripe. Port of the payment gate in sendSalesContract (src/native-commercial-domain.mjs at 3b7063d6f3). Storage-free:
// the caller passes the facts; platformReady is a function so it is asked only when the old code asked it.
import data from './send-refused-without-payment-path.json' with { type: 'json' };

/** True when the person's own Stripe connection is connected. */
export function ownStripeConnected(connections) {
  return connections.some(item => item.connection_id === data.seller_payment_connection && item.status === data.connected_status);
}

/** True when a commitment in the deal asks for a fixed number of payments. */
export function hasFixedPayments(contract) {
  return (contract.contract?.rules ?? []).some(row => row?.type === 'Commitment' && Number.isSafeInteger(row.metadata?.billing_cycles));
}

/**
 * → { paid: true } when the deal may be sent, else { paid: false, refusal } with the words the person sees.
 * platformReady() → boolean; it is called only when the deal is not free, has no own Stripe, and has no fixed payments.
 */
export function paymentPath({ free, ownStripe, fixedPayments, platformReady }) {
  const platform = !free && !ownStripe && !fixedPayments ? Boolean(platformReady()) : false;
  if (free || ownStripe || platform) return { paid: true };
  return { paid: false, refusal: fixedPayments ? data.messages.fixed_payments : data.messages.no_payment_path };
}
