// tools/take-payments/do-work/payment-catch-up.ts
//
// The payment catch-up as statements a workflow runs through tool:run-sql-in-my-database, around the read
// tool:keep-completed-stripe-checkouts-as-payment-events: every completed checkout since a saved point is kept once, by the
// same rules keepPaymentEventSql keeps one (payment-keys.ts), and the point moves only after a complete read is kept in full.
//
//   CATCH_UP_SHAPE          the one-row table of saved points (payment_catch_up), each statement safe to run again
//   CATCH_UP_POINT_SQL      where this read starts: the saved point, or CHECKOUT_WINDOW_SECONDS back when there is none; the
//                           point the read moves to once kept; and the store's offers, which the read tool names events by
//   KEEP_PAYMENT_EVENTS_SQL every event of one answered list kept once, in one statement
//   SETTLE_CATCH_UP_SQL     reads every listed event back; when any has no kept row the statement fails and the point stays;
//                           when the read was complete it moves the point forward (never back)
//
// Why the window: Stripe lists checkouts by when they were made, and a checkout is paid later, at most 24 hours later (a Checkout
// Session lasts 24 hours). A checkout paid after a read began was made after that read's start less 24 hours, so each read
// starts 48 hours before the last read began (24 hours of margin for clock difference) and re-reads those checkouts; a kept
// checkout is kept again as a no-op, since its id comes from the checkout.
//
// Each statement takes one jsonb parameter, { events?, kinds?, complete?, next_read_from_unix? }, so a workflow step binds the
// read's answer into it whatever the store's driver does with lists.
import { KEPT_COLUMNS, PAYMENT_EVENTS_TABLE } from './payment-keys.ts';

export const CHECKOUT_WINDOW_SECONDS = 48 * 60 * 60;
export const CATCH_UP_TABLE = 'payment_catch_up';

export const CATCH_UP_SHAPE: string[] = [
  `CREATE TABLE IF NOT EXISTS ${CATCH_UP_TABLE} (
  id integer PRIMARY KEY CHECK (id = 1),
  read_from_unix bigint NOT NULL
)`,
  `ALTER TABLE ${CATCH_UP_TABLE} ADD COLUMN IF NOT EXISTS events_from_unix bigint`,
];

export const CATCH_UP_POINT_SQL = `SELECT coalesce(c.read_from_unix, n.now_unix - ${CHECKOUT_WINDOW_SECONDS})::bigint AS created_after_unix,
  (n.now_unix - ${CHECKOUT_WINDOW_SECONDS})::bigint AS next_read_from_unix,
  (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.id), '[]'::jsonb) FROM offers o) AS offers
FROM (SELECT extract(epoch FROM now())::bigint AS now_unix) n LEFT JOIN ${CATCH_UP_TABLE} c ON c.id = 1`;

// One column's value of an event as keepPaymentEventSql reads it: the event's own key when it has one, else its attributes'.
const valueOf = (column: string) => `CASE WHEN g.e ? '${column}' THEN g.e->>'${column}' ELSE g.e->'attributes'->>'${column}' END`;
const castOf = (column: string) => (column === 'occurred_at' ? '::timestamptz' : column === 'amount_due_today_cents' ? '::numeric' : '');
const columnOf = (column: string) => {
  if (column === 'attributes') return `coalesce(g.e->'attributes', '{}'::jsonb) AS attributes`;
  if (column === 'pursuit_ids') return `CASE WHEN g.e ? 'pursuit_ids' THEN g.e->'pursuit_ids' END AS pursuit_ids`;
  return `(${valueOf(column)})${castOf(column)} AS ${column}`;
};

// The listed events, in list order, read into the kept columns; `kinds` are the payment kinds.
const GIVEN = `given AS (
  SELECT g.at, ${KEPT_COLUMNS.map(columnOf).join(', ')}
  FROM jsonb_array_elements(coalesce($1::jsonb->'events', '[]'::jsonb)) WITH ORDINALITY AS g(e, at)
),
kinds AS (SELECT jsonb_array_elements_text(coalesce($1::jsonb->'kinds', '[]'::jsonb)) AS kind)`;

// The same payment as keepPaymentEventSql judges it: both rows of a payment kind, with the same PaymentIntent or checkout.
const samePayment = (a: string, b: string) => `(${a}.event_kind IN (SELECT kind FROM kinds) AND ${b}.event_kind IN (SELECT kind FROM kinds)
    AND (${a}.provider_object_ref = ${b}.provider_object_ref OR ${a}.completion_ref = ${b}.completion_ref))`;

/**
 * Every event of $1.events kept once, as keepPaymentEventSql keeps one: added only when the store holds no row of a payment kind
 * with the same PaymentIntent or checkout, nothing kept on a clash with its own id alone, and any other clash raised. Two events
 * of one list that are the same payment (or share an id) keep the first in list order. Answers { listed, kept }.
 */
export const KEEP_PAYMENT_EVENTS_SQL = `WITH ${GIVEN},
first_of_each AS (
  SELECT g.* FROM given g
  WHERE NOT EXISTS (SELECT 1 FROM given h WHERE h.at < g.at AND (h.id = g.id OR ${samePayment('h', 'g')}))
),
kept AS (
  INSERT INTO ${PAYMENT_EVENTS_TABLE} (${KEPT_COLUMNS.join(', ')})
  SELECT ${KEPT_COLUMNS.map(column => `f.${column}`).join(', ')} FROM first_of_each f
  WHERE NOT EXISTS (SELECT 1 FROM ${PAYMENT_EVENTS_TABLE} p WHERE ${samePayment('p', 'f')})
  ORDER BY f.at
  ON CONFLICT ON CONSTRAINT ${PAYMENT_EVENTS_TABLE}_pkey DO NOTHING
  RETURNING id
)
SELECT (SELECT count(*) FROM given)::int AS listed, (SELECT count(*) FROM kept)::int AS kept`;

/**
 * The listed events read back, and the point moved. Every event of $1.events must have a kept row: its own id, or a row of a
 * payment kind with the same PaymentIntent or checkout. When one has none the statement fails, naming how many, and nothing
 * moves. When all are kept and $1.complete is true, $1.next_read_from_unix becomes the point (only ever forward).
 * Answers { listed, moved, read_from_unix }.
 */
export const SETTLE_CATCH_UP_SQL = `WITH ${GIVEN},
missing AS (
  SELECT count(*)::int AS n FROM given g
  WHERE NOT EXISTS (SELECT 1 FROM ${PAYMENT_EVENTS_TABLE} p WHERE p.id = g.id OR ${samePayment('p', 'g')})
),
refused AS (
  SELECT CASE WHEN n > 0 THEN ('payment catch-up: ' || n || ' listed events have no kept row; the saved point stays')::int ELSE 0 END AS n FROM missing
),
moved AS (
  INSERT INTO ${CATCH_UP_TABLE} (id, read_from_unix)
  SELECT 1, ($1::jsonb->>'next_read_from_unix')::bigint FROM refused
  WHERE refused.n = 0 AND coalesce(($1::jsonb->>'complete')::boolean, false) AND $1::jsonb ? 'next_read_from_unix'
  ON CONFLICT (id) DO UPDATE SET read_from_unix = GREATEST(${CATCH_UP_TABLE}.read_from_unix, EXCLUDED.read_from_unix)
  RETURNING read_from_unix
)
SELECT (SELECT count(*) FROM given)::int AS listed, (SELECT n FROM refused) = 0 AND EXISTS (SELECT 1 FROM moved) AS moved,
  (SELECT read_from_unix FROM moved) AS read_from_unix`;
