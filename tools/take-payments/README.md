# tools/take-payments/

A person who sells with their own Stripe account can have their AI price a sale from their offers, send a buyer to a Stripe checkout, recover a checkout the buyer's browser never came back from, list every completed checkout and every ended subscription since a time so each buyer is followed up once, schedule later payments, count a pay-in-N plan and stop it at the last payment, cancel a subscription, keep Stripe holding one lasting payment link for every priced option, check a Stripe event before believing it, check what a buyer paid against what the offer says, decide which offers a buyer may see, and pay people through Stripe Connect. The person's offer rows are read by `tools/funnels-and-offers/read-data/read-offers.ts`, the one reader of offers; every row packs that file at `/opt/funnels-and-offers`. Ported from the old packages `stripe-payment-provider`, `payment-adapter` and `checkout`: the pure decisions and the Stripe request builders are theirs; the old engine's sends, signed quote reservations and descriptor plumbing are not carried.

## Money rules

- **Nothing moves without the person's own key.** Every row that can reach Stripe mounts one field of the seller's Stripe connection (`secret_key`, `test_secret_key` for the rehearsal, `webhook_secret` for the webhook check) on descriptor 4 (5 for the webhook), and the run's input `seller_connection` names whose: `service_connection:stripe` is the person's own, `service_connection:stripe:<account>` another business's. The engine finds the vault name in that connection's row (`credential_injections` `{field_id, vault_key}`), so a business's key is data in its own row and no row names a vault key. A row that uses the seller's live key takes it
from exactly one of three inputs, each mounted on descriptor 4 only when given: `secret_name`, the key's vault name, mounted as
it is (marked `share_by_listing`: a share's run opens it only when its grant lists that very name); `account`, the account
whose key is held as `<account>-stripe-secret-key`; or `seller_connection`, as above. Two given together land on one
descriptor and the engine refuses the run before it starts; with none, no key is mounted and nothing is sent. The key is read in `do-work/stripe-send.mjs` and put on the Authorization header of one request at the moment of sending. It is never in a row, a request the other modules build, an answer or an error (a Stripe refusal is reported with every key-shaped word redacted).
- **Every price comes from the person's DATA.** Prices, plans, codes and rules are the person's own records (the rows of their offers list, `record:commercial-offer`; `checkout-code-adjustment`, `offer-eligibility-rule`, `usage-pricing-rule-version`). The sale tools (price, start checkout, payment links, check what was paid, show offers, list checkouts as payment events) and the usage tools that compute (`price-resource-usage`, `keep-resource-usage-observation`, `settle-shared-resource-cost`, `correct-resource-usage-settlement`, `report-resource-usage`, `reconcile-resource-usage-report`) keep nothing and open no records door: the caller's AI reads those rows from its store and passes them in the request (`offers`, `adjustments`, `rules`, `suggestions`), and the result is the answer. The calculators apply those rules; the folder ships no offer, supplier tariff, retail markup or free allowance.
- **A checkout code takes its discount off what the buyer pays today, and a code of duration `once` never changes the recurring price.** The floor of a price (`voluntary_amount_policy.min_cents`) is checked on the amount the buyer chose, so a code may take the amount due below it. A code of duration `once` keeps the recurring price full: its discount is a Stripe coupon with duration `once`, put on the Checkout Session as `discounts`, and it takes the amount off the first invoice only. Any other code takes its discount off the recurring price, as before.
- **A customer credit is a balance Stripe takes off the next invoice.** `giveACustomerCredit` sends one negative customer balance transaction (`operation:create-customer-balance-transaction`) with the caller's idempotency key, and refuses an answer whose booked amount is not the credit asked for. Nothing else in this folder gives a credit.
- **Paying money out asks twice.** `tool:pay-someone-a-share-through-stripe` sends nothing unless `confirm_moves_money: true` is in the same request.
- **A rehearsal can only touch test mode.** The key must start with a Stripe test prefix, checked before any request is built.
- **A webhook is believed only after its checks.** `tool:check-a-stripe-event` checks the replay window and the signature (HMAC-SHA256 with the person's signing secret on descriptor 5), then reads the event through the data map in `read-data/webhook-event-map.json`. The payment event it answers (type `payment-event`) is the same shape `tools/revenue-ledger` adds up.
- **Webhook endpoints are not made here.** Stripe shows an endpoint's signing secret only when it is created, and a tool's answer must not carry a secret; the person adds the endpoint in Stripe and keeps the secret in their held values.

## Files

| File | Purpose |
|------|---------|
| `read-data/unit-price-curve.ts` | Per-unit price as a piecewise curve (`curveAmountCents`) and its exact inverse (`paidMatchesCurve`). |
| `read-data/charge-dimensions.ts` | Additive N-dimensional pricing, scalar and per-scope. |
| `read-data/read-code-adjustments.ts` | Reads `checkout-code-adjustment` rows (percent or amount off, scoped). |
| `read-data/checkout-quote.ts`, `checkout-contract.ts` | `buildCheckoutMaterialQuote` and `buildCheckoutQuote`: what is due today, what repeats and when. A code that is unknown or does not apply never aborts a quote; it falls back to full price with a notice. A code of duration `once` keeps the recurring price full and takes its discount off the first invoice only. |
| `read-data/when-money-is-taken.ts` | One shape for when a price takes money: charges with days after signup, and a repeat. |
| `read-data/verify-paid-amount.ts` | Money gate: the paid amount must be a price the offer declares. |
| `read-data/offer-eligibility.ts` | Upsell and already-owns rules over what the buyer holds. |
| `read-data/provider-operation-map.json` | One row per Stripe operation (method, whole address, subject). Adding an operation is one row. |
| `read-data/stripe-read-shapes.json` | One row per list read of Stripe (see `do-work/read-stripe-objects.mjs`). |
| `read-data/webhook-event-map.json`, `stripe-payee-event-map.json` | Stripe event type to payment event, as data. |
| `do-work/provider-request-mapper.mjs`, `encode-provider-form.mjs`, `build-provider-request.mjs` | Operation row to a ready-to-send request, form-encoded; `call` builds and sends one. |
| `do-work/stripe-send.mjs` | The only place the key is read and used. |
| `do-work/stripe-phases-for-a-payment-schedule.ts` | A payment schedule as the part taken at the door and the Stripe subscription phases after it. |
| `do-work/session-intent.ts` | A quote to a provider-neutral session intent and back to checkout material. The intent carries the caller's `metadata` and, for a code of duration `once`, `first_invoice_discount` (the amount `startAStripeCheckout` makes a coupon for). |
| `do-work/hosted-session.ts` | Create and read a hosted checkout, find a completed one, list every completed one since a time (payment links included) and every subscription that ended since a time, create a schedule, cancel, tag, and count installments. The session's `metadata` (text keys and values within Stripe's limits; the keys the grant path sets, `GRANT_METADATA_KEYS`, are refused) and `discounts` (coupon ids) are checked and written here. |
| `do-work/ensure-offer-payment-links.mjs` | Lasting payment links, percent- and amount-off codes scoped to the offers a code row names, and the billing page: made fresh with plan changes among the business's own subscription prices (at most 10, Stripe's limit as its API reference states it). An existing billing page is kept as it is (`portal: keep`, the default); `portal: reconcile` reads its features and reports the difference, and writes only with `apply: true`. A link carries the option's trial, its day-0 `charges` part as a one-time item, a quantity the buyer picks, and the offer's checkout note; after paying it opens the row's `post_purchase_route_path` under `after_payment_url` (its root when the row names none). |
| `do-work/quantity-for-checkout.mjs`, `read-data/quantity-limits.json` | The count a buyer may pick for an option with `quantity` (or `seats`), cut to what one Stripe checkout can carry. |
| `do-work/connect-payees.mjs` | Payee account, onboarding link, destination checkout, share transfer subjects, and payee readiness. |
| `do-work/parse-webhook-signature.mjs`, `admit-a-webhook.mjs`, `map-webhook-event.mjs` | The webhook check. `paymentEventIdOf` names every row of one payment by its PaymentIntent (`payment:<pi id>`; a paid invoice's and a subscription checkout's are read with `invoicePaymentIntent`), a completed checkout that took no payment by its checkout session (`checkout:<cs id>`), and every other kind by its Stripe event id. `PAYMENT_EVENT_TYPES` lists a payment's own event types. The webhook, the event list and the checkout list all use it, so one payment is one row id on every path. |
| `do-work/payment-keys.ts` | One payment is one kept row. `paymentEventsShape` is the `payment_events` table with two keys over the kinds a payment's own events are kept as (`paymentKindsOf`, from the event map): one row per PaymentIntent (`provider_object_ref`) and one per checkout (`completion_ref`), so the database refuses a second row for a payment kept by another path or under an older id, and a keep with `ON CONFLICT DO NOTHING` keeps it 0 times. `planPaymentKeyMoves` (CLI: `node do-work/payment-keys.ts < request.json`) moves rows kept under their checkout ids before rows were named by their PaymentIntent: from the kept rows and the events `tool:keep-completed-stripe-checkouts-as-payment-events` reads from Stripe (a read only), matched by checkout, it answers the moves, the rows left and why, `rekey_sql` (one statement: the rows and every named reference move, or nothing does; it refuses when a new id is already kept, a moved reference collides, or any text or json column not named as `history` still holds an old id) and `counts_sql` (run after it in the same transaction; a dry run rolls both back). |
| `do-work/list-stripe-events.mjs` | `listStripeEventsAsPaymentEvents` (the export; no tool row yet): Stripe events of the kinds the event map names, created since a time, paged with `starting_after` (Stripe keeps 30 days), each mapped and named as the webhook check names it. Returns `{ payment_events, next_cursor, complete, cursor_too_old, left_out }`; keeps nothing, and sends only through the send seam. |
| `do-work/rehearse-a-payment-schedule.mjs` | Test-mode rehearsal of a schedule. |
| `do-work/rehearse-a-billing-page.mjs` | `tool:rehearse-a-billing-page-in-stripe-test-mode`: in Stripe test mode, makes a customer, product, price and subscription, finds or makes the account's billing portal configuration, and opens the subscription's billing page with `billing-portal.mjs`; returns the page's address and never opens it. |
| `do-work/billing-portal.mjs` | The billing page of one purchase (`tool:open-the-billing-page-for-one-purchase-and-show-the-card`): a portal session for the customer that bills the subscription, opened on one step when `flow` names it (`payment_method_update`, `subscription_update`, `subscription_cancel`), and the card that pays it. `readBillingPage` (`tool:show-one-purchase-plan-card-and-receipts`) reads the plan, renewal or end date, status, card and up to 12 receipts. Both take `subject_email`, the signed-in buyer's verified email: the purchase's customer must have it, or the call is refused and nothing of the purchase is returned or opened. Neither changes a subscription; the buyer confirms on Stripe's page. |
| `packages/billing/show/BillingScreen.tsx`, `web/src/workspace/billing-screen-mount.tsx`, `web/src/workspace/billing-targets.ts`, `billing-targets.json` | The billing screen (`tool:show-one-purchase-plan-card-and-receipts`'s screen): plan, renewal or end date, card, receipts, and three one-click buttons (change card, change plan, cancel) that each open the matching Stripe billing-page step. The screen takes `readPage` and `openFlow`; the mount answers them through the two tools `billing-targets.json` names. |
| `do-work/read-stripe-objects.mjs`, `read-data/stripe-read-shapes.json` | A read of Stripe that answers a list (`tool:read-stripe-promotion-codes` for the real account, `tool:read-stripe-promotion-codes-in-test-mode` for the test account, which refuses any key that is not a test key). Each read is one row of the shapes file: the GET operation, which inputs become which query words and what each may be, what to expand, and the shape of each thing returned (paths into Stripe's answer; a field Stripe did not send answers null). The reader names no provider address, id shape or field, wraps the sender so only GET leaves, and never answers the key. Promotion codes answer id, code, active, times redeemed, most redemptions, expiry (Stripe's seconds), restrictions (first order only, minimum amount, its currency) and the coupon given (amount or percent off, currency, duration, months, valid, its own counts). Adding a read is one row. |
| `do-work/stripe-response-redactor.mjs` | Strips key-shaped words from anything Stripe says. |
| `do-work/take-payments.mjs` | The function each row runs. `startAStripeCheckout` takes the caller's `metadata` and makes the once-discount coupon; `giveACustomerCredit` gives a customer credit through the send seam, keyed by the caller's idempotency key. |
| `read-data/resource-usage.mjs` | Exact rational supplier-cost allocation, effective-dated resource/plan/client markup, purchased snapshots, subcent cash clearing and nested leaf-only pricing. Public to consumers through `part.json`. |
| `do-work/resource-usage.mjs` | Pricing from the rules handed in, observation checking, supplier settlement and corrections: each takes its rows in the request and answers its result, keeping nothing. `manageUsagePricing`, `readResourceUsageSettlement`, `readResourceUsageReport` and `cancelPreparedResourceUsageReport` take the rows the caller read from its own store and answer `keep`, the rows the caller writes (cancel and pricing), so none opens a records door. Re-exported by `take-payments.mjs`, through the same runner. |
| `do-work/live-usage.mjs` | `tool:observe-live-usage`: turns the account's own usage day rows it is given (`usage_days`: the counts of stored bytes, tool work milliseconds and source bytes the person's files program, tools/live-namespace, keeps and answers) and answers each closed day as one `resource-usage-observation` per billed resource, for the existing settlement (it reads only the day rows it is given and keeps nothing). Its readers are the older owner's `usageReadings` (REF-LIVE-USAGE-READINGS). |
| `read-data/usage-meters.json` | The billed meters and the default +30% rule, ported one to one from old trillion `src/usage-meters.json`, and which engine row field each reading reads. |
| `packages/checkout/show/CheckoutFlow.tsx`, `CheckoutPaymentSlot.tsx`, `mount-checkout.tsx` | The buyer checkout screen, moved byte for byte from the old checkout package (`moved-from.json`) and edited only where it called the retired Bitfield runtime (listed under "The checkout screen's swapped calls"): plan choice, pay-what-you-want with suggested and custom amounts and their limits, compare-at price, benefits and detail groups, billing and legal consent, customer fields, offers filtered by what the buyer holds, a checkout attempt that survives a reload, the route to open after paying. It is the screen of `tool:price-a-sale` (`screen.module.entry` `web/src/workspace/checkout-screen-mount.tsx`). |
| `web/src/workspace/checkout-screen-mount.tsx` | The screen's module entry: answers the targets the screen asks, then mounts it. Its input may name `seller_connection` and `subject` (the buyer, as the person's access rules name one). |
| `web/src/workspace/checkout-targets.ts`, `checkout-targets.json` | The web shell's answers to the three targets, read from the tools the DATA names, and the hooks that read the person's offer, code-adjustment, eligibility and amount-choice rows through the screen's records door and pass them in the pricing tools' requests. |
| `web/src/workspace/checkout-answers.ts` | What each target answers, taking the tool run as a parameter. |
| `web/src/workspace/seller-account.ts`, `seller-account.json`, `seller-account-names.ts` | Which of the seller's accounts the screen's connection means, asked before a paid step or a billing read runs: the account's owner reads the names its vault holds (`secrets:names`, names only) and asks `tool:find-the-account-of-a-service` (tools/connections); one held is that one, several stop the run naming them, none or a buyer (who cannot read the names) keeps the connection as named. The engine chose this inside every run until the engine boundary audit moved it to the connections owner (Nov 21 2026). |
| `read-data/suggestion-lists.mjs` | The rows of each suggestion list an offer names: `suggestionListsFrom` takes the offer-amount-choice rows as given, for the tools and the checkout screen alike. It reads no store. |
| `tool-rows.json` | The Workshop rows. `tool:keep-completed-stripe-checkouts-as-payment-events` (id kept; it keeps nothing) answers each completed checkout as one `payment-event` (its id comes from the checkout), so a purchase no webhook reported can still be kept by the caller's AI; paid-access folds those records into held access by the buyer's email. |
| `test/` | The ported cases (curve, dimensions, price discovery, voluntary amounts, verify, phases, webhook, request builder, Connect, links) and new ones for the quote, hosted session, listing completed checkouts and ended subscriptions (answers shaped like Stripe test mode), rows and money rules. `expect.mjs` is a vitest-shaped helper that compares whole-cent bigint amounts. `checkout-codes-metadata-and-credits.test.mjs` covers the floor and duration of a checkout code, the caller's metadata, and customer credits, against a stand-in Stripe. |

## Resource usage, customer markup and pooled supplier cost

`tool:manage-usage-pricing` pages the rule rows the caller hands in (`list`, with `rows`; `versions: true` in the caller's rows gives every immutable version, the rules `price-resource-usage` takes) and reads one (`read`), and saves, retires or deletes a rule (`current` is the head row the caller read, or null). It keeps nothing: it answers `keep`, the new head, the immutable `usage-pricing-rule-version` and the `resource-usage-receipt` for the `request_key`, and the caller writes them in its own store while the head is still at the `expected_version` it read. A repeat of a `request_key` takes the receipt the caller kept (`prior_receipt`) and answers the first result.
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

`tool:price-resource-usage` takes the pricing rules in the request (`rules`, or `pinned_terms` alone for a purchased snapshot), reads no rows and returns either resolved terms or a priced `tree`.
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

`tool:keep-resource-usage-observation` checks one attributed physical attempt and
answers it exact as a `resource-usage-observation` for the caller to keep.
`state:"unknown"` carries no numeric amount; a correction is another `event_id` with
`supersedes` (give the earlier observation as `supersedes_observation`), never a
rewrite of measured history. These observations are seller-adopted evidence, not a claim that this
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
this tool; it is not cloned per supplier scope. Optional `observations` (as the
observation tools answered them) replace payer quantities with their exact, measured,
unsuperseded source excess totals.
Unknown or cross-pool observations refuse final settlement.

The verified invoice is split across positive excess users, including platform
work as its own payer. Customers within allowance pay zero; capped/unallocatable
cost stays an explicit company residual rather than being spread onto them.
`company_funding` must explicitly cover platform expense and residual before
state becomes `reconciled`; otherwise state is `funding_required`. This creates
no unrequested free grant, no permission to bill a residual and no silent subsidy.
The tool cannot decide whether supplied provider evidence is authentic; the
caller must adopt it through the provider/invoice owner before final collection.

`tool:settle-shared-resource-cost` answers `{record_id,settlement,allocations}`: the
settlement version record and every allocation (at most 10,000 payers). It keeps
nothing; the caller keeps the answer. `tool:correct-resource-usage-settlement`
takes that answer back as `previous` with the corrected invoice/payers and a
`reason`, and answers the next version, preserving purchased terms/ceilings; the
caller keeps old versions beside the new one. `tool:read-resource-usage-settlement`
pages the settlement row and its allocation rows the caller hands in, by an opaque version-scoped cursor. Its negative deltas name refund/credit obligations; positive deltas name
the original-authority requirement. **It never sends money to Stripe**, marks a
refund complete or claims a customer invoice was collected. The existing payment
sender owns those effects, and the caller must not collect a `funding_required`
settlement or any amount beyond the original reservation. A payer field never selects another account. Customer-facing views project only that customer's authorized lines.

## Open

- A buyer who comes back from checkout before their account has a passkey: the older owner answered a signed-out visit to the root, carrying the buyer cookie of a payment its signed event confirmed, with the account page's paid step (`/account?paid`; older owner src/worker.mjs:4225, `confirmedBuyer` :365-371, `heldBuyer` :335). The engine's signed-out root now goes to its sign-in page; the buyer cookie, the confirmed-payment check and that redirect have no owner yet. `post_purchase_route_path` already opens the row's page after paying.

## The checkout screen's swapped calls

The screen was moved byte for byte; these are the only edits, and each replaces a call of the retired runtime or of a package that is not here.

| Where in `CheckoutFlow.tsx` | Was | Now |
|---|---|---|
| `sendCheckoutTarget` (one call) | `sendRequestToBitfieldTarget` from `@bitfield/runtime-kit` | the same function from `#workspace-records`, whose targets `checkout-targets.ts` answers |
| `checkout.prepare-checkout` | the old gate's `prepareCheckout` | `tool:price-a-sale`, its `material` |
| `checkout.start-checkout`, paid | the old gate's `startCheckout` with a signed quote | `tool:start-a-stripe-checkout`, naming `seller_connection`, a return that carries `session_id`, and the buyer's consent |
| `checkout.start-checkout`, free | the old gate's free completion event | no provider: a choice that asks for nothing today and nothing later completes at once; what a free offer gives is held by everyone (`tools/paid-access`) |
| `checkout.complete-hosted-session` | the old gate's `completeHostedCheckout` | `tool:look-up-a-stripe-checkout`: paid only when Stripe says `paid`; access follows the signature-checked payment event, never the return |
| `useBitfieldData('commercial-offers')` | the runtime's projection | `useCheckoutOffers`: the rows of `record:commercial-offer` and the person's `record:offer-amount-choice` rows, through the records door |
| `useBitfieldData('offer-eligibility')` | the runtime's projection | `useEligibilityRows`: the rows of `record:offer-eligibility-rule` |
| `useBitfieldData('offer-scoping')` | the runtime's projection | none: no row of the Workshop keeps a visitor's selection surfaces for a screen to read, so the list is returned unchanged, as the old screen did with no projection. Per-visitor choice is `tools/run-experiments`' `tool:choose-what-a-visitor-sees`; a screen that asks it is not wired yet. |
| `readAccountPortalBrowserSession` and `readAccountGrantedAccessRefs` | the old account-session and product-access reads | `readHeldAccessRefs`: `tool:see-who-holds-paid-access` for the buyer the screen's input names, with the person's payment, offer, grant and rule rows in the request |
| `scopeRecordsForObserver`, `formatMoneyCents`, `LoadingOverlay` | `@/packages/...` imports | the files that moved to `tools/run-experiments/read-data/scope-records.ts`, `tools/ui/packages/ui/show/format-money.ts` (moved with this screen) and `tools/ui` |

Not wired and said so: nothing observed a live checkout through these answers; Stripe test mode was not run.

## The old checkout engine, call by call

`do-work/gate-checkout.ts`, the target files and `payment-adapter.ts` asked the retired runtime for these. Each has an owner here; the engine itself is not carried.

| Old call | Owner now |
|---|---|
| `payment-adapter.prepare-provider-session`, `.start-provider-session`, `.read-provider-session` | `tool:price-a-sale`, `tool:start-a-stripe-checkout`, `tool:look-up-a-stripe-checkout` |
| `stripe-payment-provider.read-hosted-session`, `.update-subscription-metadata` | `tool:look-up-a-stripe-checkout`, `tool:tag-a-stripe-subscription` |
| `engine.operation.label-addressed` read of offers, code adjustments and eligibility policies | `record:commercial-offer`, `record:checkout-code-adjustment` and `record:offer-eligibility-rule` rows through the records door |
| the grant and revoke events (`capability_access_granted`, `..._revoked`) and the revocation audit write | access is worked out from payment events each time (`tools/paid-access`); a gift or pass is an `access-grant` record by `tool:grant-paid-access-to-people`, and its `revoke` ends one |
| `account-identity.derive`, the signed-event author and authority (`sign-event`, `admit-event`, `list-effects`), the signed quote reservation | no owner: a payment is believed from Stripe's own record (`tool:check-a-stripe-event`, `tool:check-what-a-buyer-paid`), the buyer is the account the door verified, and no quote is reserved, so a paid amount is checked against the offer instead of a signed quote |
| `slot::workflow` email contact-point capture at signup | no owner here: capturing a buyer's email into the contact points is the contacts and workflow owners' job, and nothing calls it from checkout now |

## Not carried, with the reason

- `stripe-payment-elements`: the secure-field mount, the section list for a screen and the browser Stripe.js confirmation are drawing and browser glue; they belong with the screens, and the only logic in them (redacting key-shaped words) is in `stripe-response-redactor.mjs`.
- The old checkout's iOS JSCore mounts, the descriptor readers (`checkout-descriptors`, `checkout-fields`, `checkout-rules`, `event-templates`, `read-funnel`, `validate-funnel-coverage`), the carried targets (`prepare-checkout-target` and the other target files), `payment-adapter.ts` and `gate-checkout.ts`. The engine's calls each have a Workshop owner, listed under "The old checkout engine, call by call" below; none is carried because none could run here without the retired Bitfield runtime.
- `payment-adapter` route descriptors (`operation-routes.ts`, the spend-rail descriptors): old-engine routing; spend rails are `tools/guard-ai-spending`.

### Report an exact settlement to the payment provider

`reportResourceUsage({agreement,settlement,payer_id,cash?,applied?,prior_report?}, context)` takes a reconciled settlement answer (`{settlement,allocations}`), verifies its pinned purchased resource terms against the agreement, and posts its already marked-up total through the existing Stripe mapper/sender. It does **not** multiply by a margin again. The fixed whole-minor-unit invoice item is bound to the exact seller account, customer and subscription, with `discountable:false`. A negative item is a future-invoice credit, not a completed cash refund. Ended subscriptions require final-invoice recovery in the existing payment owner.

The purchased agreement is handed in as `agreement`, the caller's read of the existing agreement owner (a projection of type `usage-billing-agreement`). It must be confirmed and contain `agreement_id`, `payer_id`, `provider_account_id`, `provider_customer_id`, `provider_subscription_id`, `currency`, `currency_exponent`, `usage_terms`, `source_ref`, `authority_ref`, `bill_usage:true`, `collection:"settled_invoice_item"`, and `collection_authorized_total`. The projection is not an editable source of spending authority. Product integration supplies `assertCollectionAuthority({agreement,report})` against its existing current authorization owner before dispatch. An account-owned tool invocation uses that account's projection and mounted Stripe credential; it cannot mount another seller's key. Trial charges require the explicitly purchased `usage_billed_during_trial:true`.

The report keeps nothing. Exact fractional carry and a cumulative applied-source cursor come back in the answer as `cash` and `applied` (null until the report commits); give them to the next report for the same agreement (`cash`) and the same settlement (`applied`). Subcent accrual touches no provider. The invoice item is sent under a key fixed by agreement, payer, currency, settlement and version, so Stripe refuses to repeat it. Corrections compare cumulative totals, so skipping an earlier version does not double bill. A timeout or malformed answer returns `outcome_unknown` with the frozen `report`: retry the same source version within 23 hours with that report as `prior_report`; outside that window, or after a backwards clock, use `reconcileResourceUsageReport({report,provider_invoice_item_id,cash,applied})`, which reads and checks the actual provider receipt without another POST. The cash and applied handed in must be the ones the frozen report was prepared from. Nothing here fences two simultaneous reports for one agreement: the caller serializes them. `readResourceUsageReport` and `cancelPreparedResourceUsageReport` still act on a report row a store holds.

`provider_accepted` proves the exact invoice item was accepted. Every public result retains `payment_state:"not_proved_collected"`; collection must be observed through the existing provider invoice/payment lifecycle. Carry is only reported as committed after the provider acceptance checkpoint, never after an ambiguous attempt. This API does not prove native pre-read monetary reservations are mounted and does not replace their budget owner.

## Files moved from bitfield-packages (packages/payment-adapter)

Each file below is the package's own, byte for byte; `from-bitfield-packages/moved-from.json` names each source path and commit, the identity of its source bytes and of its bytes here, and the `calls` that made a real name or id made up. After the first commit only import paths changed. A file named `.held` is the same bytes with its test name taken off so the repository test does not run it; the reason is under `held` in the receipt. Most files import `@/packages/ui` and the retired package runtime (`@bitfield/runtime-kit`); the shared ui parts live in apps `tools/ui`, so the screens and targets here are prepared, not wired to a tool row.

| File | What it is |
|---|---|
| `do-work/materialize-operation-session-intent.ts` | exposes the package target |
| `read-data/operation-routes.ts` | decodes generic route records and maps them to |
| `test/payment-adapter-backend.test.ts.held` | proves payment-labeled and PDF routes (held: imports react or shared ui parts (tools/ui) that live in apps tools/ui, not in the Workshop) |

### Not carried

- 10 files: generated build output of the retired package runtime (entry scope, built entry bytes); not carried
- 4 files: package README, package.json or ignore file; this folder has its own README
- 1 file: maps package entries to the retired package runtime's entry scope; not carried
- 1 file: package entry wiring for the retired package runtime; not carried
- 1 file: the package boundary file: record contracts, actions and surfaces for the retired package runtime (slot workflows, owner targets); not carried
- 1 file: byte-equal to tools/take-payments/read-data/when-money-is-taken.ts
- 1 file: the Workshop test is later (test/when-money-is-taken.test.ts)
- 1 file: its logic is in tools/take-payments/do-work/session-intent.ts and hosted-session.ts (the dispatch to a slot target was replaced by the session intent); the checkout lane owns that adaptation
- 1 file: tests the package's dispatch through a slot target; the checkout lane owns the Workshop's replacement tests

The receipt's `not_carried` names each path.
