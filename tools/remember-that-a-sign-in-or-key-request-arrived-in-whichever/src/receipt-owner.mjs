// src/receipt-owner.mjs
//
// Purpose: who keeps the pre-dispatch receipt of a sign-in or key route (src/worker-api-receipt-owner.json). The owner
// follows the person store's known carry state: a store frozen or retired for the own-records carry is read-only and refuses
// the receipt write, so the @executions book keeps it; every other store keeps it as before 1b6e78df7.
// Invariant: chosen from the state, never by trying one owner and falling back; a store that cannot say is treated as carried.
export async function receiptOwnerFor(pathname, { rules, stub, book }) {
  if (!rules.paths.includes(pathname)) return null;
  const carried = await Promise.resolve().then(() => stub.recordsSource()).then(source => Boolean(source), () => true);
  return carried ? book() : stub;
}
