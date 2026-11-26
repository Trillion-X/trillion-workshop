// tools/take-payments/do-work/payment-keys.ts
//
// One real payment is one kept row, whatever path keeps it and whenever it was kept.
//
// paymentEventsShape(eventMap) is the payment_events table a store keeps payment rows in, with the two keys the database
// holds a payment to: one row per payment (its PaymentIntent, provider_object_ref) and one row per checkout
// (completion_ref), each over the kinds a payment's own events are kept as (paymentKindsOf, read from the event map). A
// second row for a payment already kept is refused by the database whatever its id. keepPaymentEventSql is the keep as one
// statement: the row is added only when no row of the same payment is kept, a clash on its own id keeps nothing, and any other
// clash raises (never swallowed), so a payment is reported kept only when it is, and nothing downstream of a new row runs twice.
//
// Rows kept before payment rows were named by their PaymentIntent are named by their checkout (payment-event:checkout:cs_…,
// provider_object_ref the checkout session). paymentKeyMoves works out the id each such row has now, from the same
// payment's event as the checkout list reads it from Stripe (tool:keep-completed-stripe-checkouts-as-payment-events, a read
// only), matched by checkout session. rekeySql moves those rows to their ids, and every reference to them, in one
// statement: it refuses when a new id is already kept, when a moved reference collides, and when any column still holds an
// old id that the request did not name as history.
//
//   node do-work/payment-keys.ts < request.json
//     request: { kept: [payment_events rows], listed: [events the checkout list answered], references: [...], history: [...] }
//     answers: { kinds, moves, left, rekey_sql, counts_sql }
import webhookEventMap from '../read-data/webhook-event-map.json' with { type: 'json' };
import { PAYMENT_EVENT_TYPES } from './map-webhook-event.mjs';

export const PAYMENT_EVENTS_TABLE = 'payment_events';
const NEW_ID_PREFIX = 'payment-event:payment:';
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const ID = /^[A-Za-z0-9_:.-]{1,255}$/;
const KIND = /^[a-z][a-z0-9_.-]{0,62}$/;

type EventMapRule = { stripe_event_type: string; target_event_kind: string; target_event_kind_by_billing_reason?: Record<string, string> };
type EventMap = { rules: EventMapRule[] };

/** A kept payment_events row, as the store reads it. */
export type KeptRow = { id: string; event_id: string; event_kind: string; completion_ref?: string | null; provider_object_ref?: string | null };
/** A payment event the checkout list answered: { id, event_id, event_kind, attributes: { completion_ref, provider_object_ref } }. */
export type ListedEvent = { id: string; event_id: string; event_kind: string; attributes?: { completion_ref?: string; provider_object_ref?: string } };
/** A column that refers to a payment row: by its id, or by its event_id; json_key when the column is jsonb and the key holds it. */
export type Reference = { table: string; column: string; holds: 'id' | 'event_id'; json_key?: string };
/** A column whose old ids are kept as written: history, evidence or provenance, never followed as a reference. */
export type History = { table: string; column: string };
export type Move = { from: string; to: string; from_event_id: string; to_event_id: string; payment_intent: string };
export type Left = { id: string; why: string };

/** The kinds a payment's own events are kept as: the event map's kinds for the payment event types. */
export function paymentKindsOf(eventMap: EventMap = webhookEventMap as EventMap): string[] {
  const kinds = new Set<string>();
  for (const rule of eventMap.rules) {
    if (!PAYMENT_EVENT_TYPES.includes(rule.stripe_event_type)) continue;
    kinds.add(rule.target_event_kind);
    for (const kind of Object.values(rule.target_event_kind_by_billing_reason ?? {})) kinds.add(kind);
  }
  const listed = [...kinds].sort();
  for (const kind of listed) if (!KIND.test(kind)) throw new Error(`payment keys: the event map's kind ${JSON.stringify(kind)} is not a plain kind name.`);
  return listed;
}

const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
const kindList = (kinds: string[]) => kinds.map(literal).join(', ');

/** The payment_events table and its keys, each statement safe to run again. */
export function paymentEventsShape(eventMap: EventMap = webhookEventMap as EventMap): string[] {
  const kinds = kindList(paymentKindsOf(eventMap));
  const table = PAYMENT_EVENTS_TABLE;
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
  id text PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL,
  event_kind text NOT NULL,
  offer_id text,
  price_option_id text,
  customer_email text,
  amount_due_today_cents numeric,
  currency text,
  payment_status text,
  subscription_id text,
  provider_object_ref text,
  completion_ref text,
  provider_event_id text,
  pursuit_ids jsonb,
  attributes jsonb NOT NULL,
  made_at timestamptz NOT NULL DEFAULT now()
)`,
    `CREATE INDEX IF NOT EXISTS ${table}_email ON ${table} (lower(customer_email))`,
    `CREATE INDEX IF NOT EXISTS ${table}_offer ON ${table} (offer_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${table}_one_row_per_payment ON ${table} (provider_object_ref) WHERE provider_object_ref IS NOT NULL AND event_kind IN (${kinds})`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${table}_one_row_per_checkout ON ${table} (completion_ref) WHERE completion_ref IS NOT NULL AND event_kind IN (${kinds})`,
  ];
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** A payment event as a path answers it: { id, event_id, occurred_at, event_kind, attributes, pursuit_ids? }. */
export type PaymentEvent = { id: string; event_id: string; occurred_at: string; event_kind: string; attributes?: Record<string, unknown>; pursuit_ids?: unknown };

const KEPT_COLUMNS = ['id', 'event_id', 'occurred_at', 'event_kind', 'offer_id', 'price_option_id', 'customer_email', 'amount_due_today_cents', 'currency',
  'payment_status', 'subscription_id', 'provider_object_ref', 'completion_ref', 'provider_event_id', 'pursuit_ids', 'attributes'] as const;

/**
 * One payment event kept once, as one statement: { sql, params }, answering { id, kept }. The row is added only when the store
 * holds no row of a payment kind with the same PaymentIntent (provider_object_ref) or checkout (completion_ref), and a clash on
 * its own id alone keeps nothing (ON CONFLICT ON CONSTRAINT on the primary key). A clash on any other key raises, never
 * swallowed: two keeps of one payment under two ids at the same moment raise on the payment's key for the later one, which
 * reads the store again and finds the row; a clash on a key that is not the payment's is an error to see, not a payment kept.
 * `id` is the id the store holds for the payment (the event's own when it was added), `kept` is 1 when this statement added it.
 * `id` null with `kept` 0 is a keep of the same id at the same moment that this statement waited for and could not yet see:
 * keepPaymentEvent reads the stored row again then (storedPaymentIdSql), and fails if there is none.
 */
export function keepPaymentEventSql(event: PaymentEvent, kinds: string[] = paymentKindsOf()): { sql: string; params: unknown[] } {
  const a = event.attributes ?? {};
  const value = (column: string) => (column in event ? (event as Record<string, unknown>)[column] : a[column]) ?? null;
  const params = KEPT_COLUMNS.map(column => {
    if (column === 'attributes') return JSON.stringify(a);
    if (column === 'pursuit_ids') return event.pursuit_ids === undefined ? null : JSON.stringify(event.pursuit_ids);
    return value(column);
  });
  const at = (column: string) => `$${KEPT_COLUMNS.indexOf(column as never) + 1}`;
  const kindsAt = `$${KEPT_COLUMNS.length + 1}::text[]`;
  const table = PAYMENT_EVENTS_TABLE;
  const samePayment = `p.event_kind = ANY (${kindsAt}) AND ${at('event_kind')}::text = ANY (${kindsAt}) AND (p.provider_object_ref = ${at('provider_object_ref')}::text OR p.completion_ref = ${at('completion_ref')}::text)`;
  const sql = `WITH kept AS (
  INSERT INTO ${table} (${KEPT_COLUMNS.join(', ')})
  SELECT ${KEPT_COLUMNS.map(column => `${at(column)}${column === 'occurred_at' ? '::timestamptz' : column === 'amount_due_today_cents' ? '::numeric' : column === 'pursuit_ids' || column === 'attributes' ? '::jsonb' : '::text'}`).join(', ')}
  WHERE NOT EXISTS (SELECT 1 FROM ${table} p WHERE ${samePayment})
  ON CONFLICT ON CONSTRAINT ${table}_pkey DO NOTHING
  RETURNING id)
SELECT coalesce((SELECT id FROM kept), (SELECT p.id FROM ${table} p WHERE p.id = ${at('id')}::text OR (${samePayment}) ORDER BY p.id = ${at('id')}::text DESC, p.made_at LIMIT 1)) AS id,
  (SELECT count(*) FROM kept)::int AS kept`;
  return { sql, params: [...params, kinds] };
}

/** The id the store holds for one payment event's payment: its own id, or a row of a payment kind with the same PaymentIntent
 * or checkout. Answers { id } rows, none when the store holds no such row. */
export function storedPaymentIdSql(event: PaymentEvent, kinds: string[] = paymentKindsOf()): { sql: string; params: unknown[] } {
  const a = event.attributes ?? {};
  return {
    sql: `SELECT p.id FROM ${PAYMENT_EVENTS_TABLE} p WHERE p.id = $1::text OR (p.event_kind = ANY ($5::text[]) AND $2::text = ANY ($5::text[])
  AND (p.provider_object_ref = $3::text OR p.completion_ref = $4::text)) ORDER BY p.id = $1::text DESC, p.made_at LIMIT 1`,
    params: [event.id, event.event_kind, a.provider_object_ref ?? null, a.completion_ref ?? null, kinds],
  };
}

/** Runs one statement and answers its rows (a store's own client: pg, PGlite, a run's SQL tool). */
export type Query = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * A keep step whole: keepPaymentEventSql, and when it answers no id (a keep of the same id at the same moment it could not yet
 * see) the stored row read again with storedPaymentIdSql. Answers { id, kept }: the stored id, and 1 when this keep added it. A
 * clash on any other key raises as it came; no stored row after the read again throws, so the step fails rather than submit a
 * payment that is not kept.
 */
export async function keepPaymentEvent(query: Query, event: PaymentEvent, kinds: string[] = paymentKindsOf()): Promise<{ id: string; kept: number }> {
  const keep = keepPaymentEventSql(event, kinds);
  const [answer] = await query(keep.sql, keep.params);
  if (typeof answer?.id === 'string') return { id: answer.id, kept: Number(answer.kept) };
  const read = storedPaymentIdSql(event, kinds);
  const [stored] = await query(read.sql, read.params);
  if (typeof stored?.id !== 'string') throw new Error(`payment keys: ${event.id} was neither kept nor found kept; the keep failed.`);
  return { id: stored.id, kept: 0 };
}

/**
 * The id each kept payment row has now. A row of a payment kind not yet named by its PaymentIntent moves to the id the
 * checkout list gives the same checkout; every other row of a payment kind is left, with why.
 */
export function paymentKeyMoves({ kept, listed, kinds = paymentKindsOf() }: { kept: KeptRow[]; listed: ListedEvent[]; kinds?: string[] }): { moves: Move[]; left: Left[] } {
  const byCheckout = new Map<string, ListedEvent>();
  for (const event of listed) {
    const checkout = text(event.attributes?.completion_ref);
    if (checkout) byCheckout.set(checkout, event);
  }
  const moves: Move[] = [];
  const left: Left[] = [];
  for (const row of kept) {
    if (!kinds.includes(row.event_kind) || row.id.startsWith(NEW_ID_PREFIX)) continue;
    const checkout = text(row.completion_ref);
    if (!checkout) { left.push({ id: row.id, why: 'it names no checkout, so the checkout list cannot name its payment' }); continue; }
    const event = byCheckout.get(checkout);
    if (!event) { left.push({ id: row.id, why: 'the checkout list read no completed checkout for it' }); continue; }
    if (!event.id.startsWith(NEW_ID_PREFIX)) { left.push({ id: row.id, why: 'its checkout took no payment, so it stays named by its checkout' }); continue; }
    const paymentIntent = text(event.attributes?.provider_object_ref);
    if (event.id !== `${NEW_ID_PREFIX}${paymentIntent}`) throw new Error(`payment keys: ${event.id} is not named by its PaymentIntent ${paymentIntent}.`);
    moves.push({ from: row.id, to: event.id, from_event_id: row.event_id, to_event_id: event.event_id, payment_intent: paymentIntent });
  }
  const seen = new Map<string, string>();
  for (const move of moves) {
    for (const value of [move.from, move.to, move.from_event_id, move.to_event_id, move.payment_intent]) {
      if (!ID.test(value)) throw new Error(`payment keys: ${JSON.stringify(value)} is not an id this move can carry.`);
    }
    const other = seen.get(move.to);
    if (other) throw new Error(`payment keys: ${other} and ${move.from} are one payment (${move.to}); keep one of them before moving.`);
    seen.set(move.to, move.from);
  }
  return { moves, left };
}

function checkName(name: string, what: string) {
  if (!NAME.test(name)) throw new Error(`payment keys: the ${what} ${JSON.stringify(name)} is not a plain lower-case name.`);
}

function checkedReferences(references: Reference[], history: History[]) {
  for (const ref of references) {
    checkName(ref.table, 'table'); checkName(ref.column, 'column');
    if (ref.json_key !== undefined) checkName(ref.json_key, 'json key');
    if (ref.holds !== 'id' && ref.holds !== 'event_id') throw new Error(`payment keys: ${ref.table}.${ref.column} holds id or event_id, not ${JSON.stringify(ref.holds)}.`);
  }
  for (const kept of history) { checkName(kept.table, 'table'); checkName(kept.column, 'column'); }
}

function referenceUpdate(ref: Reference): string {
  const from = ref.holds === 'id' ? 'from' : 'from_event_id';
  const to = ref.holds === 'id' ? 'to' : 'to_event_id';
  if (ref.json_key) {
    return `  UPDATE ${ref.table} t SET ${ref.column} = jsonb_set(t.${ref.column}, '{${ref.json_key}}', to_jsonb(m->>'${to}'))
    FROM jsonb_array_elements(moves) m WHERE t.${ref.column}->>'${ref.json_key}' = m->>'${from}';`;
  }
  return `  UPDATE ${ref.table} t SET ${ref.column} = m->>'${to}' FROM jsonb_array_elements(moves) m WHERE t.${ref.column} = m->>'${from}';`;
}

/**
 * One statement that moves the rows and every named reference, or changes nothing. It refuses (raises, so the whole
 * statement is undone) when a moved row is missing, a new id or event id is already kept, a moved reference collides with
 * a row already there, or any text or json column of the schema still holds an old id afterwards and is not named in
 * history.
 */
export function rekeySql({ moves, references, history = [] }: { moves: Move[]; references: Reference[]; history?: History[] }): string {
  checkedReferences(references, history);
  const table = PAYMENT_EVENTS_TABLE;
  const historyPairs = history.length
    ? `AND (c.table_name::text, c.column_name::text) NOT IN (${history.map(h => `(${literal(h.table)}, ${literal(h.column)})`).join(', ')})`
    : '';
  return `DO $rekey$
DECLARE
  moves jsonb := ${literal(JSON.stringify(moves))}::jsonb;
  old_ids text[];
  missing text;
  taken text;
  col record;
  n bigint;
  still text := '';
BEGIN
  SELECT coalesce(array_agg(m->>'from'), '{}') INTO old_ids FROM jsonb_array_elements(moves) m;
  SELECT string_agg(m->>'from', ', ') INTO missing FROM jsonb_array_elements(moves) m
    WHERE NOT EXISTS (SELECT 1 FROM ${table} p WHERE p.id = m->>'from');
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'payment keys: no row is kept as %', missing; END IF;
  SELECT string_agg(p.id, ', ') INTO taken FROM ${table} p, jsonb_array_elements(moves) m
    WHERE p.id = m->>'to' OR p.event_id = m->>'to_event_id';
  IF taken IS NOT NULL THEN RAISE EXCEPTION 'payment keys: a payment is already kept under its new id or event id: %', taken; END IF;
  UPDATE ${table} p SET id = m->>'to', event_id = m->>'to_event_id', provider_object_ref = m->>'payment_intent',
    attributes = p.attributes || jsonb_build_object('provider_object_ref', m->>'payment_intent')
    FROM jsonb_array_elements(moves) m WHERE p.id = m->>'from';
${references.map(referenceUpdate).join('\n')}
  FOR col IN SELECT c.table_name, c.column_name, c.data_type FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = current_schema() AND c.data_type IN ('text', 'character varying', 'jsonb', 'json') ${historyPairs}
  LOOP
    IF col.data_type IN ('jsonb', 'json') THEN
      EXECUTE format('SELECT count(*) FROM %I x WHERE x.%I IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_path_query(x.%I::jsonb, ''strict $.**'') v WHERE jsonb_typeof(v) = ''string'' AND v #>> ''{}'' = ANY($1))',
        col.table_name, col.column_name, col.column_name) INTO n USING old_ids;
    ELSE
      EXECUTE format('SELECT count(*) FROM %I WHERE %I = ANY($1)', col.table_name, col.column_name) INTO n USING old_ids;
    END IF;
    IF n > 0 THEN still := still || format('%s.%s (%s rows); ', col.table_name, col.column_name, n); END IF;
  END LOOP;
  IF still <> '' THEN RAISE EXCEPTION 'payment keys: these columns would still hold an old payment id, pointing nowhere: %', still; END IF;
END
$rekey$`;
}

/** What the moved rows and references hold afterwards: run after rekeySql in the same transaction (a dry run rolls both back). */
export function countsSql({ moves, references }: { moves: Move[]; references: Reference[] }): string {
  checkedReferences(references, []);
  const ids = `ARRAY[${moves.map(m => literal(m.to)).join(', ')}]::text[]`;
  const eventIds = `ARRAY[${moves.map(m => literal(m.to_event_id)).join(', ')}]::text[]`;
  const parts = [`'${PAYMENT_EVENTS_TABLE}', (SELECT count(*) FROM ${PAYMENT_EVENTS_TABLE} WHERE id = ANY(${ids}))`];
  for (const ref of references) {
    const held = ref.json_key ? `${ref.column}->>'${ref.json_key}'` : ref.column;
    const key = `${ref.table}.${ref.column}${ref.json_key ? `.${ref.json_key}` : ''}`;
    parts.push(`${literal(key)}, (SELECT count(*) FROM ${ref.table} WHERE ${held} = ANY(${ref.holds === 'id' ? ids : eventIds}))`);
  }
  return `SELECT jsonb_build_object(${parts.join(', ')}) AS moved`;
}

type Request = { kept: KeptRow[]; listed: ListedEvent[]; references: Reference[]; history?: History[] };

/** The whole plan for one store: its moves, the rows left and why, and the two statements. */
export function planPaymentKeyMoves(request: Request) {
  const kinds = paymentKindsOf();
  const { moves, left } = paymentKeyMoves({ kept: request.kept, listed: request.listed, kinds });
  return {
    kinds,
    moves,
    left,
    rekey_sql: rekeySql({ moves, references: request.references, history: request.history ?? [] }),
    counts_sql: countsSql({ moves, references: request.references }),
  };
}

if (import.meta.main) {
  const { readFileSync } = await import('node:fs');
  const request = JSON.parse(readFileSync('/dev/stdin', 'utf8')) as Request;
  process.stdout.write(`${JSON.stringify(planPaymentKeyMoves(request), null, 2)}\n`);
}
