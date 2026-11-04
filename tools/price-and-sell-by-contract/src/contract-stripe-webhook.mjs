// Seller Stripe deliveries are wakeups, not trusted payment evidence. The caller routes
// them to the seller's addressed owner; that owner re-reads the exact saved Stripe objects
// before it changes contract or payment state.
const MAX_EVENT_BYTES = 256 * 1024;

async function boundedText(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_EVENT_BYTES) throw new Error('event-too-large');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_EVENT_BYTES) {
        await reader.cancel();
        throw new Error('event-too-large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

const json = (body, status = 200) => Response.json(body, { status });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Dispatch a Stripe event as an untrusted wakeup to its already-resolved seller owner. */
export async function handleContractStripeWebhook(request, sellerStore) {
  if (request.method !== 'POST') return json({ error: 'Use POST for payment notices.' }, 405);
  let event;
  try {
    event = JSON.parse(await boundedText(request));
  } catch (error) {
    return json({ error: error?.message === 'event-too-large' ? 'Payment notice is too large.' : 'Payment notice is not valid JSON.' }, error?.message === 'event-too-large' ? 413 : 400);
  }
  if (!isObject(event) || !isObject(event.data) || !isObject(event.data.object)) return json({ error: 'Payment notice is missing its event object.' }, 400);
  const objectId = event.data.object.id;
  if (typeof objectId !== 'string' || !/^[_A-Za-z0-9]+$/.test(objectId)) return json({ error: 'Payment notice is missing its Stripe object id.' }, 400);

  try {
    if (event.type === 'checkout.session.completed' && objectId.startsWith('cs_')) {
      // Session mode, customer, metadata and payment details are verified by the seller owner.
      if (typeof sellerStore.contractStripeNotice === 'function') {
        await sellerStore.contractStripeNotice({ method: 'completeFiniteSetup', object_id: objectId });
      } else await sellerStore.completeFiniteSetup({ checkout_session_id: objectId });
      return json({ received: true });
    }
    if (event.type === 'invoice.paid' && objectId.startsWith('in_')) {
      // The invoice id alone is enough; its subscription and negotiated offer are resolved by the seller owner.
      if (typeof sellerStore.contractStripeNotice === 'function') {
        // These fields are locator hints, never payment or buyer evidence. The
        // native owner re-reads Stripe and checks the selected original offer.
        const offered = event.data.object.metadata?.negotiated_offer_id;
        const subscription = event.data.object.subscription
          ?? event.data.object.parent?.subscription_details?.subscription;
        await sellerStore.contractStripeNotice({ method: 'reconcileFiniteInvoice', object_id: objectId,
          ...(typeof offered === 'string' ? { offer_id: offered } : {}),
          ...(typeof subscription === 'string' ? { subscription_id: subscription } : {}) });
      } else await sellerStore.reconcileFiniteInvoice({ invoice_id: objectId });
      return json({ received: true });
    }
    return json({ received: true, ignored: 'This event does not wake a finite contract payment.' });
  } catch {
    // A failed owner read or mutation must remain retryable at Stripe.
    return json({ error: 'The seller could not finish this payment notice. Stripe can retry it.' }, 503);
  }
}
