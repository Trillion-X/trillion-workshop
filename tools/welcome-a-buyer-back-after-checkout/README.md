# Welcome a buyer back after checkout

The source-first checkout-return library. `returnAddress` validates credential-free HTTP(S) addresses;
`makeCheckoutReturn({ welcome, afterPurchase })` retains origin selection, the original TTL-aware KV host interface,
and welcome section DATA. `welcome` is read from the person's installed content rows; `afterPurchase` is the payment
owner's purchased-offer wording function. No payment implementation or content copy is installed here.

`checkoutReturnInHand({ welcome, afterPurchase, now? })` additionally offers `keep({ from, return }, stored)` and
`kept(stored)` over the selected account's `checkout-return:yours` record of kind `checkout-return`. The caller reads that
record from the person's own store and hands it in as `stored.records` (value null when absent); leaving it out is
refused, never read as absent. `keep` answers `{ came_from, keep }`: the record with the value it expected, so a store
refuses the write when the record moved. The record contains `came_from` and `expires_at`; expiry is enforced on reads.
This does not promise physical TTL erasure of the store's retained record history.

The caller supplies the payment/content owners. This library reaches no store, and does not install a purchase route
or a page renderer. The welcome output remains section DATA for the shared shell.

Run `node --test tools/welcome-a-buyer-back-after-checkout/test/checkout-return.test.mjs`.

## The welcome page as a screen

`tool:read-the-welcome-page` (`reads/read-the-welcome-page.ts`) answers the page's title and addresses and, per checkout state, its heading, body and actions from the pursuit's `welcome_page` and `welcome_states` rows. `show/Welcome.tsx` is its screen: plain JSON props (`states`, `status_path`), it draws the state `none` on the server and, once mounted, asks `<status_path>?checkout=<id>` for the buyer's state. Test: `node --test tools/welcome-a-buyer-back-after-checkout/test/welcome-page.test.ts`.
