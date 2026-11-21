# tools/build-and-send-a-sales-contract

The sales contract builder's knowledge of the person's own business and what a sent deal sets up afterwards. The builder screen itself (choosing an offer, a price and a customer, and sending the deal) is the hosted app's; this folder holds its DATA and the part that runs anywhere.

## Files

| File | Purpose |
|------|---------|
| `sales-contract-builder.json` | DATA: the sources the builder reads (offers, prices, customers, saved deals, rules, schedules, workflows), the paid-deal trigger and the follow-ups it offers, and the words it shows |
| `do-work/sales-contract-builder.mjs` | Moved from Trillion `src/sales-contract-builder.mjs` (`moved-from.json`, `ports/sales-contract-builder.json`): `readDealResources`, `valueAt`, `fillWords`, `dealFollowUps`. Its `readSalesContractBuilder`, which read the hosted builder's content through the Worker, stays with the hosted service |
| `do-work/contract-builder-quote.mjs` | Pure: a deal's price lines and total (`quoteLines`, `totalOf`), and the message the customer gets (`composeMessage`). Percent lines count on the amount lines; an unpriced amount makes the total null. |
| `do-work/plan-deal-follow-ups.mjs` | `planDealFollowUps({ contract, facts, follow_ups })`: a sent deal's follow-ups as rules and schedules (what `tool-rows.json` runs) |
| `moved-from.json` | Where `do-work/sales-contract-builder.mjs` came from and the identity of its source bytes |
| `ports/` | The port contracts of the two do-work files |
| `tool-rows.json` | The row `tool:plan-what-a-sent-deal-sets-up` |
| `web/src/workspace/sales-contract-builder-mount.tsx` | The Sales contracts screen's module entry: `mount` is `mountPrivateDealBuilder`. |
| `web/src/workspace/private-deal-builder.tsx` | The Sales contracts screen (`mountPrivateDealBuilder`): pursuit, then customer, product, price lines, message and a preview of exactly what the customer gets. The draft lives in the screen; nothing is saved or sent there. |
| `web/src/workspace/contract-builder-data.ts` | What the builder reads: the pursuits (the vault's pursuit connections), and from the chosen pursuit's database its customers (`leads`), offers with price parts (`offers`, `offer_price_parts`) and sender (`email_sender`). Each read is one `tool:run-sql-in-my-database` call with a statement time limit. |
| `web/src/workspace/contract-builder-words.json` | Every word the builder shows, and the words the message uses where a value is not set yet. |
| `web/src/workspace/contract-templates.json` | The messages a private deal starts from; the person edits the words on the spot. |
