# tools/open-the-billing-page-for-one-purchase-and-show-the-card/

Open the billing page for one purchase and show the card that purchase is paid with.

The Workshop row lives in `tools/take-payments/tool-rows.json`, beside the other Stripe rows: take-payments owns this job. It runs `openABillingPage` in `tools/take-payments/do-work/take-payments.mjs`, which calls `do-work/billing-portal.mjs`, the one owner of the billing session: it reads the purchase with its paying card expanded (`operation:read-subscription-card`), finds the account's billing portal configuration (`operation:find-portal-configurations`, or the one the caller names), and opens a Stripe customer portal session (`operation:create-portal-session`) for the customer that bills the purchase. The answer is the redirect address and the card's brand, last four and expiry only. Nothing changes a subscription, and an account with no portal configuration is refused rather than given a made-up one.

Tests: `tools/take-payments/test/billing-portal.test.mjs`.

`src/` holds the Trillion app's copy of the earlier billing code, moved here byte for byte from Trillion-X/trillion; `moved-from.json` names each file's source path and commit. Trillion-X/trillion imports these files from this package, so they stay until that app copy is retired onto `openABillingPage`.
