# Welcome a buyer back after checkout

The source-first checkout-return library. `returnAddress` validates credential-free HTTP(S) addresses;
`makeCheckoutReturn({ welcome, afterPurchase })` retains origin selection, the original TTL-aware KV host interface,
and welcome section DATA. `welcome` is read from the person's installed content rows; `afterPurchase` is the payment
owner's purchased-offer wording function. No payment implementation or content copy is installed here.

`checkoutReturnOverDoor({ door, welcome, afterPurchase, now? })` additionally offers `keep({ from, return })` and
`kept()` over the selected account's `checkout-return:yours` record of kind `checkout-return`. Writes use the existing
records door's exact-value conditions and BLAKE3 request identities. The record contains `came_from` and `expires_at`;
expiry is enforced on reads. This does not promise physical TTL erasure of the engine's retained record history.

The caller must supply an already-authorized account door and the payment/content owners. This library does not
install a purchase route or a page renderer. The welcome output remains section DATA for the shared shell.

Run `node --test tools/welcome-a-buyer-back-after-checkout/test/checkout-return.test.mjs`.
