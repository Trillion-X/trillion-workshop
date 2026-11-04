# tools/seller-payment-setup

The payment provider (Stripe) half of a seller's payment setup: which operation becomes which request (`data/stripe-operation-map.json`, DATA), the request built from it with no key in it, and a provider webhook checked and read as a payment event. Nothing here sends a request or holds a key; a sender binds the seller's own key to a built request at the moment it sends.

## Files

| File | Purpose |
|------|---------|
| `part.json` | Which files other code may import |
| `data/stripe-operation-map.json` | Each operation's method, whole address, subject key, object ref key, whether it hands the person off, and the account it acts for |
| `data/stripe-webhook-event-map.json` | How each provider webhook event type reads as a payment event |
| `data/quantity-limits.json` | The provider's limits on an adjustable quantity and an amount |
| `process/build-stripe-http-request.mjs` | `buildStripeHttpRequest({ operation_id, input_facts, idempotency_key, api_version_policy, required_credential_ref })`: the finished request, its key named, never carried (what `tool-rows.json` runs) |
| `process/build-stripe-http-request-cli.mjs` | The same from the command line |
| `process/stripe-request-mapper.mjs` | `mapCapabilityRequest(request)`: an operation and its facts as method, address, body or query and headers |
| `process/stripe-form-encode.mjs` | `encodeStripeForm(body)`: bracket-notation form encoding |
| `process/parse-stripe-signature.mjs`, `process/compare-and-map-stripe-webhook.mjs`, `process/map-stripe-webhook-event.mjs` | A webhook's signature header read and compared, and the event read as a payment event |
| `process/quantity-for-checkout.mjs` | `quantityForCheckout(option)`: the quantity range one checkout can take |
| `process/read-cli-input.mjs` | The command-line input reader |
| `tool-rows.json` | The row `tool:build-a-sellers-payment-setup-request`, with a sample that builds the onboarding link request for a made-up connected account |
| `README.md` | This file |

## The row

`tool:build-a-sellers-payment-setup-request` runs `buildStripeHttpRequest` in a small container with no internet and answers the request it built. It sends nothing; sending with the seller's key and taking the seller to the onboarding page are not part of it.
