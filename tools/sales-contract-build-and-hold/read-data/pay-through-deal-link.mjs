// The pay section of a shared deal's page: what the buyer sees for each payment status, and whether the page offers to pay
// now. Port of ABILITY_SECTIONS.pay in the old share page owner (tools/write-public-share-files/from-an-older-version/src/
// record-share-pages.mjs). Storage-free: the caller reads the payment terms and passes them in. Words that the old owner
// took from its copy file come back as copy keys, so the copy owner words them; the literal sentences stay here.
import data from './pay-through-deal-link.json' with { type: 'json' };

/** True when the page must first settle a payment already taken, for this buyer (the seller's Stripe is asked then). */
export function settleFirst(owed, buyerRef) {
  return owed.status === 'payment-received' && Boolean(buyerRef);
}

/** The text of a numbered payment line, as the page writes it. */
function numbered(received, cycles, words) {
  return data.payments_numbered
    .replace('{received}', () => String(received || 1))
    .replace('{cycles}', () => String(cycles))
    .replace('{words}', () => words);
}

/**
 * owed: { terms: { label, billing_cycles? }, status, payment_end_reason?, amount_due_today_cents, payments_received? };
 * paymentWords(terms) → the plain words for the terms; proven: the buyer proved their address; canSign: the deal asks
 * for a signature; signed: the buyer has signed.
 * → { heading, words, body, actions } where body is { copy } (a copy key), { text } (a literal sentence), or { words }
 * alone; actions lists { kind: 'check-again' } or { kind: 'pay', method: 'POST' }. null when there is no owed record.
 */
export function paySection({ owed, paymentWords, proven, canSign, signed }) {
  if (!owed) return null;
  const { terms, status, payment_end_reason: endReason, amount_due_today_cents: due, payments_received: received } = owed;
  const words = paymentWords(terms);
  const section = { heading: terms.label, words, body: { words }, actions: [] };
  const checkAgain = { kind: 'check-again' };
  if (status === 'paid') {
    if (due === 0) section.body = { copy: data.copy.no_payment_required };
    else if (Number.isSafeInteger(terms.billing_cycles)) section.body = { text: numbered(received, terms.billing_cycles, words) };
    else section.body = { copy: data.copy.paid, words };
    return section;
  }
  if (status === 'awaiting-payment') {
    section.body = { text: data.text.payment_saved };
    section.actions = [checkAgain];
    return section;
  }
  if (status === 'payment-ended') {
    const copy = endReason === 'disputed' ? data.copy.disputed
      : endReason === 'subscription-ended' ? data.copy.subscription_ended : data.copy.refunded;
    section.body = { copy };
    return section;
  }
  if (status === 'payment-received') {
    section.body = { copy: data.copy.received };
    section.actions = [checkAgain];
    return section;
  }
  if (status === 'taken') {
    section.body = { text: data.text.taken };
    return section;
  }
  if (!proven) return section;
  if (canSign && !signed) {
    section.body = { words, copy: data.copy.sign_first };
    return section;
  }
  section.actions = [{ kind: 'pay', method: 'POST' }];
  return section;
}
