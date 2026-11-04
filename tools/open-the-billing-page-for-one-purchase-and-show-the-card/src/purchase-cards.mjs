// src/purchase-cards.mjs
//
// PURPOSE
//   The card each purchase an account pays for uses (brand, last four, expiry only), as Billing shows it. One owner for
//   both places an account's billing facts are kept: the account's policy owner when it keeps the account's rights
//   (src/account-control.mjs accountPurchaseCards) and the account's store otherwise (src/person-store.mjs purchaseCards).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The answer is what is kept, at once: Billing never waits on the payment service.
//   2. A purchase not read in the last day (or whose read failed over 15 minutes ago) is read after the answer, all of
//      them together and one batch at a time per holder, so a failing read is never repeated on every look.
//   3. Only the account's own purchases are read; a failed read is kept as failed and never answered as a card.

const DAY_MS = 86_400_000;
const FAILED_MS = 900_000;

/**
 * The kept cards of `subscriptions`: { [subscription]: { card, read_at } }. `facts` reads and writes the kept map
 * (purchase_cards), `ours` holds the account's own purchase ids, `readCard(id)` asks the payment service, `waitUntil`
 * keeps the background read alive and `holder` keeps the one batch in flight (its `cardsReading`).
 */
export function keptPurchaseCards({ facts, ours, readCard, waitUntil, holder }, subscriptions, now = Date.now()) {
  const kept = facts.read() ?? {};
  const stale = id => { const row = kept[id]; return !row || now - Date.parse(row.read_at) > (row.failed ? FAILED_MS : DAY_MS); };
  const due = subscriptions.filter(id => ours.has(id) && stale(id));
  if (due.length && !holder.cardsReading) {
    holder.cardsReading = Promise.all(due.map(async id => [id, await readCard(id).then(card => ({ card }), error => ({ failed: String(error?.message ?? error).slice(0, 200) }))]))
      .then(rows => facts.write({ ...(facts.read() ?? {}), ...Object.fromEntries(rows.map(([id, row]) => [id, { ...row, read_at: new Date().toISOString() }])) }))
      .finally(() => { holder.cardsReading = null; });
    waitUntil(holder.cardsReading);
  }
  return Object.fromEntries(subscriptions.filter(id => kept[id] && !kept[id].failed).map(id => [id, kept[id]]));
}
