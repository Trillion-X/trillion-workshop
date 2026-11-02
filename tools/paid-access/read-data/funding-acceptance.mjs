// tools/paid-access/read-data/funding-acceptance.mjs
//
// Contract: moved unchanged from trillion src/funding-acceptance.mjs (commit 1ecb3437d3), which both the old account
// policy owner (src/account-control.mjs acceptAccountFunding) and the old person store (src/person-store.mjs
// acceptFunding) ran on the beneficiary's side when someone paid for their place.
//
// Accept a sponsored entitlement on the beneficiary's account, never on GET and never
// by treating the payer as the beneficiary. A durable pending claim prevents two
// concurrent funders from both reserving a spot for the same account. Unknown RPC
// outcomes remain retryable only through that same claim, not another sponsor.
//
//   makeFundingAcceptance({ read, write, access, give, record }) → async ({ buyer, taker, episode_ref }) →
//     { words } | { refused, words }
//   read/write   the beneficiary's one pending claim (kept where the beneficiary's own records are)
//   access       the beneficiary's current access (who-holds-access.mjs heldAccess, or currentCapabilityState)
//   give         the payer's side: one seat of their purchase (seats.mjs takeSeat), answering { effects, words } or
//                { refused, words }
//   record       keeps one effect on the beneficiary's account
export function makeFundingAcceptance({ read, write, access, give, record }) {
  let running = null;
  return async input => {
    const { buyer, taker, episode_ref = null } = input;
    if (![buyer, taker].every(value => typeof value === 'string' && value)) throw new Error('A payer and a beneficiary are required.');
    const key = JSON.stringify([buyer, taker, episode_ref]);
    const pending = read();
    if (pending && pending.key !== key) return { refused: 'pending', words: 'An earlier spot acceptance is still being checked. Retry its invitation before accepting another sponsor.' };
    if (running) return running;
    write({ key, buyer, taker, episode_ref });
    running = (async () => {
      const result = await give({ buyer, taker, episode_ref, taker_access: await access() });
      if (result.refused) { write(null); return result; }
      if (!Array.isArray(result.effects) || !result.effects.length) throw new Error('The payer did not return a verified entitlement. Retry this invitation.');
      for (const effect of result.effects) await record(effect);
      write(null);
      return { words: result.words };
    })();
    try { return await running; } finally { running = null; }
  };
}
