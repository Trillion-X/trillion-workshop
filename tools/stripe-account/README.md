# stripe-account

The Workshop row for Stripe's account read (GET https://api.stripe.com/v1/account): one http row, `tool:read-my-stripe-account`. It sends the Stripe secret key the caller names (`key_name`, a vault entry name given as input) as a bearer header on api.stripe.com only. Reads only.

| File | Purpose |
|---|---|
| `tool-rows.json` | The http row the engine runs (no code of its own). |
| `kits/read-my-stripe-account.json` | The kit: how to say it and what it answers. |
| `test/stripe-account-rows.test.mjs` | Checks that the row holds only that key, sent to api.stripe.com as a bearer header, and only reads. |
