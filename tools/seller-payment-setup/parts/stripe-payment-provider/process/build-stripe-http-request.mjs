// parts/stripe-payment-provider/process/build-stripe-http-request.mjs
//
// Assemble a transport-agnostic, ready-to-send Stripe HTTP request from a mapped
// capability request. This is the request-construction half of real Stripe
// execution (#41) — everything UP TO the live secret. It contains ZERO secrets:
// authentication is expressed as a `credential_ref` (the credential-class the
// http-client runner must resolve from credentials-vault and inject as
// `Authorization: Bearer <secret>`). No key, no live call here — pure assembly,
// fully provable with a fixture.
//
// Why this lives here (L098 / no-god-package): only stripe-payment-provider knows
// Stripe's base URL, form-encoding, idempotency header, and API-version header.
// The http-client part stays a blind transport — it receives a finished
// request descriptor + a credential handle and sends bytes. It never learns
// "Stripe".
//
// Output shape (machine-readable, explicit fields — L: machine-readable-over-shorthand):
//   {
//     method: "POST",
//     url: "https://api.stripe.com/v1/checkout/sessions",
//     headers: { "Content-Type": "...", "Stripe-Version": "...", "Idempotency-Key": "..." },
//     body: "line_items[0][price]=...&...",   // omitted for GET
//     auth: { scheme: "bearer", credential_ref: "credential-class:stripe-restricted-key" },
//     idempotency_key: "...",
//     operation_id: "operation:create-session"
//   }
//
// SECURITY (SP4/SP7/SP8): the Authorization header is NEVER materialized here;
// the runner binds the credential to this request at send time. `auth.credential_ref`
// is the only authority pointer. A missing credential at send time => the runner
// fails closed (no anonymous Stripe call).

import { readCliInput } from './read-cli-input.mjs';
import { mapCapabilityRequest, CURRENT_STRIPE_API_VERSION } from './stripe-request-mapper.mjs';
import { encodeStripeForm } from './stripe-form-encode.mjs';

// There is no base URL any more. Each operation row carries the WHOLE address
// the vendor answers on, because this vendor serves more than one versioned
// namespace and a shared prefix could only ever be right for some of them: one
// row was already an exception living inside a rule that claimed there were
// none.

// The credential-class each Stripe call authenticates with. Restricted keys are
// the least-privilege default (SP9); the owner provisions the secret VALUE into
// credentials-vault under this class — never into source.
const DEFAULT_CREDENTIAL_REF = 'credential-class:stripe-restricted-key';

/**
 * @param {object} capabilityRequest - the capability invocation (operation_id, input_facts, idempotency_key, api_version_policy, required_credential_ref)
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
    if (mapped.body_encoding === 'json') {
      headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(mapped.body || {});
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      request.body = encodeStripeForm(mapped.body || {});
    }
    // Idempotency is mandatory for POST money operations (SP: replay-safety).
    if (mapped.idempotency_key) {
      headers['Idempotency-Key'] = mapped.idempotency_key;
      request.idempotency_key = mapped.idempotency_key;
    }
  }

  return request;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = readCliInput(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(buildStripeHttpRequest(input))}\n`);
}
