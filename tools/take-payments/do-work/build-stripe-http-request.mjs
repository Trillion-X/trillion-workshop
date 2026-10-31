// tools/take-payments/do-work/build-stripe-http-request.mjs
//
// Assemble a ready-to-send Stripe HTTP request from a capability request ({ operation_id, input_facts,
// idempotency_key, api_version_policy, required_credential_ref }). Everything up to the live key: the address, the
// form-encoded body, the idempotency and API-version headers. It contains no secret. Authentication is named, not
// carried: `auth.credential_ref` is the name of the person's own held key, and `stripe-send.mjs` is the only place
// that reads the key and puts it on the Authorization header at the moment of sending. A request built here and never
// sent moves no money, which is how the tools prepare a request for the person to look at first.
//
// Output shape (explicit fields, no string parsing):
//   {
//     method: "POST",
//     url: "https://api.stripe.com/v1/checkout/sessions",
//     headers: { "Content-Type": "...", "Stripe-Version": "...", "Idempotency-Key": "..." },
//     body: "line_items[0][price]=...&...",   // omitted for GET and DELETE
//     auth: { scheme: "bearer", credential_ref: "stripe-api-key" },
//     idempotency_key: "...",
//     operation_id: "operation:create-session"
//   }
//
// Each operation row carries the WHOLE address the vendor answers on, because this vendor serves more than one
// versioned namespace and a shared prefix could only ever be right for some of them.

import { mapCapabilityRequest, CURRENT_STRIPE_API_VERSION } from './stripe-request-mapper.mjs';
import { encodeStripeForm } from './stripe-form-encode.mjs';

// The name of the held value a Stripe call authenticates with. A restricted key is the least-privilege choice; the
// person puts the key's value in their held values under this name, never in a request, a row or a file.
export const DEFAULT_CREDENTIAL_REF = 'stripe-api-key';

/**
 * @param {object} capabilityRequest operation_id, input_facts, idempotency_key, api_version_policy, required_credential_ref
 * @returns {{method:string,url:string,headers:Record<string,string>,body?:string,auth:{scheme:string,credential_ref:string},idempotency_key?:string,operation_id:string,api_version:string}}
 */
export function buildStripeHttpRequest(capabilityRequest) {
  const mapped = mapCapabilityRequest(capabilityRequest);
  const apiVersion = mapped.api_version || CURRENT_STRIPE_API_VERSION;
  const credentialRef = capabilityRequest?.required_credential_ref || DEFAULT_CREDENTIAL_REF;

  const headers = { 'Stripe-Version': apiVersion, ...(mapped.acting_account ? { [mapped.acting_account.header]: mapped.acting_account.account } : {}) };
  const request = {
    operation_id: mapped.operation_id,
    method: mapped.method,
    url: mapped.query ? `${mapped.endpoint}?${encodeStripeForm(mapped.query)}` : mapped.endpoint,
    headers,
    auth: { scheme: 'bearer', credential_ref: credentialRef },
    api_version: apiVersion,
  };

  if (mapped.method !== 'GET' && mapped.method !== 'DELETE') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    request.body = encodeStripeForm(mapped.body || {});
    // Idempotency makes a retried POST safe: the same key answers the object already made instead of making another.
    if (mapped.idempotency_key) {
      headers['Idempotency-Key'] = mapped.idempotency_key;
      request.idempotency_key = mapped.idempotency_key;
    }
  }

  return request;
}

/**
 * Build the request for one named operation and hand it to the caller's `send`, which binds the key and returns the
 * decoded JSON reply (and throws on a non-2xx reply). The one way every setup, payee and session call is made.
 */
export function call(send, operationId, subject, { ref, idempotencyKey, actingAccount } = {}) {
  return send(buildStripeHttpRequest({
    operation_id: operationId,
    input_facts: {
      ...(subject ? { operation_subject: subject } : {}),
      ...(ref ? { provider_object_ref: ref } : {}),
      ...(actingAccount ? { acting_account: actingAccount } : {}),
    },
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  }));
}
