// src/inbound-own-records.mjs
//
// The one road an arrival a carrier brings with no person's sign-in behind it reaches its account: mail to the
// account's own address (src/inbound-mail.mjs) and that mail when the edge sends it again (src/share-inbox.mjs). It
// is taken by the account's own records (inbound:take, src/standalone-resource-behavior.mjs) as the account's
// inbound-mail service actor (src/service-actor-origins.json), which its policy owner mints and which opens only that
// operation, under the account's plan as any carrier's arrival is. The PersonStore it once reached is retired with
// the account's carry, so mail sent to it was never taken.
//
// Non-Negotiable Invariants:
//   1. The answer is a Response as the store's was: 2xx taken, 4xx refused for good (the mail bounces with its words),
//      5xx not now (the mail is kept at the edge and sent again).
//   2. The same arrival is taken once: the inbound owner knows an arrival by its carrier's source_id (src/inbound.mjs
//      invariant 2), so a resend answers the first arrival and nothing is taken twice. Each send is its own command
//      (each mints its own actor), so it carries no request key of its own.
//   3. An account whose records are still being imported answers "not now", never a bounce.
export const INBOUND_PATH = '/inbound';

// The native engine currently has no inbound service-actor mint/consumer route.
// Keep that exact authority protocol as an explicit host requirement; never
// substitute an ordinary records bearer or caller-written claims for it.
export function createOwnInbound({ PERSON_APP, refusalStatus, nativeOwnConsumerContext, callOwnResourceConsumer, addressId, mintServiceActor }) {
  if ([refusalStatus, nativeOwnConsumerContext, callOwnResourceConsumer, addressId, mintServiceActor].some(value => typeof value !== 'function') || typeof PERSON_APP !== 'string')
    throw Object.assign(new Error('The admitted inbound service-actor owner is unavailable.'), { code: 'inbound_service_owner_unavailable', status: 503 });
/** The account's own records as its inbound-mail actor, as a fetch ({ fetch(request) }) of POST /inbound: the arrival
 *  taken, its refusal as the status it was refused with, or a failure of the moment thrown as it was (kept for later). */
function ownInbound(env, userId) {
  const deliver = async arrival => {
    const owner = addressId(env, { kind: 'person', key: userId });
    try {
      const { claims } = await mintServiceActor(env, { origin: 'inbound-mail', account: owner, scope: { kind: 'inbound', id: owner } });
      const own = nativeOwnConsumerContext({ env, owner, userId, claims, recorder: { app: PERSON_APP, app_basis: 'service' } });
      return Response.json(await callOwnResourceConsumer(INBOUND_PATH, arrival, 'POST', own));
    } catch (error) {
      if (error?.code === 'account_import_pending') return Response.json({ error: error.message }, { status: 503 });
      const status = refusalStatus(error);
      if (status === null) throw error;
      return Response.json({ error: error.message, ...(error.upgrade_needed === true ? { upgrade_needed: true } : {}) }, { status });
    }
  };
  return {
    // Uses the same narrowly scoped inbound:take actor and current kept-plan gate, without taking an arrival.
    preflight: () => deliver({ preflight: true }),
    async fetch(request) {
      let arrival;
      try { arrival = JSON.parse(await request.text()); } catch { return Response.json({ error: 'Invalid JSON body.' }, { status: 400 }); }
      return deliver(arrival);
    },
  };
}

  return { ownInbound };
}
