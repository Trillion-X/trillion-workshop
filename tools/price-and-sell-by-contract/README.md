# tools/price-and-sell-by-contract/

`read-data/billing-pricing-controls.mjs` restores the operator-only Billing pricing read, through the host's admitted
`tool:manage-usage-pricing` run. Its extracted presentation function, `read-data/usage-pricing-controls.mjs`, preserves
versioned edits, scopes and the current pricing owner's arithmetic. The host binds operator identity; request data
does not select a seller. This library does not install a Billing screen or change any real account's prices.

Files more than one moved group imports, kept once.

Earlier files were moved byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json`
records that original move. The new Billing adapter and extracted presentation function above have separate source
baselines and port contracts; they do not restore the retired Worker's billing imports.

## The buy address (`/buy/<offer id>`)

`src/buy-route.mjs` answers a Buy: it reads the offer's charged price from the offer rows it is given, creates one Stripe
Checkout session for it (a subscription when the price repeats, with its free days first, else a payment), and redirects
to that session. Checkout returns to the settings' `success_path` (`/welcome`). `?jv=` becomes the session's
`client_reference_id`; `utm_*` and `ref` become metadata on the session (and on the subscription). An id with no row, or
with no charged price, gets the plain 404 page and no session is made.

`on-a-computer/serve-buy.mjs` is the program a computer's unit runs (`on-a-computer/serve-buy.service`, its settings in
`BUY_SETTINGS`, the Stripe secret key from the unit's sealed credential as `STRIPE_SECRET_KEY`). The front door sends
`/buy/*` to its `buy` pool through `on-a-computer/caddy-route-buy.caddy`. The Stripe key is never read from a request,
logged or put in a URL.

Checks: `node --test tools/price-and-sell-by-contract/test/buy-route.test.mjs`.
