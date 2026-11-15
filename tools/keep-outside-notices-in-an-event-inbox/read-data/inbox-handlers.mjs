// src/inbox-handlers.mjs
//
// What applies each kind of notice kept in an event inbox (src/event-inbox.mjs), and the upkeep each source keeps
// running. A new kind of outside notice is one row in `apply` (and in `tend` if it has upkeep); the inbox never names one.
// apply(env, { body, header, origin }) → a Response (below 300 done; 400, 404 or 409 not one to apply; else try again).
// tend(env, origin) → what the upkeep did.
// Supplied by the current admitted payment host; a row cannot mint its own
// account policy or substitute an arbitrary own-records bearer for that service.
export function createInboxHandlers({ keepPricesCurrent, receivePaymentEvent, personFor }) {
  if (![keepPricesCurrent, receivePaymentEvent, personFor].every(value => typeof value === 'function'))
    throw Object.assign(new Error('The admitted payment notice and upkeep owners are unavailable.'), { code: 'payment_notice_owner_unavailable', status: 503 });
  return {
    apply: {
      stripe: (env, notice) => receivePaymentEvent(new Request(`${notice.origin}/billing/stripe`, { method: 'POST', headers: { 'stripe-signature': notice.header }, body: notice.body }), env, personFor),
    },
    tend: {
      stripe: (env, origin) => keepPricesCurrent(env, origin),
    },
  };
}
