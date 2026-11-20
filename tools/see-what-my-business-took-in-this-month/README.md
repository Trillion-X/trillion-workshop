# tools/see-what-my-business-took-in-this-month/

Business: what this account's business took in this month on the payment services it connected (money in, the service's fees, money returned, net and how many payments, per currency), read with the person's own connection. The screen is the catalogue row `tool:business` in `tools/show-my-screens-from-a-catalogue-of-reads-and-layouts`, which the engine's generic screen host answers at `GET /work/api/screens/business`; its one read is this folder's `tool:read-business`.

Ported from old trillion `src/business-screen.mjs` (Trillion-X/trillion before 4ffa1dc4a2), its catalogue rows `tool:business` and `tool:read-business` (records/marketplace-screens.json) and its test `test/business-screen.test.mjs` with the golden `test/fixtures/business-descriptions.json`. `ports/business-screen.json` is the port contract.

## Tools

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:read-business` | Business's facts for the page's account: each payment service in `tools/money-reads/src/money-reads.json`, its money this month read by running that service's money read with the person's own connection (a nested run), summed per currency and written as the layout places it | in a small container, no internet; it reaches the person's records only to start the connections list and the money read |
| `tool:stripe-events-read_money_since` | Stripe's balance transactions at or after a moment, at most 100, with the key of the Stripe account its `connection` input names, by the handle the person's connections list gives (`service_connection:stripe` or `service_connection:stripe:<account>`; a person may hold more than one) (old trillion's row of the same id, made from `package::service-connections::how-to-ask-something-else-to-do-things::stripe-events`) | the engine's `http` kind; the key goes only to `api.stripe.com` |

## Which payment services this account connected

Read as old trillion read it (`connectionsNow`, the held-values operation `list`, the row `tool:list-connections`): `tool:read-business` runs `tool:list-connections` (tools/connections) as a nested run, handing on the two lists it is given: `connection_records` (the person's `connection` records) and `held_connections` (the vault's held connection names, never a value), so a service the person did not connect is drawn "Stripe is not connected / Open Connections", live, and its money is not read. Each money read names the account it reads (`connection: {connection_id}`, from that listing); a person who holds more than one account of a service is refused, with the accounts named, since Business reads one. When either list is not handed in, or the listing cannot be read just now, each service's connection is unknown (a missing list is never taken as no connections): no account is known to name, so each service's money is read with the service named and no account (`service_connection:<vendor>`) and the engine finds the account the vault holds of it (one held: that one; several: refused, naming them); a read that fails is drawn as old Business drew a failed read ("Your Stripe money could not be read just now", no number). The connections a computer carries (old `src/carried-connections.mjs`) have no owner today and are not added; no payment service is carried.

## What it cannot read today

- **The operator's part.** Whether this account is the operator (`OPERATOR_ACCOUNT_ID`), Trillion's payment config (`src/payment.mjs` readPaymentConfig), its call pool's use (`pool.callStats`) and its price tests (`priceExperimentsState`, the service's record book) were the hosted service's own stores. None is read, so Business is drawn as every other account saw it; `operatorFacts` and its layout are kept and tested from given facts.

## Files

| File | Purpose |
|------|---------|
| `do-work/business-screen.mjs` | The facts (`readBusiness`, `businessFacts`) and the row's entry (`readBusinessForScreen`). |
| `tool-rows.json` | The two rows. |
| `test/business-screen.test.mjs` | The old test, ported; the golden draws the old layout through the formula engine as the screen host does. |
| `test/draw-catalogue-screen.mjs` | Old `src/screen-layout.mjs` drawLayout and the old test helper `drawCatalogueScreen`. |
| `test/fixtures/business-descriptions.json` | The old golden, unchanged. |
| `ports/business-screen.json` | The port contract. |
