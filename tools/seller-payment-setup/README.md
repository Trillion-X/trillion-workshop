# tools/seller-payment-setup

One row, `tool:build-a-sellers-payment-setup-request`: it builds, without sending, the payment provider request that starts a seller's payment setup and gets their hosted onboarding link.

It holds no code of its own. It runs `buildStripeHttpRequest` from `tools/take-payments/do-work/build-provider-request.mjs` over the operation rows in `tools/take-payments/read-data/provider-operation-map.json`: the one copy of the request builder, form encoder, webhook check and the operation and event maps. Adding an operation or a webhook event is one row in those files.

## Files

| File | Purpose |
|------|---------|
| `part.json` | Which files other code may import (none: the code lives in take-payments) |
| `tool-rows.json` | The row, mounting the take-payments package, with a sample that builds the onboarding link request for a made-up connected account |
| `kits/` | The kit that shows the row's real answer |
| `moved-from.json` | Where the files first came from |
| `README.md` | This file |

The row runs in a small container with no internet and answers the request it built. It sends nothing; sending with the seller's key is take-payments' job.
