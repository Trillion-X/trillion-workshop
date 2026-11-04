# tools/build-and-send-a-sales-contract

The sales contract builder's knowledge of the person's own business and what a sent deal sets up afterwards. The builder screen itself (choosing an offer, a price and a customer, and sending the deal) is the hosted app's; this folder holds its DATA and the part that runs anywhere.

## Files

| File | Purpose |
|------|---------|
| `sales-contract-builder.json` | DATA: the sources the builder reads (offers, prices, customers, saved deals, rules, schedules, workflows), the paid-deal trigger and the follow-ups it offers, and the words it shows |
| `do-work/sales-contract-builder.mjs` | Moved from Trillion `src/sales-contract-builder.mjs` (`moved-from.json`, `ports/sales-contract-builder.json`): `readDealResources`, `valueAt`, `fillWords`, `dealFollowUps`. Its `readSalesContractBuilder`, which read the hosted builder's content through the Worker, stays with the hosted service |
| `do-work/plan-deal-follow-ups.mjs` | `planDealFollowUps({ contract, facts, follow_ups })`: a sent deal's follow-ups as rules and schedules (what `tool-rows.json` runs) |
| `moved-from.json` | Where `do-work/sales-contract-builder.mjs` came from and the identity of its source bytes |
| `ports/` | The port contracts of the two do-work files |
| `tool-rows.json` | The row `tool:plan-what-a-sent-deal-sets-up` |
