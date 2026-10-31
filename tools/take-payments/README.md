# tools/take-payments/

A person who sells with their own Stripe account can have their AI price a sale from their offers, send a buyer to a Stripe checkout, recover a checkout the buyer's browser never came back from, list every completed checkout and every ended subscription since a time so each buyer is followed up once, schedule later payments, count a pay-in-N plan and stop it at the last payment, cancel a subscription, keep Stripe holding one lasting payment link for every priced option, check a Stripe event before believing it, check what a buyer paid against what the offer says, decide which offers a buyer may see, and pay people through Stripe Connect. The person's offer rows are read by `tools/funnels-and-offers/read-data/read-offers.ts`, the one reader of offers; every row packs that file at `/opt/funnels-and-offers`. Ported from the old packages `stripe-payment-provider`, `payment-adapter` and `checkout`: the pure decisions and the Stripe request builders are theirs; the old engine's sends, signed quote reservations and descriptor plumbing are not carried.

## Money rules

- **Nothing moves without the person's own key.** Every row that can reach Stripe mounts one held value (`stripe-api-key`, or `stripe-test-api-key` for the rehearsal) on descriptor 4, and the records door is descriptor 3. The key is read in `do-work/stripe-send.mjs` and put on the Authorization header of one request at the moment of sending. It is never in a row, a request the other modules build, an answer or an error (a Stripe refusal is reported with every key-shaped word redacted).
- **Nothing here prices anything.** Prices, plans, codes and rules are the person's own records (`commercial-offer`, `checkout-code-adjustment`, `offer-eligibility-rule`), read through the records door, or passed in the request. The folder ships no offer, no price and no default.
- **Paying money out asks twice.** `tool:pay-someone-a-share-through-stripe` sends nothing unless `confirm_moves_money: true` is in the same request.
- **A rehearsal can only touch test mode.** The key must start with a Stripe test prefix, checked before any request is built.
- **A webhook is believed only after its checks.** `tool:check-a-stripe-event` checks the replay window and the signature (HMAC-SHA256 with the person's signing secret on descriptor 5), then reads the event through the data map in `read-data/stripe-webhook-event-map.json`. The payment event it keeps (type `payment-event`) is the same shape `tools/revenue-ledger` adds up.
- **Webhook endpoints are not made here.** Stripe shows an endpoint's signing secret only when it is created, and a tool's answer must not carry a secret; the person adds the endpoint in Stripe and keeps the secret in their held values.

## Files

| File | Purpose |
|------|---------|
| `read-data/unit-price-curve.ts` | Per-unit price as a piecewise curve (`curveAmountCents`) and its exact inverse (`paidMatchesCurve`). |
| `read-data/charge-dimensions.ts` | Additive N-dimensional pricing, scalar and per-scope. |
| `read-data/read-code-adjustments.ts` | Reads `checkout-code-adjustment` rows (percent or amount off, scoped). |
| `read-data/checkout-quote.ts`, `checkout-contract.ts` | `buildCheckoutMaterialQuote` and `buildCheckoutQuote`: what is due today, what repeats and when. A code that is unknown or does not apply never aborts a quote; it falls back to full price with a notice. |
| `read-data/when-money-is-taken.ts` | One shape for when a price takes money: charges with days after signup, and a repeat. |
| `read-data/verify-paid-amount.ts` | Money gate: the paid amount must be a price the offer declares. |
| `read-data/offer-eligibility.ts` | Upsell and already-owns rules over what the buyer holds. |
| `read-data/stripe-operation-map.json` | One row per Stripe operation (method, whole address, subject). Adding an operation is one row. |
| `read-data/stripe-webhook-event-map.json`, `stripe-payee-event-map.json` | Stripe event type to payment event, as data. |
| `do-work/stripe-request-mapper.mjs`, `stripe-form-encode.mjs`, `build-stripe-http-request.mjs` | Operation row to a ready-to-send request, form-encoded; `call` builds and sends one. |
| `do-work/stripe-send.mjs` | The only place the key is read and used. |
| `do-work/stripe-phases-for-a-payment-schedule.ts` | A payment schedule as the part taken at the door and the Stripe subscription phases after it. |
| `do-work/session-intent.ts` | A quote to a provider-neutral session intent and back to checkout material. |
| `do-work/hosted-session.ts` | Create and read a hosted checkout, find a completed one, list every completed one since a time (payment links included) and every subscription that ended since a time, create a schedule, cancel, tag, and count installments. |
| `do-work/ensure-offer-payment-links.mjs` | Lasting payment links, percent-off codes and the plan page, found before made. |
| `do-work/connect-payees.mjs` | Payee account, onboarding link, destination checkout, share transfer subjects, and payee readiness. |
| `do-work/parse-stripe-signature.mjs`, `compare-and-map-stripe-webhook.mjs`, `map-stripe-webhook-event.mjs` | The webhook check. |
| `do-work/rehearse-a-payment-schedule.mjs` | Test-mode rehearsal of a schedule. |
| `do-work/stripe-response-redactor.mjs` | Strips key-shaped words from anything Stripe says. |
| `do-work/take-payments.mjs` | The function each row runs. |
| `tool-rows.json` | The eighteen rows. |
| `test/` | The ported cases (curve, dimensions, price discovery, voluntary amounts, verify, phases, webhook, request builder, Connect, links) and new ones for the quote, hosted session, listing completed checkouts and ended subscriptions (answers shaped like Stripe test mode), rows and money rules. `expect.mjs` is a vitest-shaped helper that compares whole-cent bigint amounts. |

## Not carried, with the reason

- `stripe-payment-elements`: the secure-field mount, the section list for a screen and the browser Stripe.js confirmation are drawing and browser glue; they belong with the screens, and the only logic in them (redacting key-shaped words) is in `stripe-response-redactor.mjs`.
- `checkout/show/*`, the iOS JSCore mounts, the descriptor readers (`checkout-descriptors`, `checkout-fields`, `checkout-rules`, `event-templates`) and the old signed-quote, account-identity and signed-event sends in `gate-checkout.ts` belong to the old engine's plumbing.
- `payment-adapter` route descriptors (`operation-routes.ts`, the spend-rail descriptors): old-engine routing; spend rails are `tools/guard-ai-spending`.
