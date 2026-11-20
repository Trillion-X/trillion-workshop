// The seller's own payment setup: the request that starts it, and the rule for the setup link it answers with. Port of
// startSellerPaymentConnect in the old web client (web/src/workspace/seller-payment-connect.mjs at 792aae2aa). Storage-free
// and network-free: the caller sends the request and passes back the answer; nothing here opens a page or calls a service.
import data from './seller-payment-connect-route.json' with { type: 'json' };

/** The request that starts the setup. The path is named here and nowhere is it sent by this module. */
export function sellerPaymentRequest() {
  return { path: data.path, method: data.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) };
}

/**
 * ok: the answer's status is a success; result: its parsed body ({} when it had none).
 * → the secure https setup link to open. Refuses with the answer's own error, else the old words.
 */
export function sellerPaymentLink({ ok, result }) {
  if (!ok) throw new Error(result?.error || data.messages.not_opened);
  if (typeof result?.url !== 'string' || !URL.canParse(result.url) || new URL(result.url).protocol !== 'https:') {
    throw new Error(data.messages.no_link);
  }
  return result.url;
}
