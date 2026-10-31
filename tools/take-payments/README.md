# tools/take-payments/

A person who sells with their own Stripe account can have their AI price a sale from their offers, send a buyer to a Stripe checkout, recover a checkout the buyer's browser never came back from, list every completed checkout and every ended subscription since a time so each buyer is followed up once, schedule later payments, count a pay-in-N plan and stop it at the last payment, cancel a subscription, keep Stripe holding one lasting payment link for every priced option, check a Stripe event before believing it, check what a buyer paid against what the offer says, decide which offers a buyer may see, and pay people through Stripe Connect. The person's offer rows are read by `tools/funnels-and-offers/read-data/read-offers.ts`, the one reader of offers; every row packs that file at `/opt/funnels-and-offers`. Ported from the old packages `stripe-payment-provider`, `payment-adapter` and `checkout`: the pure decisions and the Stripe request builders are theirs; the old engine's sends, signed quote reservations and descriptor plumbing are not carried.

## Money rules

- **Nothing moves without the person's own key.** Every row that can reach Stripe mounts one held value (`stripe-api-key`, or `stripe-test-api-key` for the rehearsal) on descriptor 4, and the records door is descriptor 3. The key is read in `do-work/stripe-send.mjs` and put on the Authorization header of one request at the moment of sending. It is never in a row, a request the other modules build, an answer or an error (a Stripe refusal is reported with every key-shaped word redacted).
- **Every price comes from the person's DATA.** Prices, plans, codes and rules are the person's own records (`commercial-offer`, `checkout-code-adjustment`, `offer-eligibility-rule`, `usage-pricing-rule-version`), read through the records door, or passed in the request. The calculators apply those rules; the folder ships no offer, supplier tariff, retail markup or free allowance.
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
| `read-data/resource-usage.mjs` | Exact rational supplier-cost allocation, effective-dated resource/plan/client markup, purchased snapshots, subcent cash clearing and nested leaf-only pricing. Public to consumers through `part.json`. |
| `do-work/resource-usage.mjs` | Records-backed pricing configuration, immutable physical observations, supplier settlement/corrections and paged readback. Re-exported by `take-payments.mjs`, through the same records-door runner. |
| `tool-rows.json` | The eighteen rows. |
| `test/` | The ported cases (curve, dimensions, price discovery, voluntary amounts, verify, phases, webhook, request builder, Connect, links) and new ones for the quote, hosted session, listing completed checkouts and ended subscriptions (answers shaped like Stripe test mode), rows and money rules. `expect.mjs` is a vitest-shaped helper that compares whole-cent bigint amounts. |

## Resource usage, customer markup and pooled supplier cost

`tool:manage-usage-pricing` reads/lists and saves/retires/deletes a rule by `rule_id`.
Writes carry `request_key` and `expected_version` (0 for creation). Each change
appends an immutable `usage-pricing-rule-version` and atomically updates its head.
A retirement/deletion has an explicit `effective_at`; saving a new active version
restores a deleted rule. Deletion stops future pricing and preserves purchased
snapshots and financial evidence. Read a previous version with `version`.

A rule is `{id,scope:{resource_id?,plan_id?,client_id?},effective_at,markup_bps}`.
100 basis points is 1%; a caller-supplied default of `3000` means +30%. Client
editors can instead submit `markup_percent: "30"` (at most two decimal places).
The exact conversion refuses conflicting percent/basis-point fields; omit an old
`markup_bps` when replacing it through a human-facing percent editor. A rule may
retain its human `label` beside the structured scope. Client
rules override plan rules, then the deepest matching resource, then the default;
the latest effective version of each rule is considered. Equally specific,
simultaneously effective independent rules are refused. No rule means unknown
price, not free work. `pinned_terms` retain `{resource_id,rule_ref,markup_bps}`
from the purchase; changing today's rule never reprices them.

`tool:price-resource-usage` returns either resolved terms or a priced `tree`.
Leaves supply measured base `cost`, resource, quantity/unit and currency. Parents
only sum children; their own cost/markup is refused, as is repricing an already
charged tree. Every node returns exact `base_cost`, `markup_amount` and `charged`
plus decimal `display` strings. `presentation.visible/expanded` affects disclosure
only, never the amount. A tree may have at most 32 layers and 10,000 nodes, and one
currency. This is a bounded calculator, not proof of a billion-customer workload.

All money/units are exact `{n:"integer",d:"positive integer"}` or decimal strings;
non-integer JavaScript number inputs are refused. Display rounding is not ledger
rounding. `cashClearing` separately returns whole cash quanta and the exact carry,
never assigns a cent over the supplied cash ceiling, and never redistributes a
remainder onto another customer.

`resourceReservationQuote` is the shared pure pre-dispatch calculation: requested
source units, remaining purchased included units, a maximum base unit cost, pinned
terms and verified available customer/company balances produce separate company
and customer liabilities. It always says `requires_atomic_reservation: true`.
A quote does not acquire funds, capacity, entitlement or authority. The existing
budget/lease owner must atomically reserve both before the byte owner dispatches;
an included customer with zero overage authorization is not made to pay the
company's promised liability. No new parallel budget ledger is introduced here.

`tool:keep-resource-usage-observation` preserves attributed physical attempts as
`resource-usage-observation`. `state:"unknown"` carries no numeric amount; a
correction creates another `event_id` with `supersedes`, never overwrites measured
history. These observations are seller-adopted evidence, not a claim that this
tool authenticates an engine/supplier signature. No credentials, bearer URLs,
private file contents or names belong in these financial records.

`tool:settle-shared-resource-cost` takes one settlement key
`{supplier_pool,tariff_version,cost_class,invoice_period,currency,resource_id}`, a
confirmed invoice `{status:"confirmed",amount,evidence_ref}` and attributed
`payers`. A customer payer has `{payer_id,kind:"customer",excess_units,terms,
max_unit_cost,authorized_total}`; a platform payer needs only its id/kind/excess.
`authorized_total` covers the final customer amount including markup. Thus the
base supplier allocation is capped by the proportional share, excess times the
contract's maximum base unit cost and authorization divided by the markup factor.
Above-allowance classification is consumed once by the entitlement owner before
this tool; it is not cloned per supplier scope. Optional `observation_refs` replace
payer quantities with their exact, measured, unsuperseded source excess totals.
Unknown or cross-pool observations refuse final settlement.

The verified invoice is split across positive excess users, including platform
work as its own payer. Customers within allowance pay zero; capped/unallocatable
cost stays an explicit company residual rather than being spread onto them.
`company_funding` must explicitly cover platform expense and residual before
state becomes `reconciled`; otherwise state is `funding_required`. This creates
no unrequested free grant, no permission to bill a residual and no silent subsidy.
The tool cannot decide whether supplied provider evidence is authentic; the
caller must adopt it through the provider/invoice owner before final collection.

Writes use idempotency receipts, optimistic expected heads and immutable versions.
Large results use `resource-usage-allocation` rows in bounded batches, then one
committed head. Staged rows alone never authorize collection. Source-ref pages
retain exact observation provenance. `tool:read-resource-usage-settlement` reads
a version and at most 100 allocation rows with an opaque version-scoped cursor.
`tool:correct-resource-usage-settlement` appends a correction with
`expected_version` and `reason`, preserving purchased terms/ceilings and old
versions. Its negative deltas name refund/credit obligations; positive deltas name
the original-authority requirement. **It never sends money to Stripe**, marks a
refund complete or claims a customer invoice was collected. The existing payment
sender owns those effects, and the caller must not collect a `funding_required`
settlement or any amount beyond the original reservation. All records remain on
the invoking seller's own records door; a payer field never selects another
account. Customer-facing views project only that customer's authorized lines.

## Not carried, with the reason

- `stripe-payment-elements`: the secure-field mount, the section list for a screen and the browser Stripe.js confirmation are drawing and browser glue; they belong with the screens, and the only logic in them (redacting key-shaped words) is in `stripe-response-redactor.mjs`.
- `checkout/show/*`, the iOS JSCore mounts, the descriptor readers (`checkout-descriptors`, `checkout-fields`, `checkout-rules`, `event-templates`) and the old signed-quote, account-identity and signed-event sends in `gate-checkout.ts` belong to the old engine's plumbing.
- `payment-adapter` route descriptors (`operation-routes.ts`, the spend-rail descriptors): old-engine routing; spend rails are `tools/guard-ai-spending`.
