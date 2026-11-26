// tools/take-payments/keeps/keep-a-stripe-event.ts
//
// PURPOSE
//   The function tool:keep-a-stripe-event runs: a seller's Stripe webhook call, checked and kept. It is take-payments.mjs's
//   checkAStripeEvent (the signature under the webhook signing secret, the event mapped by the one event map), then the payment
//   event kept once in the pursuit's payment_events by payment-keys.ts keepPaymentEvent: one real payment is one row whatever
//   path keeps it (this call, the catch-up, a replay), so a call Stripe sends again keeps nothing. A site's action row sends the
//   raw body and the Stripe-Signature header; nothing else.
//
//   What follows a new payment (the welcome series' first email, a referral reward) is not called from here: the new
//   payment_events row is the fact. Its row-change trigger tells the engine, and the workflows that fire on a payment row being
//   added run once, because the row is added once.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing unchecked is kept: a call whose signature fails is answered { admitted: false, reason } and the database is not
//      opened. A signed event of a kind the map does not read is answered admitted false, reason unmapped-event-type, also
//      without opening the database (Stripe sends every event the endpoint is subscribed to).
//   2. A payment is kept only under a use, through the database's writer login: given no `use` it is refused in these words
//      before any descriptor is read. The row mounts the writer login (-writer-connection) on 6 and the use ticket on 7; the keep
//      runs in one transaction that claims the use first, with only the columns read-data/writer-rights.json names.
//   3. The answer's `id` is the id the store holds for the payment (keepPaymentEvent), and `kept` is 1 only when this call
//      added the row. A keep that cannot find its payment kept after a clash fails the run; it never answers an id the store
//      does not hold.
//   4. `context.keep`, when given (tests), stands in for the descriptor road; nothing else of the context is read here beyond
//      what checkAStripeEvent reads (its secrets and its Stripe sender).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { readFileSync } from 'node:fs';
import { checkAStripeEvent } from '../do-work/take-payments.mjs';
import { keepPaymentEvent, paymentKindsOf, type PaymentEvent, type Query } from '../do-work/payment-keys.ts';
import { sayWithout, withSqlWrite } from '../../run-sql-in-my-database/do-work/run-sql.mjs';

const DATABASE_DESCRIPTOR = 6;
const TICKET_DESCRIPTOR = 7;
const NO_USE = 'A payment is kept only under a use.';

type Use = { purpose: string; surface?: string };
type Given = Record<string, unknown> & { payload?: unknown; signature_header?: unknown; database?: unknown; use?: unknown };
type Keep = (given: Given & { database: string; use: Use }, event: PaymentEvent, kinds: string[]) => Promise<{ id: string; kept: number }>;
type Context = Record<string, unknown> & { keep?: Keep };

const isUse = (use: unknown): use is Use =>
  !!use && typeof use === 'object' && !Array.isArray(use) && typeof (use as Use).purpose === 'string' && (use as Use).purpose !== '';

/** Checks one Stripe webhook call and keeps its payment event once. Answers { admitted, reason?, event_kind?, id?, kept }. */
export async function keepAStripeEvent(given: Given, context: Context = {}) {
  if (typeof given.database !== 'string' || given.database === '') throw new Error('database is needed: the pursuit database the payment is kept in.');
  if (!isUse(given.use)) throw new Error(`${NO_USE} Give use ({ purpose, surface }) with database ${given.database}.`);
  const checked = await checkAStripeEvent(given, context);
  if (!checked.admitted) return { admitted: false, reason: checked.reason, kept: 0 };
  const kinds = paymentKindsOf(given.event_map as never);
  const keep = context.keep ?? keepThroughDescriptors;
  const { id, kept } = await keep(given as Given & { database: string; use: Use }, checked.payment_event as PaymentEvent, kinds);
  return { admitted: true, event_kind: checked.event_kind, id, kept };
}

// The run's own keep: the writer login and use ticket the row mounted, one transaction that claims the use first, told without either.
async function keepThroughDescriptors(given: Given & { use: Use }, event: PaymentEvent, kinds: string[]) {
  let connection = '', ticket = '';
  try {
    connection = readFileSync(DATABASE_DESCRIPTOR, 'utf8').trim();
    ticket = readFileSync(TICKET_DESCRIPTOR, 'utf8').trim();
    return await withSqlWrite({ connection, ticket, use: given.use }, (run: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => {
      const query: Query = async (sql, params) => (await run(sql, params)).rows;
      return keepPaymentEvent(query, event, kinds);
    });
  } catch (error) {
    throw new Error(sayWithout(error, connection, ticket));
  }
}
