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

A purchase of a plan on the person's own account is the sign-in tool's (`tools/better-auth-official/sell.mjs`, Better Auth's
Stripe plugin), because the account is there: this tool keeps no buy address.
